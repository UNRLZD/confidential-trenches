// The signing page's kit-version sweep (test/kit-version-mutants.mjs) as a test of the package: every mutant of what
// the page sends a kit-v1.4 client (src/kit-version.ts and its use in src/api.ts), each later deposit stage's mapping
// to every other kit-v1.4 stage among them, fails test/kit-version.test.ts. The package's test:mutants script runs it.
//   node --test test/kit-version-mutants.test.mjs      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
// The sweep runs in a process group of its own (scripts/group-run.mjs): at this test's timeout it gets SIGTERM, ends its
// own test runs' groups, and its group is killed after it, so nothing it started outlives this test.

test("every kit-version mutant fails the kit-version test, and the sources are left as they were", { timeout: 600_000 }, (t) => {
  const r = runSync(process.execPath, [fileURLToPath(new URL("./kit-version-mutants.mjs", import.meta.url))], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeoutMs: 600_000, killSignal: "SIGTERM" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /^(LIVE|BAD)/.test(l)).join("\n") || out.slice(-2000));
  assert.match(out, /^all \d+ mutants killed$/m);
  t.diagnostic(out.match(/^all \d+ mutants killed$/m)[0]); // the kill count, in the run's log
});
