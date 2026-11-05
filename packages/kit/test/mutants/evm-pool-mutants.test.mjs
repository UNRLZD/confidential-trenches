// The EVM pool buy's and sell's mutant sweeps (test/evm-pool-buy-mutants.mjs, test/evm-pool-sell-mutants.mjs) as tests
// of the kit: every check, removed or weakened one at a time, fails the test named for it. A sweep that no command runs
// holds nothing; the kit's test:mutants script runs this file (card fresh-run-margin: CI's test jobs run it after the
// tests, and the README's fresh run leaves it out). Each sweep works in its own copy of the kit (test/mutant-copy.mjs),
// so the kit's other tests, run beside it, never read a mutant.
//   node --test test/mutants/evm-pool-mutants.test.mjs      (from packages/kit; a heavy job on this Mac: the box)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

for (const [name, done] of [
  ["evm-pool-buy-mutants.mjs", /^every one of \d+ mutants fails its named test$/m],
  ["evm-pool-sell-mutants.mjs", /^every one of \d+ mutants fails its named test$/m],
]) {
  test(`${name}: every mutant fails its named test`, { timeout: 1_800_000 }, (t) => {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL(`../${name}`, import.meta.url))], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    assert.equal(r.status, 0, out.split("\n").filter((l) => /^FAIL/.test(l)).join("\n") || out.slice(-2000));
    assert.match(out, done);
    t.diagnostic(out.match(done)[0]); // the kill count, in the run's log
  });
}
