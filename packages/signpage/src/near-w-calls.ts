// W's own calls, as the helper carried them (card near-holdings-restore): the device learns which token a NEAR trade
// wallet W bought from W's signed calls alone, never from what W holds (anyone can send W a token) or from a list.
// - Source: the helper's POST /v1/bind/record answer, each carried call's relayer transaction as the helper signed and
//   sent it (apps/helper/src/bind/send.ts encodeTransaction: borsh Transaction V0 of one Action::Delegate, then the
//   relayer's ed25519 signature). Only the delegate inside counts: the relayer's own fields and signature are not ours to
//   trust and are not read for anything but the delegate's place.
// - Proof: the delegate's NEP-366 signature, ed25519 over sha256(u32le(2^30 + 366) || borsh(DelegateAction)), by W's own
//   key: W is a NEAR implicit id, its 64 hex the public key, derived on this device from (l, j). The delegate's sender
//   and public key are W. W's key exists only on this user's device, and it signs only the calls the device built for
//   that one buy or sell, so one valid signature is proof enough from a single source; a helper that lies can only
//   withhold a call (nothing is rebuilt), never make one.
// - The token a call names, as the kit's nearSwapCalls writes them (packages/kit/src/trade/near/swap.ts): a buy's
//   registration is storage_deposit on the token; a buy's swap is USDC's ft_transfer_call into the exchange, its msg's
//   last action's token_out the token; a sell's swap is the token's own ft_transfer_call into the exchange; a claim is
//   claim_lostfound on the exchange naming the token.
// Every input is hostile: bytes out of shape, a second action, trailing bytes, a key or signature that is not ed25519,
// a bad signature, a sender other than W: the call is refused (null), never guessed.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64 } from "@scure/base";
import { NEP366_PREFIX } from "../../wallet/src/deposit/delegate.ts";

/** The longest relayer transaction read (a delegate carries at most a few KB: the helper's bind body cap is 4 KB). */
export const NEAR_W_CALL_MAX_BYTES = 8_192;

/** One of W's calls, its signature checked: what it calls, on what, and the last block it could land in. */
export type NearWCall = { receiver: string; method: string; args: Uint8Array; maxBlockHeight: bigint; nonce: bigint };

const HEX64 = /^[0-9a-f]{64}$/;
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

/** The delegate inside the relayer's signed transaction, checked as W's own; null when it is not. */
export function nearWCallOf(w: string, signedTxB64: string): NearWCall | null {
  if (!HEX64.test(w) || typeof signedTxB64 !== "string" || signedTxB64.length > Math.ceil((NEAR_W_CALL_MAX_BYTES * 4) / 3) + 4) return null;
  let b: Uint8Array;
  try {
    b = base64.decode(signedTxB64);
  } catch {
    return null;
  }
  try {
    return decode(w, b);
  } catch {
    return null;
  }
}

function decode(w: string, b: Uint8Array): NearWCall | null {
  let i = 0;
  const take = (n: number): Uint8Array => {
    if (!Number.isSafeInteger(n) || n < 0 || n > b.length - i) throw new Error("short");
    const out = b.subarray(i, i + n);
    i += n;
    return out;
  };
  const uint = (n: number): bigint => {
    const s = take(n);
    let v = 0n;
    for (let k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(s[k]!);
    return v;
  };
  const u32 = (): number => Number(uint(4));
  const str = (): string => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(take(u32()));
  const ed = (len: number): Uint8Array => {
    if (take(1)[0] !== 0) throw new Error("not ed25519");
    return take(len);
  };
  // the relayer's Transaction V0: signer, key, nonce, receiver, block hash, one action
  str();
  ed(32);
  uint(8);
  const outerReceiver = str();
  take(32);
  if (u32() !== 1 || take(1)[0] !== 8) return null; // exactly one action, Action::Delegate
  // the SignedDelegateAction: DelegateAction, then its signature
  const start = i;
  const sender = str();
  const receiver = str();
  if (u32() !== 1 || take(1)[0] !== 2) return null; // one FunctionCall
  const method = str();
  const args = take(u32());
  uint(8); // gas
  uint(16); // deposit
  const nonce = uint(8);
  const maxBlockHeight = uint(8);
  const key = ed(32);
  const delegate = b.subarray(start, i);
  const signature = ed(64);
  ed(64); // the relayer's signature over its transaction: its place only
  if (i !== b.length) return null;
  if (sender !== w || outerReceiver !== w) return null;
  const wKey = hexBytes(w);
  if (key.length !== 32 || !key.every((x, k) => x === wKey[k])) return null;
  const signable = new Uint8Array(4 + delegate.length);
  new DataView(signable.buffer).setUint32(0, NEP366_PREFIX, true);
  signable.set(delegate, 4);
  if (!ed25519.verify(signature, sha256(signable), wKey)) return null;
  return { receiver, method, args: Uint8Array.from(args), maxBlockHeight, nonce };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const json = (a: Uint8Array): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(a));

/** What one checked call says of W's trade: the token it names and whether it is a sell's swap; null when it names
 *  none (a call of no trade shape: it proves nothing). */
export function nearWCallToken(c: NearWCall, usdc: string, exchange: string): { token: string; sellSwap: boolean } | null {
  try {
    if (c.method === "storage_deposit") return c.receiver === usdc ? null : { token: c.receiver, sellSwap: false };
    if (c.method === "claim_lostfound") {
      if (c.receiver !== exchange) return null;
      const a = json(c.args);
      return isObj(a) && typeof a.token_id === "string" && a.token_id !== usdc ? { token: a.token_id, sellSwap: false } : null;
    }
    if (c.method !== "ft_transfer_call") return null;
    const a = json(c.args);
    if (!isObj(a) || a.receiver_id !== exchange || typeof a.msg !== "string") return null;
    if (c.receiver !== usdc) return { token: c.receiver, sellSwap: true }; // the token's own transfer: a sell
    const m = JSON.parse(a.msg) as unknown;
    const acts = isObj(m) && Array.isArray(m.actions) ? m.actions : [];
    const last = acts.at(-1);
    return isObj(last) && typeof last.token_out === "string" && last.token_out !== usdc ? { token: last.token_out, sellSwap: false } : null;
  } catch {
    return null;
  }
}
