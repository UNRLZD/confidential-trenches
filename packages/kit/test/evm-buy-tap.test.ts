// The kit's buy tap quote (src/trade/evm/buy-tap.ts evmPoolBuyQuoteTap), through the kit's public entry, on planted
// quotes: three kit quotes at most however many pools a token has, a refusal's own best route asked once where the hook
// rule takes it, and a named refusal when none quotes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EVM_BUY_TAP_QUOTES, EvmBuyTapRefused, EvmQuoteError, evmBuyTapReset, evmPoolBuyQuoteTap, type EvmPoolBuyQuote, type EvmPoolBuyQuoteRequest, type EvmPoolKey } from "../src/index.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const TOKEN = "0x00000000000000000000000000000000000ca5ca";
const spam = (n: number): EvmPoolKey[] => Array.from({ length: n }, (_, i) => ({ currency0: ZERO, currency1: TOKEN, fee: 10_000 + i, tickSpacing: 215, hooks: ZERO }));
const tap = (quote: (r: EvmPoolBuyQuoteRequest) => Promise<EvmPoolBuyQuote>, pools: EvmPoolKey[] | null) =>
  evmPoolBuyQuoteTap({ chain: "robinhood", token: TOKEN, amountIn: 10n ** 15n, slippageBps: 300 }, { quote, indexPools: () => pools });

test("a token with 200 indexed pools that all quote nothing is a named refusal after three kit quotes at most", async () => {
  evmBuyTapReset();
  let n = 0;
  await assert.rejects(
    tap(async () => (n++, Promise.reject(new EvmQuoteError("no_quote", "the route reverts or quotes nothing"))), spam(200)),
    (e) => e instanceof EvmBuyTapRefused && e.code === "quote_check_failed",
  );
  assert.ok(n <= EVM_BUY_TAP_QUOTES && EVM_BUY_TAP_QUOTES === 3, `${n} quotes`);
});

test("a refusal naming the kit's best route asks it once; one through a hook the venue does not list is never asked", async () => {
  evmBuyTapReset();
  const real = { venue: "uniswap-v3" as const, tokens: ["0x0bd7d308f8e1639fab988df18a8011f41eacad73", TOKEN], fees: [10_000] };
  const asked: string[] = [];
  const q = await tap(async (r) => {
    asked.push(JSON.stringify(r.route));
    if (JSON.stringify(r.route) === JSON.stringify(real)) return { route: real } as unknown as EvmPoolBuyQuote;
    return Promise.reject(new EvmQuoteError("partial_fill", "a pool runs out", { amountOut: 1n, route: real }));
  }, spam(5));
  assert.deepEqual(q.route, real);
  assert.equal(asked.length, 2);
  evmBuyTapReset();
  const hooked = { venue: "uniswap-v4" as const, currencyIn: ZERO, hops: [{ currency: TOKEN, fee: 0, tickSpacing: 60, hooks: "0x0af57f6200000000000000000000000000000000", hookData: "0x" as const }] };
  const seen: string[] = [];
  await assert.rejects(tap(async (r) => (seen.push(JSON.stringify(r.route)), Promise.reject(new EvmQuoteError("no_quote", "x", { amountOut: 1n, route: hooked }))), spam(5)), EvmBuyTapRefused);
  assert.ok(!seen.includes(JSON.stringify(hooked)) && seen.length <= 2, seen.join("\n"));
});

test("a reference quoted again and refused for a better one is followed inside the bound; past it the kit's refusal is the tap's", async () => {
  // AERO and GOOGLc on Base, CRCL on Robinhood (2026-11-13): the pools moved between the two quotes and the reference
  // itself was refused below_reference or native_first, which the tap gave up on
  const tier = (fee: number) => ({ venue: "uniswap-v3" as const, tokens: ["0x0bd7d308f8e1639fab988df18a8011f41eacad73", TOKEN], fees: [fee] });
  evmBuyTapReset();
  const asked: string[] = [];
  const q = await tap(async (r) => {
    asked.push(JSON.stringify(r.route));
    if (asked.length === 1) return Promise.reject(new EvmQuoteError("below_reference", "x", { amountOut: 2n, route: tier(500) }));
    if (asked.length === 2) return Promise.reject(new EvmQuoteError("native_first", "y", { amountOut: 3n, route: tier(10_000) }));
    return { route: r.route } as unknown as EvmPoolBuyQuote;
  }, spam(1));
  assert.deepEqual(q.route, tier(10_000));
  assert.equal(asked.length, 3);
  evmBuyTapReset();
  let n = 0;
  await assert.rejects(
    tap(async () => (n++, Promise.reject(new EvmQuoteError("below_reference", "z", { amountOut: BigInt(n), route: tier(100 + n) }))), spam(1)),
    (e) => e instanceof EvmQuoteError && e.code === "below_reference",
  );
  assert.equal(n, EVM_BUY_TAP_QUOTES);
});
