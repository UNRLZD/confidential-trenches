// The withdraw hand-off tests' world (card readme-run-fits-an-agent-timeout): what test/withdraw-handoff.test.ts held above its
// tests, shared by its three files, so node --test runs them side by side; with 32 real proofs it was one file of 173 s
// on a 4-CPU run, the signing page's last to start. The header below is that file's.
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
// the 1Click mock's key hook first: the cash run to another chain checks its quotes with the kit (./oneclick-mock.ts)
import { h1c } from "./oneclick-mock.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { IDBFactory } from "fake-indexeddb";
import type { VaultProver } from "../../kit/src/prover/prove.ts";
import type { VaultSnarkjsProof } from "../../kit/src/vault/shapes.ts";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { ZK_SETUP_FILES } from "../../kit/src/zk/setup-files.ts";
import { NEAR_NETWORKS, type NearNetwork } from "../../kit/src/near/networks.ts";
import { armAccount, entropyToWords, refundId, wordsToSeed64 } from "../../wallet/src/derive/index.ts";
import type { NoteStore } from "../../wallet/src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../../wallet/src/store/index.ts";
import type { RelayOutcome, RelayRpc } from "../../wallet/src/withdraw/relay.ts";
import type { WithdrawRequest } from "../../wallet/src/withdraw/request.ts";
import type { HandoffOver, HandoffPage } from "../src/withdraw/handoff.ts";

// these load the kit's 1Click keys, so after the mock (in the order they loaded before it)
const { checkWithdraw } = await import("../../../apps/helper/src/withdraw/checks.ts");
const { noteCommitment, noteSecrets } = await import("../../wallet/src/notes/secrets.ts");
const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { RELEASE_WITHDRAW_RELAYER } = await import("../../wallet/src/withdraw/relay.ts");
const { readTokenStorageMin } = await import("../../wallet/src/arming/accounts.ts");
const { cashNotes, planCashWithdraw, vaultScope } = await import("../src/withdraw/checks.ts");
const { cashWithdrawRun, lowerFinalTime, treesOf, withdrawFormDeps, withdrawHandoff, withdrawSettle } = await import("../src/withdraw/handoff.ts");

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


export { FEE_READS, h1c, KIT, MIN, R, RELAY_FEE, RELEASE_WITHDRAW_RELAYER, SCOPE, SEED, T, bytes, cashNotes, cashWithdrawRun, checkWithdraw, expired, feeAnswer, handoffOf, helper, leftReserved, lowerFinalTime, noteCommitment, noteSecrets, openNoteStore, page, pair, planCashWithdraw, readTokenStorageMin, settleWith, snarkProver, snarkjs, testnet, tick, treesOf, vaultScope, view, withdrawFormDeps, withdrawHandoff, withdrawSettle, world, worlds, zeroed, zk };
export type { Page, Rec, World };
