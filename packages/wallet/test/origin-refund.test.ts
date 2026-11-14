// A failed swap's refund lands on the device's own wallet on its chain (card refunds-land-on-the-devices-own-wallet).
// A 1Click quote whose origin is a pool coin a device-held wallet pays (a Move from a pool, a leftover's carry to Cash)
// asks refundType ORIGIN_CHAIN with refundTo the quote's own deposit key on that coin's chain: base58 of U_{s,i} on
// Solana, U^evm_{s,i} on Base and Robinhood. Never INTENTS there: a refund resting in public intents.near can be frozen
// by the intents.near DAO. A request for any other origin, or to an address not of the origin's chain, is not built.
//   node --test test/origin-refund.test.ts
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { depositId, depositIdEvm } from "../src/derive/keys.ts";
import { checkOriginRefund, depositQuoteRequest, poolCoinChain, poolDepositQuoteRequest } from "../src/deposit/quote.ts";

const NOW = Date.parse("2026-11-14T07:00:00.000Z");
const SOL = "nep141:sol.omft.near", BASE_ETH = "nep141:base.omft.near", HOOD_ETH = "nep141:hood.omft.near";
const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
// the published all-zero seed of test/vectors/a8.json's kind: no secret of a user
const SEED = new Uint8Array(64);
const S = 12345n;
const sol = depositId(SEED, S, 0);
const evm = depositIdEvm(SEED, S, 0);
const ID = sol.id, SOL_U = base58.encode(sol.publicKey), EVM_U = evm.address;
sol.secretKey.fill(0);
evm.secretKey.fill(0);

test("each pool coin names its chain; any other origin none", () => {
  assert.equal(poolCoinChain(SOL), "solana");
  assert.equal(poolCoinChain(BASE_ETH), "base");
  assert.equal(poolCoinChain(HOOD_ETH), "robinhood");
  for (const a of [SOL_USDC, NEAR_USDC, "", "nep141:wrap.near", "toString", "__proto__"]) assert.equal(poolCoinChain(a), null, a);
});

test("pool to Cash and a leftover's carry: SOL into Cash refunds ORIGIN_CHAIN to base58 U_{s,i} on Solana, not INTENTS", () => {
  const r = depositQuoteRequest(ID, SOL, 100_000_000n, NOW, true, { chain: "solana", to: SOL_U });
  assert.equal(r.refundType, "ORIGIN_CHAIN");
  assert.equal(r.refundTo, SOL_U);
  assert.equal(r.recipient, ID);
  assert.equal(r.recipientType, "DESTINATION_CHAIN");
  assert.equal(r.originAsset, SOL);
});

test("pool to Cash from Base and Robinhood: ETH refunds ORIGIN_CHAIN to U^evm_{s,i} on its chain", () => {
  for (const [asset, chain] of [[BASE_ETH, "base"], [HOOD_ETH, "robinhood"]] as const) {
    const r = depositQuoteRequest(ID, asset, 10n ** 16n, NOW, true, { chain, to: EVM_U });
    assert.equal(r.refundType, "ORIGIN_CHAIN");
    assert.equal(r.refundTo, EVM_U);
  }
});

test("pool to pool: SOL into Base's pool refunds ORIGIN_CHAIN on Solana; ETH into Solana's pool on Base", () => {
  const a = poolDepositQuoteRequest("base", EVM_U, ID, SOL, 100_000_000n, NOW, true, { chain: "solana", to: SOL_U });
  assert.deepEqual([a.refundType, a.refundTo, a.recipient], ["ORIGIN_CHAIN", SOL_U, EVM_U]);
  const b = poolDepositQuoteRequest("solana", SOL_U, ID, BASE_ETH, 10n ** 16n, NOW, true, { chain: "base", to: EVM_U });
  assert.deepEqual([b.refundType, b.refundTo, b.recipient], ["ORIGIN_CHAIN", EVM_U, SOL_U]);
  const c = poolDepositQuoteRequest("robinhood", EVM_U, ID, BASE_ETH, 10n ** 16n, NOW, true, { chain: "base", to: EVM_U });
  assert.deepEqual([c.refundType, c.refundTo], ["ORIGIN_CHAIN", EVM_U]);
});

test("no refund named: the request is as before, INTENTS under the id (an outside wallet's money, Cash's NEAR USDC)", () => {
  assert.deepEqual([depositQuoteRequest(ID, SOL_USDC, 1n, NOW).refundType, depositQuoteRequest(ID, SOL_USDC, 1n, NOW).refundTo], ["INTENTS", ID]);
  const p = poolDepositQuoteRequest("solana", SOL_U, ID, NEAR_USDC, 1n, NOW, true);
  assert.deepEqual([p.refundType, p.refundTo], ["INTENTS", ID]);
});

test("a refund off the origin's chain, or not an address the device derives there, builds no request", () => {
  const bad: [string, { chain: never; to: string }][] = [
    [SOL, { chain: "base" as never, to: EVM_U }], // ETH's chain for a SOL origin
    [BASE_ETH, { chain: "robinhood" as never, to: EVM_U }], // the other EVM chain
    [SOL_USDC, { chain: "solana" as never, to: SOL_U }], // an outside wallet's USDC: no device address there
    [NEAR_USDC, { chain: "solana" as never, to: SOL_U }],
    [SOL, { chain: "solana" as never, to: ID }], // the hex id is no Solana address
    [SOL, { chain: "solana" as never, to: base58.encode(new Uint8Array(31)) }],
    [BASE_ETH, { chain: "base" as never, to: EVM_U.toLowerCase() }], // not EIP-55 as derived
    [BASE_ETH, { chain: "base" as never, to: SOL_U }],
    [BASE_ETH, { chain: "near" as never, to: ID }],
  ];
  for (const [asset, refund] of bad) {
    assert.throws(() => checkOriginRefund(asset, refund), `${asset} ${refund.chain} ${refund.to}`);
    assert.throws(() => depositQuoteRequest(ID, asset, 1n, NOW, true, refund), `${asset} ${refund.chain}`);
    const [to, wallet] = asset === SOL ? (["base", EVM_U] as const) : (["solana", SOL_U] as const);
    assert.throws(() => poolDepositQuoteRequest(to, wallet, ID, asset, 1n, NOW, true, refund), `${asset} ${refund.chain}`);
  }
});
