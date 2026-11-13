// node --test scripts/live-checks/screens-never-say-proof.test.mjs: the live check's verdict replays recorded runs
// (screens-never-say-proof.answers.json), each read by screens-never-say-proof.mjs collect() in headless Chromium, the
// stand-in shell signed in with a Solana pool still being made spendable, at 390 and 1440:
//   good: this card's build at APP_HOST's name in the stand-in shell (--harness): the trade box names no proof, shows
//         the pool's balance, no Max and Buy busy; Portfolio's pools one Balance column; the deposit sheet and the
//         scripts hold no removed word: PASS;
//   bad:  main's build before the card (4c1826a75) in the same shell: the box's "Making proof", Portfolio's Ready and
//         Pending columns, the scripts' four removed words: FAIL.
// Planted from the good run: a proof mark, Max $0 above Buy, Buy not busy, a Ready column, a removed word in a script.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./screens-never-say-proof.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "screens-never-say-proof.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: no screen names a proof, the balance shows and Buy is busy while nothing is spendable yet: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: main's build says Making proof, draws Ready and Pending and holds the words: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  for (const w of ["phone", "desktop"]) {
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w}: the trade box holds 1 proof mark(s)`)), `${w}\n${r.lines.join("\n")}`);
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w}: the line above Buy "Making proof"`)), `${w}\n${r.lines.join("\n")}`);
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w}: Buy {"kind":"trade"`)), `${w}\n${r.lines.join("\n")}`);
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w}: Portfolio's pools head ["Balance","Ready","Pending"]`)), `${w}\n${r.lines.join("\n")}`);
  }
  assert.ok(bad(r).some((l) => /^BAD the app's scripts: \d+ read, holding .*"Making proof"/.test(l)), r.lines.join("\n"));
});

test("planted: a proof mark in the box fails", () => fails(mut((rec) => (rec.runs[0].box.marks = 1)), /proof mark/));
test("planted: a word of proof in the box fails", () => fails(mut((rec) => (rec.runs[1].box.text += " Proof ready")), /the trade box says/));
test("planted: Max $0, or a word of proof, above Buy fails", () => {
  fails(mut((rec) => (rec.runs[0].box.max = "Max $0")), /want no Max/);
  fails(mut((rec) => (rec.runs[1].box.max = "Making proof")), /want no Max and no word/);
});
test("planted: Buy not busy fails", () => fails(mut((rec) => (rec.runs[1].box.cta = { ...rec.runs[1].box.cta, kind: "trade", busy: null })), /busy look/));
test("planted: the balance as $0 or a dash fails", () => {
  fails(mut((rec) => (rec.runs[0].box.balance = "$0 available")), /pool's balance shows/);
  fails(mut((rec) => (rec.runs[0].box.balance = "— available")), /pool's balance shows/);
});
test("planted: a Ready column on Portfolio fails", () => fails(mut((rec) => (rec.runs[0].pools.heads = ["Balance", "Ready"])), /Portfolio's pools/));
test("planted: Pending on the deposit sheet fails", () => fails(mut((rec) => (rec.runs[1].deposit += " Pending 0.1 SOL")), /deposit sheet says/));
test("planted: a removed word in a script, or no script read, fails", () => {
  fails(mut((rec) => (rec.scripts.found = ['"Pending" in /assets/index.js'])), /the app's scripts/);
  fails(mut((rec) => (rec.scripts.read = 0)), /the app's scripts: 0 read/);
});
test("planted: a run missing or not framed fails", () => {
  fails(mut((rec) => rec.runs.pop()), /run\(s\) of 2/);
  fails(mut((rec) => (rec.runs[0].framed = false)), /not inside SIGN_HOST's shell/);
});
