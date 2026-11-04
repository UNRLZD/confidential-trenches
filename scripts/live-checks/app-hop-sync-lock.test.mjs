// node --test scripts/live-checks/app-hop-sync-lock.test.mjs: the live check's verdict replays recorded runs
// (app-hop-sync-lock.answers.json), each read on 4 Nov by app-hop-sync-lock.mjs collect() in headless Chrome, APP_HOST
// framed by the stand-in shell signed out and answering signin.open { pending: true }, at 390 and 1440:
//   good: this card's build at APP_HOST's name (--harness --build): one signin.open for two taps, the way still locked,
//         no line: PASS;
//   bad:  the deployed APP_HOST on 4 Nov, before this card: the second tap, after the shell's answer, sent a second
//         signin.open and the way was unlocked: FAIL.
// Planted from the good run: two opens, the way unlocked, a line under it, no answer before the second tap, no sheet,
// a missing run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./app-hop-sync-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-hop-sync-lock.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const fails = (rec, re) => {
  const r = judge(rec);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};
const planted = (edit) => {
  const rec = structuredClone(ANSWERS.good);
  edit(rec);
  return rec;
};

test("recorded good answer: both widths, one signin.open for two taps, the way held with no line: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.runs.length, 2);
});

test("recorded bad answer: the deployed app before this card sends a second signin.open after the answer: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /signin\.open sent 2 time/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /unlocked/.test(l)), r.lines.join("\n"));
});

test("planted: two opens, the way unlocked, a line, no answer first, no sheet, a missing run fail", () => {
  fails(planted((r) => (r.runs[0].opens = 2)), /sent 2 time/);
  fails(planted((r) => (r.runs[1].locked = false)), /unlocked/);
  fails(planted((r) => (r.runs[0].line = "silent")), /line silent/);
  fails(planted((r) => (r.runs[1].answered = false)), /no answer before/);
  fails(planted((r) => (r.runs[0].sheet = false)), /no sign-in sheet/);
  fails(planted((r) => r.runs.pop()), /run\(s\) of 2/);
  fails({ runs: [] }, /run\(s\) of 2/);
});
