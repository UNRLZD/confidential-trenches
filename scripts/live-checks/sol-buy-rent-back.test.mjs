// node --test scripts/live-checks/sol-buy-rent-back.test.mjs: the live check replays its recorded answers
// (sol-buy-rent-back.answers.json). good: this card's SIGN_HOST build, its pool sell's teardown and sweep: PASS. bad: main
// 987fae20's build: FAIL. liveBefore: SIGN_HOST before this card's deploy (the same bundle as main's): FAIL. Planted on
// the good one: another /app.js, no pin, each mark taken away: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./sol-buy-rent-back.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./sol-buy-rent-back.answers.json", import.meta.url), "utf8"));
const NO_TEARDOWN = "BAD the bundle's pool sell runs no teardown: W's token and volume accounts keep their rent after a full sell";
const NO_SWEEP = "BAD the bundle's pool sell sweeps nothing: what W holds after a full sell stays out of the pool";

test("recorded good answer: this card's build tears down and sweeps W after a full sell: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

for (const k of ["bad", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, the teardown and the sweep named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, [NO_TEARDOWN, NO_SWEEP]);
  });
}

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, teardown: false }).lines, [NO_TEARDOWN]);
  assert.deepEqual(judge({ ...g, volumeClose: false }).lines, [NO_TEARDOWN]);
  assert.deepEqual(judge({ ...g, sweep: false }).lines, [NO_SWEEP]);
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle", () => {
  const js = "r(`teardown`);x=[249,69,164,218,150,103,84,138];r(`sweep_amount`)";
  assert.deepEqual(facts("", js), { index: "", sha384: facts("", js).sha384, teardown: true, volumeClose: true, sweep: true });
  assert.equal(facts("", js.replace("`sweep_amount`", "`sweep`")).sweep, false);
  assert.equal(facts("", js.replace("`teardown`", "`teardowns`")).teardown, false);
  assert.equal(facts("", js.replace("249,69", "249,70")).volumeClose, false);
});
