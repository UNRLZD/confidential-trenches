// The token chart's trade marks (card app-chart-controls): the helper's GET /v1/market/trades answer read whole or not
// at all, trades grouped per trader x bar x side at the average fill clamped into the bar, and the layout that slides or
// folds marks that would cover each other. Pure functions only.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bar } from "../src/screens/token/candles.ts";
import { TRADES_URL, groupMarks, layoutMarks, shortTrader, toTrades } from "../src/screens/token/trades.ts";
import type { Mark, Trade } from "../src/screens/token/trades.ts";

const T0 = 1_762_000_200_000; // a 15m bucket start, ms
const SPAN = 900_000;
const bars: Bar[] = [
  { timestamp: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
  { timestamp: T0 + SPAN, open: 1.5, high: 3, low: 1.2, close: 2, volume: 10 },
];
const good = () => ({
  trades: [
    { t_ms: T0 + 1000, side: "buy", usd: "100.50", amt: "50", trader: "TraderAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", tx: "tx1" },
    { t_ms: T0 + 500, side: "sell", usd: "20", amt: "40", trader: null, tx: "tx2" },
  ],
  src: "chain",
  as_of_ms: T0 + 2000,
});
const trade = (o: Partial<Trade> = {}): Trade => ({ t_ms: T0 + 10, side: "buy", usd: "10", amt: "5", trader: "A", tx: "t", ...o });

test("the url asks the chain, the token and 50 rows", () => {
  assert.equal(TRADES_URL("solana", "Mint111"), "https://api.confidential.unrealized.trade/v1/market/trades?chain=solana&token=Mint111&limit=50");
  assert.match(TRADES_URL("base", "0xa&b"), /token=0xa%26b&limit=50$/);
});

test("a good answer: every row, as sent", () => {
  const t = toTrades(good());
  assert.ok(t);
  assert.equal(t.length, 2);
  assert.deepEqual(t[0], { t_ms: T0 + 1000, side: "buy", usd: "100.50", amt: "50", trader: "TraderAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", tx: "tx1" });
  assert.equal(t[1]!.trader, null);
  assert.deepEqual(toTrades({ ...good(), trades: [] }), []);
});

test("planted bad answers: each refused whole", () => {
  const row = (k: string, v: unknown) => {
    const b = good();
    (b.trades[1] as Record<string, unknown>)[k] = v;
    return b;
  };
  const gone = (k: string) => {
    const b = good();
    delete (b.trades[1] as Record<string, unknown>)[k];
    return b;
  };
  const bad: [string, unknown][] = [
    ["null", null],
    ["a string", "trades"],
    ["a list", []],
    ["trades not a list", { ...good(), trades: {} }],
    ["trades missing", { src: "chain", as_of_ms: 1 }],
    ["a row not an object", { ...good(), trades: [good().trades[0], 7] }],
    ["a row null", { ...good(), trades: [null] }],
    ["t_ms missing", gone("t_ms")],
    ["usd missing", gone("usd")],
    ["amt missing", gone("amt")],
    ["side missing", gone("side")],
    ["trader missing", gone("trader")],
    ["tx missing", gone("tx")],
    ["side sell-ish", row("side", "SELL")],
    ["side other", row("side", "swap")],
    ["usd a number", row("usd", 5)],
    ["usd zero", row("usd", "0")],
    ["usd negative", row("usd", "-1")],
    ["usd exponent", row("usd", "1e3")],
    ["usd empty", row("usd", "")],
    ["usd NaN", row("usd", "NaN")],
    ["usd Infinity", row("usd", "Infinity")],
    ["usd 0.0", row("usd", "0.0")],
    ["amt a number", row("amt", 5)],
    ["amt zero", row("amt", "0.000")],
    ["amt hex", row("amt", "0x10")],
    ["amt spaced", row("amt", " 5")],
    ["t_ms a string", row("t_ms", "1762000200000")],
    ["t_ms fractional", row("t_ms", 1.5)],
    ["t_ms unsafe", row("t_ms", 2 ** 53)],
    ["t_ms NaN", row("t_ms", NaN)],
    ["t_ms negative", row("t_ms", -1)],
    ["trader a number", row("trader", 5)],
    ["trader empty", row("trader", "")],
    ["trader very long", row("trader", "x".repeat(300))],
    ["tx a number", row("tx", 5)],
    ["tx empty", row("tx", "")],
    ["more rows than asked", { ...good(), trades: Array.from({ length: 51 }, () => good().trades[0]) }],
  ];
  for (const [name, body] of bad) assert.equal(toTrades(body), null, name);
  assert.equal(toTrades({ ...good(), trades: Array.from({ length: 50 }, () => good().trades[0]) })!.length, 50);
});

test("grouping: one mark per trader x bar x side, at the average fill (sum usd / sum amt)", () => {
  const wide: Bar[] = [{ timestamp: T0, open: 0.5, high: 1, low: 0.1, close: 0.5, volume: 1 }, bars[1]!];
  const m = groupMarks(
    [
      trade({ usd: "10", amt: "10", t_ms: T0 + 10 }), // fill 1.0
      trade({ usd: "9", amt: "90", t_ms: T0 + 20, tx: "u" }), // fill 0.1: together 19 / 100 = 0.19, not the mean 0.55
      trade({ usd: "5", amt: "10", t_ms: T0 + 30, tx: "v", side: "sell" }), // other side: own mark
      trade({ usd: "5", amt: "10", t_ms: T0 + 40, tx: "w", trader: "B" }), // other trader: own mark
      trade({ usd: "5", amt: "10", t_ms: T0 + SPAN + 5, tx: "x" }), // next bar: own mark
    ],
    wide,
    "15m",
  );
  assert.equal(m.length, 4);
  const a = m.find((x) => x.barTs === T0 && x.side === "buy" && x.trader === "A")!;
  assert.equal(a.usd, 19);
  assert.equal(a.amt, 100);
  assert.ok(Math.abs(a.price - 0.19) < 1e-12, String(a.price));
  assert.equal(a.t_ms, T0 + 20, "the newest trade's time");
  assert.equal(a.n, 2);
  assert.equal(m.filter((x) => x.barTs === T0 + SPAN).length, 1);
});

test("grouping: a trade with no trader is its own mark, never merged with another unknown", () => {
  const m = groupMarks([trade({ trader: null, tx: "p" }), trade({ trader: null, tx: "q" })], bars, "15m");
  assert.equal(m.length, 2);
  assert.equal(m[0]!.trader, null);
});

test("the price is clamped into the bar's low..high", () => {
  const above = groupMarks([trade({ usd: "100", amt: "10" })], bars, "15m"); // fill 10, bar 0.5..2
  assert.equal(above[0]!.price, 2);
  const below = groupMarks([trade({ usd: "1", amt: "1000" })], bars, "15m"); // fill 0.001
  assert.equal(below[0]!.price, 0.5);
  const inside = groupMarks([trade({ usd: "10", amt: "10" })], bars, "15m"); // fill 1
  assert.equal(inside[0]!.price, 1);
});

test("a trade before the first bar or past the last bar's span is dropped; one in the last bar's span is kept", () => {
  const m = groupMarks(
    [
      trade({ t_ms: T0 - 1, tx: "a" }),
      trade({ t_ms: T0 + 2 * SPAN, tx: "b" }), // the last bar covers T0+SPAN .. T0+2*SPAN-1
      trade({ t_ms: T0 + 2 * SPAN - 1, tx: "c" }),
      trade({ t_ms: T0, tx: "d" }),
    ],
    bars,
    "15m",
  );
  assert.deepEqual(m.map((x) => x.barTs).sort(), [T0, T0 + SPAN]);
  assert.deepEqual(groupMarks([trade()], [], "15m"), []);
});

test("a trade falls in the span of the tf, so a 1m chart does not take a bar's whole 15m", () => {
  const one: Bar[] = [{ timestamp: T0, open: 1, high: 2, low: 1, close: 1, volume: 1 }];
  assert.equal(groupMarks([trade({ t_ms: T0 + 59_999 })], one, "1m").length, 1);
  assert.equal(groupMarks([trade({ t_ms: T0 + 60_000 })], one, "1m").length, 0);
});

const item = (id: string, x: number, y: number, usd: number) => ({ id, x, y, usd });
const AREA = { width: 400, height: 300, r: 8 };

test("layout: biggest first, an overlapping mark slides one step up, else down", () => {
  const p = layoutMarks([item("small", 100, 150, 1), item("big", 100, 150, 9)], AREA);
  assert.equal(p.length, 2);
  const big = p.find((q) => q.id === "big")!;
  const small = p.find((q) => q.id === "small")!;
  assert.deepEqual([big.x, big.y, big.k], [100, 150, 0], "the biggest keeps its place");
  assert.deepEqual([small.x, small.y, small.k], [100, 150 - 18, 0], "one step (2r + 2) up");
  // up is blocked by a third: it goes down
  const p3 = layoutMarks([item("a", 100, 150, 9), item("b", 100, 132, 8), item("c", 100, 150, 1)], AREA);
  const c = p3.find((q) => q.id === "c")!;
  assert.equal(c.y, 168);
});

test("layout: a mark that cannot slide folds into the nearest placed one, which shows +k", () => {
  const p = layoutMarks([item("a", 100, 150, 9), item("b", 100, 132, 8), item("c", 100, 168, 7), item("d", 100, 151, 1), item("e", 100, 149, 0.5)], AREA);
  assert.equal(p.length, 3, "d and e are folded");
  const a = p.find((q) => q.id === "a")!;
  assert.equal(a.k, 2, "both fold into a: it is the nearest to each");
  assert.equal(p.find((q) => q.id === "b")!.k, 0);
  assert.equal(p.find((q) => q.id === "c")!.k, 0);
  // the nearest, not the first: e sits closer to b, with a also in reach
  const q = layoutMarks([item("a", 100, 150, 9), item("b", 100, 132, 8), item("c", 100, 168, 7), item("e", 100, 140, 1)], AREA);
  assert.equal(q.find((m) => m.id === "b")!.k, 1);
  assert.equal(q.find((m) => m.id === "a")!.k, 0);
});

test("layout: marks outside the pane are not drawn; one at the edge is held inside it", () => {
  const p = layoutMarks([item("l", -1, 50, 1), item("r", 401, 50, 1), item("t", 50, -1, 1), item("b", 50, 301, 1), item("nan", NaN, 5, 1), item("e", 50, 2, 1)], AREA);
  assert.deepEqual(p.map((q) => q.id), ["e"]);
  assert.equal(p[0]!.y, 8, "held inside by its radius");
});

test("layout: the sorted order of the answer does not change the result", () => {
  const a = [item("a", 100, 150, 9), item("b", 100, 150, 5), item("c", 300, 40, 1)];
  const x = layoutMarks(a, AREA).map((q) => [q.id, q.x, q.y, q.k]).sort();
  const y = layoutMarks([...a].reverse(), AREA).map((q) => [q.id, q.x, q.y, q.k]).sort();
  assert.deepEqual(x, y);
});

test("the trader is shortened to first 4 + an ellipsis + last 4; a short one is kept whole", () => {
  assert.equal(shortTrader("TraderAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), "Trad…AAAA");
  assert.equal(shortTrader("0x1234567890abcdef"), "0x12…cdef");
  assert.equal(shortTrader("abcdefgh"), "abcdefgh");
});

test("a Mark's key is stable across reads", () => {
  const a: Mark[] = groupMarks([trade()], bars, "15m");
  const b: Mark[] = groupMarks([trade()], bars, "15m");
  assert.equal(a[0]!.id, b[0]!.id);
});

test("a failed tape read waits longer each time, at most TRADES_BACKOFF_MAX_MS; a good one reads again at TRADES_POLL_MS", async () => {
  const { nextWait, TRADES_POLL_MS, TRADES_BACKOFF_MAX_MS } = await import("../src/screens/token/trades.ts");
  assert.equal(nextWait(0), TRADES_POLL_MS);
  assert.equal(nextWait(1), 2 * TRADES_POLL_MS);
  assert.equal(nextWait(2), 4 * TRADES_POLL_MS);
  assert.equal(nextWait(10), TRADES_BACKOFF_MAX_MS);
});
