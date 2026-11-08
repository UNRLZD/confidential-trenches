// The EVM sell sender's mutant sweep (test/pool-evm/sell-mutants.mjs) still runs: every entry's text is in its file
// exactly once, and the sweep refuses a stale entry before any test and counts a survivor as a problem (card
// helper-sell-sweep-in-ci: five entries stood stale for days while no CI job ran the sweep). The sweep itself runs in
// ci.yml's test-mutants, as apps/helper's test:mutants.
//   node --test apps/helper/test/pool-evm/sell-mutants.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { MUTANTS, partOf, stale, sweep } from "./sell-mutants.mjs";

const EVM = "src/pool/evm.ts";
const T = "src/pool/evm-sell.test.ts";

test("every sell mutant's text occurs exactly once in its file", () => {
  assert.ok(MUTANTS.length > 200, `${MUTANTS.length} mutants`);
  assert.deepEqual(stale(MUTANTS), []);
});

test("planted: a text gone from the code and a text in two places are each refused, and the sweep then runs no test", () => {
  const read = () => "if (a) {}\nif (b) {}\nif (b) {}\n";
  assert.match(stale([[EVM, "if (gone) {}", "", T, "x"]], read).join(), /^mutant 1: its text is in src\/pool\/evm\.ts 0 times, not once/);
  assert.match(stale([[EVM, "if (b) {}", "", T, "x"]], read).join(), /2 times, not once/);
  assert.deepEqual(stale([[EVM, "if (a) {}", "", T, "x"]], read), []);
  const said = [];
  // a test that does not exist would print "names no test" had the sweep gone on to run it
  assert.equal(sweep([MUTANTS[0], [EVM, "  if (gone) return no(400);", "", T, "no such test"]], (l) => said.push(l)), 1);
  assert.deepEqual(said, ['FAIL mutant 2: its text is in src/pool/evm.ts 0 times, not once: "if (gone) return no(400);"']);
});

test("planted: a mutant its named test does not tell apart from the code is a survivor, and the sweep fails on it", { timeout: 120_000 }, () => {
  const [, find, , , name] = MUTANTS.find((m) => m[4] === "no fee collector set");
  const said = [];
  // the same check with a comment after it: the code's behaviour is unchanged, so the named test still passes
  assert.equal(sweep([[EVM, find, `${find} /* planted */`, T, name]], (l) => said.push(l)), 1);
  assert.equal(said.length, 1);
  assert.match(said[0], /^FAIL mutant 1: .* -> "no fee collector set" PASSES$/);
});

test("the parts: k of n for every n takes each entry exactly once, and a part that is not k/n is refused", () => {
  for (const n of [1, 2, 3, 4, 7]) {
    const taken = MUTANTS.map((_, i) => Array.from({ length: n }, (_, k) => partOf(`${k + 1}/${n}`, MUTANTS.length).pick(i)).filter(Boolean).length);
    assert.ok(taken.every((c) => c === 1), `n = ${n}`);
  }
  assert.equal(partOf(undefined, 10).what, "10 mutants");
  assert.equal(partOf("2/3", 10).what, "3 mutants (part 2 of 3)");
  for (const bad of ["0/3", "4/3", "1/0", "3", "1/3/2", " 1/3", "a/b", ""]) assert.throws(() => partOf(bad, 10), /<k>\/<n>/, bad);
});
