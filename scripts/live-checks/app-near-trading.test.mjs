// node --test scripts/live-checks/app-near-trading.test.mjs: the live check's verdict replays recorded runs
// (app-near-trading.answers.json), each read by app-near-trading.mjs collect() in headless Chromium:
//   good: card app-near-trading's build (12 Nov) served at APP_HOST's name inside the stand-in shell, signed out, HELPER_HOST
//         live: the top of NEAR's Trending draws ready at 1440 and 390, its trade box on NEAR's path, the JS carrying
//         pool.buy and pool.sell with chain near: PASS;
//   bad:  APP_HOST as deployed on 12 Nov (main d97e984e): the page draws, the box takes the vault's path and the JS carries
//         no NEAR request: FAIL.
// Planted from the good run: a box on another path, a page of another token, a script without the sell request.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, LOADS, MARKS, topOf } from "./app-near-trading.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-near-trading.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the NEAR token page at both widths, its box on NEAR's path, the JS with both NEAR requests: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.loads.length, LOADS.length);
  for (const l of ANSWERS.good.loads) {
    assert.equal(l.shown, ANSWERS.good.top);
    assert.equal(l.box.path, "near");
    assert.ok(l.scripts.some((s) => s.marks.buy) && l.scripts.some((s) => s.marks.sell));
  }
});

test("recorded bad answer: the deployed app before the card (the vault's path, no NEAR request): FAIL at both widths", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  for (const l of LOADS) {
    assert.ok(bad(r.lines).some((x) => x.startsWith(`BAD ${l.name}: the trade box's path is vault, not near`)), r.lines.join("\n"));
    assert.ok(bad(r.lines).some((x) => x.startsWith(`BAD ${l.name}: the served JS`) && /no NEAR buy request/.test(x) && /no NEAR sell request/.test(x)), r.lines.join("\n"));
  }
});

test("planted: a box on the pool's path, a page of another token, a script set without the sell request, no lists: FAIL", () => {
  const pool = mut((rec) => (rec.loads[0].box.path = "pool"));
  assert.ok(bad(pool.lines).some((l) => /^BAD desktop: the trade box's path is pool, not near/.test(l)), pool.lines.join("\n"));
  const other = mut((rec) => (rec.loads[1].shown = "token.rhealab.near"));
  assert.ok(bad(other.lines).some((l) => /^BAD phone: the page is near\/token\.rhealab\.near, not near\//.test(l)), other.lines.join("\n"));
  const sell = mut((rec) => {
    for (const s of rec.loads[0].scripts) s.marks.sell = false;
  });
  assert.ok(bad(sell.lines).some((l) => /^BAD desktop: the served JS .*no NEAR sell request/.test(l)), sell.lines.join("\n"));
  const lists = mut((rec) => {
    rec.lists.status = 503;
    rec.top = null;
  });
  assert.equal(lists.ok, false);
});

test("the marks read the build's own writing of the NEAR requests, and not the pool chains'", () => {
  assert.ok(MARKS.buy.test("kind:`pool.buy`,params:{chain:`near`,token:e,amount:cm(t),slippage_bps:n}"));
  assert.ok(MARKS.sell.test("kind:`pool.sell`,params:{chain:`near`,token:n,share_bps:Bm,slippage_bps:i}"));
  assert.ok(!MARKS.buy.test("kind:`pool.buy`,params:{chain:p.chain,token:t,amount:a,slippage_bps:s}"));
  assert.ok(!MARKS.sell.test("kind:`pool.sell`,params:{chain:p.chain,token:t,...size,slippage_bps:s}"));
});

test("topOf: the top of NEAR's Trending in Discover's order, only NEAR rows", () => {
  const row = (token, vol) => ({ chain: "near", token, vol_1h_usd: vol, chg_1h_bps: 0 });
  assert.equal(topOf({ lists: { trending: [row("a.near", "1"), row("b.near", "9")] } }) !== null, true);
  assert.equal(topOf({ lists: { trending: [{ chain: "solana", token: "So11111111111111111111111111111111111111112" }] } }), null);
  assert.equal(topOf(null), null);
});
