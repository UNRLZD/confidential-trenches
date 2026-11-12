// node --test scripts/live-checks/restore-notice-redraw.test.mjs: the live check's verdict replays recorded answers
// (restore-notice-redraw.answers.json), each read on 12 Nov 2026 by restore-notice-redraw.mjs collect():
//   good: this card's terminal build (vite build, read from disk): the dot mark, its sweep and its dotted tick, the
//         green tick, the amber stall, the sweep at rest under reduced motion, Retry drawn off, no bar: PASS;
//   bad:  APP_HOST as deployed before this card, read over https: the sliding bar, none of the rest: FAIL.
// Planted from the good answer: each mark or rule gone, the bar back, a file the host did not answer. The patterns are
// read on the minified and the source forms.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, marksOf, MUST, refsOf, RULES, rulesOf } from "./restore-notice-redraw.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "restore-notice-redraw.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const some = (r, re) => assert.ok(!r.ok && bad(r.lines).some((l) => re.test(l)), r.lines.join("\n"));

test("recorded good answer: this card's build draws direction A and Retry off: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: APP_HOST before this card draws the sliding bar and none of A: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  some(r, /the scripts lack .*rn-mark.*rn-arc.*rn-tick/);
  some(r, /still draw the sliding bar/);
  some(r, /Retry drawn off while money is off/);
  some(r, /still styles the sliding bar/);
});

test("planted: each mark or rule gone, the bar back, a file not answered, fail", () => {
  for (const k of Object.keys(MUST)) some(mut((rec) => { for (const f of rec.js) f.marks[k] = 0; }), /the scripts lack/);
  for (const k of Object.keys(RULES)) some(mut((rec) => { for (const f of rec.css) f.rules[k] = false; }), /no stylesheet holds/);
  some(mut((rec) => { rec.js[0].marks.bar = 1; }), /sliding bar \(rbar, 1\)/);
  some(mut((rec) => { rec.css[0].rules.barRule = true; }), /\.rbar/);
  some(mut((rec) => { rec.js[0].status = 404; }), /script\(s\) named by the page/);
  some(mut((rec) => { rec.css = []; }), /0 stylesheet\(s\)/);
  some(mut((rec) => { rec.pageStatus = 500; }), /the page answers 500/);
});

test("the patterns: the minified and the source forms", () => {
  assert.deepEqual(marksOf("k(`span`,{className:`rn-mark ${e}`,children:[k(`g`,{className:`rn-arc`}),k(`g`,{className:`rn-tick`})]})"), { mark: 1, arc: 1, tick: 1, bar: 0 });
  assert.equal(marksOf('className={`rn-mark ${kind}`} <g className="rn-tick">').tick, 1);
  assert.equal(marksOf("className:`rn-marker`").mark, 0, "another class that starts the same is not the mark");
  assert.equal(marksOf('{className:"rbar","aria-hidden":"true"}').bar, 1);
  const min = ".rn-tick circle{fill:var(--acc)}.rn-mark.off .rn-base circle{fill:var(--warn);fill-opacity:.28}@keyframes rn-comet{0%{opacity:1}to{opacity:0}}@media (prefers-reduced-motion:reduce){.rn-arc circle,.sk{animation:none}}.rline .retry:disabled{color:var(--text-3)}";
  assert.deepEqual(rulesOf(min), { tickGreen: true, offAmber: true, sweep: true, restsReduced: true, retryOff: true, barRule: false });
  assert.equal(rulesOf("/* .rline .retry:disabled{color:var(--text-3)} */").retryOff, false, "a comment is not a rule");
  assert.equal(rulesOf("@media (prefers-reduced-motion:reduce){.sk{animation:none}}.rn-arc circle{animation:none}").restsReduced, false, "outside the media query is not the reduced-motion rule");
  assert.equal(rulesOf(".rbar i{display:block}").barRule, true);
  assert.equal(rulesOf(".rbarometer{}").barRule, false);
  assert.deepEqual(refsOf('<script type="module" crossorigin src="/assets/a.js"></script><link rel="stylesheet" crossorigin href="/assets/a.css">'), { js: ["/assets/a.js"], css: ["/assets/a.css"] });
});
