// node --test test/evm-quote-follow-scope.test.ts (from packages/kit), the recorded quote in a cold module of its own.
// Final review of card evm-cold-multihop-quote-inside-the-kpi, P2: the kept agreement answers the pinned quote alone
// (MEMO_FOR). A quote with no `at` at the same block, the watch's held head with no confirmation of its own, sends every
// read again, each requiring the block canonical; served from the kept agreement it would send none (the guard removed,
// as the mutant run shows), and a block the chain dropped would go unseen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evmQuoteWarmReset } from "../src/checks/evm/quote.ts";
import { firstThenFollow } from "./evm-quote-follow-fx.ts";
import { onTestClock } from "./test-clock.ts";

test("SCOPE a quote with no `at` at the block a quote was pinned to reads every read again: the kept agreement is the pinned quote's alone", () => onTestClock(async () => {
  const { q1, r2, follow, plain } = await firstThenFollow(undefined, true);
  // the pinned follow first, so the kept agreement at the block is in use
  const q2 = await follow();
  assert.equal(q2.block.hash, q1.block.hash);
  const before = r2.methods.get("eth_call") ?? 0;
  assert.equal(before, 0, "the pinned follow read again");
  // asked as the follow was (no warm plan), so each of its reads is one the kept agreement holds: served from it, the
  // quote would send none
  evmQuoteWarmReset();
  await plain().catch(() => null);
  const reads = (r2.methods.get("eth_call") ?? 0) - before;
  assert.ok(reads > 0, "a quote with no `at` was answered from the kept agreement: no read required its block canonical");
}));
