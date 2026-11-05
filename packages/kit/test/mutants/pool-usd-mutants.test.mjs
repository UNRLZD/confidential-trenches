// The price reads' mutant sweep (test/pool-usd-mutants.mjs) as a test of the kit: every agreement and staleness check
// of src/price/pool-usd.ts, removed or weakened one at a time, fails the tests named for it. A sweep that no command
// runs holds nothing; the kit's test:mutants script runs this file (card fresh-run-margin: CI's test jobs run it
// after the tests, and the README's fresh run leaves it out). The sweep works in its own copy of the kit
// (test/mutant-copy.mjs), so the kit's other tests, run beside it, never read a mutant.
//   node --test test/mutants/pool-usd-mutants.test.mjs      (from packages/kit)
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../../scripts/group-run.mjs";
// The sweep runs in a process group of its own (scripts/group-run.mjs): at this test's timeout it gets SIGTERM, ends its
// own test runs' groups, and its group is killed after it, so nothing it started outlives this test.

test("pool-usd-mutants.mjs: every agreement and staleness mutant fails its named tests", { timeout: 600_000 }, (t) => {
  const r = runSync(process.execPath, [fileURLToPath(new URL("../pool-usd-mutants.mjs", import.meta.url))], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeoutMs: 600_000, killSignal: "SIGTERM" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /^FAIL/.test(l)).join("\n") || out.slice(-2000));
  assert.match(out, /^every one of \d+ mutants fails its named test$/m);
  t.diagnostic(out.match(/^every one of \d+ mutants fails its named test$/m)[0]); // the kill count, in the run's log
});
