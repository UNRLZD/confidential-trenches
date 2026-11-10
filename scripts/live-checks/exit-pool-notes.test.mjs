// Replays exit-pool-notes.answers.json through the live check: the recorded good answer (devnet and mainnet, every
// listed mark and page read on both RPCs, the pages counting every mark) passes; each recorded bad answer (one lie
// planted in the good one by the tool's --bad) fails on its own line.
//   node --test scripts/live-checks/exit-pool-notes.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { check } from "./exit-pool-notes.mjs";

const FILE = fileURLToPath(new URL("./exit-pool-notes.answers.json", import.meta.url));
const A = JSON.parse(readFileSync(FILE, "utf8"));

test("the recorded good answer passes: devnet and mainnet, every mark listed and read on both RPCs", async () => {
  const r = await check(["--replay", FILE]);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => /^ok {3}(devnet|mainnet): every listed mark on both RPCs/.test(l)).length, 2, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^ok {3}mainnet: https:\/\/solana-rpc\.publicnode\.com\/ read every mark and page by address only/.test(l)), r.lines.join("\n"));
});

for (const bad of A.bad) {
  test(`recorded bad answer fails: ${bad.name}`, async () => {
    const r = await check(["--replay", FILE, "--bad", JSON.stringify(bad)]);
    assert.equal(r.ok, false, r.lines.join("\n"));
    assert.match(r.lines.filter((l) => l.startsWith("FAIL")).join("\n"), new RegExp(bad.fails, "m"));
  });
}
