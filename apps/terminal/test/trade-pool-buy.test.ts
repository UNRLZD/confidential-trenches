// The trade box's buy and sell on the pool path (card trade-box-pool; plan v2 A2): the USD the box shows turned into the
// pool asset's units the tap spends, rounded down as the kit's poolUsdToUnits rounds (a tap never spends more than the
// USD asked), the pool's balance and the most one tap can spend drawn in USD, and the ask the box sends: pool.buy only
// with a proof ready and at most `tap_max`, any amount on every pool chain (card buy-any-amount-on-every-chain), pool.sell for the position's units. Planted pools and prices.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageState } from "@blindfill/kit";
import { amountOk, amountText, amountWrong, cashMax, cashMovesTo, centsToUnits, coinTapAgainMs, coinTapKey, decimalToUnits, feeAskAmount, feeCents, feeShown, parseUsd, poolBuyAsk, poolSellAsk, poolView, presetOn, receiveShown, tradeBal, unitsToCents, unitsToDecimal, withCoinTap } from "../src/screens/trade/model.ts";

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
  // Making proof only while a proof is being made (kit 1.12 making); none ready and none being made reads none
  assert.deepEqual(poolView([{ ...sol("0.2", "0"), making: "0.2" }], "solana", SOL), { asset: "SOL", balance: 1_860n, tapMax: null, proof: "making" });
  assert.deepEqual(poolView([sol("0.2", "0")], "solana", SOL), { asset: "SOL", balance: 1_860n, tapMax: null, proof: "none" });
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

test("pool.buy on Base and Robinhood: any amount up to tap_max, as on Solana", () => {
  const pools = [base("0.03", "0.02", "0.01")];
  assert.deepEqual(poolBuyAsk(pools, "base", "0xabc", 3_500n, ETH, 500), { ok: true, kind: "pool.buy", params: { chain: "base", token: "0xabc", amount: "0.01", slippage_bps: 500 } });
  assert.deepEqual(poolBuyAsk(pools, "base", "0xabc", 2_500n, ETH, 500), { ok: true, kind: "pool.buy", params: { chain: "base", token: "0xabc", amount: unitsToDecimal(centsToUnits(2_500n, ETH), 18), slippage_bps: 500 } });
  assert.deepEqual(poolBuyAsk(pools, "base", "0xabc", 5_000n, ETH, 500), { ok: false, why: "over_tap" });
});

test("pool.sell: the position's token units for the chain's pool, the proceeds back into it; none off a pool chain", () => {
  assert.deepEqual(poolSellAsk([sol("0", undefined)], "solana", "Mint1", { amount: "1200.5" }, 1_000), { kind: "pool.sell", params: { chain: "solana", token: "Mint1", amount: "1200.5", slippage_bps: 1_000 } });
  assert.deepEqual(poolSellAsk([base("0.01")], "base", "0xabc", { amount: "5" }, 1_000), { kind: "pool.sell", params: { chain: "base", token: "0xabc", amount: "5", slippage_bps: 1_000 } });
  // card pool-sell-share-across-wallets: a share of the whole holding, the page's own units
  assert.deepEqual(poolSellAsk([sol("0", undefined)], "solana", "Mint1", { share_bps: 7_500 }, 1_000), { kind: "pool.sell", params: { chain: "solana", token: "Mint1", share_bps: 7_500, slippage_bps: 1_000 } });
  // no pool for the chain (signed out, notes unread, or NEAR): the vault's own sell stays
  assert.equal(poolSellAsk(undefined, "solana", "Mint1", "1", 1_000), null);
  assert.equal(poolSellAsk([sol("0.2")], "near", "x.near", "1", 1_000), null);
});

test("the amount field is marked wrong only when the amount is what is wrong: over one tap or under a base unit; never while a proof is making or the pool cannot be priced", () => {
  const ready = [sol("1.25", "0.4", "0.3")];
  // a proof still making, with or without the page's tap_max: the amount is not what is wrong
  assert.equal(amountWrong(poolBuyAsk([sol("0.2", "0", "0.1")], "solana", "Mint1", 1_000n, SOL, 1_000)), false);
  assert.equal(amountWrong(poolBuyAsk([sol("0.2", "0")], "solana", "Mint1", 1_000n, SOL, 1_000)), false);
  assert.equal(amountWrong(poolBuyAsk(ready, "solana", "Mint1", 1_000n, null, 1_000)), false);
  assert.equal(amountWrong(poolBuyAsk(ready, "solana", "Mint1", 2_500n, SOL, 1_000)), false);
  assert.equal(amountWrong(poolBuyAsk(ready, "solana", "Mint1", 3_000n, SOL, 1_000)), true);
  assert.equal(amountWrong(poolBuyAsk([base("0.03", "0.02", "0.01")], "base", "0xabc", 2_500n, ETH, 500)), false);
  assert.equal(amountWrong(poolBuyAsk([base("0.03", "0.02", "0.01")], "base", "0xabc", 3_501n, ETH, 500)), true);
  assert.equal(amountWrong(poolBuyAsk(ready, "solana", "Mint1", 0n, SOL, 1_000)), true);
});

test("an amount in cents as the box takes it: whole dollars bare, cents with two places, parsed back to the same cents", () => {
  for (const c of [350n, 2_500n, 3_501n]) assert.equal(parseUsd(amountText(c)), c);
  assert.equal(amountText(350n), "3.50");
  assert.equal(amountText(2_500n), "25");
});

test("Max for the coin on screen (card max-is-priced-for-the-coin): the page's pool.buy.dry in place of state.pools' tap_max, for that coin and those proofs only", () => {
  // the owner's mainnet piece: one 0.01 SOL proof; state.pools prices the costliest venue (0.00038488 SOL), the page's
  // pool.buy.dry the coin's own (a Token mint's coin with no cashback: 0.00337192 SOL)
  const pools = [sol("0.01", "0.01", "0.00038488")];
  const key = coinTapKey(pools, "solana", "Mint1");
  assert.equal(key, JSON.stringify(["Mint1", "0.01", "0.00038488"]));
  // the key moves with the coin and with the proofs, so an answer for another coin or other proofs is never used
  assert.notEqual(coinTapKey(pools, "solana", "Mint2"), key);
  assert.notEqual(coinTapKey([sol("0.02", "0.02", "0.00038488")], "solana", "Mint1"), key);
  assert.notEqual(coinTapKey([sol("0.01", "0.01", "0.0004")], "solana", "Mint1"), key);
  // nothing to ask: no proof ready, no tap_max, no token, NEAR (no pool), no pool. Base and Robinhood ask it for
  // with_cash (card one-balance-buys-on-every-chain), and withCoinTap leaves their whole chunk as it is
  for (const [p, chain, token] of [[[sol("0.01")], "solana", "Mint1"], [[sol("0.01", "0.01")], "solana", "Mint1"], [pools, "solana", ""], [[base("0.01", "0.01", "0.01")], "near", "0xT"], [undefined, "solana", "Mint1"]] as const)
    assert.equal(coinTapKey(p as SignpageState["pools"], chain, token), null, JSON.stringify([p, chain]));
  const coin = withCoinTap(pools, "solana", "0.00337192");
  assert.deepEqual(coin, [sol("0.01", "0.01", "0.00337192")]);
  // Max and the ask read it: $0.31 where the costliest venue gave $0.03, and an amount up to it asks the buy
  assert.equal(poolView(pools, "solana", SOL)!.tapMax, 3n);
  assert.equal(poolView(coin, "solana", SOL)!.tapMax, 31n);
  assert.deepEqual(poolBuyAsk(pools, "solana", "Mint1", 31n, SOL, 300), { ok: false, why: "over_tap" });
  const ask = poolBuyAsk(coin, "solana", "Mint1", 31n, SOL, 300);
  assert.ok(ask.ok && decimalToUnits(ask.params.amount, 9)! <= 3_371_920n);
  assert.deepEqual(poolBuyAsk(coin, "solana", "Mint1", 32n, SOL, 300), { ok: false, why: "over_tap" });
  // as they are: no answer, an answer that is no decimal or more than ready, another chain
  for (const [tap, chain] of [[null, "solana"], ["x", "solana"], ["0.02", "solana"], ["0.00337192", "base"]] as const) assert.equal(withCoinTap(pools, chain, tap), pools, JSON.stringify(tap));
});

test("Max for the coin asked again while the page says not now: busy every second (a trade runs), down every 3 s (a provider failed), never on an answer that is no", () => {
  assert.equal(coinTapAgainMs("busy"), 1_000);
  assert.equal(coinTapAgainMs("down"), 3_000);
  for (const code of ["not_allowed", "not_funded", "quote_check_failed", "timeout"]) assert.equal(coinTapAgainMs(code), null, code);
});

test("card buy-spends-several-pieces: the Fee row asks the cost of the typed amount in SOL and draws it in USD, rounded up; a dash until it is read", () => {
  // $0.16 at $93.01 is the buy's own amount (poolBuyAsk asks 0.001720236 for it)
  assert.equal(feeAskAmount(16n, SOL), "0.001720236");
  assert.equal(feeAskAmount(null, SOL), null);
  assert.equal(feeAskAmount(0n, SOL), null);
  assert.equal(feeAskAmount(16n, null), null);
  // 0.0014 SOL (one piece's 1,300,000 relay fee and the 100,000 tip) is $0.1302: never drawn under what it costs
  assert.equal(feeCents("0.0014", SOL), 14n);
  assert.equal(feeCents("0.10751476", SOL), 1_000n); // $10.00, the $9.99 rounded down read up
  for (const bad of [undefined, "", "-1", "1e3", "0x10", "0.0000000001"]) assert.equal(feeCents(bad, SOL), null, String(bad));
  assert.equal(feeCents("0.0014", null), null);
  // the row keeps the coin's last answer while a newer amount is asked and as the price ticks; another coin's, none
  const read = { key: "solana:MINT", cost: "0.0014" };
  assert.equal(feeShown(read, "solana:MINT", 16n, SOL), 14n);
  assert.equal(feeShown(read, "solana:MINT", 99n, SOL), 14n, "a newer amount typed: the last cost until its own answer");
  assert.equal(feeShown(read, "solana:MINT", 16n, { ...SOL, price: SOL.price * 2n }), 27n, "a price tick reprices the same cost (0.0014 SOL at $186.02, rounded up)");
  assert.equal(feeShown(read, "solana:OTHER", 16n, SOL), null, "another coin's answer is never shown");
  assert.equal(feeShown(null, "solana:MINT", 16n, SOL), null);
  assert.equal(feeShown(read, "solana:MINT", null, SOL), null, "no amount typed");
});

test("card solana-buy-preview-complete: You receive on a pool path is the dry answer's out for this coin, dimmed while another amount is asked; a dash with none", () => {
  // red before this card: the live source had no set preview and the dry answer no out, so You receive was a dash on
  // every amount
  const read = { key: "solana:MINT", cost: "0.0014", out: "35294.263662", amount: 16n };
  assert.deepEqual(receiveShown(read, "solana:MINT", 16n), { out: "35294.263662", pending: false });
  assert.deepEqual(receiveShown(read, "solana:MINT", 99n), { out: "35294.263662", pending: true }, "a newer amount typed: the last out, dimmed, until its own answer");
  assert.equal(receiveShown(read, "solana:OTHER", 16n), null, "another coin's answer is never shown");
  assert.equal(receiveShown({ key: "solana:MINT", cost: "0.0014" }, "solana:MINT", 16n), null, "an answer with no out (a page below kit 1.14, or its quote not read): the dash");
  assert.equal(receiveShown(null, "solana:MINT", 16n), null);
  assert.equal(receiveShown(read, "solana:MINT", null), null, "no amount typed");
  assert.equal(receiveShown(read, "solana:MINT", 0n), null);
});

// Card one-balance-buys-on-every-chain: on Solana a tap above tap_max moves its shortfall from Cash (the NEAR vault's
// USDC) into the pool and buys the whole ask once it lands (packages/signpage/src/cash-to-pool.ts cashFirst). The box's
// Max is pool.buy.dry's with_cash, its Bal the pool and Cash's NEAR part, and an ask above tap_max at most with_cash is
// sent as one pool.buy. with_cash is the page's answer: anything not a plain decimal at or above tap_max is not used.
test("card one-balance-buys-on-every-chain: Max is with_cash, Bal is the pool and Cash, an ask above tap_max and at most with_cash is sent", () => {
  // one 0.01 SOL proof whose tap spends 0.00337192 SOL on this coin ($0.31); with_cash 0.5 SOL ($46.50)
  const pools = [sol("0.01", "0.01", "0.00337192")];
  assert.equal(cashMax(pools, "solana", "0.5", SOL), 4_650n);
  assert.equal(cashMax(pools, "solana", "0.00337192", SOL), 31n, "with_cash at tap_max: nothing to move");
  // no with_cash, or one that is no plain decimal, has more digits than SOL, sits under tap_max: Max stays tap_max's
  for (const w of [null, "", "x", "-1", "1e3", "0x10", "0.0000000001", "0.001", " 0.5"]) assert.equal(cashMax(pools, "solana", w, SOL), null, JSON.stringify(w));
  // no price, no tap_max, no pool, another chain: none
  assert.equal(cashMax(pools, "solana", "0.5", null), null);
  assert.equal(cashMax([sol("0.01", "0.01")], "solana", "0.5", SOL), null);
  assert.equal(cashMax(undefined, "solana", "0.5", SOL), null);
  // $30 is above one tap's $0.31 and under with_cash's $46.50: one pool.buy of the whole $30, never a refusal
  const ask = poolBuyAsk(pools, "solana", "Mint1", 3_000n, SOL, 1_000, "0.5");
  assert.deepEqual(ask, { ok: true, kind: "pool.buy", params: { chain: "solana", token: "Mint1", amount: unitsToDecimal(centsToUnits(3_000n, SOL), 9), slippage_bps: 1_000 } });
  assert.equal(amountWrong(ask), false);
  // at with_cash's Max it is sent; one cent above it is over
  assert.equal(poolBuyAsk(pools, "solana", "Mint1", 4_650n, SOL, 1_000, "0.5").ok, true);
  assert.deepEqual(poolBuyAsk(pools, "solana", "Mint1", 4_651n, SOL, 1_000, "0.5"), { ok: false, why: "over_tap" });
  // no with_cash (or one not used): over one tap is over, as before
  for (const w of [null, "x", "0.001"]) assert.deepEqual(poolBuyAsk(pools, "solana", "Mint1", 3_000n, SOL, 1_000, w), { ok: false, why: "over_tap" }, JSON.stringify(w));
  // no proof ready: with_cash makes no ask
  assert.deepEqual(poolBuyAsk([sol("0.01", "0")], "solana", "Mint1", 3_000n, SOL, 1_000, "0.5"), { ok: false, why: "no_proof" });
  // the amount gate and the presets read that Max: $30 and the $25 and $10 presets are on under Bal
  const pv = poolView(pools, "solana", SOL)!;
  const bal = tradeBal(true, pv, 999n, 5_000n).cents;
  assert.equal(bal, 93n + 5_000n, "Bal: the pool's $0.93 and Cash's $50 on NEAR");
  assert.equal(amountOk(3_000n, cashMax(pools, "solana", "0.5", SOL), bal), true);
  assert.equal(amountOk(3_000n, pv.tapMax, bal), false, "tap_max alone: $30 is over Max");
  assert.equal(presetOn(2_500n, cashMax(pools, "solana", "0.5", SOL), bal, false), true);
  assert.equal(presetOn(5_000n, cashMax(pools, "solana", "0.5", SOL), bal, false), false, "$50 over with_cash's $46.50");
  // Bal: no pool view (no price) or Cash not read yet is no number; Cash moves into a buy on Solana only
  assert.deepEqual(tradeBal(true, null, 999n, 5_000n), { from: "pool", cents: null });
  assert.deepEqual(tradeBal(true, pv, 999n, null), { from: "pool", cents: null });
  assert.deepEqual(tradeBal(false, pv, 999n, 5_000n), { from: "cash", cents: 999n });
  for (const c of ["solana", "base", "robinhood"] as const) assert.equal(cashMovesTo(c), true, c);
  assert.equal(cashMovesTo("near"), false);
});

test("card one-balance-buys-on-every-chain on Base and Robinhood: Max is with_cash, and a tap asks any amount up to it (card buy-any-amount-on-every-chain)", () => {
  for (const chain of ["base", "robinhood"] as const) {
    const pools = [{ ...base("0.03", "0.02", "0.01"), chain }];
    const note = unitsToCents(decimalToUnits("0.05", 18)!, ETH);
    const ready = unitsToCents(decimalToUnits("0.01", 18)!, ETH);
    assert.equal(cashMax(pools, chain, "0.05", ETH), note);
    // Max's cents ask the whole 0.05 ETH; the ready note's USD under it is asked as typed
    assert.deepEqual(poolBuyAsk(pools, chain, "0xabc", note, ETH, 500, "0.05"), { ok: true, kind: "pool.buy", params: { chain, token: "0xabc", amount: "0.05", slippage_bps: 500 } });
    assert.deepEqual(poolBuyAsk(pools, chain, "0xabc", ready, ETH, 500, "0.05"), { ok: true, kind: "pool.buy", params: { chain, token: "0xabc", amount: unitsToDecimal(centsToUnits(ready, ETH), 18), slippage_bps: 500 } });
    // any other amount under with_cash: asked as typed; above it: over
    assert.deepEqual(poolBuyAsk(pools, chain, "0xabc", note - 1n, ETH, 500, "0.05"), { ok: true, kind: "pool.buy", params: { chain, token: "0xabc", amount: unitsToDecimal(centsToUnits(note - 1n, ETH), 18), slippage_bps: 500 } });
    assert.deepEqual(poolBuyAsk(pools, chain, "0xabc", note + 1n, ETH, 500, "0.05"), { ok: false, why: "over_tap" });
    // no with_cash: the ready note alone, as before
    assert.deepEqual(poolBuyAsk(pools, chain, "0xabc", note, ETH, 500, null), { ok: false, why: "over_tap" });
    assert.equal(coinTapKey(pools, chain, "0xabc") !== null, true, "the box asks the page's dry on this chain too");
    assert.deepEqual(withCoinTap(pools, chain, "0.05"), pools, "the dry's with_cash, not its tap_max, is Base's Max");
  }
});

test("card one-balance-buys-on-every-chain: a pool that holds nothing yet buys from Cash on every pool chain (the user who deposited on NEAR only); without with_cash it still waits for a proof", () => {
  // Solana: an empty pool (no note, tap_max 0) and with_cash 0.5 SOL: $30 is one pool.buy, the page moves it all first
  const empty = [sol("0", "0", "0")];
  assert.equal(cashMax(empty, "solana", "0.5", SOL), 4_650n);
  assert.deepEqual(poolBuyAsk(empty, "solana", "Mint1", 3_000n, SOL, 1_000, "0.5"), { ok: true, kind: "pool.buy", params: { chain: "solana", token: "Mint1", amount: unitsToDecimal(centsToUnits(3_000n, SOL), 9), slippage_bps: 1_000 } });
  // no with_cash, or with_cash 0 (Cash makes nothing): no proof, no ask
  for (const w of [null, "0"]) assert.deepEqual(poolBuyAsk(empty, "solana", "Mint1", 3_000n, SOL, 1_000, w), { ok: false, why: "no_proof" }, JSON.stringify(w));
  // Base and Robinhood: Cash's part is spent as typed
  for (const chain of ["base", "robinhood"] as const) {
    const pools = [{ ...base("0", "0", "0"), chain }];
    const note = unitsToCents(decimalToUnits("0.05", 18)!, ETH);
    assert.deepEqual(poolBuyAsk(pools, chain, "0xabc", note, ETH, 500, "0.05"), { ok: true, kind: "pool.buy", params: { chain, token: "0xabc", amount: "0.05", slippage_bps: 500 } });
    assert.equal(poolBuyAsk(pools, chain, "0xabc", note - 1n, ETH, 500, "0.05").ok, true);
    assert.deepEqual(poolBuyAsk(pools, chain, "0xabc", note, ETH, 500, null), { ok: false, why: "no_proof" });
  }
});

test("card buy-any-amount-on-every-chain: a Base or Robinhood buy of any amount up to Max is one pool.buy of exactly that amount ($2.37 with notes 0.002 + 0.001 ETH), as on Solana", () => {
  for (const chain of ["base", "robinhood"] as const) {
    // two notes, 0.002 and 0.001 ETH: the page's tap_max is what one tap can spend of both
    const pools = [{ ...base("0.003", "0.003", "0.00298"), chain }];
    const units = centsToUnits(237n, ETH);
    assert.deepEqual(poolBuyAsk(pools, chain, "0xabc", 237n, ETH, 500), { ok: true, kind: "pool.buy", params: { chain, token: "0xabc", amount: unitsToDecimal(units, 18), slippage_bps: 500 } }, chain);
    // a non-rung amount above one note's chunk, under the two notes' Max: still one pool.buy
    assert.equal(poolBuyAsk(pools, chain, "0xabc", 900n, ETH, 500).ok, true, chain);
    // over Max is over, as on Solana
    assert.deepEqual(poolBuyAsk(pools, chain, "0xabc", 1_100n, ETH, 500), { ok: false, why: "over_tap" }, chain);
    // with_cash: any amount up to what Cash adds
    assert.equal(poolBuyAsk(pools, chain, "0xabc", 1_100n, ETH, 500, "0.05").ok, true, chain);
  }
});
