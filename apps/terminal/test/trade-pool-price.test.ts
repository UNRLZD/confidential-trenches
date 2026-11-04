// The trade box's pool price (card signpage-pool-price): TradeKit.poolPrice reads the signing page's own read in
// state.pools[chain].price and nothing else, used only while within its feed's bound (the kit's POOL_USD_FEEDS maxAgeS)
// on this device's clock. A fresh one prices the tap, so Buy turns on; a stale or missing one draws no USD and keeps Buy
// off. Planted states, as the page would send them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { POOL_USD_FEEDS, type SignpageState } from "@blindfill/kit";
import { poolBuyAsk, poolPriceEnd, poolView, statePoolPrice } from "../src/screens/trade/model.ts";

type Pool = NonNullable<SignpageState["pools"]>[number];
// Pyth SOL/USD as read on 4 Nov 07:40Z (packages/kit/src/price/pool-usd.ts): $93.01048308, published 07:40:06Z
const PUBLISHED_S = 1_793_778_006;
const PRICE = { price: "9301048308", expo: -8, published_s: PUBLISHED_S, read_ms: PUBLISHED_S * 1000 + 2_000 };
const NOW = PUBLISHED_S * 1000 + 5_000;
const sol = (price?: Pool["price"]): Pool => ({ chain: "solana", asset: "SOL", balance: "0.01", ready: "0.01", tap_max: "0.00173608", ...(price ? { price } : {}) });
const MAX_MS = POOL_USD_FEEDS.solana.maxAgeS * 1000;

test("fresh: the page's price in state.pools turns the pool Buy on, priced from that read alone", () => {
  const pools = [sol(PRICE)];
  const p = statePoolPrice(pools, "solana", NOW);
  assert.deepEqual(p, { price: 9_301_048_308n, expo: -8, decimals: 9 });
  // $0.10 at $93.01048308: 1,075,147 lamports, rounded down, under tap_max
  const ask = poolBuyAsk(pools, "solana", "Mint111", 10n, p, 1000);
  assert.deepEqual(ask, { ok: true, kind: "pool.buy", params: { chain: "solana", token: "Mint111", amount: "0.001075147", slippage_bps: 1000 } });
  const view = poolView(pools, "solana", p);
  assert.equal(view?.balance, 93n, "the pool's 0.01 SOL is $0.93");
  assert.equal(view?.tapMax, 16n, "one tap's most, 0.00173608 SOL, is $0.16");
  // at the bound: still fresh
  assert.notEqual(statePoolPrice(pools, "solana", PUBLISHED_S * 1000 + MAX_MS), null);
});

test("stale: past its feed's bound on this device's clock, or ahead of it, the price is none, so no USD and Buy stays off", () => {
  const pools = [sol(PRICE)];
  assert.equal(statePoolPrice(pools, "solana", PUBLISHED_S * 1000 + MAX_MS + 1), null, "one ms past the bound");
  const ahead = [sol({ ...PRICE, published_s: Math.floor(NOW / 1000) + 61 })];
  assert.equal(statePoolPrice(ahead, "solana", NOW), null, "more than 60 s ahead of the clock");
  assert.notEqual(statePoolPrice([sol({ ...PRICE, published_s: Math.floor(NOW / 1000) + 60 })], "solana", NOW), null, "60 s ahead: used");
  const p = statePoolPrice(pools, "solana", PUBLISHED_S * 1000 + MAX_MS + 1);
  assert.equal(poolView(pools, "solana", p), null, "no USD drawn");
  assert.deepEqual(poolBuyAsk(pools, "solana", "Mint111", 10n, p, 1000), { ok: false, why: "no_price" });
});

test("missing: no price on the entry, no entry, no pools, or NEAR: none, and Buy stays off", () => {
  assert.equal(statePoolPrice([sol()], "solana", NOW), null);
  assert.deepEqual(poolBuyAsk([sol()], "solana", "Mint111", 10n, statePoolPrice([sol()], "solana", NOW), 1000), { ok: false, why: "no_price" });
  assert.equal(statePoolPrice([sol(PRICE)], "base", NOW), null, "another chain's entry");
  assert.equal(statePoolPrice(undefined, "solana", NOW), null);
  assert.equal(statePoolPrice([], "solana", NOW), null);
  assert.equal(statePoolPrice([{ chain: "near", asset: "USDC", balance: "1", price: PRICE }], "near", NOW), null, "NEAR has no feed");
});

test("each chain's own bound: Base's and Robinhood's from their feeds; the end is published_s plus maxAgeS", () => {
  const eth = (chain: "base" | "robinhood"): Pool => ({ chain, asset: "ETH", balance: "1", price: { ...PRICE, price: "350012345678" } });
  for (const chain of ["base", "robinhood"] as const) {
    const end = (PUBLISHED_S + POOL_USD_FEEDS[chain].maxAgeS) * 1000;
    assert.equal(poolPriceEnd(eth(chain)), end);
    assert.deepEqual(statePoolPrice([eth(chain)], chain, end), { price: 350_012_345_678n, expo: -8, decimals: 18 });
    assert.equal(statePoolPrice([eth(chain)], chain, end + 1), null);
  }
  assert.equal(poolPriceEnd(sol()), null);
});

test("a clock behind the feed never stretches the bound: a price stamped 60 s ahead of its read is refused 61 s after the read (review L2)", () => {
  const readS = PUBLISHED_S;
  const ahead = [sol({ ...PRICE, published_s: readS + 60, read_ms: readS * 1000 })];
  assert.notEqual(statePoolPrice(ahead, "solana", (readS + 60) * 1000), null, "60 s after the read: used");
  assert.equal(statePoolPrice(ahead, "solana", (readS + 61) * 1000), null, "61 s after the read: refused");
  assert.equal(poolPriceEnd(ahead[0]!), (readS + POOL_USD_FEEDS.solana.maxAgeS) * 1000, "the end counts from the earlier of the two times");
});
