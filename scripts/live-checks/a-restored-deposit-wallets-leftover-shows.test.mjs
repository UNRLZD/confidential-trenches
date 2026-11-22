// node --test scripts/live-checks/a-restored-deposit-wallets-leftover-shows.test.mjs: the live check replays recorded
// answers (a-restored-deposit-wallets-leftover-shows.answers.json). bad: SIGN_HOST as read before this card, its
// /app.js writing no op for a restored U_X: FAIL, the marker named. good: this card's build, as SIGN_HOST serves it once
// deployed: PASS. Planted on the good one: a served /app.js that is not the pinned one, the marker gone, no pin: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MARKERS, judge } from "./a-restored-deposit-wallets-leftover-shows.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./a-restored-deposit-wallets-leftover-shows.answers.json", import.meta.url), "utf8"));

test("recorded bad answer: SIGN_HOST before this card, no op for a restored U_X: FAIL", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, MARKERS.map((m) => `BAD the served /app.js writes no op for a restored U_X (${JSON.stringify(m)})`));
});

test("recorded good answer: the pinned /app.js writes a restored U_X's op: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("planted: a served /app.js that is not the pinned one, the marker gone, or no pin: FAIL", () => {
  const g = ANSWERS.good;
  assert.ok(judge({ ...g, app: { ...g.app, sha384: "sha384-other" } }).lines.includes("BAD the served /app.js is not the one index.html pins"));
  assert.equal(judge({ ...g, app: { ...g.app, markers: [] } }).ok, false);
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD index.html pins no /app.js"));
});
