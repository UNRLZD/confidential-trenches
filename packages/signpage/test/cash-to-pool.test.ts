// cash-to-pool.ts (card one-balance-buys-on-every-chain, part 1; keyless-vault §5): Cash moves out of the NEAR vault into
// the pool of the chain the user trades, in the background (cashMover), and a tap above one tap's spend waits for that
// move and buys the whole ask (cashFirst).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolAsk } from "../src/rules/pool.ts";
import type { HostRefusal, KindContext, Running } from "../src/api.ts";
import { withCash, cashFirst, cashLamportsFor, cashMover, CASH_MOVE_POLL_MS, CASH_MOVE_WAIT_MS, type CashMoverDeps, type CashQuote, type CashRail, type CashToPoolDeps } from "../src/cash-to-pool.ts";

const TOKEN = "So11111111111111111111111111111111111111112";
const ADDRESS = "a".repeat(64);
const ask = (amount: bigint): PoolAsk => ({ kind: "pool.buy", chain: "solana", token: TOKEN, amount, slippageBps: 100, decimals: 6 });
const ctx = (): KindContext & { routes: unknown[] } => {
  const routes: unknown[] = [];
  return { id: "r1", sha: "00", routes, progress: () => {}, route: (r) => void routes.push(r) };
};

// --- the mover

const PRICE = { price: "8000000000", expo: -8 }; // SOL at 80 USD
type Paid = { recipient: string; amount: bigint; fee: bigint };
function mover(o: { floor?: bigint | null; cash?: bigint; quote?: (usdc: bigint) => CashQuote | { error: string }; end?: string; price?: null; landed?: (id: string) => boolean; hold?: Promise<void> }) {
  const paid: Paid[] = [], quoted: { chain: string; usdc: bigint; id: string; rail: CashRail }[] = [];
  let clock = 1_000;
  const d: CashMoverDeps = {
    price: (c) => (o.price === null ? null : c === "solana" ? PRICE : { price: "300000000000", expo: -8 }),
    floor: async () => (o.floor === undefined ? 1_020_000_000_000_000n : o.floor),
    rails: ["1click"],
    quote: async (chain, usdc, id, rail) => (quoted.push({ chain, usdc, id, rail }), o.quote?.(usdc) ?? { address: ADDRESS, amountIn: usdc, minOut: (usdc * 10n ** 9n) / 80_000_000n }),
    fee: async () => 50_000n,
    cash: async () => o.cash ?? 1_000_000_000n,
    handoff: async (w, fee) => (paid.push({ recipient: w.recipient, amount: w.amount, fee }), await o.hold, { kind: (o.end ?? "arrived") as "arrived" }),
    landed: async (id) => o.landed?.(id) ?? false,
    now: () => clock,
  };
  return { m: cashMover(d), paid, quoted, tick: (ms: number) => void (clock += ms) };
}

test("cashMover.need: Cash pays the quote's deposit address for the shortfall plus the least rung and 3%, at the device's price", async () => {
  const t = mover({});
  assert.equal(await t.m.need("solana", 300_000_000n), "cash/solana/1000", "the move op's id");
  // 0.3 SOL + 0.01 SOL at 80 USD = 24.8 USD, 3% over = 25.544 USD
  assert.deepEqual(t.quoted.map((q) => [q.chain, q.usdc, q.rail, q.id]), [["solana", 25_544_000n, "1click", "cash/solana/1000/1click"]]);
  assert.deepEqual(t.paid, [{ recipient: ADDRESS, amount: 25_544_000n, fee: 50_000n }]);
});

test("cashMover.need: a second need for a shortfall already on its way joins it; a larger one moves only what is left", async () => {
  const t = mover({});
  await t.m.need("solana", 300_000_000n);
  assert.equal(await t.m.need("solana", 300_000_000n), "cash/solana/1000", "the tap after the typing: the move on its way, by its op");
  assert.equal(t.paid.length, 1, "never moved twice");
  await t.m.need("solana", 400_000_000n);
  assert.equal(t.paid.length, 2);
  assert.ok(t.quoted[1]!.usdc < t.quoted[0]!.usdc, "only what the first move does not cover");
});

test("cashMover.need: a move whose follow op ended (landed in the pool) or that failed no longer counts as on its way", async () => {
  const landed = mover({ landed: () => true });
  await landed.m.need("solana", 300_000_000n);
  await landed.m.need("solana", 300_000_000n);
  assert.equal(landed.paid.length, 2, "landed: the shortfall now is a new one");
  const failed = mover({ end: "expired" });
  await failed.m.need("solana", 300_000_000n);
  await failed.m.need("solana", 300_000_000n);
  assert.equal(failed.paid.length, 2);
});

test("cashMover.need: no price, Cash short of the amount and its fee, or a refused quote: false, nothing withdrawn", async () => {
  for (const [name, o] of [["no price", { price: null }], ["Cash short", { cash: 25_593_999n }], ["refused", { quote: () => ({ error: "above_max" }) }]] as const) {
    const t = mover(o as never);
    assert.equal(await t.m.need("solana", 300_000_000n), null, name);
    assert.deepEqual(t.paid, [], name);
  }
});

test("cashMover.need: a quote that is not a NEAR implicit account, not the USDC asked, or under the shortfall withdraws nothing", async () => {
  for (const q of [
    { address: "intents.near", amountIn: 25_544_000n, minOut: 320_000_000n },
    { address: "A".repeat(64), amountIn: 25_544_000n, minOut: 320_000_000n },
    { address: ADDRESS, amountIn: 25_544_001n, minOut: 320_000_000n },
    { address: ADDRESS, amountIn: 25_544_000n, minOut: 299_999_999n },
  ]) {
    const t = mover({ quote: () => q });
    assert.equal(await t.m.need("solana", 300_000_000n), null, JSON.stringify(q, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
    assert.deepEqual(t.paid, []);
  }
});

test("cashMover.need on Base and Robinhood: a whole note of the asked rung, never part of one: the quote's least is the rung plus one deposit's gas (the pool's floor less its least rung), the USDC that at the device's ETH price and 3% over", async () => {
  for (const chain of ["base", "robinhood"] as const) {
    const t = mover({ quote: (usdc) => ({ address: ADDRESS, amountIn: usdc, minOut: 5_020_000_000_000_000n }) });
    // 0.005 ETH + 0.00002 ETH gas at 3,000 USD, 3% over = 15.5118 USDC
    assert.equal(await t.m.need(chain, 5_000_000_000_000_000n), `cash/${chain}/1000`);
    assert.deepEqual(t.quoted.map((q) => [q.chain, q.usdc]), [[chain, 15_511_800n]]);
    assert.deepEqual(t.paid, [{ recipient: ADDRESS, amount: 15_511_800n, fee: 50_000n }]);
    // a quote under the rung plus its gas: nothing withdrawn
    const short = mover({ quote: (usdc) => ({ address: ADDRESS, amountIn: usdc, minOut: 5_019_999_999_999_999n }) });
    assert.equal(await short.m.need(chain, 5_000_000_000_000_000n), null);
    assert.deepEqual(short.paid, []);
    // no floor read: no move
    const none = mover({ floor: null });
    assert.equal(await none.m.need(chain, 5_000_000_000_000_000n), null);
    assert.deepEqual(none.quoted, []);
  }
});

// --- the tap

type Calls = { inner: bigint[] };
function tap(o: { taps: bigint[]; moving: boolean; any?: boolean }, _calls: Calls): CashToPoolDeps {
  let t = 0, clock = 0;
  return {
    any: async () => o.any ?? true,
    tapMax: async () => o.taps[Math.min(t++, o.taps.length - 1)]!,
    need: async () => (o.moving ? "cash/solana/7" : null),
    wait: async (ms) => void (clock += ms),
    now: () => clock,
  };
}
const innerOf = (calls: Calls) => (a: PoolAsk, _c: KindContext | null): HostRefusal | Running<"pool.buy"> => {
  calls.inner.push(a.amount);
  return { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "filled", txs: [] } }) };
};
const run = async (r: HostRefusal | Running<"pool.buy">): Promise<unknown> => {
  if (!("running" in r)) return { ...r };
  await r.after;
  // copied plainly: a HostAnswer's optional `then` is never returned from an async function
  return { ...(r.answer() as object) };
};

test("cashFirst: a buy one tap pays goes straight to the pool buy", async () => {
  const calls = { inner: [] as bigint[] };
  const c = ctx();
  await run(cashFirst(innerOf(calls), () => tap({ taps: [500_000_000n], moving: true }, calls))(ask(400_000_000n), c));
  assert.deepEqual(calls.inner, [400_000_000n]);
  assert.deepEqual(c.routes, []);
});

test("cashFirst: a buy above one tap while Cash moves waits for it, tells the app, then buys the whole ask once", async () => {
  const calls = { inner: [] as bigint[] };
  const c = ctx();
  const a = await run(cashFirst(innerOf(calls), () => tap({ taps: [100_000_000n, 100_000_000n, 100_000_000n, 400_000_000n], moving: true }, calls))(ask(400_000_000n), c));
  assert.deepEqual(a, { result: { stage: "filled", txs: [] } });
  assert.deepEqual(calls.inner, [400_000_000n]);
  assert.deepEqual(c.routes, [{ move: "cash", op: "cash/solana/7" }], "the route event names the move's op");
});

test("cashFirst: with nothing on its way the pool buy answers at once; a move that never lands is waited CASH_MOVE_WAIT_MS at most", async () => {
  const calls = { inner: [] as bigint[] };
  const c = ctx();
  await run(cashFirst(innerOf(calls), () => tap({ taps: [100_000_000n], moving: false }, calls))(ask(400_000_000n), c));
  assert.deepEqual(c.routes, []);
  let reads = 0;
  const d = tap({ taps: [100_000_000n], moving: true }, calls);
  const tm = d.tapMax;
  d.tapMax = async (c, t) => (reads++, tm(c, t));
  await run(cashFirst(innerOf(calls), () => d)(ask(400_000_000n), ctx()));
  assert.ok(reads <= CASH_MOVE_WAIT_MS / CASH_MOVE_POLL_MS + 2, `${reads} reads`);
});

test("cashFirst: with no Cash to move and nothing on its way the pool buy goes straight to the flow, with no tap read and no move asked", async () => {
  const calls = { inner: [] as bigint[] };
  const c = ctx();
  const d = tap({ taps: [0n], moving: true, any: false }, calls);
  let reads = 0, needs = 0;
  d.tapMax = async () => (reads++, 0n);
  d.need = async () => (needs++, "cash/solana/0");
  await run(cashFirst(innerOf(calls), () => d)(ask(400_000_000n), c));
  assert.deepEqual([calls.inner, reads, needs, c.routes], [[400_000_000n], 0, 0, []]);
});

test("cashFirst on Base and Robinhood: a rung above every ready note asks the mover for that whole rung, waits for it, then buys it; an ask that is no rung goes straight to the pool buy", async () => {
  for (const chain of ["base", "robinhood"] as const) {
    const calls = { inner: [] as bigint[] };
    const c = ctx();
    const d = tap({ taps: [2_000_000_000_000_000n, 2_000_000_000_000_000n, 5_000_000_000_000_000n], moving: true }, calls);
    const asked: [string, bigint][] = [];
    d.need = async (ch, x) => (asked.push([ch, x]), `cash/${ch}/7`);
    await run(cashFirst(innerOf(calls), () => d)({ ...ask(5_000_000_000_000_000n), chain }, c));
    assert.deepEqual(asked, [[chain, 5_000_000_000_000_000n]], "the whole rung, never the gap to the ready note");
    assert.deepEqual(c.routes, [{ move: "cash", op: `cash/${chain}/7` }]);
    assert.deepEqual(calls.inner, [5_000_000_000_000_000n]);
    const odd = { inner: [] as bigint[] };
    const o = tap({ taps: [0n], moving: true }, odd);
    let needs = 0;
    o.need = async () => (needs++, "x");
    await run(cashFirst(innerOf(odd), () => o)({ ...ask(4_000_000_000_000_000n), chain }, ctx()));
    assert.deepEqual([odd.inner, needs], [[4_000_000_000_000_000n], 0]);
  }
});

test("cashFirst: a sell or a NEAR buy is the inner kind's alone", async () => {
  const calls = { inner: [] as bigint[] };
  await run(cashFirst(innerOf(calls), () => tap({ taps: [0n], moving: true }, calls))({ ...ask(1n), chain: "near" as never }, ctx()));
  await run(cashFirst(innerOf(calls), () => tap({ taps: [0n], moving: true }, calls))({ ...ask(1n), kind: "pool.sell" }, ctx()));
  assert.deepEqual(calls.inner, [1n, 1n]);
});

test("cashLamportsFor: Cash counted in SOL at the device's price, less 3% and the least rung, rounded down", () => {
  // SOL at 80.00000000 USD (Pyth's expo -8): 25.544 USD / 1.03 = 24.8 USD = 0.31 SOL, less the 0.01 rung = 0.3 SOL
  const p = { price: "8000000000", expo: -8 };
  assert.equal(cashLamportsFor(25_544_000n, p), 300_000_000n);
  assert.equal(cashLamportsFor(100n, p), 0n, "dust gives nothing past the rung");
  assert.equal(cashLamportsFor(25_544_000n, { price: "-1", expo: -8 }), 0n);
});

test("withCash: tap_max plus the moves on their way plus what the largest Cash note less its fee gives, in whole SOL", () => {
  const p = { price: "8000000000", expo: -8 };
  // 0.1 SOL a tap now, 0.05 on its way, 25.594 USDC of Cash less a 0.05 fee = 25.544 USDC = 0.3 SOL
  assert.equal(withCash("0.1", 50_000_000n, 25_594_000n, 50_000n, p), "0.45");
  assert.equal(withCash("0", 0n, 50_000n, 50_000n, p), "0", "Cash under its fee gives nothing");
  assert.equal(withCash("0.1", 0n, 25_594_000n, 50_000n, null), "0.1", "no price: Cash is not counted");
  assert.equal(withCash("x", 0n, 0n, 0n, p), null);
});
