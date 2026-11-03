// Portfolio (S10) and Activity (S14) as pure functions (card app-portfolio; A3.1, app.md:1459): exact cents from the
// kit's decimal strings, the totals, the sort, search and hide small, the closed list and its stats, the calendar, the
// loading, empty and offline states, and Activity's rows, filters and day headers; and the one WORDS table.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Operation, SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { activity, bps, calendar, cents, closedRows, filterActivity, filterRows, groupByDay, line, mulCents, NO_FILTER, pct, portfolio, restored, sortRows, stats, units, usd } from "../src/screens/portfolio/model.ts";
import type { PortfolioData, TokenMarket } from "../src/screens/portfolio/model.ts";
import { DRAFTS, WORDS } from "../src/screens/portfolio/words.ts";

const NOW = Date.parse("2026-11-02T03:00:00Z");
const H = 3_600_000;
const D = 24 * H;

const MARKET: Record<string, TokenMarket> = {
  "solana:WTH": { symbol: "WTH", name: "What the hoot", price: "0.0000612", route: true },
  "base:BOAR": { symbol: "boar", name: "Boar", price: "0.5", route: true },
  "near:NEAIR": { symbol: "NEAIR", name: "Neair", price: null, route: true },
  "solana:SWC": { symbol: "swordcat", name: "cat wif sword", price: "0.001", route: false },
};
const data = (over: Partial<PortfolioData> = {}): PortfolioData => ({
  market: (c, t) => MARKET[`${c}:${t}`] ?? null,
  extra: () => null,
  closed: [],
  series: [],
  fees: null,
  op: () => null,
  exported: [],
  ...over,
});
const STATE: SignpageState = {
  release: "signpage-v1",
  api: 1,
  signed_in: true,
  code_saved: true,
  vault_balance: "73.189",
  wallets: [
    { chain: "solana", address: "a1", role: "fresh", size: "10.005", state: "READY" },
    { chain: "base", address: "a2", role: "fresh", size: "5", state: "ARMING" },
    { chain: "near", address: "a3", role: "fresh", size: "2.5", state: "RETURNING" },
    { chain: "solana", address: "a4", role: "fresh", size: "25", state: "IN_POSITION" },
  ],
  positions: [
    { chain: "solana", token: "WTH", amount: "891500", cost: "25", wallets: ["a4"] },
    { chain: "base", token: "BOAR", amount: "20.25", cost: "12.10", wallets: ["b1", "b2"] },
    { chain: "near", token: "NEAIR", amount: "1000", cost: "40", wallets: ["n1"] },
    { chain: "solana", token: "SWC", amount: "500", cost: "0.90", wallets: ["s1"] },
  ],
  orders: [],
  held: [],
  ops: [],
};
const snap = (state: SignpageState | null, status: SignpageClientSnapshot["status"] = "ready"): SignpageClientSnapshot => ({ status, release: "signpage-v1", state, stale: status === "down" });

test("decimal strings to cents are exact and round down; garbage is null", () => {
  assert.equal(cents("73.189"), 7318n);
  assert.equal(cents("0.1"), 10n);
  assert.equal(cents("12"), 1200n);
  assert.equal(cents("-4.081"), -409n);
  assert.equal(cents("-4.08"), -408n);
  assert.equal(cents("1e3"), null);
  assert.equal(cents(""), null);
  // 0.1 + 0.2 in floats is 0.30000000000000004; in cents it is 30
  assert.equal(cents("0.1")! + cents("0.2")!, 30n);
  // a value no float holds
  assert.equal(mulCents("123456789012345678.123456", "1.000001"), 12345691246913469046n);
  assert.equal(mulCents("891500", "0.0000612"), 5455n);
  assert.equal(mulCents("x", "1"), null);
});

test("money and percent text", () => {
  assert.equal(usd(123456n), "$1,234.56");
  assert.equal(usd(-408n), "−$4.08");
  assert.equal(usd(2963n, true), "+$29.63");
  assert.equal(usd(0n, true), "+$0.00");
  assert.equal(pct(11900), "+119.0%");
  assert.equal(pct(-816), "−8.1%");
  assert.equal(pct(0), "0.0%");
  assert.equal(pct(null), "—");
  assert.equal(bps(2963n, 2500n), 11852);
  assert.equal(bps(1n, 0n), null);
  assert.equal(units("891500"), "891.5K");
  assert.equal(units("3770000000"), "3.77B");
  assert.equal(units("96.2"), "96.2");
  assert.equal(units("100"), "100");
  assert.equal(units("1000"), "1K");
  assert.equal(units("0"), "0");
});

test("S10.1 loading before the first state; S10.2 empty with none open; S10.5 offline keeps the last state", () => {
  assert.equal(portfolio(snap(null, "connecting"), data(), NOW).view, "S10.1");
  const down = portfolio(snap(null, "down"), data(), NOW);
  assert.equal(down.view, "S10.2");
  assert.equal(down.offline, true);
  const empty = portfolio(snap({ ...STATE, positions: [], wallets: [] }), data(), NOW);
  assert.equal(empty.view, "S10.2");
  assert.equal(empty.totals?.total, 7318n);
  const off = portfolio(snap(STATE, "down"), data(), NOW);
  assert.equal(off.view, "S10.3");
  assert.equal(off.offline, true);
  assert.equal(off.rows.length, 4);
});

test("S10.3 rows by value, the priceless one last; S10.4 a row with no price has no value or PnL; S10.6 no route", () => {
  const p = portfolio(snap(STATE), data(), NOW);
  assert.deepEqual(p.rows.map((r) => r.symbol), ["WTH", "boar", "swordcat", "NEAIR"]);
  const [wth, boar, swc, neair] = p.rows;
  assert.equal(wth!.value, 5455n);
  assert.equal(wth!.pnl, 2955n);
  assert.equal(wth!.pnlBps, 11820);
  assert.equal(boar!.value, 1012n);
  assert.equal(boar!.pnl, -198n);
  assert.equal(boar!.pnlBps, -1636);
  assert.equal(boar!.wallets, 2);
  assert.equal(neair!.value, null);
  assert.equal(neair!.pnl, null);
  assert.equal(neair!.pnlBps, null);
  assert.equal(swc!.mark, "noRoute");
  assert.equal(wth!.mark, null);
});

test("totals: cash is the vault plus ready wallets, on the way is arming and returning, a priceless row counts at cost", () => {
  const t = portfolio(snap(STATE), data(), NOW).totals!;
  assert.equal(t.cash, 7318n + 1000n);
  assert.equal(t.onWay, 750n);
  assert.equal(t.inPos, 5455n + 1012n + 50n + 4000n);
  assert.equal(t.total, t.cash + t.onWay + t.inPos);
  assert.equal(t.unreal, 2955n - 198n + (50n - 90n));
  assert.equal(t.partial, true);
  const priced = portfolio(snap({ ...STATE, positions: STATE.positions.filter((x) => x.token !== "NEAIR") }), data(), NOW).totals!;
  assert.equal(priced.partial, false);
});

test("S10.7 and S10.8 marks come from the position's extra; S10.12 a sell on its way shows in its row", () => {
  const ops: Operation[] = [
    { id: "s1", kind: "sell", stage: "sent", txs: [] },
    { id: "s2", kind: "sell", stage: "filled", txs: [] },
  ];
  const d = data({
    extra: (c, t) => (t === "NEAIR" ? { mark: "held" } : t === "BOAR" ? { mark: "reverted" } : null),
    op: (id) => (id === "s1" ? { at: NOW - 500, chain: "solana", token: "WTH" } : id === "s2" ? { at: NOW - 9000, chain: "base", token: "BOAR" } : null),
  });
  const rows = portfolio(snap({ ...STATE, ops }), d, NOW).rows;
  const by = Object.fromEntries(rows.map((r) => [r.token, r]));
  assert.equal(by.NEAIR!.mark, "held");
  assert.equal(by.BOAR!.mark, "reverted");
  assert.deepEqual(by.WTH!.selling, { stage: "landing", ms: 500 });
  assert.equal(by.BOAR!.selling, null);
});

test("S10.11 search by symbol or name in any case, and hide small hides under $1 but keeps a priceless row", () => {
  const rows = portfolio(snap(STATE), data(), NOW).rows;
  assert.deepEqual(filterRows(rows, "HOOT", false).map((r) => r.symbol), ["WTH"]);
  assert.deepEqual(filterRows(rows, "", true).map((r) => r.symbol), ["WTH", "boar", "NEAIR"]);
  assert.deepEqual(filterRows(rows, "r", true).map((r) => r.symbol), ["boar", "NEAIR"]);
  assert.equal(filterRows(rows, "zzz", false).length, 0);
});

test("ties sort by symbol, and sorting never mutates", () => {
  const rows = portfolio(snap(STATE), data(), NOW).rows;
  const a = { ...rows[0]!, symbol: "B", value: 100n };
  const b = { ...rows[0]!, symbol: "A", value: 100n };
  const input = [a, b];
  assert.deepEqual(sortRows(input).map((r) => r.symbol), ["A", "B"]);
  assert.deepEqual(input.map((r) => r.symbol), ["B", "A"]);
});

const CLOSED = [
  { chain: "solana" as const, token: "WTH", bought: "50", sold: "36.82", opened_at: NOW - 3 * D, closed_at: Date.parse("2026-11-01T10:00:00Z") },
  { chain: "base" as const, token: "BOAR", bought: "10", sold: "14.43", opened_at: NOW - 4 * D, closed_at: Date.parse("2026-11-01T12:00:00Z") },
  { chain: "base" as const, token: "BOAR", bought: "20", sold: "0", opened_at: NOW - 40 * D, closed_at: Date.parse("2026-10-02T12:00:00Z") },
];

test("S10.10 closed rows newest first with realized PnL; the header's stats and buckets; S10.14 no trades gives nulls", () => {
  const c = closedRows(data({ closed: CLOSED }));
  assert.deepEqual(c.map((r) => r.realized), [443n, -1318n, -2000n]);
  assert.deepEqual(c.map((r) => r.realizedBps), [4430, -2636, -10000]);
  const s = stats(c);
  assert.equal(s.trades, 3);
  assert.equal(s.winBps, 3333);
  assert.equal(s.avgWinBps, 4430);
  assert.equal(s.avgLossBps, Math.trunc((-2636 - 10000) / 2));
  assert.deepEqual(s.buckets, [1, 1, 0, 0, 1, 0, 0, 0]);
  const none = stats([]);
  assert.equal(none.winBps, null);
  assert.equal(none.avgRetBps, null);
  assert.deepEqual(none.buckets, [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("realized over 30 days counts only trades closed in the window", () => {
  const p = portfolio(snap(STATE), data({ closed: CLOSED }), NOW);
  assert.equal(p.totals!.realized30, 443n - 1318n);
});

test("the calendar: the month of now, Monday first, each day's realized sum, future days marked", () => {
  const cal = calendar(closedRows(data({ closed: CLOSED })), NOW);
  assert.equal(cal.month, 10);
  assert.equal(cal.days.length, 30);
  assert.equal(cal.lead, 6); // 1 Nov 2026 is a Sunday
  assert.equal(cal.days[0]!.pnl, 443n - 1318n);
  assert.equal(cal.days[1]!.today, true);
  assert.equal(cal.days[2]!.future, true);
  assert.equal(cal.sum, -875n);
  assert.deepEqual([cal.green, cal.red], [0, 1]);
});

test("the value line keeps the range's points, in cents", () => {
  const series = [[NOW - 10 * D, "100"], [NOW - 2 * D, "120.5"], [NOW - H, "130.01"]] as const;
  assert.deepEqual(line(series, "1D", NOW), [[NOW - H, 13001n]]);
  assert.equal(line(series, "1W", NOW).length, 2);
  assert.equal(line(series, "All", NOW).length, 3);
});

const OPS: Operation[] = [
  { id: "d1", kind: "deposit", stage: "done", txs: [{ chain: "near", hash: "h1" }] },
  { id: "b1", kind: "buy", stage: "filled", txs: [{ chain: "solana", hash: "h2" }] },
  { id: "h1", kind: "hop", stage: "arrived", txs: [] },
  { id: "s1", kind: "sell", stage: "filled", txs: [] },
  { id: "w1", kind: "withdraw", stage: "sent", txs: [] },
  { id: "r1", kind: "return", stage: "done", txs: [] },
];
const DETAIL: Record<string, { at: number; usd?: string; chain?: "solana" | "base"; token?: string; units?: string }> = {
  d1: { at: NOW - 20 * H, usd: "100" },
  b1: { at: NOW - 2 * H, usd: "25", chain: "solana", token: "WTH", units: "891500" },
  s1: { at: NOW - H, usd: "14.43", chain: "base", token: "BOAR" },
};

test("S14.1 empty; S14.2 rows: deposits, withdrawals, buys and sells newest first, hops and returns left out, no time last", () => {
  assert.deepEqual(activity([], data()), []);
  assert.deepEqual(activity(null, data()), []);
  const rows = activity(OPS, data({ op: (id) => DETAIL[id] ?? null }));
  assert.deepEqual(rows.map((r) => r.id), ["s1", "b1", "d1", "w1"]);
  assert.equal(rows[1]!.usd, 2500n);
  assert.equal(rows[3]!.at, null);
});

test("S14.4 an exported key is a row with its address", () => {
  const rows = activity(OPS, data({ op: (id) => DETAIL[id] ?? null, exported: [{ id: "x1", at: NOW - 3 * H, chain: "solana", token: "WTH", address: "5Ftu" }] }));
  const x = rows.find((r) => r.id === "x1")!;
  assert.equal(x.kind, "export");
  assert.equal(x.stage, "key_exported");
  assert.equal(x.address, "5Ftu");
});

test("S14.5 type chips, min size and the token search", () => {
  const d = data({ op: (id) => DETAIL[id] ?? null });
  const rows = activity(OPS, d);
  assert.equal(filterActivity(rows, NO_FILTER, d).length, 4);
  assert.deepEqual(filterActivity(rows, { ...NO_FILTER, kinds: ["buy", "sell"] }, d).map((r) => r.id), ["s1", "b1"]);
  assert.deepEqual(filterActivity(rows, { ...NO_FILTER, min: 2000n }, d).map((r) => r.id), ["b1", "d1"]);
  assert.deepEqual(filterActivity(rows, { ...NO_FILTER, q: "hoot" }, d).map((r) => r.id), ["b1"]);
});

test("day headers: Today, Yesterday, then the date, in the viewer's zone; rows with no time get no header", () => {
  const rows = activity(OPS, data({ op: (id) => DETAIL[id] ?? null }));
  const g = groupByDay(rows, NOW, 0);
  assert.deepEqual(g.map((x) => [x.label, x.rows.length]), [["today", 2], ["yesterday", 1], [null, 1]]);
  // at UTC+7 it is 10:00 on 2 Nov; 20 h back is 1 Nov 14:00 local: yesterday
  assert.deepEqual(groupByDay(rows, NOW, 420).map((x) => x.label), ["today", "yesterday", null]);
  // at UTC-5 it is 22:00 on 1 Nov; three days back is 29 Oct 22:00 local: a date
  assert.deepEqual(groupByDay([{ ...rows[0]!, at: NOW - 3 * D }], NOW, -300).map((x) => x.label), ["Oct 29"]);
});

test("S14.3 after a restore: the kit's restore op done", () => {
  assert.equal(restored(OPS), false);
  assert.equal(restored([...OPS, { id: "rs", kind: "restore", stage: "done", txs: [] }]), true);
  assert.equal(restored([{ id: "rs", kind: "restore", stage: "reading", txs: [] }]), false);
});

// the pools (card balances-per-chain, v2 A1): the signing page sends each chain's sum of its own notes (packages/wallet
// pool balances: spent, reserved, incoming and planned notes are left out there); the screen draws them as sent
test("pools: loading, offline, unread (none sent), empty, and rows with balance, ready and pending in cents", () => {
  assert.deepEqual(portfolio(snap(null), data(), NOW).pools, { view: "loading", rows: [] });
  assert.deepEqual(portfolio(snap(null, "down"), data(), NOW).pools, { view: "offline", rows: [] });
  // a page that sends no pools: dashes, never $0.00
  assert.deepEqual(portfolio(snap(STATE), data(), NOW).pools, { view: "unread", rows: [] });
  assert.deepEqual(portfolio(snap(STATE, "down"), data(), NOW).pools, { view: "offline", rows: [] });
  assert.deepEqual(portfolio(snap({ ...STATE, pools: [] }), data(), NOW).pools, { view: "empty", rows: [] });
  // a configured chain with none: still empty while no pool holds anything
  assert.equal(portfolio(snap({ ...STATE, pools: [{ chain: "solana", balance: "0", ready: "0" }] }), data(), NOW).pools.view, "empty");
  const p = portfolio(snap({ ...STATE, pools: [{ chain: "solana", balance: "250.129", ready: "200" }, { chain: "base", balance: "0" }, { chain: "robinhood", balance: "70", ready: "0" }] }), data(), NOW).pools;
  assert.equal(p.view, "rows");
  assert.deepEqual(p.rows, [
    { chain: "solana", balance: 25012n, ready: 20000n, pending: 5012n },
    // a chain with none keeps its row at $0.00; no ready sent: ready and pending are null (dashes)
    { chain: "base", balance: 0n, ready: null, pending: null },
    // a ready of 0 is a real 0: every chunk still being proved
    { chain: "robinhood", balance: 7000n, ready: 0n, pending: 7000n },
  ]);
});

test("pools: a ready above the balance is held to it; a garbled amount reads as 0", () => {
  const p = portfolio(snap({ ...STATE, pools: [{ chain: "solana", balance: "10", ready: "12" }, { chain: "base", balance: "x", ready: "1" }] }), data(), NOW).pools;
  assert.deepEqual(p.rows, [
    { chain: "solana", balance: 1000n, ready: 1000n, pending: 0n },
    { chain: "base", balance: 0n, ready: 0n, pending: 0n },
  ]);
});

test("cash: the vault, each pool and the ready wallets, each source counted once", () => {
  const base = { ...STATE, positions: [] };
  // vault 73.18 + ready wallet 10.00
  assert.equal(portfolio(snap(base), data(), NOW).totals!.cash, 8318n);
  // the pools add their balances once; ready is a part of the balance, never added again
  const t = portfolio(snap({ ...base, pools: [{ chain: "solana", balance: "100.5", ready: "100" }, { chain: "base", balance: "20" }] }), data(), NOW).totals!;
  assert.equal(t.cash, 8318n + 10050n + 2000n);
  assert.equal(t.total, t.cash + t.onWay + t.inPos);
  // the same amount in the vault and in a pool are two sources: both count, neither twice
  const same = portfolio(snap({ ...base, vault_balance: "50", wallets: [], pools: [{ chain: "solana", balance: "50", ready: "50" }] }), data(), NOW).totals!;
  assert.equal(same.cash, 10000n);
  assert.equal(same.total, 10000n);
});

test("words: every word has a source; the drafts left are the overflow button's accessible name and the pool rows' words", () => {
  for (const [k, w] of Object.entries(WORDS)) assert.ok(w.text && w.source, k);
  for (const k of ["total", "token", "holding", "value", "pnl", "realized", "tpsl", "search", "hideSmall", "minSize", "feesPaid", "receipt", "keyExported", "viewKey"] as const) assert.equal(WORDS[k].draft, false, k);
  // owner 2 Nov 06:08Z, all approved
  for (const k of ["cash", "noPositions", "noActivity", "open", "closed", "offline", "noRoute", "reverted", "held", "today", "yesterday", "notRestorable"] as const) assert.equal(WORDS[k].draft, false, k);
  assert.deepEqual([...DRAFTS], ["more", "privateBalance", "balance", "ready", "pending", "noBalance"]);
});
