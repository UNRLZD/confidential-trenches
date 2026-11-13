// node --test scripts/live-checks/signed-out-portfolio-and-account-say-what-appears.test.mjs: the live check's verdict
// replays recorded runs (signed-out-portfolio-and-account-say-what-appears.answers.json), each read on 13 Nov by the
// check's collect() in headless Chromium, signed out, at 390 and 1440:
//   good: this card's build served at APP_HOST's name inside the stand-in shell (--harness --build): Portfolio and
//         Account each draw their line above Sign in, and nothing else: PASS;
//   bad:  the deployed APP_HOST before this card: Portfolio and Account draw Sign in alone, no line: FAIL.
// Planted from the good run: a changed word, the line under Sign in, the line off screen, another word in the block, a
// signed-in header, no block, a missing page or width, the shell not around the app.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, LINES } from "./signed-out-portfolio-and-account-say-what-appears.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signed-out-portfolio-and-account-say-what-appears.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const page = (rec, w, p) => rec.runs.find((r) => r.width === w).pages.find((x) => x.path === p);
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: Portfolio and Account each say what appears, above Sign in, at 390 and 1440: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const w of ["phone", "desktop"]) for (const p of Object.keys(LINES)) assert.equal(page(ANSWERS.good, w, p).line, LINES[p], `${w} ${p}`);
});

test("recorded bad answer: the deployed app before this card draws Sign in alone: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  for (const w of ["phone", "desktop"]) for (const p of Object.keys(LINES)) assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w} ${p}: no line`)), `${w} ${p}\n${r.lines.join("\n")}`);
});

test("planted: a changed word fails", () => {
  fails(mut((rec) => (page(rec, "phone", "/portfolio").line = "Your equity and positions appear here after you sign in.")), /^BAD phone \/portfolio: the line is "Your equity and positions/);
  fails(mut((rec) => (page(rec, "desktop", "/profile").line = "Your account appears here once you sign in.")), /^BAD desktop \/profile: the line is/);
});

test("planted: the line under Sign in, or off screen, fails", () => {
  fails(mut((rec) => (page(rec, "phone", "/profile").lineAbove = false)), /^BAD phone \/profile: the line is not above Sign in/);
  fails(mut((rec) => (page(rec, "desktop", "/portfolio").lineVisible = false)), /^BAD desktop \/portfolio: the line is not on screen/);
});

test("planted: another word in the block, or a button that is not Sign in, fails", () => {
  fails(mut((rec) => (page(rec, "phone", "/portfolio").text += "Learn more")), /^BAD phone \/portfolio: the block says .*more than the line and Sign in/);
  fails(mut((rec) => (page(rec, "desktop", "/portfolio").button = "Connect")), /^BAD desktop \/portfolio: its button says "Connect", not "Sign in"/);
});

test("planted: a signed-in header, no block, a missing page or width, or the shell not around the app fails", () => {
  fails(mut((rec) => (page(rec, "phone", "/portfolio").header = "S1.4")), /^BAD phone \/portfolio: the header is S1.4/);
  fails(mut((rec) => (page(rec, "desktop", "/profile").block = false)), /^BAD desktop \/profile: no signed-out block/);
  fails(mut((rec) => (rec.runs[0].pages = rec.runs[0].pages.filter((x) => x.path !== "/profile"))), /^BAD phone \/profile: not read/);
  fails(mut((rec) => rec.runs.pop()), /^BAD 1 run\(s\) of 2/);
  fails(mut((rec) => (rec.runs[1].framed = false)), /^BAD desktop: not inside SIGN_HOST's shell/);
});
