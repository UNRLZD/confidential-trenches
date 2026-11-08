// The chart's units (card app-chart-controls): Price / MCap and USD / the chain's coin, each on only when its number was
// read, the bars scaled by the one factor the marks use too, and the axis text in the unit drawn.
import assert from "node:assert/strict";
import { test } from "node:test";
import { coinUsd, factors, scaleBars, supplyOf, unitDrawn, valueText, volumeIn } from "../src/screens/token/units.ts";

test("supply: market cap over price, none when either is missing or not above zero", () => {
  assert.equal(Math.round(supplyOf({ mc_usd: "4120000", price_usd: "0.00412" })!), 1e9);
  assert.equal(supplyOf({ mc_usd: null, price_usd: "0.00412" }), null);
  assert.equal(supplyOf({ mc_usd: "4120000", price_usd: "0" }), null);
  assert.equal(supplyOf(null), null);
});

test("the coin's USD price from the device's read: price x 10^expo, none without a read", () => {
  assert.equal(coinUsd({ price: 9301048308n, expo: -8, decimals: 9 }), 93.01048308);
  assert.equal(coinUsd(null), null);
  assert.equal(coinUsd({ price: 0n, expo: -8, decimals: 9 }), null);
});

test("a toggle with no number behind it stays off; the factors follow the unit drawn", () => {
  assert.deepEqual(unitDrawn({ mc: true, quote: true }, null, null), { mc: false, quote: false });
  assert.deepEqual(unitDrawn({ mc: true, quote: true }, 1e9, 100), { mc: true, quote: true });
  assert.deepEqual(factors({ mc: true, quote: false }, 1e9, null), { price: 1e9, volume: 1 });
  assert.deepEqual(factors({ mc: true, quote: true }, 1e9, 100), { price: 1e7, volume: 0.01 });
  assert.deepEqual(factors({ mc: false, quote: false }, 1e9, 100), { price: 1, volume: 1 });
});

test("bars scale by the factors; factors of one hand back the same bars", () => {
  const bars = [{ timestamp: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];
  assert.equal(scaleBars(bars, { price: 1, volume: 1 }), bars);
  assert.deepEqual(scaleBars(bars, { price: 10, volume: 0.5 }), [{ timestamp: 1, open: 10, high: 20, low: 5, close: 15, volume: 5 }]);
});

test("axis text: Discover's price, MCap as market cap, the coin without the dollar sign", () => {
  assert.equal(valueText({ mc: false, quote: false }, "0.00412"), "$0.00412");
  assert.equal(valueText({ mc: true, quote: false }, "2570000.00"), "$2.57M");
  assert.equal(valueText({ mc: true, quote: true }, "25700.00"), "25.7K");
  assert.equal(valueText({ mc: false, quote: false }, "+5%"), "+5%");
  assert.equal(volumeIn({ mc: true, quote: false }, "1820"), "$1.82K");
  assert.equal(volumeIn({ mc: true, quote: true }, "1820"), "1.82K");
});
