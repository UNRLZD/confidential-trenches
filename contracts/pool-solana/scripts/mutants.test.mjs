// SPDX-License-Identifier: Apache-2.0
// The mutation list (scripts/mutants.mjs) still runs: each mutant's text occurs exactly once in its file (the sweep
// throws on the first that does not, so one stale entry stops it all) and its test is a test in svm-tests. Needs no
// SBF build, so CI runs it on every change; the sweep itself needs cargo-build-sbf. Pool review round 2 found the list
// stale after a source change, with nothing failing.
//   node --test contracts/pool-solana/scripts/mutants.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MUTANTS } from "./mutants.mjs";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = join(here, "svm-tests/tests");
const svm = readdirSync(TESTS).filter((f) => f.endsWith(".rs")).map((f) => readFileSync(join(TESTS, f), "utf8")).join("\n");
const tests = new Set([...svm.matchAll(/#\[test\]\s*(?:#\[[^\]]*\]\s*)*fn (\w+)\s*\(/g)].map((m) => m[1]));

/** Every reason `list` would not run: a text not exactly once in its file, a test that is no svm test, a name twice. */
export function problems(list, read = (f) => readFileSync(join(here, f), "utf8"), known = tests) {
  const out = [];
  const seen = new Set();
  for (const [name, file, from, , testName, extra] of list) {
    if (seen.has(name)) out.push(`${name}: the name is used twice`);
    seen.add(name);
    for (const [f, t] of [[file, from], ...(extra ? [[extra[0], extra[1]]] : [])]) {
      const n = read(f).split(t).length - 1;
      if (n !== 1) out.push(`${name}: ${f} holds its text ${n} times: ${t.split("\n")[0]}`);
    }
    if (!known.has(testName)) out.push(`${name}: ${testName} is no test in svm-tests`);
  }
  return out;
}

test("every mutant's text occurs exactly once in its file, and its test is an svm test", () => {
  assert.ok(MUTANTS.length > 50 && tests.size > 50, `${MUTANTS.length} mutants, ${tests.size} tests read`);
  assert.deepEqual(problems(MUTANTS), []);
});

test("a stale text, a text twice, an unknown test and a name used twice are each refused", () => {
  const read = () => "if a {\nif b {\nif b {\n";
  const known = new Set(["t"]);
  assert.match(problems([["m", "f.rs", "if gone {", "", "t"]], read, known).join(), /holds its text 0 times/);
  assert.match(problems([["m", "f.rs", "if b {", "", "t"]], read, known).join(), /holds its text 2 times/);
  assert.match(problems([["m", "f.rs", "if a {", "", "t", ["g.rs", "if gone {", ""]]], read, known).join(), /g\.rs holds its text 0 times/);
  assert.match(problems([["m", "f.rs", "if a {", "", "no_such_test"]], read, known).join(), /no_such_test is no test/);
  assert.match(problems([["m", "f.rs", "if a {", "", "t"], ["m", "f.rs", "if a {", "", "t"]], read, known).join(), /used twice/);
  assert.deepEqual(problems([["m", "f.rs", "if a {", "", "t"]], read, known), []);
});
