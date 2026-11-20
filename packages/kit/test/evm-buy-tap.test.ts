// The kit's buy tap quote (src/trade/evm/buy-tap.ts evmPoolBuyQuoteTap), through the kit's public entry, on planted
// quotes: three kit quotes at most however many pools a token has, a refusal's own best route asked once where the hook
// rule takes it, and a named refusal when none quotes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { enableTimers, resetTimers } from "./mock-timers.ts";
import { EVM_BUY_TAP_QUOTES, EVM_BUY_WARM_EVERY_MS, EVM_BUY_WARM_IN, EvmBuyTapRefused, EvmQuoteError, evmBuyTapReset, evmPoolBuyQuoteTap, evmPoolBuyWarm, type EvmPoolBuyQuote, type EvmPoolBuyQuoteRequest, type EvmPoolKey } from "../src/index.ts";

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

test("TAPAT a followed reference is asked at the block its refusal was read at (`at`), the first ask at none (card evm-cold-multihop-quote-inside-the-kpi)", async () => {
  evmBuyTapReset();
  const real = { venue: "uniswap-v3" as const, tokens: ["0x0bd7d308f8e1639fab988df18a8011f41eacad73", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", TOKEN], fees: [500, 10_000] };
  const AT = "0x" + "ab".repeat(32);
  const asks: { route: string; at: unknown }[] = [];
  const q = await tap(async (r) => {
    asks.push({ route: JSON.stringify(r.route), at: (r as { at?: unknown }).at });
    if (JSON.stringify(r.route) === JSON.stringify(real)) return { route: real } as unknown as EvmPoolBuyQuote;
    const e = new EvmQuoteError("no_quote", "the route reverts or quotes nothing", { amountOut: 1n, route: real });
    (e as { at: string | null }).at = AT;
    return Promise.reject(e);
  }, spam(1));
  assert.deepEqual(q.route, real);
  assert.equal(asks.length, 2);
  assert.equal(asks[0]!.at, undefined, "the first ask named a block");
  assert.equal(asks[1]!.at, AT, "the reference was not asked at the refusal's block");
});

test("TAPAT2 the second try (a v3 tier after the first route's refusal) is asked at the block that refusal was read at, as a follow is (card evm-warm-tap-ends-inside-two-seconds)", async () => {
  // ANTc on Base (read-only mainnet taps from the Mac, 2026-11-20 08:4xZ): its indexed native pool partial_fill with a
  // reference through a hook the venue does not list, then the first v3 tier no_quote; the second kit quote, at no
  // block, read the whole search again at a new one: 3347-6878 ms of a 6886 ms warm tap, the same four rounds as the first
  const AT = "0x" + "ab".repeat(32);
  const hooked = { venue: "uniswap-v4" as const, currencyIn: ZERO, hops: [{ currency: TOKEN, fee: 0, tickSpacing: 60, hooks: "0x0af57f6200000000000000000000000000000000", hookData: "0x" as const }] };
  for (const [first, ref] of [["partial_fill", hooked], ["no_quote", null]] as const) {
    evmBuyTapReset();
    const asks: { route: EvmPoolBuyQuoteRequest["route"]; at: unknown }[] = [];
    await assert.rejects(
      tap(async (r) => {
        asks.push({ route: r.route, at: (r as { at?: unknown }).at });
        const e = new EvmQuoteError(asks.length === 1 ? first : "no_quote", "x", asks.length === 1 ? ref && { amountOut: 1n, route: ref } : null);
        (e as { at: string | null }).at = AT;
        return Promise.reject(e);
      }, [{ currency0: ZERO, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: ZERO }]),
      (e) => e instanceof EvmBuyTapRefused,
    );
    assert.equal(asks.length, 2, `${first}: ${asks.length} asks`);
    assert.equal(asks[0]!.route.venue, "uniswap-v4");
    assert.equal(asks[1]!.route.venue, "uniswap-v3", `${first}: the second try is a v3 tier`);
    assert.equal(asks[0]!.at, undefined, `${first}: the first ask named a block`);
    assert.equal(asks[1]!.at, AT, `${first}: the second try was not asked at the first refusal's block`);
  }
  // a first refusal that names no block (a fault-free refusal read at none): the second try names none either
  evmBuyTapReset();
  const ats: unknown[] = [];
  await assert.rejects(tap(async (r) => (ats.push((r as { at?: unknown }).at), Promise.reject(new EvmQuoteError("no_quote", "x"))), [{ currency0: ZERO, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: ZERO }]));
  assert.deepEqual(ats, [undefined, undefined]);
});

// Card evm-warm-tap-ends-inside-two-seconds, round 5: one tap reads one block. The second try is asked at the first
// try's block even where the held head moved during the first quote (at 387c0c30a it was asked at the new head: ANTc on
// Base ran its whole search twice, at two blocks, 142-152 requests and about 4.5 s every warm tap, from the Mac
// 2026-11-20 11:3xZ), and each refusal is held for the block it was read at, never for the head the tap ends on.
const A = "0x" + "aa".repeat(32);
const B = "0x" + "bb".repeat(32);
const onePool = [{ currency0: ZERO, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: ZERO }];
// a tap whose quotes refuse no_quote, each naming the block it read at (its `at`, else the head), and whose head moves
// from A to B while the first quote runs where `moves`
const heldWorld = (moves: boolean) => {
  let head = A;
  const asks: { venue: string; at: unknown }[] = [];
  const quote = async (r: EvmPoolBuyQuoteRequest) => {
    asks.push({ venue: r.route.venue, at: (r as { at?: unknown }).at });
    const readAt = (r as { at?: string }).at ?? head;
    if (moves && asks.length === 1) head = B;
    const e = new EvmQuoteError("no_quote", "x");
    (e as { at: string | null }).at = readAt;
    return Promise.reject(e);
  };
  const go = () => evmPoolBuyQuoteTap({ chain: "robinhood", token: TOKEN, amountIn: 10n ** 15n, slippageBps: 300 }, { quote, indexPools: () => onePool, held: () => head });
  return { asks, go, to: (h: string) => void (head = h) };
};

test("TAPAT3 the second try is asked at the first try's block when the held head moved during the first quote", async () => {
  evmBuyTapReset();
  const w = heldWorld(true);
  await assert.rejects(w.go(), (e) => e instanceof EvmBuyTapRefused);
  assert.deepEqual(w.asks.map((a) => a.venue), ["uniswap-v4", "uniswap-v3"]);
  assert.equal(w.asks[0]!.at, undefined, "the first ask named a block");
  assert.equal(w.asks[1]!.at, A, "the second try was not asked at the first try's block");
});

test("TAPHOLD3 the tap's refusals are held for the block they were read at: a tap at that block asks none, one at a later head asks again", async () => {
  for (const moves of [true, false]) {
    evmBuyTapReset();
    const w = heldWorld(moves);
    await assert.rejects(w.go(), (e) => e instanceof EvmBuyTapRefused);
    // a tap at A, the block both refusals were read at: none asked
    w.to(A);
    let n = w.asks.length;
    await assert.rejects(w.go(), (e) => e instanceof EvmBuyTapRefused);
    assert.equal(w.asks.length - n, 0, `head moved ${moves}: a tap at the refusals' block asked ${w.asks.length - n} quotes`);
    // a tap at B, a later head: both asked again, at B
    w.to(B);
    n = w.asks.length;
    await assert.rejects(w.go(), (e) => e instanceof EvmBuyTapRefused);
    assert.deepEqual(w.asks.slice(n).map((a) => a.venue), ["uniswap-v4", "uniswap-v3"], `head moved ${moves}: a tap at a later head`);
  }
});

test("TAPHOLD4 a refusal is never served for a block it was not read at: read at X while the held head was H, it is served at X alone", async () => {
  const H = "0x" + "11".repeat(32);
  const X = "0x" + "22".repeat(32);
  evmBuyTapReset();
  let head = H;
  let n = 0;
  const quote = async () => {
    n++;
    const e = new EvmQuoteError("no_quote", "x");
    (e as { at: string | null }).at = X;
    return Promise.reject(e);
  };
  const go = () => evmPoolBuyQuoteTap({ chain: "robinhood", token: TOKEN, amountIn: 10n ** 15n, slippageBps: 300 }, { quote, indexPools: () => onePool, held: () => head });
  await assert.rejects(go());
  // at H: asked again (the refusals were read at X)
  let m = n;
  await assert.rejects(go());
  assert.ok(n > m, `a tap at H was served a refusal read at X (${m} then ${n} quotes)`);
  // at X: served, no quote
  head = X;
  m = n;
  await assert.rejects(go());
  assert.equal(n, m, `a tap at X asked ${n - m} quotes`);
});

test("TAPHELD a refusal read at the held head is held for it; one read at another block (a follow's) is not, so the next tap asks again (card evm-cold-multihop-quote-inside-the-kpi)", async () => {
  const HEAD = "0x" + "ab".repeat(32);
  for (const [readAt, held] of [[HEAD, true], ["0x" + "cd".repeat(32), false], [null, true]] as const) {
    evmBuyTapReset();
    let n = 0;
    const quote = async () => {
      n++;
      const e = new EvmQuoteError("no_quote", "the route reverts or quotes nothing");
      (e as { at: string | null }).at = readAt;
      return Promise.reject(e);
    };
    const go = () => evmPoolBuyQuoteTap({ chain: "robinhood", token: TOKEN, amountIn: 10n ** 15n, slippageBps: 300 }, { quote, indexPools: () => spam(1), held: () => HEAD });
    await assert.rejects(go());
    const first = n;
    await assert.rejects(go());
    assert.equal(n === first, held, `read at ${readAt}: ${first} then ${n} quotes`);
  }
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
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  t.after(() => resetTimers(t.mock.timers));
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

// Card evm-quote-warm-from-the-coin-page: the coin page's warm is one buy tap quote of the coin at EVM_BUY_WARM_IN, what
// it ends in dropped; one a coin at a time and none again within EVM_BUY_WARM_EVERY_MS; a hostile ask reads nothing.
test("card evm-quote-warm-from-the-coin-page: a warm asks one tap at EVM_BUY_WARM_IN and drops its refusal; again within EVM_BUY_WARM_EVERY_MS it asks nothing, after it once more; a hostile ask asks nothing", async () => {
  evmBuyTapReset();
  const asked: EvmPoolBuyQuoteRequest[] = [];
  const route = { venue: "uniswap-v3" as const, tokens: ["0x0bd7d308f8e1639fab988df18a8011f41eacad73", TOKEN], fees: [10_000] };
  const quote = async (r: EvmPoolBuyQuoteRequest) => (asked.push(r), Promise.reject(new EvmQuoteError("no_quote", "the route reverts or quotes nothing", { amountOut: 1n, route })));
  let t = 1_000;
  const now = () => t;
  const host = { quote, indexPools: () => [] };
  await evmPoolBuyWarm({ chain: "robinhood", token: TOKEN }, host, now);
  assert.ok(asked.length >= 1 && asked.length <= EVM_BUY_TAP_QUOTES, `${asked.length} kit quotes`);
  assert.ok(asked.every((r) => r.amountIn === EVM_BUY_WARM_IN && r.chain === "robinhood" && r.token === TOKEN && r.at === undefined), JSON.stringify(asked, (_, x) => (typeof x === "bigint" ? String(x) : x)));
  const first = asked.length;
  // the same coin again, in any case of its address, within the bound: nothing asked
  t += EVM_BUY_WARM_EVERY_MS - 1;
  await evmPoolBuyWarm({ chain: "robinhood", token: TOKEN.toUpperCase().replace("0X", "0x") }, host, now);
  assert.equal(asked.length, first);
  // past it: one warm more
  t += 1;
  await evmPoolBuyWarm({ chain: "robinhood", token: TOKEN }, host, now);
  assert.equal(asked.length, 2 * first);
  // two warms at once share one run
  evmBuyTapReset();
  asked.length = 0;
  await Promise.all([evmPoolBuyWarm({ chain: "robinhood", token: TOKEN }, host, now), evmPoolBuyWarm({ chain: "robinhood", token: TOKEN }, host, now)]);
  assert.equal(asked.length, first);
  // hostile asks: nothing read, nothing thrown
  asked.length = 0;
  for (const bad of [null, {}, { chain: "robinhood" }, { chain: "robinhood", token: "0x12" }, { chain: "robinhood", token: TOKEN + "00" }, { chain: 7, token: TOKEN }]) {
    await evmPoolBuyWarm(bad as never, host, now);
  }
  assert.equal(asked.length, 0);
  // a chain with no venue: the tap's own refusal, dropped
  await evmPoolBuyWarm({ chain: "nowhere" as never, token: TOKEN }, host, now);
  assert.equal(asked.length, 0);
});

// Card robinhood-tap-asks-no-missing-v3-tier: release 175's walk read robinhood.drpc.org and publicnode answer code 3 to
// the swap-fit read (the pool's buySwap, 0x25faf2a3) of the v3 tier the tap asked for 0x0b7c6c13 on Robinhood, which
// has no v3 pool at any of the four tiers (the factory's getPool the zero address at each, read on two providers). The
// tap reads the factory's getPool for every tier in one read and asks only a tier that has a pool.
const V3_TIERS = [3000, 500, 10_000, 100];
const v3Fee = (r: EvmPoolBuyQuoteRequest) => (r.route.venue === "uniswap-v3" ? r.route.fees.join("/") : null);
const tierTap = (v3Tiers: ((chain: string, token: string, fees: readonly number[]) => Promise<readonly boolean[] | null>) | undefined, pools: EvmPoolKey[] | null, asked: EvmPoolBuyQuoteRequest[], reference: EvmPoolBuyQuote["route"] | null = null) =>
  evmPoolBuyQuoteTap({ chain: "robinhood", token: TOKEN, amountIn: 10n ** 15n, slippageBps: 300 }, {
    quote: async (r) => (asked.push(r), Promise.reject(new EvmQuoteError("no_quote", "the route reverts or quotes nothing", reference === null ? null : { amountOut: 1n, route: reference }))),
    indexPools: () => pools,
    held: () => null,
    ...(v3Tiers === undefined ? {} : { v3Tiers }),
  });

test("NOTIER a v3 tier the factory holds no pool at is never asked: the tier that has one is, after the token's own v4 pool", async () => {
  evmBuyTapReset();
  const asked: EvmPoolBuyQuoteRequest[] = [];
  const reads: { chain: string; token: string; fees: readonly number[] }[] = [];
  await assert.rejects(tierTap(async (chain, token, fees) => (reads.push({ chain, token, fees }), fees.map((f) => f === 10_000)), spam(1), asked), (e) => e instanceof EvmBuyTapRefused);
  assert.deepEqual(asked.map(v3Fee), [null, "10000"], "a tier with no pool was asked, or the one with a pool was not");
  assert.deepEqual(reads, [{ chain: "robinhood", token: TOKEN, fees: V3_TIERS }], "the tiers were not read in one read");
});

test("NOTIER 0x0b7c6c13's shape: no tier has a pool, so the tap asks only the token's own v4 pool", async () => {
  evmBuyTapReset();
  const asked: EvmPoolBuyQuoteRequest[] = [];
  await assert.rejects(tierTap(async (_c, _t, fees) => fees.map(() => false), spam(1), asked), (e) => e instanceof EvmBuyTapRefused && e.code === "no_reference");
  assert.deepEqual(asked.map(v3Fee), [null]);
});

test("NOTIER a tier read that fails or answers nothing leaves every tier asked as before", async () => {
  for (const reader of [async () => null, async () => Promise.reject(new Error("down")), async () => [true]] as const) {
    evmBuyTapReset();
    const asked: EvmPoolBuyQuoteRequest[] = [];
    await assert.rejects(tierTap(reader, spam(1), asked), (e) => e instanceof EvmBuyTapRefused);
    assert.deepEqual(asked.map(v3Fee), [null, "3000"]);
  }
});

test("NOTIER no route the tap may take and no v3 pool: one ask still runs the kit's search, and its reference is followed", async () => {
  evmBuyTapReset();
  const real = { venue: "uniswap-v3" as const, tokens: ["0x0bd7d308f8e1639fab988df18a8011f41eacad73", "0x5fc5360d0400a0fd4f2af552add042d716f1d168", TOKEN], fees: [100, 10_000] };
  const asked: EvmPoolBuyQuoteRequest[] = [];
  const q = await evmPoolBuyQuoteTap({ chain: "robinhood", token: TOKEN, amountIn: 10n ** 15n, slippageBps: 300 }, {
    quote: async (r) => (asked.push(r), JSON.stringify(r.route) === JSON.stringify(real) ? ({ route: real } as unknown as EvmPoolBuyQuote) : Promise.reject(new EvmQuoteError("no_quote", "x", { amountOut: 1n, route: real }))),
    indexPools: () => [],
    held: () => null,
    v3Tiers: async (_c, _t, fees) => fees.map(() => false),
  });
  assert.deepEqual(q.route, real);
  assert.equal(asked.length, 2, asked.map((r) => JSON.stringify(r.route)).join("\n"));
});

test("NOTIER a tier read is kept for the coin: a second tap within EVM_BUY_WARM_EVERY_MS reads none", async () => {
  evmBuyTapReset();
  let n = 0;
  const reader = async (_c: string, _t: string, fees: readonly number[]) => (n++, fees.map(() => false));
  await assert.rejects(tierTap(reader, spam(1), []));
  await assert.rejects(tierTap(reader, spam(1), []));
  assert.equal(n, 1);
});

test("NOTIER evmPoolV3Tiers: one aggregate3 of a getPool a tier to the pinned factory, one call on each of two providers; a tier has no pool only where both answer the zero address", async () => {
  const { evmPoolV3Tiers } = await import("../src/trade/evm/buy-tap.ts");
  const { evmPoolVenues } = await import("../src/trade/evm/buy-unpinned.ts");
  const v = evmPoolVenues().robinhood!;
  const COIN = "0x0b7c6c138dc75622f4200d157b13fb93e6bd94fa";
  const POOL = 0x11n;
  const w = (x: bigint | number) => BigInt(x).toString(16).padStart(64, "0");
  // aggregate3's answer: (bool success, bytes returnData)[], each element (success, 0x40, length, data)
  const result = (each: ({ ok: boolean; data: string } | null)[]) =>
    "0x" + w(32) + w(each.length) + each.map((_, i) => w(32 * each.length + 128 * i)).join("") + each.map((e) => w(e?.ok ? 1 : 0) + w(64) + w(32) + (e?.data ?? w(0))).join("");
  const run = async (answer: (host: string, fees: number[]) => unknown) => {
    const posts: { host: string; calls: { method: string; params: [{ to: string; data: string }, string] }[] }[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const host = new URL(String(url)).host;
      const calls = JSON.parse(String(init?.body));
      posts.push({ host, calls });
      const out = calls.map((c: { id: number; params: [{ data: string }] }) => {
        const d = c.params[0].data.slice(10);
        const n = Number(BigInt("0x" + d.slice(64, 128)));
        // each element's getPool call data: its fee is the call data's last word (100 bytes in, 128 kept)
        const fees = Array.from({ length: n }, (_, i) => Number(BigInt("0x" + d.slice(128 + 64 * n + 512 * i + 256 + 8 + 128, 128 + 64 * n + 512 * i + 256 + 8 + 192))));
        const a = answer(host, fees);
        return a instanceof Error ? { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: a.message } } : { jsonrpc: "2.0", id: c.id, result: a };
      });
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { got: await evmPoolV3Tiers("robinhood", COIN, V3_TIERS, fetchFn), posts };
  };
  const pools = (f: (fee: number) => bigint | null) => (_h: string, fees: number[]) => result(fees.map((fee) => (f(fee) === null ? { ok: false, data: w(0) } : { ok: true, data: w(f(fee)!) })));
  // every tier empty on both: none has a pool; one post a provider, two providers, one eth_call to Multicall3 holding
  // the pinned factory's getPool(WETH, coin, fee) for each tier in order
  const a = await run(pools(() => 0n));
  assert.deepEqual(a.got, [false, false, false, false]);
  assert.equal(a.posts.length, 2);
  assert.equal(new Set(a.posts.map((p) => p.host)).size, 2);
  const sent = (fee: number) => "1698ee82" + w(BigInt(v.weth)) + w(BigInt(COIN)) + w(fee) + "0".repeat(56);
  const want = "0x82ad56cb" + w(32) + w(4) + [0, 1, 2, 3].map((i) => w(128 + 256 * i)).join("") + V3_TIERS.map((f) => w(BigInt(v.v3Factory!)) + w(1) + w(96) + w(100) + sent(f)).join("");
  for (const p of a.posts) assert.deepEqual(p.calls.map((c) => [c.method, c.params[0].to.toLowerCase(), c.params[0].data, c.params[1]]), [["eth_call", "0xca11bde05977b3631167028862be2a173976ca11", want, "latest"]]);
  // one provider names a pool at 500: that tier is asked
  const first = a.posts[0]!.host;
  assert.deepEqual((await run((h, fees) => pools((fee) => (h === first && fee === 500 ? POOL : 0n))(h, fees))).got, [false, true, false, false]);
  // a getPool that failed in the aggregate, an answer of another length, a call's error, a result that is not words, a
  // failed post: the tier (or every tier) stays asked
  assert.deepEqual((await run((h, fees) => pools((fee) => (h === first && fee === 3000 ? null : 0n))(h, fees))).got, [true, false, false, false]);
  assert.deepEqual((await run((h, fees) => (h === first ? result(fees.slice(1).map(() => ({ ok: true, data: w(0) }))) : pools(() => 0n)(h, fees)))).got, [true, true, true, true]);
  assert.deepEqual((await run((h, fees) => (h === first ? new Error("Batch of more than 3 requests are not allowed on free plan") : pools(() => 0n)(h, fees)))).got, [true, true, true, true]);
  assert.deepEqual((await run((h, fees) => (h === first ? "0x" : pools(() => 0n)(h, fees)))).got, [true, true, true, true]);
  assert.deepEqual((await run((h, fees) => (h === first ? (() => { throw new TypeError("Failed to fetch"); })() : pools(() => 0n)(h, fees)))).got, [true, true, true, true]);
  // a chain that pins no v3 factory, or a token that is not an address: not known, nothing read
  let n = 0;
  const f = (async () => (n++, new Response("[]"))) as unknown as typeof fetch;
  assert.deepEqual([await evmPoolV3Tiers("robinhood-testnet", COIN, V3_TIERS, f), await evmPoolV3Tiers("robinhood", "0x12", V3_TIERS, f), n], [null, null, 0]);
});
