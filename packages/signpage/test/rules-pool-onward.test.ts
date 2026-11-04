// The EVM pool withdraw's second step (card signpage-pool-withdraw-form, src/rules/pool.ts): W's onward send of what the
// withdraw paid it to the address typed on the signing page. A good send passes, signs as W, and its raw bytes read back
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
const BASE_FEE = 1_000_000n;
const CAP = 1_000_000n;
const readsOf = (o: Partial<EvmOnwardReads> = {}): EvmOnwardReads => ({
  nonce: [5n, 5n],
  balance: [BAL, BAL],
  toHasCode: [false, false],
  estimate: null,
  baseFee: [BASE_FEE, BASE_FEE],
  l1Fee: [0n, 0n],
  priorityCap: CAP,
  ...o,
});
/** A send of W's whole balance less its fee bound (gasLimit × maxFeePerGas and `l1`), unless `value` is given. */
const txOf = (o: Partial<Record<keyof EvmOnwardSend, unknown>> = {}, l1 = 0n): EvmOnwardSend => {
  const gasLimit = (o.gasLimit as bigint | undefined) ?? 21_000n;
  const maxFeePerGas = (o.maxFeePerGas as bigint | undefined) ?? 2n * BASE_FEE + CAP;
  return {
    type: 2,
    chainId: BigInt(B.chainId),
    nonce: 5n,
    maxPriorityFeePerGas: CAP,
    maxFeePerGas,
    gasLimit,
    to: TO,
    value: BAL - gasLimit * maxFeePerGas - l1,
    data: "0x",
    accessList: [],
    ...o,
  } as EvmOnwardSend;
};

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

test("EVM onward send: W's whole balance less its fee bound to the typed address passes; each bad field is refused", () => {
  const tx = txOf();
  const d = checkEvmOnwardSend(tx, ASK, ctxOf(), TO, readsOf());
  assert.deepEqual(d, { chain: "base", op: "pool.withdraw", token: null, amount: tx.value, feeCap: 21_000n * tx.maxFeePerGas, pool: EVM_POOL, to: TO, decimals: 18, back: null });
  // the typed address in any case; an L1 data fee the device read stays in W as part of the fee bound
  checkEvmOnwardSend(txOf(), ASK, ctxOf(), TO.toUpperCase().replace("0X", "0x"), readsOf());
  const l1 = 7_000_000n;
  assert.equal(checkEvmOnwardSend(txOf({}, l1), ASK, ctxOf(), TO, readsOf({ l1Fee: [l1, l1] })).feeCap, 21_000n * tx.maxFeePerGas + l1);
  // a contract recipient (a smart wallet): its two-RPC estimate, up to 100,000 gas
  checkEvmOnwardSend(txOf({ gasLimit: 50_000n }), ASK, ctxOf(), TO, readsOf({ toHasCode: [true, true], estimate: [50_000n, 50_000n] }));
  checkEvmOnwardSend(txOf({ gasLimit: 100_000n }), ASK, ctxOf(), TO, readsOf({ toHasCode: [true, true], estimate: [100_000n, 100_000n] }));
  // the testnet: the pinned base-sepolia chain id and pool
  const sepolia = evmPoolVenues()["base-sepolia"];
  checkEvmOnwardSend(txOf({ chainId: BigInt(sepolia.chainId) }), ASK, ctxOf({ evm: { venues: evmPoolVenues(), feeRecipient: FEE_TO } }), TO, readsOf(), true);

  const code = (estimate: bigint, gasLimit: bigint) => [txOf({ gasLimit }), readsOf({ toHasCode: [true, true], estimate: [estimate, estimate] })] as const;
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
    // the typed address: an address, never the zero address, the pool or W
    ["to", () => checkEvmOnwardSend(txOf({ to: "0x1234" }), ASK, ctxOf(), "0x1234", readsOf())],
    ["to", () => checkEvmOnwardSend(txOf({ to: "0x" + "0".repeat(40) }), ASK, ctxOf(), "0x" + "0".repeat(40), readsOf())],
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
    // the gas: 21,000 to an account with no code; the estimate, at most 100,000, to one with code
    ["gas_limit", () => checkEvmOnwardSend(txOf({ gasLimit: 21_001n }), ASK, ctxOf(), TO, readsOf())],
    ["gas_limit", () => checkEvmOnwardSend(txOf({ gasLimit: 50_000n }), ASK, ctxOf(), TO, readsOf({ estimate: [50_000n, 50_000n] }))],
    ["gas_estimate", () => checkEvmOnwardSend(...([code(50_000n, 60_000n)[0], ASK, ctxOf(), TO, code(50_000n, 60_000n)[1]] as const))],
    ["gas_over_cap", () => checkEvmOnwardSend(...([code(100_001n, 100_001n)[0], ASK, ctxOf(), TO, code(100_001n, 100_001n)[1]] as const))],
    // the fees: no fee that burns the withdrawal
    ["priority_fee", () => checkEvmOnwardSend(txOf({ maxPriorityFeePerGas: CAP + 1n }), ASK, ctxOf(), TO, readsOf())],
    ["max_fee", () => checkEvmOnwardSend(txOf({ maxFeePerGas: 2n * BASE_FEE + CAP + 1n }), ASK, ctxOf(), TO, readsOf())],
    // the whole balance: no skim left in W, no overspend, never nothing
    ["value", () => checkEvmOnwardSend(txOf({ value: txOf().value - 1n }), ASK, ctxOf(), TO, readsOf())],
    ["value", () => checkEvmOnwardSend(txOf({ value: txOf().value + 1n }), ASK, ctxOf(), TO, readsOf())],
    ["value", () => checkEvmOnwardSend(txOf({}, 1n), ASK, ctxOf(), TO, readsOf())],
    ["value", () => checkEvmOnwardSend(txOf({ value: 0n }), ASK, ctxOf(), TO, readsOf({ balance: [21_000n * 3_000_000n, 21_000n * 3_000_000n] }))],
  ];
  for (const [rule, f] of cases) assert.throws(f, refusedAs(rule), rule);
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
