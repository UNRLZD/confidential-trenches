// node --test scripts/live-checks/evm-pool-pins.test.mjs: card evm-pool-pins's live check, replayed.
// evm-pool-pins.answers.json holds a real run (2026-11-09 from this Mac): good, the pins the testnet build carries, each
// pool's deploy receipt and code the same on both RPCs and the deployed helper's fee answer naming the pin's fee
// recipient; bad, the 3 Nov pools of pool-evm-deploy.md at their own deploy blocks, which the helper answers 404.
// Good passes; the bad run fails, and so do the good answers under a pin moved by one field.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BEFORE, check, PINS, replayer } from "./evm-pool-pins.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-pool-pins.answers.json", import.meta.url), "utf8"));
const opts = { epochMs: A.epochMs };

test("the recorded good answer passes: both testnet pins, read on two RPCs each and on the helper", async () => {
  const r = await check(replayer(A.good.log), opts);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 14);
  assert.ok(r.lines.every((l) => l.startsWith("ok  ")), r.lines.join("\n"));
});

test("the recorded bad answer fails: the 3 Nov pools, which no helper serves", async () => {
  const r = await check(replayer(A.bad.log), { ...opts, pins: BEFORE, txOf: (n) => BEFORE[n].tx });
  assert.equal(r.ok, false);
  const fails = r.lines.filter((l) => l.startsWith("FAIL"));
  assert.equal(fails.length, 2, r.lines.join("\n"));
  for (const l of fails) assert.match(l, /the helper's fee answer \(HTTP 404\)/);
});

for (const [field, value] of [["pool", "0xb239a38af69b68e6c5c305df64985f283b5d5fe5"], ["feeRecipient", "0x000000000000000000000000000000000000beef"], ["fromBlock", "55524041"]]) {
  test(`the good answers fail under a Base Sepolia pin with another ${field}`, async () => {
    const pins = { ...PINS, "base-sepolia": { ...PINS["base-sepolia"], [field]: value } };
    // a moved pool asks for other code and another fee answer, which the good run never read: the check fails either way
    const r = await check(async (url, body) => replayer(A.good.log)(url, body).catch(() => ({ status: 404, json: null })), { ...opts, pins });
    assert.equal(r.ok, false, r.lines.join("\n"));
  });
}

test("a run that names one testnet only fails", async () => {
  const r = await check(replayer(A.good.log), { ...opts, pins: { "base-sepolia": PINS["base-sepolia"] } });
  assert.equal(r.ok, false);
});
