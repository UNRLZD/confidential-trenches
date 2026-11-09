// U's one deposit call, signed on the device (card wallet-deposit-delegate; docs/plan1/wallet.md §2.4 step 7 and the
// §2.8 deposit call row, W:416 and W:898; the vault paper's 2.10 (b), V:669-673; the beta cap, OD:262; at research
// ffcba5e). Once U's reads pass (./account.ts, V 2.10 (a)), U's own key signs one NEP-366 DelegateAction:
//   sender_id U, receiver_id the network's token, exactly one FunctionCall of ft_transfer_call with args
//   {receiver_id: the network's vault, amount, msg: {"precommitment": P, "depositor": U}}, 1 yocto, 180 Tgas. The
//   token and the vault are the release's (NEAR_NETWORKS), never an argument: no caller and no helper answer can name
//   another receiver (wallet.md:898, "the vault id written into the release"). Built by the kit's
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
// The only way in is depositDelegate: U's reads on two RPCs first, then U's key is derived, signs and is zeroed, so no
// hand-made read and no read of another network can be signed from.
// The signed call goes only to the release's relayer, POST RELEASE_BIND_URL (wallet.md:898: "never self-submitted and
// never another relayer"), with redirect: "error", so fetch follows none; the signing page's CSP lets it reach no other helper
// (packages/signpage/public/_headers). The request carries the signed delegate alone: no key, no words, no other id of
// the user. Its answer is read up to BIND_ANSWER_MAX_BYTES. Nothing here logs.
//
// Not here (card wallet-deposit-bind, W2.3): the re-sign at the same nonce once a call lapsed ("Nothing landed"), the
// answers' waits and retries, the storage_balance_of(vault) read and the deposits-pages read of P.
import { HELPER_BIND_ANSWER_MS, HELPER_BIND_DEPOSIT_CODES, HELPER_CODE_STATUS, HELPER_FETCH_INIT, type HelperBindCode, vaultDepositCall } from "@blindfill/kit";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { depositId } from "../derive/keys.ts";
import { type DepositAccount, NEAR_NETWORKS, type NearNetwork, type NearRpc, readDepositAccount } from "./account.ts";
import { readCapped } from "./capped.ts";
import { askWhileBusy, type BusyOpts } from "../busy.ts";

/** W: the delegate's window in blocks over the lower of the two RPC heights (V:670-672). */
export const DEPOSIT_WINDOW = 120;
/** W is never over this: the relayer refuses max_block_height more than 600 blocks ahead (H4.3 check 4). */
export const DEPOSIT_WINDOW_MAX = 600;
/** NEP-366's signable prefix: 2^30 + 366, a little-endian u32 before borsh(DelegateAction). */
export const NEP366_PREFIX = 2 ** 30 + 366;
/** nearcore's ACCESS_KEY_NONCE_RANGE_MULTIPLIER: a delegate nonce at or above the block height x this is refused. */
export const NONCE_RANGE_MULTIPLIER = 1_000_000n;
/** The release's relayer: POST /v1/bind on HELPER_HOST, the one helper SIGN_HOST's CSP connects to. */
export const RELEASE_BIND_URL = "https://ct-api.unrealized.trade/v1/bind";
/** POST /v1/bind's body limit (HELPER_V1_PATHS), which also caps the decoded SignedDelegateAction. */
export const BIND_MAX_BYTES = 4_096;
/**
 * How long the send waits for the relayer's answer: the kit's HELPER_BIND_ANSWER_MS, within which the helper answers
 * (a carry still running then answers in_flight), and 5 s for the request's way there and back. Every answer the
 * carry gives in time is heard; past this the send has no answer, which the bind reads as unsure (it reads the pages).
 */
export const SEND_TIMEOUT_MS = HELPER_BIND_ANSWER_MS + 5_000;
/** The relayer's answer is {tx_hash} or {error: {code}}: anything longer is not one. */
export const BIND_ANSWER_MAX_BYTES = 1_024;

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export type DelegateRefusalCode = "input" | "window" | "no_vault" | "nonce" | "key" | "call";
export class DepositDelegateRefused extends Error {
  readonly code: DelegateRefusalCode;
  constructor(code: DelegateRefusalCode, detail: string) {
    super(`deposit not signed (${code}): ${detail}`);
    this.name = "DepositDelegateRefused";
    this.code = code;
  }
}

export interface DepositDelegateArgs {
  /** The network names the token and the vault (NEAR_NETWORKS); there is no other way to name either. */
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
  /** U's USDC in the read this call was signed from (public, on chain): a refused call's USDC is back once U holds it again. */
  balance: bigint;
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

// borsh(SignedDelegateAction): the delegate, then ed25519's tag and its signature over NEP-366's signable message.
function signDelegateAction(d: DelegateFields, secretKey: Uint8Array): Uint8Array {
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

// Signs U_{s,i}'s deposit call from `read`, the answer of readDepositAccount on args.network made just before (module
// private: depositDelegate is its only caller). Refuses, before anything is signed: a network with no vault in the
// release, a window that is not a whole number in 1..600, a nonce + 1 at or above the read height x 1,000,000, and
// whatever vaultDepositCall refuses (the cap among them). U's secret key is zeroed on every path once derived.
function signDepositDelegate(seed64: Uint8Array, s: bigint, i: number, args: DepositDelegateArgs, read: DepositAccount): SignedDepositDelegate {
  const window = args.window ?? DEPOSIT_WINDOW;
  if (!Number.isSafeInteger(window) || window < 1 || window > DEPOSIT_WINDOW_MAX)
    throw new DepositDelegateRefused("window", `the window must be a whole number of blocks in 1..${DEPOSIT_WINDOW_MAX}`);
  const { usdc: token, vault } = NEAR_NETWORKS[args.network];
  if (vault === null) throw new DepositDelegateRefused("no_vault", `the release names no vault on ${args.network}`);
  const n = BigInt(read.nonce) + 1n;
  if (n >= BigInt(read.height) * NONCE_RANGE_MULTIPLIER) throw new DepositDelegateRefused("nonce", "nonce + 1 is at or above the read height x 1,000,000");

  const u = depositId(seed64, s, i);
  try {
    // The read must be of the key that signs: never a call from an account other than the one just read.
    if (read.account !== u.id) throw new DepositDelegateRefused("key", "the read is not of U_{s,i}");
    let call: ReturnType<typeof vaultDepositCall>;
    try {
      call = vaultDepositCall({ vault, token, mover: u.id, amount: args.amount, precommitment: args.precommitment });
    } catch (e) {
      throw new DepositDelegateRefused("call", e instanceof Error ? e.message : String(e));
    }
    const fc = call.actions[0].FunctionCall;
    // The args exactly as the relayer reads them back (checks.ts frozenArgs): receiver_id, amount, msg, in that order.
    const json = JSON.stringify({ receiver_id: fc.args.receiver_id, amount: fc.args.amount, msg: fc.args.msg });
    const max_block_height = BigInt(read.height) + BigInt(window);
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
    const publicKey = `ed25519:${base58.encode(u.publicKey)}`;
    return { signed_delegate: base64.encode(signed), sender_id: call.sender_id, receiver_id: call.receiver_id, nonce: n, max_block_height, public_key: publicKey, balance: read.balance };
  } finally {
    u.secretKey.fill(0);
  }
}

/**
 * U_{s,i}'s deposit call on the network's token into the network's vault: reads U on two RPCs (readDepositAccount, which
 * refuses an unknown network) and signs only once every read passed.
 */
export async function depositDelegate(
  seed64: Uint8Array, s: bigint, i: number, args: DepositDelegateArgs, rpcs: readonly [NearRpc, NearRpc],
): Promise<SignedDepositDelegate> {
  // Everything the call is made from is copied before the first await: a change to args or seed64 while the reads are
  // out cannot reach what is signed. The seed's copy is zeroed on every path.
  const own: DepositDelegateArgs = { network: args.network, amount: args.amount, precommitment: args.precommitment, window: args.window };
  if (!(seed64 instanceof Uint8Array) || seed64.length !== 64) throw new DepositDelegateRefused("input", "seed64 must be 64 bytes");
  const seed = Uint8Array.from(seed64);
  try {
    const read = await readDepositAccount(seed, s, i, own.amount, own.network, rpcs);
    return signDepositDelegate(seed, s, i, own, read);
  } finally {
    seed.fill(0);
  }
}

/** The relayer's answer, checked: a tx hash, or one of the deposit codes. Anything else throws. */
export type BindAnswer = { ok: true; tx_hash: string } | { ok: false; code: HelperBindCode };

/**
 * Hands the signed call to the release's relayer only: POST RELEASE_BIND_URL with {signed_delegate} and nothing else.
 * The answer is hostile input: only a tx hash of 32 bytes in base58 on 200, or a code from HELPER_BIND_DEPOSIT_CODES
 * with its own HTTP status, is taken;
 * the deposit itself is confirmed from the vault's deposits pages, never from this answer (W:418). It waits
 * SEND_TIMEOUT_MS each ask, or until `signal` (the bind's stop) aborts. A busy helper (429 rate_limited, 503 upstream) is
 * waited out for its Retry-After, capped, and the same bytes go again, BUSY_ASKS asks at most (../busy.ts, card
 * withdraw-fee-busy-waits): one signed call, so at most one runs; the last busy answer is no bind answer (the bind
 * settles it from the pages, as before).
 */
export async function sendDepositDelegate(
  signed: Pick<SignedDepositDelegate, "signed_delegate">, fetchFn: typeof fetch = fetch, signal?: AbortSignal, sleep?: BusyOpts["sleep"],
): Promise<BindAnswer> {
  const bytes = JSON.stringify({ signed_delegate: signed.signed_delegate });
  const res = await askWhileBusy(
    () =>
      fetchFn(RELEASE_BIND_URL, {
        ...HELPER_FETCH_INIT,
        redirect: "error",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bytes,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]) : AbortSignal.timeout(SEND_TIMEOUT_MS),
      }),
    { signal, sleep },
  );
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readCapped(res, BIND_ANSWER_MAX_BYTES)));
  } catch (e) {
    throw new Error(`relayer: HTTP ${res.status}, ${e instanceof Error && e.message.startsWith("relayer:") ? e.message.slice(9) : "not JSON"}`);
  }
  const own = (o: unknown, k: string): unknown =>
    typeof o === "object" && o !== null && !Array.isArray(o) && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined;
  const txHash = own(body, "tx_hash");
  if (res.status === 200 && typeof txHash === "string" && own(body, "error") === undefined) {
    let raw: Uint8Array | undefined;
    try {
      raw = base58.decode(txHash);
    } catch {
      raw = undefined;
    }
    if (raw?.length === 32) return { ok: true, tx_hash: txHash };
  }
  const code = own(own(body, "error"), "code");
  // A code counts only with its own status (HELPER_CODE_STATUS, 400 for a code not listed there).
  if (txHash === undefined && typeof code === "string" && (HELPER_BIND_DEPOSIT_CODES as readonly string[]).includes(code)) {
    const status = Object.hasOwn(HELPER_CODE_STATUS, code) ? HELPER_CODE_STATUS[code as keyof typeof HELPER_CODE_STATUS] : 400;
    if (res.status === status) return { ok: false, code: code as HelperBindCode };
  }
  throw new Error(`relayer: HTTP ${res.status}, not a bind answer`);
}
