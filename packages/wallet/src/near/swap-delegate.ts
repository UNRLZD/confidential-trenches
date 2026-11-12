// The calls a fresh NEAR wallet signs for a Rhea classic buy or sell, each as one NEP-366 SignedDelegateAction that the
// relayer carries (it pays the gas; W holds no NEAR beyond what the relayer sent to create it).
//   W = W_{near,l,j}: the fresh wallet of change note j of label l on chain tag near (0x03), at m/44'/397'/a'/b', every
//   step hardened, (a, b) from HKDF info "wallet" ‖ 0x03 ‖ l ‖ j (docs/plan1/wallet.md:63 and :98; ../derive/keys.ts
//   freshWallet). Its id is the hex of its public key, the implicit account the relayer creates by a plain Transfer.
//   The calls are the kit's nearSwapCalls, checked again here by nearSwapCheck on this module's own copy, right before
//   W's key signs, so what is signed is what was checked.
//   Each call is its own delegate (each has its own receiver): nonce = W's key nonce + 1, + 2, ... in the calls' order,
//   so the relayer can land them only in that order. W's registration on the output token is its own round, signed
//   alone; the swap is signed only once that registration reads back (the kit's nearSwapCalls and nearSwapCheck); max_block_height = the read's height + the window (the deposit's
//   DEPOSIT_WINDOW, never over DEPOSIT_WINDOW_MAX, which the relayer refuses), the nonce below height x 1,000,000.
//   What is checked and what is signed come from one read: the kit's NearSwapWalletState of W, taken whole (its key
//   nonce, height, registration and storage minimum), and the quote read after it: refused "stale" unless the quote is
//   at or after that read and at most NEAR_SWAP_READ_AGE_MAX blocks past it, so a read from another moment (an older
//   one, or one from a height the chain has not reached) never sets the nonce or the window.
//   The bytes are ../deposit/delegate.ts's: borsh(SignedDelegateAction), ed25519 over sha256(u32le(2^30 + 366) ‖
//   borsh(DelegateAction)).
//   A11: W is bound to the one token its first buy names (the device's buy record). A buy on a W bound to another token,
//   and a sell on a W bound to none or another, are refused before anything is signed.
// W's secret key is zeroed on every path once derived. Nothing here logs.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { nearSwapCheck, type NearSwapCall, type NearSwapRequest } from "../../../kit/src/trade/near/swap.ts";
import type { RheaQuote } from "../../../kit/src/near/rhea.ts";
import type { NearSwapWalletState } from "../../../kit/src/trade/near/wallet.ts";
import { freshWallet } from "../derive/keys.ts";
import { DEPOSIT_WINDOW, DEPOSIT_WINDOW_MAX, encodeDelegateAction, NEP366_PREFIX, NONCE_RANGE_MULTIPLIER } from "../deposit/delegate.ts";

export type NearSwapDelegateRefusalCode = "input" | "A11" | "key" | "window" | "nonce" | "stale";

/** The most blocks a quote may be read after W's state that W signs from: the device reads W, then quotes (about 6 s
 *  of NEAR blocks). A quote older than the read, or a read older than this, is not what is signed. */
export const NEAR_SWAP_READ_AGE_MAX = 10;
export class NearSwapDelegateRefused extends Error {
  readonly code: NearSwapDelegateRefusalCode;
  constructor(code: NearSwapDelegateRefusalCode, detail: string) {
    super(`NEAR swap not signed (${code}): ${detail}`);
    this.name = "NearSwapDelegateRefused";
    this.code = code;
  }
}

/** One signed call, and what the device keeps to follow it. */
export interface SignedNearSwapDelegate {
  /** borsh(SignedDelegateAction) in standard base64 */
  signed_delegate: string;
  sender_id: string;
  receiver_id: string;
  method_name: NearSwapCall["actions"][0]["FunctionCall"]["method_name"];
  nonce: bigint;
  max_block_height: bigint;
  public_key: string; // ed25519:<base58>
}

/** W_{near,l,j}'s id and path (no key leaves): what the relayer creates and the buy record names. */
export function nearSwapWallet(seed64: Uint8Array, l: bigint, j: number): { id: string; path: string } {
  const w = freshWallet(seed64, "near", l, j);
  w.secretKey.fill(0);
  return { id: w.address, path: w.path };
}

/**
 * W_{near,l,j}'s delegates over `given` (nearSwapCalls' answer for `request` on `quote`), from `state`, W read on two
 * providers just before the quote: its registration and storage minimum are what nearSwapCheck holds the calls to, its
 * key nonce and height what is signed. `bound` is the token W's buy record names (null before W's first buy).
 */
export function signNearSwapDelegates(
  seed64: Uint8Array,
  l: bigint,
  j: number,
  given: readonly NearSwapCall[],
  request: NearSwapRequest,
  quote: RheaQuote,
  state: NearSwapWalletState,
  bound: string | null,
  window: number = DEPOSIT_WINDOW,
): SignedNearSwapDelegate[] {
  if (!(seed64 instanceof Uint8Array) || seed64.length !== 64) throw new NearSwapDelegateRefused("input", "seed64 must be 64 bytes");
  if (!Number.isSafeInteger(window) || window < 1 || window > DEPOSIT_WINDOW_MAX)
    throw new NearSwapDelegateRefused("window", `the window must be a whole number of blocks in 1..${DEPOSIT_WINDOW_MAX}`);
  if (
    typeof state !== "object" ||
    state === null ||
    typeof state.account !== "string" ||
    typeof state.nonce !== "bigint" ||
    state.nonce < 0n ||
    !Number.isSafeInteger(state.height) ||
    state.height < 1 ||
    typeof state.registered !== "boolean" ||
    typeof state.storageMin !== "bigint" ||
    state.storageMin < 0n
  )
    throw new NearSwapDelegateRefused("input", "W's read");
  if (typeof quote !== "object" || quote === null || !Number.isSafeInteger(quote.height) || quote.height < 1) throw new NearSwapDelegateRefused("input", "the quote's height");
  // one moment: the quote read at or after W's state, and close to it
  if (quote.height < state.height || quote.height - state.height > NEAR_SWAP_READ_AGE_MAX)
    throw new NearSwapDelegateRefused("stale", `W's read is not within ${NEAR_SWAP_READ_AGE_MAX} blocks before the quote`);
  const read = { account: state.account, nonce: state.nonce, height: state.height };
  const ctx = { quote, storageMin: state.storageMin, registered: state.registered };
  // A11: one W, one token
  if (bound !== null && bound !== request.token) throw new NearSwapDelegateRefused("A11", "W is bound to another token");
  if (request.side === "sell" && bound === null) throw new NearSwapDelegateRefused("A11", "a sell on a W that bought nothing");
  let calls: NearSwapCall[];
  try {
    calls = structuredClone([...given]);
  } catch {
    throw new NearSwapDelegateRefused("input", "the calls are not plain data");
  }
  const own: NearSwapRequest = { network: request.network, side: request.side, token: request.token, amountIn: request.amountIn, wallet: request.wallet, slippageBps: request.slippageBps };
  nearSwapCheck(calls, own, ctx); // NearSwapRefused (N1-N4, N7) passes through as it is
  const height = BigInt(read.height);
  const max_block_height = height + BigInt(window);
  const w = freshWallet(seed64, "near", l, j);
  try {
    if (read.account !== w.address || own.wallet !== w.address) throw new NearSwapDelegateRefused("key", "the read and the request are not of W_{near,l,j}");
    const public_key = `ed25519:${base58.encode(w.publicKey)}`;
    // nearSwapCheck held every call's sender to own.wallet, now held to W
    return calls.map((c, k) => {
      const nonce = read.nonce + 1n + BigInt(k);
      if (nonce >= height * NONCE_RANGE_MULTIPLIER) throw new NearSwapDelegateRefused("nonce", "a nonce at or above the read height x 1,000,000");
      const f = c.actions[0].FunctionCall;
      const delegate = encodeDelegateAction({
        sender_id: c.sender_id,
        receiver_id: c.receiver_id,
        method_name: f.method_name,
        args: new TextEncoder().encode(JSON.stringify(f.args)),
        gas: BigInt(f.gas),
        deposit: BigInt(f.deposit),
        nonce,
        max_block_height,
        public_key: w.publicKey,
      });
      // borsh(SignedDelegateAction): the delegate, ed25519's tag, W's signature over NEP-366's signable message
      const signable = new Uint8Array(4 + delegate.length);
      new DataView(signable.buffer).setUint32(0, NEP366_PREFIX, true);
      signable.set(delegate, 4);
      const signed = new Uint8Array(delegate.length + 65);
      signed.set(delegate);
      signed.set(ed25519.sign(sha256(signable), w.secretKey), delegate.length + 1);
      return { signed_delegate: base64.encode(signed), sender_id: c.sender_id, receiver_id: c.receiver_id, method_name: f.method_name, nonce, max_block_height, public_key };
    });
  } finally {
    w.secretKey.fill(0);
  }
}
