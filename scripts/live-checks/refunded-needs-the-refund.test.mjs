// node --test scripts/live-checks/refunded-needs-the-refund.test.mjs: the live check replays recorded answers
// (refunded-needs-the-refund.answers.json). bad: SIGN_HOST as deployed before this card, no refund floor in its
// /app.js: FAIL, each missing marker named. good: this card's build, as SIGN_HOST serves it once deployed: PASS. Planted
// on the good one: a served /app.js that is not the pinned one, no pinned /app.js, and each marker gone: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MARKERS, judge } from "./refunded-needs-the-refund.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./refunded-needs-the-refund.answers.json", import.meta.url), "utf8"));

test("recorded bad answer: SIGN_HOST before this card, with no refund floor: FAIL", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, MARKERS.map((m) => `BAD the served /app.js holds no refund floor (${JSON.stringify(m)})`));
});

test("recorded good answer: the pinned /app.js with the refund floor: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("planted: a served /app.js that is not the pinned one, no pin, or any one marker gone: FAIL", () => {
  const g = ANSWERS.good;
  assert.ok(judge({ ...g, app: { ...g.app, sha384: "sha384-other" } }).lines.includes("BAD the served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD index.html pins no /app.js"));
  for (const m of MARKERS) assert.equal(judge({ ...g, app: { ...g.app, markers: MARKERS.filter((x) => x !== m) } }).ok, false, m);
});
