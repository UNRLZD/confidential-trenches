// node --test apps/helper/src/data/evm/swaps-univ2-robinhood.test.ts: card robinhood-trades-finish-filling. Robinhood has
// a Uniswap v2 factory (0x8bceaa40..., 150,503 pairs by allPairsLength(), read 2026-11-16 14:0xZ on the chain's own RPC),
// and Robinhood's venues named none: a listed coin traded only on a v2 pair (0x5d102d1e..., its pairs all
// uniswap-v2-robinhood on GeckoTerminal, the top one 0x02d356ac... with WETH) found no pool of ours, and its tape answered
// src "coingecko", which helper-robinhood-capacity and helper-robinhood-search-ahead refuse (live run 43874805885,
// 16 Nov 13:40Z). The pair, its factory and its newest Swap log are read on chain (fixtures/swaps-univ2-robinhood.json).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as S from "./swaps.ts";
import { decodeSwap, parseLog, ROBINHOOD_VENUES, swapFilter, TOPIC, VENUES, type Pool } from "./swaps.ts";

const FX = JSON.parse(readFileSync(new URL("./fixtures/swaps-univ2-robinhood.json", import.meta.url), "utf8")) as { pool: string; factory: string; asset0: string; asset1: string; log: Record<string, unknown> & { topics: string[]; transactionHash: string } };
/** Read through the namespace's types, so the file loads where the venue is missing (the red run). */
const FACTORY = (ROBINHOOD_VENUES as Record<string, unknown>).uniswapV2 as string | undefined;
const POOL = { venue: "v2", id: FX.pool, token: FX.asset1, tokenIs0: false, quote: { kind: "eth", decimals: 18 }, log: "univ2" } as Pool;

test("Uniswap v2 on Robinhood: its factory is one of Robinhood's venues, confirmed by getPair, its pairs' swaps read by Uniswap v2's own topic", () => {
  assert.equal(FACTORY, FX.factory, "Robinhood's venues name the Uniswap v2 factory");
  assert.ok(VENUES.robinhood.v2.includes(FX.factory), "a v2 factory: its pairs are pools of ours");
  assert.ok(VENUES.robinhood.uniV2.includes(FX.factory), "its pairs log Uniswap v2's Swap");
  assert.equal(VENUES.robinhood.getPool[FX.factory], "pair", "confirmed by getPair(token0, token1)");
  assert.equal(FX.asset0, ROBINHOOD_VENUES.weth, "quoted in Robinhood's WETH");
  assert.equal(FX.log.topics[0], TOPIC.swapUni2);
  assert.deepEqual(swapFilter(POOL, 1, 2, "robinhood").topics, [TOPIC.swapUni2]);
  // the pair took 537,288,763,670,287,161 wei of WETH (amount0In) and paid out 145,464.633784017876398554 of the coin
  // (amount1Out): a buy
  const l = parseLog(FX.log)!;
  assert.deepEqual(decodeSwap(POOL, l, "robinhood"), { kind: "swap", block: 115_812_643, index: 0x17, tx: FX.log.transactionHash, side: "b", amt: 145_464_633_784_017_876_398_554n, quote: 537_288_763_670_287_161n });
  // a pair's price is its reserves alone
  assert.deepEqual(S.poolStateCalls(POOL), [{ to: FX.pool, data: "0x0902f1ac" }]);
});
