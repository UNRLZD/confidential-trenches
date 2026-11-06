// node --test scripts/live-checks/kit-deposit-calls.test.mjs: the live check replays its recorded answers
// (kit-deposit-calls.answers.json). good: release-60's SIGN_HOST build (packages/signpage/index.html and public/app.js
// as committed), every deposit stage, the hold reasons and the frame carrying a deposit's facts: PASS. bad: SIGN_HOST
// as served before release-60's deploy (release-59): FAIL. Planted on the good one: another /app.js, no pin, a stage, a hold reason or a fact key missing, a stage
// list with an extra stage: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FACT_KEYS, HOLDS, STAGES, facts, judge } from "./kit-deposit-calls.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./kit-deposit-calls.answers.json", import.meta.url), "utf8"));
const BEFORE = [
  "BAD the bundle's deposit stages miss failed, short, expired, refund_move: the app's sheet cannot show such a deposit",
  "BAD the bundle names no hold reasons halted, not_caught_up, vault_blocked",
  "BAD the frame does not carry a deposit's facts refunded, hold, held_id, since_ms, amount_usd into state.ops",
];

test("recorded good answer: this card's build carries every deposit stage, the hold reasons and the facts: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

for (const k of ["bad"]) {
  test(`recorded bad answer ${k}: FAIL, each missing fact named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, BEFORE);
  });
}

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.ok(judge({ ...g, sha384: "sha384-other" }).lines.includes("BAD SIGN_HOST's served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD SIGN_HOST's index.html pins no /app.js"));
  for (const s of STAGES) assert.equal(judge({ ...g, stages: [STAGES.filter((x) => x !== s)] }).ok, false, `${s} missing`);
  assert.equal(judge({ ...g, stages: [[...STAGES, "teleported"]] }).ok, false, "an extra stage");
  for (const h of HOLDS) assert.equal(judge({ ...g, holds: [HOLDS.filter((x) => x !== h)] }).ok, false, `${h} missing`);
  for (const f of FACT_KEYS) assert.equal(judge({ ...g, keys: [FACT_KEYS.filter((x) => x !== f)] }).ok, false, `${f} missing`);
  assert.equal(judge({}).ok, false, "an empty answer");
});

test("facts() reads the lists from a minified bundle", () => {
  const js = `var a=Object.freeze([${STAGES.map((s) => `\`${s}\``).join(",")}]),b=Object.freeze([\`halted\`,\`not_caught_up\`,\`vault_blocked\`]);var c=[\`refunded\`,\`hold\`,\`held_id\`,\`since_ms\`,\`amount_usd\`];`;
  const f = facts("", js);
  assert.deepEqual(f.stages, [STAGES]);
  assert.deepEqual(f.holds, [HOLDS]);
  assert.deepEqual(f.keys, [FACT_KEYS]);
});
