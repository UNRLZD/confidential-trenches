// node --test scripts/live-checks/app-toast-clears-sheet-head.test.mjs: the live check's verdict replays recorded answers
// (app-toast-clears-sheet-head.answers.json), each read on 2026-11-08 by app-toast-clears-sheet-head.mjs collect():
//   good: this card's terminal build (vite build, read from disk): its stylesheet moves the toast to top 8 px while the
//         sheet is open, the box's toast in the sheet and the page's beside it: PASS;
//   bad:  APP_HOST as deployed before this card, read over https: no rule moves it (the toast stays at 68 px, over the
//         sheet's head row): FAIL.
// Planted from the good answer: the rule with one of its two selectors, the toast lower than 8 px, a stylesheet the host
// did not answer. The parser is read on the minified and the source forms of the rule.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, MAX_TOP, ruleOf, stylesOf } from "./app-toast-clears-sheet-head.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-toast-clears-sheet-head.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the built stylesheet moves the open sheet's toast to the top: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(ANSWERS.good.css.some((f) => f.rule && f.rule.top <= MAX_TOP));
});

test("recorded bad answer: APP_HOST before this card has no such rule: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => /no stylesheet moves the toast while the sheet is open/.test(l)), r.lines.join("\n"));
});

test("planted: the toast left lower than 8 px, or a stylesheet the host did not answer, fails", () => {
  const low = mut((rec) => {
    for (const f of rec.css) if (f.rule) f.rule.top = 68;
  });
  assert.equal(low.ok, false);
  assert.ok(bad(low.lines).some((l) => /at top 68 px, at most 8/.test(l)), low.lines.join("\n"));
  const unset = mut((rec) => {
    for (const f of rec.css) if (f.rule) f.rule.top = null;
  });
  assert.equal(unset.ok, false);
  const miss = mut((rec) => {
    rec.css[0].status = 404;
  });
  assert.equal(miss.ok, false);
});

test("the parser: the minified and the source rule, and a rule with only one of the two selectors", () => {
  assert.deepEqual(ruleOf(".a{top:1px}.tsh[data-open=true] .rs-toast,.tsh[data-open=true]~.rs-toast{top:8px}")?.top, 8);
  assert.deepEqual(ruleOf('/* x */\n.tsh[data-open="true"] .rs-toast, .tsh[data-open="true"] ~ .rs-toast { top: 8px; }')?.top, 8);
  assert.equal(ruleOf(".tsh[data-open=true] .rs-toast{top:8px}"), null);
  assert.equal(ruleOf(".tsh[data-open=true]~.rs-toast{top:8px}"), null);
  assert.equal(ruleOf(".tsh[data-open=true] .rs-toast,.tsh[data-open=true]~.rs-toast{left:0}")?.top, null);
  assert.deepEqual(stylesOf('<link rel="preload" href="/f.woff2" as="font"><link rel="stylesheet" crossorigin href="/assets/a.css">'), ["/assets/a.css"]);
});
