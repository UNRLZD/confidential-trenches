// The Rhea classic quote's mutant sweep (test/near-rhea-mutants.mjs, card near-view-rhea) as a test of the kit: each
// weakening of the pool math, the two providers' agreement or the token fee fails its named test in
// test/near-rhea.test.ts. The kit's test:mutants script runs this file; the sweep works in its own copy of the kit.
//   node --test test/mutants/near-rhea-mutants.test.mjs      (from packages/kit)
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../../scripts/group-run.mjs";

test("near-rhea-mutants.mjs: every weakening of the Rhea quote fails its named test", { timeout: 600_000 }, (t) => {
  const r = runSync(process.execPath, [fileURLToPath(new URL("../near-rhea-mutants.mjs", import.meta.url))], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeoutMs: 600_000, killSignal: "SIGTERM" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /^SURVIVED|^NOT ONCE|fail on the code/.test(l)).join("\n") || out.slice(-2000));
  assert.match(out, /^every one of \d+ mutants fails its named test$/m);
  t.diagnostic(out.match(/^every one of \d+ mutants fails its named test$/m)[0]);
});
