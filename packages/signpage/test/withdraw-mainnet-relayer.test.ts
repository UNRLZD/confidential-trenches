// SIGN_HOST's build with and without a mainnet withdrawal relayer (card wallet-mainnet-relayer-pins): where the release
// names none (wallet withdraw/relay.ts RELEASE_WITHDRAW_RELAYER.mainnet null) the form refuses the fee before any read
// and offers no hand-off; where it names one, the hand-off is offered and the fee is asked of the release's helper and
// taken only from an answer that names that relayer and fee recipient byte for byte, bounded by the device's fee_max.
// Both hold whatever the source pin is now: a load hook gives this process a relay.ts whose RELEASE_WITHDRAW_RELAYER
// is the real one with its mainnet slot set by the test (a live binding the form reads on each call), every other export
// the real module's.
//   node --test test/withdraw-mainnet-relayer.test.ts      (from packages/signpage)
// The fee_max reads are the wallet's recorded mainnet ones (wallet test/vectors/withdraw-feemax.json); IndexedDB is
// fake-indexeddb; the note is the public all-zero test seed's. Test values only, never money.
/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { IDBFactory } from "fake-indexeddb";
import type { HelperReleaseRelayer } from "../../kit/src/helper/v1.ts";
import { NEAR_NETWORKS } from "../../kit/src/near/networks.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { entropyToWords, wordsToSeed64 } from "../../wallet/src/derive/index.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import { openWalletStore } from "../../wallet/src/store/index.ts";
import type { RelayRpc } from "../../wallet/src/withdraw/relay.ts";

const RELAY_URL = new URL("../../wallet/src/withdraw/relay.ts", import.meta.url).href;
registerHooks({
  load(url, context, next) {
    if (url !== RELAY_URL) return next(url, context);
    const real = JSON.stringify(`${RELAY_URL}?real`);
    const source = `import { RELEASE_WITHDRAW_RELAYER as REAL } from ${real};
export * from ${real};
export let RELEASE_WITHDRAW_RELAYER = REAL;
export function plantMainnet(m) { RELEASE_WITHDRAW_RELAYER = Object.freeze({ ...REAL, mainnet: m }); }
`;
    return { format: "module", source, shortCircuit: true };
  },
});
const relay = (await import("../../wallet/src/withdraw/relay.ts")) as unknown as {
  plantMainnet(m: HelperReleaseRelayer | null): void;
  RELEASE_WITHDRAW_RELAYER: Record<string, HelperReleaseRelayer | null>;
  WITHDRAW_FEE_URL: string;
};
/** The release's own mainnet pair, as relay.ts writes it (read before any test plants another). */
const RELEASED = relay.RELEASE_WITHDRAW_RELAYER.mainnet;
const { vaultScope } = await import("../src/withdraw/checks.ts");
const { withdrawFormDeps, withdrawHandoff } = await import("../src/withdraw/handoff.ts");
if (typeof relay.plantMainnet !== "function") throw new Error("withdraw-mainnet-relayer.test.ts: relay.ts was loaded before the hook");

const MAIN = NEAR_NETWORKS.mainnet;
/** A mainnet pair as withdraw-relayer-key.sh makes it: a 64-hex implicit relayer, the owner's fee recipient. */
const PLANTED = Object.freeze({ relayer_account: "ab".repeat(32), fee_recipient: "fees.unrlzd.near" });
/** helper-mainnet-vault-env's Mac test run's relayer (its answers.json): a helper naming it is not the release's. */
const THROWAWAY = "9747fa11a4de38cecc3b9086239633a2164a81c8e7b03a39bd3f1522438717d6";
const MIN = 1_250_000_000_000_000_000_000n; // USDC's storage_balance_bounds().min, 0.00125 NEAR
const RELAY_FEE = 186_072n; // the deployed helper's testnet quote, read 2026-11-08 03:00Z
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));

type Rec = { url: string; json: Record<string, unknown> };
const FEE_READS = JSON.parse(readFileSync(new URL("../../wallet/test/vectors/withdraw-feemax.json", import.meta.url), "utf8")) as {
  answers: { mainnet: { final: Record<"a" | "b", Rec>; at: Record<"a" | "b", Rec>; pool: Record<"a" | "b", Rec> } };
};
const bytes = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
/** Mainnet's release pair as recorded, plus USDC's storage views (the bounds' min MIN). */
function pair(): [RelayRpc, RelayRpc] {
  const rec = FEE_READS.answers.mainnet;
  const one = (side: "a" | "b"): RelayRpc => ({
    name: rec.final[side].url,
    async block(params) {
      return structuredClone("finality" in params ? rec.final[side].json : rec.at[side].json);
    },
    async query(params) {
      const h = (rec.final[side].json as { result: { header: { height: number } } }).result.header.height;
      const view = (v: unknown) => ({ jsonrpc: "2.0", result: { result: bytes(v), logs: [], block_height: h, block_hash: "x" } });
      if (params.method_name === "storage_balance_bounds") return view({ min: String(MIN), max: null });
      if (params.method_name === "storage_balance_of") return view(null);
      if (params.method_name !== "get_pool") throw new Error("no recorded answer");
      return structuredClone(rec.pool[side].json);
    },
  });
  return [one("a"), one("b")];
}
const feeAnswer = (over: Record<string, unknown> = {}) => ({
  relayer_account: PLANTED.relayer_account, fee_recipient: PLANTED.fee_recipient, relay_fee: String(RELAY_FEE), gp: "100000000", px: "3.706745373987", g_w: "92505000000000", valid_until_block: 223556400, ...over,
});
function helper(answer: Record<string, unknown>, seen: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

// the device: one UNSPENT note on the mainnet vault's scope, far above any fee
const w = await openWalletStore({ indexedDB: new IDBFactory() });
const ns = await openNoteStore(w);
after(() => (ns.close(), w.close()));
{
  const scope = vaultScope("mainnet")!;
  let n = await ns.planDeposit(scope, (ref) => noteSecrets(SEED, ref).precommitment);
  const label = vaultLabelOf(keccak_256, scope, 1n);
  const value = 1_000_000_000n;
  n = await ns.move(n.id, "PLANNED", "INCOMING");
  await ns.move(n.id, "INCOMING", "UNSPENT", { leaf: { value, label, commitment: noteCommitment(value, label, n.precommitment), leafIndex: 2n } });
}
const no = async (): Promise<never> => Promise.reject(new Error("not opened"));
const page = { store: async () => w, notes: async () => ns, seed64: no, prover: { load: no, prove: no } };
const form = (fetchFn: typeof fetch) => withdrawFormDeps(page, { network: "mainnet", rpcs: pair(), priceRpcs: pair(), fetchFn });

test("no mainnet relayer named: the fee is refused before any read and no hand-off is offered", async () => {
  relay.plantMainnet(null);
  const seen: string[] = [];
  const d = form(helper(feeAnswer(), seen));
  await assert.rejects(d.fee(), /the release names no withdrawal relayer on mainnet/);
  assert.equal(d.handoff, undefined);
  assert.equal(withdrawHandoff(page, { network: "mainnet", rpcs: pair() }), null);
  assert.deepEqual(seen, [], "the helper is never asked");
});

test("a mainnet relayer named: the hand-off is offered and the fee is the helper's quote for that relayer, bounded by fee_max", async () => {
  relay.plantMainnet(PLANTED);
  assert.deepEqual(relay.RELEASE_WITHDRAW_RELAYER.mainnet, PLANTED);
  const seen: string[] = [];
  const d = form(helper(feeAnswer(), seen));
  assert.equal(typeof d.handoff, "function");
  assert.equal(typeof withdrawHandoff(page, { network: "mainnet", rpcs: pair() }), "function");
  assert.equal(await d.fee(), RELAY_FEE);
  assert.deepEqual(seen, [`${relay.WITHDRAW_FEE_URL}?token=${MAIN.usdc}`]);
});

test("the release's own mainnet pair: the hand-off is offered, its fee answer taken, and one naming another relayer or fee recipient refused", async () => {
  assert.ok(RELEASED !== null, "relay.ts names a mainnet withdrawal relayer");
  assert.equal(RELEASED.fee_recipient, "fees.unrlzd.near");
  relay.plantMainnet(RELEASED);
  const own = { relayer_account: RELEASED.relayer_account, fee_recipient: RELEASED.fee_recipient };
  const d = form(helper(feeAnswer(own), []));
  assert.equal(typeof d.handoff, "function");
  assert.equal(await d.fee(), RELAY_FEE);
  await assert.rejects(form(helper(feeAnswer({ ...own, relayer_account: PLANTED.relayer_account }), [])).fee(), /not the release's/);
  await assert.rejects(form(helper(feeAnswer({ ...own, relayer_account: THROWAWAY }), [])).fee(), /not the release's/);
  await assert.rejects(form(helper(feeAnswer({ ...own, fee_recipient: "unrlzd.near" }), [])).fee(), /not the release's/);
});

test("a mainnet relayer named: an answer naming the throwaway relayer, another fee recipient or a fee above fee_max is refused", async () => {
  relay.plantMainnet(PLANTED);
  await assert.rejects(form(helper(feeAnswer({ relayer_account: THROWAWAY }), [])).fee(), /not the release's/);
  await assert.rejects(form(helper(feeAnswer({ fee_recipient: PLANTED.relayer_account }), [])).fee(), /not the release's/);
  await assert.rejects(form(helper(feeAnswer({ relay_fee: "100000000" }), [])).fee(), /relay_fee: above the device's fee_max/);
});
