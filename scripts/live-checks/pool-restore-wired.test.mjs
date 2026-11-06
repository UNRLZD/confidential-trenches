// node --test scripts/live-checks/pool-restore-wired.test.mjs: the live check's verdict replays recorded runs
// (pool-restore-wired.answers.json), each read on 6 Nov by pool-restore-wired.mjs collect():
//   good: --local, this card's signing page build served as SIGN_HOST under its own _headers: signed out restore is
//         refused, the published vector's words sign in, the run with no tap ends done, and restore is answered started
//         with progress reading then done: PASS;
//   bad:  live SIGN_HOST on release-53, before this card: restore refused not_allowed signed in too, and no run with
//         no tap: FAIL.
// Planted from the good run: a run that stalls, one that never ends, a second run with no tap, an answer that is not
// started, a restore answered while signed out.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./pool-restore-wired.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "pool-restore-wired.answers.json"), "utf8"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: this card's build answers restore and runs it once after the words: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: live SIGN_HOST before this card refuses restore and runs none: FAIL", () => {
  const r = judge(ANSWERS.bad);
  fails(r, /ran one restore with no tap/);
  fails(r, /answered started/);
});

test("planted: a stalled or endless run, a second run with no tap, another answer, a signed-out run: FAIL", () => {
  fails(mut((rec) => (rec.steps.asked.stages = ["reading", "stalled"])), /never stalled/);
  fails(mut((rec) => (rec.steps.asked.stages = ["reading"])), /ends done/);
  fails(mut((rec) => (rec.steps.auto.state.ops[0].stage = "reading")), /ended done/);
  fails(mut((rec) => rec.steps.auto.state.ops.push({ ...rec.steps.auto.state.ops[0], id: "x" })), /ran one restore/);
  fails(mut((rec) => (rec.steps.asked.answer = { v: 1, id: rec.steps.asked.answer.id, ok: false, error: { code: "not_allowed" } })), /answered started/);
  fails(mut((rec) => (rec.steps.signedOut.answer = { v: 1, id: "x", ok: true, result: { stage: "started" } })), /signed out/);
  fails(mut((rec) => (rec.steps.signedIn = null)), /sign SIGN_HOST in/);
  fails(mut((rec) => rec.errors.push("no words field")), /no error/);
});
