// Discover on fixtures (card app-discover-solana; A2.1, app.md:1454): the fixtures hold exactly 06b's Row fields, each
// column's rows and order, and the row's numbers (price, market cap, volume, age, shares) at their edge values.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ROW_FIELDS, ROW_REQUIRED, SNAPSHOT_LISTS } from "../src/screens/discover/fields.ts";
import type { MarketRow } from "../src/screens/discover/fields.ts";
import { age, count, price, priceTile, usd } from "../src/screens/discover/format.ts";
import { COLUMNS, columnRows, level, rowView } from "../src/screens/discover/model.ts";
import { DRAFTS, WORDS } from "../src/screens/discover/words.ts";
import { bare, edges, edgy, empty, NOW_MS, RECORDED_FIELDS, solana } from "./discover-screens/snapshots.ts";

const allRows = (s: typeof solana) => SNAPSHOT_LISTS.flatMap((k) => s.lists[k] ?? []);

test("fixtures: the recorded read's column header is 06b's Row field list, in order", () => {
  assert.deepEqual(RECORDED_FIELDS, ROW_FIELDS);
});

test("fixtures: every row holds only 06b Row fields, every required one, in its wire form", () => {
  const known = new Set<string>(ROW_FIELDS);
  for (const r of [...allRows(solana), ...allRows(edgy)]) {
    for (const k of Object.keys(r)) assert.ok(known.has(k), `${r.symbol}: ${k} is not a Row field`);
    for (const k of ROW_REQUIRED) assert.ok(k in r && (r as unknown as Record<string, unknown>)[k] !== undefined, `${r.symbol}: ${k} missing`);
    assert.equal(r.chain, "solana");
    for (const k of ROW_FIELDS.filter((f) => f.endsWith("_usd"))) {
      const v = (r as unknown as Record<string, unknown>)[k];
      assert.ok(v === null || v === undefined || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)), `${r.symbol}: ${k}=${String(v)} is not a decimal string`);
    }
    for (const k of ROW_FIELDS.filter((f) => f.endsWith("_bps") || f === "holders" || f.startsWith("buys_") || f.startsWith("sells_"))) {
      const v = (r as unknown as Record<string, unknown>)[k];
      assert.ok(v === null || v === undefined || Number.isInteger(v), `${r.symbol}: ${k}=${String(v)} is not an integer`);
    }
  }
  assert.ok(solana.lists.new.length >= 9 && solana.lists.trending_5m!.length >= 9 && solana.lists.trending_1h!.length >= 9);
});

test("fixtures: a side Jupiter leaves out reads 0, never null; both sides unknown is null (buys and sells of 5m, 1h and 24h)", () => {
  const sides = [["buys_5m", "sells_5m"], ["buys_1h", "sells_1h"], ["buys_24h", "sells_24h"]] as const;
  let zeros = 0;
  for (const r of [...allRows(solana), ...allRows(edgy)]) {
    for (const [b, s] of sides) {
      assert.equal(r[b] === null || r[b] === undefined, r[s] === null || r[s] === undefined, `${r.symbol}: ${b}=${String(r[b])} but ${s}=${String(r[s])}`);
      if (r[b] === 0 || r[s] === 0) zeros++;
    }
  }
  assert.ok(zeros > 0, "the recorded read holds rows with one side left out");
  const lan = solana.lists.new.find((r) => r.symbol === "LAN")!;
  assert.deepEqual([lan.buys_5m, lan.sells_5m, lan.buys_1h, lan.sells_1h, lan.buys_24h, lan.sells_24h], [2, 0, 2, 0, 2, 0]);
});

test("Trending (1h) draws the 1h buys and sells and the buy share from them; Hot (5m) still draws the 5m ones", () => {
  const r: MarketRow = { ...bare, buys_5m: 1, sells_5m: 3, buys_1h: 30, sells_1h: 10 };
  const h = rowView(r, "1h", NOW_MS);
  assert.deepEqual([h.buys, h.sells, h.buyShare], ["30", "10", 0.75]);
  const m = rowView(r, "5m", NOW_MS);
  assert.deepEqual([m.buys, m.sells, m.buyShare], ["1", "3", 0.25]);
  const oneSided = rowView({ ...bare, buys_1h: 7, sells_1h: 0 }, "1h", NOW_MS);
  assert.deepEqual([oneSided.buys, oneSided.sells, oneSided.buyShare], ["7", "0", 1]);
  assert.deepEqual([rowView({ ...bare, buys_1h: null, sells_1h: null }, "1h", NOW_MS).buys, rowView(bare, "1h", NOW_MS).sells], ["—", "—"]);
});

test("route map: Discover is routed, the same way the token page is (card app-discover-live)", () => {
  const src = readFileSync(new URL("../src/routes/Screen.tsx", import.meta.url), "utf8");
  assert.match(src, /discover:\s*DiscoverRoute/);
  assert.match(src, /token:\s*TokenRoute/);
});

test("price tile: at most 8 characters (the strip tile's width), compact from $100,000, decimals cut before a digit is dropped (card app-shell-cls-chrome)", () => {
  assert.equal(priceTile("184223.5"), "$184.2K");
  assert.equal(priceTile("100000"), "$100.0K");
  assert.equal(priceTile("99999.999"), "$99,999");
  assert.equal(priceTile("99999.99"), "$99,999");
  assert.equal(priceTile("12345.67"), "$12,345");
  assert.equal(priceTile("1234.56"), "$1,234.5");
  assert.equal(priceTile("1000"), "$1,000.0");
  assert.equal(priceTile("911.692423199483"), "$911.69");
  assert.equal(priceTile("5.68"), "$5.68");
  assert.equal(priceTile("0.00273"), "$0.00273");
  assert.equal(priceTile("0.000001234"), "$0.0₅123");
  assert.equal(priceTile("0"), "$0");
  assert.equal(priceTile("-1"), "—");
  assert.equal(priceTile(null), "—");
  for (const v of ["184223.5", "99999.99", "12345.67", "1234.56", "1000", "999.999", "100.5", "5.68", "0.5", "0.0123"]) assert.ok(priceTile(v).length <= 8, `${v} -> ${priceTile(v)}`);
});

test("price: tiny prices take the subscript zero count; garbage, negatives and null are the dash", () => {
  assert.equal(price("0.00000000001234"), "$0.0₁₀123");
  assert.equal(price("0.000001234"), "$0.0₅123");
  assert.equal(price("0.0001999"), "$0.0₃199");
  assert.equal(price("0.001234"), "$0.00123");
  assert.equal(price("0.0123"), "$0.0123");
  assert.equal(price("0.5"), "$0.5");
  assert.equal(price("911.692423199483"), "$911.69");
  assert.equal(price("184223.5"), "$184,223.50");
  assert.equal(price("0"), "$0");
  assert.equal(price("-1"), "—");
  assert.equal(price("1e-9"), "—");
  assert.equal(price("abc"), "—");
  assert.equal(price(null), "—");
  assert.equal(price(undefined), "—");
});

test("market cap and volume: compact, rounding rolls into the next unit, huge caps reach T", () => {
  assert.equal(usd("4150"), "$4.15K");
  assert.equal(usd("5900"), "$5.90K");
  assert.equal(usd("17560.5797945"), "$17.6K");
  assert.equal(usd("202400"), "$202.4K");
  assert.equal(usd("2212999703.19"), "$2.21B");
  assert.equal(usd("160240000"), "$160.24M");
  assert.equal(usd("123456789012345"), "$123.46T");
  assert.equal(usd("999.996"), "$1.00K");
  assert.equal(usd("9999.96"), "$10.0K");
  assert.equal(usd("999999"), "$1.00M");
  assert.equal(usd("999994999"), "$999.99M");
  assert.equal(usd("12.3"), "$12.30");
  assert.equal(usd("0.04"), "$0.04");
  assert.equal(usd("0.00000412"), "$0.0₅412");
  assert.equal(usd("0"), "$0");
  assert.equal(usd(null), "—");
  assert.equal(usd("x"), "—");
});

test("age: whole units rounded down; a launch time ahead of the clock is 1s; none is the dash", () => {
  const now = 1_800_000_000_000;
  const s = (sec: number) => Math.floor(now / 1000) - sec;
  assert.equal(age(s(0), now), "1s");
  assert.equal(age(s(59), now), "59s");
  assert.equal(age(s(60), now), "1m");
  assert.equal(age(s(3599), now), "59m");
  assert.equal(age(s(3600), now), "1h");
  assert.equal(age(s(86399), now), "23h");
  assert.equal(age(s(86400), now), "1d");
  assert.equal(age(s(86400 * 900), now), "900d");
  assert.equal(age(s(-30), now), "1s");
  assert.equal(age(null, now), "—");
  assert.equal(age(undefined, now), "—");
});

test("counts: grouped below 10K, K and M above", () => {
  assert.equal(count(0), "0");
  assert.equal(count(999), "999");
  assert.equal(count(9534), "9,534");
  assert.equal(count(67600), "67.6K");
  assert.equal(count(999_999), "1.00M");
  assert.equal(count(12_345_678), "12.35M");
  assert.equal(count(null), "—");
});

test("columns: New, Trending (1h), Hot (5m), Graduating, in the owner's order (round 15)", () => {
  assert.deepEqual(COLUMNS.map((c) => [c.key, c.win]), [["new", "5m"], ["trending", "1h"], ["hot", "5m"], ["graduating", "5m"]]);
});

test("New: newest launch first, a row with no launch time last, one row per token", () => {
  const rows = columnRows(solana, "new");
  const t = rows.map((r) => r.created_s ?? -1);
  for (let i = 1; i < t.length; i++) assert.ok(t[i - 1]! >= t[i]! || t[i] === -1, `order at ${i}`);
  assert.equal(new Set(rows.map((r) => r.token)).size, rows.length);
  const dup: MarketRow[] = [bare, { ...bare, created_s: 5 }, { ...bare, token: "Other", created_s: 10 }];
  const d = columnRows({ ...empty, lists: { ...empty.lists, new: dup } }, "new");
  assert.deepEqual(d.map((r) => r.token), ["Other", bare.token]);
});

test("Hot and Trending: the window's USD volume first, ties by trade count; no volume in the window is not listed", () => {
  const hot = columnRows(solana, "hot");
  for (let i = 1; i < hot.length; i++) assert.ok(Number(hot[i - 1]!.vol_5m_usd) >= Number(hot[i]!.vol_5m_usd));
  const trending = columnRows(solana, "trending");
  for (let i = 1; i < trending.length; i++) assert.ok(Number(trending[i - 1]!.vol_1h_usd) >= Number(trending[i]!.vol_1h_usd));
  const tie: MarketRow[] = [
    { ...bare, token: "A", vol_5m_usd: "100", buys_5m: 1, sells_5m: 1 },
    { ...bare, token: "B", vol_5m_usd: "100", buys_5m: 5, sells_5m: 5 },
    { ...bare, token: "C", vol_5m_usd: "0", buys_5m: 9, sells_5m: 9 },
    { ...bare, token: "D" },
    { ...bare, token: "E", vol_5m_usd: "250" },
  ];
  const s = { ...empty, lists: { ...empty.lists, trending_5m: tie } };
  assert.deepEqual(columnRows(s, "hot").map((r) => r.token), ["E", "B", "A"]);
});

test("Trending reads trending_1h, else `trending` (06b: they are equal)", () => {
  const only = { ...empty, lists: { ...empty.lists, trending: [{ ...bare, vol_1h_usd: "5" }], trending_1h: undefined } };
  assert.equal(columnRows(only, "trending").length, 1);
});

test("Graduating: only tokens still on a curve, highest progress first", () => {
  const g = columnRows(edgy, "graduating");
  assert.deepEqual(g.map((r) => r.curve_bps), [9999, 12]);
  const sol = columnRows(solana, "graduating").map((r) => r.curve_bps!);
  assert.deepEqual(sol, [...sol].sort((a, b) => b - a));
  assert.ok(sol.length >= 5);
});

test("risk levels: grey below the line, amber at it, coral at 1.5x; unknown is grey and never a pass", () => {
  assert.equal(level(2999, "top10"), "none");
  assert.equal(level(3000, "top10"), "warn");
  assert.equal(level(4499, "top10"), "warn");
  assert.equal(level(4500, "top10"), "sell");
  assert.equal(level(1000, "dev"), "warn");
  assert.equal(level(1500, "snipers"), "sell");
  assert.equal(level(null, "dev"), "none");
});

test("a row with no optional field draws the dash everywhere, never 0", () => {
  const v = rowView(bare, "5m", NOW_MS);
  assert.deepEqual([v.mc, v.vol, v.chg, v.age, v.top10.text, v.dev.text, v.snipers.text, v.holders, v.buys, v.sells], ["—", "—", "—", "—", "—", "—", "—", "—", "—", "—"]);
  assert.equal(v.name, "");
  assert.equal(v.buyShare, null);
  assert.equal(v.stage.pill, "POOL");
  assert.equal(v.price, "$0.0₃412");
});

test("edge rows: huge numbers stay short, hostile text stays text, a curve shows its percent", () => {
  const [tiny, huge, zalgo] = edges.map((r) => rowView(r, "5m", NOW_MS));
  assert.deepEqual([tiny!.price, tiny!.mc, tiny!.age, tiny!.stage.pill, tiny!.top10.level, tiny!.buyShare], ["$0.0₁₀123", "$12.30", "12s", "0%", "sell", 1]);
  assert.deepEqual([huge!.mc, huge!.vol, huge!.chg, huge!.holders, huge!.age, huge!.dev.text, huge!.dev.level], ["$123.46T", "$98.77M", "+12.3K% · 5m", "12.35M", "900d", "15.0%", "sell"]);
  assert.equal(rowView(edges[1]!, "1h", NOW_MS).chg, "−99% · 1h");
  assert.deepEqual([zalgo!.name, zalgo!.mc, zalgo!.vol, zalgo!.chg, zalgo!.stage.pill, zalgo!.buyShare, zalgo!.top10.level], ["<img src=x onerror=alert(1)>", "$1.00M", "$1.00K", "−33% · 5m", "99%", 0, "warn"]);
});

test("WORDS: every visible word sits in one table; the drafts are the list's age line (card app-list-age) and the launchpad menu's title (CN-137, card app-discover-toolbar)", () => {
  for (const [k, w] of Object.entries(WORDS)) assert.ok(w.text && w.source, k);
  assert.deepEqual(DRAFTS, (Object.keys(WORDS) as (keyof typeof WORDS)[]).filter((k) => WORDS[k].draft));
  assert.deepEqual(DRAFTS, ["updated", "padMenuTitle"]);
});

test("Graduating holds J19's curve rule, the token page's (card app-token-page): a launchpad and whole basis points 0-9999", () => {
  const rows: MarketRow[] = [
    { ...bare, token: "OnCurve", launchpad: "pump.fun", curve_bps: 5000 },
    { ...bare, token: "NoPad", launchpad: null, curve_bps: 5000 },
    { ...bare, token: "PartBps", launchpad: "pump.fun", curve_bps: 50.5 },
    { ...bare, token: "Listed", launchpad: "pump.fun", curve_bps: 10000 },
  ];
  const g = columnRows({ ...empty, lists: { ...empty.lists, graduating: rows } }, "graduating");
  assert.deepEqual(g.map((r) => r.token), ["OnCurve"]);
  assert.equal(rowView(rows[1]!, "5m", NOW_MS).stage.curve, false);
  assert.equal(rowView(rows[2]!, "5m", NOW_MS).stage.curve, false);
});
