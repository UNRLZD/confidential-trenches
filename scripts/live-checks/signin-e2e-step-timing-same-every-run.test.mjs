// node --test scripts/live-checks/signin-e2e-step-timing-same-every-run.test.mjs: the live check's verdict replays
// recorded runs (signin-e2e-step-timing-same-every-run.answers.json), each read by collect() in Chrome at 390 and 1440:
//   good: this card's SIGN_HOST build in the app's harness (--harness): the ground over the frame, under the dim, fading
//         as it does: PASS;
//   bad:  the deployed SIGN_HOST on 22 Nov, before this card: the ground under the frame (no stack level), no fade: FAIL.
// Planted from the good run: a width missing, the ground after the dim, a ground with no fade, the frame missing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./signin-e2e-step-timing-same-every-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signin-e2e-step-timing-same-every-run.answers.json"), "utf8"));
const fails = (rec, re) => {
  const r = judge(rec);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};
const planted = (edit) => {
  const rec = structuredClone(ANSWERS.good);
  edit(rec);
  return rec;
};

test("recorded good answer: at both widths the ground stacks over the frame and under the dim, and fades as it does: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.runs.length, 2);
});

test("recorded bad answer: the deployed shell before this card keeps the ground under the frame: FAIL", () => {
  fails(ANSWERS.bad, /the ground stacks over the APP_HOST frame/);
  fails(ANSWERS.bad, /the ground fades as the dim does/);
});

test("planted: a width not read, the ground after the dim, no fade, the frame missing: each FAIL", () => {
  fails(planted((r) => r.runs.pop()), /read at 390 and 1440/);
  fails(planted((r) => (r.runs[0].ground.index = r.runs[0].veil.index + 1)), /the dim stacks over the ground/);
  fails(planted((r) => (r.runs[1].ground.transition = "all")), /the ground fades as the dim does/);
  fails(planted((r) => delete r.runs[0].frame), /frame missing/);
});
