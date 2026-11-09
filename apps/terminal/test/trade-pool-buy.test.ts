// The trade box's buy and sell on the pool path (card trade-box-pool; plan v2 A2): the USD the box shows turned into the
// pool asset's units the tap spends, rounded down as the kit's poolUsdToUnits rounds (a tap never spends more than the
// USD asked), the pool's balance and the most one tap can spend drawn in USD, and the ask the box sends: pool.buy only
// with a proof ready and at most `tap_max`, a whole chunk on Base and Robinhood (the signing page refuses any other EVM
// amount, rules/pool.ts checkEvmBuy), pool.sell for the position's units. Planted pools and prices.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageState } from "@blindfill/kit";
import { amountText, amountWrong, centsToUnits, decimalToUnits, parseUsd, poolBuyAsk, poolSellAsk, poolView, presetsOf, PRESETS, unitsToCents, unitsToDecimal } from "../src/screens/trade/model.ts";

type Pool = NonNullable<SignpageState["pools"]>[number];
// Pyth SOL/USD as read on 4 Nov 07:40Z (packages/kit/src/price/pool-usd.ts): $93.01048308
const SOL = { price: 9_301_048_308n, expo: -8, decimals: 9 };
// a Chainlink ETH/USD answer: $3,500.12345678
const ETH = { price: 350_012_345_678n, expo: -8, decimals: 18 };
const sol = (balance: string, ready?: string, tap_max?: string): Pool => ({ chain: "solana", asset: "SOL", balance, ...(ready === undefined ? {} : { ready }), ...(tap_max === undefined ? {} : { tap_max }) });
const base = (balance: string, ready?: string, tap_max?: string): Pool => ({ chain: "base", asset: "ETH", balance, ...(ready === undefined ? {} : { ready }), ...(tap_max === undefined ? {} : { tap_max }) });

test("USD cents to the asset's base units, rounded down; and back, rounded down", () => {
  assert.equal(centsToUnits(2_500n, SOL), 268_786_906n);
  assert.equal(centsToUnits(1_000n, SOL), 107_514_762n);
  assert.equal(centsToUnits(2_500n, ETH), 7_142_605_199_131_801n);
  assert.equal(centsToUnits(0n, SOL), 0n);
  assert.equal(unitsToCents(268_786_906n, SOL), 2_499n);
  assert.equal(unitsToCents(10n ** 16n, ETH), 3_500n);
  // a price with a positive exponent and an asset with few decimals take the other branch of each
  assert.equal(centsToUnits(2_500n, { price: 2n, expo: 1, decimals: 0 }), 1n);
  assert.equal(unitsToCents(3n, { price: 2n, expo: 1, decimals: 0 }), 6_000n);
});

test("a whole-unit decimal to base units and back: plain decimals only, never more digits than the asset has", () => {
  assert.equal(decimalToUnits("0.2", 9), 200_000_000n);
  assert.equal(decimalToUnits("12", 9), 12_000_000_000n);
  assert.equal(decimalToUnits("0.123456789", 9), 123_456_789n);
  for (const bad of ["", "-1", "1e3", ".5", "1.", " 1", "0.1234567891", "0x10"]) assert.equal(decimalToUnits(bad, 9), null, JSON.stringify(bad));
  assert.equal(unitsToDecimal(268_786_906n, 9), "0.268786906");
  assert.equal(unitsToDecimal(200_000_000n, 9), "0.2");
  assert.equal(unitsToDecimal(12_000_000_000n, 9), "12");
  assert.equal(unitsToDecimal(10n ** 16n, 18), "0.01");
});

test("the pool as the box draws it: balance and the per-tap max in USD, the proof's state; none without a price or an entry", () => {
  assert.deepEqual(poolView([sol("1.25", "0.4", "0.3")], "solana", SOL), { asset: "SOL", balance: 11_626n, tapMax: 2_790n, proof: "ready" });
  assert.deepEqual(poolView([sol("0.2", "0")], "solana", SOL), { asset: "SOL", balance: 1_860n, tapMax: null, proof: "making" });
  assert.equal(poolView([sol("0.2", "0.2", "0.1")], "solana", null), null);
  assert.equal(poolView([], "solana", SOL), null);
  assert.equal(poolView(undefined, "solana", SOL), null);
  assert.equal(poolView([sol("0.2", "0.2", "0.1")], "near", SOL), null);
  assert.equal(poolView([sol("abc", "0.2", "0.1")], "solana", SOL), null);
});

test("pool.buy: the asked USD in SOL, only with a proof ready and at most what one tap can spend", () => {
  const ready = [sol("1.25", "0.4", "0.3")];
  assert.deepEqual(poolBuyAsk(ready, "solana", "Mint1", 2_500n, SOL, 1_000), { ok: true, kind: "pool.buy", params: { chain: "solana", token: "Mint1", amount: "0.268786906", slippage_bps: 1_000 } });
  // $30 is 0.322544... SOL, above the 0.3 one tap can spend
  assert.deepEqual(poolBuyAsk(ready, "solana", "Mint1", 3_000n, SOL, 1_000), { ok: false, why: "over_tap" });
  assert.deepEqual(poolBuyAsk([sol("0.2", "0")], "solana", "Mint1", 1_000n, SOL, 1_000), { ok: false, why: "no_proof" });
  assert.deepEqual(poolBuyAsk([sol("0.2")], "solana", "Mint1", 1_000n, SOL, 1_000), { ok: false, why: "no_proof" });
  // ready but a page that cannot price the pool sends no tap_max: nothing says what one tap can spend
  assert.deepEqual(poolBuyAsk([sol("0.2", "0.2")], "solana", "Mint1", 1_000n, SOL, 1_000), { ok: false, why: "no_proof" });
  assert.deepEqual(poolBuyAsk(ready, "solana", "Mint1", 1_000n, null, 1_000), { ok: false, why: "no_price" });
  assert.deepEqual(poolBuyAsk(ready, "solana", "Mint1", 0n, SOL, 1_000), { ok: false, why: "too_small" });
  assert.deepEqual(poolBuyAsk(ready, "near", "Mint1", 1_000n, SOL, 1_000), { ok: false, why: "no_pool" });
});

test("pool.buy on Base and Robinhood spends a whole chunk: only the chunk's own USD asks for it", () => {
  const pools = [base("0.03", "0.02", "0.01")];
  assert.deepEqual(poolBuyAsk(pools, "base", "0xabc", 3_500n, ETH, 500), { ok: true, kind: "pool.buy", params: { chain: "base", token: "0xabc", amount: "0.01", slippage_bps: 500 } });
  assert.deepEqual(poolBuyAsk(pools, "base", "0xabc", 2_500n, ETH, 500), { ok: false, why: "chunk" });
  assert.deepEqual(poolBuyAsk(pools, "base", "0xabc", 5_000n, ETH, 500), { ok: false, why: "over_tap" });
});

test("pool.sell: the position's token units for the chain's pool, the proceeds back into it; none off a pool chain", () => {
  assert.deepEqual(poolSellAsk([sol("0", undefined)], "solana", "Mint1", "1200.5", 1_000), { kind: "pool.sell", params: { chain: "solana", token: "Mint1", amount: "1200.5", slippage_bps: 1_000 } });
  assert.deepEqual(poolSellAsk([base("0.01")], "base", "0xabc", "5", 1_000), { kind: "pool.sell", params: { chain: "base", token: "0xabc", amount: "5", slippage_bps: 1_000 } });
  // no pool for the chain (signed out, notes unread, or NEAR): the vault's own sell stays
  assert.equal(poolSellAsk(undefined, "solana", "Mint1", "1", 1_000), null);
  assert.equal(poolSellAsk([sol("0.2")], "near", "x.near", "1", 1_000), null);
});

test("the amount field is marked wrong only when the amount is what is wrong: over one tap, not a whole chunk, under a base unit; never while a proof is making or the pool cannot be priced", () => {
  const ready = [sol("1.25", "0.4", "0.3")];
  // a proof still making, with or without the page's tap_max: the amount is not what is wrong
  assert.equal(amountWrong(poolBuyAsk([sol("0.2", "0", "0.1")], "solana", "Mint1", 1_000n, SOL, 1_000)), false);
  assert.equal(amountWrong(poolBuyAsk([sol("0.2", "0")], "solana", "Mint1", 1_000n, SOL, 1_000)), false);
  assert.equal(amountWrong(poolBuyAsk(ready, "solana", "Mint1", 1_000n, null, 1_000)), false);
  assert.equal(amountWrong(poolBuyAsk(ready, "solana", "Mint1", 2_500n, SOL, 1_000)), false);
  assert.equal(amountWrong(poolBuyAsk(ready, "solana", "Mint1", 3_000n, SOL, 1_000)), true);
  assert.equal(amountWrong(poolBuyAsk([base("0.03", "0.02", "0.01")], "base", "0xabc", 2_500n, ETH, 500)), true);
  assert.equal(amountWrong(poolBuyAsk(ready, "solana", "Mint1", 0n, SOL, 1_000)), true);
});

test("the presets row: on Base and Robinhood one button holding the chunk's USD, the one amount pool.buy takes; the four elsewhere", () => {
  const rh = (balance: string, ready?: string, tap_max?: string): Pool => ({ ...base(balance, ready, tap_max), chain: "robinhood" });
  for (const [chain, entry] of [["base", base], ["robinhood", rh]] as const) {
    const pools = [entry("0.03", "0.02", "0.01")];
    const row = presetsOf(chain, poolView(pools, chain, ETH));
    assert.deepEqual(row, [3_500n], chain);
    // the button's value is what the buy takes, and its tap's text parses back to it
    assert.equal(poolBuyAsk(pools, chain, "0xabc", row[0]!, ETH, 500).ok, true, chain);
    assert.equal(parseUsd(amountText(row[0]!)), row[0], chain);
    // a chunk worth cents: 0.001 ETH at $3,500.12345678 is $3.50, drawn and filled as 3.50, never 3
    const small = [entry("0.003", "0.003", "0.001")];
    const one = presetsOf(chain, poolView(small, chain, ETH));
    assert.deepEqual(one, [350n], chain);
    assert.equal(amountText(one[0]!), "3.50");
    assert.equal(poolBuyAsk(small, chain, "0xabc", parseUsd(amountText(one[0]!))!, ETH, 500).ok, true, chain);
    // the value unknown: a proof still making (no tap_max), no price, no pool for the chain: one button, no value
    assert.deepEqual(presetsOf(chain, poolView([entry("0.02", "0")], chain, ETH)), [null], chain);
    assert.deepEqual(presetsOf(chain, poolView(pools, chain, null)), [null], chain);
    assert.deepEqual(presetsOf(chain, null), [null], chain);
    assert.deepEqual(presetsOf(chain, poolView([entry("0.02", "0.02", "0")], chain, ETH)), [null], chain);
  }
  // Solana and NEAR keep the four
  assert.deepEqual(presetsOf("solana", poolView([sol("1.25", "0.4", "0.3")], "solana", SOL)), PRESETS);
  assert.deepEqual(presetsOf("solana", null), PRESETS);
  assert.deepEqual(presetsOf("near", null), PRESETS);
  assert.equal(amountText(2_500n), "25");
});
