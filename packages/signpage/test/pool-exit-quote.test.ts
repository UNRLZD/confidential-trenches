// card pool-withdraws-to-any-chain: the device's check of a 1Click quote a pool pays out to another chain through
// (packages/kit/src/checks/oneclick-exit.ts), on answers signed by the mock's key, which this process alone trusts
// (./oneclick-mock.ts). The pool pays the quote's deposit address on its own chain only when amountIn is the payout,
// the recipient is the address typed, the refund goes to the user's own wallet on the pool's chain and minAmountOut is
// within the slippage of amountOut (and over the device's floor at its own price reads).
//   node --test test/pool-exit-quote.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADDRESS, COLLECTOR, H72, NOW, mockKey, signAnswer, type Answer } from "./oneclick-mock.ts";
import type { OneClickRequest } from "../../kit/src/checks/oneclick.ts";

const { checkOneClickExitQuote, oneClickExitRequest, ExitRequestError, EXIT_ORIGIN_ASSET, EXIT_DESTINATION_ASSET } = await import("../../kit/src/checks/oneclick-exit.ts");
const { OneClickQuoteError } = await import("../../kit/src/checks/oneclick.ts");

const TYPED = "0x52908400098527886E0F7030069857D2E4169EE7"; // the address the user typed on Base (EIP-55)
const REFUND = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T"; // the user's own U_X on Solana
const ASK = { from: "solana", to: "base", recipient: TYPED, payout: 100_000_000n, refundTo: REFUND } as const;
// SOL at 150 and ETH at 3,000 on both reads: 0.1 SOL is 0.005 ETH; the floor on a priced pair (F 20, S 50) is
// ⌈0.005 × 0.993⌉ ETH out and that × 0.99 as the least, 4,915,350,000,000,000 wei
const OPTS = { path: "keyless" as const, pricing: { in: ["150", "150"] as const, out: ["3000", "3000"] as const }, now: NOW };

function answer(req: OneClickRequest, q: Partial<Record<string, string>> = {}, after?: (a: Answer) => void): Answer {
  const a: Answer = {
    quote: {
      amountIn: req.amount, amountInFormatted: "0.1", amountInUsd: "15.0", minAmountIn: req.amount,
      amountOut: "4990000000000000", amountOutFormatted: "0.00499", amountOutUsd: "14.97", minAmountOut: "4940100000000000",
      depositAddress: ADDRESS, deadline: new Date(Date.parse(req.deadline) + H72).toISOString(),
      timeWhenInactive: new Date(Date.parse(req.deadline) + H72).toISOString(), timeEstimate: 22, refundFee: "0", withdrawFee: "0",
      ...q,
    },
    quoteRequest: { ...req, depositMode: "SIMPLE", quoteWaitingTimeMs: 0, appFees: [{ recipient: COLLECTOR, fee: 20 }] },
    signature: "",
    timestamp: new Date(NOW - 500).toISOString(),
  };
  signAnswer(a, mockKey.privateKey);
  after?.(a);
  return a;
}
const REQ = oneClickExitRequest(ASK, NOW);

test("the device's request: the pool's coin in, the chain's coin out, the payout, the typed recipient, the refund on the pool's chain", () => {
  assert.deepEqual(REQ, {
    dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: EXIT_ORIGIN_ASSET.solana.asset, depositType: "ORIGIN_CHAIN",
    destinationAsset: EXIT_DESTINATION_ASSET.base.asset, amount: "100000000", refundTo: REFUND, refundType: "ORIGIN_CHAIN",
    recipient: TYPED, recipientType: "DESTINATION_CHAIN", deadline: new Date(NOW + 30 * 60_000).toISOString(),
  });
  assert.throws(() => oneClickExitRequest({ ...ASK, to: "solana" }, NOW), ExitRequestError); // same chain: the pool pays it
  assert.throws(() => oneClickExitRequest({ ...ASK, to: "toString" as never }, NOW), ExitRequestError);
  assert.throws(() => oneClickExitRequest({ ...ASK, payout: 0n }, NOW), ExitRequestError);
});

test("a checked quote passes and hands on its signed deposit address on the pool's chain", () => {
  const c = checkOneClickExitQuote(ASK, REQ, answer(REQ), OPTS);
  assert.equal(c.depositAddress, ADDRESS);
  assert.equal(c.amountIn, ASK.payout);
  assert.equal(c.minAmountOut, 4_940_100_000_000_000n);
});

const quoteRefused = (check: string, f: () => unknown) =>
  assert.throws(f, (e: unknown) => e instanceof OneClickQuoteError && e.check === check, `not refused ${check}`);

test("the answer's recipient is the typed address, or nothing moves", () => {
  // a helper that asks 1Click for its own recipient: the signed echo is not the device's request
  const theirs = { ...REQ, recipient: "0x000000000000000000000000000000000000dEaD" };
  quoteRefused("echo", () => checkOneClickExitQuote(ASK, REQ, answer(theirs), OPTS));
  // a request that is not the one built from the user's ask is never sent nor checked
  assert.throws(() => checkOneClickExitQuote(ASK, theirs, answer(theirs), OPTS), ExitRequestError);
  // the refund on another wallet than the user's own
  const refund = { ...REQ, refundTo: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" };
  assert.throws(() => checkOneClickExitQuote(ASK, refund, answer(refund), OPTS), ExitRequestError);
  // a refund on another chain than the pool's
  const intents = { ...REQ, refundType: "INTENTS" };
  assert.throws(() => checkOneClickExitQuote(ASK, intents, answer(intents), OPTS), ExitRequestError);
});

test("amountIn is the payout", () => {
  quoteRefused("amount", () => checkOneClickExitQuote(ASK, REQ, answer(REQ, { amountIn: "99000000", minAmountIn: "99000000", amountInFormatted: "0.099" }), OPTS));
  // a request for another amount than the payout
  const less = { ...REQ, amount: "99000000" };
  assert.throws(() => checkOneClickExitQuote(ASK, less, answer(less), OPTS), ExitRequestError);
});

test("minAmountOut within the slippage of amountOut, and over the device's floor", () => {
  // 1Click rounds the least down (a live answer, 13 Nov 20:47Z: amountOut 7,994,156, minAmountOut 7,914,214): exactly
  // ⌊amountOut × 0.99⌋ passes, one under it does not
  const c = checkOneClickExitQuote(ASK, REQ, answer(REQ, { amountOut: "4990000000000001", minAmountOut: "4940100000000000" }), OPTS);
  assert.equal(c.minAmountOut, 4_940_100_000_000_000n);
  quoteRefused("floor", () => checkOneClickExitQuote(ASK, REQ, answer(REQ, { amountOut: "4990000000000001", minAmountOut: "4940099999999999" }), OPTS));
  // over the floor (4,915,350e12) but 3.8% under a padded amountOut: refused
  quoteRefused("floor", () => checkOneClickExitQuote(ASK, REQ, answer(REQ, { amountOut: "5200000000000000", amountOutFormatted: "0.0052", minAmountOut: "5000000000000000" }), OPTS));
  // under the device's floor at its own prices
  quoteRefused("floor", () => checkOneClickExitQuote(ASK, REQ, answer(REQ, { amountOut: "4900000000000000", amountOutFormatted: "0.0049", minAmountOut: "4851000000000000" }), OPTS));
});

test("a dry request, a changed signed field, an unsigned deposit address: refused", () => {
  const dry = { ...REQ, dry: true };
  assert.throws(() => checkOneClickExitQuote(ASK, dry, answer(dry), OPTS), ExitRequestError);
  quoteRefused("signature", () => checkOneClickExitQuote(ASK, REQ, answer(REQ, {}, (a) => void (a.quote.depositAddress = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")), OPTS));
});
