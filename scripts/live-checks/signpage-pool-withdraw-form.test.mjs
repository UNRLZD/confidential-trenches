// node --test scripts/live-checks/signpage-pool-withdraw-form.test.mjs: the live check replays recorded answers
// (signpage-pool-withdraw-form.answers.json). bad: a real devnet pool buy read in the withdraw's place: FAIL, a table
// and no transfer named. none: no run recorded yet: FAIL. Planted on the bad one's SIGN_HOST read: a served /app.js
// that is not the pinned one: FAIL. The good answer is recorded from the devnet withdraw run (the run record).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge } from "./signpage-pool-withdraw-form.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./signpage-pool-withdraw-form.answers.json", import.meta.url), "utf8"));

test("recorded bad answer: a devnet pool buy in the withdraw's place: FAIL, its table and its instructions named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.ok(v.lines.some((l) => l.endsWith("loads a lookup table")), v.lines.join("\n"));
  assert.ok(v.lines.some((l) => l.endsWith("not one release and one transfer after the compute budget")), v.lines.join("\n"));
  assert.ok(!v.lines.some((l) => l.includes("SIGN_HOST")), "SIGN_HOST serves its pinned /app.js");
});

test("recorded answer with no run: FAIL until the withdraw lands", () => {
  assert.deepEqual(judge(ANSWERS.none).lines, ["BAD no run of the withdraw recorded"]);
});

test("planted: SIGN_HOST serving another /app.js, or no pin at all: FAIL", () => {
  const b = ANSWERS.bad;
  assert.ok(judge({ ...b, sign: { ...b.sign, sha384: "sha384-other" } }).lines.includes("BAD SIGN_HOST's served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...b, sign: { ...b.sign, index: "<html></html>" } }).lines.includes("BAD SIGN_HOST's index.html pins no /app.js"));
});
