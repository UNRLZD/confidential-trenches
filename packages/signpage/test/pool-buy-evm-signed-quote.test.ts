// node --test test/pool-buy-evm-signed-quote.test.ts (from packages/signpage). Card evm-tree-reads-only-when-needed: a
// shown price on a device that holds nothing is asked scanless (its pools the served index's and the helper's, no log
// read), and no buy ever signs from such a quote: the tap's quote host (evmBuyHost) passes every quote through
// signedQuote, which refuses one marked scanless; any other passes as it came.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { EvmQuoteError, type EvmPoolBuyQuote } from "../../kit/src/checks/evm/quote.ts";

const { signedQuote } = await import("../src/pool-buy-evm.ts");

const quote = { chain: "base", token: "0x" + "11".repeat(20), amountIn: 1n } as unknown as EvmPoolBuyQuote;

test("SIGNED a quote asked scanless is refused on the signing path; one scanned passes unchanged", () => {
  assert.throws(() => signedQuote({ ...quote, scanless: true }), (e: unknown) => e instanceof EvmQuoteError && e.code === "bad_request");
  assert.equal(signedQuote(quote), quote);
});

test("SIGNED the tap's quote host takes every quote through signedQuote, and only the dry's quote is ever asked scanless", () => {
  const src = readFileSync(new URL("../src/pool-buy-evm.ts", import.meta.url), "utf8");
  assert.match(src, /quote: \(req\) => pageQuote\(page\.fetch\)\(req\)\.then\(signedQuote\)/, "the tap's host signs from a quote signedQuote has not passed");
  assert.equal((src.match(/pageQuote\([^)]*scanless/g) ?? []).length, 1, "a quote other than the dry's is asked scanless");
});
