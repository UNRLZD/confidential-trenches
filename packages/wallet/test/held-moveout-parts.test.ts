// The held deposit's way-out sweep runs in parts (card ci-mutant-shards-true-times): scripts/held-moveout-mutants.mjs takes
// <k>/<n>, mutant i in part (i % n) + 1 (scripts/mutant-part.mjs), as the signing page's rent back sweep does. For every
// count of parts from 1 to the sweep's size the parts together hold each of its mutants once and no other, and a part
// with no mutant is refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { partProblems, sweepPart } from "../../../scripts/mutant-part.mjs";
import { NAMES } from "../scripts/held-moveout-mutants.mjs";

test("the held way-out sweep: the parts for every count from 1 to its size hold each mutant once", () => {
  assert.ok(NAMES.length > 60, `${NAMES.length} mutants`);
  assert.deepEqual(partProblems(NAMES), []);
  assert.throws(() => sweepPart([`${NAMES.length + 1}/${NAMES.length + 1}`], NAMES), /holds no mutant/);
  assert.throws(() => sweepPart(["3/2"], NAMES), /<k>\/<n>/);
});
