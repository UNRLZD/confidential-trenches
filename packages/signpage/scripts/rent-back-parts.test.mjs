// The rent back sweep runs in parts (cards sol-rent-back-dust-burn, ci-mutant-shards-true-times): scripts/rent-back-mutants.mjs
// takes <k>/<n>, mutant i in part (i % n) + 1 (scripts/mutant-part.mjs). For every count of parts from 1 to the sweep's
// size the parts together hold each of its mutants once and no other, and a part with no mutant is refused.
//   node --test scripts/rent-back-parts.test.mjs      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import { partProblems, sweepPart } from "../../../scripts/mutant-part.mjs";
import { NAMES } from "./rent-back-mutants.mjs";

test("the rent back sweep: the parts for every count from 1 to its size hold each mutant once", () => {
  assert.ok(NAMES.length > 80, `${NAMES.length} mutants`);
  assert.deepEqual(partProblems(NAMES), []);
  assert.throws(() => sweepPart([`${NAMES.length + 1}/${NAMES.length + 1}`], NAMES), /holds no mutant/);
  assert.throws(() => sweepPart(["3/2"], NAMES), /<k>\/<n>/);
});
