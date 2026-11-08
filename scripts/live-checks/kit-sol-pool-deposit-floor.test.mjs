// node --test scripts/live-checks/kit-sol-pool-deposit-floor.test.mjs: the live check replays its recorded answers
// (kit-sol-pool-deposit-floor.answers.json). good: this card's SIGN_HOST build, whose Solana pool deposit refuses a note
// under the release floor at the rent read: PASS. bad: main c7778df0's build, which builds any note from 1,000,000
// lamports: FAIL. liveBefore: SIGN_HOST before this card's deploy: FAIL. Planted on the good one: another /app.js, no
// pin, each mark taken away: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./kit-sol-pool-deposit-floor.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./kit-sol-pool-deposit-floor.answers.json", import.meta.url), "utf8"));
const NO_FLOOR = "BAD the bundle's Solana pool deposit builds a note under the release floor: one that costs more to release than it holds";
const NO_RENT = "BAD the bundle's Solana pool deposit takes no rent read: its floor cannot follow the rent";

test("recorded good answer: this card's build refuses a note under the release floor: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

for (const k of ["bad", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, the floor and the rent named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, [NO_FLOOR, NO_RENT]);
  });
}

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, floor: false }).lines, [NO_FLOOR]);
  assert.deepEqual(judge({ ...g, rent: false }).lines, [NO_RENT]);
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle", () => {
  const js = "r(`the value ${e} is under the release floor of ${n} lamports at this rent: the note would cost more to release than it holds`);r(`the rent is not a Rent sysvar read`)";
  assert.deepEqual(facts("", js), { index: "", sha384: facts("", js).sha384, floor: true, rent: true });
  assert.equal(facts("", js.replace("release floor", "floor")).floor, false);
  assert.equal(facts("", js.replace("${n}", "1000000")).floor, false);
  assert.equal(facts("", js.replace("Rent sysvar read", "rent")).rent, false);
});
