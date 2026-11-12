// Card market-token-reads: the kit's read of the tokens a device holds (symbol, name, USD price, one request a chain
// over the helper's GET /v1/market/held), their price history (GET /v1/market/candles) and the value line the device
// computes from its own records. The helper learns the token list only: never an amount, a wallet or a note.
//   node --test test/market-held.test.ts      (from packages/kit)
import assert from "node:assert/strict";
import { test } from "node:test";
import { HELD_HISTORY_BARS, HELD_HISTORY_TF, HELD_MARKET_MAX, heldValueSeries, readHeldHistory, readHeldMarket } from "../src/index.ts";
import type { Operation } from "../src/index.ts";

const BASE = "https://helper.test";
const SOL_A = "So11111111111111111111111111111111111111112";
const SOL_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BASE_T = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

type Call = { url: URL };
function fakeFetch(answer: (u: URL) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const f = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push({ url });
    const a = answer(url);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}
const heldAnswer = (u: URL) => ({ status: 200, body: { tokens: u.searchParams.getAll("token").map((t) => ({ token: t, symbol: `S${t.slice(0, 3)}`, name: `N${t.slice(0, 3)}`, price_usd: "1.5", src: "x" })), as_of_ms: 1 } });

test("one request a chain: tokens distinct and sorted, only chain and token in it, no request for NEAR", async () => {
  const { f, calls } = fakeFetch(heldAnswer);
  const got = await readHeldMarket(BASE, [
    { chain: "solana", token: SOL_B },
    { chain: "base", token: BASE_T },
    { chain: "solana", token: SOL_A },
    { chain: "solana", token: SOL_B },
    { chain: "near", token: "usdc.near" },
  ], f);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.url.origin + c.url.pathname, `${BASE}/v1/market/held`);
    assert.deepEqual([...new Set(c.url.searchParams.keys())].sort(), ["chain", "token"]);
  }
  const sol = calls.find((c) => c.url.searchParams.get("chain") === "solana")!;
  assert.deepEqual(sol.url.searchParams.getAll("token"), [SOL_B, SOL_A].sort());
  assert.equal(calls.some((c) => c.url.searchParams.get("chain") === "near"), false);
  const a = got.find((m) => m.chain === "solana" && m.token === SOL_A)!;
  assert.deepEqual(a, { chain: "solana", token: SOL_A, symbol: "SSo1", name: "NSo1", price_usd: "1.5" });
  const n = got.find((m) => m.chain === "near")!;
  assert.deepEqual(n, { chain: "near", token: "usdc.near", symbol: null, name: null, price_usd: null });
  assert.equal(got.length, 4);
});

test("more than HELD_MARKET_MAX tokens on a chain are split into requests of at most that many", async () => {
  const { f, calls } = fakeFetch(heldAnswer);
  const many = Array.from({ length: HELD_MARKET_MAX + 3 }, (_, i) => ({ chain: "base" as const, token: `0x${i.toString(16).padStart(40, "0")}` }));
  const got = await readHeldMarket(BASE, many, f);
  assert.deepEqual(calls.map((c) => c.url.searchParams.getAll("token").length), [HELD_MARKET_MAX, 3]);
  assert.equal(got.filter((m) => m.price_usd === "1.5").length, HELD_MARKET_MAX + 3);
});

test("a hostile answer names nothing: wrong token or order, bad price, oversize text, non-200, garbage", async () => {
  const cases: [string, (u: URL) => { status: number; body: unknown }, (m: { symbol: string | null; name: string | null; price_usd: string | null }[]) => void][] = [
    ["another token in the entry", (u) => ({ status: 200, body: { tokens: u.searchParams.getAll("token").map(() => ({ token: SOL_A, symbol: "X", name: "X", price_usd: "1" })), as_of_ms: 1 } }), (m) => assert.ok(m.every((x) => x.symbol === null && x.price_usd === null))],
    ["fewer entries than asked", () => ({ status: 200, body: { tokens: [], as_of_ms: 1 } }), (m) => assert.ok(m.every((x) => x.symbol === null))],
    ["a price in exponent form", (u) => ({ status: 200, body: { tokens: u.searchParams.getAll("token").map((t) => ({ token: t, symbol: "X", name: "Y", price_usd: "1e5" })), as_of_ms: 1 } }), (m) => assert.ok(m.every((x) => x.symbol === "X" && x.price_usd === null))],
    ["a 300-char name and symbol", (u) => ({ status: 200, body: { tokens: u.searchParams.getAll("token").map((t) => ({ token: t, symbol: "S".repeat(300), name: "N".repeat(300), price_usd: "2" })), as_of_ms: 1 } }), (m) => assert.ok(m.every((x) => x.symbol === null && x.name === null && x.price_usd === "2"))],
    ["a 503", () => ({ status: 503, body: { error: { code: "upstream" } } }), (m) => assert.ok(m.every((x) => x.symbol === null))],
    ["not an object", () => ({ status: 200, body: [1, 2] }), (m) => assert.ok(m.every((x) => x.symbol === null))],
  ];
  for (const [why, answer, check] of cases) {
    const { f } = fakeFetch(answer);
    const got = await readHeldMarket(BASE, [{ chain: "solana", token: SOL_B }, { chain: "solana", token: SOL_A }], f);
    assert.equal(got.length, 2, why);
    check(got);
  }
  // a fetch that throws is the same as no answer
  const got = await readHeldMarket(BASE, [{ chain: "solana", token: SOL_A }], (async () => { throw new Error("down"); }) as typeof fetch);
  assert.deepEqual(got, [{ chain: "solana", token: SOL_A, symbol: null, name: null, price_usd: null }]);
});

test("history: one candles read of a fixed shape; closes as [ms, usd]; a malformed answer is no history", async () => {
  const bars = [[3600, "1", "1", "1", "0.4", "0"], [7200, "1", "1", "1", "0.5", "0"]];
  const { f, calls } = fakeFetch(() => ({ status: 200, body: { tf: HELD_HISTORY_TF, candles: bars, src: "x", as_of_ms: 1 } }));
  assert.deepEqual(await readHeldHistory(BASE, { chain: "base", token: BASE_T }, f), [[3_600_000, "0.4"], [7_200_000, "0.5"]]);
  const u = calls[0]!.url;
  assert.equal(u.pathname, "/v1/market/candles");
  assert.deepEqual(Object.fromEntries(u.searchParams), { chain: "base", token: BASE_T, tf: HELD_HISTORY_TF, limit: String(HELD_HISTORY_BARS) });
  const bad: unknown[] = [
    { tf: "1d", candles: bars },
    { tf: HELD_HISTORY_TF, candles: [[7200, "1", "1", "1", "0.5", "0"], [3600, "1", "1", "1", "0.4", "0"]] },
    { tf: HELD_HISTORY_TF, candles: [[3600, "1", "1", "1", "-1", "0"]] },
    { tf: HELD_HISTORY_TF, candles: [[3600.5, "1", "1", "1", "1", "0"]] },
    { tf: HELD_HISTORY_TF, candles: Array.from({ length: HELD_HISTORY_BARS + 1 }, (_, i) => [i + 1, "1", "1", "1", "1", "0"]) },
  ];
  for (const body of bad) assert.deepEqual(await readHeldHistory(BASE, { chain: "base", token: BASE_T }, fakeFetch(() => ({ status: 200, body })).f), []);
  assert.deepEqual(await readHeldHistory(BASE, { chain: "near", token: "x.near" }, f), []);
  assert.equal(calls.length, 1);
});

const H = 3_600_000;
const buy = (token: string, at: number, stage: "filled" | "refused" = "filled"): Operation => ({ id: `b${at}`, kind: "buy", stage, txs: [], created_ms: at, chain: "solana", token, amount_usd: "50" });

test("the value line: cash plus each position at its close, at its cost before its first filled buy, ending at now's price", () => {
  const series = heldValueSeries({
    positions: [
      { chain: "solana", token: SOL_A, amount: "100", cost: "50" },
      // no price at all: at its cost throughout, as Portfolio's totals count it
      { chain: "solana", token: SOL_B, amount: "7", cost: "20" },
    ],
    markets: [
      { chain: "solana", token: SOL_A, symbol: "A", name: "A", price_usd: "0.7" },
      { chain: "solana", token: SOL_B, symbol: "B", name: "B", price_usd: null },
    ],
    history: new Map([[`solana:${SOL_A}`, [[1 * H, "0.4"], [2 * H, "0.5"], [3 * H, "0.6"]] as [number, string][]]]),
    ops: [buy(SOL_A, 2 * H), buy(SOL_A, 1 * H, "refused")],
    base_usd: "10",
    now: 4 * H,
  });
  assert.deepEqual(series, [
    [1 * H, "80.00"], // before the filled buy: cash 10 + A's cost 50 + B's cost 20
    [2 * H, "80.00"], // 10 + 100 x 0.5 + 20
    [3 * H, "90.00"], // 10 + 100 x 0.6 + 20
    [4 * H, "100.00"], // now: 10 + 100 x 0.7 + 20
  ]);
});

test("the value line: a priced token with no history is flat at its price; no positions is cash alone; each position to the nearest cent, the cash's as given", () => {
  const s = heldValueSeries({
    positions: [{ chain: "base", token: BASE_T, amount: "3", cost: "1" }],
    markets: [{ chain: "base", token: BASE_T, symbol: "T", name: "T", price_usd: "0.3333" }],
    history: new Map(),
    ops: [],
    base_usd: "0.005",
    now: 5 * H,
  });
  // 3 x $0.3333 = $0.9999, drawn $1.00 as Portfolio's row (card portfolio-counts-money-an-open-buy-holds); $0.005 cash
  // is the 0 cents it is given as
  assert.deepEqual(s, [[5 * H, "1.00"]]);
  const quarter = (price: string) => heldValueSeries({ positions: [{ chain: "base", token: BASE_T, amount: "1", cost: "1" }], markets: [{ chain: "base", token: BASE_T, symbol: "T", name: "T", price_usd: price }], history: new Map(), ops: [], base_usd: "0", now: H });
  assert.deepEqual([quarter("0.004"), quarter("0.005")], [[[H, "0.00"]], [[H, "0.01"]]], "under half a cent down, half up");
  assert.deepEqual(heldValueSeries({ positions: [], markets: [], history: new Map(), ops: [], base_usd: "12.5", now: H }), [[H, "12.50"]]);
  // bars after now are not drawn
  const later = heldValueSeries({ positions: [{ chain: "base", token: BASE_T, amount: "1", cost: "1" }], markets: [{ chain: "base", token: BASE_T, symbol: "T", name: "T", price_usd: "2" }], history: new Map([[`base:${BASE_T}`, [[H, "1"], [9 * H, "5"]] as [number, string][]]]), ops: [], base_usd: "0", now: 2 * H });
  assert.deepEqual(later, [[H, "1.00"], [2 * H, "2.00"]]);
});
