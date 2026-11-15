// node --test scripts/live-checks/app-trade-box-reads-after-a-buy.test.mjs: the live check's verdict replays recorded
// answers (app-trade-box-reads-after-a-buy.answers.json), each read on 2026-11-15 by its collect():
//   good: this card's terminal build (vite build, read from disk): its stylesheet holds both toast places: PASS;
//   bad:  APP_HOST as deployed before this card, read over https: its stylesheet holds neither: FAIL.
// Planted from the good answer: a stylesheet that lost the desktop place, one the host did not answer, no stylesheet.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, RULES, stylesOf } from "./app-trade-box-reads-after-a-buy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-trade-box-reads-after-a-buy.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the built page's stylesheet holds both toast places: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(new Set(ANSWERS.good.css.flatMap((f) => f.found)), new Set(RULES));
});

test("recorded bad answer: APP_HOST before this card holds neither: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r.lines), [`BAD the stylesheets lack the token page's toast places: ${RULES.join(" ")}`]);
});

test("planted: a stylesheet without the desktop place, one not answered, or none at all, fails", () => {
  const desk = mut((rec) => {
    for (const f of rec.css) f.found = f.found.filter((m) => !m.startsWith(".tkp-desk"));
  });
  assert.equal(desk.ok, false);
  assert.ok(bad(desk.lines).some((l) => l === `BAD the stylesheets lack the token page's toast places: ${RULES[0]}`), desk.lines.join("\n"));
  const miss = mut((rec) => {
    rec.css[0].status = 404;
  });
  assert.equal(miss.ok, false);
  const none = mut((rec) => {
    rec.css = [];
  });
  assert.equal(none.ok, false);
});

test("the page's stylesheets: each stylesheet link's href, nothing else", () => {
  const html = '<link rel="preload" href="/f.woff2" as="font"><script type="module" src="/assets/a.js"></script><link rel="stylesheet" crossorigin href="/assets/a.css">';
  assert.deepEqual(stylesOf(html), ["/assets/a.css"]);
});
