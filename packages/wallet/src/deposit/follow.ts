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
// - done: an op is done once 1Click's status of its own address read SUCCESS, and the notes it counts (their ids in
//   op.follow.notes) cover what 1Click says it delivered and the quote's min_amount_out. Each note counts for one op
//   only, the oldest op first, and only once the pages on both RPCs hold its leaf for U (whatever its state now: a
//   withdraw may have begun). A refunded op whose refund move is through counts any note of U.
// - held: the relayer struck U or refused the call, the bind refused (USDC's code hash moved, a note with another leaf,
//   the seed not U's), or the pages do not hold a note's leaf. halted while the bind waits on a halt, cleared with it; a
//   wait that is no halt ends the bind phase and the next round binds again.
// - refunded: what U holds inside intents.near of an op's origin asset or of NEAR USDC, on both RPCs. A stage, no end:
//   the rounds go on. The refund move (deps.refundMove) is recorded in the op before it is sent and never sent again
//   until that balance reads 0.
// - Pace: 1 s while a status shows a send in flight or a credit is being bound; else 15 s, doubling to 60 s. Past the
//   deadline on both RPCs' block time with no send seen, expired shows and only the chain is read, slowly. 1Click's 429
//   and Retry-After hold that op's status read. A throw that is no refusal pauses and the round runs again; only the
//   signal ends a follow. No timer ever makes a stage.
// - The seed: only a bind phase opens it (deps.seed64, under deps.seedLock), and zeroes it once the phase ends.
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
  block(params: { finality: "final" }): Promise<unknown>;
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
  const sides = await Promise.all(
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
  return sides.every((ms) => ms !== null && ms > BigInt(deadlineMs));
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
/** What `account` holds of `tokenId` inside the intents contract (mt_balance_of) at one final block on both RPCs, or null. */
export const readHeld = (intents: string, account: string, tokenId: string, rpcs: readonly [BindRpc, BindRpc]): Promise<bigint | null> =>
  readAtOne({ contract: intents, method: "mt_balance_of", args: { account_id: account, token_id: tokenId } }, rpcs);

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
  /** On 1Click's SUCCESS: what it says it delivered (USDC base units; "0" when it names none). */
  delivered?: string;
  /** The ids of U's notes this op counts, each landed for U on both RPCs and counted by no other op. */
  notes?: string[];
  /** The refund move of U's intents balance is sent: it is never sent again until that balance reads 0. */
  move?: "sent";
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
  /** The refund move (wallet.md §2.4 point 8): moves what U holds inside intents.near to U on the token. */
  refundMove?: (u: string, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

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
  if (ended !== null) return ended;
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
      run.done = followU(args, deps, ctl.signal, waiters).then(
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
  if (op.stage === "held") return { kind: "held", why: op.follow.why ?? "held" };
  if (op.stage !== "done") return null;
  const id = op.follow.notes?.at(-1);
  const note = id === undefined ? undefined : await store.get(id);
  if (note === undefined) throw new DepositFollowRefused("the op says done but its note is not in the store");
  return { kind: "done", note };
}

// U's follower: rounds of chain reads, binds, counts, refunds and status reads over every op of U, until no op waits.
// A throw that is no refusal pauses and the round runs again; only the signal ends it.
async function followU(first: FollowArgs, deps: FollowDeps, signal: AbortSignal, waiters: Set<Waiter>): Promise<void> {
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
    const out: DepositFacts = { since_ms: op.since_ms ?? now() };
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

  // ---------- a bind phase: the seed open (under deps.seedLock), U's next note bound at U's credit ----------
  const bindPhase = async (amount: bigint): Promise<"bound" | "paused" | "held"> => {
    for (const [id, op] of await opsOfU())
      if (!ENDS.has(op.stage) && (op.follow.sent || op.follow.move || op.stage === "refunded")) await write(id, "into_vault", legFacts(op, "into_vault"));
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
            onWait: async (code) => {
              if (code === "not_created") uMissing = true;
              if (!HALTS.has(code)) throw new BindPaused(code);
              halted = true;
              for (const [id, op] of await opsOfU()) if (!ENDS.has(op.stage) && op.stage === "into_vault") await write(id, "halted", legFacts(op, "halted"));
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
    // halted clears when the halt does
    if (halted) for (const [id, op] of await opsOfU()) if (op.stage === "halted") await write(id, "into_vault", legFacts(op, "into_vault"));
    if (out === "paused") return "paused";
    uMissing = false;
    if (out.kind === "struck" || out.kind === "refused") {
      await holdAll(out.kind === "struck" ? "sender_struck" : out.code);
      return "held";
    }
    return "bound";
  };

  // ---------- the counts: each landed note of U goes to the oldest op 1Click says delivered, until that op is covered ----------
  const count = async (): Promise<{ held: boolean; unsure: boolean; free: boolean }> => {
    const all = await opsOfU();
    const counted = new Set(all.flatMap(([, op]) => op.follow.notes ?? []));
    const free: { note: NoteRecord; value: bigint }[] = [];
    let unsure = false;
    for (const { note } of await notesOfU()) {
      if (note.leaf === undefined || counted.has(note.id)) continue;
      // landed: the pages hold its leaf, whatever its state now (UNSPENT, or HELD and SPENT once a withdraw began)
      const p = await pagesOf(note);
      if (p.state === "mismatch") {
        await holdAll("leaf");
        return { held: true, unsure, free: false };
      }
      if (p.state === "unsure") unsure = true;
      else if (p.state === "ours") free.push({ note, value: p.value });
    }
    for (const [id, op] of all) {
      // an op counts notes once 1Click says it delivered; a refunded op once its refund move is through (its own
      // quote's status is the refund move's, card wallet-refund-move): then any note of U at MIN_DEPOSIT covers it
      const moved = op.refunded === true && op.follow.move === undefined && op.stage !== "refunded";
      if (ENDS.has(op.stage) || (op.follow.delivered === undefined && !moved)) continue;
      const need = moved && op.follow.delivered === undefined ? VAULT_CONSTANTS.MIN_DEPOSIT : [BigInt(op.follow.min_out), BigInt(op.follow.delivered!)].reduce((a, b) => (a > b ? a : b));
      const mine = op.follow.notes ?? [];
      let sum = 0n;
      for (const nid of mine) sum += (await store.get(nid))?.leaf?.value ?? 0n;
      const took: string[] = [];
      while (sum < need && free.length > 0) {
        const f = free.shift()!;
        took.push(f.note.id);
        sum += f.value;
      }
      if (took.length === 0 && sum < need) continue;
      const notes = [...mine, ...took];
      const txs = (await Promise.all(notes.map(async (nid) => (await store.get(nid))?.calls ?? []))).flat().flatMap((c) => c.tx_hashes);
      if (sum >= need) await write(id, "done", { ...(op.refunded ? { refunded: true } : {}), since_ms: op.since_ms ?? now(), amount_usd: usdOf(sum) }, { notes }, txs);
      else await write(id, "in_transit", legFacts(op, "in_transit"), { notes }, txs);
    }
    return { held: false, unsure, free: free.length > 0 };
  };

  // ---------- one round ----------
  const statusAt = new Map<string, number>();
  const backoff = new Map<string, number>();
  const round = async (): Promise<boolean> => {
    let fast = false;
    if ((await opsOfU()).every(([, op]) => ENDS.has(op.stage))) return false;
    // the chain first: U's own USDC; MIN_DEPOSIT or more is bound as U's next note
    const c = await readCredit(U, token, rpcs);
    if (c !== null && c >= VAULT_CONSTANTS.MIN_DEPOSIT) {
      const r = await bindPhase(c);
      if (r === "held") return false;
      fast = true;
    }
    const counted = await count();
    if (counted.held) return false;
    if (counted.unsure) fast = true;
    // what U holds inside intents.near: each open op's origin asset and NEAR USDC (a refund); refunded is a stage, no end
    if (intents !== null) {
      const open = (await opsOfU()).filter(([, op]) => !ENDS.has(op.stage));
      const assets = [...new Set([usdcId, ...open.map(([, op]) => op.follow.origin)])];
      const bal = new Map<string, bigint | null>();
      for (const a of assets) bal.set(a, await readHeld(intents, U, a, rpcs));
      const heldOf = (op: DepositOp) => (bal.get(op.follow.origin) ?? 0n) + (op.follow.origin === usdcId ? 0n : (bal.get(usdcId) ?? 0n));
      const read = [...bal.values()].every((v) => v !== null);
      const any = [...bal.values()].some((v) => v !== null && v > 0n);
      if (deps.refundMove !== undefined) {
        const sent = open.filter(([, op]) => op.follow.move === "sent");
        if (any && sent.length === 0) {
          // recorded before it is sent: a reload, or a move whose debit is not final yet, never sends it again
          for (const [id, op] of open) if (heldOf(op) > 0n || !open.some(([, o]) => heldOf(o) > 0n)) await write(id, "refund_move", legFacts(op, "refund_move", true), { move: "sent" });
          await deps.refundMove(U, signal);
          await sleep(pollMs);
          fast = true;
        } else if (!any && read && sent.length > 0) {
          for (const [id, op] of sent) await write(id, "in_transit", legFacts(op, "in_transit"), { move: undefined });
        }
      } else {
        for (const [id, op] of open)
          if (heldOf(op) > 0n && op.follow.delivered === undefined && (RANK[op.stage] !== undefined || op.stage === "refunded")) await write(id, "refunded", legFacts(op, "refunded"));
      }
    }
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
      const st = await readDepositStatus(op.follow.address, U, fetchFn, signal, now());
      if (st === null) continue;
      if ("retry_ms" in st) {
        const b = st.retry_ms ?? Math.min(Math.max((backoff.get(id) ?? 0) * 2, STATUS_RETRY_MIN_MS), STATUS_RETRY_MAX_MS);
        backoff.set(id, b);
        statusAt.set(id, now() + b);
        continue;
      }
      backoff.delete(id);
      const sent = st.status !== "PENDING_DEPOSIT";
      // a send in flight (1Click has it: known, processing, short of the amount, failed and still processing, or delivered)
      if (sent && st.status !== "REFUNDED") fast = true;
      const follow: Partial<FollowRecord> = {};
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
    for (const w of [...waiters]) {
      const op = (await ops.get("ops", w.opId).catch(() => undefined)) as DepositOp | undefined;
      const o = isObj(op) ? await outcomeOf(op, store).catch(() => null) : null;
      if (o !== null) w.ok(o);
    }
    if (waiters.size === 0) return;
    if (fast) slow = 0;
    else slow = slow === 0 ? SLOW_MS : Math.min(slow * 2, SLOW_MAX_MS);
    await sleep(fast ? pollMs : slow);
  }
}
