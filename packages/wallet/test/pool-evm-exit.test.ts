// The exit tool's EVM signatures (src/pool/evm-exit.ts, card exit-evm-pools-with-the-words), the proof SIGN_SITES names
// for evmExitWithdrawSignature and evmExitSignSend: G is the words' standard first EVM account; W's Withdraw signature
// recovers to W under the pool's EIP-712 digest and is refused for a release paying anyone else; each send is a type 2
// transaction whose signer recovers to G or W, its fields the ones handed in; G signs only the pool's withdraw at value
// 0, W only a plain send; the calldata has the pool's selector, its 1,028 bytes and pB's pairs swapped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, freshWallet, wordsToSeed64 } from "../src/derive/keys.ts";
import { EVM_POOLS } from "../src/pool/evm.ts";
import { EVM_EXIT_GAS_PATH, EvmExitRefused, evmExitGasAddress, evmExitSignSend, evmExitWithdrawCalldata, evmExitWithdrawDigest, evmExitWithdrawSignature } from "../src/pool/evm-exit.ts";

const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the A.8 words, public, holding nothing
const POOL = EVM_POOLS.base!.pool;
const hex = (b: Uint8Array): string => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
const W = (l: bigint, j: number): string => {
  const w = freshWallet(SEED, "evm", l, j);
  w.secretKey.fill(0);
  return w.address.toLowerCase();
};
const relayFor = (recipient: string) => ({ recipient, feeRecipient: EVM_POOLS.base!.feeRecipient, feeCap: 0n, deadlineMs: 1n, refundPrecommitment: 0n, salt: `0x${"00".repeat(16)}` });
const recover = (digest: Uint8Array, rs: Uint8Array, bit: number): string => hex(keccak_256(secp256k1.Signature.fromBytes(rs, "compact").addRecoveryBit(bit).recoverPublicKey(digest).toBytes(false).subarray(1)).subarray(12));

/** A type 2 raw transaction read back: its unsigned digest, its signer and its fields (minimal RLP decode). */
function decode(raw: Uint8Array): { fields: Uint8Array[]; from: string } {
  assert.equal(raw[0], 2);
  const item = (b: Uint8Array, at: number): { v: Uint8Array | Uint8Array[]; end: number } => {
    const p = b[at]!;
    if (p < 0x80) return { v: b.subarray(at, at + 1), end: at + 1 };
    const long = (base: number) => {
      const n = p - base;
      let len = 0;
      for (let k = 1; k <= n; k++) len = len * 256 + b[at + k]!;
      return { start: at + 1 + n, len };
    };
    if (p < 0xb8) return { v: b.subarray(at + 1, at + 1 + p - 0x80), end: at + 1 + p - 0x80 };
    if (p < 0xc0) {
      const { start, len } = long(0xb7);
      return { v: b.subarray(start, start + len), end: start + len };
    }
    const { start, len } = p < 0xf8 ? { start: at + 1, len: p - 0xc0 } : long(0xf7);
    const out: Uint8Array[] = [];
    for (let k = start; k < start + len; ) {
      const x = item(b, k);
      out.push(x.v as Uint8Array);
      k = x.end;
    }
    return { v: out, end: start + len };
  };
  const fields = item(raw, 1).v as Uint8Array[];
  assert.equal(fields.length, 12);
  const len = (n: number, base: number): number[] => {
    if (n < 56) return [base + n];
    const bytes: number[] = [];
    for (let x = n; x > 0; x = Math.floor(x / 256)) bytes.unshift(x % 256);
    return [base + 55 + bytes.length, ...bytes];
  };
  const enc = (b: Uint8Array): number[] => (b.length === 1 && b[0]! < 0x80 ? [b[0]!] : [...len(b.length, 0x80), ...b]);
  const unsigned = [...fields.slice(0, 8).flatMap(enc), 0xc0];
  const digest = keccak_256(Uint8Array.of(2, ...len(unsigned.length, 0xc0), ...unsigned));
  const pad = (b: Uint8Array) => Uint8Array.of(...new Uint8Array(32 - b.length), ...b);
  const bit = fields[9]!.length === 0 ? 0 : fields[9]![0]!;
  return { fields, from: recover(digest, Uint8Array.of(...pad(fields[10]!), ...pad(fields[11]!)), bit) };
}

test("G is the words' first EVM account at m/44'/60'/0'/0/0, never a W", () => {
  assert.equal(EVM_EXIT_GAS_PATH, "m/44'/60'/0'/0/0");
  // the BIP-39 'abandon x11 about' words' first Ethereum account, as every EVM wallet derives it
  assert.equal(evmExitGasAddress(SEED), "0x9858effd232b4033e47d90003d41ec34ecaeda94");
  assert.notEqual(W(1n, 0), evmExitGasAddress(SEED));
});

test("W's Withdraw signature recovers to W under the pool's EIP-712 digest; a release paying another address is refused", () => {
  const a = { chainId: 8453n, pool: POOL, relay: relayFor(W(7n, 0)), nullifierHash: 11n, context: 22n, value: 33n };
  const sig = evmExitWithdrawSignature(SEED, 7n, 0, a);
  assert.equal(sig.length, 65);
  assert.ok(sig[64] === 27 || sig[64] === 28);
  assert.equal(recover(evmExitWithdrawDigest(8453n, POOL, 11n, 22n, 33n), sig.subarray(0, 64), sig[64]! - 27), W(7n, 0));
  assert.throws(() => evmExitWithdrawSignature(SEED, 7n, 0, { ...a, relay: relayFor(W(8n, 0)) }), EvmExitRefused);
  assert.throws(() => evmExitWithdrawSignature(SEED, 7n, 0, { ...a, value: 0n }), EvmExitRefused);
});

test("withdraw calldata: the pool's selector, 1,028 bytes, pB's pairs swapped", () => {
  const proof = { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] };
  const data = evmExitWithdrawCalldata(POOL, relayFor(W(7n, 0)), proof, ["1", "2", "3", "4", "5", "6", "7", "8"], 0n, new Uint8Array(65));
  assert.equal(data.length, 1028);
  assert.equal(hex(data.subarray(0, 4)), hex(keccak_256(new TextEncoder().encode("withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)")).subarray(0, 4)));
  const at = (k: number) => BigInt(hex(data.subarray(4 + 32 * k, 36 + 32 * k)));
  assert.deepEqual([at(1), at(2), at(3), at(4), at(5), at(6), at(7), at(8)], [1n, 2n, 4n, 3n, 6n, 5n, 7n, 8n]);
});

test("G's send is the pool's withdraw at value 0, signed by G; W's is a plain send, signed by W; any other shape is refused", () => {
  const data = evmExitWithdrawCalldata(POOL, relayFor(W(7n, 0)), { pi_a: ["1", "2"], pi_b: [["3", "4"], ["5", "6"]], pi_c: ["7", "8"] }, ["1", "2", "3", "4", "5", "6", "7", "8"], 0n, new Uint8Array(65));
  const base = { chainId: 8453n, nonce: 3n, tip: 10_000_000n, maxFee: 20_000_000n, gas: 600_000n, to: POOL, value: 0n, data };
  const g = evmExitSignSend(SEED, { kind: "gas", pool: POOL }, base);
  const dg = decode(g.raw);
  assert.equal(dg.from, evmExitGasAddress(SEED));
  assert.equal(g.from, dg.from);
  assert.equal(g.hash, hex(keccak_256(g.raw)));
  assert.equal(hex(dg.fields[5]!), POOL);
  assert.equal(hex(dg.fields[7]!), hex(data));
  const TO = "0x5555555555555555555555555555555555555555";
  const w = evmExitSignSend(SEED, { kind: "w", l: 7n, j: 0 }, { ...base, gas: 21_000n, to: TO, value: 12345n, data: new Uint8Array(0) });
  const dw = decode(w.raw);
  assert.equal(dw.from, W(7n, 0));
  assert.equal(hex(dw.fields[5]!), TO);
  assert.equal(BigInt(hex(dw.fields[6]!)), 12345n);
  // G: never another address, a value, or other data; W: never data, never the zero address or a precompile
  assert.throws(() => evmExitSignSend(SEED, { kind: "gas", pool: POOL }, { ...base, to: TO }), EvmExitRefused);
  assert.throws(() => evmExitSignSend(SEED, { kind: "gas", pool: POOL }, { ...base, value: 1n }), EvmExitRefused);
  assert.throws(() => evmExitSignSend(SEED, { kind: "gas", pool: POOL }, { ...base, data: data.subarray(0, 100) }), EvmExitRefused);
  assert.throws(() => evmExitSignSend(SEED, { kind: "w", l: 7n, j: 0 }, { ...base, to: TO }), EvmExitRefused);
  assert.throws(() => evmExitSignSend(SEED, { kind: "w", l: 7n, j: 0 }, { ...base, to: "0x0000000000000000000000000000000000000001", data: new Uint8Array(0) }), EvmExitRefused);
  assert.throws(() => evmExitSignSend(SEED, { kind: "w", l: 7n, j: 0 }, { ...base, to: TO, data: new Uint8Array(0), tip: 30_000_000n }), EvmExitRefused);
});
