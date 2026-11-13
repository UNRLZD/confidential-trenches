// node --test scripts/live-checks/app-lock-holds-until-the-layer-closes.test.mjs: the live check's verdict replays
// recorded runs (app-lock-holds-until-the-layer-closes.answers.json), each read on 13 Nov by
// app-lock-holds-until-the-layer-closes.mjs collect() --harness in headless Chrome, a terminal build at APP_HOST's name
// framed by the stand-in shell signed out and answering signin.open { pending: true, closes: true }, at 390 and 1440:
//   good: this card's build: one signin.open for two taps around the frame's blur, the way locked with no line through
//         another id's notice, unlocked with no line at its own: PASS;
//   bad:  main's build before this card: the blur lifted the lock, so the second tap sent a second signin.open: FAIL.
// Planted from the good run: two opens, the way unlocked or a line after the second tap, unlocked by another id's
// notice, still locked or slow after its own, a line after it, no closes in the answer, no blur, no sheet, a missing run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, UNLOCK_MS } from "./app-lock-holds-until-the-layer-closes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-lock-holds-until-the-layer-closes.answers.json"), "utf8"));
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

test("recorded good answer: both widths, one signin.open, held through the blur and another id's notice, unlocked at its own: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.runs.length, 2);
});

test("recorded bad answer: main's build before this card sends a second signin.open after the blur: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /signin\.open sent 2 time/.test(l)), r.lines.join("\n"));
});

test("planted: each broken fact fails by its own line", () => {
  fails(planted((r) => (r.runs[0].opens = 2)), /sent 2 time/);
  fails(planted((r) => (r.runs[1].locked = false)), /after the second tap the way unlocked/);
  fails(planted((r) => (r.runs[0].line = "refused")), /line refused, want still locked/);
  fails(planted((r) => (r.runs[1].otherHeld = false)), /another id's notice unlocked/);
  fails(planted((r) => ((r.runs[0].unlocked = false), (r.runs[0].unlockMs = null))), /stayed locked/);
  fails(planted((r) => (r.runs[1].unlockMs = UNLOCK_MS + 1)), /unlocked in \d+ ms/);
  fails(planted((r) => (r.runs[0].lineAfter = "silent")), /line silent, want unlocked/);
  fails(planted((r) => (r.runs[1].closes = false)), /with no closes/);
  fails(planted((r) => (r.runs[0].blurred = false)), /kept the focus/);
  fails(planted((r) => (r.runs[0].sheet = false)), /no sign-in sheet/);
  fails(planted((r) => r.runs.pop()), /run\(s\) of 2/);
  fails({ runs: [] }, /run\(s\) of 2/);
});
