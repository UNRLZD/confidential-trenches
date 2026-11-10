// node --test scripts/live-checks/pool-sell-share-across-wallets.test.mjs: the live check replays its recorded answers
// (pool-sell-share-across-wallets.answers.json). good: this card's SIGN_HOST build, which takes a share of the whole
// holding, turns it into units from its own total and sells each wallet as units: PASS, against a release list that
// holds it. bad: 4efc012f's build (main before this card): FAIL. liveBefore: SIGN_HOST before this card's deploy: FAIL.
// Planted on the good one: another /app.js, no pin, no release list, each mark taken away: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FIRST_RELEASE, facts, judge, releasedAppJs } from "./pool-sell-share-across-wallets.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pool-sell-share-across-wallets.answers.json", import.meta.url), "utf8"));
const UNRELEASED = "BAD SIGN_HOST's served /app.js is the /app.js of no release list of this card's on: bytes no tested source built";
const MARKS = [
  "BAD the page takes no pool.sell share (share_bps or an amount, exactly one)",
  "BAD the sell's units are not the device's own total of every wallet's holding (a share of it, or an amount refused over it)",
  "BAD the wallets' sales do not each run as units",
  "BAD the Solana sell's rule does not refuse a share: a share could reach signed bytes",
];
/** The release list this card's release will write: the planted cases judge against it alone. */
const LISTED = new Map([[ANSWERS.good.sha384, `release-${FIRST_RELEASE}`]]);

test("recorded good answer: this card's build takes a share, makes units from its own total and sells each wallet as units: PASS", () => {
  const v = judge(ANSWERS.good, { released: LISTED });
  assert.deepEqual(v.lines, []);
  assert.equal(v.ok, true);
  // the PR's own build, before its release (scripts/ci/bundle-checks.mjs): the marks and the pin
  assert.deepEqual(judge(ANSWERS.good, { ledger: false }).lines, []);
});

for (const k of ["bad", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, every mark named`, () => {
    const v = judge(ANSWERS[k], { released: LISTED });
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, [UNRELEASED, ...MARKS]);
    assert.deepEqual(judge(ANSWERS[k], { ledger: false }).lines, MARKS);
  });
}

test("the release lists read: none before FIRST_RELEASE (main's newest at 4ae503b1 is release-109)", () => {
  assert.equal(FIRST_RELEASE, 110);
  assert.ok([...releasedAppJs().values()].every((x) => Number(x.slice(8)) >= FIRST_RELEASE));
  assert.ok(releasedAppJs(undefined, 1).size > 50, "every written list is read from release-1");
  assert.ok(!releasedAppJs().has(ANSWERS.bad.sha384), "main's build before this card is in no list of this card's on");
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }, { released: LISTED }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins", UNRELEASED]);
  assert.deepEqual(judge(g, { released: new Map() }).lines, [UNRELEASED]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }, { released: LISTED }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  ["schema", "units", "legs", "rule"].forEach((k, i) => assert.deepEqual(judge({ ...g, [k]: false }, { released: LISTED }).lines, [MARKS[i]], k));
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle, each mark its own code", () => {
  const js =
    '"pool.sell":e=>dl(e)&&Object.hasOwn(e,`amount`)!==Object.hasOwn(e,`share_bps`),' +
    "l=t.shareBps===void 0?t.amount:t.shareBps===1e4?c:c*BigInt(t.shareBps)/10000n;if(l<=0n||l>c)return $(`not_funded`);" +
    "iV(f,{...t,amount:i.units,shareBps:void 0},c,i.w);" +
    "function ID(e,t){if(t.kind!==`pool.sell`||t.chain!==`solana`)return X(`kind`);if(t.shareBps!==void 0)return X(`amount`);}";
  assert.deepEqual(facts("", js), { index: "", sha384: facts("", js).sha384, schema: true, units: true, legs: true, rule: true });
  assert.equal(facts("", js.replace("!==Object.hasOwn(e,`share_bps`)", "")).schema, false, "exactly one of the two");
  assert.equal(facts("", js.replace("if(l<=0n||l>c)", "if(l<=0n)")).units, false, "an amount over the total refused");
  assert.equal(facts("", js.replace("===1e4?c:", "===1e4?d:")).units, false, "all of it is the total read");
  assert.equal(facts("", js.replace("shareBps:void 0}", "shareBps:t.shareBps}")).legs, false, "each sale as units");
  assert.equal(facts("", js.replace("if(t.shareBps!==void 0)return X(`amount`);", "")).rule, false, "the rule refuses a share");
  assert.equal(facts("", js.replace("if(t.shareBps!==void 0)", "if(!1&&t.shareBps!==void 0)")).rule, false, "never unreached");
});
