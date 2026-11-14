// The exit tool's EVM signatures (card exit-evm-pools-with-the-words), here so the keys stay in the wallet: the exit tool
// (packages/exit/src/evm-out.ts) gets these through the kit's ./core and never holds a key. Each signer derives its own
// key from seed64, builds the bytes it signs from the fields it is handed, holds them to one shape, and zeroes the key
// on every path.
//
// - G, the exit's gas wallet: the words' first EVM account, m/44'/60'/0'/0/0, the one every EVM wallet opens on (no W
//   shares it: W's paths are four hardened steps, ../derive/keys.ts walletPath). G signs only a call of the pool's
//   withdraw (value 0, the calldata evmExitWithdrawCalldata makes); it pays the release's gas.
// - W_{evm, l, j}, a note's fresh wallet: it signs the pool's EIP-712 Withdraw of its own note (PrivacyPool.sol:
//   WITHDRAW_TYPEHASH, the Blindfill domain at version 1, the chain and the pool), which makes it the release's
//   recipient, and then one plain send (no data) of what it holds to the address the user typed.
// - A send is EIP-1559 (type 2) with an empty access list: 0x02 ‖ rlp([chainId, nonce, tip, maxFee, gas, to, value,
//   data, [], yParity, r, s]), s low.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { EVM_FIRST_ACCOUNT_PATH, evmAddress, evmFirstAccount, freshWallet } from "../derive/keys.ts";
import { evmRelayDataBytes, type EvmRelayData } from "./evm.ts";

/** G's path: BIP-44 coin 60, account 0, external chain, index 0 (derive/keys.ts evmFirstAccount). */
export const EVM_EXIT_GAS_PATH = EVM_FIRST_ACCOUNT_PATH;

export class EvmExitRefused extends Error {
  constructor(why: string) {
    super(`evm exit: ${why}`);
    this.name = "EvmExitRefused";
  }
}
const refuse = (why: string): never => {
  throw new EvmExitRefused(why);
};

const hexOf = (b: Uint8Array): string => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
const bytesOf = (h: string): Uint8Array => {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) refuse("not hex");
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
};
const cat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const word = (v: bigint): Uint8Array => (v < 0n || v >= 1n << 256n ? refuse("a word out of range") : bytesOf(v.toString(16).padStart(64, "0")));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const evenHex = (v: bigint): string => {
  const h = v.toString(16);
  return h.length % 2 ? `0${h}` : h;
};
const addr = (a: string, what: string): string => (/^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : refuse(`${what}: not an address`));

// ---------- keys ----------

/** G's key from seed64; the caller zeroes it. Never leaves this file. */
const gasKey = (seed64: Uint8Array): Uint8Array => evmFirstAccount(seed64).secretKey;
const addressOf = (key: Uint8Array): string => evmAddress(secp256k1.getPublicKey(key, true)).toLowerCase();

/** G's address (lowercase): the words' first EVM account. */
export function evmExitGasAddress(seed64: Uint8Array): string {
  const k = gasKey(seed64);
  try {
    return addressOf(k);
  } finally {
    k.fill(0);
  }
}

/** W_{evm, l, j}'s address (lowercase), its key zeroed at once. */
export function evmExitW(seed64: Uint8Array, l: bigint, j: number): string {
  const w = freshWallet(seed64, "evm", l, j);
  w.secretKey.fill(0);
  return w.address.toLowerCase();
}

// ---------- the pool's withdraw ----------

/** The EIP-712 digest of Withdraw(nullifier, context, value) on `pool` at `chainId`, as PrivacyPool.withdraw makes it. */
export function evmExitWithdrawDigest(chainId: bigint, pool: string, nullifierHash: bigint, context: bigint, value: bigint): Uint8Array {
  const domain = keccak_256(cat([keccak_256(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak_256(utf8("Blindfill")), keccak_256(utf8("1")), word(chainId), word(BigInt(addr(pool, "pool")))]));
  const struct = keccak_256(cat([keccak_256(utf8("Withdraw(uint256 nullifier,uint256 context,uint256 value)")), word(nullifierHash), word(context), word(value)]));
  return keccak_256(cat([Uint8Array.of(0x19, 0x01), domain, struct]));
}

/** W_{evm, l, j}'s Withdraw signature, r ‖ s ‖ v with s low (v 27 or 28): only for a release paying W itself. */
export function evmExitWithdrawSignature(seed64: Uint8Array, l: bigint, j: number, a: { chainId: bigint; pool: string; relay: EvmRelayData; nullifierHash: bigint; context: bigint; value: bigint }): Uint8Array {
  const w = freshWallet(seed64, "evm", l, j);
  try {
    if (addr(a.relay.recipient, "recipient") !== w.address.toLowerCase()) refuse("the release pays another address than W");
    if (a.value <= 0n) refuse("a release of nothing");
    const rec = secp256k1.sign(evmExitWithdrawDigest(a.chainId, a.pool, a.nullifierHash, a.context, a.value), w.secretKey, { prehash: false, lowS: true, format: "recovered" });
    const out = new Uint8Array(65);
    out.set(rec.subarray(1, 65), 0);
    out[64] = 27 + rec[0]!;
    return out;
  } finally {
    w.secretKey.fill(0);
  }
}

/** The proof as the pool reads it: snarkjs's pi_a, pi_b (each pair swapped for the EVM pairing), pi_c, decimal strings. */
export type EvmExitProof = { pi_a: readonly string[]; pi_b: readonly (readonly string[])[]; pi_c: readonly string[] };
const WITHDRAW_SELECTOR = keccak_256(utf8("withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)")).subarray(0, 4);

/** withdraw(Withdrawal{pool, abi.encode(relay)}, proof, fee, signature) in its canonical ABI encoding: 1,028 bytes. */
export function evmExitWithdrawCalldata(pool: string, relay: EvmRelayData, proof: EvmExitProof, signals: readonly string[], fee: bigint, signature: Uint8Array): Uint8Array {
  if (signals.length !== 8 || signature.length !== 65) refuse("calldata: eight signals and a 65-byte signature");
  const proofWords = [proof.pi_a[0], proof.pi_a[1], proof.pi_b[0]![1], proof.pi_b[0]![0], proof.pi_b[1]![1], proof.pi_b[1]![0], proof.pi_c[0], proof.pi_c[1], ...signals].map((s) => word(BigInt(s!)));
  const tail = (b: Uint8Array): Uint8Array[] => {
    const padded = new Uint8Array(Math.ceil(b.length / 32) * 32);
    padded.set(b);
    return [word(BigInt(b.length)), padded];
  };
  const HEAD = 19n; // the Withdrawal's offset, the proof's 16 words, the fee, the signature's offset
  const withdrawal = [word(BigInt(addr(pool, "pool"))), word(0x40n), ...tail(evmRelayDataBytes(relay))];
  const sigAt = HEAD + BigInt(withdrawal.reduce((n, p) => n + p.length, 0) / 32);
  return cat([WITHDRAW_SELECTOR, word(32n * HEAD), ...proofWords, word(fee), word(32n * sigAt), ...withdrawal, ...tail(signature)]);
}

// ---------- the two sends ----------

/** One EIP-1559 send's fields. */
export type EvmExitTx = { chainId: bigint; nonce: bigint; tip: bigint; maxFee: bigint; gas: bigint; to: string; value: bigint; data: Uint8Array };
/** Who signs: G, for a call of `pool`'s withdraw (value 0); or W_{evm, l, j}, for a plain send (no data). */
export type EvmExitSigner = { kind: "gas"; pool: string } | { kind: "w"; l: bigint; j: number };

const rlpLen = (n: number, base: number): Uint8Array => (n < 56 ? Uint8Array.of(base + n) : cat([Uint8Array.of(base + 55 + evenHex(BigInt(n)).length / 2), bytesOf(evenHex(BigInt(n)))]));
const rlpBytes = (b: Uint8Array): Uint8Array => (b.length === 1 && b[0]! < 0x80 ? b : cat([rlpLen(b.length, 0x80), b]));
const rlpUint = (v: bigint): Uint8Array => (v < 0n ? refuse("a negative field") : rlpBytes(v === 0n ? new Uint8Array(0) : bytesOf(evenHex(v))));
const rlpList = (items: readonly Uint8Array[]): Uint8Array => {
  const body = cat(items);
  return cat([rlpLen(body.length, 0xc0), body]);
};

/** The signer's raw type 2 send and its hash, after the shape check: G's only to the pool, value 0, a withdraw call;
 *  W's only a plain send (no data) to any address but the zero address and the precompiles. */
export function evmExitSignSend(seed64: Uint8Array, signer: EvmExitSigner, t: EvmExitTx): { raw: Uint8Array; hash: string; from: string } {
  const to = addr(t.to, "to");
  if (t.tip > t.maxFee || t.gas <= 0n) refuse("fee fields");
  if (signer.kind === "gas") {
    if (to !== addr(signer.pool, "pool") || t.value !== 0n || t.data.length !== 1028 || hexOf(t.data.subarray(0, 4)) !== hexOf(WITHDRAW_SELECTOR)) refuse("G signs only the pool's withdraw, value 0");
  } else if (t.data.length !== 0 || BigInt(to) < 0x10000n) refuse("W signs only a plain send to an address");
  const key = signer.kind === "gas" ? gasKey(seed64) : freshWallet(seed64, "evm", signer.l, signer.j).secretKey;
  try {
    const fields = [rlpUint(t.chainId), rlpUint(t.nonce), rlpUint(t.tip), rlpUint(t.maxFee), rlpUint(t.gas), rlpBytes(bytesOf(to)), rlpUint(t.value), rlpBytes(t.data), rlpList([])];
    const rec = secp256k1.sign(keccak_256(cat([Uint8Array.of(2), rlpList(fields)])), key, { prehash: false, lowS: true, format: "recovered" });
    const be = (b: Uint8Array): bigint => BigInt(hexOf(b));
    const raw = cat([Uint8Array.of(2), rlpList([...fields, rlpUint(BigInt(rec[0]!)), rlpUint(be(rec.subarray(1, 33))), rlpUint(be(rec.subarray(33, 65)))])]);
    return { raw, hash: hexOf(keccak_256(raw)), from: addressOf(key) };
  } finally {
    key.fill(0);
  }
}
