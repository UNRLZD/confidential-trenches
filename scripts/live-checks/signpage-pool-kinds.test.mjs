// node --test scripts/live-checks/signpage-pool-kinds.test.mjs: the live check replays recorded answers
// (signpage-pool-kinds.answers.json). bad: SIGN_HOST as read before this card, no pool rule in its /app.js: FAIL, each
// missing marker named. good: this card's build, as SIGN_HOST serves it once deployed: PASS. Planted on the good one:
// a served /app.js that is not the pinned one, and one marker gone: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MARKERS, judge } from "./signpage-pool-kinds.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./signpage-pool-kinds.answers.json", import.meta.url), "utf8"));

test("recorded bad answer: SIGN_HOST before this card, with no pool rule: FAIL", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, MARKERS.map((m) => `BAD the served /app.js holds no pool rule (${JSON.stringify(m)})`));
});

test("recorded good answer: the pinned /app.js with the pool rule and the decimals read: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("planted: a served /app.js that is not the pinned one, or one marker gone: FAIL", () => {
  const g = ANSWERS.good;
  assert.ok(judge({ ...g, app: { ...g.app, sha384: "sha384-other" } }).lines.includes("BAD the served /app.js is not the one index.html pins"));
  assert.equal(judge({ ...g, app: { ...g.app, markers: MARKERS.slice(1) } }).ok, false);
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD index.html pins no /app.js"));
});
