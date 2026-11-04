// node --test scripts/live-checks/app-buy-route-strip.test.mjs: the live check's verdict replays recorded answers
// (app-buy-route-strip.answers.json), each read on 2026-11-04 by app-buy-route-strip.mjs collect():
//   good: this card's terminal build (vite build, read from disk): the page's script holds the strip's four steps, the strip,
//         the fill toast and the spec's words, its stylesheet the strip's rules: PASS;
//   bad:  APP_HOST as deployed before this card, read over https: its script and stylesheet hold none of it: FAIL.
// Planted from the good answer: a script that lost one step, a stylesheet that lost the wallet step's growth, a stylesheet
// the host did not answer, no script at all.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assetsOf, CSS_MARKERS, JS_MARKERS, judge } from "./app-buy-route-strip.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-buy-route-strip.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the built page's script and stylesheet hold the strip: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(new Set(ANSWERS.good.js.flatMap((f) => f.found)), new Set(JS_MARKERS));
  assert.deepEqual(new Set(ANSWERS.good.css.flatMap((f) => f.found)), new Set(CSS_MARKERS));
});

test("recorded bad answer: APP_HOST before this card holds none of the strip: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.ok(b.some((l) => /the scripts lack the strip: route-strip, route-balance, route-wallet, route-pool, route-token, data-steps, fill-toast, New one-time wallet/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /the stylesheets lack the strip's rules: \.rs-grp, \.rs-ld, rs-glow, rs-pop/.test(l)), r.lines.join("\n"));
});

test("planted: a script without one step, or a stylesheet without the wallet step's growth, fails", () => {
  const js = mut((rec) => {
    rec.js[0].found = rec.js[0].found.filter((m) => m !== "route-pool");
  });
  assert.equal(js.ok, false);
  assert.ok(bad(js.lines).some((l) => /the scripts lack the strip: route-pool$/.test(l)), js.lines.join("\n"));
  const css = mut((rec) => {
    rec.css[0].found = rec.css[0].found.filter((m) => m !== ".rs-grp");
  });
  assert.equal(css.ok, false);
  assert.ok(bad(css.lines).some((l) => /the stylesheets lack the strip's rules: \.rs-grp$/.test(l)), css.lines.join("\n"));
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
