// SPDX-License-Identifier: Apache-2.0
// The mutation list (test/mutants.mjs) still runs: each mutant's text occurs exactly once in its file (the sweep stops
// on one that does not) and its test is a forge test in test/ ("layout" is test/layout.test.mjs). Needs no forge, so
// CI runs it with the pool's other script tests; the sweep itself needs forge and runs by hand. Pool review round 2
// found the Solana list stale after a source change, with nothing failing; this holds the EVM list the same way.
//   node --test contracts/pool-evm/test/mutants-list.test.mjs
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MUTANTS } from "./mutants.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sol = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sol(path.join(d, e.name)) : e.name.endsWith(".t.sol") ? [path.join(d, e.name)] : []));
const forge = new Set(sol(path.join(ROOT, "test")).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/function (test\w*)\s*\(/g)].map((m) => m[1])));
const known = { has: (t) => (t === "layout" ? existsSync(path.join(ROOT, "test/layout.test.mjs")) : forge.has(t)) };

/** Every reason `list` would not run: a text not exactly once in its file, a test that is no forge test. */
export function problems(list, read = (f) => readFileSync(path.join(ROOT, f), "utf8"), tests = known) {
  const out = [];
  for (const [file, text, , name] of list) {
    const n = read(file).split(text).length - 1;
    if (n !== 1) out.push(`${file} holds its text ${n} times: ${text}`);
    if (!tests.has(name)) out.push(`${name} is no test in test/`);
  }
  return out;
}

test("every mutant's text occurs exactly once in its file, and its test is a forge test", () => {
  assert.ok(MUTANTS.length > 100 && forge.size > 100, `${MUTANTS.length} mutants, ${forge.size} forge tests read`);
  assert.deepEqual(problems(MUTANTS), []);
});

test("a stale text, a text twice and an unknown test are each refused", () => {
  const read = () => "if (a) {}\nif (b) {}\nif (b) {}\n";
  const tests = new Set(["test_x"]);
  assert.match(problems([["f.sol", "if (gone) {}", "", "test_x"]], read, tests).join(), /holds its text 0 times/);
  assert.match(problems([["f.sol", "if (b) {}", "", "test_x"]], read, tests).join(), /holds its text 2 times/);
  assert.match(problems([["f.sol", "if (a) {}", "", "test_nope"]], read, tests).join(), /test_nope is no test/);
  assert.deepEqual(problems([["f.sol", "if (a) {}", "", "test_x"]], read, tests), []);
});
