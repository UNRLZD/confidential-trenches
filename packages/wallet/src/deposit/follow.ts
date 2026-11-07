// The device follows a deposit from its checked address to its note, with no tap (card wallet-deposit-follow;
// docs/plan1/wallet.md §2.4 steps 4-9 and point 8, the app paper's APU-04 table, at research HEAD).
//
// The rule: a status answer from the server moves only the stage shown and never ends a follow. An op ends only on the
// device's own chain reads.
// - 1Click's status of the deposit address is read through the helper's keyed proxy (POST /v1/proxy/oneclick/v0/status,
//   apps/helper/src/proxy/vendors.ts oneclick). The answer is hostile: it counts only when it names our address, with U
//   as its recipient and its refund, and one of 1Click's seven statuses, and then it moves only the stage shown
//   (STATUS_STAGE, APU-04), never back (a stale answer). REFUNDED and SUCCESS show nothing the chain has not read.
// - One follower per U: the money is U's, and two quotes asked before a payment name one U (the deposit index moves
//   only once a deposit lands). Every op of U attaches to U's one follower (followDeposit), which runs rounds over all
//   of them; SIGN_HOST holds one lock per U across tabs.
// - Each round reads the chain first, on both RPCs at one final block (heights within HEIGHT_SPREAD_MAX): U's own USDC,
//   MIN_DEPOSIT or more bound as U's next note from the note store (its lowest note not landed, else a new second
//   arrival; a note with its call out is settled by bind.ts before anything new is signed). Anything that credits U, a
//   stranger's gift or a refund's return too, is bound, so nothing under U is left unfollowed.
// - done: U's money is one sum, never split between its ops (two quotes before a payment name one U, wallet.md:353-361).
//   An op is done once its own status read SUCCESS and the USDC bound into the vault from U (its notes whose leaf the
//   pages on both RPCs hold for U, whatever their state now: a withdraw may have begun) is at least the sum of the
//   checked min_amount_out of every op of U whose own status read SUCCESS. A held op whose status read SUCCESS joins that
//   sum once U's bound USDC covers its min on top of the rest: it is no longer held and is done like any other. Each
//   done op shows its part of U's sum, oldest first (what 1Click says it delivered, at least its min, the later ones
//   keeping theirs; the last one the rest), shown again as the sum grows. With deps.untilFinal (SIGN_HOST) a done op is
//   followed on until its quote's deadline is past on both RPCs (FollowRecord.final) on a round with nothing left to
//   bind (U's USDC under MIN_DEPOSIT on both, no call out) and nothing left to move (no refund move out, nothing under U
//   inside intents.near a move would take), so an older quote's late send to U, or a second refund, is bound and counted.
// - A known limit: 1Click's status comes through the helper, so a hostile helper that forges SUCCESS for a quote never
//   paid can show it done with another op's money of U, or keep a paid op of U from done until U's sum covers both
//   (review r3 D2, D2b). The per-U sum bounds it: no op shows done past what U bound into the vault, and nothing is
//   stranded, every credit to U is bound as U's notes either way.
// - held: the relayer struck U or refused the call, the bind refused (USDC's code hash moved, a note with another leaf,
//   the seed not U's), or the pages do not hold a note's leaf. halted while the bind waits on a halt, cleared by the next
//   bind phase that waits on none.
// - refunded: only for an op whose own status read REFUNDED, once what U holds inside intents.near of its origin asset
//   or of NEAR USDC reads more than 0 on both RPCs. A stage, no end: U's USDC is still bound each round. With
//   deps.refundMove (wallet.md §2.4 point 8, ./refund.ts) the move is recorded in the op with its intent's nonce,
//   deadline, asset, amount and the block its reads were made at before it is sent. Its state is read at one block on
//   both RPCs (each one's final, heights within HEIGHT_SPREAD_MAX, read at the lower): the block's time, is_nonce_used
//   and what U holds of the asset. A read below the move's block, or below the highest block a refund read rested on
//   (this session, or the read that found the last move through or over, kept with the op across a reload), is no
//   read: a provider's final that steps back answers from before the refund arrived.
//   - through on its own debit: the nonce reads used, or (a pruned nonce) U holds less than the move took at a block
//     past its deadline with no other debit seen in its window. Only the ops whose origin is the move's asset are marked
//     moved (each op on its own debit). Such an op then needs MIN_DEPOSIT of U's sum (its money back under U as USDC),
//     and what U holds after it (a stranger's dust, a second refund) is moved by a new move.
//   - another intent of U's (a withdraw.open): U holds less than the move at a block inside its window with the nonce
//     unused. A nonce is never pruned in its window, so that debit is not the move's; remembered on the move (foreign),
//     the move reads over unlanded past its deadline, and an op whose own asset U then holds none of ends held
//     (moved_out); what is left is moved again, or held under_min. The limit: once such a debit is seen, a move that
//     still lands in its window, its nonce pruned before any read finds it used, cannot be told from one that never
//     landed; it reads over unlanded, and its op ends held (moved_out) when U then holds none of the asset, while the
//     move's USDC arrives under U on the token. That ends once U's withdraws from the id are signed on this device
//     (withdraw-from-id), so every debit of U's is one of its own known moves.
//   - over unlanded: the nonce reads unused at a block whose time is past its deadline. intents.near prunes used nonces
//     past their deadline (cleanup_nonces, DAO or GarbageCollector role; near/intents 32cd1f9
//     contracts/defuse/src/contract/garbage_collector.rs, the method live on intents.near, read 7 Nov), so this false
//     alone never says the move did not land: the balance is read with it, and a new move takes only what U holds then,
//     its earlier deadline handed to the rule (prior_ms).
//   - A held op's move (struck, or held by the bind while the move was out) is read once its deadline is past on both
//     RPCs, at a block past it, by the same rule: through, and the op is followed on as moved until its USDC binds (a
//     helper that answers sender_struck and lands the intent anyway); over, and the move is cleared. Until then the op's
//     follow does not end (followEnded, a reload resumes it) and no done op of U goes final.
//   - A refund the quote's MIN_DEPOSIT floor refuses waits under U for withdraw.open: only an op whose own refund it is
//     (its origin the asset) ends held (under_min); a stranger's dust, or what is left after a move, is left as it is.
//   - The relayer's answer: sender_struck (final for U at the helper, markets.md H4.3) holds U's ops whose money waits
//     under U inside intents.near (sender_struck; an op of U still in flight is followed on, and held the same way once
//     its own refund shows under U) and nothing more is signed for U, after a reload too (FollowRecord.intents_struck);
//     any other answer but 2xx (a refusal, no route, none) reads the move at the slow pace and asks
//     the next no sooner than MOVE_RETRY_MIN_MS, doubling to MOVE_RETRY_MAX_MS. A session's first move, and each one
//     after such an answer, is asked only once the route answers an empty body with a refusal of its own (no quote, no
//     key otherwise); a 2xx carries the next without asking.
// - Pace: 1 s while a status shows a send in flight, a credit is being bound or a carried move is out; else 15 s,
//   doubling to 60 s. A status that read REFUNDED is read again once a minute at most. Past the
//   deadline on both RPCs' block time with no send seen, expired shows and only the chain is read, slowly. 1Click's 429
//   and Retry-After hold that op's status read. A throw that is no refusal pauses and the round runs again; only the
//   signal ends a follow. No timer ever makes a stage.
// - The seed: only a bind phase, or the refund move's signature, opens it (deps.seed64, under deps.seedLock), and zeroes
//   it once the phase ends. Every wait of the bind ends the phase (bind.ts onWait), so no sleep ever runs with the seed
//   open; the next round binds again from the call written. The refund move's quote is asked with the seed shut; it
//   is opened only to sign the checked intent (refund.ts runRefundMove, openKey).
// - A held op lifted to done (its money bound later, D3b) has no waiter of its own: with deps.untilFinal U's follower
//   adopts it, so it is followed to its own final in the same session even when every other op's wait has ended.
// - The ops in the wallet store's "ops" (kit messages.ts Operation, src/state.ts op contract) hold the follow's state:
//   stage, facts, txs (the counted notes' NEAR tx hashes as heard) and under `follow` what a reload needs. U's notes are
//   the note store's. Nothing secret: no key, words, note secret or signed payload.
// Nothing here logs. The status read names the deposit address only; each chain read names U, the token or the vault.
import { DEPOSIT_REFUNDED_STAGES, type DepositFacts, type DepositStage, HELPER_FETCH_INIT, HELPER_RPC_METHODS, VAULT_CONSTANTS } from "@blindfill/kit";
import { base64 } from "@scure/base";
import { noteCommitment, type NoteRef, noteSecrets } from "../notes/secrets.ts";
import type { NoteRecord, NoteStore } from "../notes/store.ts";
import type { WalletStore } from "../store/index.ts";
import { DepositAccountRefused, depositAccount, heightSpreadOver, NEAR_NETWORKS, type NearNetwork, RPC_TIMEOUT_MS } from "./account.ts";
import { type BindDeps, bindDeposit, DepositBindRefused, type BindOutcome, type BindRpc, bindRpc, DepositsWatch, POLL_MS } from "./bind.ts";
import { depositId } from "../derive/keys.ts";
import type { MoveRecord, RefundMoveAsk, RefundMoveResult, RefundRead } from "./refund.ts";

/** The helper's 1Click proxy for status (apps/helper/src/proxy/vendors.ts: oneclick, /v0/status read upstream by GET). */
export const DEPOSIT_STATUS_URL = "https://api.confidential.unrealized.trade/v1/proxy/oneclick/v0/status";
export const DEPOSIT_STATUS_TIMEOUT_MS = 10_000;
/** A status answer is the quote and a few hashes: a few KB. */
export const DEPOSIT_STATUS_ANSWER_MAX = 65_536;

/** 1Click's statuses (OpenAPI 0.1.10 GetExecutionStatusResponse.status). */
export const ONECLICK_STATUSES = ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "INCOMPLETE_DEPOSIT", "SUCCESS", "REFUNDED", "FAILED"] as const;
export type OneClickStatus = (typeof ONECLICK_STATUSES)[number];

/** Each status's stage before the device's own reads (APU-04). SUCCESS is in transit until U's credit reads. */
export const STATUS_STAGE: Readonly<Record<OneClickStatus, DepositStage>> = Object.freeze({
  PENDING_DEPOSIT: "quote_checked",
  KNOWN_DEPOSIT_TX: "waiting",
  PROCESSING: "in_transit",
  INCOMPLETE_DEPOSIT: "short",
  SUCCESS: "in_transit",
  REFUNDED: "refunded",
  FAILED: "failed",
});

const IMPLICIT = /^[0-9a-f]{64}$/;
const DIGITS = /^(0|[1-9][0-9]*)$/;
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

/** The longest a 429's Retry-After holds the status read (the chain reads go on meanwhile). */
export const STATUS_RETRY_MAX_MS = 60_000;
/** A 429 with no readable Retry-After: the wait doubles from this, to STATUS_RETRY_MAX_MS. */
export const STATUS_RETRY_MIN_MS = 2_000;
/** A 429's wait (ms) from its Retry-After (seconds, or an HTTP date against `nowMs`), or null when it gives none. */
export function retryAfterMs(res: Response, nowMs: number): number | null {
  const v = res.headers.get("retry-after")?.trim();
  if (v === undefined || v === "") return null;
  const ms = /^[0-9]{1,9}$/.test(v) ? Number(v) * 1000 : Date.parse(v) - nowMs;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), STATUS_RETRY_MAX_MS) : null;
}
/**
 * The status read's answer: a status, with on SUCCESS what 1Click says it delivered (swapDetails.amountOut, USDC base
 * units; null when it names none), or a 429 with its wait (null: none given).
 */
export type StatusRead = { status: OneClickStatus; delivered: bigint | null } | { retry_ms: number | null };

/**
 * 1Click's status of `address` through the helper, or null when it is no read: not 200, too big, not JSON, not one of
 * the seven statuses, or an answer for another address, recipient or refund than ours (U). A 429 answers its wait.
 */
export async function readDepositStatus(address: string, u: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal, nowMs: number = Date.now()): Promise<StatusRead | null> {
  try {
    const timeout = AbortSignal.timeout(DEPOSIT_STATUS_TIMEOUT_MS);
    const res = await fetchFn(`${DEPOSIT_STATUS_URL}?depositAddress=${encodeURIComponent(address)}`, {
      ...HELPER_FETCH_INIT,
      redirect: "error",
      // the helper's proxy route is POST /v1/proxy/{vendor}/{path} for every entry (the kit's helper/v1.ts routes); a
      // GET there answers 405. The helper reads 1Click with GET (vendors.ts), with this query and no body
      method: "POST",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (res.status === 429) return { retry_ms: retryAfterMs(res, nowMs) };
    if (res.status !== 200) return null;
    const text = await capped(res, DEPOSIT_STATUS_ANSWER_MAX);
    const body: unknown = JSON.parse(text);
    if (!isObj(body) || typeof body.status !== "string" || !(ONECLICK_STATUSES as readonly string[]).includes(body.status)) return null;
    const qr = isObj(body.quoteResponse) ? body.quoteResponse : undefined;
    const quote = qr && isObj(qr.quote) ? qr.quote : undefined;
    const req = qr && isObj(qr.quoteRequest) ? qr.quoteRequest : undefined;
    if (!quote || !req || quote.depositAddress !== address || req.recipient !== u || req.refundTo !== u) return null;
    const out = isObj(body.swapDetails) ? body.swapDetails.amountOut : undefined;
    const delivered = body.status === "SUCCESS" && typeof out === "string" && DIGITS.test(out) && out.length <= 30 ? BigInt(out) : null;
    return { status: body.status as OneClickStatus, delivered };
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

async function capped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get("content-length") ?? "0") > max) throw new Error("too big");
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error("too big");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(out);
}

/** A NEAR provider that also reads a block (the kit's HELPER_RPC_METHODS.near names `block`). */
export interface FollowRpc extends BindRpc {
  block(params: { finality: "final" } | { block_id: number }): Promise<unknown>;
}
const BLOCK_METHOD = "block";
if (!(HELPER_RPC_METHODS.near as readonly string[]).includes(BLOCK_METHOD)) throw new Error(`"${BLOCK_METHOD}" is not on the kit's NEAR method list`);
/** A provider by URL for query, tx and block. */
export function followRpc(url: string, fetchFn: typeof fetch = fetch, timeoutMs = RPC_TIMEOUT_MS): FollowRpc {
  const b = bindRpc(url, fetchFn, timeoutMs);
  return {
    ...b,
    async block(params) {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "blindfill", method: BLOCK_METHOD, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    },
  };
}

/** Both RPCs' final block time is past `deadlineMs` (each read on its own; either unread: not past). */
export async function pastOnBoth(rpcs: readonly [FollowRpc, FollowRpc], deadlineMs: number): Promise<boolean> {
  const sides = await finalTimes(rpcs);
  return sides.every((ms) => ms !== null && ms > BigInt(deadlineMs));
}
async function finalTimes(rpcs: readonly [FollowRpc, FollowRpc]): Promise<(bigint | null)[]> {
  return await Promise.all(
    rpcs.map(async (r) => {
      try {
        const a = await r.block({ finality: "final" });
        const h = isObj(a) && a.error === undefined && isObj(a.result) && isObj(a.result.header) ? a.result.header : undefined;
        const ns = h?.timestamp_nanosec;
        return typeof ns === "string" && DIGITS.test(ns) ? BigInt(ns) / 1_000_000n : null;
      } catch {
        return null;
      }
    }),
  );
}
const resultAt = (a: unknown, at?: number): Obj | undefined => {
  const r = isObj(a) && a.error === undefined ? a.result : undefined;
  if (!isObj(r) || r.error !== undefined) return undefined;
  const h = r.block_height;
  if (typeof h !== "number" || !Number.isSafeInteger(h) || h <= 0 || (at !== undefined && h !== at)) return undefined;
  return r;
};
type View = { contract: string; method: string; args: Obj };
async function viewAmount(r: BindRpc, v: View, block: { finality: "final" } | { block_id: number }): Promise<{ balance: bigint; height: number } | null> {
  try {
    const args = base64.encode(new TextEncoder().encode(JSON.stringify(v.args)));
    const res = resultAt(await r.query({ request_type: "call_function", account_id: v.contract, method_name: v.method, args_base64: args, ...block }), "block_id" in block ? block.block_id : undefined);
    const bytes = res?.result;
    if (res === undefined || !Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return null;
    const out: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes)));
    return typeof out === "string" && DIGITS.test(out) ? { balance: BigInt(out), height: res.block_height as number } : null;
  } catch {
    return null;
  }
}
/**
 * One amount at one final block on both RPCs: each RPC's final read, their heights within HEIGHT_SPREAD_MAX (account.ts
 * heightSpreadOver: a provider naming an old block as final picks no block), then both read at the lower height (an
 * answer at another block is no read), equal; else null.
 */
async function readAtOne(v: View, rpcs: readonly [BindRpc, BindRpc]): Promise<bigint | null> {
  const finals = await Promise.all(rpcs.map((r) => viewAmount(r, v, { finality: "final" })));
  if (finals.some((f) => f === null)) return null;
  const heights = finals.map((f) => f!.height);
  if (heightSpreadOver(heights) !== null) return null;
  const at = Math.min(...heights);
  const [a, b] = await Promise.all(rpcs.map((r) => viewAmount(r, v, { block_id: at })));
  return a && b && a.balance === b.balance ? a.balance : null;
}
/** U's USDC (the token's ft_balance_of) at one final block on both RPCs, or null. */
export const readCredit = (account: string, token: string, rpcs: readonly [BindRpc, BindRpc]): Promise<bigint | null> =>
  readAtOne({ contract: token, method: "ft_balance_of", args: { account_id: account } }, rpcs);

/** A block's height and time (ns) as one RPC answers it (`block` by finality or height), or null. */
async function blockAt(r: FollowRpc, params: { finality: "final" } | { block_id: number }): Promise<{ height: number; timeNs: bigint } | null> {
  try {
    const a = await r.block(params);
    const h = isObj(a) && a.error === undefined && isObj(a.result) && isObj(a.result.header) ? a.result.header : undefined;
    const ns = h?.timestamp_nanosec, height = h?.height;
    if (typeof ns !== "string" || !DIGITS.test(ns) || typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0) return null;
    if ("block_id" in params && height !== params.block_id) return null;
    return { height, timeNs: BigInt(ns) };
  } catch {
    return null;
  }
}
/** A view's JSON answer at `block_id` on one RPC (an answer at another block is no read), or undefined. */
async function viewJsonAt(r: BindRpc, contract: string, method: string, args: Obj, at: number): Promise<unknown> {
  try {
    const res = resultAt(await r.query({ request_type: "call_function", account_id: contract, method_name: method, args_base64: base64.encode(new TextEncoder().encode(JSON.stringify(args))), block_id: at }), at);
    const bytes = res?.result;
    if (res === undefined || !Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return undefined;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes)));
  } catch {
    return undefined;
  }
}
/** What a refund move needs read, all at one block on both RPCs. */
export interface MoveRead {
  height: number;
  /** The block's time, unix ms, and each RPC's reads as the rule takes them (refund.ts RefundRead). */
  timeMs: number;
  reads: readonly [RefundRead, RefundRead];
  held: bigint;
  /** is_nonce_used of the move's nonce, or null when no nonce was asked. */
  used: boolean | null;
  /** intents.near's current salt (8 hex). */
  salt: string;
}
/**
 * The refund move's reads at one block on both RPCs (finding 5 of the deposit-follow review: never each at its own
 * RPC's latest final): each RPC's final block, their heights within HEIGHT_SPREAD_MAX, then at the lower height on both
 * the block's time, what `account` holds of `tokenId`, intents.near's current salt and, given a nonce, is_nonce_used;
 * every pair equal, else null.
 */
export async function readMoveAt(intents: string, account: string, nonce: string | null, tokenId: string, rpcs: readonly [FollowRpc, FollowRpc]): Promise<MoveRead | null> {
  const finals = await Promise.all(rpcs.map((r) => blockAt(r, { finality: "final" })));
  if (finals.some((f) => f === null)) return null;
  const heights = finals.map((f) => f!.height);
  if (heightSpreadOver(heights) !== null) return null;
  const at = Math.min(...heights);
  const sides = await Promise.all(
    rpcs.map(async (r) => {
      const [b, held, salt, used] = await Promise.all([
        blockAt(r, { block_id: at }),
        viewJsonAt(r, intents, "mt_balance_of", { account_id: account, token_id: tokenId }, at),
        viewJsonAt(r, intents, "current_salt", {}, at),
        nonce === null ? Promise.resolve(null) : viewJsonAt(r, intents, "is_nonce_used", { account_id: account, nonce }, at),
      ]);
      if (b === null || typeof held !== "string" || !DIGITS.test(held) || typeof salt !== "string" || !/^[0-9a-f]{8}$/.test(salt)) return null;
      if (nonce !== null && typeof used !== "boolean") return null;
      return { timeNs: b.timeNs, held: BigInt(held), salt, used: used as boolean | null };
    }),
  );
  const [a, b] = sides;
  if (a == null || b == null || a.timeNs !== b.timeNs || a.held !== b.held || a.salt !== b.salt || a.used !== b.used) return null;
  return { height: at, timeMs: Number(a.timeNs / 1_000_000n), reads: [{ blockTimeNs: a.timeNs, held: a.held }, { blockTimeNs: b.timeNs, held: b.held }], held: a.held, used: a.used, salt: a.salt };
}

/** Where 1Click's refunds land (refundType INTENTS, deposit/quote.ts): the intents contract of each network; none on testnet. */
export const INTENTS_CONTRACT: Readonly<Record<NearNetwork, string | null>> = Object.freeze({ mainnet: "intents.near", testnet: null });

/** The deposit op's fields (op.follow): plain values, nothing secret. */
export interface FollowRecord {
  network: NearNetwork;
  /** U = U_{s,i}: s as a decimal string; U's public id (the deposit record's id, checked against the seed before a bind). */
  s: string;
  i: number;
  u: string;
  /** The checked quote's deposit address, its signed deadline (unix ms), its origin asset (a 1Click asset id: what a refund
   * lands as, under U inside intents.near) and its min_amount_out in USDC base units. */
  address: string;
  deadline_ms: number;
  origin: string;
  min_out: string;
  /** 1Click's status of this address has shown a send (any status past PENDING_DEPOSIT). */
  sent?: boolean;
  /** 1Click's status of this address as last read (one of its seven). */
  status?: OneClickStatus;
  /** On 1Click's SUCCESS: what it says it delivered (USDC base units; "0" when it names none). */
  delivered?: string;
  /** Once done: the ids of U's notes landed by then (their tx hashes in the op's txs), and the USDC shown as its own. */
  notes?: string[];
  bound?: string;
  /**
   * The refund move out (wallet.md §2.4 point 8), recorded before it is sent: its intent's nonce (base64, 32 bytes),
   * deadline (unix ms, from block time), asset and amount. A new one is signed only once this one is through or over.
   */
  move?: MoveRecord;
  /** The deadline (unix ms) of a move that is over unlanded: the next move's rule is handed it. */
  prior_ms?: number;
  /** The block of the read that found the last move through or over: a later refund read below it is no read. */
  prior_height?: number;
  /** The helper's intents route answered sender_struck for U (final for U there, markets.md H4.3): nothing more is
   *  signed for U, after a reload too. Its own field: bind.ts's sender_struck is another endpoint's. */
  intents_struck?: true;
  /** A refund move of this op's money is through: its own debit read at one block on both RPCs. */
  moved?: true;
  /** A refund move of this op's money went over unlanded (its nonce unused past its deadline). */
  unlanded?: true;
  /** Done, and the quote's deadline is past on both RPCs: no send to its address can come any more (deps.untilFinal). */
  final?: true;
  /** Why the op is held. */
  why?: string;
}
export type DepositOp = { kind: "deposit"; stage: DepositStage; txs: { chain: "near"; hash: string }[]; created_ms: number; follow: FollowRecord } & DepositFacts;

export interface FollowArgs extends Pick<FollowRecord, "network" | "i" | "u" | "address" | "deadline_ms" | "origin" | "min_out"> {
  /** The op's id: the deposit.quote request's id. */
  opId: string;
  s: bigint;
}

export type FollowOutcome =
  /** 1Click's SUCCESS for this op, and U's notes it counts cover what it delivered and min_out, each read on both RPCs. */
  | { kind: "done"; note: NoteRecord }
  /** The bind stopped (struck, refused, a refusal of the bind, a note the pages do not hold): the money waits under U. */
  | { kind: "held"; why: string };

export interface FollowDeps {
  /** The wallet store whose "ops" holds the ops (src/state.ts op contract). */
  ops: Pick<WalletStore, "get" | "update" | "keys">;
  store: NoteStore;
  rpcs: readonly [FollowRpc, FollowRpc];
  /** Opens the seed for a bind phase only: a fresh copy each call, which the follow zeroes once that phase ends. */
  seed64: () => Promise<Uint8Array>;
  /** Runs a bind phase while the seed is open (SIGN_HOST: the wallet's seed lock, shared); the phase itself unless given. */
  seedLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  pollMs?: number;
  /** Each stage as written, with its facts and its op (SIGN_HOST posts it as deposit.confirm's progress). */
  onStage?: (stage: DepositStage, facts: DepositFacts, opId: string) => void;
  /** bind.ts's bindDeposit unless given (tests); the release relayer account for its tx reads. */
  bind?: typeof bindDeposit;
  relayerAccount?: string | null;
  /** INTENTS_CONTRACT of the network unless given (tests). */
  intents?: string | null;
  /** The refund move (wallet.md §2.4 point 8, refund.ts runRefundMove with SIGN_HOST's rules): moves what U holds of
   * `ask.asset` inside intents.near on into the vault's asset to U on the token. It calls `ask.record` before it sends,
   * and opens U's key only through `ask.openKey`. */
  refundMove?: (ask: FollowMoveAsk, signal?: AbortSignal) => Promise<RefundMoveResult>;
  /** Resolve a done op only once its quote's deadline is past on both RPCs, U followed till then (SIGN_HOST); else at done. */
  untilFinal?: boolean;
  now?: () => number;
}

/** What the follow hands deps.refundMove: the move's reads, U's key behind the seed lock, and the record. */
export interface FollowMoveAsk extends RefundMoveAsk {
  openKey<T>(fn: (secretKey: Uint8Array) => T): Promise<T>;
  record(m: MoveRecord): Promise<void>;
}

/** An op no follow reads again: held with no move out (L3: a held op's move is read on to through or over), or done past
 *  its quote's deadline (FollowRecord.final). */
export const followEnded = (op: Pick<DepositOp, "stage" | "follow">): boolean => (op.stage === "held" && op.follow.move === undefined) || (op.stage === "done" && op.follow.final === true);

export class DepositFollowRefused extends Error {
  constructor(detail: string) {
    super(`deposit follow refused: ${detail}`);
    this.name = "DepositFollowRefused";
  }
}

// How far a status read has come: a stale answer (a proxy's cache, a lagging 1Click replica) never takes it back.
const RANK: Partial<Record<DepositStage, number>> = { quote_checked: 0, expired: 0, waiting: 1, in_transit: 2, failed: 2, short: 2 };
const FACT_KEYS = ["refunded", "hold", "held_id", "since_ms", "amount_usd"] as const;
const FOLLOW_KEYS = ["network", "s", "i", "u", "address", "deadline_ms", "origin", "min_out"] as const;
const ENDS: ReadonlySet<DepositStage> = new Set(["done", "held"]);
// The bind's waits on a halt (bind.ts onWait): USDC halted on U's read, the relayer's token_halted or relayer_low.
const HALTS = new Set(["halted", "token_halted", "relayer_low"]);
/** The rounds' pace with nothing in flight: from 15 s, doubling, to 60 s. */
export const SLOW_MS = 15_000;
export const SLOW_MAX_MS = 60_000;
/** After the relayer refuses a move (any answer but 2xx, sender_struck aside), the next is asked no sooner than this,
 *  doubled per refusal up to MOVE_RETRY_MAX_MS; each one asks the route first (runRefundMove probe). */
export const MOVE_RETRY_MIN_MS = 120_000;
export const MOVE_RETRY_MAX_MS = 30 * 60_000;
/** The USDC base units as a decimal string (6 decimals), trailing zeros dropped. */
export function usdOf(units: bigint): string {
  const s = units.toString().padStart(7, "0");
  const frac = s.slice(-6).replace(/0+$/, "");
  return frac === "" ? s.slice(0, -6) : `${s.slice(0, -6)}.${frac}`;
}
/** The inverse of usdOf: a decimal USDC string (deposit.quote's min_amount_out) in base units, or null when it is not one. */
export function usdcUnits(dec: string): bigint | null {
  const m = /^(0|[1-9][0-9]{0,30})(?:\.([0-9]{1,6}))?$/.exec(dec);
  return m === null ? null : BigInt(m[1]! + (m[2] ?? "").padEnd(6, "0"));
}
// A bind phase that stops on a wait that is not a halt (bind.ts onWait): the next round reads the chain and binds again.
class BindPaused extends Error {}

// ---------- one follower per U (and per ops store): every op of U attaches to it ----------
type Waiter = { opId: string; ok: (o: FollowOutcome) => void; fail: (e: unknown) => void };
type Runner = { waiters: Set<Waiter>; ctl: AbortController; done: Promise<void> };
const runners = new WeakMap<object, Map<string, Runner>>();

/**
 * Follows deposit op `args.opId`: writes it when the store has none, attaches it to U's one follower (started if none
 * runs) and resolves once the op is done or held. deps.signal stops this op's wait; U's follower stops once no op waits.
 */
export async function followDeposit(args: FollowArgs, deps: FollowDeps): Promise<FollowOutcome> {
  if (typeof args.network !== "string" || !Object.hasOwn(NEAR_NETWORKS, args.network)) throw new DepositFollowRefused(`unknown network ${String(args.network)}`);
  if (NEAR_NETWORKS[args.network].vault === null) throw new DepositFollowRefused(`the release names no vault on ${args.network}`);
  if (typeof args.address !== "string" || args.address === "" || !Number.isSafeInteger(args.deadline_ms) || typeof args.opId !== "string" || args.opId === "")
    throw new DepositFollowRefused("an op id, a deposit address and its signed deadline are needed");
  if (typeof args.u !== "string" || !IMPLICIT.test(args.u)) throw new DepositFollowRefused("U is not an implicit id");
  if (typeof args.origin !== "string" || args.origin === "" || typeof args.min_out !== "string" || !DIGITS.test(args.min_out) || BigInt(args.min_out) < VAULT_CONSTANTS.MIN_DEPOSIT)
    throw new DepositFollowRefused("the quote's origin asset and a min_amount_out of MIN_DEPOSIT or more are needed");
  const now = deps.now ?? Date.now;
  const fresh: FollowRecord = { network: args.network, s: args.s.toString(), i: args.i, u: args.u, address: args.address, deadline_ms: args.deadline_ms, origin: args.origin, min_out: args.min_out };
  await deps.ops.update("ops", args.opId, (v) => (v === undefined ? { kind: "deposit", stage: "quote_checked", txs: [], created_ms: now(), follow: fresh } : undefined));
  const op = (await deps.ops.get("ops", args.opId)) as DepositOp | undefined;
  if (!isObj(op) || op.kind !== "deposit" || !isObj(op.follow)) throw new DepositFollowRefused("the op is not a deposit op");
  if (FOLLOW_KEYS.some((k) => op.follow[k] !== fresh[k])) throw new DepositFollowRefused("the op names another deposit");
  const ended = await outcomeOf(op, deps.store);
  if (ended !== null && (ended.kind === "held" || !deps.untilFinal || op.follow.final === true)) return ended;
  deps.signal?.throwIfAborted();

  let byU = runners.get(deps.ops);
  if (byU === undefined) runners.set(deps.ops, (byU = new Map()));
  const key = `${args.network}/${args.u}`;
  return await new Promise<FollowOutcome>((ok, fail) => {
    let r = byU.get(key);
    if (r === undefined || r.ctl.signal.aborted) {
      const ctl = new AbortController();
      const waiters = new Set<Waiter>();
      r = { waiters, ctl, done: Promise.resolve() };
      const run = r;
      // r4: an op lifted from held to done has no waiter of its own; U's follower adopts it, so it is followed to its
      // own final in this session (a waiter that only leaves)
      const adopt = (opId: string) => {
        if ([...run.waiters].some((x) => x.opId === opId)) return;
        const own: Waiter = { opId, ok: () => {}, fail: () => {} };
        const leave = () => {
          run.waiters.delete(own);
          if (run.waiters.size === 0) run.ctl.abort(new Error("no op waits"));
        };
        own.ok = leave;
        own.fail = leave;
        run.waiters.add(own);
        deps.signal?.addEventListener("abort", leave, { once: true });
      };
      run.done = followU(args, deps, ctl.signal, waiters, adopt).then(
        () => {},
        (e) => {
          for (const w of waiters) w.fail(e);
          waiters.clear();
        },
      ).finally(() => {
        if (byU.get(key) === run) byU.delete(key);
      });
      byU.set(key, run);
    }
    const run = r;
    const w: Waiter = { opId: args.opId, ok, fail };
    const leave = () => {
      run.waiters.delete(w);
      if (run.waiters.size === 0) run.ctl.abort(new Error("no op waits"));
    };
    w.ok = (o) => (leave(), ok(o));
    w.fail = (e) => (leave(), fail(e));
    run.waiters.add(w);
    deps.signal?.addEventListener("abort", () => w.fail(deps.signal!.reason), { once: true });
  });
}

async function outcomeOf(op: DepositOp, store: NoteStore): Promise<FollowOutcome | null> {
  // a held op with a move out is followed on until that move is read through or over (L3)
  if (op.stage === "held") return op.follow.move === undefined ? { kind: "held", why: op.follow.why ?? "held" } : null;
  if (op.stage !== "done") return null;
  const id = op.follow.notes?.at(-1);
  const note = id === undefined ? undefined : await store.get(id);
  if (note === undefined) throw new DepositFollowRefused("the op says done but its note is not in the store");
  return { kind: "done", note };
}

// U's follower: rounds of chain reads, binds, counts, refunds and status reads over every op of U, until no op waits.
// A throw that is no refusal pauses and the round runs again; only the signal ends it.
async function followU(first: FollowArgs, deps: FollowDeps, signal: AbortSignal, waiters: Set<Waiter>, adopt: (opId: string) => void): Promise<void> {
  const { ops, store, rpcs } = deps;
  const U = first.u;
  const network = first.network;
  const s = first.s;
  const i = first.i;
  const vault = NEAR_NETWORKS[network].vault!;
  const token = NEAR_NETWORKS[network].usdc;
  const usdcId = `nep141:${token}`;
  const fetchFn = deps.fetchFn ?? fetch;
  const pollMs = deps.pollMs ?? POLL_MS;
  const sleep0 = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const sleep = async (ms: number) => {
    signal.throwIfAborted();
    let off = () => {};
    try {
      await Promise.race([sleep0(ms), new Promise<void>((_, no) => {
        const f = () => no(signal.reason);
        signal.addEventListener("abort", f, { once: true });
        off = () => signal.removeEventListener("abort", f);
      })]);
    } finally {
      off();
    }
    signal.throwIfAborted();
  };
  const now = deps.now ?? Date.now;
  const bind = deps.bind ?? bindDeposit;
  const seedLock = deps.seedLock ?? (<T>(fn: () => Promise<T>) => fn());
  const intents = deps.intents === undefined ? INTENTS_CONTRACT[network] : deps.intents;

  // ---------- the ops of U ----------
  const opsOfU = async (): Promise<[string, DepositOp][]> => {
    const out: [string, DepositOp][] = [];
    for (const k of await ops.keys("ops")) {
      const v = (await ops.get("ops", k).catch(() => undefined)) as DepositOp | undefined;
      if (isObj(v) && v.kind === "deposit" && isObj(v.follow) && v.follow.u === U && v.follow.network === network && v.follow.s === s.toString() && v.follow.i === i) out.push([k, v]);
    }
    return out.sort(([ka, a], [kb, b]) => a.created_ms - b.created_ms || (ka < kb ? -1 : 1));
  };
  // Writes op `id`'s stage and facts (only the facts that stage carries, kit messages.ts DepositFacts), follow fields
  // (an undefined one is dropped) and tx hashes. The same again is no write.
  const write = async (id: string, stage: DepositStage, facts: DepositFacts, follow?: Partial<FollowRecord>, txs: string[] = []): Promise<DepositOp> => {
    const cur = (await ops.get("ops", id)) as DepositOp;
    const f: Record<string, unknown> = { ...cur.follow, ...follow };
    for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
    const had = cur.txs ?? [];
    const next: Record<string, unknown> = { kind: "deposit", stage, txs: [...had, ...[...new Set(txs)].filter((h) => !had.some((t) => t.hash === h)).map((hash) => ({ chain: "near", hash }))], created_ms: cur.created_ms, follow: f };
    for (const k of FACT_KEYS) if (facts[k] !== undefined) next[k] = facts[k];
    if (JSON.stringify(next) === JSON.stringify({ ...cur, follow: { ...cur.follow }, txs: had })) return cur;
    const out = (await ops.update("ops", id, () => next)) as DepositOp | undefined;
    if (out === undefined) throw new DepositFollowRefused("the op could not be written");
    if (cur.stage !== stage || FACT_KEYS.some((k) => cur[k] !== out[k])) deps.onStage?.(stage, facts, id);
    return out;
  };
  // each fact only on the stages it belongs to (kit schema.ts depositFactsFit)
  const legFacts = (op: DepositOp, stage: DepositStage, refundedNow = false): DepositFacts => {
    const out: { -readonly [K in keyof DepositFacts]: DepositFacts[K] } = { since_ms: op.since_ms ?? now() };
    if ((refundedNow || op.refunded === true || op.stage === "refunded") && DEPOSIT_REFUNDED_STAGES.includes(stage)) out.refunded = true;
    if (stage === "refunded" || stage === "refund_move" || stage === "held" || stage === "halted") out.held_id = U;
    if (stage === "halted") out.hold = "halted";
    return out;
  };
  const factsOf = (op: DepositOp): DepositFacts => {
    const out: Record<string, unknown> = {};
    for (const k of FACT_KEYS) if (op[k] !== undefined) out[k] = op[k];
    return out as DepositFacts;
  };
  const holdAll = async (why: string): Promise<void> => {
    for (const [id, op] of await opsOfU()) if (!ENDS.has(op.stage)) await write(id, "held", legFacts(op, "held"), { why });
  };

  // ---------- U's notes: -1 its deposit note, n its n-th second arrival ----------
  const refOf = (n: number): NoteRef => (n < 0 ? { kind: "deposit", s, i } : { kind: "second", id: { id: "U", s, i }, n });
  const key = (r: NoteRef) => JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  const notesOfU = async (): Promise<{ n: number; note: NoteRecord }[]> => {
    const all = await store.list();
    const out: { n: number; note: NoteRecord }[] = [];
    for (let n = -1; ; n++) {
      const note = all.find((x) => key(x.ref) === key(refOf(n)));
      if (note === undefined) break;
      out.push({ n, note });
    }
    return out;
  };
  // The pages on both RPCs at the note's leaf: ours (U the depositor), theirs (a front-run on P), mismatch (the pages do
  // not hold the leaf the store holds), or unsure (one RPC behind).
  const pagesOf = async (note: NoteRecord): Promise<{ state: "ours" | "theirs"; value: bigint } | { state: "mismatch" | "unsure" }> => {
    const leaf = note.leaf!;
    const r = await new DepositsWatch(vault, note.precommitment, rpcs, { ...(await store.syncCursor(vault)), deposits: note.searchFrom ?? 0 }).read(signal);
    if (r.state === "unsure") return { state: "unsure" };
    if (r.state === "absent") return { state: "mismatch" };
    if (leaf.leafIndex !== r.row.leafIndex || leaf.value !== r.row.value || leaf.commitment !== noteCommitment(r.row.value, r.row.label, note.precommitment)) return { state: "mismatch" };
    return { state: r.row.depositor === U ? "ours" : "theirs", value: r.row.value };
  };

  // U not created yet (the bind's not_created wait): the helper creates U on a status read of SUCCESS once the delivery
  // is final (card helper-create-u), so the op's status is read again each round until U exists
  let uMissing = false;

  // ---------- the refund move's signature: U's key open for `fn` only, under deps.seedLock, then zeroed ----------
  const openKey = <T,>(fn: (secretKey: Uint8Array) => T): Promise<T> =>
    seedLock(async () => {
      const seed = await deps.seed64();
      try {
        if (!(seed instanceof Uint8Array) || seed.length !== 64) throw new DepositFollowRefused("seed64 must be 64 bytes");
        const k = depositId(seed, s, i);
        try {
          if (k.id !== U) throw new DepositFollowRefused("the seed's U_{s,i} is not the op's U");
          return fn(k.secretKey);
        } finally {
          k.secretKey.fill(0);
        }
      } finally {
        seed.fill(0);
      }
    });
  // assets whose balance under U the quote's MIN_DEPOSIT floor refused, at that balance: not asked again until it moves
  const underMin = new Set<string>();
  // the relayer's answers this session: struck (sender_struck, final for U here: nothing more is signed for U, U's ops
  // inside intents.near held for the way out); down (no move carried yet this session, or the last one refused or not
  // carried: no 1 Hz reads on it, the next asked after moveAt, the route asked first)
  let struck = false;
  let relayDown = true;
  // the highest block a refund read rested on this session: a read below it is no read (L2)
  let readFloor = 0;
  let moveWait = 0;
  let moveAt = 0;

  // ---------- a bind phase: the seed open (under deps.seedLock), U's next note bound at U's credit ----------
  const bindPhase = async (amount: bigint): Promise<"bound" | "paused" | "held"> => {
    for (const [id, op] of await opsOfU())
      // an op whose refund reads under U inside intents stays refunded: the USDC bound is not its money until it is moved
      if (!ENDS.has(op.stage) && op.stage !== "halted" && ((op.follow.sent && op.stage !== "refunded") || op.follow.move || op.follow.moved)) await write(id, "into_vault", legFacts(op, "into_vault"));
    let halted = false;
    let out: BindOutcome | "paused";
    try {
      out = await seedLock(async () => {
        const seed = await deps.seed64();
        try {
          if (!(seed instanceof Uint8Array) || seed.length !== 64) throw new DepositFollowRefused("seed64 must be 64 bytes");
          if (depositAccount(seed, s, i).account !== U) throw new DepositFollowRefused("the seed's U_{s,i} is not the op's U");
          // U's lowest note not landed (PLANNED, or INCOMING with its call out: bind.ts settles that call first), else a new arrival
          const mine = await notesOfU();
          if (mine.length === 0) throw new DepositFollowRefused("U's deposit note is not in the store");
          let note = mine.find((x) => x.note.leaf === undefined)?.note;
          if (note === undefined) {
            const ref = refOf(mine.at(-1)!.n + 1);
            note = await store.add({ ref, scope: mine[0]!.note.scope, precommitment: noteSecrets(seed, ref).precommitment, state: "PLANNED" });
          }
          const bindDeps: BindDeps = {
            store, rpcs, fetchFn, sleep, pollMs, signal,
            ...(deps.relayerAccount !== undefined ? { relayerAccount: deps.relayerAccount } : {}),
            // every wait of the bind ends the phase, so the seed is never open across a sleep; the next round binds
            // again, from the call written (bind.ts). A halt shows halted first, kept until a phase sees no halt.
            onWait: async (code) => {
              uMissing = code === "not_created";
              if (HALTS.has(code)) {
                halted = true;
                for (const [id, op] of await opsOfU()) if (!ENDS.has(op.stage) && op.stage === "into_vault") await write(id, "halted", legFacts(op, "halted"));
              }
              throw new BindPaused(code);
            },
          };
          return await bind(seed, { network, s, i, noteId: note.id, amount }, bindDeps);
        } finally {
          seed.fill(0);
        }
      });
    } catch (e) {
      signal.throwIfAborted();
      if (e instanceof BindPaused) out = "paused";
      // the bind's refusals hold U's ops (USDC's code hash moved, the note holds another leaf, the seed is not U's)
      else if (e instanceof DepositFollowRefused || e instanceof DepositAccountRefused || e instanceof DepositBindRefused) {
        await holdAll(e instanceof DepositFollowRefused ? "refused" : e.code);
        return "held";
      } else throw e;
    }
    // halted clears when a phase sees no halt
    if (!halted) for (const [id, op] of await opsOfU()) if (op.stage === "halted") await write(id, "into_vault", legFacts(op, "into_vault"));
    if (out === "paused") return "paused";
    uMissing = false;
    if (out.kind === "struck" || out.kind === "refused") {
      await holdAll(out.kind === "struck" ? "sender_struck" : out.code);
      return "held";
    }
    return "bound";
  };

  // ---------- the count: U's money as one sum, never split between its ops ----------
  // U's landed notes, each read once on both RPCs: ours (U the depositor, its value) or a front-run on P (theirs)
  const ours = new Map<string, bigint>();
  const theirs = new Set<string>();
  // what an op needs of U's sum: the checked min_amount_out once its own status read SUCCESS; MIN_DEPOSIT once its
  // refund move is through (its money back under U as USDC); nothing before either
  const needOf = (op: DepositOp): bigint | null => (op.follow.delivered !== undefined ? BigInt(op.follow.min_out) : op.follow.moved ? VAULT_CONSTANTS.MIN_DEPOSIT : null);
  const count = async (): Promise<{ held: boolean; unsure: boolean; free: boolean }> => {
    let unsure = false;
    for (const { note } of await notesOfU()) {
      if (note.leaf === undefined || ours.has(note.id) || theirs.has(note.id)) continue;
      // landed: the pages hold its leaf, whatever its state now (UNSPENT, or HELD and SPENT once a withdraw began)
      const p = await pagesOf(note);
      if (p.state === "mismatch") {
        await holdAll("leaf");
        return { held: true, unsure, free: false };
      }
      if (p.state === "unsure") unsure = true;
      else if (p.state === "ours") ours.set(note.id, p.value);
      else theirs.add(note.id);
    }
    const total = [...ours.values()].reduce((a, b) => a + b, 0n);
    const all = await opsOfU();
    // the ops in U's sum: every op not held whose need is known; then each held one whose own status read SUCCESS (or
    // whose refund came back), oldest first, once U's sum covers it on top of those: it is no longer held and counts
    // like any other. A held op whose money never bound never stands in another op's way.
    const base = all.filter(([, op]) => op.stage !== "held" && needOf(op) !== null);
    let need = base.reduce((a, [, op]) => a + needOf(op)!, 0n);
    const lifted = new Set<string>();
    if (total >= need)
      for (const [id, op] of all) if (op.stage === "held" && needOf(op) !== null && total >= need + needOf(op)!) (lifted.add(id), (need += needOf(op)!));
    const paid = all.filter(([id]) => lifted.has(id) || base.some(([b]) => b === id));
    // an op is done once its own status read SUCCESS (or its refund came back) and U's bound sum covers every such op's
    // need: a gift only adds to the sum, a status alone binds nothing. The sum shown per op, oldest first: what 1Click
    // says it delivered (at least its min) while the later ones keep their min, the last one the rest; shown again as
    // U's sum grows (a late delivery, an older quote's late send), never under an op's min.
    if (paid.length > 0 && total >= need) {
      const notes = [...ours.keys()];
      const txs = (await Promise.all(notes.map(async (nid) => (await store.get(nid))?.calls ?? []))).flat().flatMap((c) => c.tx_hashes);
      let rest = total;
      for (const [k, [id, op]] of paid.entries()) {
        const later = paid.slice(k + 1).reduce((a, [, o]) => a + needOf(o)!, 0n);
        const own = needOf(op)!;
        const want = op.follow.delivered !== undefined && BigInt(op.follow.delivered) > own ? BigInt(op.follow.delivered) : own;
        const take = k === paid.length - 1 ? rest : want < rest - later ? want : rest - later;
        rest -= take;
        await write(id, "done", { ...(op.refunded ? { refunded: true } : {}), since_ms: op.since_ms ?? now(), amount_usd: usdOf(take) }, { notes, bound: take.toString(), why: undefined }, txs);
      }
    }
    return { held: false, unsure, free: total > need };
  };

  // ---------- one round ----------
  const statusAt = new Map<string, number>();
  const backoff = new Map<string, number>();
  const round = async (): Promise<boolean> => {
    let fast = false;
    // every op held, none with a move out (L3: a held op's move is read on to through or over)
    if ((await opsOfU()).every(([, op]) => op.stage === "held" && op.follow.move === undefined)) return false;
    // the chain first: U's own USDC; MIN_DEPOSIT or more is bound as U's next note
    const c = await readCredit(U, token, rpcs);
    // a note whose call is out (INCOMING, a call written) is settled each round even with U's USDC gone (the call took
    // it), at the amount that call was signed from: each bind phase ends at its first wait (bindPhase onWait)
    const out = (await notesOfU()).find(({ note }) => note.leaf === undefined && note.state === "INCOMING" && (note.calls?.length ?? 0) > 0)?.note;
    const amount = out !== undefined ? out.calls!.at(-1)!.balance : c;
    if (amount !== null && amount >= VAULT_CONSTANTS.MIN_DEPOSIT) {
      const r = await bindPhase(amount);
      if (r === "held") return false;
      fast = true;
    }
    const counted = await count();
    if (counted.held) return false;
    if (counted.unsure) fast = true;
    // a done op is followed until its quote's deadline is past on both RPCs: a send to it after that cannot come. It is
    // marked final only on a round with nothing left to bind: U's USDC read on both RPCs under MIN_DEPOSIT, no note with
    // its call out, every landed note read on both (a credit or a call still out is bound first)
    // (and, after the refund moves below, no move out and nothing under U inside intents.near a move could take)
    const idle = out === undefined && c !== null && c < VAULT_CONSTANTS.MIN_DEPOSIT && !counted.unsure;
    let movable = false;
    // what U holds inside intents.near, for the ops whose own status read REFUNDED: their origin assets and NEAR USDC
    // (1Click refunds there, refundType INTENTS). refunded is a stage, no end: U's USDC is still bound each round
    if (intents !== null) {
      const all = await opsOfU();
      // the strike is kept in the store: a reload signs nothing more for U either (L1)
      if (all.some(([, op]) => op.follow.intents_struck === true)) struck = true;
      // a read below a move's own block, the block that found the last move through or over, or this session's highest: no read
      const floor = Math.max(readFloor, ...all.map(([, op]) => Math.max(op.follow.move?.height ?? 0, op.follow.prior_height ?? 0)));
      const readAt = async (nonce: string | null, asset: string): Promise<MoveRead | null> => {
        const r = await readMoveAt(intents, U, nonce, asset, rpcs);
        if (r === null || r.height < floor) return null;
        readFloor = Math.max(readFloor, r.height);
        return r;
      };
      // L3: a held op's move (struck, or held by the bind while it was out) is read once its deadline is past on both
      // RPCs, at a block past it, by the rule below: through (its nonce used, or pruned with U short of it and no other
      // debit seen), and its op is followed on as moved until its USDC binds; else over, and the move is cleared
      for (const [id, op] of all) {
        const m = op.follow.move;
        if (op.stage !== "held" || m === undefined || !(await pastOnBoth(rpcs, m.deadline_ms))) continue;
        const at = await readAt(m.nonce, m.asset);
        if (at === null || at.used === null || at.timeMs <= m.deadline_ms) continue;
        if (at.used || (at.held < BigInt(m.amount) && m.foreign !== true)) {
          const its = op.follow.origin === m.asset && !op.follow.moved;
          await write(id, its ? "in_transit" : "held", its ? legFacts(op, "in_transit", true) : factsOf(op), { move: undefined, prior_ms: undefined, prior_height: at.height, ...(its ? { moved: true as const, why: undefined } : {}) });
        } else await write(id, "held", factsOf(op), { move: undefined, prior_ms: m.deadline_ms, prior_height: at.height });
      }
      // every such op still followed, its money moved or not: what U holds after a move (dust, a second refund) is
      // moved by a new one (D1); `open` are the ones whose own money is still under U inside intents.near
      const back = (await opsOfU()).filter(([, op]) => op.follow.status === "REFUNDED" && op.stage !== "held" && op.follow.final !== true && (op.stage !== "done" || deps.untilFinal === true));
      const open = back.filter(([, op]) => !op.follow.moved && op.stage !== "done");
      // `follow`'s fields on every op of `back`; `mine`'s fields on each one whose origin is the move's asset (on every one
      // when no asset is named); the stage only on such an op not yet moved or done (L1: each op on its own debit)
      const mark = async (stage: DepositStage | null, follow: Partial<FollowRecord>, asset: string | null = null, mine: Partial<FollowRecord> = {}) => {
        for (const [id] of back) {
          const op = (await ops.get("ops", id)) as DepositOp;
          const its = asset === null || op.follow.origin === asset;
          const own = stage !== null && its && !op.follow.moved && op.stage !== "done";
          await write(id, own ? stage : op.stage, own ? legFacts(op, stage, stage !== "refunded") : factsOf(op), its ? { ...follow, ...mine } : follow);
        }
      };
      if (back.length > 0) {
        const move = back.find(([, op]) => op.follow.move !== undefined)?.[1].follow.move;
        if (move !== undefined) {
          // read each round while the relayer carries it; at the slow pace once it refused (a send already out may still land)
          if (!relayDown) fast = true;
          // the move's state at one block on both RPCs: is_nonce_used, the block's time and what U holds of its asset
          const at = await readAt(move.nonce, move.asset);
          const short = at !== null && at.held < BigInt(move.amount);
          if (at !== null && at.used === true) {
            // through on its own debit, read at a final block on both RPCs. Whatever U holds after it is moved by a new move
            await mark("in_transit", { move: undefined, prior_ms: undefined, prior_height: at.height }, move.asset, { moved: true });
          } else if (at !== null && at.used === false && short && at.timeMs <= move.deadline_ms) {
            // in its window a nonce is never pruned: a debit at a block where it reads unused is another intent of U's
            // own (a withdraw.open), not this move; remembered, so the end past the deadline is read right (L2)
            if (move.foreign !== true) await mark(null, { move: { ...move, foreign: true } });
          } else if (at !== null && at.used === false && short && move.foreign !== true) {
            // past its deadline, the nonce unused and U's balance short of it with no other debit seen in its window: a
            // pruned nonce (intents.near's cleanup_nonces) of a move that landed
            await mark("in_transit", { move: undefined, prior_ms: undefined, prior_height: at.height }, move.asset, { moved: true });
          } else if (at !== null && at.used === false && at.timeMs > move.deadline_ms) {
            // over unlanded: unused at a block past its deadline (its debit, if any, another intent's); a new move takes
            // only what U holds now, this deadline handed to its rule
            await mark(null, { move: undefined, prior_ms: move.deadline_ms, prior_height: at.height }, move.asset, { unlanded: true });
          }
        } else {
          // what U holds of each asset, at one block on both RPCs
          let found: { asset: string; at: MoveRead } | null = null;
          let held = false;
          const holds = new Map<string, bigint>();
          for (const asset of [...new Set([...back.map(([, op]) => op.follow.origin), usdcId])]) {
            const at = await readAt(null, asset);
            if (at === null) continue;
            holds.set(asset, at.held);
            if (at.held === 0n) continue;
            held = true;
            if (found === null && !underMin.has(`${asset} ${at.held}`)) found = { asset, at };
          }
          movable = found !== null && deps.refundMove !== undefined && !struck;
          if (held) for (const [id, op] of open) if (op.stage !== "refunded" && RANK[op.stage] !== undefined) await write(id, "refunded", legFacts(op, "refunded"));
          // an op whose own move went unlanded and whose own asset U now holds none of, read at one block: its money left
          // U by another intent of U's own (a withdraw.open); it ends held, with nothing left to move (L2)
          for (const [id, op] of open) if (op.follow.unlanded === true && holds.get(op.follow.origin) === 0n) await write(id, "held", legFacts(op, "held"), { why: "moved_out" });
          // L1: once U is struck (this session or kept from an earlier one), an op refunded later whose own money waits
          // under U inside intents.near is held for the way out too; nothing is signed for it
          if (struck) for (const [id, op] of open) if (!ENDS.has(op.stage) && (holds.get(op.follow.origin) ?? 0n) > 0n) await write(id, "held", legFacts(op, "held"), { why: "sender_struck" });
          if (movable && now() >= moveAt) {
            const f = found!;
            const prior = back.find(([, op]) => op.follow.prior_ms !== undefined)?.[1].follow.prior_ms ?? null;
            // recorded before it is sent: a reload, or a move whose debit is not final yet, never sends it again
            const res = await deps.refundMove!({ u: U, asset: f.asset, reads: f.at.reads, height: f.at.height, salt: f.at.salt, priorMs: prior, probe: relayDown, openKey, record: (m) => mark("refund_move", { move: m }, f.asset) }, signal);
            const backOff = () => {
              relayDown = true;
              moveWait = Math.min(Math.max(moveWait * 2, MOVE_RETRY_MIN_MS), MOVE_RETRY_MAX_MS);
              moveAt = now() + moveWait;
            };
            if (res.kind === "sent" && res.code === "sender_struck") {
              // final for U at the helper (markets.md H4.3): nothing more is signed for U this session; U's ops whose money
              // waits under U inside intents.near are held for the way out (withdraw.open); an op still in flight is
              // followed on (its own bind, if U is struck there too, holds it)
              struck = true;
              for (const [id, op] of await opsOfU()) await write(id, op.stage, factsOf(op), { intents_struck: true });
              for (const [id] of open) {
                const op = (await ops.get("ops", id)) as DepositOp;
                if (!ENDS.has(op.stage)) await write(id, "held", legFacts(op, "held"), { why: "sender_struck" });
              }
              return false;
            } else if (res.kind === "sent" && res.status >= 200 && res.status < 300) {
              relayDown = false;
              moveWait = 0;
              fast = true;
            } else if (res.kind === "sent" || (res.kind === "refused" && res.why === "relay")) backOff();
            else if (res.kind === "under_min") {
              // no quote takes it into the vault: an op whose own refund it is waits held for withdraw.open; anything
              // else under MIN_DEPOSIT (a stranger's dust, what is left after a move) is left as it is (restore finds it)
              underMin.add(`${f.asset} ${f.at.held}`);
              for (const [id, op] of open) if (op.follow.origin === f.asset) await write(id, "held", legFacts(op, "held"), { why: "under_min" });
            }
            // refused (a quote off the request, the helper down, a read that moved): nothing signed; a later round asks again
          }
        }
      }
    }
    // a move out keeps U followed, a held op's too, until it is read through or over (L3: a held op's move is read past
    // its deadline above)
    let moveOut = false;
    if (deps.untilFinal && idle && !movable) for (const [, op] of await opsOfU()) if (op.follow.move !== undefined) moveOut = true;
    if (deps.untilFinal && idle && !movable && !moveOut)
      for (const [id, op] of await opsOfU()) if (op.stage === "done" && op.follow.final !== true && (await pastOnBoth(rpcs, op.follow.deadline_ms))) await write(id, "done", factsOf(op), { final: true });
    // 1Click's status of each open op: the stage shown only, never back, never an end
    for (const [id, op0] of await opsOfU()) {
      let op = op0;
      if (ENDS.has(op.stage)) continue;
      const past = now() >= op.follow.deadline_ms && (await pastOnBoth(rpcs, op.follow.deadline_ms));
      if (past && !op.follow.sent && !counted.free) {
        // past the signed deadline with no send seen: expired shows, and the chain is read each round from here on
        if (op.stage === "quote_checked") await write(id, "expired", {});
        continue;
      }
      // after SUCCESS the status is read again only while U is not created (its read is what creates it)
      if (op.follow.delivered !== undefined && !uMissing) continue;
      if (now() < (statusAt.get(id) ?? 0)) continue;
      // REFUNDED is 1Click's last word on an address: read again at the slow pace only, through the helper's shared key
      if (op.follow.status === "REFUNDED") statusAt.set(id, now() + SLOW_MAX_MS);
      const st = await readDepositStatus(op.follow.address, U, fetchFn, signal, now());
      if (st === null) continue;
      if ("retry_ms" in st) {
        const b = st.retry_ms ?? Math.min(Math.max((backoff.get(id) ?? 0) * 2, STATUS_RETRY_MIN_MS), STATUS_RETRY_MAX_MS);
        backoff.set(id, b);
        statusAt.set(id, Math.max(statusAt.get(id) ?? 0, now() + b));
        continue;
      }
      backoff.delete(id);
      const sent = st.status !== "PENDING_DEPOSIT";
      // a send in flight (1Click has it: known, processing, short of the amount, failed and still processing, or delivered)
      if (sent && st.status !== "REFUNDED") fast = true;
      const follow: Partial<FollowRecord> = {};
      if (op.follow.status !== st.status) follow.status = st.status;
      if (sent && !op.follow.sent) follow.sent = true;
      if (st.status === "SUCCESS" && op.follow.delivered === undefined) follow.delivered = (st.delivered ?? 0n).toString();
      const stage = STATUS_STAGE[st.status];
      // REFUNDED shows nothing the chain has not read
      const moves = st.status !== "REFUNDED" && RANK[stage] !== undefined && RANK[op.stage] !== undefined && RANK[stage]! >= RANK[op.stage]!;
      if (moves || Object.keys(follow).length > 0) op = await write(id, moves ? stage : op.stage, moves ? (stage === "quote_checked" ? {} : legFacts(op, stage)) : factsOf(op), follow);
    }
    // a SUCCESS read this round may count notes already landed
    if ((await count()).held) return false;
    return fast;
  };

  // ---------- the rounds ----------
  let slow = 0;
  let err = 0;
  for (;;) {
    signal.throwIfAborted();
    let fast: boolean;
    try {
      fast = await round();
      err = 0;
    } catch (e) {
      signal.throwIfAborted();
      err = Math.min(Math.max(err * 2, pollMs), SLOW_MAX_MS);
      await sleep(err);
      continue;
    }
    // r4: a held op lifted to done in this round has no waiter: adopt it, so its final is written in this session
    if (deps.untilFinal) for (const [id, op] of await opsOfU().catch(() => [])) if (op.stage === "done" && op.follow.final !== true) adopt(id);
    for (const w of [...waiters]) {
      const op = (await ops.get("ops", w.opId).catch(() => undefined)) as DepositOp | undefined;
      const o = isObj(op) ? await outcomeOf(op, store).catch(() => null) : null;
      // done: with untilFinal, U is still followed (a late delivery, a gift, an older quote's late send are bound) until
      // the op's quote's deadline is past on both RPCs, when no send to it can come any more
      if (o !== null && (o.kind === "held" || !deps.untilFinal || op!.follow.final === true)) w.ok(o);
    }
    if (waiters.size === 0) return;
    if (fast) slow = 0;
    else slow = slow === 0 ? SLOW_MS : Math.min(slow * 2, SLOW_MAX_MS);
    await sleep(fast ? pollMs : slow);
  }
}
