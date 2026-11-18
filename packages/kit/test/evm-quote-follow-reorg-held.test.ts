// node --test test/evm-quote-follow-reorg-held.test.ts (from packages/kit), the recorded quote in a cold module of its
// own. Re-review of card evm-cold-multihop-quote-inside-the-kpi, P1: the follow's pinned block, dropped by the chain, was
// still the watch's fresh head, and the quote asked again after the pin was refused took that head and read every read
// from the kept agreement there (served to any quote at that hash while the follow ran): a quote at a block the chain
// no longer holds, with no read that requires it canonical. At 9338d3b5f it returned that quote; now the kept agreement
// answers the pinned quote alone, and the quote asked again agrees on a block of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstThenFollow } from "./evm-quote-follow-fx.ts";
import { onTestClock } from "./test-clock.ts";

test("REORGH a dropped pin that is still the watch's held head is never quoted at, by the follow or by the quote asked again", () => onTestClock(async () => {
  const gone = "0x" + "9".repeat(64);
  const { q1, follow } = await firstThenFollow((_, a) => ({ ...(a as object), result: { ...((a as { result: object }).result), hash: gone } }), true);
  const got = await follow().then((q) => q.block.hash, (e: unknown) => String((e as Error)?.message ?? e));
  assert.notEqual(got, q1.block.hash, "quoted at the block the chain no longer holds");
}));
