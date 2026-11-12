// The NEAR swap calls' mutant sweep (test/near-swap-mutants.mjs, card near-private-trading) as a test of the kit: each
// check of the calls W signs removed fails its named test in
// test/near-swap.test.ts. The kit's test:mutants script runs this file; the sweep works in its own copy of the kit.
//   node --test test/mutants/near-swap-mutants.test.mjs      (from packages/kit)
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../../scripts/group-run.mjs";

test("near-swap-mutants.mjs: every check of the NEAR swap's calls, removed, fails its named test", { timeout: 600_000 }, (t) => {
  const r = runSync(process.execPath, [fileURLToPath(new URL("../near-swap-mutants.mjs", import.meta.url))], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeoutMs: 600_000, killSignal: "SIGTERM" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /^SURVIVED|^NOT ONCE|fail on the code/.test(l)).join("\n") || out.slice(-2000));
  assert.match(out, /^every one of \d+ mutants fails its named test$/m);
  t.diagnostic(out.match(/^every one of \d+ mutants fails its named test$/m)[0]);
});
