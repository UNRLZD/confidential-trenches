// The pool deposit quote's request (card pool-deposit-address): money from another chain into chain X's pool goes by
// 1Click to U_X, the chain's one-time deposit wallet, and a refund lands inside intents.near under U_{s,i}, the scope's
// own ed25519 one-time id (derive/keys.ts depositId), the one key the refund move already signs with. On Solana U_X is
// that same key; on Base and Robinhood U_X is U^evm_{s,i} and the refund id is U_{s,i} of the same scope and index.
//   node --test test/pool-deposit-quote.test.ts
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { depositId, depositIdEvm } from "../src/derive/keys.ts";
import { POOL_DEPOSIT_DESTINATION, checkPoolDepositWallet, poolDepositQuoteRequest } from "../src/deposit/quote.ts";

const NOW = Date.parse("2026-11-07T23:00:00.000Z");
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
// the published all-zero seed of test/vectors/a8.json's kind: no secret of a user
const SEED = new Uint8Array(64);
const S = 12345n;
const sol = depositId(SEED, S, 0);
const SOL_U = base58.encode(sol.publicKey);
const SOL_ID = sol.id;
const evm = depositIdEvm(SEED, S, 0);
const EVM_U = evm.address;
const EVM_REFUND = depositId(SEED, S, 0).id;
sol.secretKey.fill(0);
evm.secretKey.fill(0);

test("the destinations are the pools' native coins on 1Click, as the return's table pins them", () => {
  assert.deepEqual({ ...POOL_DEPOSIT_DESTINATION }, { solana: "nep141:sol.omft.near", base: "nep141:base.omft.near", robinhood: "nep141:hood.omft.near" });
  assert.ok(Object.isFrozen(POOL_DEPOSIT_DESTINATION));
});

test("a Solana pool's request: U_X the recipient on Solana, its own 64-hex id the INTENTS refund, live, nothing more", () => {
  assert.deepEqual(poolDepositQuoteRequest("solana", SOL_U, SOL_ID, BASE_USDC, 25_000_000n, NOW), {
    dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: BASE_USDC, depositType: "ORIGIN_CHAIN",
    destinationAsset: "nep141:sol.omft.near", amount: "25000000",
    refundTo: SOL_ID, refundType: "INTENTS", recipient: SOL_U, recipientType: "DESTINATION_CHAIN", deadline: "2026-11-07T23:30:00.000Z",
  });
});

test("a Base pool's request: U^evm_{s,i} the recipient on Base, U_{s,i}'s 64-hex id the refund: an ed25519 id, never the 0x", () => {
  const r = poolDepositQuoteRequest("base", EVM_U, EVM_REFUND, SOL_USDC, 7_000_000n, NOW);
  assert.equal(r.destinationAsset, "nep141:base.omft.near");
  assert.equal(r.recipient, EVM_U);
  assert.equal(r.recipientType, "DESTINATION_CHAIN");
  assert.equal(r.refundTo, EVM_REFUND);
  assert.match(r.refundTo, /^[0-9a-f]{64}$/);
  assert.equal(r.refundType, "INTENTS");
  assert.equal(r.dry, false);
  assert.equal(poolDepositQuoteRequest("robinhood", EVM_U, EVM_REFUND, SOL_USDC, 7_000_000n, NOW).destinationAsset, "nep141:hood.omft.near");
});

test("the wallet and its refund id: a Solana U_X must be its refund id's own key; an EVM U_X EIP-55 and the id 64-hex", () => {
  assert.doesNotThrow(() => checkPoolDepositWallet("solana", SOL_U, SOL_ID));
  assert.doesNotThrow(() => checkPoolDepositWallet("base", EVM_U, EVM_REFUND));
  for (const [chain, u, id] of [
    ["solana", SOL_U, "ab".repeat(32)], // another key's id: a refund the recipient's key cannot move
    ["solana", SOL_U, SOL_ID.toUpperCase()], ["solana", EVM_U, SOL_ID], ["solana", SOL_ID, SOL_ID], ["solana", base58.encode(new Uint8Array(31)), SOL_ID],
    ["base", EVM_U, EVM_U.toLowerCase()], // the 0x is no ed25519 id: one signer, never ERC-191
    ["base", EVM_U.toLowerCase(), EVM_REFUND], ["base", SOL_U, EVM_REFUND], ["base", EVM_U, "5d".repeat(31)], ["near", SOL_ID, SOL_ID],
  ] as [never, string, string][])
    assert.throws(() => checkPoolDepositWallet(chain, u, id), `${chain} ${u} ${id}`);
});

test("bad input builds no request: a bad wallet or id, a chain with no pool, a bad amount or time, the pool's own coin", () => {
  for (const [chain, u, id, asset, amount, now] of [
    ["solana", SOL_U, "ab".repeat(32), BASE_USDC, 1n, NOW], ["base", EVM_U, EVM_U.toLowerCase(), SOL_USDC, 1n, NOW],
    ["near", SOL_ID, SOL_ID, BASE_USDC, 1n, NOW], ["solana", SOL_U, SOL_ID, "", 1n, NOW], ["solana", SOL_U, SOL_ID, BASE_USDC, 0n, NOW],
    ["solana", SOL_U, SOL_ID, BASE_USDC, 1, NOW], ["solana", SOL_U, SOL_ID, BASE_USDC, 1n, Number.NaN],
    ["solana", SOL_U, SOL_ID, "nep141:sol.omft.near", 1n, NOW], ["base", EVM_U, EVM_REFUND, "nep141:base.omft.near", 1n, NOW],
  ] as [never, string, string, string, bigint, number][])
    assert.throws(() => poolDepositQuoteRequest(chain, u, id, asset, amount, now), `${chain} ${u} ${asset} ${amount}`);
});
