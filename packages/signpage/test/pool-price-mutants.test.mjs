// The signing page's price retry sweep (test/pool-price-mutants.mjs) as a test of the package: every mutant of
// src/pool-price.ts's retry of a failed read fails pool-price.test.ts's "retry" test. The package's
// test:mutants script runs it.
//   node --test test/pool-price-mutants.test.mjs      (from packages/signpage)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("every pool price retry mutant fails the retry test, and pool-price.ts is left as it was", { timeout: 300_000 }, (t) => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./pool-price-mutants.mjs", import.meta.url))], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /^(LIVE|BAD)/.test(l)).join("\n") || out.slice(-2000));
  assert.match(out, /^all \d+ mutants killed$/m);
  t.diagnostic(out.match(/^all \d+ mutants killed$/m)[0]); // the kill count, in the run's log
});
