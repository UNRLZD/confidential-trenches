// The withdraw form's reads, the hand-off kept for the card that pays the typed account, and the settle pass (card
// signpage-withdraw-handoff): the note value over the note store, the relayer's fee bounded by the device's own fee_max,
// and the hand-off to the wallet's withdraw path, whose request, proved for real (snarkjs 0.7.5 over the kit's pinned
// withdraw.wasm and withdraw.zkey, the prover worker's call), passes the relayer's own checks
// (apps/helper/src/withdraw/checks.ts checkWithdraw) for the testnet release. The form gives no hand-off on any build.
// A page that dies at any step leaves no note held for good: the settle pass follows each RESERVED note from its stored
// request. Run as the testnet build (__SIGN_NETWORK__ "testnet", set before the modules load: the testnet relayer is
// that build's only); SIGN_HOST's build is held in test/withdraw-form.test.ts.
//   node --test test/withdraw-handoff.test.ts   (from packages/signpage)
// IndexedDB is fake-indexeddb; the fee_max reads are the wallet's recorded ones (wallet test/vectors/withdraw-feemax.json).
// Test values only, never money: the notes are the public all-zero test seed's (wallet test/vectors/a8.json).
/// <reference types="node" />
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { IDBFactory } from "fake-indexeddb";
import { checkWithdraw } from "../../../apps/helper/src/withdraw/checks.ts";
import type { VaultProver } from "../../kit/src/prover/prove.ts";
import type { VaultSnarkjsProof } from "../../kit/src/vault/shapes.ts";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { ZK_SETUP_FILES } from "../../kit/src/zk/setup-files.ts";
import { NEAR_NETWORKS, type NearNetwork } from "../../kit/src/near/networks.ts";
import { armAccount, entropyToWords, wordsToSeed64 } from "../../wallet/src/derive/index.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../../wallet/src/store/index.ts";
import type { RelayOutcome, RelayRpc } from "../../wallet/src/withdraw/relay.ts";
import type { WithdrawRequest } from "../../wallet/src/withdraw/request.ts";
import type { HandoffOver, HandoffPage } from "../src/withdraw/handoff.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { RELEASE_WITHDRAW_RELAYER } = await import("../../wallet/src/withdraw/relay.ts");
const { readTokenStorageMin } = await import("../../wallet/src/arming/accounts.ts");
const { vaultScope } = await import("../src/withdraw/checks.ts");
const { lowerFinalTime, treesOf, withdrawFormDeps, withdrawHandoff, withdrawSettle } = await import("../src/withdraw/handoff.ts");

const T = NEAR_NETWORKS.testnet;
const SCOPE = vaultScope("testnet")!;
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const R = RELEASE_WITHDRAW_RELAYER.testnet!;
assert.ok(R, "the testnet build's relayer (the modules loaded before __SIGN_NETWORK__ was set?)");
/** USDC's storage_balance_bounds().min: 0.00125 NEAR (wallet.md:420). */
const MIN = 1_250_000_000_000_000_000_000n;
const RELAY_FEE = 188_142n; // the deployed helper's testnet quote, read 2026-11-06 15:58Z

// ---------- the reads, replayed ----------
type Rec = { url: string; json: Record<string, unknown> };
const FEE_READS = JSON.parse(readFileSync(new URL("../../wallet/test/vectors/withdraw-feemax.json", import.meta.url), "utf8")) as {
  answers: Record<"mainnet" | "testnet", { final: Record<"a" | "b", Rec>; at: Record<"a" | "b", Rec>; pool?: Record<"a" | "b", Rec> }>;
};
const bytes = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
const view = (v: unknown, height: number) => ({ jsonrpc: "2.0", result: { result: bytes(v), logs: [], block_height: height, block_hash: "x" } });
/** The release pair of `net` as recorded, plus the token's storage views (A unregistered, the bounds' min MIN). */
function pair(net: NearNetwork, asked: string[] = [], minOf: (side: "a" | "b") => bigint = () => MIN): [RelayRpc, RelayRpc] {
  const rec = FEE_READS.answers[net];
  const one = (side: "a" | "b"): RelayRpc => ({
    name: rec.final[side].url,
    async block(params) {
      if ("finality" in params) return structuredClone(rec.final[side].json);
      return structuredClone(rec.at[side].json);
    },
    async query(params) {
      const h = (rec.final[side].json as { result: { header: { height: number } } }).result.header.height;
      if (params.method_name === "storage_balance_bounds") return view({ min: String(minOf(side)), max: null }, h);
      if (params.method_name === "storage_balance_of") {
        asked.push(JSON.parse(atob(String(params.args_base64))).account_id);
        return view(null, h);
      }
      const pool = rec.pool?.[side].json;
      if (pool === undefined || params.method_name !== "get_pool") throw new Error("no recorded answer");
      return structuredClone(pool);
    },
  });
  return [one("a"), one("b")];
}
const feeAnswer = (over: Record<string, unknown> = {}) => ({
  relayer_account: R.relayer_account, fee_recipient: R.fee_recipient, relay_fee: String(RELAY_FEE), gp: "100000000", px: "3.747982525066", g_w: "92505000000000", valid_until_block: 276507188, ...over,
});
function helper(answer = feeAnswer(), seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

// ---------- the device: a note store on the testnet vault's scope ----------
type World = { w: WalletStore; ns: NoteStore; stateTree: VaultTree; labelTree: VaultTree };
const worlds: World[] = [];
after(() => {
  for (const v of worlds.splice(0)) (v.ns.close(), v.w.close());
  (globalThis as { curve_bn128?: { terminate?: () => void } }).curve_bn128?.terminate?.();
});
async function world(values: bigint[], scope = SCOPE): Promise<World> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  const state: bigint[] = [11n, 12n];
  const labels: bigint[] = [21n, 22n];
  for (const [k, value] of values.entries()) {
    let n = await ns.planDeposit(scope, (ref) => noteSecrets(SEED, ref).precommitment);
    const label = vaultLabelOf(keccak_256, scope, BigInt(k + 1));
    const commitment = noteCommitment(value, label, n.precommitment);
    n = await ns.move(n.id, "PLANNED", "INCOMING");
    n = await ns.move(n.id, "INCOMING", "UNSPENT", { leaf: { value, label, commitment, leafIndex: BigInt(state.length) } });
    state.push(commitment);
    labels.push(label);
  }
  const v = { w, ns, stateTree: new VaultTree(state), labelTree: new VaultTree(labels) };
  worlds.push(v);
  return v;
}
const KIT = new URL("../../kit/", import.meta.url);
const snarkjs = createRequire(new URL("package.json", KIT))("snarkjs") as {
  groth16: { fullProve(i: unknown, w: Uint8Array, z: Uint8Array, l: undefined, x: undefined, o: { singleThread: boolean }): Promise<{ proof: VaultSnarkjsProof; publicSignals: string[] }> };
};
const zk = (f: "withdraw.wasm" | "withdraw.zkey"): Uint8Array => {
  const b = readFileSync(new URL(`zk/${f}`, KIT));
  assert.equal(createHash("sha256").update(b).digest("hex"), ZK_SETUP_FILES[f].sha256, `${f} is not the pinned file`);
  return new Uint8Array(b);
};
const snarkProver: VaultProver = {
  async load() {},
  async prove(_c, input) {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, zk("withdraw.wasm"), zk("withdraw.zkey"), undefined, undefined, { singleThread: true });
    return { proof, publicSignals, proveMs: 0 };
  },
};
type Page = HandoffPage & { opened: Uint8Array[] };
const page = (v: World, prover: VaultProver = snarkProver, signal?: AbortSignal): Page => {
  const opened: Uint8Array[] = [];
  return {
    opened,
    store: async () => v.w,
    notes: async () => v.ns,
    seed64: async () => {
      const s = Uint8Array.from(SEED);
      opened.push(s);
      return s;
    },
    prover,
    ...(signal ? { signal } : {}),
  };
};
const testnet = (v: World, over: HandoffOver = {}) =>
  withdrawFormDeps(page(v), { network: "testnet", rpcs: pair("testnet"), priceRpcs: pair("mainnet"), fetchFn: helper(), ...over });
/** The hand-off on the testnet release, its trees the world's and T read from the recorded pair. */
async function handoffOf(v: World, p: Page, over: HandoffOver = {}) {
  const rpcs = over.rpcs ?? pair("testnet");
  const blockNs = await lowerFinalTime(pair("testnet"));
  const h = withdrawHandoff(p, {
    network: "testnet",
    rpcs,
    priceRpcs: pair("mainnet"),
    fetchFn: helper(),
    sync: async () => ({ stateTree: v.stateTree, labelTree: v.labelTree, newestStateRoot: v.stateTree.root!, newestLabelRoot: v.labelTree.root! }),
    blockNs: async () => blockNs,
    ...over,
  });
  assert.ok(h);
  return h;
}
const zeroed = (s: Uint8Array) => s.every((b) => b === 0);
const tick = () => new Promise((r) => setImmediate(r));
const expired = async (v: World, req: WithdrawRequest): Promise<RelayOutcome> => ({ kind: "expired", note: (await v.ns.get(req.noteId))!, route: "relayer", lastAnswer: null });

// ---------- the form: reads only ----------
test("no build's form hands off: the testnet form, whose release names a vault and a relayer, gives no hand-off either", async () => {
  const v = await world([5_000_000n]);
  const d = testnet(v);
  assert.equal(d.handoff, undefined, "Withdraw stays pending until the typed account is paid (wallet-withdraw-move-out)");
  assert.equal(await d.available(), 5_000_000n);
  assert.equal(await d.fee(), RELAY_FEE);
});

test("a mainnet form names no vault or relayer: the note value 0, the fee unread, no hand-off and no settle pass", async () => {
  const v = await world([5_000_000n]);
  const p = page(v);
  const d = withdrawFormDeps(p, { network: "mainnet", rpcs: pair("mainnet"), priceRpcs: pair("mainnet"), fetchFn: helper() });
  assert.equal(d.network, "mainnet");
  assert.equal(await d.available(), 0n);
  await assert.rejects(d.fee(), /no withdrawal relayer on mainnet/);
  assert.equal(withdrawHandoff(p, { network: "mainnet", rpcs: pair("mainnet") }), null);
  assert.deepEqual(await withdrawSettle(p, { network: "mainnet", rpcs: pair("mainnet") }), { outcomes: {} });
  assert.equal(p.opened.length, 0, "the seed is never opened");
});

test("a pair that is not the build's network's is refused before any read: the fee, the hand-off and the settle pass", async () => {
  const v = await world([5_000_000n]);
  const seen: string[] = [];
  // a mainnet form with the testnet pair: refused for the pair, not for mainnet's missing relayer
  const m = withdrawFormDeps(page(v), { network: "mainnet", rpcs: pair("testnet"), fetchFn: helper(feeAnswer(), seen) });
  await assert.rejects(m.fee(), /the RPCs must be one of https:\/\/rpc\.mainnet\.fastnear\.com/);
  // the testnet release with the mainnet pair, for the fee, the hand-off and the settle pass
  const wrong = { rpcs: pair("mainnet") };
  await assert.rejects(testnet(v, { ...wrong, fetchFn: helper(feeAnswer(), seen) }).fee(), /the RPCs must be one of https:\/\/test\.rpc\.fastnear\.com/);
  const p = page(v);
  const h = await handoffOf(v, p, { ...wrong, fetchFn: helper(feeAnswer(), seen) });
  await assert.rejects(h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), /the RPCs must be one of https:\/\/test\.rpc\.fastnear\.com/);
  await assert.rejects(withdrawSettle(p, { network: "testnet", ...wrong, priceRpcs: pair("mainnet") }), /the RPCs must be one of https:\/\/test/);
  // and a testnet price pair
  await assert.rejects(testnet(v, { priceRpcs: pair("testnet"), fetchFn: helper(feeAnswer(), seen) }).fee(), /priceRpcs: the RPCs must be one of https:\/\/rpc\.mainnet/);
  assert.deepEqual(seen, [], "no quote asked");
  assert.equal(p.opened.length, 0);
});

test("available is the largest UNSPENT note of the vault's scope in the note store", async () => {
  const v = await world([2_000_000n, 10_000_000n, 5_000_000n]);
  // a note of another scope, larger, never counts
  const other = await world([50_000_000n], SCOPE + 1n);
  assert.equal(await testnet(v).available(), 10_000_000n);
  assert.equal(await testnet(other).available(), 0n);
  // a held note no longer counts
  const ten = (await v.ns.list()).find((n) => n.leaf?.value === 10_000_000n)!;
  await v.ns.move(ten.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: "1" });
  assert.equal(await testnet(v).available(), 5_000_000n);
});

test("fee is the release relayer's quote, bounded by the device's own fee_max at the token's storage minimum", async () => {
  // a note far above any fee, so the quote's "at or above the amount" refusal never comes first
  const v = await world([1_000_000_000n]);
  const seen: string[] = [];
  const asked: string[] = [];
  const d = testnet(v, { rpcs: pair("testnet", asked), fetchFn: helper(feeAnswer(), seen) });
  assert.equal(await d.fee(), RELAY_FEE);
  assert.deepEqual(seen, [`https://api.confidential.unrealized.trade/v1/withdraw/fee?token=${T.usdc}`]);
  assert.deepEqual(asked, [], "the form names no A before a note is picked");
  // below the amount and above fee_max: refused for fee_max
  await assert.rejects(testnet(v, { fetchFn: helper(feeAnswer({ relay_fee: "100000000" })) }).fee(), /relay_fee: above the device's fee_max/);
  // an answer naming another relayer: refused
  await assert.rejects(testnet(v, { fetchFn: helper(feeAnswer({ fee_recipient: "f.testnet" })) }).fee(), /not the release's/);
  // the two RPCs disagree on the storage minimum: refused
  await assert.rejects(testnet(v, { rpcs: pair("testnet", [], (s) => (s === "a" ? MIN : MIN + 1n)) }).fee(), /disagree/);
});

test("readTokenStorageMin: the network's pair only, a block height on each answer, the two heights close", async () => {
  await assert.rejects(readTokenStorageMin("testnet", pair("mainnet")), /the RPCs must be one of https:\/\/test/);
  assert.equal(await readTokenStorageMin("testnet", pair("testnet")), MIN);
  const [a, b] = pair("testnet");
  const edit = (f: (r: { result: Record<string, unknown> }) => void): RelayRpc => ({
    ...b,
    async query(p) {
      const r = (await b.query(p)) as { result: Record<string, unknown> };
      if (p.method_name === "storage_balance_bounds") f(r);
      return r;
    },
  });
  await assert.rejects(readTokenStorageMin("testnet", [a, edit((r) => delete r.result.block_height)]), /block_height|block height/);
  await assert.rejects(readTokenStorageMin("testnet", [a, edit((r) => ((r.result.block_height as number) -= 1000))]), /spread/);
});

test("the synced trees are refused unless their roots are the vault's", () => {
  const leaves = [11n, 12n, 13n];
  const labels = [21n, 22n, 23n];
  const s = { leaves, labels, stateTree: { root: new VaultTree(leaves).root! }, labelTree: { root: new VaultTree(labels).root! } };
  assert.equal(treesOf(s).newestStateRoot, s.stateTree.root);
  assert.throws(() => treesOf({ ...s, stateTree: { root: s.stateTree.root + 1n } }), /roots are not the vault's/);
  assert.throws(() => treesOf({ ...s, labelTree: { root: s.labelTree.root + 1n } }), /roots are not the vault's/);
});

// ---------- the hand-off (withdrawHandoff, for wallet-withdraw-move-out) ----------
test("the hand-off proves on the page's prover, RESERVES the note with its request and hands relayWithdraw a request the relayer's checks pass", async () => {
  const v = await world([2_000_000n, 5_000_000n, 10_000_000n]);
  const asked: string[] = [];
  let sent: WithdrawRequest | null = null;
  let waited: AbortSignal | undefined;
  const p = page(v);
  const h = await handoffOf(v, p, {
    rpcs: pair("testnet", asked),
    relay: async (seed, req, deps) => {
      assert.equal(deps.network, "testnet");
      waited = deps.signal;
      sent = req;
      await tick();
      assert.ok(zeroed(seed), "the seed is zeroed while the relay waits");
      return expired(v, req);
    },
  });
  assert.deepEqual(await h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), { kind: "expired" });
  assert.equal(p.opened.length, 1);
  assert.ok(zeroed(p.opened[0]!));
  assert.ok(waited instanceof AbortSignal, "the wait is bounded");
  const req = sent as WithdrawRequest | null;
  assert.ok(req);
  // the smallest note covering 3 USDC plus the fee, RESERVED with its request's bytes, paying its own A
  const spent = (await v.ns.get(req.noteId))!;
  assert.equal(spent.leaf?.value, 5_000_000n);
  assert.equal(spent.state, "RESERVED");
  assert.equal(spent.request, JSON.stringify(req.body));
  const a = armAccount(SEED, spent.leaf!.label, 0);
  a.secretKey.fill(0);
  assert.equal(req.body.withdrawal.recipient, a.id);
  assert.deepEqual(asked, [a.id, a.id], "one read of A on each RPC, and no other id");
  assert.equal(req.body.withdrawal.register_deposit, String(MIN));
  assert.equal(req.body.withdrawal.fee_recipient, R.fee_recipient);
  assert.equal(req.body.withdrawal.relay_fee, String(RELAY_FEE));
  assert.equal(req.body.token, T.usdc);
  const verdict = await checkWithdraw(structuredClone(req.body), { vault: T.vault, token: T.usdc, scope: SCOPE, feeRecipient: R.fee_recipient }, { feeMin: async () => RELAY_FEE });
  assert.deepEqual(verdict.ok ? "ok" : verdict, "ok");
});

test("the hand-off's fresh quote above the fee the form drew: the new fee back, nothing proved, the seed never opened", async () => {
  const v = await world([5_000_000n]);
  let proved = 0;
  const p = page(v, { async load() {}, async prove() { proved += 1; throw new Error("not proved"); } });
  const h = await handoffOf(v, p);
  assert.deepEqual(await h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE - 1n), { kind: "fee", fee: RELAY_FEE });
  assert.equal(proved, 0);
  assert.equal(p.opened.length, 0);
  assert.equal((await v.ns.list())[0]!.state, "UNSPENT");
});

test("the seed is zeroed when the prover throws, and the note is UNSPENT again", async () => {
  const v = await world([5_000_000n]);
  const p = page(v, { async load() {}, async prove() { throw new Error("prover down"); } });
  const h = await handoffOf(v, p);
  await assert.rejects(h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), /prover down/);
  assert.equal(p.opened.length, 1);
  assert.ok(zeroed(p.opened[0]!));
  assert.equal((await v.ns.list())[0]!.state, "UNSPENT");
});

test("sign out stops the relay's wait: the signal the relay gets is the page's, the note left RESERVED for the settle pass", async () => {
  const v = await world([5_000_000n]);
  const out = new AbortController();
  const p = page(v, snarkProver, out.signal);
  const h = await handoffOf(v, p, {
    relay: async (_seed, _req, deps) => {
      out.abort(); // the sign out, mid-wait
      deps.signal!.throwIfAborted();
      throw new Error("not stopped");
    },
  });
  await assert.rejects(h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), (e: unknown) => (e as Error).name === "AbortError");
  assert.ok(zeroed(p.opened[0]!));
  const [n] = await v.ns.list();
  assert.equal(n!.state, "RESERVED");
  assert.ok(n!.request);
  // the bound: a wait past waitMs stops too
  const w2 = await world([5_000_000n]);
  const h2 = await handoffOf(w2, page(w2), {
    waitMs: 5,
    relay: async (_s, _r, deps) => {
      await new Promise((r) => setTimeout(r, 40));
      deps.signal!.throwIfAborted();
      throw new Error("not bounded");
    },
  });
  await assert.rejects(h2({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), (e: unknown) => (e as Error).name === "TimeoutError");
});

// ---------- a page that dies at any step: the settle pass (withdrawSettle) ----------
/** A RESERVED note as a page that died after its proof left it: the hand-off run with a relay that throws. */
async function leftReserved(v: World, relayErr = new Error("page died mid-relay")): Promise<WithdrawRequest> {
  let sent: WithdrawRequest | null = null;
  const h = await handoffOf(v, page(v), {
    relay: async (_s, req) => {
      sent = req;
      throw relayErr;
    },
  });
  await assert.rejects(h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), relayErr);
  return sent!;
}
const settleWith = (v: World, relay: HandoffOver["relay"], p = page(v)) =>
  withdrawSettle(p, { network: "testnet", rpcs: pair("testnet"), priceRpcs: pair("mainnet"), fetchFn: helper(), relay });

test("page death during the proof: the HELD note goes back to UNSPENT when the note store opens again", async () => {
  const v = await world([5_000_000n]);
  const dying = await openNoteStore(v.w);
  const [n] = await dying.list();
  await dying.move(n!.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: "7" });
  dying.close(); // the page's death: its tab lock goes
  const again = await openNoteStore(v.w);
  assert.equal((await again.get(n!.id))!.state, "UNSPENT");
  again.close();
});

test("page death after RESERVED or in the relay's wait: the settle pass sends the stored request again and follows it to landed", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const got: WithdrawRequest[] = [];
  const p = page(v);
  const pass = await settleWith(v, async (seed, r, deps) => {
    got.push(r);
    assert.ok(deps.signal instanceof AbortSignal);
    await tick();
    assert.ok(zeroed(seed), "the seed is zeroed while the pass waits");
    return { kind: "landed", own: true, change: (await v.ns.get(r.noteId))!, spend: {} as never };
  }, p);
  assert.deepEqual(pass.outcomes, { [req.noteId]: "landed" });
  assert.equal(got.length, 1);
  assert.equal(JSON.stringify(got[0]!.body), JSON.stringify(req.body), "the same bytes");
  assert.equal(got[0]!.noteId, req.noteId);
  assert.deepEqual(got[0]!.change, req.change);
  assert.deepEqual(got[0]!.refund, req.refund);
  assert.equal(got[0]!.recipient, req.recipient);
  assert.equal(got[0]!.changeValue, req.changeValue);
  assert.ok(zeroed(p.opened[0]!));
});

test("the settle pass on a spend whose change is not the device's (unmatched): the note is SPENT, never held for good", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const pass = await settleWith(v, async () => ({ kind: "unmatched", spend: {} as never }));
  assert.deepEqual(pass.outcomes, { [req.noteId]: "spent" });
  const n = (await v.ns.get(req.noteId))!;
  assert.equal(n.state, "SPENT");
  assert.equal(n.request, undefined);
});

test("the settle pass's relay throws (no answer, sign out): the note stays RESERVED with its request for the next pass", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const pass = await settleWith(v, async () => {
    throw new Error("RPCs down");
  });
  assert.deepEqual(pass.outcomes, { [req.noteId]: "failed" });
  const n = (await v.ns.get(req.noteId))!;
  assert.equal(n.state, "RESERVED");
  assert.equal(n.request, JSON.stringify(req.body));
  // the next pass: past its deadline with no spend, relayWithdraw frees it (expired)
  assert.deepEqual((await settleWith(v, async (_s, r) => expired(v, r))).outcomes, { [req.noteId]: "expired" });
});

test("the settle pass leaves other notes alone: none RESERVED, the seed is never opened", async () => {
  const v = await world([5_000_000n]);
  const p = page(v);
  assert.deepEqual(await settleWith(v, async () => { throw new Error("not called"); }, p), { outcomes: {} });
  assert.equal(p.opened.length, 0);
});

test("T is the lower of the pair's final block times, refused when they differ by over 60 s", async () => {
  const at = (ns: string): RelayRpc => ({ name: "x", query: async () => ({}), block: async () => ({ result: { header: { timestamp_nanosec: ns } } }) });
  assert.equal(await lowerFinalTime([at("1030000000000"), at("1000000000000")]), "1000000000000");
  await assert.rejects(lowerFinalTime([at("61000000001"), at("1000000000")]), /over 60 s/);
  await assert.rejects(lowerFinalTime([at("1"), { ...at("1"), block: async () => ({ error: { name: "X" } }) }]), /not a final block/);
});
