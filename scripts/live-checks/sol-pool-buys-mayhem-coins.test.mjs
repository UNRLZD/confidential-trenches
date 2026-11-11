// node --test scripts/live-checks/sol-pool-buys-mayhem-coins.test.mjs: the live check replays its recorded answers
// (sol-pool-buys-mayhem-coins.answers.json). good: this card's builds (apps/terminal/dist, packages/signpage's
// index.html and app.js as build-app.mjs --out makes them), the page answering venue_not_built on its buy and its sell
// and the app drawing it as Unavailable: PASS. liveBefore: APP_HOST and SIGN_HOST before this card's deploy (read
// 11 Nov 14:09Z): FAIL, every mark named. Planted on the good one: another script, no pin, each mark taken away: each
// FAIL; and the marks on minified shapes, with their near misses.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./sol-pool-buys-mayhem-coins.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./sol-pool-buys-mayhem-coins.answers.json", import.meta.url), "utf8"));
const NO_BUY = "BAD the signing page's buy does not answer venue_not_built: a Mayhem coin's buy ends Failed with a Retry that cannot work";
const NO_SELL = "BAD the signing page's sell does not answer venue_not_built: a Mayhem coin's sale ends Failed with a Retry that cannot work";
const NO_REASON = "BAD the app does not draw venue_not_built as Unavailable: the trade box shows Failed with Retry";

test("recorded good answer: this card's builds answer venue_not_built and draw it as Unavailable: PASS", () => {
  assert.deepEqual(judge(ANSWERS.good), { ok: true, lines: [] });
});

test("recorded bad answer liveBefore: the hosts before this card: FAIL, every mark named", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  for (const l of [NO_BUY, NO_SELL, NO_REASON]) assert.ok(v.lines.includes(l), v.lines.join("\n"));
});

test("planted on the good answer: each mark taken away, another script, no pin: FAIL", () => {
  const with_ = (f) => {
    const a = structuredClone(ANSWERS.good);
    f(a);
    return judge(a);
  };
  assert.deepEqual(with_((a) => (a.sign.buy = false)).lines, [NO_BUY]);
  assert.deepEqual(with_((a) => (a.sign.sell = false)).lines, [NO_SELL]);
  assert.deepEqual(with_((a) => (a.app.reason = false)).lines, [NO_REASON]);
  assert.deepEqual(with_((a) => (a.app.sha384 = "sha384-other")).lines, ["BAD APP_HOST's served script is not the one index.html pins"]);
  assert.deepEqual(with_((a) => (a.sign.index = "<html></html>")).lines, ["BAD SIGN_HOST's index.html pins no script"]);
  assert.equal(judge(null).ok, false);
});

test("the marks on minified shapes: any quote and name; a near miss is no mark", () => {
  const idx = (js) => `<script type="module" src="/a.js" integrity="x"></script>${js.length}`;
  const f = (appJs, signJs) => facts({ index: idx(appJs), js: appJs }, { index: idx(signJs), js: signJs });
  for (const q of ["\"", "'", "`"]) {
    const got = f(`R=Object.freeze({no_table_fits:${q}unavailable${q},venue_not_built:${q}unavailable${q}})`, `return{error:${q}venue_not_built${q}};x;return{error:${q}venue_not_built${q},cause:$n}`);
    assert.deepEqual([got.app.reason, got.sign.buy, got.sign.sell], [true, true, true], q);
  }
  const miss = f(`{venue_not_built:"priceCheck",venue_not_pinned:"unavailable"}`, `{error:"venue_not_pinned"};{error:"venue_not_built",code:n};{error:"failed",cause:n}`);
  assert.deepEqual([miss.app.reason, miss.sign.buy, miss.sign.sell], [false, false, false]);
  // the buy's mark alone is no sale's
  const buyOnly = f("", `{error:"venue_not_built"}`);
  assert.deepEqual([buyOnly.sign.buy, buyOnly.sign.sell], [true, false]);
});
