// node --test test/evm-quote-follow-reorg.test.ts (from packages/kit), the recorded quote in a cold module of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstThenFollow } from "./evm-quote-follow-fx.ts";
import { onTestClock } from "./test-clock.ts";

// Review of the card, P3-1: a follow answered wholly from the kept agreement sends no read that requires its block
// canonical. The pin is asked by number beside the reads; a provider holding another block at that height refuses
// it, and the quote is asked again at a block agreed now. At d05d3ceaa the follow returned a quote at the block the chain dropped.
test("REORG a pinned block a provider no longer holds at its height is never quoted at: the quote is asked again at a new head", () => onTestClock(async () => {
  const gone = "0x" + "9".repeat(64);
  const { q1, follow, heads } = await firstThenFollow((_, a) => ({ ...(a as object), result: { ...((a as { result: object }).result), hash: gone } }));
  const got = await follow().then((q) => q.block.hash, (e: unknown) => String((e as Error)?.message ?? e));
  assert.notEqual(got, q1.block.hash, "quoted at the block the chain no longer holds");
  // asked again on a block agreed now, never the watch's held one (re-review P1): here the recording's head is the
  // same height, which its providers now hold another block at, so that agreement refuses too
  assert.equal(heads(), 0, "asked the watch for its held head");
  assert.match(got, /^rpc_disagree: the providers hold different blocks at /);
}));
