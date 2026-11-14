// Cash to another chain (card cash-withdraws-everything-to-any-chain, Part B): each part's 1Click quote is the device's
// own request, NEAR's USDC in to the typed address's USDC out, its refund under V_{l,j} inside intents.near, and its
// answer passes the kit's check, carries the part as its amount in and a NEAR implicit deposit address, or the vault
// pays nothing. The answers are test/oneclick-mock.ts's, signed by a key this process alone trusts.
//   node --test test/cash-withdraw-onward.test.ts   (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { h1c, mockKey, otherKey, signAnswer, type Answer } from "./oneclick-mock.ts";

const { checkOnwardQuote, onwardQuoteRequest, onwardTo, ONWARD_ORIGIN, ONWARD_USDC } = await import("../src/withdraw/onward.ts");

const SOL_TO = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const BASE_TO = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const V = "ab".repeat(32);
const DEPOSIT = "cd".repeat(32);
const PART = 25_000_000n; // the mock's answer is 25 USDC in
const ask = async (chain: "solana" | "base", to: string, m: Parameters<typeof h1c>[0] = {}) => {
  const now = Date.now();
  const req = onwardQuoteRequest(chain, to, V, PART, now);
  const { fetch } = h1c({ stampedAt: now - 500, before: (a: Answer) => void (a.quote.depositAddress = DEPOSIT), ...m });
  const r = await fetch("https://x/v1/proxy/oneclick/v0/quote", { method: "POST", body: JSON.stringify(req) });
  return { req, body: (await r.json()) as unknown };
};

test("the request: NEAR's USDC in, exactly the part, the chain's USDC out to the typed address, the refund under V inside intents.near", () => {
  const r = onwardQuoteRequest("solana", SOL_TO, V, PART, Date.parse("2026-11-13T21:00:00Z"));
  assert.deepEqual(r, {
    dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: ONWARD_ORIGIN, depositType: "ORIGIN_CHAIN", destinationAsset: ONWARD_USDC.solana,
    amount: "25000000", refundTo: V, refundType: "INTENTS", recipient: SOL_TO, recipientType: "DESTINATION_CHAIN", deadline: "2026-11-13T21:30:00.000Z",
  });
  assert.equal(onwardQuoteRequest("base", BASE_TO, V, PART, Date.now()).destinationAsset, ONWARD_USDC.base);
  assert.throws(() => onwardQuoteRequest("solana", "alice.near", V, PART, Date.now()), /not an address on the chain/);
  assert.throws(() => onwardQuoteRequest("solana", SOL_TO, "alice.near", PART, Date.now()), /refund id/);
});

test("the typed address per chain: Solana base58 keys, Base EIP-55 addresses; anything else is none", () => {
  assert.equal(onwardTo("solana", ` ${SOL_TO}\u200B `), SOL_TO);
  assert.equal(onwardTo("solana", "11111111111111111111111111111111"), null, "the System program");
  assert.equal(onwardTo("solana", BASE_TO), null);
  assert.equal(onwardTo("base", BASE_TO.toLowerCase()), BASE_TO, "all lower case: checksummed");
  assert.equal(onwardTo("base", BASE_TO.replace("C", "c")), null, "a wrong checksum");
  assert.equal(onwardTo("base", "0x0000000000000000000000000000000000000000"), null);
  assert.equal(onwardTo("base", SOL_TO), null);
});

test("a checked answer gives the deposit address the vault pays and the least that arrives", async () => {
  for (const [chain, to] of [["solana", SOL_TO], ["base", BASE_TO]] as const) {
    const { req, body } = await ask(chain, to);
    assert.deepEqual(checkOnwardQuote(req, body, { chain, to, refundId: V, amount: PART }), { depositAddress: DEPOSIT, minOut: 24_742_080n });
  }
});

test("a hostile answer is refused before the vault pays anything", async () => {
  const ctx = { chain: "solana" as const, to: SOL_TO, refundId: V, amount: PART };
  const refused = async (m: Parameters<typeof h1c>[0], re: RegExp, c = ctx) => {
    const { req, body } = await ask("solana", SOL_TO, m);
    assert.throws(() => checkOnwardQuote(req, body, c), re);
  };
  await refused({ before: (a) => void ((a.quote.depositAddress = DEPOSIT), (a.quoteRequest.recipient = "9".repeat(44))) }, /echo|recipient/);
  await refused({ before: (a) => void ((a.quote.depositAddress = DEPOSIT), (a.quoteRequest.refundTo = "ef".repeat(32))) }, /echo|refundTo/);
  await refused({ before: () => {} }, /deposit address is not a NEAR implicit id/); // the mock's own address, a Solana key
  await refused({ key: otherKey.privateKey }, /signature/);
  await refused({ after: (a) => void (a.quote.depositAddress = "ef".repeat(32)) }, /signature/);
  await refused({ stampedAt: Date.now() - 600_000 }, /timestamp/);
  await refused({ before: (a) => void ((a.quote.depositAddress = DEPOSIT), (a.quote.minAmountOut = "1000"), (a.quote.amountOut = "1000")) }, /floor|amount/);
  // the request is held to this part: another amount, address or refund id is not this part's
  await refused({}, /not this part's/, { ...ctx, amount: PART - 1n });
  await refused({}, /not this part's/, { ...ctx, refundId: "ef".repeat(32) });
  assert.ok(mockKey);
  assert.equal(typeof signAnswer, "function");
});
