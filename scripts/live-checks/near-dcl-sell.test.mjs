// node --test scripts/live-checks/near-dcl-sell.test.mjs: the live check replays its recorded answers
// (near-dcl-sell.answers.json). good: this card's SIGN_HOST build, which quotes Rhea DCL beside classic, builds the DCL
// Swap and holds it to its quote in W's signer: PASS, against a release list that holds it. bad: SIGN_HOST before this
// card's deploy: FAIL. Planted on the good one: another /app.js, no pin, no release list, each mark taken away: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FIRST_RELEASE, MARKS, facts, judge, releasedAppJs } from "./near-dcl-sell.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./near-dcl-sell.answers.json", import.meta.url), "utf8"));
const UNRELEASED = "BAD SIGN_HOST's served /app.js is the /app.js of no release list of this card's on: bytes no tested source built";
const BADS = Object.values(MARKS).map((m) => `BAD ${m}`);
/** The release list this card's release will write: the planted cases judge against it alone. */
const LISTED = new Map([[ANSWERS.good.sha384, `release-${FIRST_RELEASE}`]]);

test("recorded good answer: this card's build quotes DCL, builds its Swap and checks it before W signs: PASS", () => {
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

test("the release lists read: none before FIRST_RELEASE (main's newest is release-163, without this card)", () => {
  assert.equal(FIRST_RELEASE, 164);
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
  const js = 'throw R("no-pool",`no Running DCL pool among ${x}`);var a={exchange:`dclv2.ref-labs.near`};JSON.stringify({Swap:{min_output_amount:f}});N("N4","msg: the Swap\'s keys (no referrer, no echo)")';
  assert.deepEqual(facts("", js), { index: "", sha384: facts("", js).sha384, quote: true, swap: true, check: true });
  assert.equal(facts("", js.replace("no Running DCL pool among", "")).quote, false);
  assert.equal(facts("", js.replace("dclv2.ref-labs.near", "")).swap, false, "DCL's exchange");
  assert.equal(facts("", js.replace("min_output_amount", "")).swap, false, "the Swap's minimum");
  assert.equal(facts("", js.replace("no referrer, no echo", "")).check, false);
});
