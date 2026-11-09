// Portfolio (S10) and Activity (S14) as pure functions (card app-portfolio; A3.1, app.md:1459): exact cents from the
// kit's decimal strings, the totals, the sort, search and hide small, the closed list and its stats, the calendar, the
// loading, empty and offline states, and Activity's rows, filters and day headers; and the one WORDS table.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Operation, SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { activity, amount, balanceOf, bps, calendar, cents, closedRows, filterActivity, filterRows, groupByDay, line, mulCents, NO_DATA, NO_FILTER, pct, portfolio, restored, shortAddress, sortRows, stats, units, usd, walletRows } from "../src/screens/portfolio/model.ts";
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

test("units: a sliver of a token never reads 0; the price's small form, cut and never rounded up", () => {
  assert.equal(units("0"), "0");
  assert.equal(units("0.004"), "0.004");
  assert.equal(units("0.0000123"), "0.0₄123");
  assert.equal(units("0.0099"), "0.0099");
  assert.equal(units("0.00999999"), "0.00999");
  assert.equal(units("0.01"), "0.01");
  assert.equal(units("1.239"), "1.23");
  assert.equal(units("12345"), "12.3K");
  assert.equal(units("1e-7"), "0.0₆1");
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
    { id: "s1", kind: "sell", stage: "sent", txs: [], created_ms: NOW - 500, chain: "solana", token: "WTH", units: "100" },
    { id: "s2", kind: "sell", stage: "filled", txs: [], created_ms: NOW - 9000, chain: "base", token: "BOAR", units: "1" },
  ];
  const d = data({ extra: (c, t) => (t === "NEAIR" ? { mark: "held" } : t === "BOAR" ? { mark: "reverted" } : null) });
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

// the ops as the signing page sends them (card kit-portfolio-reads, kit OpDetail): each its time; a deposit its USD at
// done; a buy its chain, token and USD spend; a sell its chain, token and units; a withdrawal from before them none
const OPS: Operation[] = [
  { id: "d1", kind: "deposit", stage: "done", txs: [{ chain: "near", hash: "h1" }], created_ms: NOW - 20 * H, amount_usd: "100" },
  { id: "b1", kind: "buy", stage: "filled", txs: [{ chain: "solana", hash: "h2" }], created_ms: NOW - 2 * H, chain: "solana", token: "WTH", amount_usd: "25" },
  { id: "h1", kind: "hop", stage: "arrived", txs: [], created_ms: NOW - 3 * H },
  { id: "s1", kind: "sell", stage: "filled", txs: [], created_ms: NOW - H, chain: "base", token: "BOAR", units: "28.86" },
  { id: "w1", kind: "withdraw", stage: "sent", txs: [] },
  { id: "r1", kind: "return", stage: "done", txs: [] },
];

test("S14.1 empty; S14.2 rows: deposits, withdrawals, buys and sells newest first, hops and returns left out, no time last", () => {
  assert.deepEqual(activity([], data()), []);
  assert.deepEqual(activity(null, data()), []);
  const rows = activity(OPS, data());
  assert.deepEqual(rows.map((r) => r.id), ["s1", "b1", "d1", "w1"]);
  assert.equal(rows[1]!.usd, 2500n);
  assert.equal(rows[3]!.at, null);
});

test("a trade that never moved in full (refused, not_landed, part_filled) draws no amount: its USD and units are only the ask (review P2-1)", () => {
  for (const stage of ["refused", "not_landed", "part_filled"] as const) {
    const ops: Operation[] = [
      { id: "b", kind: "buy", stage, txs: [], created_ms: NOW - H, chain: "solana", token: "WTH", amount_usd: "25" },
      { id: "s", kind: "sell", stage, txs: [], created_ms: NOW - 2 * H, chain: "solana", token: "WTH", units: "28.86" },
    ];
    const [b, s] = activity(ops, data());
    assert.deepEqual([b!.usd, b!.units, s!.usd, s!.units], [null, null, null, null], stage);
    assert.deepEqual([b!.at, b!.token, s!.chain], [NOW - H, "WTH", "solana"], `${stage}: the row keeps its time, chain and token`);
  }
  for (const stage of ["filled", "sent", "signed"] as const) {
    const [b] = activity([{ id: "b", kind: "buy", stage, txs: [], created_ms: NOW, amount_usd: "25" }], data());
    assert.equal(b!.usd, 2500n, stage);
  }
});

test("S14.4 an exported key is a row with its address", () => {
  const rows = activity(OPS, data({ exported: [{ id: "x1", at: NOW - 3 * H, chain: "solana", token: "WTH", address: "5Ftu" }] }));
  const x = rows.find((r) => r.id === "x1")!;
  assert.equal(x.kind, "export");
  assert.equal(x.stage, "key_exported");
  assert.equal(x.address, "5Ftu");
});

test("S14.5 type chips, min size and the token search", () => {
  const d = data();
  const rows = activity(OPS, d);
  assert.equal(filterActivity(rows, NO_FILTER, d).length, 4);
  assert.deepEqual(filterActivity(rows, { ...NO_FILTER, kinds: ["buy", "sell"] }, d).map((r) => r.id), ["s1", "b1"]);
  assert.deepEqual(filterActivity(rows, { ...NO_FILTER, min: 2000n }, d).map((r) => r.id), ["b1", "d1"]);
  assert.deepEqual(filterActivity(rows, { ...NO_FILTER, q: "hoot" }, d).map((r) => r.id), ["b1"]);
});

test("day headers: Today, Yesterday, then the date, in the viewer's zone; rows with no time get no header", () => {
  const rows = activity(OPS, data());
  const g = groupByDay(rows, NOW, 0);
  assert.deepEqual(g.map((x) => [x.label, x.rows.length]), [["today", 2], ["yesterday", 1], [null, 1]]);
  // at UTC+7 it is 10:00 on 2 Nov; 20 h back is 1 Nov 14:00 local: yesterday
  assert.deepEqual(groupByDay(rows, NOW, 420).map((x) => x.label), ["today", "yesterday", null]);
  // at UTC-5 it is 22:00 on 1 Nov; three days back is 29 Oct 22:00 local: a date
  assert.deepEqual(groupByDay([{ ...rows[0]!, at: NOW - 3 * D }], NOW, -300).map((x) => x.label), ["Oct 29"]);
});

// card kit-portfolio-reads: Activity draws every field the kit's op carries, with no local data at all (the live source
// passes NO_DATA): its time, USD size, units, chain and token, a deposit's USD from its done fact. Red before this card:
// each read the local op() alone, so the live screen drew a dash for every one while the kit held it.
test("kit-portfolio-reads: Activity draws each op's time, USD size, units, chain and token from the kit alone", () => {
  const rows = activity(OPS, NO_DATA);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual([by.d1!.at, by.d1!.usd, by.d1!.chain, by.d1!.token, by.d1!.units], [NOW - 20 * H, 10000n, null, null, null]);
  assert.deepEqual([by.b1!.at, by.b1!.usd, by.b1!.chain, by.b1!.token, by.b1!.units], [NOW - 2 * H, 2500n, "solana", "WTH", null]);
  assert.deepEqual([by.s1!.at, by.s1!.usd, by.s1!.chain, by.s1!.token, by.s1!.units], [NOW - H, null, "base", "BOAR", "28.86"]);
  assert.deepEqual([by.w1!.at, by.w1!.usd, by.w1!.chain, by.w1!.token, by.w1!.units], [null, null, null, null, null], "an op from before them: dashes");
  // a sell on its way names its row from the kit's op alone
  const ops: Operation[] = [{ id: "s9", kind: "sell", stage: "signed", txs: [], created_ms: NOW - 1500, chain: "solana", token: "WTH", units: "5" }];
  const row = portfolio(snap({ ...STATE, ops }), NO_DATA, NOW).rows.find((r) => r.token === "WTH")!;
  assert.deepEqual(row.selling, { stage: "sending", ms: 1500 });
});

test("S14.3 after a restore: the kit's restore op done", () => {
  assert.equal(restored(OPS), false);
  assert.equal(restored([...OPS, { id: "rs", kind: "restore", stage: "done", txs: [] }]), true);
  assert.equal(restored([{ id: "rs", kind: "restore", stage: "reading", txs: [] }]), false);
});

// the pools (card balances-per-chain, v2 A1): the signing page sends each chain's sum of its own notes, in the pool's
// own asset (packages/wallet pool balances: spent, reserved, incoming and planned notes are left out there); decimals
// come from the kit's table only, and a pool's amount is never a dollar figure
test("pools: loading, offline, unread (none sent), empty, and rows in the pool's own asset", () => {
  assert.deepEqual(portfolio(snap(null), data(), NOW).pools, { view: "loading", rows: [] });
  assert.deepEqual(portfolio(snap(null, "down"), data(), NOW).pools, { view: "offline", rows: [] });
  // a page that sends no pools: dashes, never 0
  assert.deepEqual(portfolio(snap(STATE), data(), NOW).pools, { view: "unread", rows: [] });
  assert.deepEqual(portfolio(snap(STATE, "down"), data(), NOW).pools, { view: "offline", rows: [] });
  assert.deepEqual(portfolio(snap({ ...STATE, pools: [] }), data(), NOW).pools, { view: "empty", rows: [] });
  // a configured chain with none: still empty while no pool holds anything
  assert.equal(portfolio(snap({ ...STATE, pools: [{ chain: "solana", asset: "SOL", balance: "0", ready: "0" }] }), data(), NOW).pools.view, "empty");
  const p = portfolio(snap({ ...STATE, pools: [{ chain: "solana", asset: "SOL", balance: "12.5", ready: "10" }, { chain: "base", asset: "ETH", balance: "0.25" }, { chain: "robinhood", asset: "ETH", balance: "0", ready: "0" }] }), data(), NOW).pools;
  assert.equal(p.view, "rows");
  assert.deepEqual(p.rows, [
    // 12.5 SOL in lamports (9 decimals, the kit's table), 10 of it ready
    { chain: "solana", asset: "SOL", decimals: 9, balance: 12_500_000_000n, ready: 10_000_000_000n, pending: 2_500_000_000n },
    // 0.25 ETH in wei (18 decimals); no ready sent: ready and pending are null (dashes)
    { chain: "base", asset: "ETH", decimals: 18, balance: 250_000_000_000_000_000n, ready: null, pending: null },
    // a ready of 0 is a real 0
    { chain: "robinhood", asset: "ETH", decimals: 18, balance: 0n, ready: 0n, pending: 0n },
  ]);
});

test("pools: amounts in the asset's own units, short and rounded down, never a dollar figure", () => {
  assert.equal(amount(12_500_000_000n, 9), "12.5");
  assert.equal(amount(250_000_000_000_000_000n, 18), "0.25");
  // the 0.001 ETH rung, a small amount, and dust under the smallest digit drawn: "<0.000001", never "0"
  assert.equal(amount(1_000_000_000_000_000n, 18), "0.001");
  assert.equal(amount(123_456_789_000_000n, 18), "0.000123");
  assert.equal(amount(123_456_789_000n, 18), "<0.000001");
  assert.equal(amount(1n, 9), "<0.000001");
  assert.equal(amount(999n, 9), "<0.000001");
  assert.equal(amount(1_000n, 9), "0.000001");
  assert.equal(amount(999_999_999_999n, 9), "999.9999");
  assert.equal(amount(12_500_500_000_000n, 9), "12.5K");
  assert.equal(amount(1_250_000_500_000_000n, 9), "1.25M");
  assert.equal(amount(3_200_000_000_000_000_000n, 9), "3.2B");
  assert.equal(amount(0n, 9), "0");
  assert.equal(amount(12_500_000n, 6), "12.5");
  // at most 9 characters up to 999.99B of the asset, past any asset's whole supply (SOL, ETH and USDC all under 100B);
  // the column widens past that, never clips
  for (const v of [1n, 999_999_999n, 999_999_999_999n, 999_999_999_999_999n, 999_999_999_999n * 10n ** 9n]) assert.ok(amount(v, 9).length <= 9, amount(v, 9));
  assert.ok(!amount(12_500_000_000n, 9).includes("$"));
});

test("pools: a ready above the balance is held to it; a garbled amount reads as 0", () => {
  const p = portfolio(snap({ ...STATE, pools: [{ chain: "solana", asset: "SOL", balance: "10", ready: "12" }, { chain: "base", asset: "ETH", balance: "x", ready: "1" }] }), data(), NOW).pools;
  assert.deepEqual(p.rows, [
    { chain: "solana", asset: "SOL", decimals: 9, balance: 10_000_000_000n, ready: 10_000_000_000n, pending: 0n },
    { chain: "base", asset: "ETH", decimals: 18, balance: 0n, ready: 0n, pending: 0n },
  ]);
});

test("cash: the vault and the ready wallets in dollars; a SOL or ETH pool never joins it; a USDC pool once", () => {
  const base = { ...STATE, positions: [] };
  // vault 73.18 + ready wallet 10.00
  assert.equal(portfolio(snap(base), data(), NOW).totals!.cash, 8318n);
  // 12.5 SOL and 0.25 ETH have no dollar value until a price read exists: Cash and Total stay as they were
  const t = portfolio(snap({ ...base, pools: [{ chain: "solana", asset: "SOL", balance: "12.5", ready: "12.5" }, { chain: "base", asset: "ETH", balance: "0.25" }] }), data(), NOW).totals!;
  assert.equal(t.cash, 8318n);
  assert.equal(t.total, t.cash + t.onWay + t.inPos);
  // a USDC pool is dollars: it joins Cash once, and the same amount in the vault is a second source, never merged
  const same = portfolio(snap({ ...base, vault_balance: "50", wallets: [], pools: [{ chain: "near", asset: "USDC", balance: "50", ready: "50" }] }), data(), NOW).totals!;
  assert.equal(same.cash, 10000n);
  assert.equal(same.total, 10000n);
});

// one balance (card portfolio-one-balance): Cash is the vault plus every pool at the signing page's own price, one total
// with each chain's part; a deposit in flight is counted on the side the kit's totals hold it, once.
const PX = (usd: number, ageS = 5) => ({ price: String(usd * 1e8), expo: -8, published_s: Math.floor(NOW / 1000) - ageS, read_ms: NOW - 1000 });
const FOUR: SignpageState = {
  ...STATE,
  positions: [],
  pools: [
    { chain: "solana", asset: "SOL", balance: "12.5", ready: "10", tap_max: "1", price: PX(150) },
    { chain: "base", asset: "ETH", balance: "0.25", price: PX(3000) },
    { chain: "robinhood", asset: "ETH", balance: "0.1", price: PX(3000) },
  ],
};

test("one balance: Cash is the vault plus each pool at the page's price and the ready wallets, with each chain's part", () => {
  const t = portfolio(snap(FOUR), data(), NOW).totals!;
  // vault 73.18; 12.5 SOL at $150 = $1,875.00 and the READY Solana wallet's $10.00; 0.25 ETH at $3,000; 0.1 ETH at $3,000
  assert.equal(t.cash, 7318n + 187500n + 1000n + 75000n + 30000n);
  assert.deepEqual(t.parts, [
    { chain: "near", cents: 7318n, moving: false },
    { chain: "solana", cents: 188500n, moving: false },
    { chain: "base", cents: 75000n, moving: false },
    { chain: "robinhood", cents: 30000n, moving: false },
  ]);
  assert.equal(t.total, t.cash + t.onWay + t.inPos);
  // what a chain with no pool spends (the vault path): the cash before this card, the pools left out
  assert.equal(t.offPool, 7318n + 1000n);
  // the header, the deposit and withdraw screens draw the same one number
  assert.equal(balanceOf(snap(FOUR), data(), NOW), t.cash);
});

test("one balance: the vault alone, then the vault and one pool", () => {
  const vault = portfolio(snap({ ...STATE, positions: [], wallets: [] }), data(), NOW).totals!;
  assert.equal(vault.cash, 7318n);
  assert.deepEqual(vault.parts, [{ chain: "near", cents: 7318n, moving: false }]);
  const one = portfolio(snap({ ...STATE, positions: [], wallets: [], pools: [{ chain: "solana", asset: "SOL", balance: "2", price: PX(150) }, { chain: "base", asset: "ETH", balance: "0" }] }), data(), NOW).totals!;
  assert.equal(one.cash, 7318n + 30000n);
  // an empty pool is left out of the parts, priced or not
  assert.deepEqual(one.parts.map((p) => p.chain), ["near", "solana"]);
});

test("one balance: a pool with no fresh price has no dollar part and stays out of Cash; none is made up", () => {
  // Solana's feed bound is 60 s: a read 120 s old is past it on this device's clock
  const s = { ...FOUR, wallets: [], pools: [{ chain: "solana" as const, asset: "SOL" as const, balance: "12.5", price: PX(150, 120) }, { chain: "base" as const, asset: "ETH" as const, balance: "0.25" }] };
  const t = portfolio(snap(s), data(), NOW).totals!;
  assert.equal(t.cash, 7318n);
  assert.deepEqual(t.parts, [
    { chain: "near", cents: 7318n, moving: false },
    { chain: "solana", cents: null, moving: false },
    { chain: "base", cents: null, moving: false },
  ]);
});

const POOL_STAGES = ["quote_checked", "waiting", "in_transit", "in_pool", "refunded", "refund_move", "failed", "short", "expired"] as const;
const POOL_MOVING = new Set(["waiting", "in_transit", "refunded", "refund_move", "failed", "short"]);
const VAULT_STAGES = ["quote_checked", "waiting", "in_transit", "into_vault", "done", "refunded", "held", "halted", "failed", "short", "expired", "refund_move"] as const;
const VAULT_MOVING = new Set(["waiting", "in_transit", "into_vault", "refunded", "refund_move", "failed", "short"]);

for (const stage of POOL_STAGES) {
  test(`one balance, in flight: a pool deposit at ${stage} is counted once, on the side the kit's totals hold it`, () => {
    const op = { id: "pd1", kind: "pool_deposit", chain: "base", stage, txs: [] } as Operation;
    const t = portfolio(snap({ ...FOUR, wallets: [], ops: [op] }), data(), NOW).totals!;
    // the vault and the pools as the kit reports them, never more or less at any stage: the op adds no amount
    assert.equal(t.cash, 7318n + 187500n + 75000n + 30000n);
    const base = t.parts.find((p) => p.chain === "base")!;
    assert.equal(base.cents, 75000n);
    assert.equal(base.moving, POOL_MOVING.has(stage));
    // only the pool's own chain is marked
    assert.ok(t.parts.filter((p) => p.chain !== "base").every((p) => !p.moving));
  });
}

for (const stage of VAULT_STAGES) {
  test(`one balance, in flight: a vault deposit at ${stage} is counted once, on the side the kit's totals hold it`, () => {
    // a done deposit carries the USDC it credited; vault_balance already holds that note, so it never adds again
    const op = { id: "d1", kind: "deposit", stage, txs: [], ...(stage === "done" ? { amount_usd: "50" } : {}) } as Operation;
    const t = portfolio(snap({ ...FOUR, wallets: [], ops: [op] }), data(), NOW).totals!;
    assert.equal(t.cash, 7318n + 187500n + 75000n + 30000n);
    const near = t.parts.find((p) => p.chain === "near")!;
    assert.equal(near.cents, 7318n);
    assert.equal(near.moving, VAULT_MOVING.has(stage));
  });
}

test("one balance, in flight: a chain with nothing yet and a deposit moving is listed, at $0, marked", () => {
  const op = { id: "pd2", kind: "pool_deposit", chain: "robinhood", stage: "in_transit", txs: [] } as Operation;
  const t = portfolio(snap({ ...STATE, positions: [], wallets: [], ops: [op] }), data(), NOW).totals!;
  assert.deepEqual(t.parts, [
    { chain: "near", cents: 7318n, moving: false },
    { chain: "robinhood", cents: 0n, moving: true },
  ]);
});

test("words: every word has a source; the drafts left are the overflow button's accessible name and card app-export-every-wallet's two (words-pending)", () => {
  for (const [k, w] of Object.entries(WORDS)) assert.ok(w.text && w.source, k);
  for (const k of ["total", "token", "holding", "value", "pnl", "realized", "tpsl", "search", "hideSmall", "minSize", "feesPaid", "receipt", "keyExported", "viewKey"] as const) assert.equal(WORDS[k].draft, false, k);
  // owner 2 Nov 06:08Z, all approved
  for (const k of ["cash", "noPositions", "noActivity", "open", "closed", "offline", "noRoute", "reverted", "held", "today", "yesterday", "notRestorable"] as const) assert.equal(WORDS[k].draft, false, k);
  // owner 3 Nov 09:17Z, keep (card balances-per-chain)
  for (const k of ["privateBalance", "balance", "ready", "pending", "noBalance"] as const) assert.equal(WORDS[k].draft, false, k);
  assert.deepEqual([...DRAFTS], ["more"], "Export key and Wallets were kept (owner 8 Nov 07:55Z)");
});

test("export (card app-export-every-wallet): each row names the wallets that hold it; Wallets lists every money wallet with no position, a deposit wallet with money left among them", () => {
  const s: SignpageState = { ...STATE, deposit_wallets: [{ chain: "solana", address: "SoU3xxxxxxxxxxxxxxxx", asset: "SOL", amount: "0.02" }, { chain: "solana", address: "SoU4", asset: "SOL", amount: "0" }] };
  const pf = portfolio({ status: "ready", state: s } as SignpageClientSnapshot, data(), NOW);
  assert.deepEqual(Object.fromEntries(pf.rows.map((r) => [r.key, r.addresses])), { "solana:WTH": ["a4"], "base:BOAR": ["b1", "b2"], "near:NEAIR": ["n1"], "solana:SWC": ["s1"] });
  assert.deepEqual(walletRows(s), [
    { chain: "solana", address: "a1", role: "trade", amount: null, asset: null, size: 1000n },
    { chain: "solana", address: "SoU3xxxxxxxxxxxxxxxx", role: "deposit", amount: 20_000_000n, asset: "SOL", size: null },
    { chain: "base", address: "a2", role: "trade", amount: null, asset: null, size: 500n },
    { chain: "near", address: "a3", role: "trade", amount: null, asset: null, size: 250n },
  ]);
  assert.deepEqual(walletRows(null), []);
  assert.equal(shortAddress("SoU3xxxxxxxxxxxxxxxx"), "SoU3…xxxx");
  assert.equal(shortAddress("u.near"), "u.near");
});
