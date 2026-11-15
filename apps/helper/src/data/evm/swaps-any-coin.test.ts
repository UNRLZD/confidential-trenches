// node --test apps/helper/src/data/evm/swaps-any-coin.test.ts (card evm-token-page-opens-any-coin): the gate an EVM
// token's candles and tape open behind (server.ts evmKnown), the one its page answers behind: a coin no Discover list
// served opens its chart and tape when DexScreener names a pool for it (named.ts), on the recorded Robinhood chain
// (test/evm-swaps/robinhood.ts). Red at 0322a1322: the gate was lists.ts listed alone, so such a coin's candles and
// tape answered 404 (swaps.ts mainPool "unlisted").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evmKnown } from "../../server.ts";
import { createEvmNamed } from "./named.ts";
import { CURVE_TOKEN, fakeChain, open, REC } from "../../../test/evm-swaps/robinhood.ts";

const DEX = JSON.parse(readFileSync(new URL("./fixtures/dexscreener-named.json", import.meta.url), "utf8")) as { recorded_at: string; answers: Record<string, unknown[]> };
const NOW = Date.parse(DEX.recorded_at);
const MOW = "0x0b7c6c138dc75622f4200d157b13fb93e6bd94fa";
const NOT_A_COIN = "0x0000000000000000000000000000000000000001";

test("the candles and tape gate (server.ts evmKnown): a coin no list served opens its chart and tape; an address DexScreener names nothing for is 404; DexScreener down is 503", async () => {
  const pair = DEX.answers[`robinhood:${MOW}`]![0] as Record<string, unknown>;
  // the recorded MOW pair, its base token set to the recorded chain's curve token
  const answer = [{ ...pair, pairAddress: REC.curve, baseToken: { ...(pair.baseToken as object), address: CURVE_TOKEN } }];
  let down = false;
  const fetch = async (url: string) => (down ? new Response("{}", { status: 500 }) : new Response(JSON.stringify(url.endsWith(CURVE_TOKEN) ? answer : []), { status: 200 }));
  const named = createEvmNamed("robinhood", { fetch, now: () => NOW });
  const never = { listed: async () => false };
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const s = open(chain, { t: 1_000_000 }, { pools: new Map(), listed: evmKnown(never, named), hint: async (t) => named.pool(t) });
  try {
    const tape = await s.trades(CURVE_TOKEN, 50, "1.2.3.4");
    assert.equal(tape.status, 200, tape.body);
    assert.ok((JSON.parse(tape.body) as { trades: unknown[] }).trades.length > 0, "the tape has the curve's trades");
    const bars = await s.candles(CURVE_TOKEN, "1m", null, 50, "1.2.3.4");
    assert.equal(bars.status, 200, bars.body);
    assert.equal((await s.trades(NOT_A_COIN, 50, "1.2.3.4")).status, 404);
    assert.equal((await s.candles(NOT_A_COIN, "1m", null, 50, "1.2.3.4")).status, 404);
    down = true;
    const other = "0x00000000000000000000000000000000000000aa";
    assert.equal((await s.trades(other, 50, "1.2.3.4")).status, 503, "DexScreener down: no answer, never a 404");
  } finally {
    s.stop();
  }
  // a listed token passes with no DexScreener read; one the lists never served and with no named source fails
  assert.equal(await evmKnown({ listed: async () => true }, undefined)(MOW), true);
  assert.equal(await evmKnown(never, undefined)(MOW), false);
});
