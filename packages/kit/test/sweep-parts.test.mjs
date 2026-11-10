// The kit's mutant sweeps run in parts (card ci-mutant-shards-true-times): evm-quote-mutants.mjs, pool-usd-mutants.mjs and
// the three EVM pool sweeps take <k>/<n>, mutant i in part (i % n) + 1 (scripts/mutant-part.mjs). For every count of parts
// from 1 to the sweep's size, the parts together hold each of its mutants once and no other, and a part with no mutant is
// refused; and the two wrapper tests (test/mutants/) hand MUTANT_PART on to the sweep, so a part they cannot read fails them.
//   node --test packages/kit/test/sweep-parts.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { partProblems, sweepPart } from "../../../scripts/mutant-part.mjs";
import { NAMES as BUY } from "./evm-pool-buy-mutants.mjs";
import { NAMES as INDEX } from "./evm-pool-index-mutants.mjs";
import { NAMES as SELL } from "./evm-pool-sell-mutants.mjs";
import { NAMES as QUOTE } from "./evm-quote-mutants.mjs";
import { NAMES as USD } from "./pool-usd-mutants.mjs";

for (const [name, names, least] of [["evm-quote", QUOTE, 200], ["pool-usd", USD, 100], ["evm-pool-buy", BUY, 80], ["evm-pool-sell", SELL, 100], ["evm-pool-index", INDEX, 50]]) {
  test(`${name}: the parts for every count from 1 to ${names.length} hold each mutant once, and a part past the last mutant is refused`, () => {
    assert.ok(names.length > least, `${names.length} mutants`);
    assert.deepEqual(partProblems(names), []);
    assert.throws(() => sweepPart([`${names.length + 1}/${names.length + 1}`], names), /holds no mutant/);
    assert.throws(() => sweepPart(["3/2"], names), /<k>\/<n>/);
  });
}

// the wrapper tests run the sweep as a child with MUTANT_PART as its argument: a part the sweep cannot read fails the
// wrapper at once, with the sweep's own reason, and starts no mutant
for (const wrapper of ["evm-pool-mutants.test.mjs", "pool-usd-mutants.test.mjs"]) {
  for (const part of ["0/2", "3/2", "1/2/3", ""]) {
    test(`planted: ${wrapper} with MUTANT_PART=${JSON.stringify(part)} fails with the sweep's refusal`, { timeout: 120_000 }, () => {
      const env = { ...process.env, MUTANT_PART: part };
      delete env.NODE_TEST_CONTEXT;
      const r = spawnSync(process.execPath, ["--test", fileURLToPath(new URL(`./mutants/${wrapper}`, import.meta.url))], { env, encoding: "utf8", timeout: 100_000 });
      assert.notEqual(r.status, 0, `${r.stdout}${r.stderr}`.slice(-800));
      assert.match(`${r.stdout}${r.stderr}`, /FAIL the part is <k>\/<n> with 1 <= k <= n/);
      assert.doesNotMatch(`${r.stdout}${r.stderr}`, /ok {2}mutant \d+:/);
    });
  }
}
