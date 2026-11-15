// Card you-receive-on-every-chain: the trade box's "You receive" and "Fee" on Base and Robinhood. pool.buy.dry on these
// chains answers, with an amount at most tap_max, `cost` (what the tap's own plan costs for good: each planned whole
// piece's relay fee, and for a rest leg its piece's relay fee and the bound the plan keeps for W's own buy) and `out`
// (the device's own quote of the plan's swapped total through the tap's quote path, quoteOf, in whole token units at the
// token's decimals as the tap reads them; left out when that quote fails or is not the one asked). Never while a trade
// runs (busy). Red before this card: no evmBuyDry or evmDryCost in src/pool-buy-evm.ts.
//   node --test test/pool-buy-evm-dry-preview.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvmPoolBuyQuote, EvmPoolBuyQuoteRequest } from "../../kit/src/checks/evm/quote.ts";
import { evmPoolVenues } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { EVM_BUY_TAP_QUOTES } from "../../kit/src/trade/evm/buy-tap.ts";
import { evmBuyDry, evmBuyPieces, evmDryCost, evmDryTap, evmLastRouteReset, evmMostWithCash, evmMovedPieces, evmMoveShort, evmTapBuys, EVM_MOVE_FEE_ROOM, type EvmBuyDryDeps, type EvmDryQuote } from "../src/pool-buy-evm.ts";
import { planEvmBuy, poolUnits, type PoolAsk } from "../src/rules/pool.ts";
import { evmBalancePool, evmTapSpendOf } from "../../wallet/src/pool/balances.ts";

const ETH = 10n ** 18n;
const micro = (n: bigint) => (n * ETH) / 1_000_000n;
type Ready = Parameters<typeof evmBuyPieces>[0][number];
const proof = (noteId: string, chunk: bigint, feeCap: bigint): Ready =>
  ({ noteId, attempt: "a", poolId: "base-eth", wallet: { chain: "evm", l: 1n, j: 0, path: "", address: "0x01" }, chunk, root: "epoch", binding: { feeCap } }) as unknown as Ready;
// two notes: 0.01 ETH at a 0.0001 ETH relay fee, 0.005 ETH at 0.0002: spends 0.0099 and 0.0048, Max 0.0147, bound 0.0002
const READY = [proof("n1", micro(10_000n), micro(100n)), proof("n2", micro(5_000n), micro(200n))];
// a token address of the test's own (twenty 0x12 bytes): the quote is a stub, nothing reads the chain
const COIN = `0x${"12".repeat(20)}`;
const OUT = 123_456_789n; // 123.456789 of a 6-decimal token

type Asked = EvmPoolBuyQuoteRequest[];
/** The tap's quote path's host: `answer` decides each kit quote; every request is kept. */
const quoteHost = (asked: Asked, answer: (req: EvmPoolBuyQuoteRequest) => EvmPoolBuyQuote, decimals = async () => 6): EvmDryQuote => ({
  network: "base",
  venues: evmPoolVenues(),
  indexPools: () => null,
  decimals,
  quote: async (req) => {
    asked.push(req);
    return answer(req);
  },
});
const good = (req: EvmPoolBuyQuoteRequest): EvmPoolBuyQuote =>
  ({ chain: req.chain, token: req.token, amountIn: req.amountIn, route: req.route, block: { number: 1n, hash: "0x00", timestamp: 1n }, amountOut: OUT, minOut: OUT, reference: null }) as unknown as EvmPoolBuyQuote;
const deps = (over: Partial<EvmBuyDryDeps> & { quoteHost?: EvmDryQuote | null } = {}): EvmBuyDryDeps & { reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    trading: over.trading ?? (() => false),
    tap: over.tap ?? (async () => (reads.push("tap"), { tapMax: "0.0147", ready: READY })),
    withCash: over.withCash ?? (async () => (reads.push("cash"), "0.05")),
    quote: () => (over.quoteHost === undefined ? null : over.quoteHost),
    ...(over.fee ? { fee: over.fee } : {}),
    ...(over.moved ? { moved: over.moved } : {}),
  };
};
/** The dry's answer once it settles (unknown: a HostAnswer's `then` is no async function's return type). */
const run = (params: Record<string, unknown>, d: EvmBuyDryDeps): Promise<unknown> => {
  const r = evmBuyDry("base", params, d);
  assert.equal(r.running, true);
  return r.after.then(() => r.answer() as unknown);
};

test("evmDryCost: each whole piece's relay fee; a rest leg's piece's relay fee and the bound the plan keeps for W's own buy", () => {
  const { pieces, bound } = evmBuyPieces(READY);
  const plan = (amount: bigint) => planEvmBuy({ kind: "pool.buy", chain: "base", token: COIN, amount, slippageBps: 0, decimals: 0 } as PoolAsk, pieces, bound);
  assert.equal(evmDryCost(plan(micro(9_900n))), micro(100n), "one whole note");
  assert.equal(evmDryCost(plan(micro(14_700n))), micro(300n), "both whole");
  assert.equal(evmDryCost(plan(micro(1_000n))), micro(400n), "a rest on n2: its fee and the bound");
  assert.equal(evmDryCost(plan(micro(14_600n))), micro(500n), "n1 whole, the rest on n2 (the band, buys 0.0145)");
});

test("pool.buy.dry on base under tap_max: cost from the plan, out from one quote of the plan's swapped total at the token's decimals", async () => {
  evmLastRouteReset();
  const asked: Asked = [];
  const a = await run({ chain: "base", token: COIN, amount: "0.0099" }, deps({ quoteHost: quoteHost(asked, good) }));
  assert.deepEqual(a, { result: { tap_max: "0.0147", with_cash: "0.05", cost: "0.0001", out: "123.456789" } });
  assert.equal(asked.length, 1, "one kit quote");
  assert.equal(asked[0]!.amountIn, micro(9_900n));
  assert.equal(asked[0]!.token, COIN);
  // the band: the plan swaps 0.0145, which is what the one quote asks for
  evmLastRouteReset();
  const band: Asked = [];
  const b = await run({ chain: "base", token: COIN, amount: "0.0146" }, deps({ quoteHost: quoteHost(band, good) }));
  assert.deepEqual(b, { result: { tap_max: "0.0147", with_cash: "0.05", buys: "0.0145", cost: "0.0005", out: "123.456789" } });
  assert.deepEqual(band.map((r) => r.amountIn), [micro(14_500n)]);
});

test("a quote that fails, or is not the one asked, or decimals that fail: cost and no out; never more than the tap's quotes", async () => {
  evmLastRouteReset();
  const down: Asked = [];
  const a = await run({ chain: "base", token: COIN, amount: "0.001" }, deps({ quoteHost: quoteHost(down, () => { throw Object.assign(new Error("rpc"), { code: "rpc_error" }); }) }));
  assert.deepEqual(a, { result: { tap_max: "0.0147", with_cash: "0.05", cost: "0.0004" } });
  assert.equal(down.length, 1, "no retry on a provider error");
  // every route refused: the tap's bound, then no out
  evmLastRouteReset();
  const refused: Asked = [];
  const b = await run({ chain: "base", token: COIN, amount: "0.001" }, deps({ quoteHost: quoteHost(refused, () => { throw Object.assign(new Error("no"), { code: "no_quote", reference: null }); }) }));
  assert.deepEqual(b, { result: { tap_max: "0.0147", with_cash: "0.05", cost: "0.0004" } });
  assert.ok(refused.length <= EVM_BUY_TAP_QUOTES, `${refused.length} quotes`);
  // hostile answers: another amount, another token, nothing out
  for (const bad of [(r: EvmPoolBuyQuoteRequest) => ({ ...good(r), amountIn: r.amountIn + 1n }), (r: EvmPoolBuyQuoteRequest) => ({ ...good(r), token: "0x0000000000000000000000000000000000000001" }), (r: EvmPoolBuyQuoteRequest) => ({ ...good(r), amountOut: 0n })]) {
    evmLastRouteReset();
    const c = await run({ chain: "base", token: COIN, amount: "0.001" }, deps({ quoteHost: quoteHost([], bad as (r: EvmPoolBuyQuoteRequest) => EvmPoolBuyQuote) }));
    assert.deepEqual(c, { result: { tap_max: "0.0147", with_cash: "0.05", cost: "0.0004" } });
  }
  // the token's decimals not read: no out
  evmLastRouteReset();
  const d = await run({ chain: "base", token: COIN, amount: "0.001" }, deps({ quoteHost: quoteHost([], good, async () => { throw new Error("decimals"); }) }));
  assert.deepEqual(d, { result: { tap_max: "0.0147", with_cash: "0.05", cost: "0.0004" } });
  // no pool to quote on: cost alone
  const e = await run({ chain: "base", token: COIN, amount: "0.001" }, deps({ quoteHost: null }));
  assert.deepEqual(e, { result: { tap_max: "0.0147", with_cash: "0.05", cost: "0.0004" } });
});

test("no amount, zero, or over tap_max: no plan, no quote, no cost", async () => {
  for (const amount of [undefined, "0", "0.05"]) {
    const asked: Asked = [];
    const a = await run({ chain: "base", token: COIN, ...(amount === undefined ? {} : { amount }) }, deps({ quoteHost: quoteHost(asked, good) }));
    assert.deepEqual(a, { result: { tap_max: "0.0147", with_cash: "0.05" } }, String(amount));
    assert.equal(asked.length, 0);
  }
});

test("never while a trade runs: busy, with no read; an amount that is no ETH decimal: not_allowed; signed out: not_funded", async () => {
  const d = deps({ trading: () => true, quoteHost: quoteHost([], good) });
  assert.deepEqual(await run({ chain: "base", token: COIN, amount: "0.001" }, d), { error: "busy" });
  assert.deepEqual(d.reads, []);
  assert.deepEqual(await run({ chain: "base", token: COIN, amount: "1e3" }, deps()), { error: "not_allowed" });
  assert.deepEqual(await run({ chain: "base", token: COIN, amount: "0.001" }, deps({ tap: async () => null })), { error: "not_funded" });
  assert.deepEqual(await run({ chain: "base", token: COIN, amount: "0.001" }, deps({ withCash: async () => { throw new Error("cash"); } })), { error: "down" });
  assert.deepEqual(await run({ chain: "base", token: COIN, amount: "0.0099" }, deps({ withCash: async () => null })), { result: { tap_max: "0.0147", cost: "0.0001" } });
});

// Card evm-cash-move-brings-its-fee: above tap_max, the box's You receive and Fee price the buy cashFirst runs after
// moving from Cash, sized by the same plan (evmMoveShort at the epoch's fee). Red before: tap_max alone, no cost or out.
test("above tap_max: cost is the sized plan's plus the move's, out one quote of the whole ask; no fee read or no move priced: tap_max alone", async () => {
  const fee = micro(10n);
  const sized = evmMoveShort(READY, micro(50_000n), fee)!;
  assert.equal(sized.plan.amount, micro(50_000n), "the plan carries the whole ask");
  evmLastRouteReset();
  const asked: Asked = [];
  const shorts: bigint[] = [];
  const a = await run({ chain: "base", token: COIN, amount: "0.05" }, deps({ quoteHost: quoteHost(asked, good), fee: async () => fee, moved: async (s) => (shorts.push(s), micro(300n)) }));
  assert.deepEqual(a, { result: { tap_max: "0.0147", with_cash: "0.05", cost: poolUnits(evmDryCost(sized.plan) + micro(300n), 18), out: "123.456789" } });
  assert.deepEqual(shorts, [sized.short], "the move priced is the one cashFirst sizes");
  assert.deepEqual(asked.map((r) => r.amountIn), [micro(50_000n)], "one quote of the whole ask");
  // no move sized or priced (card buy-quote-before-any-note): no Fee, never one that reads under; You receive still,
  // one quote of the same whole ask, which the tap swaps whatever the move's size
  for (const [name, over] of [["no fee read", { fee: async () => null, moved: async () => micro(300n) }], ["the fee read fails", { fee: async () => { throw new Error("rpc"); }, moved: async () => micro(300n) }], ["no Cash to plan (rungs null), the fee never answers", { fee: () => new Promise<bigint>(() => {}), moved: async () => micro(300n), rungs: async () => null }], ["Cash cannot move it", { fee: async () => fee, moved: async () => null }], ["Cash's plan makes no rungs", { fee: async () => fee, moved: async () => micro(300n), rungs: async () => () => null }], ["the move's price fails", { fee: async () => fee, moved: async () => { throw new Error("price"); } }]] as const) {
    evmLastRouteReset();
    const one: Asked = [];
    const b = await run({ chain: "base", token: COIN, amount: "0.05" }, { ...deps({ quoteHost: quoteHost(one, good), ...(over as Partial<EvmBuyDryDeps>) }), ...("rungs" in over ? { rungs: over.rungs } : {}) });
    assert.deepEqual(b, { result: { tap_max: "0.0147", with_cash: "0.05", out: "123.456789" } }, name);
    assert.deepEqual(one.map((r) => r.amountIn), [micro(50_000n)], name);
  }
});

test("evmMoveShort: the least whole rungs whose notes, each at twice the epoch fee, carry the ask in the tap's own plan", () => {
  const fee = micro(10n);
  // an empty pool: 0.005 ETH asks 0.006 of rungs (0.005 + 0.001: the 0.005 note alone spends 0.005 less its fee)
  const empty = evmMoveShort([], micro(5_000n), fee)!;
  assert.equal(empty.short, micro(6_000n));
  assert.equal(empty.plan.amount, micro(5_000n));
  // the least: one rung less does not carry it
  const { pieces } = evmBuyPieces([]);
  assert.throws(() => planEvmBuy({ kind: "pool.buy", chain: "base", token: COIN, amount: micro(5_000n), slippageBps: 0, decimals: 0 } as PoolAsk, [...pieces, ...evmMovedPieces(micro(5_000n), fee)], fee * EVM_MOVE_FEE_ROOM));
  // with ready notes: only what they leave, the notes' own fees counted
  const withReady = evmMoveShort(READY, micro(20_000n), fee)!;
  assert.equal(withReady.plan.amount, micro(20_000n));
  assert.ok(withReady.short < micro(20_000n) && withReady.short >= micro(5_000n), String(withReady.short));
  assert.equal(evmMoveShort([], 0n, fee), null);
});

test("evmMostWithCash: the most one tap buys with Cash moved first, sized as cashFirst sizes it; every amount up to it the tap carries, the next step not", () => {
  const fee = micro(10n);
  // Cash pays a move of at most 0.01 ETH of rungs (its USDC and withdraw fee, as main.ts prices it)
  const pays = (short: bigint) => short <= micro(10_000n);
  const most = evmMostWithCash(READY, fee, pays, micro(100_000n));
  assert.ok(evmTapBuys(READY, most, fee, pays), "the most is carried");
  assert.ok(!evmTapBuys(READY, most + micro(1n), fee, pays), "one step more is not");
  // more than the ready notes' 0.0147 and less than the ready notes and the whole move (0.0247): each note its own fee
  assert.ok(most > micro(14_700n) && most < micro(24_700n), String(most));
  // no Cash: the ready notes' own most (one bound under their sum, the band); the move's size is checked, never assumed
  const none = evmMostWithCash(READY, fee, () => false, micro(100_000n));
  assert.ok(none <= micro(14_700n) && none > micro(14_000n), String(none));
  assert.equal(evmMostWithCash([], fee, () => false, micro(100_000n)), 0n);
});

// Card base-reads-never-starve-max: a Base or Robinhood dry whose read fails (the proofs' view or Cash's notes, the
// pool's floor or the epoch's fee read for with_cash, the move's fee or rungs above tap_max) answers "down", as Solana's
// dry does, so the box asks again (the app's coinTapAgainMs); "failed" was never asked again, and the box kept Max at
// state.pools' tap_max ($0 on the owner's live Base page, 15 Nov) with You receive a dash. Red at 6c13015c8: "failed".
for (const chain of ["base", "robinhood"] as const) {
  test(`card base-reads-never-starve-max: ${chain}'s dry answers down when any of its reads fails, never failed`, async () => {
    const boom = async (): Promise<never> => { throw new Error("every provider held"); };
    const cases: [string, Partial<EvmBuyDryDeps>, string?][] = [
      ["the proofs' view and notes", { tap: boom }],
      ["with_cash's reads", { withCash: boom }],
      ["the move's fee above tap_max", { fee: boom, moved: async () => 0n }, "0.05"],
      ["the move's cost above tap_max", { fee: async () => micro(10n), moved: boom }, "0.05"],
    ];
    for (const [what, over, amount] of cases) {
      const r = evmBuyDry(chain, { chain, token: COIN, amount: amount ?? "0.001" }, deps(over));
      await r.after;
      const a = r.answer() as { error?: string; result?: unknown };
      // a read the move's sizing makes fails only that part (tap_max still answers); every other: down
      if (a.result !== undefined) assert.ok(what.startsWith("the move's"), `${what}: ${JSON.stringify(a)}`);
      else assert.deepEqual(a, { error: "down" }, what);
    }
  });
}

// Card buy-quote-before-any-note: a fresh account, or one whose money is all Cash, has no pool note, so no proof queue
// is open (it opens at a pool note's landing) and state.pools has no tap_max. Red before: the page's tap read (main.ts)
// gave null, so the dry answered not_funded: no You receive and no Max for the buy cashFirst runs from Cash.
test("card buy-quote-before-any-note: no queue open: tap 0 over no proof; the dry prices the whole ask as the moved buy, with_cash its Max; $0 Cash: out alone", async () => {
  const pool = evmBalancePool("evm:base:p", "base", 33n, evmTapSpendOf);
  const other = evmBalancePool("evm:rh:p", "robinhood", 44n, evmTapSpendOf);
  // a fresh account: no note, no queue; a closed queue over a ready proof: none of it counts
  for (const both of [{ value: [] }, { value: [], ready: [READY[0]!], open: new Set<string>() }]) assert.deepEqual(evmDryTap("base", [pool, other], both), { tapMax: "0", ready: [] });
  // an open queue: state.pools' tap_max and the chain's own proofs only
  const mine = { ...READY[0]!, poolId: pool.id } as Ready;
  const theirs = { ...READY[1]!, poolId: other.id } as Ready;
  const n = { id: "n1", scope: 33n, state: "HELD", attempt: "a", ref: { kind: "deposit", s: 33n, i: 0 }, leaf: { value: micro(10_000n), label: 1n, commitment: 1n, leafIndex: 0n } } as never;
  const open = evmDryTap("base", [pool, other], { value: [n], ready: [mine, theirs], open: new Set([pool.id, other.id]) });
  assert.deepEqual(open.ready, [mine]);
  assert.equal(open.tapMax, "0.0099");
  // the dry over that read: every wei of the ask moved from Cash, sized as cashFirst sizes it (evmMoveShort over none)
  const fee = micro(10n);
  const sized = evmMoveShort([], micro(20_000n), fee)!;
  assert.equal(sized.plan.amount, micro(20_000n));
  const fresh = async () => evmDryTap("base", [pool], { value: [] });
  evmLastRouteReset();
  const asked: Asked = [];
  const shorts: bigint[] = [];
  const a = await run({ chain: "base", token: COIN, amount: "0.02" }, deps({ tap: fresh, withCash: async (tap) => (assert.equal(tap, "0"), "0.04"), quoteHost: quoteHost(asked, good), fee: async () => fee, moved: async (s) => (shorts.push(s), micro(300n)) }));
  assert.deepEqual(a, { result: { tap_max: "0", with_cash: "0.04", cost: poolUnits(evmDryCost(sized.plan) + micro(300n), 18), out: "123.456789" } });
  assert.deepEqual(shorts, [sized.short]);
  assert.deepEqual(asked.map((r) => r.amountIn), [micro(20_000n)], "one quote of the whole ask");
  // $0 Cash: Max 0 and You receive of the typed amount as that Cash buy, no Fee
  evmLastRouteReset();
  const none: Asked = [];
  const b = await run({ chain: "base", token: COIN, amount: "0.02" }, deps({ tap: fresh, withCash: async () => "0", quoteHost: quoteHost(none, good), fee: async () => fee, moved: async () => null }));
  assert.deepEqual(b, { result: { tap_max: "0", with_cash: "0", out: "123.456789" } });
  assert.deepEqual(none.map((r) => r.amountIn), [micro(20_000n)]);
  // no amount: Max alone
  assert.deepEqual(await run({ chain: "base", token: COIN }, deps({ tap: fresh, withCash: async () => "0" })), { result: { tap_max: "0", with_cash: "0" } });
});
