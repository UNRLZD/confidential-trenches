// The token page shell on fixtures (card app-token-page; A2.2, app.md:1435 at research 3c95759): the fixtures hold
// only 06b Row fields, the header's numbers (price, market cap, volume, liquidity, holders, age, the 24h change) at
// their edge values, the curve rule (J19, app.md:552-555: a bar only for a token still on a launchpad curve, the dash
// and no bar for any other), and the route map that draws the page at its route. Where the route's data comes from is
// test/no-test-token.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ROW_FIELDS, ROW_REQUIRED } from "../src/screens/discover/fields.ts";
import type { MarketRow } from "../src/screens/discover/fields.ts";
import { FIXTURE_NOW_MS, TOKENS } from "./token-page/fixtures.ts";
import { change24, curve, tokenView } from "../src/screens/token/model.ts";
import { DRAFTS, WORDS } from "../src/screens/token/words.ts";

const base = TOKENS.curve!;
const at = (r: Partial<MarketRow>) => tokenView({ ...base, ...r }, FIXTURE_NOW_MS);

test("fixtures: every token holds only 06b Row fields, every required one", () => {
  const known = new Set<string>(ROW_FIELDS);
  for (const [k, r] of Object.entries(TOKENS)) {
    for (const f of Object.keys(r)) assert.ok(known.has(f), `${k}: ${f} is not a Row field`);
    for (const f of ROW_REQUIRED) assert.ok(f in r && (r as unknown as Record<string, unknown>)[f] !== undefined, `${k}: ${f} missing`);
  }
  assert.deepEqual(Object.keys(TOKENS).sort(), ["curve", "edges", "listed", "pool"]);
});

test("header: price, market cap, 24h volume, liquidity and holders as Discover draws them", () => {
  const v = tokenView(base, FIXTURE_NOW_MS);
  assert.equal(v.symbol, "GLOW");
  assert.equal(v.price, "$0.0₄273");
  assert.equal(v.mc, "$27.3K");
  assert.equal(v.vol, "$132.7K");
  assert.equal(v.liq, "$9.81K");
  assert.equal(v.holders, "2,680");
  assert.equal(v.age, "41m");
  assert.equal(v.launchpad, "pump.fun");
});

test("header edges: tiny, huge, zero, rounding into the next unit, garbage and missing fields", () => {
  assert.equal(at({ price_usd: "0.00000000001234" }).price, "$0.0₁₀123");
  assert.equal(at({ price_usd: "184223.5" }).price, "$184,223.50");
  assert.equal(at({ price_usd: "0" }).price, "$0");
  // the strip tile's price is cut to its width; the header's price is not (card app-shell-cls-chrome)
  assert.equal(at({ price_usd: "184223.5" }).priceTile, "$184.2K");
  assert.equal(at({ price_usd: "0.00273" }).priceTile, "$0.00273");
  assert.equal(at({ price_usd: null }).price, "—");
  assert.equal(at({ price_usd: "-1" }).price, "—");
  assert.equal(at({ mc_usd: "999999" }).mc, "$1.00M");
  assert.equal(at({ mc_usd: "123456789012345" }).mc, "$123.46T");
  assert.equal(at({ mc_usd: undefined }).mc, "—");
  assert.equal(at({ vol_24h_usd: "9999.96" }).vol, "$10.0K");
  assert.equal(at({ vol_24h_usd: "1e5" }).vol, "—");
  assert.equal(at({ liq_usd: "0.04" }).liq, "$0.04");
  assert.equal(at({ liq_usd: null }).liq, "—");
  assert.equal(at({ holders: 999_999 }).holders, "1.00M");
  assert.equal(at({ holders: -3 }).holders, "—");
  assert.equal(at({ holders: null }).holders, "—");
});

test("age: whole units rounded down against the page's clock; a launch ahead of it is 1s; none is the dash", () => {
  const s = (sec: number) => Math.floor(FIXTURE_NOW_MS / 1000) - sec;
  assert.equal(at({ created_s: s(59) }).age, "59s");
  assert.equal(at({ created_s: s(3600) }).age, "1h");
  assert.equal(at({ created_s: s(86400 * 30) }).age, "30d");
  assert.equal(at({ created_s: s(-60) }).age, "1s");
  assert.equal(at({ created_s: null }).age, "—");
});

test("24h change: two places, signed, grouped, the direction for its colour; a part basis point or none is the dash", () => {
  assert.deepEqual(change24(802), { text: "+8.02%", dir: "up" });
  assert.deepEqual(change24(-517), { text: "−5.17%", dir: "down" });
  assert.deepEqual(change24(0), { text: "+0.00%", dir: "up" });
  assert.deepEqual(change24(-1), { text: "−0.01%", dir: "down" });
  assert.deepEqual(change24(99_999_999), { text: "+999,999.99%", dir: "up" });
  assert.deepEqual(change24(5_140_400), { text: "+51,404.00%", dir: "up" });
  assert.deepEqual(change24(null), { text: "—", dir: "none" });
  assert.deepEqual(change24(undefined), { text: "—", dir: "none" });
  assert.deepEqual(change24(Number.NaN), { text: "—", dir: "none" });
  assert.deepEqual(change24(12.5), { text: "—", dir: "none" });
  assert.equal(at({ chg_24h_bps: -10000 }).chg.text, "−100.00%");
});

test("curve rule: a bar only for a token still on a launchpad curve; every other token the dash and no bar", () => {
  assert.deepEqual(curve({ launchpad: "pump.fun", curve_bps: 6420 }), { on: true, text: "64%", fill: 0.642 });
  assert.deepEqual(curve({ launchpad: "pump.fun", curve_bps: 0 }), { on: true, text: "0%", fill: 0 });
  assert.deepEqual(curve({ launchpad: "pump.fun", curve_bps: 9999 }), { on: true, text: "99%", fill: 0.9999 });
  // graduated: off the curve, listed on a pool
  assert.deepEqual(curve({ launchpad: "pump.fun", curve_bps: 10000 }), { on: false, text: "—", fill: 0 });
  // no launchpad (a stablecoin, a major): never a curve, whatever the field says
  assert.deepEqual(curve({ launchpad: null, curve_bps: null }), { on: false, text: "—", fill: 0 });
  assert.deepEqual(curve({ launchpad: null, curve_bps: 4000 }), { on: false, text: "—", fill: 0 });
  // a launchpad token whose progress no source serves
  assert.deepEqual(curve({ launchpad: "pons", curve_bps: null }), { on: false, text: "—", fill: 0 });
  assert.deepEqual(curve({ launchpad: "pons" }), { on: false, text: "—", fill: 0 });
  // values no source sends
  assert.deepEqual(curve({ launchpad: "pump.fun", curve_bps: -1 }), { on: false, text: "—", fill: 0 });
  assert.deepEqual(curve({ launchpad: "pump.fun", curve_bps: 50.5 }), { on: false, text: "—", fill: 0 });
  assert.deepEqual(curve({ launchpad: "pump.fun", curve_bps: Number.NaN }), { on: false, text: "—", fill: 0 });
});

test("curve rule on the fixtures: the curve token has a bar; graduated, listed and edge tokens have none", () => {
  assert.equal(tokenView(TOKENS.curve!, FIXTURE_NOW_MS).curve.on, true);
  for (const k of ["pool", "listed", "edges"]) {
    const v = tokenView(TOKENS[k]!, FIXTURE_NOW_MS);
    assert.equal(v.curve.on, false, k);
    assert.equal(v.curve.text, "—", k);
  }
  assert.equal(tokenView(TOKENS.listed!, FIXTURE_NOW_MS).launchpad, null);
});

test("words: every word has its source, and no draft is left (owner 1 Nov 16:45Z, keep)", () => {
  assert.deepEqual([...DRAFTS], []);
  for (const w of Object.values(WORDS)) assert.ok(w.text.length > 0 && w.source.length > 0);
});

test("route map: the token route draws the token page", () => {
  const src = readFileSync(new URL("../src/routes/Screen.tsx", import.meta.url), "utf8");
  assert.match(src, /token:\s*TokenRoute/);
});
