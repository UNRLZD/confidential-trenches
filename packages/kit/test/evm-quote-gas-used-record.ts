// Records a real Robinhood quote, cold then warm, with each read's real gas used (card evm-quote-gas-used, review of
// e9b54f71, P2): TORCH at 100 ETH through the kit's public evmPoolBuyQuote on its pinned providers. Its cold quote has a
// call of 64 whose honest reads above an even share of 64 starve the reads behind them, so the warm quotes show which
// reads readSizes keeps apart. Every request body each quote sent and its answer, in order, and each quote's clock, for
// test/evm-quote-gas-used-replay.test.ts. Reads only: no key, no transaction, no money moves.
//   node packages/kit/test/evm-quote-gas-used-record.ts      writes test/fixtures/evm-quote-gas-used.json
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evmPoolBuyQuote, EvmQuoteError, type EvmPoolBuyQuoteRequest } from "../src/index.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
// TORCH on Robinhood: its native v4 pool, fee 0.3%, tick spacing 60 (scripts/live-checks/evm-quote-lag-held.mjs)
const TORCH = "0x000050e18ffa3f8f7ad170eb9cef160eb3ed1111";
export const REQUEST: EvmPoolBuyQuoteRequest = { chain: "robinhood", token: TORCH, amountIn: 10n ** 20n, slippageBps: 300, route: { venue: "uniswap-v4", currencyIn: ZERO, hops: [{ currency: TORCH, fee: 3000, tickSpacing: 60, hooks: ZERO, hookData: "0x" }] } };
export const QUOTES = 3;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const real = globalThis.fetch;
  const exchanges: { q: number; body: string; answer: string }[] = [];
  let quote = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const res = await real(url, init);
    const text = await res.text();
    if (res.ok && typeof init?.body === "string") exchanges.push({ q: quote, body: init.body, answer: text });
    return new Response(text, { status: res.status, headers: res.headers });
  }) as typeof fetch;
  const quotes: { now: number; outcome: string }[] = [];
  for (let q = 0; q < QUOTES; q++) {
    quote = q;
    const now = Date.now();
    let outcome: string;
    try {
      await evmPoolBuyQuote(REQUEST);
      outcome = "ok";
    } catch (e) {
      if (!(e instanceof EvmQuoteError)) throw e;
      outcome = e.code;
    }
    quotes.push({ now, outcome });
    console.log(`quote ${q}: ${outcome} in ${Date.now() - now} ms`);
    await new Promise((r) => setTimeout(r, 1_500));
  }
  const out = fileURLToPath(new URL("./fixtures/evm-quote-gas-used.json", import.meta.url));
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), quotes, exchanges }) + "\n");
  console.log(`${exchanges.length} exchanges, ${quotes.map((q) => q.outcome).join(",")} -> ${out}`);
  process.exit(0);
}
