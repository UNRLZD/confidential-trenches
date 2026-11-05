// The pool rules' mutant sweep (test/rules-pool-mutants.mjs) as a test of the package: every check in src/rules/pool.ts,
// removed or weakened one at a time, fails the test named for it. A sweep that no command runs holds nothing; this file
// is in the package's test:mutants script, which CI's test job runs after the tests (card fresh-run-margin). The
// sweep changes no tracked file (each mutant is a copy).
//   node --test test/rules-pool-mutants.test.mjs      (from packages/signpage; a heavy job on this Mac: the box)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("every pool rule mutant fails its named test, and pool.ts is left as it was", { timeout: 1_200_000 }, () => {
  const runner = fileURLToPath(new URL("./rules-pool-mutants.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [runner], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /^(LIVE|BAD)/.test(l)).join("\n") || out.slice(-2000));
  assert.match(out, /^all \d+ mutants killed$/m);
});
