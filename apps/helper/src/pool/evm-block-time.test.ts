// Card base-200ms-blocks: the order sender's waits that stood for Base blocks are held to the time they stand for.
// Base makes a block every 200 ms since block 53556127 (2026-11-05 18:00:01Z; 2 s before), Robinhood one every 101 ms
// (both read 2026-11-05 20:38Z on two providers each). At 2 s a held answer's retry after a send was 10 of Base's blocks
// now, and the first receipt read of a send came 10 blocks after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as evm from "./evm.ts";

const BASE_BLOCK_MS = 200;

test("a held answer whose tend sent something retries in the least Retry-After says, 1 s (five Base blocks), for 10 s after the send", () => {
  assert.equal(evm.EVM_LANE_SENT_RETRY_S, 1);
  assert.equal(evm.EVM_LANE_SENT_WINDOW_MS, 10_000);
});

test("a send's receipt is first read two Base blocks after it, and the reads back off to the same 30 s", () => {
  assert.equal(evm.EVM_SELL_RECEIPT_POLL_MS, 2 * BASE_BLOCK_MS);
  assert.equal(evm.EVM_SELL_RECEIPT_POLL_MS * evm.EVM_RECEIPT_POLL_BACKOFF, 30_000);
});
