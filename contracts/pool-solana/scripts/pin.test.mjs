// SPDX-License-Identifier: Apache-2.0
// The pinned code hash (scripts/pin.mjs): the findings file holds exactly one, a code whose sha256 differs is refused,
// and the CLI that CI's pool-solana job runs exits 1 on a planted mismatch and 0 on the pinned bytes' hash.
//   node --test contracts/pool-solana/scripts/pin.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pinnedSha, pinRefusal, readPin } from "./pin.mjs";

const PIN = readPin();
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "pin.mjs");

test("the findings file pins one code hash, and the pin reads only a whole line of its own", () => {
  assert.match(PIN, /^[0-9a-f]{64}$/);
  const h = "ab".repeat(32);
  assert.equal(pinnedSha(`x\nProgram sha256: \`${h}\` (the build)\n`), h);
  assert.throws(() => pinnedSha("no pin here\n"), /0 "Program sha256:" lines/);
  assert.throws(() => pinnedSha(`Program sha256: \`${h}\`\nProgram sha256: \`${"cd".repeat(32)}\`\n`), /2 "Program sha256:" lines/);
  assert.throws(() => pinnedSha(`Program sha256: \`${h.slice(2)}\`\n`), /0 "Program sha256:" lines/);
  assert.throws(() => pinnedSha(`a note: Program sha256: \`${h}\`\n`), /0 "Program sha256:" lines/);
});

test("a code whose sha256 is not the pin is refused; the pin itself passes", () => {
  assert.equal(pinRefusal(PIN, PIN), null);
  assert.match(pinRefusal("0".repeat(64), PIN), new RegExp(`sha256 0{64} is not the pinned ${PIN}`));
});

test("the CLI CI runs: a planted mismatch exits 1, and no file is a usage error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pin-test-"));
  try {
    const so = path.join(dir, "blindfill_pool_solana.so");
    writeFileSync(so, "not the pinned code");
    const r = spawnSync(process.execPath, [CLI, so], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /is not the pinned/);
    assert.notEqual(spawnSync(process.execPath, [CLI], { encoding: "utf8" }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
