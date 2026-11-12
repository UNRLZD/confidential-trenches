// node --test scripts/live-checks/signing-views-open-over-the-app.test.mjs: the live check's verdict replays recorded
// answers (signing-views-open-over-the-app.answers.json), each read on 2026-11-11 by the check's collect():
//   good: this card's checkout (--local): the signing page's fresh build holds every one of the sheet's markers, and its
//         _headers deny picture-in-picture and fullscreen: PASS (read again 12 Nov with backup in the set);
//   bad:  SIGN_HOST as deployed before this card (release 116), read over https: its screens draw as a page of their
//         own, and its script holds none of the markers: FAIL.
//   beforeWatch: SIGN_HOST as deployed on 12 Nov (read over https), whose one set still takes the frame out under the
//         withdraw forms (the black page behind them): neither the typed set nor the withdraw forms' set: FAIL.
// good was read again 12 Nov from this checkout with the two sets (src/frame-cover.ts).
// Planted from the good answer: a marker lost, a script the host did not answer, a page naming no script, a page that did
// not answer. The markers themselves run over this checkout's build and over minified snippets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { found, judge, MARKERS } from "./signing-views-open-over-the-app.mjs";
import { signBuilt } from "../signpage-built.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signing-views-open-over-the-app.answers.json"), "utf8"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the sheet's markers all in the script: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(new Set(ANSWERS.good.js.flatMap((f) => f.found)), new Set(MARKERS));
});

test("recorded bad answer: release 116 draws its screens as a page of their own: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l === `BAD sign: the script lacks ${MARKERS.length} of ${MARKERS.length}: ${MARKERS.join(", ")}`), r.lines.join("\n"));
});

test("recorded beforeWatch answer: the withdraw forms still among the typed screens: FAIL", () => {
  const r = judge(ANSWERS.beforeWatch);
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("BAD sign: the script lacks 2 of " + MARKERS.length + ": typed screens set, withdraw forms set"), r.lines.join("\n"));
});

test("planted: a marker lost, a script not answered, no script, no page: each FAIL", () => {
  assert.equal(mut((r) => (r.js[0].found = r.js[0].found.filter((m) => m !== "typed screens set"))).ok, false);
  assert.equal(mut((r) => (r.js[0].found = r.js[0].found.filter((m) => m !== "withdraw forms set"))).ok, false);
  assert.equal(mut((r) => (r.js[0].status = 404)).ok, false);
  assert.equal(mut((r) => (r.js = [])).ok, false);
  assert.equal(mut((r) => (r.pageStatus = 503)).ok, false);
  // the policy: picture-in-picture or fullscreen not denied, or no header at all
  assert.equal(mut((r) => (r.permissions = r.permissions.replace("picture-in-picture=(), ", ""))).ok, false);
  assert.equal(mut((r) => (r.permissions = r.permissions.replace("fullscreen=(), ", ""))).ok, false);
  assert.equal(mut((r) => (r.permissions = r.permissions.replace("picture-in-picture=()", "picture-in-picture=(*)"))).ok, false);
  assert.equal(mut((r) => (r.permissions = null)).ok, false);
});

test("the markers on this checkout's build, and on minified snippets", () => {
  const dir = signBuilt();
  assert.deepEqual(found(readFileSync(path.join(dir, "public/app.js"), "utf8")), MARKERS);
  assert.ok(found('e.dataset.sheet="scrim";const T=new Set(["words","invalid-code","held","backup"])').includes("typed screens set"));
  assert.ok(!found('new Set(["words","invalid-code","held"])').includes("typed screens set"), "the set without the 12 words shown (backup)");
  assert.ok(!found('new Set(["words","withdraw"])').includes("typed screens set"), "a set missing a typed screen");
  // the withdraw forms: exactly the two; one more screen kept under the sheet (the 12 words, held) fails
  assert.ok(found('const W=new Set(["withdraw","pool-withdraw"])').includes("withdraw forms set"));
  assert.ok(!found('new Set(["withdraw","pool-withdraw","words"])').includes("withdraw forms set"), "a typed screen among the watched");
  assert.ok(!found('new Set(["withdraw","pool-withdraw","held"])').includes("withdraw forms set"), "held among the watched");
  assert.ok(!found('new Set(["withdraw"])').includes("withdraw forms set"), "a withdraw form missing");
  // the one set as deployed on 12 Nov, the withdraw forms still among the typed: neither set is held
  const before = found('new Set(["words","invalid-code","withdraw","pool-withdraw","held","backup"])');
  assert.ok(!before.includes("typed screens set") && !before.includes("withdraw forms set"));
  assert.deepEqual(found("nothing here"), []);
});
