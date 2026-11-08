// The refund move (card wallet-refund-move; docs/plan1/wallet.md §2.4 point 8 and the §2.8 refund move row, at research
// HEAD). When 1Click refunds a late or wrong send to U inside intents.near (refundType INTENTS), the device moves it on
// with no tap: a 1Click quote from that asset to the vault's asset with depositType INTENTS, recipient U on the token
// (DESTINATION_CHAIN) and refundTo U (INTENTS), checked as a deposit quote; then one transfer intent of exactly the
// quote's amount in to its signed deposit address, signed by U's key and carried by the release's relayer
// (POST /v1/intents, markets.md H4.3 "The ids' intents"). 1Click delivers the vault's asset to U on the token, and the
// follow (./follow.ts) binds it as U's next note.
//
// This file builds the request, the nonce and the payload, and runs the steps in order. The checks and the signature are
// SIGN_HOST's (packages/signpage/src/rules/refund.ts: checkRefundMoveQuote, checkIdTransferIntent, signIdIntent), handed
// in as `check`, so nothing here signs a payload no rule passed.
// - The order: the quote is asked and checked with no key open; the payload is built and checked; only then is U's key
//   opened (deps.openKey, which zeroes it after), the intent signed, and the move recorded (deps.record) before it is
//   sent, so a reload never signs a second one while the first can still land.
// - A refund under MIN_DEPOSIT is not moved: its quote's floor (MIN_DEPOSIT out, the vault's least deposit) refuses it,
//   which the check reports as RefundMoveUnderMin; it waits under U for withdraw.open.
// - The relayer's answer is hostile and ends nothing: the follow counts the move through only on its own chain reads.
//   Its code is read (a listed HELPER_INTENTS_CODES code with its own status, or none) so the follow can stop on
//   sender_struck (final for U here, markets.md H4.3) and back off on any other refusal; a route that does not answer
//   its own refusal to an empty body (ask.probe) gets no new quote and no signature.
// Nothing here logs. The request names U, the asset and the amount; the intent is U's own.
import { HELPER_FETCH_INIT, HELPER_INTENTS_CODES, type HelperIntentsCode, type HelperSignedIntent, type OneClickRequest } from "@blindfill/kit";
import { base64 } from "@scure/base";
import { readCapped } from "./capped.ts";
import { askDepositQuote, DEPOSIT_QUOTE_DESTINATION, DEPOSIT_QUOTE_SLIPPAGE_BPS, type DepositQuoteReply } from "./quote.ts";

/** The release's relayer for an id's intents: POST /v1/intents on HELPER_HOST (kit helper/v1.ts HelperIntentsRequest). */
export const RELEASE_INTENTS_URL = "https://ct-api.unrealized.trade/v1/intents";
export const RELEASE_INTENTS_TIMEOUT_MS = 10_000;
/** An id's intent deadline: the lower of two RPCs' final-block times + 120 s (wallet.md §2.8 refund move row; the rule's
 *  ID_INTENT_WINDOW_MS, which a test holds equal). */
export const REFUND_INTENT_WINDOW_MS = 120_000;
/** The quote's own deadline from now: 30 minutes, as the deposit quote asks (quote.ts DEPOSIT_QUOTE_DEADLINE_MS). */
export const REFUND_QUOTE_DEADLINE_MS = 30 * 60_000;
/** intents.near's V1 versioned nonce: magic 5628f6c6, version 0, then salt (4), deadline (i64 ns LE), 15 random bytes
 *  (near/intents 32cd1f9 core/src/nonce/versioned.rs, salted.rs, expirable.rs). */
export const NONCE_V1_PREFIX = Uint8Array.of(0x56, 0x28, 0xf6, 0xc6, 0);
const IMPLICIT = /^[0-9a-f]{64}$/;
const SALT = /^[0-9a-f]{8}$/;

/** The quote request of §2.4 point 8 for `amount` base units of `asset` that U holds inside intents.near, asked at `now`. */
export function refundMoveRequest(u: string, asset: string, amount: bigint, now: number): OneClickRequest {
  if (typeof u !== "string" || !IMPLICIT.test(u)) throw new Error("refund move: U must be a 64-hex implicit account id");
  if (typeof asset !== "string" || asset === "") throw new Error("refund move: no asset");
  if (typeof amount !== "bigint" || amount <= 0n) throw new Error("refund move: the amount must be a positive bigint");
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("refund move: now must be a time in ms");
  return {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: DEPOSIT_QUOTE_SLIPPAGE_BPS,
    originAsset: asset,
    depositType: "INTENTS",
    destinationAsset: DEPOSIT_QUOTE_DESTINATION,
    amount: amount.toString(),
    refundTo: u,
    refundType: "INTENTS",
    recipient: u,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now + REFUND_QUOTE_DEADLINE_MS).toISOString(),
  };
}

/** A V1 versioned nonce (base64 of 32 bytes) under intents.near's current `salt` (8 hex), dying at `deadlineMs`. */
export function versionedNonce(salt: string, deadlineMs: number, random15: Uint8Array = crypto.getRandomValues(new Uint8Array(15))): string {
  if (typeof salt !== "string" || !SALT.test(salt)) throw new Error("refund move: the salt must be 4 bytes of hex");
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error("refund move: the deadline must be a time in ms");
  if (!(random15 instanceof Uint8Array) || random15.length !== 15) throw new Error("refund move: 15 random bytes");
  const n = new Uint8Array(32);
  n.set(NONCE_V1_PREFIX, 0);
  n.set(Uint8Array.from(salt.match(/../g)!, (h) => parseInt(h, 16)), 5);
  new DataView(n.buffer).setBigInt64(9, BigInt(deadlineMs) * 1_000_000n, true);
  n.set(random15, 17);
  return base64.encode(n);
}

/** The transfer intent's payload, in the one spelling the rule reads (the five keys in order, no whitespace). */
export function transferPayload(p: { u: string; deadlineMs: number; nonce: string; receiver: string; asset: string; amount: bigint }): string {
  return JSON.stringify({
    signer_id: p.u,
    verifying_contract: "intents.near",
    deadline: new Date(p.deadlineMs).toISOString(),
    nonce: p.nonce,
    intents: [{ intent: "transfer", receiver_id: p.receiver, tokens: { [p.asset]: p.amount.toString() } }],
  });
}

/** One RPC's reads at the one block the follow read: its time (ns) and what U holds of the asset (mt_balance_of). */
export interface RefundRead {
  blockTimeNs: bigint;
  held: bigint;
}
/** The move as the op records it before it is sent: its nonce, deadline (unix ms), asset, amount and the block its reads
 *  were made at. */
export interface MoveRecord {
  nonce: string;
  deadline_ms: number;
  asset: string;
  amount: string;
  /** The block both RPCs' reads were made at: a later read of the move below it is no read (a provider's final that
   *  steps back answers from before the refund arrived). */
  height: number;
  /** A debit of U's balance below the move read in its window with its nonce unused: another intent of U's own. */
  foreign?: true;
}

/** The checks, SIGN_HOST's rules (rules/refund.ts), and the quote's floor read as under MIN_DEPOSIT. */
export interface RefundMoveCheck<Q, I> {
  /** checkRefundMoveQuote: the answer to `request` checked; throws RefundMoveUnderMin when its one shortfall is MIN_DEPOSIT. */
  quote(request: OneClickRequest, answer: unknown): Q;
  /** The checked quote's signed deposit address, amount in and deadline (unix ms). */
  read(q: Q): { depositAddress: string; amountIn: bigint; deadlineMs: number };
  /** checkIdTransferIntent with the reads and the earlier deadline (ISO, or null when there is none). */
  intent(payload: string, q: Q, reads: readonly [RefundRead, RefundRead], priorDeadline: string | null): I;
  /** signIdIntent with U's secret key. */
  sign(secretKey: Uint8Array, intent: I): HelperSignedIntent;
}

export class RefundMoveUnderMin extends Error {
  constructor() {
    super("refund move: under MIN_DEPOSIT");
    this.name = "RefundMoveUnderMin";
  }
}

export interface RefundMoveAsk {
  u: string;
  /** The one asset moved (a 1Click id, "nep141:<token>") and the balance both RPCs read at one block. */
  asset: string;
  reads: readonly [RefundRead, RefundRead];
  /** The block those reads were made at (both RPCs at one height), kept with the move. */
  height: number;
  /** intents.near's current salt (8 hex), read on both RPCs alike. */
  salt: string;
  /** The deadline (unix ms) of U's earlier move for this money that never landed, or null. */
  priorMs: number | null;
  /** The relayer refused the last move: ask the route first (an empty body must get one of its own refusals), and ask
   *  no quote and open no key unless it answers. */
  probe?: boolean;
}

export interface RefundMoveDeps<Q, I> {
  check: RefundMoveCheck<Q, I>;
  /** Opens U's secret key for `fn` only (SIGN_HOST: the seed under its lock, U checked), zeroing it after. */
  openKey<T>(fn: (secretKey: Uint8Array) => T): Promise<T>;
  /** Writes the move into U's ops before it is sent. */
  record(m: MoveRecord): Promise<void>;
  fetchFn?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
}

/** sent: recorded and handed to the relayer (its answer read as data only); under_min: waits for withdraw.open;
 *  refused: nothing signed (a quote off the request, the helper down, a read that moved), tried again on a later round. */
export type RefundMoveResult = { kind: "sent"; move: MoveRecord; status: number; code: HelperIntentsCode | null } | { kind: "under_min" } | { kind: "refused"; why: string };

/** The relayer's answer is {tx_hash} or {error: {code}}: anything longer is not one. */
export const INTENTS_ANSWER_MAX_BYTES = 1_024;

/** POST /v1/intents with `body`: the HTTP status (0 when none came) and its listed code, or null. */
async function postIntents(body: string, fetchFn: typeof fetch, signal?: AbortSignal): Promise<{ status: number; code: HelperIntentsCode | null }> {
  try {
    const timeout = AbortSignal.timeout(RELEASE_INTENTS_TIMEOUT_MS);
    const res = await fetchFn(RELEASE_INTENTS_URL, {
      ...HELPER_FETCH_INIT,
      redirect: "error",
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    let code: HelperIntentsCode | null = null;
    try {
      const j: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readCapped(res, INTENTS_ANSWER_MAX_BYTES)));
      const e = typeof j === "object" && j !== null && Object.hasOwn(j, "error") ? (j as { error: unknown }).error : undefined;
      const c = typeof e === "object" && e !== null && Object.hasOwn(e, "code") ? (e as { code: unknown }).code : undefined;
      if (typeof c === "string" && (HELPER_INTENTS_CODES as readonly string[]).includes(c) && res.status >= 400 && res.status < 500) code = c as HelperIntentsCode;
    } catch {
      code = null;
    }
    return { status: res.status, code };
  } catch {
    signal?.throwIfAborted();
    return { status: 0, code: null };
  }
}

/** Runs one refund move: the quote, its check, the intent, its check, U's signature, the record, the send. */
export async function runRefundMove<Q, I>(ask: RefundMoveAsk, deps: RefundMoveDeps<Q, I>): Promise<RefundMoveResult> {
  const now = deps.now ?? Date.now;
  const [a, b] = ask.reads;
  if (a.held !== b.held || a.held <= 0n) return { kind: "refused", why: "held" };
  const held = a.held;
  // 0. after a refusal, the route first: an empty body answered by one of its own refusals (bad_shape), else no quote
  if (ask.probe === true) {
    const p = await postIntents("{}", deps.fetchFn ?? fetch, deps.signal);
    if (p.code === null) return { kind: "refused", why: "relay" };
  }
  // 1. the quote for all U holds of the asset, through the helper, checked as a deposit quote (no key open)
  let request: OneClickRequest;
  try {
    request = refundMoveRequest(ask.u, ask.asset, held, now());
  } catch {
    return { kind: "refused", why: "request" };
  }
  let reply: DepositQuoteReply;
  try {
    reply = await askDepositQuote(request, deps.fetchFn);
  } catch {
    deps.signal?.throwIfAborted();
    return { kind: "refused", why: "down" };
  }
  if (reply.status !== 200 && reply.status !== 201) return { kind: "refused", why: `quote_http_${reply.status}` };
  let q: Q;
  try {
    q = deps.check.quote(request, reply.body);
  } catch (e) {
    if (e instanceof RefundMoveUnderMin) return { kind: "under_min" };
    return { kind: "refused", why: "quote_check_failed" };
  }
  // 2. the intent: exactly the quote's amount in to its signed deposit address, dying 120 s past the lower block time
  const r = deps.check.read(q);
  const t0 = a.blockTimeNs / 1_000_000n, t1 = b.blockTimeNs / 1_000_000n;
  const deadlineMs = Number(t0 < t1 ? t0 : t1) + REFUND_INTENT_WINDOW_MS;
  let move: MoveRecord, intent: I;
  try {
    const nonce = versionedNonce(ask.salt, deadlineMs);
    const payload = transferPayload({ u: ask.u, deadlineMs, nonce, receiver: r.depositAddress, asset: ask.asset, amount: r.amountIn });
    intent = deps.check.intent(payload, q, ask.reads, ask.priorMs === null ? null : new Date(ask.priorMs).toISOString());
    move = { nonce, deadline_ms: deadlineMs, asset: ask.asset, amount: r.amountIn.toString(), height: ask.height };
  } catch {
    return { kind: "refused", why: "intent" };
  }
  // 3. U's signature, with the key open for the signing only; the move recorded before it is sent
  let signed: HelperSignedIntent;
  try {
    signed = await deps.openKey((sk) => deps.check.sign(sk, intent));
  } catch {
    deps.signal?.throwIfAborted();
    return { kind: "refused", why: "sign" };
  }
  await deps.record(move);
  // 4. the send: the relayer's answer is data (its code read for the follow's pace); the follow reads the chain for the
  // move's debit
  const { status, code } = await postIntents(JSON.stringify({ signed_intent: signed }), deps.fetchFn ?? fetch, deps.signal);
  return { kind: "sent", move, status, code };
}
