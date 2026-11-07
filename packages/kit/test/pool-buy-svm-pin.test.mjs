// SPDX-License-Identifier: Apache-2.0
// test/svm/pool-buy.svm.mjs runs the Solana pool program from POOL_SO in LiteSVM: it must be the pinned code
// (contracts/pool-solana/scripts/pin.mjs), the bytes the deploy ships, and any other file stops the run by name before
// it loads LiteSVM or reads an RPC (card vault-sandbox-shipped-bytes). The pinned file itself is CI's pool-solana build
// (pin.test.mjs holds the pin's own check); here each refusal is planted.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readPin } from "../../../contracts/pool-solana/scripts/pin.mjs";

const SCRIPT = fileURLToPath(new URL("./svm/pool-buy.svm.mjs", import.meta.url));
// a mint the usage takes; the run stops before it is read
const MINT = "So11111111111111111111111111111111111111112";
const run = (env) => {
  const { LITESVM_DIR, POOL_SO, ...rest } = process.env;
  return spawnSync(process.execPath, [SCRIPT, "pump-curve", MINT], { encoding: "utf8", env: { ...rest, ...env }, timeout: 20_000 });
};

test("planted: a POOL_SO that is not the pinned pool code stops the run by name, before LiteSVM", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pool-buy-pin-"));
  try {
    const so = path.join(dir, "blindfill_pool_solana.so");
    const bytes = Buffer.from("another build of the pool program");
    writeFileSync(so, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const r = run({ POOL_SO: so });
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(`POOL_SO ${so}: the code's sha256 ${sha} is not the pinned ${readPin()}`), r.stderr);
    // it stopped there: LiteSVM (LITESVM_DIR, unset here) was never asked for
    assert.ok(!r.stderr.includes("LITESVM_DIR is not set"), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planted: no POOL_SO stops the run by name", () => {
  const r = run({});
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /POOL_SO is not set/);
});
