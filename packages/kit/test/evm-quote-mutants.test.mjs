// The mutant runner's baseline judges each named test as its kill phase does: alone, by the run's exit code (re-review
// of 037627c, LOW-1: one run per file read from its TAP lines called a test that passed and then threw from a timer a
// pass, where the same test alone exits 1 and every mutant of it would count as killed).
//   node --test packages/kit/test/evm-quote-mutants.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { baseline } from "./evm-quote-mutants.mjs";

const PLANTED = `import { test } from "node:test";
test("Z1 passes, then a late unhandled rejection", async () => { setTimeout(() => Promise.reject(new Error("late")), 50); });
test("Z2 passes cleanly", () => {});
test("Y9 not named, fails", () => { throw new Error("other"); });
test("Z3 passes, then a late throw", () => { setTimeout(() => { throw new Error("late throw"); }, 50); });
`;

test("the baseline fails a named test that passes and then throws from a timer, alone and by exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "evm-quote-mutants-test-"));
  try {
    writeFileSync(join(dir, "planted.test.mjs"), PLANTED);
    const got = await baseline([dir, dir], new Map([["planted.test.mjs", ["Z1 ", "Z2 ", "Z3 ", "Z4 "]]]));
    const of = Object.fromEntries(got.map((g) => [g.name, g.r]));
    assert.deepEqual(of, { "Z1 ": "fail", "Z2 ": "pass", "Z3 ": "fail", "Z4 ": "none" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
