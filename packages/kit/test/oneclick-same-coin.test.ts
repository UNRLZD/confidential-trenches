// Card same-coin-deposits-across-chains-quote: the kit's 1Click fee on one coin from its other chains, from 1Click's own
// recorded answers.   node --test test/oneclick-same-coin.test.ts      (from packages/kit)
// Mutations of src/checks/oneclick.ts that must each turn a test here red (re-apply one at a time):
//   1. `|| ONECLICK_SAME_COIN_ROUTES.some(...)` dropped from oneClickFeeBps
//   2. `o === originAsset && d === destinationAsset` -> `d === destinationAsset` (any origin into a listed destination)
//   3. a route's ends swapped (the way back pinned in place of the way read)
/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  checkOneClickQuote,
  oneClickFeeBps,
  oneClickFloors,
  OneClickQuoteError,
  type OneClickCheck,
  type OneClickCheckOptions,
  type OneClickRequest,
} from "../src/checks/oneclick.ts";

type Answer = { quoteRequest: Record<string, unknown>; quote: Record<string, unknown>; signature: string; timestamp: string } & Record<string, unknown>;
const clone = <T>(v: T): T => structuredClone(v);
const at = (a: Answer, ms = 1_000): number => Date.parse(a.timestamp) + ms;
const COLLECTOR = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd";
function refused(check: OneClickCheck, f: () => unknown): void {
  assert.throws(f, (e: unknown) => {
    assert.ok(e instanceof OneClickQuoteError, `not a OneClickQuoteError: ${String(e)}`);
    assert.equal(e.check, check, e.message);
    return true;
  });
}

// Card same-coin-deposits-across-chains-quote: one coin from its other chains. fixtures/oneclick-same-coin.json holds
// 1Click's dry answers through the helper's partner key, 2026-11-14 06:58-07:02Z, of every same-coin listing on its
// token list into the four places money lands (Cash's NEAR USDC, the Solana, Base and Robinhood pools' coins), public and
// "advanced" (confidential), and four of the public answers whole and signed. 1Click charged fee 1 on ETH from Ethereum
// and Arbitrum into Base ETH and on USDC from both into NEAR USDC, both modes, where the kit pinned 20, so such a quote was
// refused "app-fees" (quote_check_failed); it charged 20 into Robinhood ETH from every chain and between Base and
// Robinhood ETH both ways, so those stay 20.
type SameCoinRead = { place: string; blockchain: string; origin: string; destination: string; mode: string; status: number; appFees?: { recipient: string; fee: number }[] };
const sameCoin = JSON.parse(readFileSync(new URL("./fixtures/oneclick-same-coin.json", import.meta.url), "utf8")) as {
  reads: SameCoinRead[];
  signed: Record<"eth_eth_to_base" | "arb_eth_to_base" | "eth_usdc_to_cash" | "arb_usdc_to_cash", { request: OneClickRequest; answer: Answer }>;
};
// One coin on both ends: the device prices both at the same two reads (3,000 USD for ETH, 1 for USDC).
const sameCoinOpts = (a: Answer, decimals: number, usd: string): OneClickCheckOptions =>
  ({ path: "partner", pricing: { in: [usd, usd], out: [usd, usd] }, decimalsIn: decimals, decimalsOut: decimals, intoVault: false, now: at(a) });
const SAME_COIN_SIGNED = [["eth_eth_to_base", 18, "3000"], ["arb_eth_to_base", 18, "3000"], ["eth_usdc_to_cash", 6, "1"], ["arb_usdc_to_cash", 6, "1"]] as const;
const ETHEREUM_OR_ARBITRUM = ["eth", "arb"];
test("same coin from Ethereum or Arbitrum (ETH into the Base pool, USDC into Cash) at 1Click's fee 1 passes the whole check", () => {
  for (const [name, decimals, usd] of SAME_COIN_SIGNED) {
    const { request, answer } = sameCoin.signed[name];
    assert.deepEqual(answer.quoteRequest.appFees, [{ recipient: COLLECTOR, fee: 1 }], name);
    assert.doesNotThrow(() => checkOneClickQuote(request, clone(answer), sameCoinOpts(answer, decimals, usd)), name);
  }
});
test("the kit's fee on each same-coin route from Ethereum or Arbitrum, and into Robinhood ETH, is what 1Click answered, both modes", () => {
  const covered = sameCoin.reads.filter((r) => r.status === 201 && r.appFees?.length === 1 &&
    (ETHEREUM_OR_ARBITRUM.includes(r.blockchain) || r.place === "robinhood" || (r.place === "base" && r.blockchain === "hood")));
  assert.equal(covered.length, 26); // into Cash 2 × 2, into Base 3 × 2, into Robinhood 8 × 2 (Abstract: no liquidity)
  for (const r of covered) assert.equal(oneClickFeeBps("partner", r.origin, r.destination), r.appFees![0]!.fee, `${r.place} from ${r.blockchain} ${r.mode}`);
  // and nowhere does the kit pin 1 where 1Click charged 20 (a pin below the charge refuses; it never lets a fee through)
  for (const r of sameCoin.reads.filter((x) => x.status === 201 && x.appFees?.[0]?.fee === 20))
    assert.equal(oneClickFeeBps("partner", r.origin, r.destination), 20, `${r.place} from ${r.blockchain} ${r.mode}`);
});
test("a pinned same-coin route takes 1Click's fee 1 only: a fee 20 entry on it is refused, as is a fee 1 entry into Robinhood ETH", () => {
  for (const [name, decimals, usd] of SAME_COIN_SIGNED) {
    const { request, answer } = sameCoin.signed[name];
    const a = clone(answer); a.quoteRequest.appFees = [{ recipient: COLLECTOR, fee: 20 }];
    refused("app-fees", () => checkOneClickQuote(request, a, sameCoinOpts(answer, decimals, usd)));
  }
  assert.equal(oneClickFeeBps("partner", "nep141:eth.omft.near", "nep141:hood.omft.near"), 20);
  assert.equal(oneClickFeeBps("partner", "nep141:base.omft.near", "nep141:eth.omft.near"), 20); // the way back is not read: not pinned
});
test("a lower pinned fee raises the device's floor: at F 1 a same-coin quote must deliver more than at F 20", () => {
  const { answer } = sameCoin.signed.eth_eth_to_base;
  const floor = (feeBps: number) => oneClickFloors({ amountIn: BigInt(answer.quote.amountIn as string), withdrawFee: 560_000_000_000n, slippageBps: 100, feeBps,
    pricing: { in: ["3000", "3000"], out: ["3000", "3000"] }, decimalsIn: 18, decimalsOut: 18, intoVault: false });
  assert.ok(floor(1).minAmountOut > floor(20).minAmountOut);
  // and the signed answer clears the F 1 floor: 1Click's own minAmountOut is at or above it
  assert.ok(BigInt(answer.quote.minAmountOut as string) >= floor(1).minAmountOut);
});
