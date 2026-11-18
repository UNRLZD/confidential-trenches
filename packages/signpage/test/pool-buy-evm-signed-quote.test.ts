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

// Card evm-quote-warm-from-the-coin-page: the coin page's warm quotes on the dry's own host (h.quote), so on a device that
// holds nothing it reads no log, as the dry's shown price does; it drops every answer, and asks nothing of a buy's host
test("SIGNED the coin's warm quotes on the dry's host alone: scanless where the dry is, never the tap's signing host", async () => {
  const src = readFileSync(new URL("../src/pool-buy-evm.ts", import.meta.url), "utf8");
  const warm = src.slice(src.indexOf("export async function evmDryWarm("), src.indexOf("\n}\n", src.indexOf("export async function evmDryWarm(")));
  assert.match(warm, /evmPoolBuyWarm\(\{ chain: h\.network, token \}, \{ quote: h\.quote, venues: h\.venues, indexPools: h\.indexPools \?\? \(\(\) => null\) \}\)/, "the warm quotes on a host other than the dry's");
  assert.doesNotMatch(warm, /pageQuote|signedQuote|evmBuyHost|build/, "the warm reaches a buy's quote host");
  // its quotes reach the dry host's quote alone, and its answer (scanless here) goes nowhere
  const { evmDryWarm } = await import("../src/pool-buy-evm.ts");
  const { evmBuyTapReset } = await import("../../kit/src/trade/evm/buy-tap.ts");
  evmBuyTapReset();
  const asked: unknown[] = [];
  const token = "0x" + "5c".repeat(20);
  const h = {
    network: "base" as const,
    venues: (await import("../../kit/src/trade/evm/buy-unpinned.ts")).evmPoolVenues(),
    quote: async (req: { token: string; amountIn: bigint }) => (asked.push(req), { ...quote, token: req.token, amountIn: req.amountIn, scanless: true } as unknown as EvmPoolBuyQuote),
    indexPools: () => null,
    decimals: async () => 18,
  };
  assert.equal(await evmDryWarm(h as never, token), undefined);
  assert.ok(asked.length >= 1, "the warm asked the dry host's quote nothing");
});
