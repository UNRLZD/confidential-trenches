// The keys the kit derives from the 12 words (docs/plan1/wallet.md §2.2 at research ffcba5e, vector set §A.8).
//   seed64     BIP-39 seed of the 12 words, empty passphrase (wallet.md:54)
//   W_{c,l,j}  fresh wallet at m/44'/coin'/a'/b', every step hardened, (a, b) from HKDF info "wallet" ‖ c ‖ l ‖ j
//   U_{s,i}    one-time deposit id      HKDF info "onetime/in"     ‖ s ‖ i
//   U^evm_{s,i} one-time EVM deposit wallet, secp256k1: HKDF info "onetime/in/evm" ‖ s ‖ i (card pool-deposits)
//   R_{c,l,j}  one-time return id       HKDF info "onetime/return" ‖ c ‖ l ‖ j
//   V_{l,j}    one-time refund id       HKDF info "onetime/refund" ‖ l ‖ j
//   A_{l,j}    one-use arming account   HKDF info "onetime/arm"    ‖ l ‖ j
//   T_k        profile key              HKDF info "profile"        ‖ k
// Every input is checked; nothing here logs. A returned secretKey is the caller's to keep on the device.
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { base58 } from "@scure/base";
import { CHAINS, type Chain, HKDF_SALT, P, PRF_INFO, PRF_SALT } from "./constants.ts";

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};
const u32 = (x: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, x);
  return b;
};

// ---------- the 12 words ----------
export function entropyToWords(entropy: Uint8Array): string {
  if (!(entropy instanceof Uint8Array) || entropy.length !== 16) throw new Error("entropy must be 16 bytes");
  return entropyToMnemonic(entropy, wordlist);
}
// The BIP-39 checksum is checked on the device before anything else (wallet.md:49). The typed words are normalized
// once (any run of whitespace is one space, none at either end) and that one string goes to the checksum and the seed.
export function wordsToSeed64(words: string): Uint8Array {
  if (typeof words !== "string") throw new Error("not 12 valid BIP-39 English words");
  const list = words.trim().split(/\s+/);
  const one = list.join(" ");
  if (list.length !== 12 || !validateMnemonic(one, wordlist)) throw new Error("not 12 valid BIP-39 English words");
  return mnemonicToSeedSync(one, "");
}

// A new account's entropy. A stuck random source gives one repeated byte, and 16 zero bytes are the A.8 test seed,
// whose keys are published (wallet.md §A.8): a new account refuses any entropy that is one byte repeated. Restore
// (wordsToSeed64) takes any valid words, so the A.8 vectors keep working.
export function newAccountEntropy(entropy: Uint8Array): Uint8Array {
  if (!(entropy instanceof Uint8Array) || entropy.length !== 16) throw new Error("entropy must be 16 bytes");
  if (entropy.every((x) => x === entropy[0])) throw new Error("new account entropy refused: one byte repeated");
  return entropy;
}
// 16 random bytes for a new account without PRF (wallet.md:48); random is crypto.getRandomValues unless a test says.
export function newEntropy(random: (b: Uint8Array<ArrayBuffer>) => unknown = (b) => crypto.getRandomValues(b)): Uint8Array {
  const e = new Uint8Array(16);
  random(e);
  return newAccountEntropy(e);
}
// The passkey's PRF output to the 16 bytes of entropy (wallet.md:47), a new account's entropy like the above.
export function entropyFromPrf(prfOutput: Uint8Array): Uint8Array {
  if (!(prfOutput instanceof Uint8Array) || prfOutput.length !== 32) throw new Error("the PRF output must be 32 bytes");
  return newAccountEntropy(hkdf(sha256, prfOutput, ascii(PRF_SALT), ascii(PRF_INFO), 16));
}

// ---------- the encodings (wallet.md:70-89) ----------
function seedOk(seed64: Uint8Array): Uint8Array {
  if (!(seed64 instanceof Uint8Array) || seed64.length !== 64) throw new Error("seed64 must be 64 bytes");
  return seed64;
}
export function field(name: string, x: bigint): Uint8Array {
  if (typeof x !== "bigint" || x < 0n || x >= P) throw new Error(`${name} is not a field element in [0, p)`);
  const b = new Uint8Array(32);
  for (let i = 31, v = x; i >= 0; i--, v >>= 8n) b[i] = Number(v & 0xffn);
  return b;
}
export function counter(name: string, x: number): Uint8Array {
  if (!Number.isSafeInteger(x) || x < 0 || x > 0xffffffff) throw new Error(`${name} is not a counter in [0, 2^32)`);
  return u32(x);
}
export function chainTag(c: Chain): number {
  if (typeof c !== "string" || !Object.hasOwn(CHAINS, c)) throw new Error(`unknown chain tag ${String(c)}`);
  return CHAINS[c].tag;
}

export const info = {
  in: (s: bigint, i: number) => concat(ascii("onetime/in"), field("s", s), counter("i", i)),
  return: (c: Chain, l: bigint, j: number) =>
    concat(ascii("onetime/return"), Uint8Array.of(chainTag(c)), field("l", l), counter("j", j)),
  refund: (l: bigint, j: number) => concat(ascii("onetime/refund"), field("l", l), counter("j", j)),
  arm: (l: bigint, j: number) => concat(ascii("onetime/arm"), field("l", l), counter("j", j)),
  wallet: (c: Chain, l: bigint, j: number) =>
    concat(ascii("wallet"), Uint8Array.of(chainTag(c)), field("l", l), counter("j", j)),
  profile: (k: number) => concat(ascii("profile"), counter("k", k)),
};

export const infoInEvm = (s: bigint, i: number): Uint8Array => concat(ascii("onetime/in/evm"), field("s", s), counter("i", i));

export function hkdfSeed(seed64: Uint8Array, inf: Uint8Array, length: number): Uint8Array {
  return hkdf(sha512, seedOk(seed64), ascii(HKDF_SALT), inf, length);
}

// ---------- one-time ed25519 ids: U, R, V, A, T ----------
export interface OneTime {
  info: string; // the HKDF info bytes, hex
  id: string; // lowercase hex of the public key: the NEAR implicit account (T: the profile key)
  publicKey: Uint8Array;
  secretKey: Uint8Array; // the 32-byte ed25519 seed (RFC 8032)
}
function oneTime(seed64: Uint8Array, inf: Uint8Array): OneTime {
  const secretKey = hkdfSeed(seed64, inf, 32);
  const publicKey = ed25519.getPublicKey(secretKey);
  return { info: hex(inf), id: hex(publicKey), publicKey, secretKey };
}
export const depositId = (seed64: Uint8Array, s: bigint, i: number) => oneTime(seed64, info.in(s, i));
export const returnId = (seed64: Uint8Array, c: Chain, l: bigint, j: number) => oneTime(seed64, info.return(c, l, j));
export const refundId = (seed64: Uint8Array, l: bigint, j: number) => oneTime(seed64, info.refund(l, j));
export const armAccount = (seed64: Uint8Array, l: bigint, j: number) => oneTime(seed64, info.arm(l, j));
export const profileKey = (seed64: Uint8Array, k: number) => oneTime(seed64, info.profile(k));

// ---------- the one-time EVM deposit wallet U^evm_{s,i} (card pool-deposits slice 3, CO's call 7 Nov) ----------
// U on Base and Robinhood needs a secp256k1 key. Its private key is HKDF-SHA512(seed64, salt "blindfill/v1", info
// "onetime/in/evm" ‖ s (32 B) ‖ i (4 B big-endian), 32 B), read as a big-endian integer. A value of 0 or at least the
// curve order n is no key: try k takes bytes [32k, 32k + 32) of the same HKDF output stream (RFC 5869 output of length
// L is the first L bytes of any longer one), so try 0 is the 32-byte output and no index i ever shifts or repeats.
// The odds of try 0 failing are about 2^-128. HKDF-SHA512 gives at most 255 * 64 bytes: 510 tries.
const SECP_N = secp256k1.Point.CURVE().n;
const EVM_KEY_TRIES = (255 * 64) / 32;
/** The first try k whose 32 bytes, as a big-endian integer, are in [1, n): its index and a copy of the key. The stream
 *  is the caller's to zero. */
export function secpKeyOfStream(stream: Uint8Array): { k: number; key: Uint8Array } {
  for (let k = 0; (k + 1) * 32 <= stream.length; k++) {
    const key = stream.subarray(32 * k, 32 * k + 32);
    let x = 0n;
    for (const b of key) x = (x << 8n) | BigInt(b);
    if (x !== 0n && x < SECP_N) return { k, key: key.slice() };
  }
  throw new Error("no secp256k1 key in this stream");
}
export interface OneTimeEvm {
  info: string; // the HKDF info bytes, hex
  address: string; // EIP-55 0x address
  publicKey: Uint8Array; // 33 B compressed
  secretKey: Uint8Array; // the 32-byte secp256k1 private key
}
/** U^evm_{s,i}: deposit number i of the EVM pool of scope s. */
export function depositIdEvm(seed64: Uint8Array, s: bigint, i: number): OneTimeEvm {
  const inf = infoInEvm(s, i);
  // try 0 alone first; only if it is refused, the whole stream
  for (const length of [32, 32 * EVM_KEY_TRIES]) {
    const stream = hkdfSeed(seed64, inf, length);
    try {
      const { key } = secpKeyOfStream(stream);
      const publicKey = secp256k1.getPublicKey(key, true);
      return { info: hex(inf), address: evmAddress(publicKey), publicKey, secretKey: key };
    } catch {
      // every try in this stream refused: a longer one, whose first bytes are this one's
    } finally {
      stream.fill(0);
    }
  }
  throw new Error("no secp256k1 key for this id");
}

// ---------- SLIP-10 ed25519, hardened steps only ----------
const HARDENED = 0x80000000;
// No intermediate copy is made: each step reads the parent's key and chain code as views of its I, and each I and each
// step's data is zeroed once used. Only the leaf's key and chain code are copied out.
export function slip10Ed25519(seed: Uint8Array, path: number[]): { key: Uint8Array; chainCode: Uint8Array } {
  const I = slip10Leaf(seed, path);
  const out = { key: I.slice(0, 32), chainCode: I.slice(32) };
  I.fill(0);
  return out;
}
// The leaf's I (key || chain code), the caller's to zero.
function slip10Leaf(seed: Uint8Array, path: number[]): Uint8Array {
  for (const step of path)
    if (!Number.isSafeInteger(step) || step < HARDENED || step > 0xffffffff)
      throw new Error("SLIP-10 ed25519 takes hardened steps only");
  let I = hmac(sha512, ascii("ed25519 seed"), seed);
  for (const step of path) {
    const data = concat(Uint8Array.of(0), I.subarray(0, 32), u32(step));
    const next = hmac(sha512, I.subarray(32), data);
    data.fill(0);
    I.fill(0);
    I = next;
  }
  return I;
}

// ---------- fresh wallets W_{c,l,j} ----------
export interface FreshWallet {
  chain: Chain;
  info: string; // the HKDF info bytes of the path, hex
  path: string; // m/44'/coin'/a'/b'
  address: string; // sol: base58 of the public key; evm: EIP-55 0x address; near: hex of the public key
  publicKey: Uint8Array; // ed25519: 32 B; secp256k1: 33 B compressed
  secretKey: Uint8Array; // ed25519: the 32-byte seed; secp256k1: the 32-byte private key
}
// (a, b): the 8 HKDF bytes as two big-endian u32, each AND 0x7fffffff (wallet.md:62).
export function walletPath(seed64: Uint8Array, c: Chain, l: bigint, j: number): { a: number; b: number; path: string } {
  const ab = hkdfSeed(seed64, info.wallet(c, l, j), 8);
  const v = new DataView(ab.buffer, ab.byteOffset, 8);
  const a = v.getUint32(0) & 0x7fffffff, b = v.getUint32(4) & 0x7fffffff;
  ab.fill(0);
  return { a, b, path: `m/44'/${CHAINS[c].coin}'/${a}'/${b}'` };
}
export function freshWallet(seed64: Uint8Array, c: Chain, l: bigint, j: number): FreshWallet {
  const { a, b, path } = walletPath(seed64, c, l, j);
  const inf = hex(info.wallet(c, l, j));
  const steps = [44, CHAINS[c].coin, a, b].map((x) => x + HARDENED);
  if (CHAINS[c].curve === "ed25519") {
    const leaf = slip10Leaf(seed64, steps); // only the key is copied out; the leaf's chain code is never copied
    const key = leaf.slice(0, 32);
    leaf.fill(0);
    const publicKey = ed25519.getPublicKey(key);
    const address = c === "sol" || c === "hop-sol" ? base58.encode(publicKey) : hex(publicKey);
    return { chain: c, info: inf, path, address, publicKey, secretKey: key };
  }
  // Step by step, so each parent's private key is wiped once its child is made (HDKey.derive drops them unwiped).
  let node = HDKey.fromMasterSeed(seed64);
  for (const step of steps) {
    const child = node.deriveChild(step);
    node.wipePrivateData();
    node = child;
  }
  const secretKey = node.privateKey, publicKey = node.publicKey; // copies (the getters copy)
  node.wipePrivateData();
  if (!secretKey || !publicKey) throw new Error("BIP-32 derivation gave no key");
  return { chain: c, info: inf, path, address: evmAddress(publicKey), publicKey, secretKey };
}

// ---------- EVM address ----------
// The last 20 bytes of keccak-256 of the 64-byte public key, in EIP-55 mixed case.
export function evmAddress(publicKey: Uint8Array): string {
  const full = publicKey.length === 65 ? publicKey : secp256k1.Point.fromBytes(publicKey).toBytes(false);
  return toChecksum(hex(keccak_256(full.slice(1)).slice(12)));
}
export function toChecksum(addr: string): string {
  const lower = addr.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error("not a 20-byte address");
  const h = hex(keccak_256(ascii(lower)));
  return "0x" + Array.from(lower, (ch, i) => (parseInt(h[i]!, 16) >= 8 ? ch.toUpperCase() : ch)).join("");
}

// ---------- the change index j (wallet.md:116-124) ----------
// j is fixed by the spent note, never by a device counter: the first note of a label (a deposit note, or a refund
// note under its own new label) makes change note 0; change note k makes change note k + 1.
export type SpentNote = { kind: "deposit" } | { kind: "refund" } | { kind: "change"; j: number };
export function changeIndex(spent: SpentNote): number {
  if (spent.kind === "deposit" || spent.kind === "refund") return 0;
  if (spent.kind === "change") {
    counter("j", spent.j);
    if (spent.j === 0xffffffff) throw new Error("change index out of range");
    return spent.j + 1;
  }
  throw new Error("unknown note kind");
}
