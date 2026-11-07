// The pool deposit quote's request (card pool-deposit-address): money from another chain into chain X's pool goes by
// 1Click to U_X, the chain's one-time deposit wallet, and a refund lands under U_X's own key inside intents.near, so
// the request names U_X alone.   node --test test/pool-deposit-quote.test.ts
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { POOL_DEPOSIT_DESTINATION, poolDepositQuoteRequest, poolRefundId } from "../src/deposit/quote.ts";

const NOW = Date.parse("2026-11-07T23:00:00.000Z");
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const SOL_PK = new Uint8Array(32).map((_, i) => i + 1);
const SOL_U = base58.encode(SOL_PK);
const SOL_U_HEX = Buffer.from(SOL_PK).toString("hex");
const EVM_U = "0x52908400098527886E0F7030069857D2E4169EE7"; // EIP-55's own test vector

test("the destinations are the pools' native coins on 1Click, as the return's table pins them", () => {
  assert.deepEqual({ ...POOL_DEPOSIT_DESTINATION }, { solana: "nep141:sol.omft.near", base: "nep141:base.omft.near", robinhood: "nep141:hood.omft.near" });
  assert.ok(Object.isFrozen(POOL_DEPOSIT_DESTINATION));
});

test("U_X's refund id is its own key's intents account: the 64-hex of a Solana key, the lowercase 0x of an EVM one", () => {
  assert.equal(poolRefundId("solana", SOL_U), SOL_U_HEX);
  assert.equal(poolRefundId("base", EVM_U), EVM_U.toLowerCase());
  assert.equal(poolRefundId("robinhood", EVM_U), EVM_U.toLowerCase());
});

test("a Solana pool's request: U_X the recipient on Solana, its own intents id the refund, live, nothing more", () => {
  assert.deepEqual(poolDepositQuoteRequest("solana", SOL_U, BASE_USDC, 25_000_000n, NOW), {
    dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: BASE_USDC, depositType: "ORIGIN_CHAIN",
    destinationAsset: "nep141:sol.omft.near", amount: "25000000",
    refundTo: SOL_U_HEX, refundType: "INTENTS", recipient: SOL_U, recipientType: "DESTINATION_CHAIN", deadline: "2026-11-07T23:30:00.000Z",
  });
});

test("a Base pool's request: U_X the recipient on Base (EIP-55 as derived), its lowercase id the refund", () => {
  const r = poolDepositQuoteRequest("base", EVM_U, SOL_USDC, 7_000_000n, NOW);
  assert.equal(r.destinationAsset, "nep141:base.omft.near");
  assert.equal(r.recipient, EVM_U);
  assert.equal(r.recipientType, "DESTINATION_CHAIN");
  assert.equal(r.refundTo, EVM_U.toLowerCase());
  assert.equal(r.refundType, "INTENTS");
  assert.equal(r.dry, false);
});

test("bad input builds no request: a wallet not of the chain, a chain with no pool, a bad amount or time", () => {
  for (const [chain, u, asset, amount, now] of [
    ["solana", EVM_U, BASE_USDC, 1n, NOW], ["solana", SOL_U_HEX, BASE_USDC, 1n, NOW], ["solana", base58.encode(new Uint8Array(31)), BASE_USDC, 1n, NOW],
    ["base", SOL_U, SOL_USDC, 1n, NOW], ["base", EVM_U.toLowerCase().replace("0x", "0X"), SOL_USDC, 1n, NOW], ["base", "0x52908400098527886e0f7030069857d2e4169ee", SOL_USDC, 1n, NOW],
    ["near", SOL_U_HEX, BASE_USDC, 1n, NOW], ["solana", SOL_U, "", 1n, NOW], ["solana", SOL_U, BASE_USDC, 0n, NOW],
    ["solana", SOL_U, BASE_USDC, 1, NOW], ["solana", SOL_U, BASE_USDC, 1n, Number.NaN],
    // money already on chain X is pool.deposit's own, never a quote
    ["solana", SOL_U, "nep141:sol.omft.near", 1n, NOW], ["base", EVM_U, "nep141:base.omft.near", 1n, NOW],
  ] as [never, string, string, bigint, number][])
    assert.throws(() => poolDepositQuoteRequest(chain, u, asset, amount, now), `${chain} ${u} ${asset} ${amount}`);
});
