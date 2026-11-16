// card market-data-matches-the-page: the push socket's readers are every chain whose tape the helper serves. Live 16 Nov
// 20:0xZ, GET /v1/market/push?chain=near&token=blackdragon.tkn.near upgraded answered 404 (Solana's 101): start() handed
// the push only the EVM chains' and Solana's swap reads (evmSwaps), never NEAR's tape (near.trades), which
// GET /v1/market/trades?chain=near serves.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pushReaders } from "./server.ts";

const reader = (tag: string) => ({ trades: async () => ({ status: 200, body: tag, src: "chain", asOfMs: 0 }) });

test("the push reads NEAR's tape beside the swap reads, and only the chains it serves", async () => {
  const solana = reader("solana");
  const base = reader("base");
  const trades = reader("near");
  const readers = pushReaders({ solana, base } as never, { trades } as never);
  assert.deepEqual(Object.keys(readers).sort(), ["base", "near", "solana"]);
  assert.equal(readers.near, trades);
  assert.equal(readers.solana, solana);
  assert.deepEqual(Object.keys(pushReaders({ solana } as never, undefined)), ["solana"], "no NEAR market, no NEAR reader");
  assert.deepEqual(pushReaders(undefined, undefined), {});
});
