// node --test scripts/live-checks/sol-sell-deposit-back-floor.test.mjs: the live check replays its recorded answers
// (sol-sell-deposit-back-floor.answers.json). good: this card's SIGN_HOST build, whose sell's rule refuses a deposit
// back under the kit's release floor by name: PASS, against a release list that holds it. bad: 87c410c4's build (the
// floor card merged with main), whose rule refuses only one under the pool's least deposit: FAIL. liveBefore: SIGN_HOST
// before this card's deploy: FAIL. unreached: the good bundle with the refusal never reached (!1&& in front of it) and
// index.html pinning it: FAIL. Planted on the good one: another /app.js, no pin, the mark taken away, no release list:
// each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FIRST_RELEASE, facts, judge, releasedAppJs } from "./sol-sell-deposit-back-floor.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./sol-sell-deposit-back-floor.answers.json", import.meta.url), "utf8"));
const NO_FLOOR = "BAD the bundle's Solana sell signs a deposit back under the kit's release floor: a note no release can take whole";
const UNRELEASED = "BAD SIGN_HOST's served /app.js is the /app.js of no release list of this card's on: bytes no tested source built";
/** The release list this card's release writes: until its number is set, the test names it. */
const LISTED = new Map([[ANSWERS.good.sha384, "release-this-card"]]);

test("recorded good answer: this card's build refuses a deposit back under the floor by name: PASS", () => {
  const v = judge(ANSWERS.good, { released: LISTED });
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
  // the PR's own build, before its release (scripts/ci/bundle-checks.mjs): the marks and the pin
  assert.deepEqual(judge(ANSWERS.good, { ledger: false }).lines, []);
});

for (const k of ["bad", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, the floor named`, () => {
    const v = judge(ANSWERS[k], { released: LISTED });
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, [UNRELEASED, NO_FLOOR]);
    assert.deepEqual(judge(ANSWERS[k], { ledger: false }).lines, [NO_FLOOR]);
  });
}

test("recorded bad answer unreached (the refusal behind !1&&): FAIL, its mark gone and its bytes in no release list", () => {
  const v = judge(ANSWERS.unreached, { released: LISTED });
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [UNRELEASED, NO_FLOOR]);
});

test("the release lists read: none holds this card's build until its release is cut, so the live run FAILs until then", () => {
  assert.equal(FIRST_RELEASE, Number.POSITIVE_INFINITY);
  assert.equal(releasedAppJs().size, 0);
  assert.deepEqual(judge(ANSWERS.good).lines, [UNRELEASED]);
  // from release-1 every written list is read, each its own /app.js
  const all = releasedAppJs(undefined, 1);
  assert.ok(all.size > 50 && !all.has(ANSWERS.good.sha384) && !all.has(ANSWERS.bad.sha384), String(all.size));
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }, { released: LISTED }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins", UNRELEASED]);
  assert.deepEqual(judge(g, { released: new Map() }).lines, [UNRELEASED]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }, { released: LISTED }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, floor: false }, { released: LISTED }).lines, [NO_FLOOR]);
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle", () => {
  const js = "let b=h-s<Xy(y),x=p.at(-1);if(b&&x.program===l.program)return X(`deposit_floor`);let S=b?p:p.slice(0,-1);";
  assert.equal(facts("", js).floor, true);
  assert.equal(facts("", js.replace("`deposit_floor`", "`deposit_amount`")).floor, false);
  assert.equal(facts("", js.replace("if(b&&", "if(!1&&b&&")).floor, false);
  assert.equal(facts("", js.replace("if(b&&", "if(c&&")).floor, false, "the refusal is the floor comparison's own");
  assert.equal(facts("", js.replace("&&x.program", "&&y.program")).floor, false, "on the last instruction");
  assert.equal(facts("", js.replace("<Xy(y)", "<1000000n")).floor, false, "the floor is read from the rent, never a constant");
});
