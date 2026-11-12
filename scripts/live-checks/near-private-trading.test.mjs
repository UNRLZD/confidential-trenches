// node --test scripts/live-checks/near-private-trading.test.mjs: the live check replays its recorded answers
// (near-private-trading.answers.json). good: this card's SIGN_HOST build, which binds the NEAR buy and sell to a record,
// a token lock and Rhea's pool list: PASS, against a release list that holds it. bad: SIGN_HOST before this card's
// deploy: FAIL. Planted on the good one: another /app.js, no pin, no release list, each mark taken away: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FIRST_RELEASE, MARKS, facts, judge, releasedAppJs } from "./near-private-trading.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./near-private-trading.answers.json", import.meta.url), "utf8"));
const UNRELEASED = "BAD SIGN_HOST's served /app.js is the /app.js of no release list of this card's on: bytes no tested source built";
const BADS = Object.values(MARKS).map((m) => `BAD ${m}`);
/** The release list this card's release will write: the planted cases judge against it alone. */
const LISTED = new Map([[ANSWERS.good.sha384, `release-${FIRST_RELEASE}`]]);

test("recorded good answer: this card's build binds the NEAR buy and sell: PASS", () => {
  const v = judge(ANSWERS.good, { released: LISTED });
  assert.deepEqual(v.lines, []);
  assert.equal(v.ok, true);
  assert.deepEqual(judge(ANSWERS.good, { ledger: false }).lines, []);
});

test("recorded bad answer (SIGN_HOST before this card): FAIL, every mark named", () => {
  const v = judge(ANSWERS.bad, { released: LISTED });
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [UNRELEASED, ...BADS]);
  assert.deepEqual(judge(ANSWERS.bad, { ledger: false }).lines, BADS);
});

test("the release lists read: none before FIRST_RELEASE (main's newest is release-118, without this card)", () => {
  assert.equal(FIRST_RELEASE, 119);
  assert.ok([...releasedAppJs().values()].every((x) => Number(x.slice(8)) >= FIRST_RELEASE));
  assert.ok(!releasedAppJs().has(ANSWERS.bad.sha384));
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }, { released: LISTED }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins", UNRELEASED]);
  assert.deepEqual(judge(g, { released: new Map() }).lines, [UNRELEASED]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }, { released: LISTED }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  Object.keys(MARKS).forEach((k, i) => assert.deepEqual(judge({ ...g, [k]: false }, { released: LISTED }).lines, [BADS[i]], k));
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle, each mark its own", () => {
  const js = 'const K="near-buy:";log("near buy recorded");locks.request(`ct-near-buy/${n}/${t}`);log("near sell recorded");view(x,"get_number_of_pools",{})';
  assert.deepEqual(facts("", js), { index: "", sha384: facts("", js).sha384, record: true, lock: true, sell: true, pools: true });
  assert.equal(facts("", js.replace("near buy recorded", "")).record, false, "the record written before the payout");
  assert.equal(facts("", js.replace("ct-near-buy/", "")).lock, false);
  assert.equal(facts("", js.replace("near sell recorded", "")).sell, false);
  assert.equal(facts("", js.replace("get_number_of_pools", "")).pools, false);
});
