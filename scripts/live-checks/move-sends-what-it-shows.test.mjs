// node --test scripts/live-checks/move-sends-what-it-shows.test.mjs: the live check replays its recorded answers
// (move-sends-what-it-shows.answers.json). good: this card's SIGN_HOST and APP_HOST builds: PASS. bad: the same builds of
// 83af19e2d, the card's base: FAIL, each fact named. liveBefore: the hosts as served before this card: FAIL, each fact
// named. facts() over the good build's own dry and pool.move (goodDrySource), and over it with one cut each: each cut
// read. Planted on the good answer: another /app.js, no pin, each fact taken away: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { appOf, facts, judge } from "./move-sends-what-it-shows.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./move-sends-what-it-shows.answers.json", import.meta.url), "utf8"));
const LIMITS = "BAD pool.move.dry answers no amount it can send for one it cannot: the sheet has no Max, Min or Try to show";
const PRICED = (n) => `BAD pool.move.dry names max on ${n} of its 3 priced answers: Max is not what the move sends`;
const FLOOR = "BAD a pool to pool dry does not read the destination pool's floor first: a move under it ends with its money in Cash";
const HOLD = "BAD pool.move does not hold to its dry: a move the dry refuses still leaves Cash or its pool";
const APP = (m) => `BAD APP_HOST's scripts lack the move sheet's ${m}: its Max or its hint is not what the page can send`;

test("recorded good answer: this card's builds hold every move to what it can send, and the sheet draws it: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

for (const k of ["bad", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, each fact named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, [LIMITS, PRICED(0), FLOOR, HOLD, APP("limits, max, tries")]);
  });
}

test("facts() reads the good build's own dry and pool.move, and each cut in them", () => {
  const src = `${ANSWERS.goodDrySource},answer:()=>a}}}function zz(){}`;
  const f = (s) => {
    const { index: _i, sha384: _s, ...r } = facts("", s);
    return r;
  };
  assert.deepEqual(f(src), { hold: true, limits: true, priced: 3, floor: true });
  const cut = (a, b) => {
    assert.equal(src.split(a).length, 2, a);
    return f(src.replace(a, () => b));
  };
  assert.equal(cut(":`below_min`}})()", ":`failed`}})()").hold, false, "a move under a floor refused with another code");
  assert.equal(cut("let n=await cK(e(),", "let n=await cZ(e(),").hold, false, "pool.move holds to another function");
  assert.equal(cut("`out`in n.result?i.from===`near`?e().move(i.to,i.usdc,r.id):", "i.from===`near`?e().move(i.to,i.usdc,r.id):`out`in n.result?").hold, false, "a move from Cash not held to it");
  assert.equal(cut("...n.min===void 0?{}:{min:i(n.min)},", "").limits, false, "the answer names no min");
  assert.equal(cut("if(d.floor===null)return{error:`down`};", "").floor, false, "a floor it cannot read is not down");
  assert.equal(cut("steps:c,max:i(l.max)}}}function", "steps:c}}}function").priced, 2, "the pool to pool answer names no max");
});

test("appOf(): each of the sheet's marks in the app's scripts, as minified", () => {
  const js = "{kind:`limits`,value:i};x={\"data-control\":`move-max`,\"data-max\":k??void 0};y={\"data-control\":`move-try`,\"data-amount\":e}";
  assert.deepEqual(appOf([js]), ["limits", "max", "tries"]);
  assert.deepEqual(appOf(["a", js]), ["limits", "max", "tries"], "in any of the page's scripts");
  assert.deepEqual(appOf([js.replace("`limits`", "`refused`")]), ["max", "tries"]);
  assert.deepEqual(appOf([js.replace("\"data-max\":", "disabled:")]), ["limits", "tries"]);
  assert.deepEqual(appOf([js.replace("`move-try`", "`move-go`")]), ["limits", "max"]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  const at = (p) => judge({ ...g, ...p }).lines;
  assert.deepEqual(at({ sha384: "sha384-other" }), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(at({ index: "<html></html>" }), ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(at({ limits: false }), [LIMITS]);
  assert.deepEqual(at({ priced: 2 }), [PRICED(2)]);
  assert.deepEqual(at({ priced: undefined }), [PRICED("no")]);
  assert.deepEqual(at({ floor: false }), [FLOOR]);
  assert.deepEqual(at({ hold: false }), [HOLD]);
  assert.deepEqual(at({ app: ["limits", "tries"] }), [APP("max")]);
  assert.deepEqual(at({ app: undefined }), [APP("limits, max, tries")]);
});
