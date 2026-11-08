// The Solana pool deposit's note floor mutant sweep (test/pool-deposit-mutants.mjs, card kit-sol-pool-deposit-floor,
// audit S-01) as a test of the kit: each weakening of the floor or its comparison fails the "S-01" tests. The kit's
// test:mutants script runs this file; the sweep works in its own copy of the kit (test/mutant-copy.mjs).
//   node --test test/mutants/pool-deposit-mutants.test.mjs      (from packages/kit)
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../../scripts/group-run.mjs";

test("pool-deposit-mutants.mjs: every weakening of the note floor fails its named tests", { timeout: 600_000 }, (t) => {
  const r = runSync(process.execPath, [fileURLToPath(new URL("../pool-deposit-mutants.mjs", import.meta.url))], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeoutMs: 600_000, killSignal: "SIGTERM" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /^SURVIVED|^NOT ONCE/.test(l)).join("\n") || out.slice(-2000));
  assert.match(out, /^every one of \d+ mutants fails its named test$/m);
  t.diagnostic(out.match(/^every one of \d+ mutants fails its named test$/m)[0]);
});
