// The withdraw form's reads and hand-off (card signpage-withdraw-handoff): the note value over the note store, the
// relayer's fee bounded by the device's own fee_max, and the hand-off to the wallet's withdraw path, whose request,
// proved for real (snarkjs 0.7.5 over the kit's pinned withdraw.wasm and withdraw.zkey, the prover worker's call),
// passes the relayer's own checks (apps/helper/src/withdraw/checks.ts checkWithdraw) for the testnet release. One
// network per build: SIGN_HOST's build is mainnet, where no vault or relayer is named, so nothing is offered, and a
// testnet pair is refused there.
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
import { RELEASE_WITHDRAW_RELAYER, type RelayRpc } from "../../wallet/src/withdraw/relay.ts";
import type { WithdrawRequest } from "../../wallet/src/withdraw/request.ts";
import { vaultScope } from "../src/withdraw/checks.ts";
import { lowerFinalTime, PAGE_NETWORK, withdrawFormDeps, type HandoffOver } from "../src/withdraw/handoff.ts";

const T = NEAR_NETWORKS.testnet;
const SCOPE = vaultScope("testnet")!;
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const R = RELEASE_WITHDRAW_RELAYER.testnet!;
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
const page = (v: World, prover: VaultProver = snarkProver) => ({ store: async () => v.w, notes: async () => v.ns, seed64: async () => Uint8Array.from(SEED), prover });
const testnet = (v: World, over: HandoffOver = {}) =>
  withdrawFormDeps(page(v), { network: "testnet", rpcs: pair("testnet"), priceRpcs: pair("mainnet"), fetchFn: helper(), ...over });

test("SIGN_HOST's build is mainnet: no vault or relayer is named there, so the note value is 0, the fee unread and nothing handed off", async () => {
  assert.equal(PAGE_NETWORK, "mainnet");
  const v = await world([5_000_000n]);
  const d = withdrawFormDeps(page(v), { fetchFn: helper() });
  assert.equal(d.network, "mainnet");
  assert.deepEqual(d.rpcs.map((r) => r.name), [NEAR_NETWORKS.mainnet.fastnear[0], NEAR_NETWORKS.mainnet.drpc]);
  assert.equal(await d.available(), 0n);
  await assert.rejects(d.fee(), /no withdrawal relayer on mainnet/);
  assert.equal(d.handoff, undefined);
});

test("a mainnet form refuses a testnet pair: the fee read stops before any read", async () => {
  const v = await world([5_000_000n]);
  const d = withdrawFormDeps(page(v), { network: "mainnet", rpcs: pair("testnet"), fetchFn: helper() });
  await assert.rejects(d.fee());
  // and the testnet relayer on a testnet form with the mainnet pair: the storage read refuses the pair
  const t = withdrawFormDeps(page(v), { network: "testnet", rpcs: pair("mainnet"), priceRpcs: pair("mainnet"), fetchFn: helper() });
  await assert.rejects(t.fee(), /the RPCs must be one of/);
});

test("available is the largest UNSPENT note of the vault's scope in the note store", async () => {
  const v = await world([2_000_000n, 10_000_000n, 5_000_000n]);
  // a note of another scope, larger, never counts
  const other = await world([50_000_000n], SCOPE + 1n);
  assert.equal(await testnet(v).available(), 10_000_000n);
  assert.equal(await testnet(other).available(), 0n);
  // a spent note no longer counts
  const ten = (await v.ns.list()).find((n) => n.leaf?.value === 10_000_000n)!;
  await v.ns.move(ten.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: "1", attempt: "a" });
  assert.equal(await testnet(v).available(), 5_000_000n);
});

test("fee is the release relayer's quote, bounded by the device's own fee_max at the token's storage minimum", async () => {
  const v = await world([5_000_000n]);
  const seen: string[] = [];
  const asked: string[] = [];
  const d = testnet(v, { rpcs: pair("testnet", asked), fetchFn: helper(feeAnswer(), seen) });
  assert.equal(await d.fee(), RELAY_FEE);
  assert.deepEqual(seen, [`https://api.confidential.unrealized.trade/v1/withdraw/fee?token=${T.usdc}`]);
  assert.deepEqual(asked, [], "the form names no A before a note is picked");
  // above fee_max: refused (the form shows it unread)
  await assert.rejects(testnet(v, { fetchFn: helper(feeAnswer({ relay_fee: "100000000" })) }).fee(), /relay_fee/);
  // an answer naming another relayer: refused
  await assert.rejects(testnet(v, { fetchFn: helper(feeAnswer({ fee_recipient: "f.testnet" })) }).fee(), /not the release's/);
  // the two RPCs disagree on the storage minimum: refused
  await assert.rejects(testnet(v, { rpcs: pair("testnet", [], (s) => (s === "a" ? MIN : MIN + 1n)) }).fee(), /disagree/);
});

test("the hand-off proves on the page's prover and hands relayWithdraw a request the relayer's checks pass", async () => {
  const v = await world([2_000_000n, 5_000_000n, 10_000_000n]);
  const asked: string[] = [];
  const rpcs = pair("testnet", asked);
  let sent: WithdrawRequest | null = null;
  const blockNs = await lowerFinalTime(rpcs);
  const d = testnet(v, {
    rpcs,
    sync: async () => ({ stateTree: v.stateTree, labelTree: v.labelTree, newestStateRoot: v.stateTree.root!, newestLabelRoot: v.labelTree.root! }),
    blockNs: async () => blockNs,
    relay: async (seed, req, deps) => {
      assert.equal(deps.network, "testnet");
      assert.ok(seed.some((b) => b !== 0), "the seed is open while the relay runs");
      sent = req;
      return { kind: "expired", note: (await v.ns.get(req.noteId))!, route: "relayer", lastAnswer: null };
    },
  });
  assert.ok(d.handoff);
  assert.equal(await d.handoff({ recipient: "alice.testnet", amount: 3_000_000n }), "expired");
  const req = sent as WithdrawRequest | null;
  assert.ok(req);
  // the smallest note covering 3 USDC plus the fee, RESERVED, paying its own A, register_deposit read for that A only
  const spent = (await v.ns.get(req.noteId))!;
  assert.equal(spent.leaf?.value, 5_000_000n);
  assert.equal(spent.state, "RESERVED");
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

test("T is the lower of the pair's final block times, refused when they differ by over 60 s", async () => {
  const at = (ns: string): RelayRpc => ({ name: "x", query: async () => ({}), block: async () => ({ result: { header: { timestamp_nanosec: ns } } }) });
  assert.equal(await lowerFinalTime([at("1030000000000"), at("1000000000000")]), "1000000000000");
  await assert.rejects(lowerFinalTime([at("61000000001"), at("1000000000")]), /over 60 s/);
  await assert.rejects(lowerFinalTime([at("1"), { ...at("1"), block: async () => ({ error: { name: "X" } }) }]), /not a final block/);
});
