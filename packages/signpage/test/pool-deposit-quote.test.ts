// The pool deposit quote rule (card pool-deposit-address; src/pool-deposit-quote.ts): a quote for money from another
// chain into chain X's pool passes only when it sends X's coin to U_X and refunds under U_X's own key; a quote whose
// recipient or refund is not U_X is refused, as is a request built for another wallet or chain.
//   node --test test/pool-deposit-quote.test.ts
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, ATTACKER, ADDRESS, H72, COLLECTOR, signAnswer, mockKey, type Answer } from "./oneclick-mock.ts";

const { OneClickQuoteError, oneClickFloors } = await import("../../kit/src/checks/oneclick.ts");
const { poolDepositQuoteRequest, poolRefundId } = await import("../../wallet/src/deposit/quote.ts");
const { DepositRuleRefused } = await import("../src/rules/deposit.ts");
const { checkPoolDepositQuote } = await import("../src/pool-deposit-quote.ts");
type Req = ReturnType<typeof poolDepositQuoteRequest>;

const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const SOL_U = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T"; // a 32-byte base58 key; no secret of it is used
const EVM_U = "0x52908400098527886E0F7030069857D2E4169EE7"; // EIP-55's own vector
const OTHER_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SEED = { source: "words", code_saved: true };
const PRICING = { in: ["1", "1"], out: ["150", "150.1"] } as const; // USDC in, the pool's coin out: two reads each

const ctxOf = (chain: "solana" | "base", wallet: string, decimalsOut: number) => ({
  seed: SEED, chain, wallet, check: { path: "keyless" as const, pricing: PRICING, decimalsIn: 6, decimalsOut, now: NOW },
});

/** 1Click's signed answer to `req`, at its own floor plus `extra`, with the pair's fee entry. */
function answerOf(req: Req, decimalsOut: number, extra = 1_000n, change?: (a: Answer) => void): Answer {
  const withdrawFee = 5_000n;
  const { minAmountOut } = oneClickFloors({ amountIn: BigInt(req.amount), withdrawFee, slippageBps: req.slippageTolerance, feeBps: 20,
    pricing: PRICING, decimalsIn: 6, decimalsOut, intoVault: false });
  const out = minAmountOut + extra, min = out - 500n;
  const fmt = (v: bigint, d: number) => { const s = v.toString().padStart(d + 1, "0"); return `${s.slice(0, -d)}.${s.slice(-d)}`; };
  const a: Answer = {
    quote: {
      amountIn: req.amount, amountInFormatted: fmt(BigInt(req.amount), 6), amountInUsd: "25.0", minAmountIn: req.amount,
      amountOut: out.toString(), amountOutFormatted: fmt(out, decimalsOut), amountOutUsd: "24.9", minAmountOut: min.toString(),
      depositAddress: ADDRESS, deadline: new Date(Date.parse(req.deadline) + H72).toISOString(),
      timeWhenInactive: new Date(Date.parse(req.deadline) + H72).toISOString(), timeEstimate: 20, refundFee: "0", withdrawFee: withdrawFee.toString(),
    },
    quoteRequest: { ...req, depositMode: "SIMPLE", confidentiality: "public", quoteWaitingTimeMs: 0, insured: false, appFees: [{ recipient: COLLECTOR, fee: 20 }] },
    signature: "", timestamp: new Date(NOW - 500).toISOString(), correlationId: "00000000-0000-4000-8000-000000000000",
  };
  change?.(a);
  signAnswer(a, mockKey.privateKey);
  return a;
}

const refusedRule = (rule: string, f: () => unknown) =>
  assert.throws(f, (e: unknown) => e instanceof DepositRuleRefused && e.rule === rule, rule);
const refusedAnswer = (check: string, f: () => unknown) =>
  assert.throws(f, (e: unknown) => e instanceof OneClickQuoteError && (e as { check?: string }).check === check, check);

test("a quote of money from Base into the Solana pool, to U_X, passes; its signed address comes back", () => {
  const req = poolDepositQuoteRequest("solana", SOL_U, BASE_USDC, 25_000_000n, NOW);
  const c = checkPoolDepositQuote(req, answerOf(req, 9), ctxOf("solana", SOL_U, 9));
  assert.equal(c.depositAddress, ADDRESS);
  assert.equal(c.amountIn, 25_000_000n);
});

test("a quote of money from Solana into the Base pool, to U_X, passes", () => {
  const req = poolDepositQuoteRequest("base", EVM_U, SOL_USDC, 25_000_000n, NOW);
  assert.equal(checkPoolDepositQuote(req, answerOf(req, 18, 10n ** 9n), ctxOf("base", EVM_U, 18)).depositAddress, ADDRESS);
});

test("an answer whose recipient is not U_X is refused, even signed by 1Click", () => {
  const req = poolDepositQuoteRequest("solana", SOL_U, BASE_USDC, 25_000_000n, NOW);
  refusedAnswer("echo", () => checkPoolDepositQuote(req, answerOf(req, 9, 1_000n, (a) => { a.quoteRequest.recipient = OTHER_SOL; }), ctxOf("solana", SOL_U, 9)));
  refusedAnswer("echo", () => checkPoolDepositQuote(req, answerOf(req, 9, 1_000n, (a) => { a.quoteRequest.refundTo = ATTACKER; }), ctxOf("solana", SOL_U, 9)));
  refusedAnswer("echo", () => checkPoolDepositQuote(req, answerOf(req, 9, 1_000n, (a) => { a.quoteRequest.refundType = "ORIGIN_CHAIN"; }), ctxOf("solana", SOL_U, 9)));
  refusedAnswer("echo", () => checkPoolDepositQuote(req, answerOf(req, 9, 1_000n, (a) => { a.quoteRequest.destinationAsset = "nep141:wrap.near"; }), ctxOf("solana", SOL_U, 9)));
});

test("a request whose recipient or refund is not U_X is refused before its answer is read", () => {
  const req = poolDepositQuoteRequest("solana", SOL_U, BASE_USDC, 25_000_000n, NOW);
  const ans = answerOf(req, 9);
  const ctx = ctxOf("solana", SOL_U, 9);
  refusedRule("recipient", () => checkPoolDepositQuote({ ...req, recipient: OTHER_SOL }, ans, ctx));
  refusedRule("recipientType", () => checkPoolDepositQuote({ ...req, recipientType: "INTENTS" }, ans, ctx));
  refusedRule("refundTo", () => checkPoolDepositQuote({ ...req, refundTo: ATTACKER }, ans, ctx));
  refusedRule("refundTo", () => checkPoolDepositQuote({ ...req, refundTo: SOL_U }, ans, ctx)); // the base58 form is no intents id
  refusedRule("refundType", () => checkPoolDepositQuote({ ...req, refundType: "ORIGIN_CHAIN" }, ans, ctx));
  refusedRule("destinationAsset", () => checkPoolDepositQuote({ ...req, destinationAsset: "nep141:base.omft.near" }, ans, ctx));
  refusedRule("dry", () => checkPoolDepositQuote({ ...req, dry: true }, ans, ctx));
  refusedRule("request", () => checkPoolDepositQuote({ ...req, customRecipientMsg: "x" } as Req, ans, ctx));
  // the request of another wallet passes only that wallet's own context
  const other = poolDepositQuoteRequest("solana", OTHER_SOL, BASE_USDC, 25_000_000n, NOW);
  refusedRule("recipient", () => checkPoolDepositQuote(other, answerOf(other, 9), ctx));
});

test("the context must name a wallet of its chain, and a seed past its backup gate", () => {
  const req = poolDepositQuoteRequest("solana", SOL_U, BASE_USDC, 25_000_000n, NOW);
  const ans = answerOf(req, 9);
  refusedRule("deposit_wallet", () => checkPoolDepositQuote(req, ans, ctxOf("solana", EVM_U, 9)));
  refusedRule("deposit_wallet", () => checkPoolDepositQuote(req, ans, ctxOf("base", SOL_U, 9)));
  refusedRule("chain", () => checkPoolDepositQuote(req, ans, { ...ctxOf("solana", SOL_U, 9), chain: "near" as "solana" }));
  refusedRule("backup", () => checkPoolDepositQuote(req, ans, { ...ctxOf("solana", SOL_U, 9), seed: { source: "words", code_saved: false } }));
});

test("an answer below the device's own floor, or priced past its two reads, is refused", () => {
  const req = poolDepositQuoteRequest("solana", SOL_U, BASE_USDC, 25_000_000n, NOW);
  refusedAnswer("floor", () => checkPoolDepositQuote(req, answerOf(req, 9, -10_000n), ctxOf("solana", SOL_U, 9)));
  const wide = { ...ctxOf("solana", SOL_U, 9), check: { ...ctxOf("solana", SOL_U, 9).check, pricing: { in: ["1", "1"], out: ["150", "160"] } as const } };
  refusedAnswer("price", () => checkPoolDepositQuote(req, answerOf(req, 9), wide));
  assert.equal(poolRefundId("solana", SOL_U).length, 64);
});
