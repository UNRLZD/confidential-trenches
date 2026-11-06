// The device follows a deposit from its checked address to its note, with no tap (card wallet-deposit-follow;
// docs/plan1/wallet.md §2.4 steps 4-9 and point 8, the app paper's APU-04 table, at research HEAD).
//
// The rule: a status answer from the server moves only the stage shown and never ends a follow. An op ends only on the
// device's own chain reads.
// - 1Click's status of the deposit address is read through the helper's keyed proxy (POST /v1/proxy/oneclick/v0/status,
//   apps/helper/src/proxy/vendors.ts oneclick). The answer is hostile: it counts only when it names our address, with U
//   as its recipient and its refund, and one of 1Click's seven statuses, and then it moves only the stage shown
//   (STATUS_STAGE, APU-04), never back (a stale answer). REFUNDED and SUCCESS show nothing the chain has not read.
// - Each round reads the chain first, on both RPCs at one final block (heights within HEIGHT_SPREAD_MAX):
//   U's own USDC (MIN_DEPOSIT or more is a credit: it is written as the amount of U's next note, then bound), and the
//   quote's origin asset that U holds inside intents.near (more than 0: refunded, held_id U; with deps.refundMove the
//   device moves it, and its credit to U is bound the same way). Anything that credits U, a stranger's gift too, is
//   bound as U's next note, so nothing under U is ever left unfollowed.
// - done: the pages on both RPCs hold U's notes of this op, each UNSPENT with the leaf the note store holds and U as
//   depositor, and their total is at least the checked quote's min_amount_out (op.follow.min_out). A note under it
//   (a gift, a forged SUCCESS) is bound and the follow goes on for the rest. A front-run on P binds nothing for us and
//   the money still in U goes on U's next second-arrival note.
// - held: the relayer struck U or refused the call, or the bind refused (USDC's code hash moved, a note with another
//   leaf, the pages not holding the note's leaf). halted while the bind waits on a halt. Both hold the money under U.
// - Polling: each second while the quote's signed deadline is live (1Click's 429 and Retry-After honoured for the
//   status read only); past it on both RPCs' block time, one round of chain reads per follow (each landing's settle)
//   and the follow answers waiting. expired is a stage shown, never an end. No timer ever makes a stage.
// - The seed: only the bind phase opens it (deps.seed64), and zeroes it once that phase ends. The status and balance
//   reads name only U, which is public (the deposit record's id).
// - The op in the wallet store's "ops" (kit messages.ts Operation, src/state.ts op contract) is the follow's only state:
//   its stage, facts and txs (each bind call's NEAR tx hash as heard), and under `follow` what a reload needs. Nothing
//   secret: no key, words, note secret or signed payload.
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
/** The status read's answer: a status, or a 429 with its wait (null: none given). */
export type StatusRead = OneClickStatus | { retry_ms: number | null };

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
    return body.status as OneClickStatus;
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

/** The deposit op's resume fields (op.follow): plain values, nothing secret. */
export interface FollowRecord {
  network: NearNetwork;
  /** U = U_{s,i}: s as a decimal string; U's public id (the deposit record's id, checked against the seed before a bind). */
  s: string;
  i: number;
  u: string;
  /** The checked quote's deposit address, its signed deadline (unix ms), its origin asset (a 1Click asset id: what a refund
   * lands as, under U inside intents.near) and its min_amount_out in USDC base units (what done needs bound). */
  address: string;
  deadline_ms: number;
  origin: string;
  min_out: string;
  /** Which of U's notes binds next (-1 its deposit note, n its n-th second arrival) and, once U's credit is read, its amount. */
  note?: number;
  amount?: string;
  /** The total of U's notes of this op the pages hold (USDC base units). */
  bound?: string;
  /** Why the op is held. */
  why?: string;
}
export type DepositOp = { kind: "deposit"; stage: DepositStage; txs: { chain: "near"; hash: string }[]; created_ms: number; follow: FollowRecord } & DepositFacts;

export interface FollowArgs extends Omit<FollowRecord, "s" | "note" | "amount" | "bound" | "why"> {
  /** The op's id: the deposit.quote request's id. */
  opId: string;
  s: bigint;
}

export type FollowOutcome =
  /** U's notes of the op read on both RPCs, UNSPENT, at least min_out in all. */
  | { kind: "done"; note: NoteRecord }
  /** U holds the refund inside intents.near (both RPCs) and no refund move is given: the money waits under U. */
  | { kind: "refunded" }
  /** The bind stopped (struck, refused, or a refusal of the bind): the money waits under U, which withdraw.open moves out. */
  | { kind: "held"; why: string }
  /** Past the signed deadline on both RPCs with nothing to bind now: each landing reads the chain again. */
  | { kind: "waiting" };

export interface FollowDeps {
  /** The wallet store whose "ops" holds the op (src/state.ts op contract). */
  ops: Pick<WalletStore, "get" | "update">;
  store: NoteStore;
  rpcs: readonly [FollowRpc, FollowRpc];
  /** Opens the seed for a bind phase only: a fresh copy each call, which the follow zeroes once that phase ends. */
  seed64: () => Promise<Uint8Array>;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  pollMs?: number;
  /** Each stage as written, with its facts (SIGN_HOST posts it as deposit.confirm's progress). */
  onStage?: (stage: DepositStage, facts: DepositFacts) => void;
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
// The bind's waits on a halt (bind.ts onWait): USDC halted on U's read, the relayer's token_halted or relayer_low.
const HALTS = new Set(["halted", "token_halted", "relayer_low"]);
// A refusal the next read may clear (one RPC behind or down, USDC not back yet): the follow stops, the op stays.
const PASSING = new Set(["rpc", "disagree", "height", "balance", "not_created", "early", "nonce"]);
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

/**
 * Follows the deposit op `args.opId` to done, refunded (no refund move), held or, past its deadline with nothing to
 * bind, waiting. Starts the op when the store has none; resumes it from its stage otherwise (a reload, a closed tab).
 * deps.signal stops it; the money is then wherever the chain has it and a later follow of the op picks up from there.
 */
export async function followDeposit(args: FollowArgs, deps: FollowDeps): Promise<FollowOutcome> {
  if (typeof args.network !== "string" || !Object.hasOwn(NEAR_NETWORKS, args.network)) throw new DepositFollowRefused(`unknown network ${String(args.network)}`);
  const vault = NEAR_NETWORKS[args.network].vault;
  if (vault === null) throw new DepositFollowRefused(`the release names no vault on ${args.network}`);
  if (typeof args.address !== "string" || args.address === "" || !Number.isSafeInteger(args.deadline_ms) || typeof args.opId !== "string" || args.opId === "")
    throw new DepositFollowRefused("an op id, a deposit address and its signed deadline are needed");
  if (typeof args.u !== "string" || !IMPLICIT.test(args.u)) throw new DepositFollowRefused("U is not an implicit id");
  if (typeof args.origin !== "string" || args.origin === "" || typeof args.min_out !== "string" || !DIGITS.test(args.min_out) || BigInt(args.min_out) < VAULT_CONSTANTS.MIN_DEPOSIT)
    throw new DepositFollowRefused("the quote's origin asset and a min_amount_out of MIN_DEPOSIT or more are needed");
  const { ops, store, rpcs } = deps;
  const U = args.u;
  const fetchFn = deps.fetchFn ?? fetch;
  const pollMs = deps.pollMs ?? POLL_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const now = deps.now ?? Date.now;
  const signal = deps.signal;
  const bind = deps.bind ?? bindDeposit;
  const token = NEAR_NETWORKS[args.network].usdc;
  const intents = deps.intents === undefined ? INTENTS_CONTRACT[args.network] : deps.intents;
  const minOut = BigInt(args.min_out);
  const pause = async () => {
    signal?.throwIfAborted();
    await sleep(pollMs);
    signal?.throwIfAborted();
  };

  // ---------- the op: read, or written fresh ----------
  const fresh: FollowRecord = { network: args.network, s: args.s.toString(), i: args.i, u: U, address: args.address, deadline_ms: args.deadline_ms, origin: args.origin, min_out: args.min_out };
  let op = (await ops.update("ops", args.opId, (v) => (v === undefined ? { kind: "deposit", stage: "quote_checked", txs: [], created_ms: now(), follow: fresh } : undefined))) as DepositOp | undefined;
  op ??= (await ops.get("ops", args.opId)) as DepositOp | undefined;
  if (!isObj(op) || op.kind !== "deposit" || !isObj(op.follow)) throw new DepositFollowRefused("the op is not a deposit op");
  if (FOLLOW_KEYS.some((k) => op!.follow[k] !== fresh[k])) throw new DepositFollowRefused("the op names another deposit");

  // Writes a stage and its facts (only the facts that stage carries, kit messages.ts DepositFacts), follow fields (an
  // undefined one is dropped) and tx hashes heard.
  const write = async (stage: DepositStage, facts: DepositFacts, follow?: Partial<FollowRecord>, txs: string[] = []): Promise<void> => {
    const newTx = txs.filter((h) => !op!.txs.some((t) => t.hash === h));
    // the same stage and facts again is no write: each write is a store change the app's state is posted again for
    if (follow === undefined && newTx.length === 0 && op!.stage === stage && FACT_KEYS.every((k) => op![k] === facts[k])) return;
    const next = (await ops.update("ops", args.opId, (v) => {
      const cur = v as DepositOp;
      const f: Record<string, unknown> = { ...cur.follow, ...follow };
      for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
      const had = cur.txs ?? [];
      const out: Record<string, unknown> = { kind: "deposit", stage, txs: [...had, ...newTx.filter((h) => !had.some((t) => t.hash === h)).map((hash) => ({ chain: "near", hash }))], created_ms: cur.created_ms, follow: f };
      for (const k of FACT_KEYS) if (facts[k] !== undefined) out[k] = facts[k];
      return out;
    })) as DepositOp | undefined;
    if (next === undefined) throw new DepositFollowRefused("the op could not be written");
    const changed = op!.stage !== stage || FACT_KEYS.some((k) => op![k] !== next[k]);
    op = next;
    if (changed) deps.onStage?.(stage, facts);
  };
  const since = (): number => op!.since_ms ?? now();
  // refunded: the op is at the refunded stage, or a leg after it carries the fact (the refunded stage itself does
  // not: the kit's DEPOSIT_REFUNDED_STAGES are the legs after it)
  const refunded = (): boolean => op!.refunded === true || op!.stage === "refunded";
  // each fact only on the stages it belongs to (kit schema.ts depositFactsFit): refunded on the legs after a refund,
  // U as held_id on the stages that hold the money under it, the hold's reason on halted
  const legFacts = (stage: DepositStage): DepositFacts => {
    const out: DepositFacts = { since_ms: since() };
    if (refunded() && DEPOSIT_REFUNDED_STAGES.includes(stage)) out.refunded = true;
    if (stage === "refunded" || stage === "refund_move" || stage === "held" || stage === "halted") out.held_id = U;
    if (stage === "halted") out.hold = "halted";
    return out;
  };
  const hold = async (why: string): Promise<FollowOutcome> => {
    await write("held", legFacts("held"), { why });
    return { kind: "held", why };
  };

  // ---------- the notes of U, by op.follow.note: -1 U's deposit note, n its n-th second arrival ----------
  const refOf = (n: number): NoteRef => (n < 0 ? { kind: "deposit", s: args.s, i: args.i } : { kind: "second", id: { id: "U", s: args.s, i: args.i }, n });
  const key = (r: NoteRef) => JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  const noteOf = async (n: number, seed?: Uint8Array): Promise<NoteRecord> => {
    const ref = refOf(n);
    const found = (await store.list()).find((x) => key(x.ref) === key(ref));
    if (found !== undefined) return found;
    if (n < 0) throw new DepositFollowRefused("U's deposit note is not in the store");
    if (seed === undefined) throw new DepositFollowRefused(`U's second-arrival note ${n} is not in the store`);
    const scope = (await noteOf(-1)).scope;
    return store.add({ ref, scope, precommitment: noteSecrets(seed, ref).precommitment, state: "PLANNED" });
  };

  // ---------- a note read: a fresh read of the pages on both RPCs holds P with the note's leaf, the note UNSPENT ----------
  const confirm = async (n: number): Promise<{ note: NoteRecord; ours: boolean } | null> => {
    const note = await noteOf(n);
    const watch = new DepositsWatch(vault, note.precommitment, rpcs, { ...(await store.syncCursor(vault)), deposits: note.searchFrom ?? 0 });
    for (;;) {
      const r = await watch.read(signal);
      if (r.state === "held") {
        const cur = (await store.get(note.id))!;
        const leaf = cur.leaf;
        if (cur.state !== "UNSPENT" || leaf === undefined || leaf.leafIndex !== r.row.leafIndex || leaf.value !== r.row.value || leaf.commitment !== noteCommitment(r.row.value, r.row.label, note.precommitment)) return null;
        return { note: cur, ours: r.row.depositor === U };
      }
      await pause();
    }
  };

  // ---------- the bind phase: the seed open, note n bound at the amount written, then read on both RPCs ----------
  const bindPhase = async (): Promise<FollowOutcome | null> => {
    const n = op!.follow.note ?? -1;
    const amount = BigInt(op!.follow.amount!);
    const seed = await deps.seed64();
    let note: NoteRecord;
    let out: BindOutcome;
    try {
      try {
        if (!(seed instanceof Uint8Array) || seed.length !== 64) throw new DepositFollowRefused("seed64 must be 64 bytes");
        if (depositAccount(seed, args.s, args.i).account !== U) throw new DepositFollowRefused("the seed's U_{s,i} is not the op's U");
        note = await noteOf(n, seed);
        const bindDeps: BindDeps = {
          store, rpcs, fetchFn, sleep, pollMs,
          ...(signal ? { signal } : {}),
          ...(deps.relayerAccount !== undefined ? { relayerAccount: deps.relayerAccount } : {}),
          onWait: async (code) => {
            if (HALTS.has(code)) await write("halted", legFacts("halted"));
          },
        };
        out = note.state === "UNSPENT" ? { kind: "deposited", note } : await bind(seed, { network: args.network, s: args.s, i: args.i, noteId: note.id, amount }, bindDeps);
      } catch (e) {
        signal?.throwIfAborted();
        // the bind's refusals end the op held (USDC's code hash moved, the note holds another leaf, the seed is not U's);
        // a read the next round may clear stops this follow only, the op at its stage
        if (e instanceof DepositFollowRefused || ((e instanceof DepositAccountRefused || e instanceof DepositBindRefused) && !PASSING.has(e.code)))
          return await hold(e instanceof DepositFollowRefused ? "refused" : e.code);
        throw e;
      }
    } finally {
      seed.fill(0);
    }
    const txs = ((await store.get(note.id))?.calls ?? []).flatMap((c) => c.tx_hashes);
    if (out.kind === "struck" || out.kind === "refused") {
      await write("held", legFacts("held"), { why: out.kind === "struck" ? "sender_struck" : out.code }, txs);
      return { kind: "held", why: out.kind === "struck" ? "sender_struck" : out.code };
    }
    const read = await confirm(n);
    if (read === null) {
      await write(op!.stage, legFacts(op!.stage), undefined, txs);
      return await hold("leaf");
    }
    if (!read.ours) {
      // a front-run on P: that note holds another's deposit; what U still holds goes on U's next second arrival
      await write("in_transit", legFacts("in_transit"), { note: n + 1, amount: undefined }, txs);
      return null;
    }
    const bound = BigInt(op!.follow.bound ?? "0") + read.note.leaf!.value;
    if (bound >= minOut) {
      await write("done", { ...(refunded() ? { refunded: true } : {}), since_ms: since(), amount_usd: usdOf(bound) }, { bound: bound.toString(), amount: undefined }, txs);
      return { kind: "done", note: read.note };
    }
    // under the checked quote's min_amount_out (a gift, part of it): bound, and the rest is still to come
    await write("in_transit", legFacts("in_transit"), { bound: bound.toString(), note: n + 1, amount: undefined }, txs);
    return null;
  };

  // ---------- resume from the op's stage ----------
  if (op.stage === "held") return { kind: "held", why: op.follow.why ?? "held" };
  if (op.stage === "done") {
    const read = await confirm(op.follow.note ?? -1);
    if (read !== null) return { kind: "done", note: read.note };
    return await hold("leaf");
  }
  let statusAt = 0;
  let backoff = 0;
  for (;;) {
    if (op.follow.amount !== undefined) {
      const r = await bindPhase();
      if (r !== null) return r;
      continue;
    }
    // the chain first: U's own USDC, then what U holds inside intents.near (a refund)
    const c = await readCredit(U, token, rpcs);
    if (c !== null && c >= VAULT_CONSTANTS.MIN_DEPOSIT) {
      await write("into_vault", legFacts("into_vault"), { amount: c.toString(), note: op.follow.note ?? -1 });
      continue;
    }
    const held = intents === null ? null : await readHeld(intents, U, args.origin, rpcs);
    if (held !== null && held > 0n) {
      if (deps.refundMove === undefined) {
        await write("refunded", legFacts("refunded"));
        return { kind: "refunded" };
      }
      // the refund read on both RPCs: refunded from here on, so the move's legs carry the fact
      await write("refund_move", { ...legFacts("refund_move"), refunded: true });
      await deps.refundMove(U, signal);
      // the move's own quote delivers to U on the token: the next rounds read its credit and bind it
      await write("in_transit", legFacts("in_transit"));
      continue;
    }
    // past the signed deadline on both RPCs: no more status reads; each landing reads the chain again
    if (now() >= args.deadline_ms && (await pastOnBoth(rpcs, args.deadline_ms))) {
      if (op.stage === "quote_checked") await write("expired", {});
      return { kind: "waiting" };
    }
    if (now() >= statusAt) {
      const st = await readDepositStatus(args.address, U, fetchFn, signal, now());
      if (st !== null && typeof st === "object") {
        backoff = st.retry_ms ?? Math.min(Math.max(backoff * 2, STATUS_RETRY_MIN_MS), STATUS_RETRY_MAX_MS);
        statusAt = now() + backoff;
      } else if (st !== null) {
        backoff = 0;
        // the stage shown only, never back; REFUNDED shows nothing until U's refund reads on both RPCs
        const stage = STATUS_STAGE[st];
        if (st !== "REFUNDED" && RANK[stage] !== undefined && RANK[op.stage] !== undefined && RANK[stage]! >= RANK[op.stage]!) await write(stage, stage === "quote_checked" ? {} : legFacts(stage));
      }
    }
    await pause();
  }
}
