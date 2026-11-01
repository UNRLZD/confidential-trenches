// U's one deposit call, signed on the device (card wallet-deposit-delegate; docs/plan1/wallet.md §2.4 step 7 and the
// §2.8 deposit call row, W:416 and W:898; the vault paper's 2.10 (b), V:669-673; the beta cap, OD:262; at research
// ffcba5e). Once U's reads pass (./account.ts, V 2.10 (a)), U's own key signs one NEP-366 DelegateAction:
//   sender_id U, receiver_id the network's token, exactly one FunctionCall of ft_transfer_call with args
//   {receiver_id: vault, amount, msg: {"precommitment": P, "depositor": U}}, 1 yocto, 180 Tgas, built by the kit's
//   vaultDepositCall (the one builder for U, R, V and A; it refuses an amount under MIN_DEPOSIT or over
//   HELPER_BIND_DEPOSIT_CAP, P not below p, a vault equal to the mover, the token or intents.near), at nonce = U's key
//   nonce + 1, with max_block_height = the lower block height of U's two-RPC reads + the window W.
// W is 120 blocks (about 70 s) until vault SB run (6) measures K, and never over 600, which the relayer refuses
// (markets H4.3 check 4, M:1730-1731). The nonce is also kept below that height x 1,000,000, which nearcore refuses
// (DelegateActionNonceTooLarge; the helper's check 3 does the same).
// The bytes are borsh(SignedDelegateAction) as nearcore reads them (core/primitives/src/action/delegate.rs): the
// signature is ed25519 over sha256(u32le(2^30 + 366) || borsh(DelegateAction)) (NEP-366's signable message). The
// helper's own checks (apps/helper/src/bind/checks.ts, H4.3 checks 1-7) pass them on test/vectors/deposit-delegate.json,
// and the borsh of near-api-js 7.3.1 for the helper's fixture equals ours byte for byte (test/deposit-delegate.test.ts).
// The signed call goes only to the release's relayer, POST RELEASE_BIND_URL (wallet.md:898: "never self-submitted and
// never another relayer"); the signing page's CSP lets it reach no other helper (packages/signpage/public/_headers).
// The request carries the signed delegate alone: no key, no words, no other id of the user. Nothing here logs.
//
// Not here (card wallet-deposit-bind, W2.3): the re-sign at the same nonce once a call lapsed ("Nothing landed"), the
// answers' waits and retries, the storage_balance_of(vault) read and the deposits-pages read of P.
import { HELPER_BIND_DEPOSIT_CODES, HELPER_FETCH_INIT, type HelperBindCode, vaultDepositCall } from "@blindfill/kit";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { depositId } from "../derive/keys.ts";
import { type DepositAccount, NEAR_NETWORKS, type NearNetwork, type NearRpc, readDepositAccount } from "./account.ts";

/** W: the delegate's window in blocks over the lower of the two RPC heights (V:670-672). */
export const DEPOSIT_WINDOW = 120;
/** W is never over this: the relayer refuses max_block_height more than 600 blocks ahead (H4.3 check 4). */
export const DEPOSIT_WINDOW_MAX = 600;
/** NEP-366's signable prefix: 2^30 + 366, a little-endian u32 before borsh(DelegateAction). */
export const NEP366_PREFIX = 2 ** 30 + 366;
/** nearcore's ACCESS_KEY_NONCE_RANGE_MULTIPLIER: a delegate nonce at or above the block height x this is refused. */
export const NONCE_RANGE_MULTIPLIER = 1_000_000n;
/** The release's relayer: POST /v1/bind on HELPER_HOST, the one helper SIGN_HOST's CSP connects to. */
export const RELEASE_BIND_URL = "https://api.confidential.unrealized.trade/v1/bind";
/** POST /v1/bind's body limit (HELPER_V1_PATHS), which also caps the decoded SignedDelegateAction. */
export const BIND_MAX_BYTES = 4_096;
export const SEND_TIMEOUT_MS = 10_000;

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export type DelegateRefusalCode = "input" | "window" | "key" | "balance" | "nonce" | "call";
export class DepositDelegateRefused extends Error {
  readonly code: DelegateRefusalCode;
  constructor(code: DelegateRefusalCode, detail: string) {
    super(`deposit not signed (${code}): ${detail}`);
    this.name = "DepositDelegateRefused";
    this.code = code;
  }
}

export interface DepositDelegateArgs {
  vault: string;
  network: NearNetwork;
  /** In the token's base units: this call's note. */
  amount: bigint;
  /** P, the note's precommitment. */
  precommitment: bigint;
  /** W in blocks; DEPOSIT_WINDOW unless SB run (6) sets another, 1 to DEPOSIT_WINDOW_MAX. */
  window?: number;
}

/** What goes to the relayer, and what the device keeps to follow it. */
export interface SignedDepositDelegate {
  /** borsh(SignedDelegateAction) in standard base64: POST /v1/bind's one body field. */
  signed_delegate: string;
  sender_id: string;
  receiver_id: string;
  nonce: bigint;
  max_block_height: bigint;
  public_key: string; // ed25519:<base58>
}

/** One DelegateAction with its one FunctionCall, the only shape this file signs. */
export interface DelegateFields {
  sender_id: string;
  receiver_id: string;
  method_name: string;
  args: Uint8Array;
  gas: bigint;
  deposit: bigint;
  nonce: bigint;
  max_block_height: bigint;
  public_key: Uint8Array; // 32 bytes, ed25519
}

/** borsh(DelegateAction) with exactly one FunctionCall action (tag 2), as nearcore reads it. */
export function encodeDelegateAction(d: DelegateFields): Uint8Array {
  const out: number[] = [];
  const uint = (v: bigint, bytes: number, max: bigint, what: string) => {
    if (typeof v !== "bigint" || v < 0n || v > max) throw new Error(`${what}: out of range`);
    for (let k = 0; k < bytes; k++) out.push(Number((v >> BigInt(8 * k)) & 0xffn));
  };
  const blob = (b: Uint8Array) => {
    uint(BigInt(b.length), 4, 0xffffffffn, "length");
    out.push(...b);
  };
  const str = (s: string) => blob(new TextEncoder().encode(s));
  if (!(d.public_key instanceof Uint8Array) || d.public_key.length !== 32) throw new Error("public_key: not 32 bytes");
  str(d.sender_id);
  str(d.receiver_id);
  uint(1n, 4, 1n, "actions");
  out.push(2); // Action::FunctionCall
  str(d.method_name);
  blob(d.args);
  uint(d.gas, 8, U64_MAX, "gas");
  uint(d.deposit, 16, U128_MAX, "deposit");
  uint(d.nonce, 8, U64_MAX, "nonce");
  uint(d.max_block_height, 8, U64_MAX, "max_block_height");
  out.push(0, ...d.public_key); // KeyType::ED25519
  return Uint8Array.from(out);
}

/** borsh(SignedDelegateAction): the delegate, then ed25519's tag and its signature over NEP-366's signable message. */
export function signDelegateAction(d: DelegateFields, secretKey: Uint8Array): Uint8Array {
  const delegate = encodeDelegateAction(d);
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, NEP366_PREFIX, true);
  const signable = new Uint8Array(4 + delegate.length);
  signable.set(prefix);
  signable.set(delegate, 4);
  const signature = ed25519.sign(sha256(signable), secretKey);
  const signed = new Uint8Array(delegate.length + 65);
  signed.set(delegate);
  signed[delegate.length] = 0; // KeyType::ED25519
  signed.set(signature, delegate.length + 1);
  return signed;
}

/**
 * Signs U_{s,i}'s deposit call from `read`, the answer of U's reads (checkDepositAccount) on `args.network`. Refuses,
 * before anything is signed: a window that is not a whole number in 1..600, a read that is not U's own, an amount
 * over what the read found, a nonce + 1 at or above the read height x 1,000,000, and whatever vaultDepositCall refuses
 * (the cap among them). U's secret key is zeroed once the signature is made.
 */
export function signDepositDelegate(seed64: Uint8Array, s: bigint, i: number, args: DepositDelegateArgs, read: DepositAccount): SignedDepositDelegate {
  const window = args.window ?? DEPOSIT_WINDOW;
  if (!Number.isSafeInteger(window) || window < 1 || window > DEPOSIT_WINDOW_MAX)
    throw new DepositDelegateRefused("window", `the window must be a whole number of blocks in 1..${DEPOSIT_WINDOW_MAX}`);
  if (typeof args.network !== "string" || !Object.hasOwn(NEAR_NETWORKS, args.network)) throw new DepositDelegateRefused("input", `unknown network ${String(args.network)}`);
  const token = NEAR_NETWORKS[args.network].token;
  const { nonce, height, balance } = read;
  if (!Number.isSafeInteger(nonce) || nonce < 0 || !Number.isSafeInteger(height) || height <= 0 || typeof balance !== "bigint" || read.halted !== false)
    throw new DepositDelegateRefused("input", "the read is not a passed deposit-account read");

  const u = depositId(seed64, s, i);
  try {
    const publicKey = `ed25519:${base58.encode(u.publicKey)}`;
    if (read.account !== u.id || read.publicKey !== publicKey) throw new DepositDelegateRefused("key", "the read is not of U_{s,i}");
    if (typeof args.amount !== "bigint" || args.amount > balance) throw new DepositDelegateRefused("balance", `the amount is over U's read balance ${balance}`);
    const n = BigInt(nonce) + 1n;
    if (n >= BigInt(height) * NONCE_RANGE_MULTIPLIER) throw new DepositDelegateRefused("nonce", "nonce + 1 is at or above the read height x 1,000,000");

    let call: ReturnType<typeof vaultDepositCall>;
    try {
      call = vaultDepositCall({ vault: args.vault, token, mover: u.id, amount: args.amount, precommitment: args.precommitment });
    } catch (e) {
      throw new DepositDelegateRefused("call", e instanceof Error ? e.message : String(e));
    }
    const fc = call.actions[0].FunctionCall;
    // The args exactly as the relayer reads them back (checks.ts frozenArgs): receiver_id, amount, msg, in that order.
    const json = JSON.stringify({ receiver_id: fc.args.receiver_id, amount: fc.args.amount, msg: fc.args.msg });
    const max_block_height = BigInt(height) + BigInt(window);
    const signed = signDelegateAction(
      {
        sender_id: call.sender_id,
        receiver_id: call.receiver_id,
        method_name: fc.method_name,
        args: new TextEncoder().encode(json),
        gas: BigInt(fc.gas),
        deposit: BigInt(fc.deposit),
        nonce: n,
        max_block_height,
        public_key: u.publicKey,
      },
      u.secretKey,
    );
    if (signed.length > BIND_MAX_BYTES) throw new DepositDelegateRefused("call", `the signed call is ${signed.length} B, over ${BIND_MAX_BYTES}`);
    return { signed_delegate: base64.encode(signed), sender_id: call.sender_id, receiver_id: call.receiver_id, nonce: n, max_block_height, public_key: publicKey };
  } finally {
    u.secretKey.fill(0);
  }
}

/** Reads U_{s,i} on two RPCs (readDepositAccount) and signs its deposit call only once every read passed. */
export async function depositDelegate(
  seed64: Uint8Array, s: bigint, i: number, args: DepositDelegateArgs, rpcs: readonly [NearRpc, NearRpc],
): Promise<SignedDepositDelegate> {
  const read = await readDepositAccount(seed64, s, i, args.amount, args.network, rpcs);
  return signDepositDelegate(seed64, s, i, args, read);
}

/** The relayer's answer, checked: a tx hash, or one of the deposit codes. Anything else throws. */
export type BindAnswer = { ok: true; tx_hash: string } | { ok: false; code: HelperBindCode };

/**
 * Hands the signed call to the release's relayer only: POST RELEASE_BIND_URL with {signed_delegate} and nothing else.
 * The answer is hostile input: only a tx hash of 32 bytes in base58 or a code from HELPER_BIND_DEPOSIT_CODES is taken;
 * the deposit itself is confirmed from the vault's deposits pages, never from this answer (W:418).
 */
export async function sendDepositDelegate(signed: Pick<SignedDepositDelegate, "signed_delegate">, fetchFn: typeof fetch = fetch): Promise<BindAnswer> {
  const res = await fetchFn(RELEASE_BIND_URL, {
    ...HELPER_FETCH_INIT,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signed_delegate: signed.signed_delegate }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`relayer: HTTP ${res.status}, not JSON`);
  }
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (res.status === 200 && typeof b.tx_hash === "string") {
    let raw: Uint8Array | undefined;
    try {
      raw = base58.decode(b.tx_hash);
    } catch {
      raw = undefined;
    }
    if (raw?.length === 32) return { ok: true, tx_hash: b.tx_hash };
  }
  const err = b.error;
  const code = typeof err === "object" && err !== null ? (err as Record<string, unknown>).code : undefined;
  if (res.status !== 200 && typeof code === "string" && (HELPER_BIND_DEPOSIT_CODES as readonly string[]).includes(code)) return { ok: false, code: code as HelperBindCode };
  throw new Error(`relayer: HTTP ${res.status}, not a bind answer`);
}
