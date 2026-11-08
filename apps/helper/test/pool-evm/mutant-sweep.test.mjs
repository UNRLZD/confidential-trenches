// The helper's EVM mutant sweeps (test/pool-evm/sell-mutants.mjs and release-mutants.mjs, run by mutant-sweep.mjs)
// still run: every entry's text is in its file exactly once, and the runner refuses a stale entry before any test and
// counts a survivor as a problem (card helper-sell-sweep-in-ci: twelve sell entries stood stale while no CI job ran
// the sweep; card helper-release-sweep-in-ci: the release sweep joined it). The sweeps themselves run in ci.yml's
// test-mutants, as apps/helper's test:mutants.
//   node --test apps/helper/test/pool-evm/mutant-sweep.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { partOf, stale, sweep } from "./mutant-sweep.mjs";
import { MUTANTS as RELEASE } from "./release-mutants.mjs";
import { MUTANTS as SELL } from "./sell-mutants.mjs";

const EVM = "src/pool/evm.ts";
const T = "src/pool/evm-sell.test.ts";

for (const [name, list, least] of [["sell", SELL, 200], ["release", RELEASE, 70]]) {
  test(`every ${name} mutant's text occurs exactly once in its file`, () => {
    assert.ok(list.length > least, `${list.length} mutants`);
    assert.deepEqual(stale(list), []);
  });
}

test("planted: a text gone from the code and a text in two places are each refused, and the sweep then runs no test", () => {
  const read = () => "if (a) {}\nif (b) {}\nif (b) {}\n";
  assert.match(stale([[EVM, "if (gone) {}", "", T, "x"]], read).join(), /^mutant 1: its text is in src\/pool\/evm\.ts 0 times, not once/);
  assert.match(stale([[EVM, "if (b) {}", "", T, "x"]], read).join(), /2 times, not once/);
  assert.deepEqual(stale([[EVM, "if (a) {}", "", T, "x"]], read), []);
  // a test that does not exist would print "names no test" had the sweep gone on to run it
  for (const list of [SELL, RELEASE]) {
    const said = [];
    assert.equal(sweep([list[0], [EVM, "  if (gone) return no(400);", "", T, "no such test"]], (l) => said.push(l)), 1);
    assert.deepEqual(said, ['FAIL mutant 2: its text is in src/pool/evm.ts 0 times, not once: "if (gone) return no(400);"']);
  }
  // a text in two places of evm.ts: evmSaleUnpaid's and evmBuyUnpaid's cost lines are the same
  const said = [];
  assert.equal(sweep([[EVM, "  const cost = ca > cb ? ca : cb;", "  const cost = ca;", T, "no such test"]], (l) => said.push(l)), 1);
  assert.deepEqual(said, ['FAIL mutant 1: its text is in src/pool/evm.ts 2 times, not once: "const cost = ca > cb ? ca : cb;"']);
});

// one entry of each sweep, its named test in its own file, with a comment put after its text: the code's behaviour is
// unchanged, so the named test still passes and the sweep counts it a survivor
for (const [name, list, pick] of [
  ["sell", SELL, (m) => m[4] === "no fee collector set"],
  ["release", RELEASE, (m) => m[3] === "src/pool/evm-release.test.ts" && !m[1].endsWith("\n")],
]) {
  test(`planted: a ${name} mutant its named test does not tell apart from the code is a survivor, and the sweep fails on it`, { timeout: 120_000 }, () => {
    const [file, find, , tf, t] = list.find(pick);
    const said = [];
    assert.equal(sweep([[file, find, `${find} /* planted */`, tf, t]], (l) => said.push(l)), 1);
    assert.equal(said.length, 1, said.join("\n"));
    assert.ok(said[0].startsWith("FAIL mutant 1: ") && said[0].endsWith(`-> "${t}" PASSES`), said[0]);
  });
}

test("the parts: k of n for every n takes each entry exactly once, and a part that is not k/n is refused", () => {
  for (const list of [SELL, RELEASE]) {
    for (const n of [1, 2, 3, 4, 7]) {
      const taken = list.map((_, i) => Array.from({ length: n }, (_, k) => partOf(`${k + 1}/${n}`, list.length).pick(i)).filter(Boolean).length);
      assert.ok(taken.every((c) => c === 1), `n = ${n}`);
    }
  }
  assert.equal(partOf(undefined, 10).what, "10 mutants");
  assert.equal(partOf("2/3", 10).what, "3 mutants (part 2 of 3)");
  for (const bad of ["0/3", "4/3", "1/0", "3", "1/3/2", " 1/3", "a/b", ""]) assert.throws(() => partOf(bad, 10), /<k>\/<n>/, bad);
});
