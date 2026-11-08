// node --test scripts/live-checks/kit-sol-pool-deposit-floor.test.mjs: the live check replays its recorded answers
// (kit-sol-pool-deposit-floor.answers.json). good: this card's SIGN_HOST build, whose Solana pool deposit refuses a note
// under the release floor at the rent read: PASS. bad: main c7778df0's build, which builds any note from 1,000,000
// lamports: FAIL. liveBefore: SIGN_HOST before this card's deploy: FAIL. unreached: the good bundle with the refusal
// never reached (!1&& in front of it) and index.html pinning it: FAIL, no release list holds its bytes. Planted on the
// good one: another /app.js, no pin, each mark taken away, no release list: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FIRST_RELEASE, facts, judge, releasedAppJs } from "./kit-sol-pool-deposit-floor.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./kit-sol-pool-deposit-floor.answers.json", import.meta.url), "utf8"));
const NO_FLOOR = "BAD the bundle's Solana pool deposit builds a note under the release floor: one that costs more to release than it holds";
const NO_RENT = "BAD the bundle's Solana pool deposit takes no rent read: its floor cannot follow the rent";
const UNRELEASED = "BAD SIGN_HOST's served /app.js is the /app.js of no release list from release-101 on: bytes no tested source built";

test("recorded good answer: this card's build refuses a note under the release floor: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

for (const k of ["bad", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, the floor and the rent named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, [UNRELEASED, NO_FLOOR, NO_RENT]);
  });
}

test("recorded bad answer unreached (the refusal behind !1&&, its marks still there): FAIL, its bytes in no release list", () => {
  const v = judge(ANSWERS.unreached);
  assert.equal(v.ok, false);
  assert.equal(ANSWERS.unreached.floor && ANSWERS.unreached.rent, true, "the marks alone would pass it");
  assert.deepEqual(v.lines, [UNRELEASED]);
});

test("the release lists read: release-101's /app.js is the good answer's; a list before release-101 is not read", () => {
  const r = releasedAppJs();
  assert.equal(r.get(ANSWERS.good.sha384), "release-101");
  assert.equal(r.has(ANSWERS.bad.sha384), false);
  assert.ok([...r.values()].every((x) => Number(x.slice(8)) >= FIRST_RELEASE));
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins", UNRELEASED]);
  assert.deepEqual(judge(g, new Map()).lines, [UNRELEASED]);
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
