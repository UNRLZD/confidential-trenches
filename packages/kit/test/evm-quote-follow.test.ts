// node --test test/evm-quote-follow.test.ts (from packages/kit), the recorded quote in a cold module of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstThenFollow } from "./evm-quote-follow-fx.ts";
import { onTestClock } from "./test-clock.ts";

// Card evm-cold-multihop-quote-inside-the-kpi: the buy tap follows a refusal's reference at the refused quote's block
// (`at`). A quote at a block another quote read sends only the reads that quote's providers did not agree on there: the
// recorded USDG quote asked again at its own block sends no read at all (its one post the scan provider's head), and picks the same quote. At main it read
// every one again: 194 posts, 7 s of the clock (and a follow on Base, 0x07b3d9's WETH-USDC-coin reference, a second
// cold round of about 40 posts, 1.4 s, mainnet from the Mac 2026-11-18).
test("FOLLOW the recorded USDG quote asked again at its own block (`at`) sends no read and picks the same quote", () => onTestClock(async () => {
  const { q1, r1, r2, follow } = await firstThenFollow();
  const q2 = await follow().catch((e) => {
    throw new Error(`${e}; ${r2.posts()} posts, missed ${r2.missed.length}: ${r2.missed.slice(0, 3).join(" | ")}`);
  });
  assert.equal(q2.block.hash, q1.block.hash, "the follow read at another block");
  assert.equal(q2.amountOut, q1.amountOut);
  assert.equal(q2.minOut, q1.minOut);
  assert.deepEqual(q2.route, q1.route);
  // no read sent: what is left is the scan provider's head (the lag rule every block is held to, agreedAt) and the
  // pinned block asked by number on two providers (pinConfirm)
  assert.equal(r2.methods.get("eth_call") ?? 0, 0, `the follow sent reads: ${JSON.stringify(Object.fromEntries(r2.methods))}`);
  assert.equal(r2.methods.get("eth_getBlockByNumber"), 2, `the pin asked by number: ${JSON.stringify(Object.fromEntries(r2.methods))}`);
  assert.ok(r2.posts() <= 3, `the follow sent ${r2.posts()} posts, ${JSON.stringify(Object.fromEntries(r2.sent))}`);
  assert.ok(r1.posts() > 100, `the first sent ${r1.posts()} posts`);
}));
