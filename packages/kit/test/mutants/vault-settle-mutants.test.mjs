// The settle's refund-pick mutant sweep (test/vault-settle-mutants.mjs, card vault-kit-settle) as a test of the kit: each
// wrong pick of the refund note (by commitment only, the first leaf on R, the lowest index) fails the "refund by leaf"
// tests. The kit's test:mutants script runs this file; the sweep works in its own copy of the kit (test/mutant-copy.mjs).
//   node --test test/mutants/vault-settle-mutants.test.mjs      (from packages/kit)
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../../scripts/group-run.mjs";

test("vault-settle-mutants.mjs: every wrong refund pick fails its named tests", { timeout: 600_000 }, (t) => {
  const r = runSync(process.execPath, [fileURLToPath(new URL("../vault-settle-mutants.mjs", import.meta.url))], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeoutMs: 600_000, killSignal: "SIGTERM" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /^SURVIVED|^NOT ONCE/.test(l)).join("\n") || out.slice(-2000));
  assert.match(out, /^every one of \d+ mutants fails its named test$/m);
  t.diagnostic(out.match(/^every one of \d+ mutants fails its named test$/m)[0]);
});
