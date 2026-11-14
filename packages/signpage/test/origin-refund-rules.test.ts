// The refund rules for a quote a device wallet pays (card refunds-land-on-the-devices-own-wallet): the vault's deposit
// quote rule (src/rules/deposit.ts checkDepositQuote: pool to Cash, a leftover's carry) and the pool deposit quote rule
// (src/pool-deposit-quote.ts checkPoolDepositQuote: pool to pool) accept refundType ORIGIN_CHAIN only to the device's
// own derived address for that leg (`refund` in the rule's context), and refuse anything else before the answer is
// read: INTENTS where the leg names its own refund, ORIGIN_CHAIN to any other address or chain, ORIGIN_CHAIN with no
// refund of the device's. With no `refund`, the rules are as they were: INTENTS under the id.
//   node --test test/origin-refund-rules.test.ts
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

const { depositQuoteRequest, poolDepositQuoteRequest } = await import("../../wallet/src/deposit/quote.ts");
const { depositId, depositIdEvm } = await import("../../wallet/src/derive/keys.ts");
const { base58 } = await import("@scure/base");
const { DepositRuleRefused, checkDepositQuote } = await import("../src/rules/deposit.ts");
const { checkPoolDepositQuote } = await import("../src/pool-deposit-quote.ts");

const NOW = Date.parse("2026-11-14T07:00:00.000Z");
const SOL = "nep141:sol.omft.near", BASE_ETH = "nep141:base.omft.near";
// the all-zero seed (a published test seed, no user's): each secret zeroed at once
const SEED64 = new Uint8Array(64);
const k0 = depositId(SEED64, 777n, 0), k1 = depositId(SEED64, 777n, 1), e0 = depositIdEvm(SEED64, 777n, 0), e1 = depositIdEvm(SEED64, 777n, 1);
const ID = k0.id, SOL_U = base58.encode(k0.publicKey), OTHER_SOL = base58.encode(k1.publicKey), EVM_U = e0.address, OTHER_EVM = e1.address;
for (const k of [k0, k1, e0, e1]) k.secretKey.fill(0);
const SEED = { source: "words", code_saved: true };
const CHECK = { path: "keyless" as const, pricing: { in: ["150", "150"], out: ["1", "1"] } as const, decimalsIn: 9, decimalsOut: 6, now: NOW };

/** The rule's refusal code, or "answer" when the request passed every request rule and the kit read the (empty) answer. */
const ruleOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof DepositRuleRefused ? e.rule : "answer";
  }
  return "passed";
};

const cash = (req: ReturnType<typeof depositQuoteRequest>, refund?: { chain: "solana" | "base" | "robinhood"; to: string }) =>
  ruleOf(() => checkDepositQuote(req, {}, { seed: SEED, depositId: ID, check: CHECK, confidential: true, ...(refund === undefined ? {} : { refund }) }));

test("pool to Cash: ORIGIN_CHAIN to the device's own Solana address passes the request rules (the answer read next)", () => {
  const req = depositQuoteRequest(ID, SOL, 10n ** 8n, NOW, true, { chain: "solana", to: SOL_U });
  assert.equal(cash(req, { chain: "solana", to: SOL_U }), "answer");
});

test("pool to Cash: INTENTS where the leg names its own refund is refused", () => {
  // its refundTo is U's hex id, not the leg's own address: refused at refundTo
  assert.equal(cash(depositQuoteRequest(ID, SOL, 10n ** 8n, NOW, true), { chain: "solana", to: SOL_U }), "refundTo");
  // the right address asked INTENTS: refused at refundType
  assert.equal(cash({ ...depositQuoteRequest(ID, SOL, 10n ** 8n, NOW, true, { chain: "solana", to: SOL_U }), refundType: "INTENTS" }, { chain: "solana", to: SOL_U }), "refundType");
  assert.equal(cash({ ...depositQuoteRequest(ID, SOL, 10n ** 8n, NOW, true, { chain: "solana", to: SOL_U }), refundType: "CONFIDENTIAL_INTENTS" }, { chain: "solana", to: SOL_U }), "refundType");
});

test("pool to Cash: ORIGIN_CHAIN to an address that is not the device's own for the leg is refused", () => {
  const other = depositQuoteRequest(ID, SOL, 10n ** 8n, NOW, true, { chain: "solana", to: OTHER_SOL });
  assert.equal(cash(other, { chain: "solana", to: SOL_U }), "refundTo");
  // and a hand-made request naming an attacker's EVM address on the SOL leg
  assert.equal(cash({ ...depositQuoteRequest(ID, SOL, 10n ** 8n, NOW, true, { chain: "solana", to: SOL_U }), refundTo: EVM_U }, { chain: "solana", to: SOL_U }), "refundTo");
});

test("pool to Cash: ORIGIN_CHAIN with no refund of the device's is refused; a refund off the origin's chain is refused", () => {
  assert.equal(cash(depositQuoteRequest(ID, SOL, 10n ** 8n, NOW, true, { chain: "solana", to: SOL_U })), "refundTo");
  assert.equal(cash({ ...depositQuoteRequest(ID, SOL, 10n ** 8n, NOW, true), refundType: "ORIGIN_CHAIN" }), "refundType");
  assert.equal(cash(depositQuoteRequest(ID, SOL, 10n ** 8n, NOW, true, { chain: "solana", to: SOL_U }), { chain: "base", to: EVM_U }), "refundTo");
});

test("with no refund named the deposit rule is as it was: INTENTS under U", () => {
  assert.equal(cash(depositQuoteRequest(ID, SOL, 10n ** 8n, NOW, true)), "answer");
});

const pool = (req: ReturnType<typeof poolDepositQuoteRequest>, refund?: { chain: "solana" | "base" | "robinhood"; to: string }) =>
  ruleOf(() => checkPoolDepositQuote(req, {}, {
    seed: SEED, chain: "solana", wallet: SOL_U, refundId: ID, check: { ...CHECK, pricing: { in: ["3000", "3000"], out: ["150", "150"] }, decimalsIn: 18, decimalsOut: 9 },
    floor: 10_000_000n, confidential: true, ...(refund === undefined ? {} : { refund }),
  }));

test("pool to pool: ETH from Base into Solana's pool refunds ORIGIN_CHAIN to U^evm on Base, and only there", () => {
  const good = poolDepositQuoteRequest("solana", SOL_U, ID, BASE_ETH, 10n ** 16n, NOW, true, { chain: "base", to: EVM_U });
  assert.equal(pool(good, { chain: "base", to: EVM_U }), "answer");
  assert.equal(pool(poolDepositQuoteRequest("solana", SOL_U, ID, BASE_ETH, 10n ** 16n, NOW, true), { chain: "base", to: EVM_U }), "refundTo");
  assert.equal(pool({ ...good, refundType: "INTENTS" }, { chain: "base", to: EVM_U }), "refundType");
  assert.equal(pool(poolDepositQuoteRequest("solana", SOL_U, ID, BASE_ETH, 10n ** 16n, NOW, true, { chain: "base", to: OTHER_EVM }), { chain: "base", to: EVM_U }), "refundTo");
  assert.equal(pool(good), "refundTo");
  assert.equal(pool(good, { chain: "robinhood", to: EVM_U }), "refundTo");
});
