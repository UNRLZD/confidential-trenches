// card evm-pool-index-from-the-first-pool: the page asks the helper for a token's pools beside its quote, once a minute
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVM_SERVED_FRESH_MS, evmServedAsk, evmServedReset } from "../src/evm-served.ts";
import { evmPoolIndexReset } from "../../kit/src/checks/evm/quote.ts";

test("the helper's pools of a token are asked as its quote starts, once a minute a token, on Base and Robinhood only", async () => {
  const asked: string[] = [];
  const f = (async (url: string) => (asked.push(url), new Response(JSON.stringify({ complete: false }), { status: 200 }))) as typeof fetch;
  const T = "0x00000000000000000000000000000000000ABCde";
  try {
    evmServedAsk(f, "https://helper.test", "robinhood", T, 1_000);
    assert.deepEqual(asked, ["https://helper.test/v1/market/pools?chain=robinhood&token=0x00000000000000000000000000000000000abcde"]);
    evmServedAsk(f, "https://helper.test", "robinhood", T.toLowerCase(), 1_000 + EVM_SERVED_FRESH_MS - 1);
    assert.equal(asked.length, 1, "asked again inside the minute");
    evmServedAsk(f, "https://helper.test", "base", T, 2_000);
    assert.equal(asked.length, 2, "another chain is another ask");
    evmServedAsk(f, "https://helper.test", "robinhood", T, 1_000 + EVM_SERVED_FRESH_MS);
    assert.equal(asked.length, 3, "a minute on, asked again");
    evmServedAsk(f, "https://helper.test", "base-sepolia", T, 9_000);
    evmServedAsk(f, "https://helper.test", "base", "0x12", 9_000);
    assert.equal(asked.length, 3, "no ask for a test network or a malformed token");
    // a failing helper is no error of the page's: the kit holds the failure as no answer
    evmServedAsk((async () => Promise.reject(new Error("down"))) as typeof fetch, "https://helper.test", "robinhood", "0x" + "11".repeat(20), 9_000);
    await new Promise((r) => setImmediate(r));
  } finally {
    evmServedReset();
    evmPoolIndexReset();
  }
});
