// node --test apps/helper/src/data/held-budget.test.ts: card market-token-reads, live run 42760975418 (05:16Z, helper at
// 20956297). (1) Base USDC, a token no list carries, answered symbol null: GeckoTerminal names it (tokens/multi read
// 05:37Z), but the held read drew on GeckoTerminal's one keyless budget (5 calls in 75 s), in its refresh lane, which
// refuses while 3 of the 5 are taken, where the helper's own lists and ahead reads hold the window most minutes; every
// EVM token no list carries was blank in Portfolio then. (2) A held read could take one of the 5 calls a cold token
// page's holders and a chart's first bars need. The held read of a token no list carries now goes to DexScreener's
// keyless tokens/v1 (300 calls a minute, 30 addresses a call) on its own budget, so it is named on a busy window and
// never takes a GeckoTerminal call. Red at 20956297: the held read answers null and takes a GeckoTerminal call.
import assert from "node:assert/strict";
import { test } from "node:test";
import { geckoBudget } from "./gecko.ts";
import { createHeld, HELD_MAX } from "./held.ts";
import { createEvmToken } from "./evm/token.ts";
import { NOT_FOUND } from "./solana/token.ts";

const NOW = Date.parse("2026-11-10T05:16:00Z");
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const LISTED = { base: "0x9296dde9801a777ac43b48abb8372e523269adf8", robinhood: "0xe8ffd7e24187f72afb08d75b1bb13088a989a791" } as const;

/** The chain's lists answer, one row per token given. */
const listsOf = (chain: "base" | "robinhood", tokens: string[]) => ({
  get: async () => ({ status: 200, asOfMs: NOW - 5_000, body: JSON.stringify({ chain, as_of_ms: NOW - 5_000, lists: { new: tokens.map((token) => ({ chain, token, symbol: "LST", name: "Listed", price_usd: "0.5", src: "geckoterminal", as_of_ms: NOW - 5_000 })) } }) }),
  listed: async (t: string) => tokens.includes(t),
});
/** Upstream as both sources answer it: GeckoTerminal's tokens/multi and token info, DexScreener's tokens/v1. */
function upstream(hits: string[]) {
  return async (url: string): Promise<Response> => {
    hits.push(url);
    const multi = /api\.geckoterminal\.com\/api\/v2\/networks\/(\w+)\/tokens\/multi\/([^/?]+)$/.exec(url);
    if (multi) return Response.json({ data: multi[2]!.split(",").map((address) => ({ id: `${multi[1]}_${address}`, type: "token", attributes: { address, symbol: "USDC", name: "USD Coin", price_usd: "0.9983" } })) });
    const info = /api\.geckoterminal\.com\/api\/v2\/networks\/\w+\/tokens\/(0x[0-9a-f]{40})\/info$/.exec(url);
    if (info) return Response.json({ data: { id: `x_${info[1]}`, type: "token", attributes: { address: info[1], decimals: 18, holders: { count: 1234, distribution_percentage: { top_10: "41.5" }, last_updated: new Date(NOW - 60_000).toISOString() } } } });
    const dex = /api\.dexscreener\.com\/tokens\/v1\/(\w+)\/([^/?]+)$/.exec(url);
    if (dex) return Response.json(dex[2]!.split(",").map((address) => ({ chainId: dex[1], dexId: "uniswap", pairAddress: "0x0e635f8eeed4f7279d56692d552f034ece136019", baseToken: { address, symbol: "USDC", name: "USD Coin" }, quoteToken: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", name: "Wrapped Ether" }, priceUsd: "1.00011", liquidity: { usd: 127707.1 } })));
    throw new Error(`unexpected ${url}`);
  };
}
const solana = { page: async () => NOT_FOUND };

test("a token no list carries (Base USDC) is named while the helper's own reads hold GeckoTerminal's window at 3 of 5", async () => {
  const gecko = geckoBudget(() => NOW);
  // the helper's own background reads, as the deployed helper's window stood 40 of 60 minutes (evm/token.ts INFO_SERVE_MS)
  assert.ok(gecko.take("lists", true, true) && gecko.take("lists", true, true) && gecko.take("ahead"));
  const hits: string[] = [];
  const held = createHeld({ solana, lists: { base: listsOf("base", [LISTED.base]), robinhood: listsOf("robinhood", []) }, gecko, fetch: upstream(hits), now: () => NOW, sleep: async () => {} } as Parameters<typeof createHeld>[0]);
  const a = await held.read("base", [USDC, LISTED.base]);
  assert.equal(a.status, 200);
  const j = JSON.parse(a.body) as { tokens: { token: string; symbol: string | null; price_usd: string | null }[] };
  assert.equal(j.tokens[0]!.symbol, "USDC", `USDC's entry: ${JSON.stringify(j.tokens[0])}`);
  assert.match(j.tokens[0]!.price_usd ?? "", /^\d+(\.\d+)?$/);
  assert.equal(j.tokens[1]!.symbol, "LST", "a listed token stays named from its row");
});

test("held reads take no GeckoTerminal call: after a stranger's held reads on Base and Robinhood, both chains' cold holders and a chart's first bars find their calls", async () => {
  let t = NOW;
  const clock = () => t;
  const gecko = geckoBudget(clock);
  // the helper's own lists: 2 calls in the window
  assert.ok(gecko.take("lists", true, true) && gecko.take("lists", true, true));
  const hits: string[] = [];
  const fetch = upstream(hits);
  const held = createHeld({ solana, lists: { base: listsOf("base", []), robinhood: listsOf("robinhood", []) }, gecko, fetch, now: clock, sleep: async () => {} } as Parameters<typeof createHeld>[0]);
  const rand = () => `0x${Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")}`;
  for (let i = 0; i < 20; i++) await held.read(i % 2 === 0 ? "base" : "robinhood", Array.from({ length: HELD_MAX }, rand), `198.51.100.${i % 4}`);
  const gtByHeld = hits.filter((u) => u.includes("geckoterminal")).length;
  assert.equal(gtByHeld, 0, `held reads made ${gtByHeld} GeckoTerminal calls`);
  assert.equal(gecko.calls().length, 2, "the window holds only the lists' calls");
  // the cold reads a token page and a chart make, as the live suite makes them in the same minute
  const sleep = async (ms: number) => void (t += ms);
  const base = createEvmToken("base", { lists: listsOf("base", [LISTED.base]), gecko, fetch, now: clock, sleep });
  const robinhood = createEvmToken("robinhood", { lists: listsOf("robinhood", [LISTED.robinhood]), gecko, fetch, now: clock, sleep });
  assert.equal((await base.holders(LISTED.base)).status, 200, "base holders");
  assert.equal((await robinhood.holders(LISTED.robinhood)).status, 200, "robinhood holders");
  assert.ok(gecko.take("pages"), "a Solana chart's first bars find a call");
});
