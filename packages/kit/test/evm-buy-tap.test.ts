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

test("a token with 200 indexed pools that all quote nothing, with no route found anywhere, is no_reference after three kit quotes at most", async () => {
  evmBuyTapReset();
  let n = 0;
  await assert.rejects(
    tap(async () => (n++, Promise.reject(new EvmQuoteError("no_quote", "the route reverts or quotes nothing"))), spam(200)),
    (e) => e instanceof EvmBuyTapRefused && e.code === "no_reference",
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
  // card base-coin-quote-check-names-its-cause: its name is the hook's, not_allowed (NOVAAI on Robinhood)
  await assert.rejects(tap(async (r) => (seen.push(JSON.stringify(r.route)), Promise.reject(new EvmQuoteError("no_quote", "x", { amountOut: 1n, route: hooked }))), spam(5)), (e) => e instanceof EvmBuyTapRefused && e.code === "not_allowed");
  assert.ok(!seen.includes(JSON.stringify(hooked)) && seen.length <= 2, seen.join("\n"));
});

test("card base-coin-quote-check-names-its-cause: a route refused for another reason than no route anywhere stays quote_check_failed", async () => {
  evmBuyTapReset();
  await assert.rejects(
    tap(async () => Promise.reject(new EvmQuoteError("partial_fill", "a pool runs out", null)), spam(1)),
    (e) => e instanceof EvmBuyTapRefused && e.code === "quote_check_failed",
  );
  // one try no route anywhere, the other a partial fill: not every refusal is no route, so not no_reference
  evmBuyTapReset();
  let n = 0;
  await assert.rejects(
    tap(async () => Promise.reject(++n === 1 ? new EvmQuoteError("no_quote", "x") : new EvmQuoteError("partial_fill", "y", null)), spam(1)),
    (e) => e instanceof EvmBuyTapRefused && e.code === "quote_check_failed",
  );
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

test("card evm-warm-tap-ends-inside-two-seconds: HOOKR's native_first with no route the tap may take is not_allowed, and a tap at the same held block asks no route that refused there", async (t) => {
  // HOOKR on Robinhood (read-only mainnet taps from the Mac, 2026-11-15 23:50Z, scratchpad ewt/tr-rh1.txt and ref.mjs):
  // its indexed native pool refused partial_fill (NotEnoughLiquidity) naming the WETH-USDG-HOOKR route, which refused
  // native_first naming none; each kit quote took about 1.8 s and 0.5 s of the tap, every warm tap
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const HOOKR = "0x18e674231a58c239dc7daedcffe15ec3a24cff5c";
  const native = { currency0: ZERO, currency1: HOOKR, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const viaUsdg = { venue: "uniswap-v3" as const, tokens: ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", HOOKR], fees: [100, 10_000] };
  let block = "0xb1";
  const asked: string[] = [];
  const quote = async (r: EvmPoolBuyQuoteRequest): Promise<EvmPoolBuyQuote> => {
    asked.push(JSON.stringify(r.route));
    const v3 = r.route.venue === "uniswap-v3";
    await new Promise((go) => setTimeout(go, v3 ? 500 : 1_800));
    if (!v3) throw new EvmQuoteError("partial_fill", "a hookless hop runs out of liquidity (NotEnoughLiquidity)", { amountOut: 177696018052208568545n, route: viaUsdg });
    throw new EvmQuoteError("native_first", "robinhood's WETH is behind an upgradeable proxy and a native route quotes at least as much", null);
  };
  const hookr = () => evmPoolBuyQuoteTap({ chain: "robinhood", token: HOOKR, amountIn: 980_000_000_000_000n, slippageBps: 300 }, { quote, indexPools: () => [native], held: () => block });
  // the tap's time on the mock clock: 100 ms ticks until it ends
  const timed = async (p: Promise<unknown>) => {
    let end: { e?: unknown } | null = null;
    p.then(() => (end = {}), (e: unknown) => (end = { e }));
    let ms = 0;
    for (; end === null && ms < 60_000; ms += 100) {
      await new Promise((go) => setImmediate(go));
      if (end === null) t.mock.timers.tick(100);
    }
    return { ms, e: (end as { e?: unknown } | null)?.e };
  };
  const named = (e: unknown) => e instanceof EvmBuyTapRefused && e.code === "not_allowed";
  evmBuyTapReset();
  const cold = await timed(hookr());
  assert.ok(named(cold.e), String(cold.e));
  assert.equal(asked.length, 2);
  assert.ok(cold.ms >= 2_300, `${cold.ms} ms`);
  // the next tap at the same held block: the same refusal, no kit quote, inside 2 s
  const warm = await timed(hookr());
  assert.ok(named(warm.e), String(warm.e));
  assert.equal(asked.length, 2, asked.join("\n"));
  assert.ok(warm.ms < 2_000, `${warm.ms} ms`);
  // at a new block each route is asked again, as before
  block = "0xb2";
  const next = await timed(hookr());
  assert.ok(named(next.e), String(next.e));
  assert.equal(asked.length, 4);
  // no held block (no head held fresh): nothing is held
  evmBuyTapReset();
  const none = () => evmPoolBuyQuoteTap({ chain: "robinhood", token: HOOKR, amountIn: 980_000_000_000_000n, slippageBps: 300 }, { quote, indexPools: () => [native], held: () => null });
  await timed(none());
  await timed(none());
  assert.equal(asked.length, 8);
});

test("card evm-warm-tap-ends-inside-two-seconds: a provider's fault is never held, and a refusal read while the held block moved is not held", async () => {
  evmBuyTapReset();
  let n = 0;
  const fault = async (): Promise<EvmPoolBuyQuote> => (n++, Promise.reject(new EvmQuoteError("rpc_error", "a provider did not answer")));
  const one = () => evmPoolBuyQuoteTap({ chain: "robinhood", token: TOKEN, amountIn: 10n ** 15n, slippageBps: 300 }, { quote: fault, indexPools: () => spam(1), held: () => "0xb1" });
  await assert.rejects(one(), (e) => e instanceof EvmQuoteError && e.code === "rpc_error");
  await assert.rejects(one(), (e) => e instanceof EvmQuoteError && e.code === "rpc_error");
  assert.equal(n, 2);
  evmBuyTapReset();
  let at = 0;
  let m = 0;
  const moving = () => `0xb${at++}`;
  const refuse = async (): Promise<EvmPoolBuyQuote> => (m++, Promise.reject(new EvmQuoteError("no_quote", "x")));
  const two = () => evmPoolBuyQuoteTap({ chain: "robinhood", token: TOKEN, amountIn: 10n ** 15n, slippageBps: 300 }, { quote: refuse, indexPools: () => spam(1), held: moving });
  await assert.rejects(two(), (e) => e instanceof EvmBuyTapRefused);
  const first = m;
  await assert.rejects(two(), (e) => e instanceof EvmBuyTapRefused);
  assert.equal(m, 2 * first);
});
