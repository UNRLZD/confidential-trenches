// Sign-in with a wallet's signature: a new account (docs/plan1/wallet.md §2.2 :50 at research ffcba5e; owner picks
// walletsignin "New 12 words", OD:271, and "Ask first", OD:349). Runs top-level on SIGN_HOST only.
//
// - The wallet signs derive/signin.ts's exact bytes: personal_sign on an EVM wallet (EIP-1193, the bytes as 0x-hex
//   UTF-8 with the EIP-55 address), signMessage on a Solana wallet (the bytes, display "utf8"), never signIn, which
//   lets the wallet build the bytes.
// - The answer is hostile until checked: the address the wallet names is read as one (20 bytes in EIP-55 form, or
//   base58 of 32 bytes), and the signature must be over those exact bytes by that address: an EIP-191 recover
//   (65 bytes r ‖ s ‖ v, v 27/28 or 0/1, s low) whose address is the one named, or a strict RFC 8032 ed25519 verify
//   (64 bytes, ZIP-215 off) under the named key. Anything else is WalletRefused and makes nothing. The bytes bind
//   SIGN_HOST and the address, so another page's or another address's signature is refused here.
// - The signature signs the user in and is no seed source (W:50): it derives nothing, unlocks nothing and is dropped
//   after the check. Only then is the account's seed made, 16 random bytes like a passkey without PRF (words.ts
//   walletSeed), stored insert-only as { source: "wallet", code_saved: false }, so the backup screen comes first and no
//   deposit quote is taken before Saved (OD:20, W:888). A seed already stored is never replaced: the sign-in lands on it.
// - The user's no in the wallet (EIP-1193 4001, the code Phantom answers too) is "cancelled" and makes nothing; no wallet
//   in this window is "no-wallet". Nothing here sends anything: the address and the signature never leave this page.
// - The wallet is the one injected in this window: window.ethereum when there is one, else Phantom's or the injected
//   window.solana. Either signs only the user in, so which one signs changes nothing the account holds.
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { evmAddress, evmSignIn, SIGN_HOST, solanaSignIn, toChecksum } from "../derive/index.ts";
import { signInWallet, type Landing, type Opener, type WordsEnv } from "./words.ts";

export type WalletFamily = "evm" | "solana";
export type WalletOutcome = { kind: "signed"; family: WalletFamily } | { kind: "cancelled" } | { kind: "no-wallet" };

/** A wallet answer that is not a signature of the exact sign-in bytes by the address it named. */
export class WalletRefused extends Error {
  constructor(why: string) {
    super(`the wallet's sign-in was refused: ${why}`);
    this.name = "WalletRefused";
  }
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const SECP_HALF_N = secp256k1.Point.CURVE().n >> 1n;

/** EIP-191 version 0x45 (personal_sign): keccak256("\x19Ethereum Signed Message:\n" ‖ decimal length ‖ message). */
export function eip191Digest(message: Uint8Array): Uint8Array {
  const prefix = utf8(`\x19Ethereum Signed Message:\n${message.length}`);
  const all = new Uint8Array(prefix.length + message.length);
  all.set(prefix);
  all.set(message, prefix.length);
  return keccak_256(all);
}

/** Whether `signature` (0x-hex r ‖ s ‖ v) is personal_sign of `message` by `address` (EIP-55). */
export function evmSignatureValid(address: string, message: string, signature: unknown): boolean {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  const b = Uint8Array.from(signature.slice(2).match(/../g)!, (x) => parseInt(x, 16));
  const v = b[64];
  const rec = v === 27 || v === 28 ? v - 27 : v === 0 || v === 1 ? v : -1;
  if (rec < 0) return false;
  // s low (EIP-2): a high-s twin of a signature is not the wallet's answer
  if (BigInt(`0x${hex(b.slice(32, 64))}`) > SECP_HALF_N) return false;
  try {
    // noble's recovered form is recovery ‖ r ‖ s; the digest is already hashed
    const recovered = Uint8Array.from([rec, ...b.slice(0, 64)]);
    const pub = secp256k1.recoverPublicKey(recovered, eip191Digest(utf8(message)), { prehash: false });
    return evmAddress(pub) === address;
  } catch {
    return false;
  }
}

/** Whether `signature` (64 bytes) is a strict ed25519 signature of `message` under the base58 key `address`. */
export function solanaSignatureValid(address: string, message: Uint8Array, signature: unknown): boolean {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) return false;
  try {
    const pub = base58.decode(address);
    if (pub.length !== 32) return false;
    return ed25519.verify(signature, message, pub, { zip215: false });
  } catch {
    return false;
  }
}

/** The EVM sign-in: personal_sign of evmSignIn(address) by address. */
export const evmSignInValid = (address: string, signature: unknown): boolean => evmSignatureValid(address, evmSignIn(address), signature);
/** The Solana sign-in: signMessage of solanaSignIn(address) under address's key. */
export const solanaSignInValid = (address: string, signature: unknown): boolean =>
  solanaSignatureValid(address, utf8(solanaSignIn(address)), signature);

// ---------- the request ----------
interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}
interface SolanaInjected {
  connect(): Promise<unknown>;
  signMessage(message: Uint8Array, display?: string): Promise<unknown>;
}
export interface WalletEnv extends WordsEnv {
  ethereum?: unknown; // window.ethereum unless a test says (null: none)
  solana?: unknown; // window.phantom?.solana ?? window.solana unless a test says (null: none)
}

function walletsOf(env: WalletEnv): { ethereum: Eip1193 | null; solana: SolanaInjected | null } {
  const g = globalThis as { ethereum?: unknown; solana?: unknown; phantom?: { solana?: unknown } };
  const ethereum = env.ethereum !== undefined ? env.ethereum : g.ethereum;
  const solana = env.solana !== undefined ? env.solana : (g.phantom?.solana ?? g.solana);
  const isEvm = (x: unknown): x is Eip1193 => typeof (x as Eip1193 | null)?.request === "function";
  const isSol = (x: unknown): x is SolanaInjected =>
    typeof (x as SolanaInjected | null)?.connect === "function" && typeof (x as SolanaInjected | null)?.signMessage === "function";
  return { ethereum: isEvm(ethereum) ? ethereum : null, solana: isSol(solana) ? solana : null };
}

/** Whether this window holds a wallet the page can ask: New account is offered only then. */
export function walletFound(env: WalletEnv = {}): boolean {
  const w = walletsOf(env);
  return w.ethereum !== null || w.solana !== null;
}

function onSignHost(env: WalletEnv): void {
  const hostname = env.hostname ?? globalThis.location?.hostname;
  if (hostname !== SIGN_HOST) throw new Error(`wallet sign-in runs on ${SIGN_HOST} only`);
  const w = globalThis as { window?: { top?: unknown } };
  const topLevel = env.topLevel ?? (w.window !== undefined && w.window.top === w.window);
  if (!topLevel) throw new Error("wallet sign-in runs top-level only, never in a frame");
}

const isUserNo = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === 4001;

async function evmRequest(wallet: Eip1193): Promise<void> {
  const accounts = await wallet.request({ method: "eth_requestAccounts" });
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(first)) throw new WalletRefused("no 20-byte account");
  const address = toChecksum(first);
  // a mixed-case answer is EIP-55 and must check; an all-lower or all-upper one carries no checksum
  const body = first.slice(2);
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && first !== address) throw new WalletRefused("a bad EIP-55 checksum");
  const message = evmSignIn(address);
  const signature = await wallet.request({ method: "personal_sign", params: [`0x${hex(utf8(message))}`, address] });
  if (!evmSignatureValid(address, message, signature)) throw new WalletRefused("not personal_sign of the sign-in bytes by its account");
}

function keyBytes(k: unknown): Uint8Array | null {
  const x = k as { toBytes?: () => unknown; toString?: () => unknown } | null;
  try {
    const b = typeof x?.toBytes === "function" ? x.toBytes() : typeof x?.toString === "function" ? base58.decode(String(x.toString())) : null;
    return b instanceof Uint8Array && b.length === 32 ? Uint8Array.from(b) : null;
  } catch {
    return null;
  }
}

async function solanaRequest(wallet: SolanaInjected): Promise<void> {
  const connected = (await wallet.connect()) as { publicKey?: unknown } | null;
  const pub = keyBytes(connected?.publicKey ?? (wallet as { publicKey?: unknown }).publicKey);
  if (!pub) throw new WalletRefused("no 32-byte public key");
  const address = base58.encode(pub);
  const message = utf8(solanaSignIn(address));
  // the wallet gets a copy: what it does to it changes nothing checked here
  const answer = (await wallet.signMessage(Uint8Array.from(message), "utf8")) as { signature?: unknown; publicKey?: unknown } | null;
  const raw = answer instanceof Uint8Array ? answer : answer?.signature;
  const signature = raw instanceof Uint8Array ? Uint8Array.from(raw) : null;
  if (answer && !(answer instanceof Uint8Array) && answer.publicKey !== undefined) {
    const named = keyBytes(answer.publicKey);
    if (!named || hex(named) !== hex(pub)) throw new WalletRefused("the answer names another key");
  }
  if (!solanaSignatureValid(address, message, signature)) throw new WalletRefused("not signMessage of the sign-in bytes by its key");
}

/**
 * Asks the window's wallet for one sign-in signature and checks it. Resolves "signed" only for a valid signature of
 * the exact bytes by the address the wallet named; throws WalletRefused for any other answer.
 */
export async function walletSignIn(env: WalletEnv = {}): Promise<WalletOutcome> {
  onSignHost(env);
  const w = walletsOf(env);
  try {
    if (w.ethereum) {
      await evmRequest(w.ethereum);
      return { kind: "signed", family: "evm" };
    }
    if (w.solana) {
      await solanaRequest(w.solana);
      return { kind: "signed", family: "solana" };
    }
  } catch (e) {
    if (isUserNo(e)) return { kind: "cancelled" };
    throw e;
  }
  return { kind: "no-wallet" };
}

/**
 * New account by a wallet (W:50): one checked sign-in signature, then a new random seed with source "wallet", stored
 * insert-only (a seed already stored stays and is the one landed on). Nothing is made, and the store is not opened,
 * unless the signature checked.
 */
export async function newAccountByWallet(open: Opener, env: WalletEnv = {}): Promise<{ kind: "landed"; landing: Landing } | { kind: "cancelled" } | { kind: "no-wallet" }> {
  const r = await walletSignIn(env);
  if (r.kind !== "signed") return r;
  return { kind: "landed", landing: await signInWallet(open, env) };
}
