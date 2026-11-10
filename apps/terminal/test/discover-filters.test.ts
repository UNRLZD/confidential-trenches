// Discover's column filter panel (card app-discover-filter-panel; 09-design-brief CN-137, drawn after design-lock-r5
// discover-ui.js P.filterPanel and P.d7filter): each control reads one field the helper serves on Discover's rows, runs on
// this device over the rows already served, and never hides a row that does not carry its field (M160 N4). Snipers % and
// Dev sold are not shipped: snipers_bps and creator_sold_bps are null on every served row (apps/helper/src/data/solana/
// lists.ts, apps/helper/src/data/evm/lists.ts). The browser run (test/discover-screens/run.mjs) opens the panel at 1440
// and the sheet at 390.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MarketRow } from "../src/screens/discover/fields.ts";
import { ROW_FIELDS } from "../src/screens/discover/fields.ts";
import { columnRows, COLUMNS } from "../src/screens/discover/model.ts";
import type { ColumnKey } from "../src/screens/discover/model.ts";
import { boundText, COL_FILTER0, CONTROLS, controlsFor, FILTERS0, filterOn, filterRows, keeps, panelPads, parseBound, readFilters, servedOn } from "../src/screens/discover/filters.ts";
import type { ColFilter, FilterKey } from "../src/screens/discover/filters.ts";
import { WORDS } from "../src/screens/discover/words.ts";
import { bare, NOW_MS, solana } from "./discover-screens/snapshots.ts";

const f = (ranges: ColFilter["ranges"], pads: string[] = []): ColFilter => ({ pads, ranges });
const nowS = Math.floor(NOW_MS / 1000);

/** A row carrying every field a control reads, at a known value. */
const full: MarketRow = {
  ...bare,
  token: "Full111111111111111111111111111111111111111",
  created_s: nowS - 30 * 60,
  mc_usd: "50000",
  liq_usd: "20000",
  vol_5m_usd: "3000",
  vol_1h_usd: "40000",
  buys_5m: 60,
  sells_5m: 40,
  holders: 800,
  top10_bps: 2500,
  dev_bps: 400,
  launchpad: "pump.fun",
  curve_bps: 6100,
};

/** Each control: a value under `full`'s, `full`'s own (the bound is kept), one over it. */
const AT: Record<FilterKey, [number, number, number]> = {
  curve: [60, 61, 62],
  age: [29, 30, 31],
  mc: [49_999, 50_000, 50_001],
  liq: [19_999, 20_000, 20_001],
  vol5: [2_999, 3_000, 3_001],
  vol1: [39_999, 40_000, 40_001],
  tx5: [99, 100, 101],
  b5: [59, 60, 61],
  s5: [39, 40, 41],
  hold: [799, 800, 801],
  top10: [24, 25, 26],
  dev: [3, 4, 5],
};

test("the controls, in R5's order, each naming the one served Row field it reads", () => {
  assert.deepEqual(
    CONTROLS.map((c) => [c.k, WORDS[c.label].text, c.fields.join(" + ")]),
    [
      ["curve", "Curve progress", "curve_bps"],
      ["age", "Age", "created_s"],
      ["mc", "MC", "mc_usd"],
      ["liq", "Liquidity", "liq_usd"],
      ["vol5", "Volume 5m", "vol_5m_usd"],
      ["vol1", "Volume 1h", "vol_1h_usd"],
      ["tx5", "Txns 5m", "buys_5m + sells_5m"],
      ["b5", "Buys 5m", "buys_5m"],
      ["s5", "Sells 5m", "sells_5m"],
      ["hold", "Holders", "holders"],
      ["top10", "Top 10 %", "top10_bps"],
      ["dev", "Dev %", "dev_bps"],
    ],
  );
  for (const c of CONTROLS) for (const k of c.fields) assert.ok((ROW_FIELDS as readonly string[]).includes(k), k);
});

test("no control reads a field the helper does not serve: Snipers % (snipers_bps) and Dev sold (creator_sold_bps) are left out", () => {
  const read = CONTROLS.flatMap((c) => c.fields);
  assert.ok(!read.includes("snipers_bps"));
  assert.ok(!read.includes("creator_sold_bps"));
});

test("Curve progress is Graduating's alone; the other columns draw the Metrics and Audit controls only", () => {
  assert.deepEqual(controlsFor("graduating").map((c) => c.k), CONTROLS.map((c) => c.k));
  for (const k of ["new", "trending", "hot"] as const) assert.deepEqual(controlsFor(k).map((c) => c.k), CONTROLS.filter((c) => c.k !== "curve").map((c) => c.k));
  assert.deepEqual(controlsFor("new").map((c) => c.section), ["metrics", "metrics", "metrics", "metrics", "metrics", "metrics", "metrics", "metrics", "metrics", "audit", "audit"]);
});

for (const c of CONTROLS) {
  test(`${WORDS[c.label].text}: a Min hides a row under it, a Max one over it, and the bound itself is kept`, () => {
    const [lo, at, hi] = AT[c.k];
    assert.equal(keeps(full, f({ [c.k]: { min: at } }), NOW_MS), true);
    assert.equal(keeps(full, f({ [c.k]: { max: at } }), NOW_MS), true);
    assert.equal(keeps(full, f({ [c.k]: { min: hi } }), NOW_MS), false);
    assert.equal(keeps(full, f({ [c.k]: { max: lo } }), NOW_MS), false);
    assert.equal(keeps(full, f({ [c.k]: { min: lo, max: hi } }), NOW_MS), true);
  });

  test(`${WORDS[c.label].text}: a row without ${c.fields.join(" or ")} (null or absent) is never hidden by it`, () => {
    const nulled = { ...full } as Record<string, unknown>;
    for (const k of c.fields) nulled[k] = null;
    const absent = { ...full } as Record<string, unknown>;
    for (const k of c.fields) delete absent[k];
    for (const r of [nulled, absent] as unknown as MarketRow[]) {
      assert.equal(keeps(r, f({ [c.k]: { min: 1e15 } }), NOW_MS), true);
      assert.equal(keeps(r, f({ [c.k]: { max: 0 } }), NOW_MS), true);
      // and every other control still reads the row
      const other = CONTROLS.find((o) => o.k !== c.k && !o.fields.some((x) => c.fields.includes(x)))!;
      assert.equal(keeps(r, f({ [c.k]: { min: 1e15 }, [other.k]: { min: 1e15 } }), NOW_MS), false, other.k);
    }
  });
}

test("Txns 5m reads buys_5m + sells_5m only when both are served", () => {
  assert.equal(keeps({ ...full, buys_5m: 100, sells_5m: null }, f({ tx5: { min: 1000 } }), NOW_MS), true);
  assert.equal(keeps({ ...full, buys_5m: 0, sells_5m: 0 }, f({ tx5: { min: 1 } }), NOW_MS), false);
});

test("a row the Base and Robinhood lists serve (no holders, Top 10 or dev) is kept by Holders, Top 10 % and Dev %", () => {
  const evm: MarketRow = { ...full, chain: "base", holders: null, top10_bps: null, dev_bps: null, snipers_bps: null, creator_sold_bps: null };
  assert.equal(keeps(evm, f({ hold: { min: 1e9 }, top10: { max: 0 }, dev: { max: 0 } }), NOW_MS), true);
  assert.equal(keeps(evm, f({ mc: { min: 1e9 } }), NOW_MS), false);
});

test("a value that is not a number (a broken wire value) is read as not served, never as 0", () => {
  assert.equal(keeps({ ...full, mc_usd: "n/a" }, f({ mc: { min: 1 } }), NOW_MS), true);
  assert.equal(keeps({ ...full, holders: Number.NaN }, f({ hold: { min: 1 } }), NOW_MS), true);
});

test("Launchpad: a picked chain:launchpad keeps its rows and hides every other, a row with no launchpad included", () => {
  const pf = f({}, ["solana:pump.fun"]);
  assert.equal(keeps(full, pf, NOW_MS), true);
  assert.equal(keeps({ ...full, launchpad: "letsbonk.fun" }, pf, NOW_MS), false);
  assert.equal(keeps({ ...full, chain: "base" }, pf, NOW_MS), false);
  assert.equal(keeps({ ...full, launchpad: null }, pf, NOW_MS), false);
  assert.equal(keeps({ ...full, launchpad: "letsbonk.fun" }, f({}, ["solana:pump.fun", "solana:letsbonk.fun"]), NOW_MS), true);
});

test("an unset panel keeps every row of every column, and is not on", () => {
  for (const k of ["new", "trending", "hot", "graduating"] as const) assert.deepEqual(filterRows(columnRows(solana, k), FILTERS0[k], NOW_MS), columnRows(solana, k));
  for (const k of Object.keys(FILTERS0) as ColumnKey[]) assert.equal(filterOn(FILTERS0[k]), false);
  assert.equal(filterOn(f({ mc: { min: 1 } })), true);
  assert.equal(filterOn(f({}, ["solana:pump.fun"])), true);
  assert.equal(filterOn(f({ mc: {} })), false);
});

test("on the recorded read, MC Min $10K hides exactly the served MCs under $10K, and some", () => {
  const rows = columnRows(solana, "new");
  const kept = filterRows(rows, f({ mc: { min: 10_000 } }), NOW_MS);
  const hid = rows.filter((r) => !kept.includes(r));
  assert.ok(hid.length > 0 && kept.length > 0, `hid ${hid.length} of ${rows.length}`);
  for (const r of hid) assert.ok(r.mc_usd !== null && r.mc_usd !== undefined && Number(r.mc_usd) < 10_000, r.symbol);
});

test("a bound as typed: a plain amount, $ and % and commas dropped, K M B for thousands; empty unsets; anything else is refused", () => {
  assert.equal(parseBound("10000", "$"), 10_000);
  assert.equal(parseBound(" $10K ", "$"), 10_000);
  assert.equal(parseBound("1.5m", "$"), 1_500_000);
  assert.equal(parseBound("2B", "$"), 2e9);
  assert.equal(parseBound("1,200", ""), 1200);
  assert.equal(parseBound("25%", "%"), 25);
  assert.equal(parseBound("5m", "m"), 5);
  assert.equal(parseBound("", "$"), null);
  assert.equal(parseBound("  ", "%"), null);
  for (const bad of ["abc", "-5", "1e3", "10KK", "$", "1.2.3", "Infinity"]) assert.equal(parseBound(bad, "$"), undefined, bad);
});

test("a set bound is drawn as R5 draws it: $10K, 25%, 5m, 800", () => {
  assert.equal(boundText(10_000, "$"), "$10K");
  assert.equal(boundText(1_500_000, "$"), "$1.5M");
  assert.equal(boundText(25, "%"), "25%");
  assert.equal(boundText(5, "m"), "5m");
  assert.equal(boundText(800, ""), "800");
  assert.equal(boundText(1200, ""), "1.2K");
});

test("a drawn bound reads back as itself, so focusing a set box and leaving it changes nothing", () => {
  for (const [v, u] of [[10_000, "$"], [1_500_000, "$"], [999e9, "$"], [25, "%"], [99.99, "%"], [5, "m"], [800, ""], [1200, ""], [0, "$"]] as const)
    assert.equal(parseBound(boundText(v, u), u), v, `${v} ${u}`);
});

test("the filters, kept and read back: a stored panel per column survives; anything else is the unset panel", () => {
  const set = { ...FILTERS0, trending: f({ mc: { min: 10_000 }, hold: { max: 50 } }, ["solana:pump.fun"]), graduating: f({ curve: { min: 25 } }) };
  assert.deepEqual(readFilters(JSON.parse(JSON.stringify(set))), set);
  for (const raw of [undefined, null, 7, "x", [], { new: 1 }]) assert.deepEqual(readFilters(raw), FILTERS0);
  // a bound that is not a finite amount 0 or over, a control no column has, and Curve progress off Graduating are dropped
  const odd = readFilters({ new: { pads: ["solana:pump.fun", 3, "nochain"], ranges: { mc: { min: -1, max: 5 }, snip: { min: 1 }, curve: { min: 10 }, age: { min: "5" } } } });
  assert.deepEqual(odd.new, f({ mc: { max: 5 } }, ["solana:pump.fun"]));
  assert.deepEqual(odd.hot, COL_FILTER0);
});

test("each column has its own panel", () => {
  assert.deepEqual(Object.keys(FILTERS0).sort(), COLUMNS.map((c) => c.key).sort());
});

test("the panel's launchpads: every launchpad on Discover's lists now, under its chain, counted in this column; Graduating's only those with a curve", () => {
  const pads = panelPads(solana, "new");
  assert.deepEqual(pads.map((g) => g.chain), ["solana"]);
  const newRows = columnRows(solana, "new");
  for (const e of pads[0]!.entries) assert.equal(e.count, newRows.filter((r) => `${r.chain}:${r.launchpad}` === e.key).length, e.key);
  assert.ok(pads[0]!.entries.some((e) => e.count > 0));
  const grad = panelPads(solana, "graduating");
  const curvePads = new Set(columnRows(solana, "graduating").map((r) => `${r.chain}:${r.launchpad}`));
  for (const e of grad[0]!.entries) assert.ok(curvePads.has(e.key), e.key);
});

test("the chains that serve a control's field on the lists now (the control's hover where not every chain does)", () => {
  const mixed = { ...solana, chain: "all" as const, lists: { ...solana.lists, new: [...solana.lists.new, { ...full, chain: "base" as const, holders: null, top10_bps: null, dev_bps: null }] } };
  const hold = CONTROLS.find((c) => c.k === "hold")!;
  const mc = CONTROLS.find((c) => c.k === "mc")!;
  assert.deepEqual(servedOn(mixed, hold), { all: false, chains: ["solana"] });
  assert.deepEqual(servedOn(mixed, mc), { all: true, chains: ["solana", "base"] });
});
