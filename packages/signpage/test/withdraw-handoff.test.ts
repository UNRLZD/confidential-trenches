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
/** The release pair of `net` as recorded, plus the token's storage views (A unregistered, the bounds' min MIN); `asked`
 * keeps every account a storage_balance_of names. */
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
    // no arrival read unless a test gives its pair: a landing ends "landed", as before the arrival read
    arrival: async () => Promise.reject(new Error("no arrival read in this test")),
    ...over,
  });
  assert.ok(h);
  return h;
}
const zeroed = (s: Uint8Array) => s.every((b) => b === 0);
const tick = () => new Promise((r) => setImmediate(r));
const expired = async (v: World, req: WithdrawRequest): Promise<RelayOutcome> => ({ kind: "expired", note: (await v.ns.get(req.noteId))!, route: "relayer", lastAnswer: null });

// ---------- the form: reads only ----------
test("the testnet form, whose release names a vault and a relayer, offers the hand-off that pays the typed account", async () => {
  const v = await world([5_000_000n]);
  const d = testnet(v);
  assert.equal(typeof d.handoff, "function", "Withdraw is offered: the vault pays the typed account straight (wallet-withdraw-move-out)");
  assert.equal(await d.available(), 5_000_000n);
  assert.equal(await d.fee(), RELAY_FEE);
});

// The release names its mainnet vault and withdrawal relayer (card wallet-mainnet-relayer-pins); the release-with-no-relayer
// case is held in test/withdraw-mainnet-relayer.test.ts, with the pin planted null.
test("a mainnet form over testnet notes: the note value 0, the fee refused unasked, nothing to settle", async () => {
  const v = await world([5_000_000n]);
  const p = page(v);
  const seen: string[] = [];
  const d = withdrawFormDeps(p, { network: "mainnet", rpcs: pair("mainnet"), priceRpcs: pair("mainnet"), fetchFn: helper(feeAnswer(), seen) });
  assert.equal(d.network, "mainnet");
  assert.equal(await d.available(), 0n, "no note of this world is on the mainnet vault's scope");
  await assert.rejects(d.fee(), /withdraw relay refused \(input\): amount: not a bigint above 0/);
  assert.deepEqual(seen, [], "the helper is never asked");
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
  assert.deepEqual(seen, [`https://ct-api.unrealized.trade/v1/withdraw/fee?token=${T.usdc}`]);
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
  // the smallest note covering 3 USDC plus the fee, RESERVED with its request's bytes, paying the typed account straight
  const spent = (await v.ns.get(req.noteId))!;
  assert.equal(spent.leaf?.value, 5_000_000n);
  assert.equal(spent.state, "RESERVED");
  assert.equal(spent.request, JSON.stringify(req.body));
  const a = armAccount(SEED, spent.leaf!.label, 0);
  a.secretKey.fill(0);
  assert.equal(req.body.withdrawal.recipient, "alice.testnet");
  assert.equal(req.recipient, "alice.testnet");
  assert.equal(req.body.fund_recipient, false);
  assert.notEqual(req.body.withdrawal.recipient, a.id, "never the note's A");
  assert.deepEqual(asked, [], "no read names the typed account: register_deposit is the token's minimum for every recipient (card relayer-cost-guards, review F2)");
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
  withdrawSettle(p, { network: "testnet", rpcs: pair("testnet"), priceRpcs: pair("mainnet"), fetchFn: helper(), relay, arrival: async () => Promise.reject(new Error("no arrival read in this test")) });

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

test("the settle pass on a ragequit of the note (context 0, no change inserted): SPENT, its request dropped", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const pass = await settleWith(v, async () => ({ kind: "unmatched", spend: { context: 0n } as never }));
  assert.deepEqual(pass.outcomes, { [req.noteId]: "spent" });
  const n = (await v.ns.get(req.noteId))!;
  assert.equal(n.state, "SPENT");
  assert.equal(n.request, undefined);
});

test("the settle pass on a withdraw whose new leaf is not the device's change (a drift): RESERVED with its request, unmatched, never dropped", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const pass = await settleWith(v, async () => ({ kind: "unmatched", spend: { context: 123n } as never }));
  assert.deepEqual(pass.outcomes, { [req.noteId]: "unmatched" });
  const n = (await v.ns.get(req.noteId))!;
  assert.equal(n.state, "RESERVED");
  assert.equal(n.request, JSON.stringify(req.body));
});

test("the settle pass: one note's stored request that cannot be read fails that note alone; the others are followed", async () => {
  const v = await world([5_000_000n, 6_000_000n]);
  const [a, b] = await v.ns.list();
  const bad = await v.ns.move(a!.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: "7" });
  await v.ns.move(a!.id, "HELD", "RESERVED", { attempt: bad.attempt, request: "{}" }); // JSON, not a request body
  const req = await leftReserved(v);
  assert.equal(req.noteId, b!.id);
  const pass = await settleWith(v, async (_s, r) => expired(v, r));
  assert.deepEqual(pass.outcomes, { [a!.id]: "failed", [b!.id]: "expired" });
  assert.equal((await v.ns.get(a!.id))!.state, "RESERVED");
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

// ---------- the real relayWithdraw: the seed zeroed right after the call (it copies the seed before its first await) ----------
const { relayWithdraw } = await import("../../wallet/src/withdraw/relay.ts");
const BLOCK_MS = 1_800_000_000_000;
type Spend = { nh: bigint; withdrawn: bigint; newLeaf: number; context: bigint; h: number };
// the wallet's withdraw-relay.test.ts Chain: a model vault's pages on the testnet release pair
class Chain {
  height = 175_000_000;
  times = new Map<number, bigint>([[this.height, BigInt(BLOCK_MS)]]);
  leaves: { v: bigint; h: number }[] = Array.from({ length: 8 }, (_, k) => ({ v: BigInt(100 + k), h: 0 }));
  spends: Spend[] = [{ nh: 41n, withdrawn: 1_000_000n, newLeaf: 7, context: 43n, h: 0 }];
  status = "in_flight";
  recipient = "a".repeat(64);
  refundValue = "0";
  land(nh: bigint, withdrawn: bigint, leaf: bigint, context: bigint): void {
    this.leaves.push({ v: leaf, h: this.height });
    this.spends.push({ nh, withdrawn, newLeaf: this.leaves.length - 1, context, h: this.height });
  }
  views(at: number) {
    const leaves = this.leaves.filter((l) => l.h <= at);
    const spends = this.spends.filter((s) => s.h <= at);
    const tree = (n: number) => ({ size: n, depth: n <= 1 ? 0 : Math.ceil(Math.log2(n)), root: "7" });
    return {
      state_tree: tree(leaves.length),
      label_tree: tree(0),
      spends: spends.map((s, index) => ({
        index, nullifier_hash: String(s.nh), withdrawn: String(s.withdrawn), new_leaf_index: s.newLeaf, refund_precommitment: "5",
        refund_value: this.refundValue, refund_label: "0", refund_leaf_index: 0, status: this.status,
        payer: "relayer.confidential.unrlzd.near", reserve: "0", recipient: this.recipient, fee: "30000", context: String(s.context),
      })),
      leaves: leaves.map((l) => String(l.v)),
    } as Record<string, unknown>;
  }
  rpcs(): [RelayRpc, RelayRpc] {
    const one = (name: string): RelayRpc => ({
      name,
      query: async (p) => {
        const at = p.finality === "final" ? this.height : (p.block_id as number);
        const args = JSON.parse(atob(p.args_base64 as string)) as { from?: number; limit?: number };
        let view = this.views(at)[p.method_name as string];
        if (Array.isArray(view)) view = view.slice(Math.min(args.from!, view.length), Math.min(args.from! + args.limit!, view.length));
        return { jsonrpc: "2.0", id: "x", result: { block_hash: `hash-${at}`, block_height: at, logs: [], result: [...new TextEncoder().encode(JSON.stringify(view))] } };
      },
      block: async (p) => {
        const block_id = "block_id" in p ? p.block_id : this.height;
        const t = this.times.get(block_id)!;
        return { jsonrpc: "2.0", id: "x", result: { header: { height: block_id, hash: `hash-${block_id}`, timestamp: 0, timestamp_nanosec: (t * 1_000_000n).toString(), gas_price: "100000000" } } };
      },
    });
    return [one(T.fastnear[0]), one(T.drpc)];
  }
}
const sig = (r: WithdrawRequest, k: number): bigint => BigInt(r.body.public_signals[k]);
/** The real relayWithdraw, called synchronously (as the hand-off and the settle pass call it), its own spend landed first. */
const realRelayLanded = (c: Chain): HandoffOver["relay"] => (seed, req, deps) => {
  c.land(sig(req, 1), sig(req, 2), sig(req, 0), sig(req, 7));
  return relayWithdraw(seed, req, { ...deps, rpcs: c.rpcs() });
};

test("hand-off with the real relayWithdraw: the seed zeroed after the call, its own spend is still landed with the change note", async () => {
  const v = await world([5_000_000n]);
  const p = page(v);
  const h = await handoffOf(v, p, { relay: realRelayLanded(new Chain()) });
  assert.deepEqual(await h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), { kind: "landed" });
  assert.ok(zeroed(p.opened[0]!));
  const change = (await v.ns.list()).find((n) => n.ref.kind === "change");
  assert.ok(change, "the change note is written");
  assert.equal(change!.state, "UNSPENT");
});

test("settle pass with the real relayWithdraw: a stored request whose own spend landed is settled landed, its change written", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const p = page(v);
  const pass = await settleWith(v, realRelayLanded(new Chain()), p);
  assert.deepEqual(pass.outcomes, { [req.noteId]: "landed" });
  const change = (await v.ns.list()).find((n) => n.ref.kind === "change");
  assert.ok(change, "the change note is written (an 'unmatched' here would mark the note SPENT with no change)");
  assert.equal((await v.ns.get(req.noteId))!.state, "SPENT");
  assert.ok(zeroed(p.opened[0]!));
});

test("settle pass: two passes (two tabs) on one RESERVED note, both with the real relay: one change note, the note SPENT, neither pass throws", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const c = new Chain();
  c.land(sig(req, 1), sig(req, 2), sig(req, 0), sig(req, 7));
  const relay: HandoffOver["relay"] = (seed, r, deps) => relayWithdraw(seed, r, { ...deps, rpcs: c.rpcs() });
  const tabB = await openNoteStore(v.w);
  const pB = { ...page(v), notes: async () => tabB };
  const [a, b] = await Promise.all([settleWith(v, relay), settleWith(v, relay, pB as never)]);
  tabB.close();
  const kinds = [a.outcomes[req.noteId], b.outcomes[req.noteId]].sort();
  const changes = (await v.ns.list()).filter((n) => n.ref.kind === "change");
  assert.equal(changes.length, 1, "one change note");
  assert.equal((await v.ns.get(req.noteId))!.state, "SPENT");
  assert.deepEqual(kinds, ["landed", "landed"], `outcomes ${kinds.join(",")}`);
});

test("settle pass: a RESERVED vault note with no stored request is skipped and left RESERVED", async () => {
  const v = await world([5_000_000n]);
  const [n] = await v.ns.list();
  const held = await v.ns.move(n!.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: "7" });
  await v.ns.move(n!.id, "HELD", "RESERVED", { attempt: held.attempt });
  let called = 0;
  const p = page(v);
  const pass = await settleWith(v, async () => { called += 1; throw new Error("x"); }, p);
  assert.deepEqual(pass.outcomes, {});
  assert.equal(called, 0);
  assert.equal(p.opened.length, 0);
  assert.equal((await v.ns.get(n!.id))!.state, "RESERVED", "nothing on this page ever frees it");
});


// the r3 re-check (card signpage-withdraw-handoff)
const rejections: unknown[] = [];
process.on("unhandledRejection", (e) => void rejections.push(e));

test("the settle pass: a bad stored request listed after a note whose relay still waits fails alone, its refusal never unhandled meanwhile", async () => {
  const v = await world([5_000_000n, 6_000_000n]);
  const req = await leftReserved(v);
  const other = (await v.ns.list()).find((n) => n.id !== req.noteId && n.ref.kind === "deposit")!;
  const held = await v.ns.move(other.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: "7" });
  await v.ns.move(other.id, "HELD", "RESERVED", { attempt: held.attempt, request: "{}" }); // JSON, not a request body
  // the waiting note listed first, the bad one after it
  const list = async () => {
    const all = await v.ns.list();
    return [...all.filter((n) => n.id === req.noteId), ...all.filter((n) => n.id !== req.noteId)];
  };
  const ns = new Proxy(v.ns, { get: (t, k) => (k === "list" ? list : (Reflect.get(t, k) as (...a: unknown[]) => unknown)?.bind?.(t) ?? Reflect.get(t, k)) });
  const p = { ...page(v), notes: async () => ns };
  const before = rejections.length;
  const slow: HandoffOver["relay"] = async (_s, r) => (await new Promise((ok) => setTimeout(ok, 50)), expired(v, r));
  const pass = await withdrawSettle(p, { network: "testnet", rpcs: pair("testnet"), priceRpcs: pair("mainnet"), fetchFn: helper(), relay: slow });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.deepEqual(pass.outcomes, { [req.noteId]: "expired", [other.id]: "failed" });
  assert.ok(zeroed(p.opened[0]!));
  assert.deepEqual(rejections.slice(before), [], "a rejection went unhandled while the first note's relay waited");
});

test("the settle pass on a ragequit whose SPENT move fails (another tab moved the note first): failed, never spent", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const pass = await settleWith(v, async () => {
    await v.ns.move(req.noteId, "RESERVED", "SPENT"); // another tab's pass got there first
    return { kind: "unmatched", spend: { context: 0n } as never };
  });
  assert.deepEqual(pass.outcomes, { [req.noteId]: "failed" });
});

// ---------- card wallet-withdraw-move-out: the vault pays the typed account; the arrival read on the pair ----------
const { withdrawArrival } = await import("../../wallet/src/withdraw/arrival.ts");
const paidTo = (to: string, status = "paid", refundValue = "0"): Chain => Object.assign(new Chain(), { status, recipient: to, refundValue });
/** A fetch that counts every POST /v1/withdraw (a send) and answers the fee for anything else. */
function counting(posts: string[]): typeof fetch {
  const fee = helper();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(String(init.body));
      return new Response(JSON.stringify({ error: { code: "in_flight" } }), { status: 409, headers: { "content-type": "application/json" } });
    }
    return fee(input, init);
  }) as typeof fetch;
}

test("the hand-off ends at the arrival: landed on the pair, then the spend reads paid to the typed account: arrived", async () => {
  const v = await world([5_000_000n]);
  const c = paidTo("alice.testnet");
  const h = await handoffOf(v, page(v), { relay: realRelayLanded(c), arrivalRpcs: c.rpcs(), arrival: withdrawArrival });
  assert.deepEqual(await h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), { kind: "arrived" });
});

test("the payout failed (refund_pending): the hand-off ends refunded, never arrived", async () => {
  const v = await world([5_000_000n]);
  const c = paidTo("alice.testnet", "refund_pending", "3188142");
  const h = await handoffOf(v, page(v), { relay: realRelayLanded(c), arrivalRpcs: c.rpcs(), arrival: withdrawArrival });
  assert.deepEqual(await h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), { kind: "refunded" });
});

test("resume: the page dies after the relay landed, before the arrival read: the rerun sends nothing new and relays nothing", async () => {
  const v = await world([5_000_000n]);
  const c = paidTo("alice.testnet");
  const died = new Error("page died after the relay");
  const h = await handoffOf(v, page(v), { relay: realRelayLanded(c), arrival: async () => Promise.reject(died) });
  // the relay's landing is kept: the change note written, the spent note SPENT; the arrival unread
  assert.deepEqual(await h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), { kind: "landed" });
  const spent = (await v.ns.list()).find((n) => n.ref.kind !== "change")!;
  assert.equal(spent.state, "SPENT");
  // the rerun (a reload's settle pass) on the same store: no note is RESERVED, so nothing is sent or relayed again
  const posts: string[] = [];
  let relayed = 0;
  const pass = await withdrawSettle(page(v), { network: "testnet", rpcs: c.rpcs(), priceRpcs: pair("mainnet"), fetchFn: counting(posts), relay: async () => (relayed++, Promise.reject(new Error("no relay"))) });
  assert.deepEqual(pass.outcomes, {});
  assert.equal(relayed, 0);
  assert.deepEqual(posts, []);
});

test("resume: the page dies after the send, before landed: the rerun sends the same bytes once, then reads the arrival", async () => {
  const v = await world([5_000_000n]);
  const req = await leftReserved(v);
  const c = paidTo("alice.testnet");
  const posts: string[] = [];
  let calls = 0;
  const pass = await withdrawSettle(page(v), {
    network: "testnet", rpcs: c.rpcs(), priceRpcs: pair("mainnet"), fetchFn: counting(posts), arrivalRpcs: c.rpcs(),
    relay: (seed, r, deps) => {
      calls++;
      assert.equal(JSON.stringify(r.body), JSON.stringify(req.body), "the stored bytes, never re-proved");
      return realRelayLanded(c)!(seed, r, deps);
    },
  });
  assert.deepEqual(pass.outcomes, { [req.noteId]: "arrived" });
  assert.equal(calls, 1);
  assert.ok(posts.every((b) => b === JSON.stringify(req.body)), "any send is the same bytes");
  // a second rerun: nothing RESERVED, nothing sent
  const again = await withdrawSettle(page(v), { network: "testnet", rpcs: c.rpcs(), priceRpcs: pair("mainnet"), fetchFn: counting(posts), relay: async () => Promise.reject(new Error("no relay")) });
  assert.deepEqual(again.outcomes, {});
});

// review of c19ad399, L3: a landing by another attempt of these words (another device, own false) ends on its spend row
test("a landing that is not own, paid to another account, ends elsewhere (never a bare landed)", async () => {
  const v = await world([5_000_000n]);
  const c = paidTo("eve.testnet");
  const h = await handoffOf(v, page(v), {
    relay: async (_seed, r) => ({ kind: "landed", own: false, change: (await v.ns.get(r.noteId))!, spend: { nullifierHash: BigInt(r.body.public_signals[1]), recipient: "eve.testnet", status: "paid", refundValue: 0n } as never }),
    arrivalRpcs: c.rpcs(),
    arrival: async () => Promise.reject(new Error("a landing that is not own reads no arrival")),
  });
  assert.deepEqual(await h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), { kind: "elsewhere" });
});

// review of c19ad399, L4: one deadline per tap, so a tap never waits HANDOFF_WAIT_MAX_MS twice
test("the relay and the arrival read after it share one deadline: the same signal", async () => {
  const v = await world([5_000_000n]);
  const c = paidTo("alice.testnet");
  let relaySignal: AbortSignal | undefined;
  let arrivalSignal: AbortSignal | undefined;
  const landed = realRelayLanded(c)!;
  const h = await handoffOf(v, page(v), {
    relay: async (seed, r, deps) => ((relaySignal = deps.signal), landed(seed, r, deps)),
    arrivalRpcs: c.rpcs(),
    arrival: async (a) => ((arrivalSignal = a.signal), withdrawArrival(a)),
  });
  assert.deepEqual(await h({ recipient: "alice.testnet", amount: 3_000_000n }, RELAY_FEE), { kind: "arrived" });
  assert.ok(relaySignal instanceof AbortSignal);
  assert.equal(arrivalSignal, relaySignal, "the arrival waits under the relay's own deadline, not a fresh one");
});

// review of a6903d91, N1: the settle pass follows each note from its own relay to its own arrival, all at once, so a
// note held to the bound never cuts a later note's arrival, and each arrival waits under its own note's deadline (M6)
test("the settle pass: a note held to the bound never ends a later note's arrival, each read under its own note's deadline", async () => {
  const v = await world([5_000_000n, 6_000_000n]);
  const a = await leftReserved(v);
  const b = await leftReserved(v);
  assert.notEqual(a.noteId, b.noteId);
  const list = async () => {
    const all = await v.ns.list();
    return [...all.filter((n) => n.id === a.noteId), ...all.filter((n) => n.id !== a.noteId)];
  };
  const ns = new Proxy(v.ns, { get: (t, k) => (k === "list" ? list : (Reflect.get(t, k) as (...x: unknown[]) => unknown)?.bind?.(t) ?? Reflect.get(t, k)) });
  const c = paidTo("alice.testnet");
  const landed = realRelayLanded(c)!;
  const relaySignals = new Map<string, AbortSignal>();
  const arrivalSignals: AbortSignal[] = [];
  const pass = await withdrawSettle({ ...page(v), notes: async () => ns }, {
    network: "testnet", rpcs: c.rpcs(), priceRpcs: pair("mainnet"), fetchFn: helper(), arrivalRpcs: c.rpcs(), waitMs: 3_000,
    relay: async (seed, r, deps) => {
      relaySignals.set(r.noteId, deps.signal!);
      // A: a pair that never settles, held until its bound
      if (r.noteId === a.noteId) return new Promise((_ok, no) => deps.signal!.addEventListener("abort", () => no(deps.signal!.reason), { once: true }));
      return landed(seed, r, deps);
    },
    // B's payout runs 500 ms after its landing: the arrival waits for it under its signal, as the pair's rounds do
    arrival: async (x) => {
      arrivalSignals.push(x.signal!);
      await new Promise<void>((ok, no) => {
        const t = setTimeout(ok, 500);
        x.signal!.addEventListener("abort", () => (clearTimeout(t), no(x.signal!.reason)), { once: true });
      });
      return withdrawArrival(x);
    },
  });
  assert.deepEqual(pass.outcomes, { [a.noteId]: "failed", [b.noteId]: "arrived" });
  assert.equal(arrivalSignals.length, 1);
  assert.equal(arrivalSignals[0], relaySignals.get(b.noteId), "B's arrival waits under B's own deadline, never a fresh one");
});
