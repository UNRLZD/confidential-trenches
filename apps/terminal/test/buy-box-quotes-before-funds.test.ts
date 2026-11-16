// Card buy-box-quotes-before-funds: a fresh account with $0 sees its Max ($0.00) in the buy box, so a grey Buy has its
// reason. The signing page lists such an account's pools with a balance of "0" and no ready or tap_max (its proof
// queue opens at a first landing, none has come), as a live read of release 156 on 15 Nov 20:23Z gave:
//   [{"chain":"solana","asset":"SOL","balance":"0","price":{...}},{"chain":"base","asset":"ETH","balance":"0",...},...]
// so Max had nothing to read and the box drew no Max line at all. Bal is $0 there, and a tap spends no more than Bal.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Chain, SignpageState } from "@blindfill/kit";
import { amountOk, buysAskAmount, cashMax, coinTapKey, feeReadOf, feeShown, poolBuyAsk, poolMax, poolView, presetOn, receiveShown, spendSoon, tradeBal, type FeeRead } from "../src/screens/trade/model.ts";

type Pool = NonNullable<SignpageState["pools"]>[number];
// Pyth SOL/USD and ETH/USD as that read gave them
const SOL = { price: 7_137_485_968n, expo: -8, decimals: 9 };
const ETH = { price: 182_109_000_000n, expo: -8, decimals: 18 };
const FRESH: Pool[] = [
  { chain: "solana", asset: "SOL", balance: "0" },
  { chain: "base", asset: "ETH", balance: "0" },
  { chain: "robinhood", asset: "ETH", balance: "0" },
];

test("a fresh account's pool chain: Bal $0 and Max $0.00, not no Max; a $5 amount is over it and Buy stays off", () => {
  for (const [chain, price] of [["solana", SOL], ["base", ETH], ["robinhood", ETH]] as const) {
    const pv = poolView(FRESH, chain, price);
    assert.ok(pv, chain);
    assert.equal(pv.tapMax, null, `${chain}: the page sends no tap_max`);
    const bal = tradeBal(true, pv, 0n, 0n, 0n).cents;
    assert.equal(bal, 0n, chain);
    const max = poolMax(cashMax(FRESH, chain, null, price), pv.tapMax, bal);
    assert.equal(max, 0n, `${chain}: Max is $0.00`);
    // money is not on its way (nothing to make spendable), so the Max line shows, not Buy's busy look
    assert.equal(spendSoon(FRESH, chain, max), false, chain);
    assert.equal(amountOk(500n, max, bal), false, chain);
    assert.equal(presetOn(1_000n, max, bal, false), false, chain);
  }
});

test("Max is the page's own wherever it prices one; no $0 guess while Bal is not $0 or not read", () => {
  assert.equal(poolMax(4_650n, 31n, 7_000n), 4_650n, "with_cash first");
  assert.equal(poolMax(null, 31n, 7_000n), 31n, "one tap's own");
  assert.equal(poolMax(null, 0n, 0n), 0n);
  // money on the pool or in Cash that no tap is priced for yet (the seconds after a load, a proof making): no Max line
  assert.equal(poolMax(null, null, 93n), null);
  assert.equal(poolMax(null, null, null), null, "Bal not read");
});

// Half 2: the signing page answers pool.buy.dry with no pool note and no queue (card buy-quote-before-any-note): tap_max
// "0", with_cash (the most one tap spends with Cash moved first) and `out` (a quote of the whole ask) on Solana, Base
// and Robinhood. state.pools for such an account is the page's own (packages/wallet/src/pool/balances.ts): a balance of
// "0" and no ready or tap_max. The box must ask the dry for the coin, take its with_cash as Max and turn Buy on.
const SOL150 = { price: 15_000_000_000n, expo: -8, decimals: 9 };
const ETH3000 = { price: 300_000_000_000n, expo: -8, decimals: 18 };
const CASH_ONLY: [Chain, typeof SOL150, string, string][] = [
  // chain, price, with_cash for $39.00 of Cash, $5.00 in the pool asset at that price, rounded down
  ["solana", SOL150, "0.26", "0.033333333"],
  ["base", ETH3000, "0.013", "0.001666666666666666"],
  ["robinhood", ETH3000, "0.013", "0.001666666666666666"],
];

test("a Cash-only account (Cash > 0, no pool note): the box asks pool.buy.dry for the coin on every pool chain, none on NEAR", () => {
  for (const [chain] of CASH_ONLY) assert.notEqual(coinTapKey(FRESH, chain, "TOKEN"), null, chain);
  assert.equal(coinTapKey(FRESH, "near", "TOKEN"), null, "NEAR's box asks with the amount, not for a Max");
  assert.equal(coinTapKey(FRESH, "solana", ""), null, "no coin");
  assert.equal(coinTapKey(undefined, "solana", "TOKEN"), null, "signed out or notes unread");
  // a note held with its queue not running yet, or proofs still making: as before, no read (state.pools' own Max rules)
  assert.equal(coinTapKey([{ chain: "solana", asset: "SOL", balance: "0.01" }], "solana", "TOKEN"), null, "a note before its queue runs");
  assert.equal(coinTapKey([{ chain: "solana", asset: "SOL", balance: "0.01", ready: "0", making: "0.01" }], "solana", "TOKEN"), null, "a proof making");
  assert.notEqual(coinTapKey([{ chain: "solana", asset: "SOL", balance: "0.01", ready: "0.01", tap_max: "0.0017" }], "solana", "TOKEN"), null, "a proof ready");
});

test("a Cash-only account: Max is with_cash at the device's price, rounded down, and Buy is on up to it", () => {
  for (const [chain, price, withCash, five] of CASH_ONLY) {
    const max = cashMax(FRESH, chain, withCash, price);
    assert.equal(max, 3_900n, `${chain}: Max $39.00`);
    const pv = poolView(FRESH, chain, price)!;
    const bal = tradeBal(true, pv, 3_900n, 3_900n, 0n).cents;
    assert.equal(poolMax(max, pv.tapMax, bal), 3_900n, chain);
    assert.deepEqual(poolBuyAsk(FRESH, chain, "TOKEN", 500n, price, 100, withCash), { ok: true, kind: "pool.buy", params: { chain, token: "TOKEN", amount: five, slippage_bps: 100 } }, `${chain}: $5`);
    // Max's own cents ask the whole of with_cash
    const atMax = poolBuyAsk(FRESH, chain, "TOKEN", 3_900n, price, 100, withCash);
    assert.equal(atMax.ok && atMax.params.amount, withCash, `${chain}: Max`);
    assert.deepEqual(poolBuyAsk(FRESH, chain, "TOKEN", 3_901n, price, 100, withCash), { ok: false, why: "over_tap" }, `${chain}: over Max`);
    assert.equal(amountOk(500n, max, bal), true, chain);
    // Base and Robinhood ask the dry the tap's own amount, as with notes
    if (chain !== "solana") assert.equal(buysAskAmount(FRESH, chain, "TOKEN", 500n, price, 100, withCash), five, chain);
  }
});

test("a $0 account: Max $0, the amount over it, and the quote still asked with the typed amount", () => {
  for (const [chain, price, , five] of CASH_ONLY) {
    const pv = poolView(FRESH, chain, price)!;
    const bal = tradeBal(true, pv, 0n, 0n, 0n).cents;
    // the page's with_cash "0" (no Cash), or none at all: Max $0 either way
    for (const withCash of ["0", null]) {
      const max = poolMax(cashMax(FRESH, chain, withCash, price), pv.tapMax, bal);
      assert.equal(max, 0n, `${chain} with_cash ${withCash}`);
      const ask = poolBuyAsk(FRESH, chain, "TOKEN", 500n, price, 100, withCash);
      assert.deepEqual(ask, { ok: false, why: "no_proof" }, chain);
      assert.equal(amountOk(500n, max, bal), false, chain);
      // You receive: Base and Robinhood ask the dry the typed USD in ETH (no tap to ask: the whole buy moves from Cash)
      if (chain !== "solana") assert.equal(buysAskAmount(FRESH, chain, "TOKEN", 500n, price, 100, withCash), five, `${chain} with_cash ${withCash}`);
    }
  }
  // the answer's out with no cost: You receive shows it, the Fee its dash
  const read: FeeRead = { key: "k", out: "1234.5", amount: 500n };
  assert.deepEqual(receiveShown(read, "k", 500n), { out: "1234.5", pending: false });
  assert.equal(feeShown(read, "k", 500n, SOL150), null);
  // the box keeps such an answer (feeReadOf), and one that prices nothing never replaces the last
  assert.deepEqual(feeReadOf("k", { out: "1234.5" }, 500n), read);
  assert.deepEqual(feeReadOf("k", { cost: "0.0014", out: "9" }, 500n), { key: "k", cost: "0.0014", out: "9", amount: 500n });
  assert.equal(feeReadOf("k", {}, 500n), null);
});

test("the page's answer stays hostile: a with_cash that is not a plain decimal is not used; a missing tap_max reads as 0", () => {
  for (const bad of ["", "abc", "-1", "1e3", "0x10", " 1", "1.", ".5", "Infinity", "0.1234567891"]) {
    assert.equal(cashMax(FRESH, "solana", bad, SOL150), null, `with_cash ${JSON.stringify(bad)}`);
    assert.deepEqual(poolBuyAsk(FRESH, "solana", "TOKEN", 500n, SOL150, 100, bad), { ok: false, why: "no_proof" }, `with_cash ${JSON.stringify(bad)}`);
  }
  // no tap_max in state.pools is "0", never a number the page did not send: poolView draws none
  assert.equal(poolView(FRESH, "base", ETH3000)!.tapMax, null);
  // with notes, a with_cash under the pool's own tap_max is not used (as before)
  const held: Pool[] = [{ chain: "base", asset: "ETH", balance: "0.003", ready: "0.003", tap_max: "0.002" }];
  assert.equal(cashMax(held, "base", "0.001", ETH3000), null);
  assert.equal(cashMax(held, "base", "0.003", ETH3000), 900n);
  // with notes and no queue for them, no Cash Max either (state.pools' tap_max is not there to read with_cash over):
  // the box does not ask (coinTapKey null), and NEAR moves no Cash into a pool
  assert.equal(cashMax(FRESH, "near", "0.26", SOL150), null);
});
