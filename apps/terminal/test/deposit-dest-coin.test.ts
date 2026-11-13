// node --test apps/terminal/test/deposit-dest-coin.test.ts: a place picked on the deposit sheet's To row starts on its own
// coin (card deposit-pool-picks-its-own-coin; owner 13 Nov 08:12Z: Solana, Base and Robinhood all drew USDC on NEAR):
// the NEAR vault USDC on NEAR, the Solana pool SOL on Solana, the Base pool ETH on Base, the Robinhood pool ETH on
// Robinhood; with that coin not listed, the first asset on the place's chain; with none on it, the list's first.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DESTS, destAsset, pickAsset } from "../src/screens/deposit/model.ts";
import type { Asset, Dest } from "../src/screens/deposit/model.ts";

const A = (symbol: string, chain: string): Asset => ({ id: `${chain}:${symbol}`, chain, symbol, min: "1", max_usd: null });
// every place's own coin listed, after the other coins on its chain so the order alone cannot pass it
const FULL = [A("USDC", "NEAR"), A("NEAR", "NEAR"), A("USDC", "Solana"), A("SOL", "Solana"), A("USDC", "Base"), A("ETH", "Base"), A("USDC", "Robinhood"), A("ETH", "Robinhood")];
// the list the signing page answers today (packages/signpage/src/rules/deposit-dry.ts DEPOSIT_ASSET_CHAINS): USDC on NEAR,
// Solana and Base
const TODAY = [A("USDC", "NEAR"), A("USDC", "Solana"), A("USDC", "Base")];

const drawn = (assets: Asset[], d: Dest) => {
  const a = pickAsset(assets, destAsset(assets, d));
  return a && `${a.symbol} ${a.chain}`;
};

for (const [d, want] of [["near", "USDC NEAR"], ["solana", "SOL Solana"], ["base", "ETH Base"], ["robinhood", "ETH Robinhood"]] as const) {
  test(`the ${d} place starts on ${want}`, () => {
    assert.equal(drawn(FULL, d), want);
  });
}

test("with its own coin not listed, a place starts on its chain's first asset, else the list's first", () => {
  assert.deepEqual(DESTS.map((d) => drawn(TODAY, d)), ["USDC NEAR", "USDC Solana", "USDC Base", "USDC NEAR"]);
});

test("no list: no asset yet", () => {
  assert.equal(destAsset(null, "solana"), null);
  assert.equal(destAsset([], "base"), null);
});
