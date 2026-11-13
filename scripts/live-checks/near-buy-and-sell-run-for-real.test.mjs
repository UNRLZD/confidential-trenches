// node --test scripts/live-checks/near-buy-and-sell-run-for-real.test.mjs: the live check replays its recorded answers
// (near-buy-and-sell-run-for-real.answers.json). good: mainnet as this check read it on FastNEAR and dRPC: PASS. bad: the
// good answer as an upgrade would leave it (Rhea at another code on both operators, pool 4771's fee changed on one):
// FAIL, each named. Planted on the good one: a key on the vault, USDC at another code, a pool's tokens swapped: each
// FAIL, named; one operator silent: INCONCLUSIVE. The pinned hashes are the ones the card's record names for the copy's code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CODE, POOLS, USDC, judge } from "./near-buy-and-sell-run-for-real.mjs";

const A = JSON.parse(readFileSync(new URL("./near-buy-and-sell-run-for-real.answers.json", import.meta.url), "utf8"));
const FAST = "https://rpc.mainnet.fastnear.com";
const DRPC = "https://near.drpc.org";
const planted = (f) => {
  const a = structuredClone(A.good);
  f(a);
  return judge(a);
};
const one = (v, re) => {
  assert.equal(v.ok, false);
  assert.equal(v.lines.length, 1, v.lines.join(" | "));
  assert.match(v.lines[0], re);
};

test("recorded good answer: mainnet runs the code the run proved, the vault keyless, the route's pools as built: PASS", () => {
  const v = judge(A.good);
  assert.deepEqual(v.lines, []);
  assert.equal(v.ok, true);
});

test("recorded bad answer: Rhea upgraded, a pool's fee changed: FAIL, each named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.equal(v.lines.length, 3, v.lines.join(" | "));
  assert.match(v.lines[0], /^BAD https:\/\/rpc\.mainnet\.fastnear\.com: v2\.ref-finance\.near runs code /);
  assert.match(v.lines[1], /^BAD https:\/\/near\.drpc\.org: v2\.ref-finance\.near runs code /);
  assert.match(v.lines[2], /^BAD https:\/\/near\.drpc\.org: Rhea's pool 4771 is .* at fee 25, not the route/);
});

test("planted bad answers: each FAIL, named", () => {
  one(planted((a) => (a.reads[FAST].vaultKeys = [{ public_key: "ed25519:x" }])), /the vault has access keys/);
  one(planted((a) => (a.reads[DRPC].code[USDC] = "11111111111111111111111111111111")), new RegExp(`${USDC} runs code 1{32}`));
  one(planted((a) => a.reads[FAST].pools["4512"].token_account_ids.reverse()), /pool 4512 is/);
  one(planted((a) => delete a.reads[FAST].pools["4771"]), /pool 4771 gave no answer/);
});

test("an operator that answers nothing usable is its no-answer: INCONCLUSIVE, never PASS or FAIL; a wrong answer beside it still FAILs", () => {
  for (const silent of [null, { noAnswer: "near.drpc.org HTTP 429: 429 Too Many Requests" }]) {
    const v = planted((a) => (a.reads[DRPC] = silent));
    assert.equal(v.verdict, "INCONCLUSIVE");
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines.filter((l) => l.startsWith("BAD")), []);
    assert.match(v.lines[0], /^-- {2}https:\/\/near\.drpc\.org: no answer/);
  }
  const both = planted((a) => ((a.reads[DRPC] = null), (a.reads[FAST].vaultKeys = [{ public_key: "ed25519:x" }])));
  assert.equal(both.verdict, "FAIL");
});

test("the pins: five accounts, the route's two pools", () => {
  assert.deepEqual(Object.keys(CODE).length, 5);
  assert.deepEqual(Object.keys(POOLS), ["4512", "4771"]);
});
