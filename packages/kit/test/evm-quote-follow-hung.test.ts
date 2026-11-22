// node --test test/evm-quote-follow-hung.test.ts (from packages/kit), the recorded quote in a cold module of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstThenFollow } from "./evm-quote-follow-fx.ts";
import { onTestClock } from "./test-clock.ts";

// Card evm-warm-tap-ends-inside-two-seconds, round (E): a follow at the block the device's watch holds (the buy tap's
// second quote) confirms that block by number on two providers beside its reads (pinConfirm). It asked its first two
// at once and waited for both, so one post hung to its provider's 10 s timeout held the follow 10 s. A post out past
// its provider's hedge time (evmHedgeAfter: here 400 ms, every answer 200 ms) has the next provider asked in its place.
test("H2 the follow's pinned block confirmed: a post hung to its 10 s timeout adds at most the hedge time and a stand-in's answer", () => onTestClock(async () => {
  const { q1, r2, follow } = await firstThenFollow(undefined, false, true);
  const t0 = performance.now();
  const q2 = await follow();
  const ms = performance.now() - t0;
  assert.equal(r2.hung(), 1, "the planted post was never sent");
  assert.equal(q2.block.hash, q1.block.hash, "the follow read at another block");
  assert.equal(q2.amountOut, q1.amountOut);
  // the follow's own posts (the scan provider's head, the pin on two providers, 200 ms each) and the hedge time and
  // a stand-in's answer; a hang waited out is 10 s
  assert.ok(ms <= 1_500, `the hung post held the follow ${Math.round(ms)} ms (${r2.posts()} posts)`);
}));
