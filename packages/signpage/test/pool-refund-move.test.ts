// The pool refund carry (card pool-deposit-follow): a pool quote 1Click refunded lands under U_{s,i} inside intents.near;
// the device moves it with the same signer back to X's coin, delivered to U_X on X, refunded again under U_{s,i}, and
// the follow carries it on into the pool. The quote passes only with those ends and a min out over the pool's floor;
// its intent is the refund move's own (checkIdTransferIntent), signed by U_{s,i}.
//   node --test test/pool-refund-move.test.ts
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, ADDRESS, ATTACKER, H72, COLLECTOR, signAnswer, mockKey, type Answer } from "./oneclick-mock.ts";

const { oneClickFloors } = await import("../../kit/src/checks/oneclick.ts");
const { poolRefundMoveRequest, refundMoveRequest } = await import("../../wallet/src/deposit/refund.ts");
const { depositId, depositIdEvm } = await import("../../wallet/src/derive/keys.ts");
const { base58 } = await import("@scure/base");
const R = await import("../src/rules/refund.ts");
type Req = ReturnType<typeof refundMoveRequest>;

const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
// U_{s,i} and U^evm_{s,i} of the all-zero seed (a published test seed, no user's): each secret zeroed at once
const SEED64 = new Uint8Array(64);
const k0 = depositId(SEED64, 777n, 0), k1 = depositId(SEED64, 777n, 1), ke = depositIdEvm(SEED64, 777n, 0);
const SOL_U = base58.encode(k0.publicKey), ID = k0.id, PUB = Uint8Array.from(k0.publicKey), EVM_U = ke.address;
const OTHER_SOL = base58.encode(k1.publicKey);
for (const k of [k0, k1, ke]) k.secretKey.fill(0);
const PRICING = { in: ["1", "1"], out: ["150", "150.1"] } as const;
const check = (decimalsOut: number) => ({ path: "keyless" as const, pricing: PRICING, decimalsIn: 6, decimalsOut, now: NOW });
const signer = { role: "U" as const, id: ID, publicKey: PUB };
const ctxOf = (chain: "solana" | "base", wallet: string, decimalsOut: number, floor = chain === "solana" ? 13_586_400n : 10n ** 15n) =>
  ({ network: "mainnet" as const, signer, origin: BASE_USDC, chain, wallet, floor, check: check(decimalsOut) });

function answerOf(req: Req, decimalsOut: number, change?: (a: Answer) => void): Answer {
  const withdrawFee = 5_000n;
  const { minAmountOut } = oneClickFloors({ amountIn: BigInt(req.amount), withdrawFee, slippageBps: req.slippageTolerance, feeBps: 20, pricing: PRICING, decimalsIn: 6, decimalsOut, intoVault: false });
  const out = minAmountOut + 1_000n, min = out - 500n;
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
const refused = (rule: string, f: () => unknown) => assert.throws(f, (e: unknown) => e instanceof R.RefundRuleRefused && e.rule === rule, rule);

test("the request: the refunded asset inside intents.near to X's coin, delivered to U_X, refunded under U_{s,i}", () => {
  const req = poolRefundMoveRequest("solana", SOL_U, ID, BASE_USDC, 25_000_000n, NOW);
  assert.equal(req.depositType, "INTENTS");
  assert.equal(req.originAsset, BASE_USDC);
  assert.equal(req.destinationAsset, "nep141:sol.omft.near");
  assert.equal(req.recipient, SOL_U);
  assert.equal(req.recipientType, "DESTINATION_CHAIN");
  assert.equal(req.refundTo, ID);
  assert.equal(req.refundType, "INTENTS");
  assert.equal(poolRefundMoveRequest("base", EVM_U, ID, BASE_USDC, 1n, NOW).destinationAsset, "nep141:base.omft.near");
  // a U_X that is not the id's own wallet: no request
  assert.throws(() => poolRefundMoveRequest("solana", OTHER_SOL, ID, BASE_USDC, 1n, NOW));
  assert.throws(() => poolRefundMoveRequest("base", EVM_U.toLowerCase(), "zz", BASE_USDC, 1n, NOW));
});

test("a pool refund quote to U_X passes, and the refund move's intent check takes it (a copy it does not)", () => {
  const req = poolRefundMoveRequest("solana", SOL_U, ID, BASE_USDC, 25_000_000n, NOW);
  const q = R.checkPoolRefundQuote(req, answerOf(req, 9), ctxOf("solana", SOL_U, 9));
  assert.equal(q.depositAddress, ADDRESS);
  // the checked quote is one the refund move's intent check takes (it reads the payload next), a copy of it is not
  const ictx = { network: "mainnet" as const, signer, reads: [] as never, priorDeadline: null };
  refused("payload", () => R.checkIdTransferIntent("not json", q, ictx));
  refused("unchecked", () => R.checkIdTransferIntent("not json", { ...q }, ictx));
  const b = poolRefundMoveRequest("base", EVM_U, ID, BASE_USDC, 25_000_000n, NOW);
  assert.equal(R.checkPoolRefundQuote(b, answerOf(b, 18), ctxOf("base", EVM_U, 18)).depositAddress, ADDRESS);
});

test("any other end is refused before the answer is read: the vault's asset, another recipient, another refund, the vault's request", () => {
  const req = poolRefundMoveRequest("solana", SOL_U, ID, BASE_USDC, 25_000_000n, NOW);
  const ans = answerOf(req, 9);
  const ctx = ctxOf("solana", SOL_U, 9);
  refused("destinationAsset", () => R.checkPoolRefundQuote({ ...req, destinationAsset: "nep141:base.omft.near" }, ans, ctx));
  refused("recipient", () => R.checkPoolRefundQuote({ ...req, recipient: OTHER_SOL }, ans, ctx));
  refused("recipient", () => R.checkPoolRefundQuote({ ...req, recipient: ID }, ans, ctx));
  refused("recipientType", () => R.checkPoolRefundQuote({ ...req, recipientType: "INTENTS" }, ans, ctx));
  refused("refundTo", () => R.checkPoolRefundQuote({ ...req, refundTo: ATTACKER }, ans, ctx));
  refused("refundType", () => R.checkPoolRefundQuote({ ...req, refundType: "ORIGIN_CHAIN" }, ans, ctx));
  refused("depositType", () => R.checkPoolRefundQuote({ ...req, depositType: "ORIGIN_CHAIN" }, ans, ctx));
  refused("originAsset", () => R.checkPoolRefundQuote({ ...req, originAsset: "nep141:wrap.near" }, ans, ctx));
  // the vault's refund move request (into the vault's USDC, to the id) is no pool refund
  const vault = refundMoveRequest(ID, BASE_USDC, 25_000_000n, NOW);
  refused("destinationAsset", () => R.checkPoolRefundQuote(vault, answerOf(vault, 6), ctx));
  // the context must name a U_X that is the id's own wallet, and a signer U
  refused("deposit_wallet", () => R.checkPoolRefundQuote(req, ans, ctxOf("solana", OTHER_SOL, 9)));
  refused("signer", () => R.checkPoolRefundQuote(req, ans, { ...ctx, signer: { ...signer, role: "R" } }));
  refused("network", () => R.checkPoolRefundQuote(req, ans, { ...ctx, network: "testnet" }));
});

test("the pool's floor holds on min out: under it, or no floor, or one under the rung, is refused floor", () => {
  const req = poolRefundMoveRequest("solana", SOL_U, ID, BASE_USDC, 2_000_000n, NOW); // about 0.0132 SOL of min out
  const ans = answerOf(req, 9);
  refused("floor", () => R.checkPoolRefundQuote(req, ans, ctxOf("solana", SOL_U, 9)));
  const big = poolRefundMoveRequest("solana", SOL_U, ID, BASE_USDC, 25_000_000n, NOW);
  const bigAns = answerOf(big, 9);
  refused("floor", () => R.checkPoolRefundQuote(big, bigAns, ctxOf("solana", SOL_U, 9, 9_999_999n)));
  refused("floor", () => R.checkPoolRefundQuote(big, bigAns, { ...ctxOf("solana", SOL_U, 9), floor: undefined as never }));
  // an answer that delivers to another wallet fails the kit's echo
  assert.throws(() => R.checkPoolRefundQuote(big, answerOf(big, 9, (a) => { a.quoteRequest.recipient = OTHER_SOL; }), ctxOf("solana", SOL_U, 9)), /echo/);
});
