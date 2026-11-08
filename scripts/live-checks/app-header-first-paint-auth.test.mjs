// node --test scripts/live-checks/app-header-first-paint-auth.test.mjs: the live check's verdict replays recorded answers
// (app-header-first-paint-auth.answers.json), each read on 2026-11-09 by app-header-first-paint-auth.mjs collect():
//   good: this card's terminal build (vite build, read from disk): its script holds the sign-in hint and its stylesheet
//         reserves the account box only under data-shape=in: PASS;
//   bad:  APP_HOST as deployed before this card, read over https: none of them: FAIL.
// Planted from the good answer: a script without the hint's key, a stylesheet without the phone's box, a stylesheet that
// reserves the box whatever the shape (the 51688cd9 rule), a stylesheet the host did not answer: each fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { alwaysReserved, assetsOf, CSS_MARKERS, JS_MARKERS, judge } from "./app-header-first-paint-auth.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-header-first-paint-auth.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the built page's hint and the box reserved only for in: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(new Set(ANSWERS.good.js.flatMap((f) => f.found)), new Set(JS_MARKERS));
  assert.deepEqual(new Set(ANSWERS.good.css.flatMap((f) => f.found)), new Set(CSS_MARKERS));
});

test("recorded bad answer: APP_HOST before this card holds no hint: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.ok(b.some((l) => l === `BAD the scripts lack the sign-in hint: ${JS_MARKERS.join(", ")}`), r.lines.join("\n"));
  assert.ok(b.some((l) => l.startsWith("BAD the stylesheets lack the box reserved only for in")), r.lines.join("\n"));
});

test("planted: no hint key, no phone box, the box reserved whatever the shape, a stylesheet not answered: each fails", () => {
  const js = mut((rec) => {
    for (const f of rec.js) f.found = f.found.filter((m) => m !== "ct-signin-hint");
  });
  assert.ok(bad(js.lines).some((l) => l === "BAD the scripts lack the sign-in hint: ct-signin-hint"), js.lines.join("\n"));
  const phone = mut((rec) => {
    for (const f of rec.css) f.found = f.found.filter((m) => !m.startsWith(".phh-acct"));
  });
  assert.equal(phone.ok, false);
  const always = mut((rec) => (rec.css[0].always = [".tb-acct{flex:none;justify-content:flex-end;min-width:264px;display:flex}"]));
  assert.ok(bad(always.lines).some((l) => l.startsWith("BAD the stylesheets reserve the box whatever the shape")), always.lines.join("\n"));
  assert.equal(mut((rec) => (rec.css[0].status = 404)).ok, false);
  assert.equal(mut((rec) => (rec.js = [])).ok, false);
});

test("alwaysReserved: a min-width on the bare box (as 51688cd9 built it) is found; one under data-shape=in is not", () => {
  assert.deepEqual(alwaysReserved(".tb-acct{flex:none;justify-content:flex-end;min-width:264px;display:flex}.phh-acct{flex:none;min-width:148px}"), [
    ".tb-acct{flex:none;justify-content:flex-end;min-width:264px;display:flex}",
    ".phh-acct{flex:none;min-width:148px}",
  ]);
  assert.deepEqual(alwaysReserved(".tb-acct,.phh-acct{flex:none;justify-content:flex-end;display:flex}.tb-acct[data-shape=in]{min-width:264px}.phh-acct[data-shape=in]{min-width:148px}"), []);
  assert.deepEqual(alwaysReserved(".x .tb-acct{min-width:1px}.tb-acct .y{min-width:2px}"), [".x .tb-acct{min-width:1px}"]);
});

test("the page's assets: its script and stylesheet tags", () => {
  const html = '<script type="module" crossorigin src="/assets/a.js" integrity="sha384-x"></script><link rel="stylesheet" crossorigin href="/assets/a.css">';
  assert.deepEqual(assetsOf(html), { js: ["/assets/a.js"], css: ["/assets/a.css"] });
});
