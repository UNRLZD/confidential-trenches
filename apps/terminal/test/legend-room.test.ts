// The legend's rooms and the phone price's (card app-legend-holds-still): src/screens/token/legend.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { price } from "../src/screens/discover/format.ts";
import { keepRoom, legendRoom, legendText, priceRoom } from "../src/screens/token/legend.ts";

const bar = (i: number, p: number) => ({ timestamp: i * 900_000, open: p, high: p * 1.5, low: p * 0.5, close: p, volume: 1 });
const PRICE = { mc: false, quote: false };

test("the room of each value is the longest it takes on any bar", () => {
  const bars = [bar(0, 9.5), bar(1, 1234.5), bar(2, 12)];
  const r = legendRoom(bars, 2, PRICE);
  assert.equal(r.c, [...legendText(bars, 1, 2, PRICE).c].length);
  assert.equal(r.c, "$1,234.50".length);
  assert.equal(r.h, "$1,851.75".length);
  for (let i = 0; i < bars.length; i++) assert.ok([...legendText(bars, i, 2, PRICE).ch].length <= r.ch);
});

test("the room kept only grows for one token, timeframe and unit, and starts again on another", () => {
  const wide = legendRoom([bar(0, 1234.5)], 2, PRICE);
  const narrow = legendRoom([bar(0, 1.5)], 2, PRICE);
  const k1 = keepRoom(null, "PEPE 15m false false", wide);
  assert.deepEqual(keepRoom(k1, "PEPE 15m false false", narrow).room, wide);
  assert.deepEqual(keepRoom(k1, "PEPE 1H false false", narrow).room, narrow);
});

test("the phone price's room is the form with its trailing zeros whole", () => {
  for (const [v, whole] of [["0.0012", "0.00123"], ["0.00012", "0.000123"], ["0.1", "0.1234"], ["0.012", "0.0123"], ["0.00000012", "0.000000123"], ["12.3", "12.34"]] as const) {
    assert.equal(priceRoom(price(v)), [...price(whole)].length, `${price(v)} holds ${price(whole)}`);
  }
});
