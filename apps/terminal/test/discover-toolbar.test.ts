// Discover's toolbar (card app-discover-toolbar; 09-design-brief S5 Presets, Filter chips, Column search, Pause, Quick-buy
// amount): each control reads only a field the helper serves on Discover's rows, and a field a row does not carry is
// never a flag or a fail (S5 Presets "an unknown is not a flag"; M160 N4). The browser run (test/discover-screens/run.mjs)
// clicks each control at 1440 and 390.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { MarketRow, MarketSnapshot } from "../src/screens/discover/fields.ts";
import { columnRows } from "../src/screens/discover/model.ts";
import { flagged, MC_LINE, matches, narrowed, padEntries, passes, pendingNew, qbAmount, readView, VIEW0, viewRows } from "../src/screens/discover/view.ts";
import type { View } from "../src/screens/discover/view.ts";
import { bare, solana } from "./discover-screens/snapshots.ts";

const v = (o: Partial<View>): View => ({ ...VIEW0, ...o });
const FEWER = v({ preset: "fewer_flags" });

test("All keeps every row", () => {
  for (const k of ["new", "trending", "hot", "graduating"] as const) {
    const rows = columnRows(solana, k);
    assert.deepEqual(viewRows(rows, VIEW0), rows);
  }
  assert.equal(narrowed(VIEW0), false);
});

test("Fewer flags hides a row with a known flag on Top 10 or dev, at the line (amber) and over it (coral)", () => {
  assert.equal(flagged({ ...bare, top10_bps: 2999 }), false);
  assert.equal(flagged({ ...bare, top10_bps: 3000 }), true);
  assert.equal(flagged({ ...bare, top10_bps: 4500 }), true);
  assert.equal(flagged({ ...bare, dev_bps: 999 }), false);
  assert.equal(flagged({ ...bare, dev_bps: 1000 }), true);
  // snipers_bps is null on every served row: Fewer flags does not read it (card app-discover-toolbar)
  assert.equal(flagged({ ...bare, snipers_bps: 5000 }), false);
  assert.equal(passes({ ...bare, dev_bps: 1500 }, FEWER), false);
  assert.equal(passes({ ...bare, top10_bps: 1200, dev_bps: 50 }, FEWER), true);
});

test("Fewer flags: an unknown is not a flag (null or absent Top 10, dev and snipers pass)", () => {
  assert.equal(passes(bare, FEWER), true);
  assert.equal(passes({ ...bare, top10_bps: null, dev_bps: null, snipers_bps: null }, FEWER), true);
});

test("Fewer flags on the recorded read: it hides exactly the rows with a served share at a line, and some", () => {
  const rows = columnRows(solana, "new");
  const kept = viewRows(rows, FEWER);
  const hid = rows.filter((r) => !kept.includes(r));
  assert.ok(hid.length > 0 && kept.length > 0, `hid ${hid.length} of ${rows.length}`);
  for (const r of hid) assert.ok((r.top10_bps ?? 0) >= 3000 || (r.dev_bps ?? 0) >= 1000, r.symbol);
});

test("MC ≥ $10K hides a served MC under $10K, keeps $10K and over, and keeps a row whose MC is not served", () => {
  const mc = v({ mc10k: true });
  assert.equal(MC_LINE, 10_000);
  assert.equal(passes({ ...bare, mc_usd: "9999.99" }, mc), false);
  assert.equal(passes({ ...bare, mc_usd: "10000" }, mc), true);
  assert.equal(passes({ ...bare, mc_usd: "2320000.5" }, mc), true);
  assert.equal(passes({ ...bare, mc_usd: null }, mc), true);
  assert.equal(passes(bare, mc), true);
  const rows = columnRows(solana, "new");
  const kept = viewRows(rows, mc);
  assert.ok(kept.length < rows.length, "the recorded read holds rows under $10K");
  for (const r of rows.filter((r) => !kept.includes(r))) assert.ok(Number(r.mc_usd) < 10_000, r.symbol);
});

test("Launchpad by chain: a pick keeps that chain's launchpad only; a row with no launchpad leaves while any is picked", () => {
  const sol: MarketRow = { ...bare, chain: "solana", launchpad: "pump.fun" };
  const base: MarketRow = { ...bare, chain: "base", launchpad: "pump.fun" };
  const none: MarketRow = { ...bare, launchpad: null };
  const pick = v({ pads: ["solana:pump.fun"] });
  assert.equal(passes(sol, pick), true);
  assert.equal(passes(base, pick), false);
  assert.equal(passes(none, pick), false);
  assert.equal(passes(none, VIEW0), true);
  assert.equal(passes({ ...bare, launchpad: "met-dbc" }, v({ pads: ["solana:pump.fun", "solana:met-dbc"] })), true);
});

test("the launchpad menu: each launchpad on the lists now with its token count (each token once), most first, named only", () => {
  const entries = padEntries(solana);
  assert.ok(entries.length > 1);
  const seen = new Map<string, string>();
  for (const name of ["new", "trending", "trending_5m", "trending_1h", "graduating"] as const) for (const r of solana.lists[name] ?? []) seen.set(r.token, `${r.chain}:${r.launchpad}`);
  for (const e of entries) assert.equal(e.count, [...seen.values()].filter((k) => k === e.key).length, e.key);
  for (let i = 1; i < entries.length; i++) assert.ok(entries[i - 1]!.count >= entries[i]!.count);
  const unnamed: MarketSnapshot = { ...solana, lists: { new: [{ ...bare, token: "x1", launchpad: "not-a-pad" }], trending: [] } };
  assert.deepEqual(padEntries(unnamed), []);
});

test("column search: a symbol or a name holding the text, any case; blank keeps all", () => {
  const r: MarketRow = { ...bare, symbol: "NEARLY", name: "Nearly.trade" };
  assert.equal(matches(r, "near"), true);
  assert.equal(matches(r, "TRADE"), true);
  assert.equal(matches(r, "  "), true);
  assert.equal(matches(r, "bonk"), false);
  const rows = columnRows(solana, "new");
  const q = rows[0]!.symbol.slice(0, 3);
  assert.ok(viewRows(rows, VIEW0, q).every((x) => matches(x, q)) && viewRows(rows, VIEW0, q).includes(rows[0]!));
});

test("the views stack: a row must pass the preset, the chip, the launchpads and the search", () => {
  const r: MarketRow = { ...bare, symbol: "AAA", mc_usd: "50000", launchpad: "pump.fun", dev_bps: 100 };
  const all = v({ preset: "fewer_flags", mc10k: true, pads: ["solana:pump.fun"] });
  assert.deepEqual(viewRows([r], all, "aa"), [r]);
  assert.deepEqual(viewRows([{ ...r, dev_bps: 2000 }], all, "aa"), []);
  assert.deepEqual(viewRows([r], all, "zz"), []);
});

test("Pause: the new tokens a live list has over the held one, per column", () => {
  const held = solana;
  const extra: MarketRow = { ...solana.lists.new[0]!, token: "NewWhilePaused111", created_s: (solana.lists.new[0]!.created_s ?? 0) + 5 };
  const live: MarketSnapshot = { ...solana, lists: { ...solana.lists, new: [extra, ...solana.lists.new] } };
  assert.equal(pendingNew(live, held, "new"), 1);
  assert.equal(pendingNew(live, held, "hot"), 0);
  assert.equal(pendingNew(held, held, "new"), 0);
});

test("Quick buy amount: a positive USD amount, 2 decimals at most; anything else is flagged", () => {
  assert.equal(qbAmount("25"), 25);
  assert.equal(qbAmount(" 10.5 "), 10.5);
  assert.equal(qbAmount("0.01"), 0.01);
  for (const bad of ["", "0", "0.00", "-5", "1e3", "12.345", "abc", "$25", "12345678"]) assert.equal(qbAmount(bad), null, bad);
});

test("a stored view reads back, and anything else is All", () => {
  assert.deepEqual(readView({ preset: "fewer_flags", mc10k: true, pads: ["solana:pump.fun", 7, "x"] }), { preset: "fewer_flags", mc10k: true, pads: ["solana:pump.fun"] });
  assert.deepEqual(readView(null), VIEW0);
  assert.deepEqual(readView({ preset: "following" }), VIEW0);
});

test("no toolbar control reads a field the helper serves as null on every Solana row (creator_sold_bps, snipers_bps)", () => {
  const src = readFileSync(new URL("../src/screens/discover/view.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/creator_sold_bps|snipers_bps/.test(src));
  const helper = readFileSync(new URL("../../helper/src/data/solana/lists.ts", import.meta.url), "utf8");
  assert.match(helper, /creator_sold_bps: null,/);
  assert.match(helper, /snipers_bps: null,/);
});
