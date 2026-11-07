// node --test scripts/live-checks/app-quick-buy-one-tap.test.mjs: the live check's verdict replays recorded answers
// (app-quick-buy-one-tap.answers.json), each read on 2026-11-07 by app-quick-buy-one-tap.mjs collect():
//   good: this card's terminal build (vite build, read from disk): the page's script holds the page's toast, its line, its
//         Retry and the fill toast, its stylesheet the Retry's rule and the chip's off state: PASS;
//   bad:  APP_HOST as deployed before this card, read over https: its script holds only the fill toast, its stylesheet
//         none of the rules: FAIL.
// Planted from the good answer: a script that lost the toast's Retry, a stylesheet that lost the chip's off state, a
// stylesheet the host did not answer, no script at all.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assetsOf, CSS_MARKERS, JS_MARKERS, judge } from "./app-quick-buy-one-tap.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-quick-buy-one-tap.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the built page's script and stylesheet hold the quick buy: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(new Set(ANSWERS.good.js.flatMap((f) => f.found)), new Set(JS_MARKERS));
  assert.deepEqual(new Set(ANSWERS.good.css.flatMap((f) => f.found)), new Set(CSS_MARKERS));
});

test("recorded bad answer: APP_HOST before this card holds none of the quick buy: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.ok(b.some((l) => /the scripts lack the quick buy: quick-toast, quick-toast-line, quick-retry$/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /the stylesheets lack the quick buy's rules: \.qt-retry, \.tkp-chip:disabled$/.test(l)), r.lines.join("\n"));
});

test("planted: a script without the toast's Retry, or a stylesheet without the chip's off state, fails", () => {
  const js = mut((rec) => {
    for (const f of rec.js) f.found = f.found.filter((m) => m !== "quick-retry");
  });
  assert.equal(js.ok, false);
  assert.ok(bad(js.lines).some((l) => /the scripts lack the quick buy: quick-retry$/.test(l)), js.lines.join("\n"));
  const css = mut((rec) => {
    for (const f of rec.css) f.found = f.found.filter((m) => m !== ".tkp-chip:disabled");
  });
  assert.equal(css.ok, false);
  assert.ok(bad(css.lines).some((l) => /the stylesheets lack the quick buy's rules: \.tkp-chip:disabled$/.test(l)), css.lines.join("\n"));
});

test("planted: a file the host did not answer, or a page naming no script, fails", () => {
  const miss = mut((rec) => {
    rec.css[0].status = 404;
  });
  assert.equal(miss.ok, false);
  assert.ok(bad(miss.lines).some((l) => /stylesheet\(s\) named by the page, each answering 200/.test(l)), miss.lines.join("\n"));
  const none = mut((rec) => {
    rec.js = [];
  });
  assert.equal(none.ok, false);
});

test("the page's assets: its script and stylesheet tags", () => {
  const html = '<link rel="preload" href="/f.woff2" as="font"><script type="module" crossorigin src="/assets/a.js" integrity="sha384-x"></script><link rel="stylesheet" crossorigin href="/assets/a.css">';
  assert.deepEqual(assetsOf(html), { js: ["/assets/a.js"], css: ["/assets/a.css"] });
});
