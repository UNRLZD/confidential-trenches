// The EVM pool withdraw's second step (card signpage-pool-withdraw-form, src/rules/pool.ts): W's onward send of the part
// the user typed to the address typed on the signing page. A good send passes, signs as W, and its raw bytes read back
// as the same fields; each bad field is refused not_allowed, named by its rule; only the very send a check passed signs.
// Key: the Hardhat mnemonic's account 0, a published test vector.
import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { evmPoolVenues, type EvmPoolVenue } from "../../kit/src/trade/evm/buy-unpinned.ts";
import {
  PoolRuleRefused,
  checkEvmOnwardSend,
  evmOnwardCodeGas,
  evmOnwardSendDigest,
  signEvmOnwardSend,
  type EvmOnwardReads,
  type EvmOnwardSend,
  type PoolAsk,
  type PoolContext,
} from "../src/rules/pool.ts";

const refusedAs = (rule: string) => (e: unknown) => e instanceof PoolRuleRefused && e.code === "not_allowed" && e.rule === rule;
const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
const N = secp256k1.Point.CURVE().n;
function hardhatAccount0(): Uint8Array {
  const seed = pbkdf2(sha512, enc("test test test test test test test test test test test junk"), enc("mnemonic"), { c: 2048, dkLen: 64 });
  let I = hmac(sha512, enc("Bitcoin seed"), seed);
  let k = BigInt(hex(I.slice(0, 32)));
  let c = I.slice(32);
  for (const [i, hard] of [[44, true], [60, true], [0, true], [0, false], [0, false]] as [number, boolean][]) {
    const kb = Buffer.from(k.toString(16).padStart(64, "0"), "hex");
    const head = hard ? Uint8Array.of(0, ...kb) : secp256k1.getPublicKey(kb, true);
    const idx = Buffer.alloc(4);
    idx.writeUInt32BE(hard ? i + 0x80000000 : i);
    I = hmac(sha512, c, Uint8Array.of(...head, ...idx));
    k = (BigInt(hex(I.slice(0, 32))) + k) % N;
    c = I.slice(32);
  }
  return Buffer.from(k.toString(16).padStart(64, "0"), "hex");
}
const addressOf = (pub: Uint8Array) => hex(keccak_256(pub.slice(1)).slice(12));
const EVM_SECRET = hardhatAccount0();
const EVM_W = addressOf(secp256k1.getPublicKey(EVM_SECRET, false));

const B = evmPoolVenues().base;
const EVM_POOL = "0x00000000000000000000000000000000000f0011";
const FEE_TO = "0x0000000000000000000000000000000000000fee";
const TO = "0x1111111111111111111111111111111111111111";
const pin = (v: EvmPoolVenue, o: Partial<EvmPoolVenue>): EvmPoolVenue => Object.freeze({ ...v, ...o });
const VENUES = Object.freeze({ base: pin(B, { pool: EVM_POOL }) });
const ctxOf = (o: Partial<PoolContext> = {}): PoolContext => ({ nowMs: 1_800_000_000_000n, wallet: EVM_W, feeCap: 10n ** 15n, evm: { venues: VENUES, feeRecipient: FEE_TO }, ...o });
const ASK: PoolAsk = { kind: "pool.withdraw", chain: "base", token: null, amount: 0n, slippageBps: 0, decimals: 18 };

const BAL = 10n ** 16n;
// the part the device's plan sends to To: W holds it and far more than the fee bound beside it
const PART = 4n * 10n ** 15n;
const BASE_FEE = 1_000_000n;
const CAP = 1_000_000n;
const MAX_FEE = 2n * BASE_FEE + CAP;
// a plain send's fee bound at the default max fee
const FEE = 21_000n * MAX_FEE;
const readsOf = (o: Partial<EvmOnwardReads> = {}): EvmOnwardReads => ({
  nonce: [5n, 5n],
  balance: [BAL, BAL],
  toHasCode: [false, false],
  estimate: null,
  baseFee: [BASE_FEE, BASE_FEE],
  l1Fee: [0n, 0n],
  priorityCap: CAP,
  part: PART,
  ...o,
});
/** The reads of a To with code: both RPCs' estimate, and the very send run on both. */
const codeReads = (estimate: bigint, o: Partial<EvmOnwardReads> = {}) => readsOf({ toHasCode: [true, true], estimate: [estimate, estimate], simulated: [true, true], ...o });
/** A send of the part, unless `value` is given. */
const txOf = (o: Partial<Record<keyof EvmOnwardSend, unknown>> = {}): EvmOnwardSend =>
  ({
    type: 2,
    chainId: BigInt(B.chainId),
    nonce: 5n,
    maxPriorityFeePerGas: CAP,
    maxFeePerGas: MAX_FEE,
    gasLimit: 21_000n,
    to: TO,
    value: PART,
    data: "0x",
    accessList: [],
    ...o,
  }) as EvmOnwardSend;

// ---------- an RLP reader of the test's own, to read the signed bytes back ----------
type R = Uint8Array | R[];
function rlpRead(b: Uint8Array, at = 0): [R, number] {
  const p = b[at]!;
  const len = (n: number, from: number) => Number(BigInt(hex(b.subarray(from, from + n))));
  if (p < 0x80) return [b.subarray(at, at + 1), at + 1];
  if (p <= 0xb7) return [b.subarray(at + 1, at + 1 + p - 0x80), at + 1 + p - 0x80];
  if (p <= 0xbf) {
    const n = len(p - 0xb7, at + 1);
    const s = at + 1 + p - 0xb7;
    return [b.subarray(s, s + n), s + n];
  }
  const [s, n] = p <= 0xf7 ? [at + 1, p - 0xc0] : [at + 1 + p - 0xf7, len(p - 0xf7, at + 1)];
  const items: R[] = [];
  let i = s;
  while (i < s + n) {
    const [x, next] = rlpRead(b, i);
    items.push(x);
    i = next;
  }
  assert.equal(i, s + n);
  return [items, s + n];
}
const int = (x: R) => (x instanceof Uint8Array ? (x.length === 0 ? 0n : BigInt(hex(x))) : assert.fail("a list, not a string"));

test("EVM onward send: a send of the part to the typed address passes; each bad field is refused", () => {
  const tx = txOf();
  const d = checkEvmOnwardSend(tx, ASK, ctxOf(), TO, readsOf());
  assert.deepEqual(d, { chain: "base", op: "pool.withdraw", token: null, amount: PART, feeCap: FEE, pool: EVM_POOL, to: TO, decimals: 18, back: null });
  // the typed address in any case; an L1 data fee the device read is part of the fee bound
  checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO.toUpperCase().replace("0X", "0x"), readsOf());
  const l1 = 7_000_000n;
  assert.equal(checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, readsOf({ l1Fee: [l1, l1] })).feeCap, FEE + l1);
  // the first address past the precompiles is an address like any other
  const past = "0x0000000000000000000000000000000000010000";
  checkEvmOnwardSend(txOf({ to: past }), ASK, ctxOf(), past, readsOf());
  // the testnet: the pinned base-sepolia chain id and pool
  const sepolia = evmPoolVenues()["base-sepolia"];
  checkEvmOnwardSend(txOf({ chainId: BigInt(sepolia.chainId) }), ASK, ctxOf({ evm: { venues: evmPoolVenues(), feeRecipient: FEE_TO } }), TO, readsOf(), true);

  const at = (n: number) => "0x" + n.toString(16).padStart(40, "0");
  const cases: [string, () => unknown][] = [
    // the ask: a pool withdraw on an EVM chain
    ["kind", () => checkEvmOnwardSend(txOf(), { ...ASK, kind: "pool.buy" }, ctxOf(), TO, readsOf())],
    ["chain", () => checkEvmOnwardSend(txOf(), { ...ASK, chain: "solana" }, ctxOf(), TO, readsOf())],
    ["evm_not_pinned", () => checkEvmOnwardSend(txOf(), ASK, ctxOf({ evm: undefined }), TO, readsOf())],
    ["wallet", () => checkEvmOnwardSend(txOf(), ASK, ctxOf({ wallet: "W" }), TO, readsOf())],
    // type 2 only: no EIP-7702 delegation of W, no legacy, nothing beside the nine fields
    ["type", () => checkEvmOnwardSend(txOf({ type: 4 }), ASK, ctxOf(), TO, readsOf())],
    ["type", () => checkEvmOnwardSend(txOf({ type: 0 }), ASK, ctxOf(), TO, readsOf())],
    ["type", () => checkEvmOnwardSend({ ...txOf(), authorizationList: [{ address: EVM_POOL }] } as EvmOnwardSend, ASK, ctxOf(), TO, readsOf())],
    ["type", () => checkEvmOnwardSend(null as unknown as EvmOnwardSend, ASK, ctxOf(), TO, readsOf())],
    ["tx_fields", () => checkEvmOnwardSend(txOf({ nonce: -1n }), ASK, ctxOf(), TO, readsOf())],
    ["tx_fields", () => checkEvmOnwardSend(txOf({ value: "1" }), ASK, ctxOf(), TO, readsOf())],
    ["tx_fields", () => checkEvmOnwardSend(txOf({ nonce: 2n ** 64n - 1n }), ASK, ctxOf(), TO, readsOf())],
    ["tx_fields", () => checkEvmOnwardSend(txOf({ to: 7 }), ASK, ctxOf(), TO, readsOf())],
    // the two providers agree on every read
    ["reads", () => checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, readsOf({ nonce: [5n, 6n] }))],
    ["reads", () => checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, readsOf({ balance: [BAL, BAL + 1n] }))],
    ["reads", () => checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, readsOf({ toHasCode: [false, true] }))],
    ["reads", () => checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, readsOf({ baseFee: [BASE_FEE, BASE_FEE + 1n] }))],
    ["reads", () => checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, readsOf({ l1Fee: [0n, 1n] }))],
    ["reads", () => checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, readsOf({ toHasCode: [true, true], estimate: [50_000n, 50_001n] }))],
    ["reads", () => checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, readsOf({ toHasCode: [true, true], estimate: null }))],
    ["reads", () => checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, readsOf({ priorityCap: -1n }))],
    // the pinned chain's id: no replay on another chain
    ["chain_id", () => checkEvmOnwardSend(txOf({ chainId: 1n }), ASK, ctxOf(), TO, readsOf())],
    ["chain_id", () => checkEvmOnwardSend(txOf(), ASK, ctxOf({ evm: { venues: evmPoolVenues(), feeRecipient: FEE_TO } }), TO, readsOf(), true)],
    // the typed address: an address, never the zero address, a precompile, the pool or W
    ["to", () => checkEvmOnwardSend(txOf({ to: "0x1234" }), ASK, ctxOf(), "0x1234", readsOf())],
    ["to", () => checkEvmOnwardSend(txOf({ to: "0x" + "1".repeat(41) }), ASK, ctxOf(), "0x" + "1".repeat(41), readsOf())],
    ["to", () => checkEvmOnwardSend(txOf({ to: "0x" + "0".repeat(40) }), ASK, ctxOf(), "0x" + "0".repeat(40), readsOf())],
    ["to", () => checkEvmOnwardSend(txOf({ to: at(0x1) }), ASK, ctxOf(), at(0x1), readsOf())],
    ["to", () => checkEvmOnwardSend(txOf({ to: at(0x100) }), ASK, ctxOf(), at(0x100), readsOf())],
    ["to", () => checkEvmOnwardSend(txOf({ to: at(0xffff) }), ASK, ctxOf(), at(0xffff), readsOf())],
    ["to", () => checkEvmOnwardSend(txOf({ to: EVM_POOL }), ASK, ctxOf(), EVM_POOL.toUpperCase().replace("0X", "0x"), readsOf())],
    ["to", () => checkEvmOnwardSend(txOf({ to: EVM_W }), ASK, ctxOf(), EVM_W, readsOf())],
    // the send goes to the typed address
    ["transfer_to", () => checkEvmOnwardSend(txOf({ to: "0x2222222222222222222222222222222222222222" }), ASK, ctxOf(), TO, readsOf())],
    // W's nonce on two RPCs: no replacing, no queueing behind another
    ["nonce", () => checkEvmOnwardSend(txOf({ nonce: 6n }), ASK, ctxOf(), TO, readsOf())],
    ["nonce", () => checkEvmOnwardSend(txOf({ nonce: 4n }), ASK, ctxOf(), TO, readsOf())],
    // a plain send: no call, no access list
    ["data", () => checkEvmOnwardSend(txOf({ data: "0xa9059cbb" }), ASK, ctxOf(), TO, readsOf())],
    ["access_list", () => checkEvmOnwardSend(txOf({ accessList: [{ address: TO, storageKeys: [] }] }), ASK, ctxOf(), TO, readsOf())],
    // the gas: 21,000 to an account with no code (the To with code: its own test below)
    ["gas_limit", () => checkEvmOnwardSend(txOf({ gasLimit: 21_001n }), ASK, ctxOf(), TO, readsOf())],
    ["gas_limit", () => checkEvmOnwardSend(txOf({ gasLimit: 50_000n }), ASK, ctxOf(), TO, readsOf({ estimate: [50_000n, 50_000n] }))],
    // the fees: no fee that burns the withdrawal
    ["priority_fee", () => checkEvmOnwardSend(txOf({ maxPriorityFeePerGas: CAP + 1n }), ASK, ctxOf(), TO, readsOf())],
    ["max_fee", () => checkEvmOnwardSend(txOf({ maxFeePerGas: 2n * BASE_FEE + CAP + 1n }), ASK, ctxOf(), TO, readsOf())],
    // the part (its own test below): one wei off either way
    ["value", () => checkEvmOnwardSend(txOf({ value: PART - 1n }), ASK, ctxOf(), TO, readsOf())],
    ["value", () => checkEvmOnwardSend(txOf({ value: PART + 1n }), ASK, ctxOf(), TO, readsOf())],
  ];
  for (const [rule, f] of cases) assert.throws(f, refusedAs(rule), rule);
});

test("EVM onward send: the value is the part, or W's balance less the fee bound when the fee rose past it; the fee bound within the Max fee", () => {
  const l1 = 7_000_000n;
  const two = (x: bigint) => [x, x] as [bigint, bigint];
  // W holds the part and the fee bound to the wei: the part
  assert.equal(checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, readsOf({ balance: two(PART + FEE) })).amount, PART);
  // the fee rose one wei past what W holds beyond the part: W's balance less the bound, one wei under the part
  const short = readsOf({ balance: two(PART + FEE - 1n) });
  assert.equal(checkEvmOnwardSend(txOf({ value: PART - 1n }), ASK, ctxOf(), TO, short).amount, PART - 1n);
  // the L1 data fee is part of that bound
  const shortL1 = readsOf({ balance: two(PART + FEE + l1 - 1n), l1Fee: two(l1) });
  checkEvmOnwardSend(txOf({ value: PART - 1n }), ASK, ctxOf(), TO, shortL1);
  // a part of all W holds: W's balance less the bound
  checkEvmOnwardSend(txOf({ value: BAL - FEE }), ASK, ctxOf(), TO, readsOf({ part: BAL }));
  // the fee bound at exactly the Max fee drawn, with the L1 fee in it
  assert.equal(checkEvmOnwardSend(txOf(), ASK, ctxOf({ feeCap: FEE }), TO, readsOf()).feeCap, FEE);
  assert.equal(checkEvmOnwardSend(txOf(), ASK, ctxOf({ feeCap: FEE + l1 }), TO, readsOf({ l1Fee: two(l1) })).feeCap, FEE + l1);

  const cases: [string, () => unknown][] = [
    // W holds enough: the part, never a wei above it or below it
    ["value", () => checkEvmOnwardSend(txOf({ value: PART + 1n }), ASK, ctxOf(), TO, readsOf({ balance: two(PART + FEE) }))],
    ["value", () => checkEvmOnwardSend(txOf({ value: PART - 1n }), ASK, ctxOf(), TO, readsOf({ balance: two(PART + FEE) }))],
    // the fee rose: the part is more than W pays beside the bound, and a wei less than it can pay is left on W
    ["value", () => checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, short)],
    ["value", () => checkEvmOnwardSend(txOf({ value: PART - 2n }), ASK, ctxOf(), TO, short)],
    ["value", () => checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, shortL1)],
    ["value", () => checkEvmOnwardSend(txOf({ value: BAL }), ASK, ctxOf(), TO, readsOf({ part: BAL }))],
    // W holds the fee bound alone, or less: nothing to send, never a send of nothing
    ["value", () => checkEvmOnwardSend(txOf({ value: 0n }), ASK, ctxOf(), TO, readsOf({ balance: two(FEE) }))],
    ["value", () => checkEvmOnwardSend(txOf({ value: 1n }), ASK, ctxOf(), TO, readsOf({ balance: two(FEE) }))],
    ["value", () => checkEvmOnwardSend(txOf({ value: 0n }), ASK, ctxOf(), TO, readsOf({ balance: two(FEE - 1n) }))],
    // the fee bound one wei over the Max fee drawn, with and without the L1 fee in it; no Max fee at all
    ["fee_cap", () => checkEvmOnwardSend(txOf(), ASK, ctxOf({ feeCap: FEE - 1n }), TO, readsOf())],
    ["fee_cap", () => checkEvmOnwardSend(txOf(), ASK, ctxOf({ feeCap: FEE + l1 - 1n }), TO, readsOf({ l1Fee: two(l1) }))],
    ["fee_cap", () => checkEvmOnwardSend(txOf(), ASK, ctxOf({ feeCap: undefined as unknown as bigint }), TO, readsOf())],
    // no part: 0, under 0, past a uint256, not a bigint
    ["reads", () => checkEvmOnwardSend(txOf({ value: 0n }), ASK, ctxOf(), TO, readsOf({ part: 0n }))],
    ["reads", () => checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, readsOf({ part: -1n }))],
    ["reads", () => checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, readsOf({ part: 1n << 256n }))],
    ["reads", () => checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, readsOf({ part: Number(PART) as unknown as bigint }))],
  ];
  for (const [rule, f] of cases) assert.throws(f, refusedAs(rule), rule);
});

test("EVM onward send: a To with code takes its two-RPC estimate and a fifth, at most 100,000 gas, and only once the very send ran on both RPCs", () => {
  assert.equal(evmOnwardCodeGas(50_000n), 60_000n);
  const d = checkEvmOnwardSend(txOf({ gasLimit: 60_000n }), ASK, ctxOf(), TO, codeReads(50_000n));
  assert.deepEqual([d.amount, d.feeCap], [PART, 60_000n * MAX_FEE]);
  // the most: an estimate of 83,334 and its fifth (16,666)
  assert.equal(evmOnwardCodeGas(83_334n), 100_000n);
  checkEvmOnwardSend(txOf({ gasLimit: 100_000n }), ASK, ctxOf(), TO, codeReads(83_334n));
  // an address with no code: no run of the send is read
  checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, readsOf({ simulated: [false, false] }));

  const cases: [string, () => unknown][] = [
    // the estimate with no margin, or a gas a wei off the margin
    ["gas_estimate", () => checkEvmOnwardSend(txOf({ gasLimit: 50_000n }), ASK, ctxOf(), TO, codeReads(50_000n))],
    ["gas_estimate", () => checkEvmOnwardSend(txOf({ gasLimit: 59_999n }), ASK, ctxOf(), TO, codeReads(50_000n))],
    ["gas_estimate", () => checkEvmOnwardSend(txOf({ gasLimit: 60_001n }), ASK, ctxOf(), TO, codeReads(50_000n))],
    // an estimate whose margin passes 100,000 gas
    ["gas_over_cap", () => checkEvmOnwardSend(txOf({ gasLimit: evmOnwardCodeGas(83_335n) }), ASK, ctxOf(), TO, codeReads(83_335n))],
    // the send reverted on both RPCs
    ["simulation", () => checkEvmOnwardSend(txOf({ gasLimit: 60_000n }), ASK, ctxOf(), TO, codeReads(50_000n, { simulated: [false, false] }))],
    // the two RPCs differ, or no run of the send was read
    ["reads", () => checkEvmOnwardSend(txOf({ gasLimit: 60_000n }), ASK, ctxOf(), TO, codeReads(50_000n, { simulated: [true, false] }))],
    ["reads", () => checkEvmOnwardSend(txOf({ gasLimit: 60_000n }), ASK, ctxOf(), TO, codeReads(50_000n, { simulated: [false, true] }))],
    ["reads", () => checkEvmOnwardSend(txOf({ gasLimit: 60_000n }), ASK, ctxOf(), TO, codeReads(50_000n, { simulated: null }))],
    ["reads", () => checkEvmOnwardSend(txOf({ gasLimit: 60_000n }), ASK, ctxOf(), TO, codeReads(50_000n, { simulated: undefined }))],
  ];
  for (const [rule, f] of cases) assert.throws(f, refusedAs(rule), rule);
});

// review #232 LOW: fees bounded from below too, so a checked send is one a node includes
test("EVM onward send: a max fee under the base fee, or a priority fee above the max fee, is refused", () => {
  // control: a max fee of twice the base fee and a tip at the cap passes
  checkEvmOnwardSend(txOf({ maxFeePerGas: 2n * BASE_FEE }), ASK, ctxOf(), TO, readsOf());
  // and a max fee of exactly the base fee with no tip
  checkEvmOnwardSend(txOf({ maxFeePerGas: BASE_FEE, maxPriorityFeePerGas: 0n }), ASK, ctxOf(), TO, readsOf());
  assert.throws(() => checkEvmOnwardSend(txOf({ maxFeePerGas: BASE_FEE / 2n, maxPriorityFeePerGas: 0n }), ASK, ctxOf(), TO, readsOf()), refusedAs("max_fee"));
  assert.throws(() => checkEvmOnwardSend(txOf({ maxFeePerGas: BASE_FEE - 1n, maxPriorityFeePerGas: 0n }), ASK, ctxOf(), TO, readsOf()), refusedAs("max_fee"));
  // a tip over the max fee, the tip still under the device's cap
  const big = readsOf({ priorityCap: 3n * BASE_FEE });
  assert.throws(() => checkEvmOnwardSend(txOf({ maxFeePerGas: 3n * BASE_FEE / 2n, maxPriorityFeePerGas: 2n * BASE_FEE }), ASK, ctxOf(), TO, big), refusedAs("priority_fee"));
});

// review #232 MEDIUM 2: Robinhood is Arbitrum Nitro, which charges the L1 data as gas: 21,000 does not land there
const RH = evmPoolVenues().robinhood;
const RH_CTX = ctxOf({ evm: { venues: Object.freeze({ ...VENUES, robinhood: pin(RH, { pool: EVM_POOL }) }), feeRecipient: FEE_TO } });
const RH_ASK: PoolAsk = { ...ASK, chain: "robinhood" };
const rh = (gasLimit: bigint) => txOf({ gasLimit, chainId: BigInt(RH.chainId) });
const est = (g: bigint, o: Partial<EvmOnwardReads> = {}) => readsOf({ estimate: [g, g], ...o });
test("EVM onward send: on Robinhood the gas is the estimate both RPCs agree on (and a fifth to a To with code), at most 100,000, with no L1 fee", () => {
  const d = checkEvmOnwardSend(rh(32_000n), RH_ASK, RH_CTX, TO, est(32_000n));
  assert.equal(d.feeCap, 32_000n * rh(32_000n).maxFeePerGas);
  checkEvmOnwardSend(rh(100_000n), RH_ASK, RH_CTX, TO, est(100_000n));
  const code = { toHasCode: [true, true], simulated: [true, true] } as const;
  checkEvmOnwardSend(rh(72_000n), RH_ASK, RH_CTX, TO, est(60_000n, code));
  for (const [rule, f] of [
    // a plain 21,000 on Nitro: under what the chain charges, the send never lands
    ["gas_estimate", () => checkEvmOnwardSend(rh(21_000n), RH_ASK, RH_CTX, TO, est(32_000n))],
    ["gas_estimate", () => checkEvmOnwardSend(rh(40_000n), RH_ASK, RH_CTX, TO, est(32_000n))],
    // the margin only to a To with code; a To with code never without it, nor without the send run on both RPCs
    ["gas_estimate", () => checkEvmOnwardSend(rh(evmOnwardCodeGas(32_000n)), RH_ASK, RH_CTX, TO, est(32_000n))],
    ["gas_estimate", () => checkEvmOnwardSend(rh(60_000n), RH_ASK, RH_CTX, TO, est(60_000n, code))],
    ["simulation", () => checkEvmOnwardSend(rh(72_000n), RH_ASK, RH_CTX, TO, est(60_000n, { ...code, simulated: [false, false] }))],
    // no estimate, or two that differ, is no read
    ["reads", () => checkEvmOnwardSend(rh(21_000n), RH_ASK, RH_CTX, TO, readsOf())],
    ["reads", () => checkEvmOnwardSend(rh(32_000n), RH_ASK, RH_CTX, TO, readsOf({ estimate: [32_000n, 32_001n] }))],
    ["gas_over_cap", () => checkEvmOnwardSend(rh(100_001n), RH_ASK, RH_CTX, TO, est(100_001n))],
    // Nitro's L1 cost is in the gas: an L1 fee beside it is a second charge W would be short of
    ["l1_fee", () => checkEvmOnwardSend(rh(32_000n), RH_ASK, RH_CTX, TO, est(32_000n, { l1Fee: [7n, 7n] }))],
  ] as const) assert.throws(f, refusedAs(rule), rule);
  // Base keeps 21,000 plus its L1 fee to an address with no code, and ignores an estimate there
  checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO, readsOf({ l1Fee: [7n, 7n], estimate: [32_000n, 32_000n] }));
});

test("EVM onward send: signs as W the send the check passed, as it read it; nothing else", () => {
  const tx = txOf();
  checkEvmOnwardSend(tx, ASK, ctxOf(), TO, readsOf());
  const raw = signEvmOnwardSend(EVM_SECRET, tx);
  // 0x02 ‖ rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList, yParity, r, s])
  assert.equal(raw[0], 2);
  const [list, end] = rlpRead(raw, 1);
  assert.equal(end, raw.length);
  assert.ok(Array.isArray(list) && list.length === 12);
  const f = list as R[];
  assert.deepEqual(
    [int(f[0]!), int(f[1]!), int(f[2]!), int(f[3]!), int(f[4]!), hex(f[5] as Uint8Array), int(f[6]!), hex(f[7] as Uint8Array), f[8]],
    [tx.chainId, tx.nonce, tx.maxPriorityFeePerGas, tx.maxFeePerGas, tx.gasLimit, TO, tx.value, "0x", []],
  );
  const [v, r, s] = [int(f[9]!), int(f[10]!), int(f[11]!)];
  assert.ok(v === 0n || v === 1n);
  assert.ok(s <= N / 2n, "low s");
  // the digest is keccak256(0x02 ‖ rlp of the nine fields), the bytes signed less the signature
  const start = 1 + 1 + (raw[1]! > 0xf7 ? raw[1]! - 0xf7 : 0);
  let at = start;
  for (let i = 0; i < 9; i++) at = rlpRead(raw, at)[1];
  const nine = raw.subarray(start, at);
  const head = nine.length <= 55 ? [0xc0 + nine.length] : [0xf8, nine.length];
  assert.deepEqual(evmOnwardSendDigest(tx), keccak_256(Uint8Array.of(2, ...head, ...nine)));
  const sig = new secp256k1.Signature(r, s).addRecoveryBit(Number(v));
  assert.equal(addressOf(sig.recoverPublicKey(evmOnwardSendDigest(tx)).toBytes(false)), EVM_W);

  // a send no check passed, though it reads the same
  assert.throws(() => signEvmOnwardSend(EVM_SECRET, txOf()), refusedAs("unchecked"));
  // a copy of a passed send with one field changed
  assert.throws(() => signEvmOnwardSend(EVM_SECRET, { ...tx, to: "0x2222222222222222222222222222222222222222" }), refusedAs("unchecked"));
  // the passed send itself, changed after the check: a field, the access list, a field added
  const moved = txOf();
  checkEvmOnwardSend(moved, ASK, ctxOf(), TO, readsOf());
  (moved as { value: bigint }).value -= 1n;
  assert.throws(() => signEvmOnwardSend(EVM_SECRET, moved), refusedAs("unchecked"));
  const listed = txOf();
  checkEvmOnwardSend(listed, ASK, ctxOf(), TO, readsOf());
  (listed.accessList as unknown[]).push({ address: TO, storageKeys: [] });
  assert.throws(() => signEvmOnwardSend(EVM_SECRET, listed), refusedAs("unchecked"));
  const typed = txOf();
  checkEvmOnwardSend(typed, ASK, ctxOf(), TO, readsOf());
  (typed as unknown as Record<string, unknown>).authorizationList = [];
  assert.throws(() => signEvmOnwardSend(EVM_SECRET, typed), refusedAs("unchecked"));
  // a key other than the W the check read
  assert.throws(() => signEvmOnwardSend(new Uint8Array(32).fill(1), tx), refusedAs("wallet"));
  // the passed send still signs, the same bytes each time (RFC 6979)
  assert.deepEqual(signEvmOnwardSend(EVM_SECRET, tx), raw);
});
