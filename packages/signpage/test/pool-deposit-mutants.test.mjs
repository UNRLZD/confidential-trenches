// The deposit runners' end-rule mutant sweep (test/pool-deposit-mutants.mjs) as a test of the package: every rule of
// src/pool-deposit.ts and src/pool-deposit-evm.ts that tells a deposit's end, removed or weakened one at a time, fails the
// test named for it. This file is in the package's
// test:mutants script, which CI's test job runs after the tests. The sweep changes no tracked file (each mutant is a copy).
//   node --test test/pool-deposit-mutants.test.mjs      (from packages/signpage; a heavy job on this Mac: the box)
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
// The sweep runs in a process group of its own (scripts/group-run.mjs): at this test's timeout it gets SIGTERM, ends its
// own test runs' groups, and its group is killed after it, so nothing it started outlives this test.

test("every deposit end-rule mutant fails its named test, and the runners are left as they were", { timeout: 1_200_000 }, (t) => {
  const runner = fileURLToPath(new URL("./pool-deposit-mutants.mjs", import.meta.url));
  const r = runSync(process.execPath, [runner], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeoutMs: 1_200_000, killSignal: "SIGTERM" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /^(LIVE|BAD)/.test(l)).join("\n") || out.slice(-2000));
  assert.match(out, /^all \d+ mutants killed$/m);
  t.diagnostic(out.match(/^all \d+ mutants killed$/m)[0]); // the kill count, in the run's log
});
