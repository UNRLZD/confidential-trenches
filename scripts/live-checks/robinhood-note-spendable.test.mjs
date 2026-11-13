// node --test scripts/live-checks/robinhood-note-spendable.test.mjs: the live check replays its recorded answers
// (robinhood-note-spendable.answers.json). good: this card's mainnet build, the proving lock named and asked both ways,
// the queues lock named: PASS. bad: SIGN_HOST before this card, no proving lock: FAIL. bad_tap: the build of this card's
// first commit d638031c, no queues lock (a tap in a tab without the front refused): FAIL. Planted on the good one:
// another /app.js, no pin, no lock, a lock asked one way only, no queues lock, facts not read: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LOCK, QUEUES, facts, judge } from "./robinhood-note-spendable.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./robinhood-note-spendable.answers.json", import.meta.url), "utf8"));
const NO_LOCK = `BAD the bundle names no ${LOCK} lock: every tab runs its own proof queue, and a note another tab proved is never spendable in the tab in use`;
const NO_QUEUES = `BAD the bundle names no ${QUEUES} lock: a buy tapped in a tab without the front is refused, and a window switch mid-buy refuses it`;

test("recorded good answer: this card's build names the proving lock, asks it with steal and ifAvailable, and names the queues lock: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST before this card, no proving lock: FAIL, that fact named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_LOCK]);
});

test("recorded bad_tap answer: this card's first build d638031c, the proving lock with no queues lock: FAIL, that fact named", () => {
  const v = judge(ANSWERS.bad_tap);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_QUEUES]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.ok(judge({ ...g, sha384: "sha384-other" }).lines.includes("BAD SIGN_HOST's served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD SIGN_HOST's index.html pins no /app.js"));
  assert.deepEqual(judge({ ...g, lock: false }).lines, [NO_LOCK]);
  for (const k of ["steal", "ifAvailable"]) assert.equal(judge({ ...g, [k]: false }).ok, false, `asked without ${k}`);
  assert.deepEqual(judge({ ...g, queues: false }).lines, [NO_QUEUES]);
  for (const k of ["lock", "steal", "ifAvailable", "queues"]) assert.equal(judge({ ...g, [k]: undefined }).ok, false, `${k} not read`);
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle: the lock's name in any quote the minifier writes, and both ways of asking", () => {
  for (const q of ['"', "'", "`"]) assert.equal(facts("", `var a=${q}${LOCK}${q};`).lock, true);
  assert.equal(facts("", `var a="${LOCK}-other";`).lock, false);
  for (const q of ['"', "'", "`"]) assert.equal(facts("", `var a=${q}${QUEUES}${q};`).queues, true);
  assert.equal(facts("", `var a="${QUEUES}-other";`).queues, false);
  const f = facts("", "l.request(a,{steal:!0},c);l.request(a,{ifAvailable:!0},c)");
  assert.deepEqual([f.steal, f.ifAvailable], [true, true]);
});
