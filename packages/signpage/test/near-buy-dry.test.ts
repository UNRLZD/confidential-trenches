// pool.buy.dry on NEAR (card you-receive-on-every-chain, src/near-buy.ts nearBuyDry): the trade box's You receive and Fee
// for a NEAR buy, from the device's own reads before any signature. Red before the card: the page answered a NEAR dry
// not_allowed (no such answer), so the box drew You receive and Fee as a dash on NEAR.
//   node --test test/near-buy-dry.test.ts      (from packages/signpage)
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { IDBFactory } from "fake-indexeddb";
import { SIGNPAGE_PARAM_SCHEMAS, SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { RheaQuoteRefused, type RheaQuote } from "../../kit/src/near/rhea.ts";
import { WithdrawRelayRefused } from "../../wallet/src/withdraw/relay.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../../wallet/src/store/index.ts";
import { nearBuyDry } from "../src/near-buy.ts";
import { vaultScope } from "../src/withdraw/checks.ts";

const SEED = new Uint8Array(64).fill(0x42);
const NETWORK = "mainnet" as const;
const SCOPE = vaultScope(NETWORK)!;
const X = "x.near";
const FEE = 50_000n; // the vault payout's fee, 0.05 USDC
globalThis.fetch = (async () => {
  throw new Error("no network in tests");
}) as typeof fetch;
const worlds: { w: WalletStore; ns: NoteStore }[] = [];
after(() => {
  for (const v of worlds.splice(0)) (v.ns.close(), v.w.close());
});

async function cash(values: bigint[]): Promise<NoteStore> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  worlds.push({ w, ns });
  for (const [k, value] of values.entries()) {
    let n = await ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED, ref).precommitment);
    const label = vaultLabelOf(keccak_256, SCOPE, BigInt(k + 1));
    n = await ns.move(n.id, "PLANNED", "INCOMING");
    await ns.move(n.id, "INCOMING", "UNSPENT", { leaf: { value, label, commitment: noteCommitment(value, label, n.precommitment), leafIndex: BigInt(k) } });
  }
  return ns;
}
const quoteOf = (asked: bigint[], out: bigint | null) => async (a: { side: "buy" | "sell"; token: string; amountIn: bigint }): Promise<RheaQuote> => {
  asked.push(a.amountIn);
  if (out === null) throw new RheaQuoteRefused("no-pool", "no simple pool joins USDC to the token");
  return { side: a.side, token: a.token, amountIn: a.amountIn, amountOut: out } as RheaQuote;
};

test("NEAR: with an amount, cost is the fees the buy's own plan draws and out one quote of what W swaps, at the token's decimals", async () => {
  const ns = await cash([40_000_000n]);
  const asked: bigint[] = [];
  const page = { network: NETWORK, notes: async () => ns, fee: async () => FEE, rpcs: () => { throw new Error("no rpc"); }, pools: async () => [], decimals: async () => 18 };
  const a = await nearBuyDry(page as never, X, 2_000_000n, quoteOf(asked, 1_234_500_000_000_000_000n));
  // $2 of the $40 note: W swaps $2 less the payout's fee (planCashSpend), the fee is the Fee
  assert.deepEqual(a, { result: { tap_max: "40", cost: "0.05", out: "1.2345" } });
  assert.deepEqual(asked, [1_950_000n], "one quote, of what W swaps");
  assert.ok(SIGNPAGE_RESULT_SCHEMAS["pool.buy.dry"]((a as { result: unknown }).result));
  // the box's ask on NEAR passes the kit's own schema (chain near, a USDC decimal)
  assert.ok(SIGNPAGE_PARAM_SCHEMAS["pool.buy.dry"]({ chain: "near", token: X, amount: "2.00" }));
});

test("NEAR: a quote that fails gives the Fee and no out; no amount, or one Cash cannot pay, gives tap_max alone", async () => {
  const ns = await cash([3_000_000n]);
  const page = { network: NETWORK, notes: async () => ns, fee: async () => FEE, rpcs: () => { throw new Error("no rpc"); }, pools: async () => [], decimals: async () => 6 };
  const asked: bigint[] = [];
  assert.deepEqual(await nearBuyDry(page as never, X, 2_000_000n, quoteOf(asked, null)), { result: { tap_max: "3", cost: "0.05" } });
  assert.deepEqual(await nearBuyDry(page as never, X, null, quoteOf(asked, 1n)), { result: { tap_max: "3" } });
  // more than Cash holds (card buy-quote-before-any-note): You receive of the same buy, no Fee
  assert.deepEqual(await nearBuyDry(page as never, X, 5_000_000n, quoteOf(asked, 1n)), { result: { tap_max: "3", out: "0.000001" } });
  // an amount no plan pays (at most twice the fee): tap_max alone, no quote
  assert.deepEqual(await nearBuyDry(page as never, X, 100_000n, quoteOf(asked, 1n)), { result: { tap_max: "3" } });
  assert.deepEqual(asked, [1_950_000n, 4_950_000n], "one quote a planned buy");
  // a quote for another amount or token than W swaps is no out
  const other = async (a: { side: "buy" | "sell"; token: string; amountIn: bigint }) => ({ side: a.side, token: "y.near", amountIn: a.amountIn, amountOut: 7n }) as RheaQuote;
  assert.deepEqual(await nearBuyDry(page as never, X, 2_000_000n, other), { result: { tap_max: "3", cost: "0.05" } });
});

// Card buy-quote-before-any-note: a fresh account has no Cash note, so no plan pays the amount. Red before: tap_max
// alone, so the box's You receive drew a dash until money landed.
test("card buy-quote-before-any-note: $0 Cash: tap_max 0 and out one quote of what the buy would swap, its payout's fee off; no Fee", async () => {
  const ns = await cash([]);
  const asked: bigint[] = [];
  // the payout's fee of a withdrawal of the amount itself: with no note, Cash's largest (0) sizes no fee quote
  const fees: (bigint | undefined)[] = [];
  const page = { network: NETWORK, notes: async () => ns, fee: async (amount?: bigint) => (fees.push(amount), FEE), rpcs: () => { throw new Error("no rpc"); }, pools: async () => [], decimals: async () => 18 };
  const a = await nearBuyDry(page as never, X, 2_000_000n, quoteOf(asked, 1_234_500_000_000_000_000n));
  assert.deepEqual(a, { result: { tap_max: "0", out: "1.2345" } });
  assert.deepEqual(fees, [2_000_000n]);
  // a fee that amount cannot carry (askWithdrawFee refuses it): tap_max alone, never "failed"
  const refused = { ...page, fee: async () => { throw new WithdrawRelayRefused("fee", "relay_fee: at or above the amount"); } };
  assert.deepEqual(await nearBuyDry(refused as never, X, 2_000_000n, quoteOf(asked, 1n)), { result: { tap_max: "0" } });
  assert.deepEqual(asked, [1_950_000n], "the same swap a $2 Cash note's buy makes");
  assert.ok(SIGNPAGE_RESULT_SCHEMAS["pool.buy.dry"]((a as { result: unknown }).result));
  assert.deepEqual(await nearBuyDry(page as never, X, null, quoteOf(asked, 1n)), { result: { tap_max: "0" } });
});

// Card near-quote-blackdragon: release 165's sign run 43832638554 (job 133181648165) asked a fresh account's NEAR dry of
// blackdragon.tkn.near and got tap_max alone, no out, though the coin quotes from its Rhea pools (4276 with wNEAR: the
// device's rheaQuote answered out at 08:46Z, and the live page answered out on the box at 08:49Z). The page reads a fault
// of its providers as the coin's "no out": with dRPC answering 429, the live page answered blackdragon and prl.omft.near
// tap_max alone in 11 ms (08:51Z). Red before: { result: { tap_max } } for each fault below, so the box drew You receive as
// a dash and never asked again, and the live check FAILed a provider's moment as a coin with no quote.
test("card near-quote-blackdragon: a read that failed is down (the box asks again); only the chain's own refusal is no out", async () => {
  const ns = await cash([]);
  const page = { network: NETWORK, notes: async () => ns, fee: async () => FEE, rpcs: () => { throw new Error("no rpc"); }, pools: async () => [], decimals: async () => 18 };
  const throwing = (e: Error) => async (): Promise<RheaQuote> => { throw e; };
  for (const code of ["rpc", "disagree", "lag"] as const) assert.deepEqual(await nearBuyDry(page as never, X, 2_000_000n, throwing(new RheaQuoteRefused(code, "a provider"))), { error: "down" }, code);
  // a transport fault (the pair's HTTP 429, a timeout) and the token's decimals read failing
  assert.deepEqual(await nearBuyDry(page as never, X, 2_000_000n, throwing(new Error("near.drpc.org: HTTP 429"))), { error: "down" });
  const noDecimals = { ...page, decimals: async () => { throw new Error("ft_metadata: HTTP 503"); } };
  assert.deepEqual(await nearBuyDry(noDecimals as never, X, 2_000_000n, quoteOf([], 1n)), { error: "down" });
  // the payout's fee read failing with no Cash note (not the relayer's "fee" refusal)
  const noFee = { ...page, fee: async () => { throw new Error("rpc.mainnet.fastnear.com: HTTP 429"); } };
  assert.deepEqual(await nearBuyDry(noFee as never, X, 2_000_000n, quoteOf([], 1n)), { error: "down" });
  // the chain's own refusals, alike on both providers: no out, as before
  for (const code of ["no-pool", "liquidity", "frozen", "paused", "pool", "input"] as const) assert.deepEqual(await nearBuyDry(page as never, X, 2_000_000n, throwing(new RheaQuoteRefused(code, "the chain"))), { result: { tap_max: "0" } }, code);
});
