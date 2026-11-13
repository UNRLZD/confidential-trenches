// Card buy-any-amount-on-every-chain: an EVM buy of any amount. The pool's buy swaps a whole release in its own call,
// so a buy of X (the ETH that goes into swaps) is planned over the ready proofs: whole notes each a pool.buy, and the
// rest from one more note released whole to its W, which buys exactly the rest through the pinned adapter itself
// (checkEvmWBuy) and puts its change back into the pool as rungs (checkEvmChange). The quote is replayed from the
// answers Base's two pinned providers gave (kit test/fixtures/evm-quote.json, "base-ok": 0.01 ETH of USDC on v3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { evmPoolVenues, type EvmPoolVenue } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { evmPoolBuyQuoteWith, type EvmPoolBuyQuote, type EvmRpc, type EvmRpcCall } from "../../kit/src/checks/evm/quote.ts";
import { evmQuotedBuy } from "../../kit/src/trade/evm/quoted.ts";
import { asRecorded, gasRoundAnswers, withMarker } from "../../kit/test/evm-quote-gas-fx.ts";
import { evmPoolContextOf, evmPoolScopeOf, EVM_LADDER, type EvmPoolPin, type EvmRelayData } from "../../wallet/src/pool/evm.ts";
import {
  checkEvmBuy,
  checkEvmChange,
  checkEvmWBuy,
  evmAdapterBuyData,
  evmBuyMax,
  evmDepositHeadroom,
  planEvmBuy,
  PoolRuleRefused,
  signEvmBuy,
  signEvmDeposit,
  signEvmWBuy,
  type EvmBuyPiece,
  type EvmDepositReads,
  type EvmOnwardSend,
  type EvmWBuyReads,
  type PoolAsk,
  type PoolContext,
} from "../src/rules/pool.ts";

const refusedAs = (rule: string) => (e: unknown) => e instanceof PoolRuleRefused && e.code === "not_allowed" && e.rule === rule;
const ruleOf = (f: () => unknown): string => {
  try {
    f();
    return "passed";
  } catch (e) {
    if (e instanceof PoolRuleRefused) return e.rule ?? e.code;
    throw e;
  }
};
const ETH = 10n ** 18n;
const milli = (n: bigint) => (n * ETH) / 1_000n;
const NOW = 1_800_000_000_000n;
// a W key made here (no published key needed: nothing is sent), and its address
const W_KEY = new Uint8Array(32).fill(7);
const W = "0x" + Buffer.from(keccak_256(secp256k1.getPublicKey(W_KEY, false).slice(1)).slice(12)).toString("hex");
const { pool: _p, adapters: _a, sellDelegate: _s, feeCollector: _f, ...B } = evmPoolVenues().base;
const POOL = "0x00000000000000000000000000000000000f0011";
const A_V3 = "0x000000000000000000000000000000000000ad03";
const A_V4 = "0x000000000000000000000000000000000000ad04";
const FEE_TO = "0x0000000000000000000000000000000000000fee";
const pin = (v: EvmPoolVenue, o: Partial<EvmPoolVenue>): EvmPoolVenue => Object.freeze({ ...v, ...o });
const VENUES = Object.freeze({ base: pin(B, { pool: POOL, adapters: Object.freeze({ v3: A_V3, v4: A_V4 }) }) });
const ctxOf = (o: Partial<PoolContext> = {}): PoolContext => ({ nowMs: NOW, wallet: W, feeCap: 10n ** 13n, evm: { venues: VENUES, feeRecipient: FEE_TO }, ...o });

type Exchange = { calls: EvmRpcCall[]; answers: unknown[] };
const QF = (JSON.parse(readFileSync(new URL("../../kit/test/fixtures/evm-quote.json", import.meta.url), "utf8")) as Record<string, { request: Record<string, unknown>; now: number; exchanges: [Exchange[], Exchange[]] }>)["base-ok"]!;
const replay = (ex: Exchange[]): EvmRpc => async (sent) => {
  const calls = asRecorded(sent);
  return withMarker(sent, structuredClone(ex.find((x) => JSON.stringify(x.calls) === JSON.stringify(calls))?.answers ?? gasRoundAnswers(ex, calls)!));
};
const buyQuote = (): Promise<EvmPoolBuyQuote> => {
  const { buys, amountIn, ...rest } = QF.request;
  return evmPoolBuyQuoteWith({ ...(rest as object), token: buys as string, amountIn: BigInt(amountIn as string) } as never, [replay(QF.exchanges[0]), replay(QF.exchanges[1])], QF.now);
};

// Base's USDC, the coin the recorded quote buys
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const askOf = (amount: bigint, coin = BASE_USDC): PoolAsk => ({ kind: "pool.buy", chain: "base", token: coin, amount, slippageBps: 100, decimals: 18 });
// the owner's case: notes of 0.002 and 0.001 ETH, each paying a relay fee of 0.00006 ETH (Robinhood's epoch fee at
// 0.02 gwei, read 13 Nov), and $2.37 at $3,500 is 0.000677118972877694 ETH
const FEE = 6n * 10n ** 13n;
const TWO: EvmBuyPiece = { noteId: "a", chunk: milli(2n), fee: FEE };
const ONE: EvmBuyPiece = { noteId: "b", chunk: milli(1n), fee: FEE };
const BOUND = 10n ** 13n;

test("planEvmBuy: any amount up to every note's spend is one plan of whole notes and at most one rest; the rest's note pays W's own buy beside it", () => {
  const x = 677_118_972_877_694n;
  const p = planEvmBuy(askOf(x), [TWO, ONE], BOUND);
  // $2.37: no note's whole spend fits, so the least note that pays it and W's buy carries it all
  assert.deepEqual([p.whole, p.rest], [[], { piece: ONE, spend: x }]);
  // 0.0025 ETH: the 0.002 note whole (0.00194), the rest from the 0.001 note
  const q = planEvmBuy(askOf(milli(5n) / 2n), [ONE, TWO], BOUND);
  assert.deepEqual([q.whole, q.rest], [[TWO], { piece: ONE, spend: milli(5n) / 2n - (TWO.chunk - FEE) }]);
  // Max: every note's spend, every note a whole pool.buy, no rest
  const max = evmBuyMax([TWO, ONE]);
  assert.equal(max, milli(3n) - 2n * FEE);
  const m = planEvmBuy(askOf(max), [TWO, ONE], BOUND);
  assert.deepEqual([m.whole, m.rest], [[TWO, ONE], null]);
  // a note made before the ladder (a carried balance) stays spendable whole
  const odd: EvmBuyPiece = { noteId: "c", chunk: 1_234_567_890_123_456n, fee: FEE };
  assert.deepEqual(planEvmBuy(askOf(odd.chunk - FEE), [odd], BOUND).whole, [odd]);
  // over Max, or within one W buy's bound under it (the rest's W could not pay its own buy): no plan makes it exactly
  assert.throws(() => planEvmBuy(askOf(max + 1n), [TWO, ONE], BOUND), refusedAs("amount"));
  assert.throws(() => planEvmBuy(askOf(max - 1n), [TWO, ONE], BOUND), refusedAs("amount"));
  assert.equal(ruleOf(() => planEvmBuy(askOf(max - BOUND), [TWO, ONE], BOUND)), "passed");
  // a piece twice, a fee at or over its chunk, nothing to buy, a Solana ask
  assert.throws(() => planEvmBuy(askOf(x), [ONE, ONE], BOUND), refusedAs("pieces"));
  assert.throws(() => planEvmBuy(askOf(x), [{ ...ONE, fee: ONE.chunk }], BOUND), refusedAs("pieces"));
  assert.throws(() => planEvmBuy(askOf(0n), [ONE], BOUND), refusedAs("amount"));
  assert.throws(() => planEvmBuy({ ...askOf(x), chain: "solana" }, [ONE], BOUND), refusedAs("kind"));
});

const relay = (o: Partial<EvmRelayData> = {}): EvmRelayData => ({ recipient: W, feeRecipient: FEE_TO, feeCap: 10n ** 13n, deadlineMs: NOW + 120_000n, refundPrecommitment: 7n, salt: "0x" + "ab".repeat(16), ...o });
const proofOf = (r: EvmRelayData, value: bigint) => ({ nullifier: 11n, context: evmPoolContextOf({ processooor: POOL, relay: r }, evmPoolScopeOf(POOL, BigInt(B.chainId))), value });

test("checkEvmBuy: a non-standard amount's whole note passes as a piece of its plan and signs; a proof the plan does not spend whole is refused (red at e0e5034a9: refused amount)", async () => {
  const q = await buyQuote();
  const built = evmQuotedBuy(VENUES, A_V3, q, QF.now);
  const fee = 10n ** 13n;
  // the quote is of 0.01 ETH: the note of 0.01 ETH + its fee is spent whole, and 0.001 ETH more comes from a 0.002 note
  const whole: EvmBuyPiece = { noteId: "w", chunk: q.amountIn + fee, fee };
  const rest: EvmBuyPiece = { noteId: "r", chunk: milli(2n), fee };
  const ask = askOf(q.amountIn + milli(1n), q.token);
  const plan = planEvmBuy(ask, [whole, rest], BOUND);
  assert.deepEqual([plan.whole, plan.rest?.spend], [[whole], milli(1n)]);
  const r = relay();
  const proof = proofOf(r, whole.chunk);
  const agreed = { token: q.token, amountIn: q.amountIn, amountOut: q.amountOut };
  const d = checkEvmBuy(built, POOL, proof, r, ask, ctxOf(), agreed, plan);
  assert.equal(d.amount, q.amountIn);
  assert.equal(signEvmBuy(W_KEY, ctxOf(), built, POOL, proof).length, 65);
  // the rest's note is never a whole pool.buy, nor is a proof of another value; another plan, or one of another amount
  assert.throws(() => checkEvmBuy(built, POOL, proofOf(r, rest.chunk), r, ask, ctxOf(), agreed, plan), refusedAs("amount"));
  assert.throws(() => checkEvmBuy(built, POOL, proofOf(r, whole.chunk + 1n), r, ask, ctxOf(), agreed, plan), refusedAs("amount"));
  assert.throws(() => checkEvmBuy(built, POOL, proof, r, ask, ctxOf(), agreed, { ...plan }), refusedAs("plan"));
  assert.throws(() => checkEvmBuy(built, POOL, proof, r, { ...ask, amount: ask.amount + 1n }, ctxOf(), agreed, plan), refusedAs("plan"));
  // the piece's own fee: a device fee cap other than the piece's finds no piece
  assert.throws(() => checkEvmBuy(built, POOL, proof, r, ask, ctxOf({ feeCap: fee + 1n }), agreed, plan), refusedAs("amount"));
});

const BASE_FEE = 10_000_000n, TIP = 1_000_000n, EST = 300_000n, L1 = 1_000_000_000n;
const GAS = EST + EST / 5n;
const wbuyReads = (balance: bigint, o: Partial<EvmWBuyReads> = {}): EvmWBuyReads => ({ nonce: [0n, 0n], balance: [balance, balance], estimate: [EST, EST], simulated: [true, true], baseFee: [BASE_FEE, BASE_FEE], l1Fee: [L1, L1], priorityCap: TIP, ...o });

test("checkEvmWBuy: W buys exactly the plan's rest through the pinned adapter, the kit's build paying W, its fee within the plan's bound and W's balance; signed with W's key only; each bad field is refused", async () => {
  const q = await buyQuote();
  const built = evmQuotedBuy(VENUES, A_V3, q, QF.now);
  // the rest is the quote's 0.01 ETH, carried by a 0.02 ETH note: W holds the note less its fee
  const carrier: EvmBuyPiece = { noteId: "c", chunk: milli(20n), fee: 10n ** 13n };
  const ask = askOf(q.amountIn, q.token);
  const plan = planEvmBuy(ask, [carrier], BOUND);
  assert.deepEqual([plan.whole, plan.rest], [[], { piece: carrier, spend: q.amountIn }]);
  const held = carrier.chunk - carrier.fee;
  const data = evmAdapterBuyData(built.token, W, built.minOut, built.data);
  const txOf = (o: Partial<EvmOnwardSend> = {}): EvmOnwardSend => ({ type: 2, chainId: BigInt(B.chainId), nonce: 0n, maxPriorityFeePerGas: TIP, maxFeePerGas: 2n * BASE_FEE + TIP, gasLimit: GAS, to: A_V3, value: q.amountIn, data, accessList: [], ...o });
  const agreed = { token: q.token, amountIn: q.amountIn, amountOut: q.amountOut };
  const tx = txOf();
  const d = checkEvmWBuy(tx, built, ask, ctxOf(), wbuyReads(held), agreed, plan);
  assert.deepEqual([d.amount, d.feeCap, d.to], [q.amountIn, GAS * (2n * BASE_FEE + TIP) + L1, W]);
  const raw = signEvmWBuy(W_KEY, tx);
  assert.equal(raw[0], 2);
  // the adapter's bytes: buy(token, W, minOut, path)
  assert.equal(data.slice(0, 10), "0x" + Buffer.from(keccak_256(new TextEncoder().encode("buy(address,address,uint256,bytes)")).slice(0, 4)).toString("hex"));
  // another key, a send changed after its check, or one never checked: nothing signed
  assert.throws(() => signEvmWBuy(new Uint8Array(32).fill(9), tx), refusedAs("wallet"));
  assert.throws(() => signEvmWBuy(W_KEY, txOf()), refusedAs("unchecked"));
  assert.throws(() => signEvmDeposit(W_KEY, tx), refusedAs("unchecked"));
  const other = "0x2222222222222222222222222222222222222222";
  const R = wbuyReads(held);
  for (const [f, rule] of [
    [() => checkEvmWBuy(txOf({ to: other }), built, ask, ctxOf(), R, agreed, plan), "to"],
    [() => checkEvmWBuy(txOf({ to: A_V4 }), built, ask, ctxOf(), R, agreed, plan), "to"],
    [() => checkEvmWBuy(txOf({ value: q.amountIn + 1n }), built, ask, ctxOf(), R, agreed, plan), "value"],
    [() => checkEvmWBuy(txOf({ data: evmAdapterBuyData(built.token, other, built.minOut, built.data) }), built, ask, ctxOf(), R, agreed, plan), "data"],
    [() => checkEvmWBuy(txOf({ data: evmAdapterBuyData(built.token, W, built.minOut - 1n, built.data) }), built, ask, ctxOf(), R, agreed, plan), "data"],
    [() => checkEvmWBuy(txOf({ chainId: 84532n }), built, ask, ctxOf(), R, agreed, plan), "chain_id"],
    [() => checkEvmWBuy(txOf({ nonce: 1n }), built, ask, ctxOf(), R, agreed, plan), "nonce"],
    [() => checkEvmWBuy(txOf({ gasLimit: GAS + 1n }), built, ask, ctxOf(), R, agreed, plan), "gas_estimate"],
    [() => checkEvmWBuy(txOf(), built, ask, ctxOf(), wbuyReads(held, { estimate: [2_000_000n, 2_000_000n] }), agreed, plan), "gas_over_cap"],
    [() => checkEvmWBuy(txOf({ maxPriorityFeePerGas: TIP + 1n }), built, ask, ctxOf(), R, agreed, plan), "priority_fee"],
    [() => checkEvmWBuy(txOf({ maxFeePerGas: 2n * BASE_FEE + TIP + 1n }), built, ask, ctxOf(), R, agreed, plan), "max_fee"],
    [() => checkEvmWBuy(txOf({ accessList: [other] }), built, ask, ctxOf(), R, agreed, plan), "access_list"],
    [() => checkEvmWBuy({ ...txOf(), type: 4 } as never, built, ask, ctxOf(), R, agreed, plan), "type"],
    // the reads: two RPCs that differ, a run that failed, a balance that cannot pay the rest and its bound
    [() => checkEvmWBuy(txOf(), built, ask, ctxOf(), wbuyReads(held, { nonce: [0n, 1n] }), agreed, plan), "reads"],
    [() => checkEvmWBuy(txOf(), built, ask, ctxOf(), wbuyReads(held, { simulated: [true, false] }), agreed, plan), "reads"],
    [() => checkEvmWBuy(txOf(), built, ask, ctxOf(), wbuyReads(held, { simulated: [false, false] }), agreed, plan), "simulation"],
    [() => checkEvmWBuy(txOf(), built, ask, ctxOf(), wbuyReads(q.amountIn), agreed, plan), "balance"],
    // a fee bound past what the plan kept for W's buy
    [() => checkEvmWBuy(txOf(), built, ask, ctxOf(), R, agreed, planEvmBuy(ask, [carrier], 1n)), "fee_cap"],
    // the quote is of the rest exactly; the floor is the check's own
    [() => checkEvmWBuy(txOf(), built, ask, ctxOf(), R, { ...agreed, amountIn: q.amountIn + 1n }, plan), "amount"],
    [() => checkEvmWBuy(txOf(), built, ask, ctxOf(), R, { ...agreed, amountOut: q.amountOut * 2n }, plan), "min_out"],
    // only a plan with a rest, of this amount, the device's own
    [() => checkEvmWBuy(txOf(), built, ask, ctxOf(), R, agreed, { ...plan }), "plan"],
    [() => checkEvmWBuy(txOf(), built, ask, ctxOf(), R, agreed, planEvmBuy(askOf(carrier.chunk - carrier.fee, q.token), [carrier], BOUND)), "plan"],
    [() => checkEvmWBuy(txOf(), { ...built }, ask, ctxOf(), R, agreed, plan), "not_quoted"],
    [() => checkEvmWBuy(txOf(), built, { ...ask, kind: "pool.sell" }, ctxOf(), R, agreed, plan), "kind"],
  ] as const) {
    assert.throws(f, refusedAs(rule), rule);
  }
});

const PIN: EvmPoolPin = Object.freeze({ network: "base", pool: POOL, feeRecipient: FEE_TO, fromBlock: 1n });
const PRE = 123_456_789n;
const word = (v: bigint) => v.toString(16).padStart(64, "0");
const callOf = (value: bigint) => Object.freeze({ to: POOL, value, data: "0xe2bbb158" + word(value) + word(PRE) });
const DGAS = 250_000n, DS = 7n, DL = 5n;
const DLIMIT = DGAS + evmDepositHeadroom(DS, DL);
const DFEE = DLIMIT * (2n * BASE_FEE + TIP) + L1;
const depReads = (balance: bigint): EvmDepositReads => ({ nonce: [1n, 1n], balance: [balance, balance + 5n], estimate: [DGAS, DGAS], baseFee: [BASE_FEE, BASE_FEE], l1Fee: [L1, L1], stateDepth: [DS, DS], labelDepth: [DL, DL], priorityCap: TIP });
const depTx = (value: bigint): EvmOnwardSend => ({ type: 2, chainId: 8453n, nonce: 1n, maxPriorityFeePerGas: TIP, maxFeePerGas: 2n * BASE_FEE + TIP, gasLimit: DLIMIT, to: POOL, value, data: callOf(value).data, accessList: [] });

test("checkEvmChange: W's change goes back as the largest rung its balance pays beside the fee bound, one deposit at a time; never its whole balance nor a smaller rung; under the least rung nothing is deposited", () => {
  const ctx = (value: bigint) => ({ wallet: W, precommitment: PRE, call: callOf(value), pin: PIN, chain: "base" as const });
  // W holds 0.0073 ETH and the bound: 0.005, then 0.002, then 0.0003 stays on W, under the least rung (0.001)
  const held = milli(73n) / 10n + DFEE;
  const tx = depTx(milli(5n));
  assert.equal(ruleOf(() => checkEvmChange(tx, ctx(milli(5n)), depReads(held))), "passed");
  assert.equal(signEvmDeposit(W_KEY, tx)[0], 2);
  assert.equal(ruleOf(() => checkEvmChange(depTx(milli(2n)), ctx(milli(2n)), depReads(milli(23n) / 10n + DFEE))), "passed");
  // a smaller rung while a larger one fits leaves a rung on W: refused, and nothing signed
  const small = depTx(milli(2n));
  assert.equal(ruleOf(() => checkEvmChange(small, ctx(milli(2n)), depReads(held))), "change_rung");
  assert.throws(() => signEvmDeposit(W_KEY, small), refusedAs("unchecked"));
  // W's whole balance (the carry's old shape) is no rung
  const whole = milli(73n) / 10n;
  assert.equal(ruleOf(() => checkEvmChange(depTx(whole), ctx(whole), depReads(held))), "rung");
  // a rung W cannot pay beside the bound; the least rung with less than it and the bound held
  assert.equal(ruleOf(() => checkEvmChange(depTx(milli(10n)), ctx(milli(10n)), depReads(held))), "balance");
  assert.equal(ruleOf(() => checkEvmChange(depTx(EVM_LADDER.min), ctx(EVM_LADDER.min), depReads(EVM_LADDER.min + DFEE - 1n))), "balance");
  assert.equal(ruleOf(() => checkEvmChange(depTx(milli(5n)), { ...ctx(milli(5n)), chain: "solana" as never }, depReads(held))), "chain");
});

test("planEvmBuy: when no piece the whole ones leave can carry the rest, one they took carries it instead (spends 5, 2 and 2, bound 0.1, an ask of 6.95: both 2s whole and 2.95 on the 5's W); only an ask within one buy's bound under every spend is refused", () => {
  const u = 10n ** 14n;
  const pieces = [
    { noteId: "five", chunk: 50n * u + u, fee: u },
    { noteId: "two-a", chunk: 20n * u + u, fee: u },
    { noteId: "two-b", chunk: 20n * u + u, fee: u },
  ];
  const ask = { kind: "pool.buy", chain: "base", token: "0x" + "11".repeat(20), amount: 69n * u + u / 2n, slippageBps: 100, decimals: 18 } as const;
  const plan = planEvmBuy(ask, pieces, u);
  assert.deepEqual(plan.whole.map((p) => p.noteId), ["two-a", "two-b"]);
  assert.equal(plan.rest?.piece.noteId, "five");
  assert.equal(plan.rest?.spend, 29n * u + u / 2n);
  // every spend is 9.0: an ask over 8.9 (the bound 0.1 under it) and under 9.0 has no W to pay its own buy
  assert.throws(() => planEvmBuy({ ...ask, amount: 89n * u + 1n }, pieces, u), /amount/);
  assert.equal(planEvmBuy({ ...ask, amount: 90n * u }, pieces, u).rest, null, "Max: every piece whole");
});
