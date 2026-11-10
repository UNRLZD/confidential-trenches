// The part argument of a mutant sweep (scripts/mutant-part.mjs): none runs the whole sweep, <k>/<n> part k of n with
// mutant i in part (i % n) + 1, and anything else is refused with nothing run (card ci-mutant-shards-true-times).
//   node --test scripts/ci/mutant-part.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { partProblems, sweepPart, sweepPartOrExit } from "../mutant-part.mjs";

const NAMES = Array.from({ length: 10 }, (_, i) => `m${i}`);

test("no argument runs every mutant; k/n takes mutant i when i % n is k - 1", () => {
  assert.deepEqual(sweepPart([], NAMES).at, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(sweepPart(["1/3"], NAMES).at, [0, 3, 6, 9]);
  assert.deepEqual(sweepPart(["2/3"], NAMES).at, [1, 4, 7]);
  assert.deepEqual(sweepPart(["3/3"], NAMES).at, [2, 5, 8]);
  assert.deepEqual(sweepPart(["1/1"], NAMES).at, sweepPart([], NAMES).at);
  assert.equal(sweepPart(["2/3"], NAMES).what, "3 mutants (part 2 of 3)");
  assert.ok(sweepPart(["2/3"], NAMES).pick(4) && !sweepPart(["2/3"], NAMES).pick(3));
});

test("planted: a malformed part, k past n, a part with no mutant and a second argument are each refused", () => {
  for (const bad of ["0/3", "4/3", "1/0", "3", "1/3/2", " 1/3", "1/3 ", "a/b", "", "-1/3", "1.5/3", "01/3x"]) {
    assert.throws(() => sweepPart([bad], NAMES), /<k>\/<n> with 1 <= k <= n/, JSON.stringify(bad));
  }
  assert.throws(() => sweepPart(["1/3", "2/3"], NAMES), /one part at most/);
  assert.throws(() => sweepPart(["11/11"], NAMES), /part 11 of 11 holds no mutant: the sweep has 10/);
  assert.throws(() => sweepPart(["1/1"], []), /holds no mutant/);
  assert.throws(() => sweepPart("1/3", NAMES), /one part at most/);
});

test("a refused part is a FAIL line and exit 1, never a run", () => {
  const said = [];
  const exits = [];
  sweepPartOrExit(["9/3"], NAMES, (l) => said.push(l), (c) => exits.push(c));
  assert.deepEqual(exits, [1]);
  assert.match(said[0], /^FAIL the part is <k>\/<n>/);
  assert.deepEqual(sweepPartOrExit(["2/2"], NAMES, () => assert.fail(), () => assert.fail()).at, [1, 3, 5, 7, 9]);
});

test("partProblems: every count of parts takes each mutant once; a split that drops, doubles or runs a part past the sweep is named", () => {
  assert.deepEqual(partProblems(NAMES), []);
  const own = (args) => sweepPart(args, NAMES);
  const drops = (args) => ({ ...own(args), at: own(args).at.filter((i) => i !== 9) });
  const doubles = (args) => ({ ...own(args), at: [...own(args).at, 0] });
  const stray = (args) => ({ ...own(args), at: [...own(args).at, 12] });
  const lenient = (args) => (/^11\//.test(args[0]) ? { at: [] } : own(args));
  assert.match(partProblems(NAMES, drops).join("\n"), /\b2 parts: 10 "m9" x0/);
  assert.match(partProblems(NAMES, doubles).join("\n"), /"m0" x2/);
  assert.match(partProblems(NAMES, stray).join("\n"), /none of the sweep's|x/);
  assert.match(partProblems(NAMES, lenient).join("\n"), /part 11 of 11 ran, with no mutant to run/);
  // a sweep whose parts are chosen by a different rule (k-th block, not every n-th) still holds each once: no false alarm
  const blocks = (args) => {
    if (!args.length) return own(args);
    const [k, n] = args[0].split("/").map(Number);
    const per = Math.ceil(NAMES.length / n);
    const at = NAMES.map((_, i) => i).filter((i) => Math.floor(i / per) === k - 1);
    if (!at.length) throw new Error("no mutant");
    return { at };
  };
  assert.ok(partProblems(NAMES, blocks).some((p) => /part \d+ of \d+: no mutant/.test(p)), "a block rule leaves a part empty for some n, and is named");
});
