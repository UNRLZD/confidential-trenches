// The Raydium CLMM market read's mutant sweep (test/solana-clmm-mutants.mjs, card solana-buy-never-below-a-hidden-market)
// as a test of the kit: each weakening of the read fails its named tests. The kit's test:mutants script runs this file;
// the sweep works in its own copy of the kit (test/mutant-copy.mjs).
//   node --test test/mutants/solana-clmm-mutants.test.mjs      (from packages/kit)
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../../scripts/group-run.mjs";

test("solana-clmm-mutants.mjs: every weakening of the CLMM market read fails its named tests", { timeout: 600_000 }, (t) => {
  const r = runSync(process.execPath, [fileURLToPath(new URL("../solana-clmm-mutants.mjs", import.meta.url))], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeoutMs: 600_000, killSignal: "SIGTERM" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, out.split("\n").filter((l) => /^SURVIVED|^NOT ONCE/.test(l)).join("\n") || out.slice(-2000));
  assert.match(out, /^every one of \d+ mutants fails its named test$/m);
  t.diagnostic(out.match(/^every one of \d+ mutants fails its named test$/m)[0]);
});
