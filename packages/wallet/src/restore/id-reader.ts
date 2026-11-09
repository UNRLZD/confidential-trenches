// The restore's IdReader on NEAR (card wallet-restore-id-reader; docs/plan1/wallet.md §2.3 "Restore" step 5, l.297-303,
// and its cost, l.312-324). What one deposit id U (a NEAR implicit account, U_{s,i}) shows, from public views only:
//
// - "money": U holds the vault's asset on the token (ft_balance_of(U) > 0; 1Click delivers to U's own NEAR account,
//   §2.4 step 5) or any token inside intents.near (mt_tokens_for_owner(U) lists one and mt_batch_balance_of shows it
//   above 0; D45).
// - "used": U holds nothing now, and a lasting public trace shows it was used:
//   - storage_balance_of(U) on the token is not null: a never-used implicit id has no storage there (D16), and 1Click's
//     delivery registers U (its ft_withdraw with storage_deposit, D12). Read on mainnet USDC at block 223638277:
//     9c484fa5…21c5c1 answers {"total":"1250000000000000000000","available":"0"} with ft_balance_of "0" (used, empty);
//     abab…ab answers null at block 223638170 (never used).
//   - view_account(U) answers an account: U was created (the relayer's prepay Transfer, §2.4). Read at block 223638199:
//     a8969c04…f264e4 answers {"amount":"20000000000000000000000","storage_usage":428} with storage null and no token
//     in intents.near; abab…ab answers UNKNOWN_ACCOUNT at block 223638171.
//   Not a trace: has_public_key(U, U's key) is true for every implicit id, used or not (D15), and intents.near's nonces
//   are pruned (below), so neither is read.
// - Both providers are read, at once, each at its own pace, and must agree (card wallet-id-reader-paced, review P2-3).
//   Two providers at one block hash read one state, so two answers that differ mean one of the pair is wrong: the read
//   throws PairDisagrees naming the provider with the stronger answer (money over used over unused: the one that would
//   read the lane on), and step 5 stops there (./wallets.ts restoreDepositIds). A provider that hides money (answering
//   used) or a trace (answering unused), or one that fakes money or a trace on every id, ends the restore at its first
//   lie, named, never reading a lane on at one word. A listed intents.near token at 0 is no trace: intents.near at
//   16d04f6 deletes a balance that falls to 0 (core/src/amounts.rs:137-140, its entry_or_default;
//   crates/map-utils/src/cleanup.rs:19-20).
// - One block for the whole restore pass (review F6, N1 and its fold): openRestorePass reads both providers' final
//   blocks (view_account of intents.near). Over VAULT_SYNC_LAG_MAX (120) blocks apart refuses the pass at once; the
//   floor is the HIGHER of the two, and the provider behind is re-read until its final reaches it (PASS_TRIES reads,
//   PASS_WAIT_MS apart), or the pass is refused ("the RPCs' finals did not meet"). The floor block's hash is then read
//   on both by its height, and the two must agree. Every view of every id, on both providers, reads at that hash
//   (block_id) and must answer from that block, so money moving between two views never reads as used, and no single
//   provider picks the block: a low final changes nothing (the floor is the higher), a high one the other cannot reach
//   refuses the pass (a stop, never a wrong answer), and a fake hash fails the agreement. Money that lands after the
//   pinned block is step 7's 72-h re-reads' (./wallets.ts afterRestore), as anything after the restore.
// - The pass block's time (delta review 6): on providers that read blocks (`block`, ../withdraw/relay.ts relayRpc),
//   the pass reads its block's header on both while it is served (the release pair stops serving a block by height
//   after about 20 h on FastNEAR and 28 h on dRPC, read 8 Nov 19:58Z), both naming the agreed hash and the same time,
//   and keeps that time with the pass (passTimeMs). Step 7's clock (./after.ts) counts from it and never reads the
//   block again.
// - A pass is used only while fresh and only on the providers it was opened on (review P1, P2): building a reader reads
//   both finals once and refuses a pass more than VAULT_SYNC_LAG_MAX below the higher of them; a step that exists to see
//   money after a height (./after.ts rereadOnOpen and secondScan) opens its own pass above it; and the pass keeps
//   its two provider objects (a frozen copy), matched by identity, never by name. A reader reads its one block for as
//   long as it lives, so the steps that exist to see money after a height take no reader, pass height or clock from
//   their caller: they own their reads and their readers (./after.ts; review R1).
// - An indexer (NearBlocks, the intents explorer) is a server's word: it may turn an id both providers see as unused
//   into "used" (`indexer` answers true), never anything into "unused"; a failed or false answer changes nothing.
//
// The trace this cannot see (review 2, gap 1): an id whose whole life was inside intents.near (a refunded quote moved
// out by an intent to a pool wallet or by withdraw.open) leaves no storage on the token and no NEAR account. Its
// intents' nonces do not last: intents.near runs near/intents 16d04f6 (contract_source_metadata, block 223637676),
// whose cleanup_nonces prunes a V1 versioned nonce once its deadline is past or its salt is no longer valid
// (contracts/defuse/src/contract/garbage_collector.rs:9-43, is_nonce_cleanable l.32-42), by the DAO or the
// GarbageCollector role; a legacy (unversioned) nonce is never cleaned (l.33-35), but "Legacy nonces can still be used
// at this time, but will be prohibited out in the near future" (core/src/nonce/versioned.rs:20). So a seed-derived
// nonce read back by is_nonce_used is no lasting proof. Such an id reads "unused" here unless the indexer says used;
// its money is still under the 12 words.
//
// Failures (review 2, gap 2; card wallet-id-reader-paced): each provider is asked at its own pace (PACE), and a busy
// answer is waited out and asked again within BUSY_WAIT_MAX_MS, its Retry-After honoured. Any other failure is tried
// on its provider with doubling backoff (ID_READ_TRIES, from ID_READ_BACKOFF_MS; a provider a block behind catches up
// in that time). Every state needs both answers: an id whose reads still fail on either throws, and step 5 counts it
// as failed (restoreDepositIds), so one provider always down ends a lane with its named error, never with an answer
// taken on one provider's word. A view that fails with "FiatToken: paused" is a halt, never a zero: it fails the read,
// to be read again. The caller's signal aborts every request in flight and every wait (a sign out). A restore's Retry
// goes on where the last run stopped (IdReadKeep, keptIdReader): an answer at one block never changes, so the ids
// answered at a still-fresh pass are not asked again; and an id both providers answered used stays used at every block
// after, so that answer is kept across any pass age (review P2-2).
//
// Each request names U or the token and nothing else (§2.9 row 8); both operators are asked of each id at once, the one
// asked first drawn at random (l.322-324). Nothing here logs.
import { VAULT_SYNC_LAG_MAX } from "@blindfill/kit";
import { base64 } from "@scure/base";
import { NEAR_NETWORKS, nearPairNetwork, nearPairRule, type NearNetwork, type NearRpc } from "../deposit/account.ts";
import { isPacedRpc, paceHold, paceOf, paceSlot } from "../pace.ts";
import { blockTimeMsOf } from "../withdraw/request.ts";
import type { IdReader, IdState } from "./wallets.ts";

export const INTENTS = "intents.near";
/** Tries of one view on one provider before that provider's read fails (a wrong or failed answer; busy is apart). */
export const ID_READ_TRIES = 4;
/** The wait before a view's second try; it doubles on each try after. */
export const ID_READ_BACKOFF_MS = 250;
/**
 * A provider that says it is busy (HTTP 429 or 5xx, its JSON-RPC -429, dRPC's free-plan timeout, code 30, or no answer
 * in time) is waited for and asked again, never failed: its Retry-After when it sends one, else BUSY_BACKOFF_MS
 * doubling to BUSY_BACKOFF_CAP_MS, while the provider's pace holds its other views back too. One view waits
 * BUSY_WAIT_MAX_MS at most in all; past it (or a Retry-After past it) that provider's read fails, and the id stays
 * unread. FastNEAR's free plan answers HTTP 429 with no Retry-After and the body {"error":{"code":-429,"message":"Rate
 * limits exceeded. ..."}} in runs of 0.2-2.9 s (300 sequential views flat out, 9 Nov 01:37Z: 72 answered, 228 not, from
 * 5.5 s on), so 60 s outlasts twenty of its longest runs; near.org sends Retry-After: 600.
 */
export const BUSY_BACKOFF_MS = 500;
export const BUSY_BACKOFF_CAP_MS = 8_000;
export const BUSY_WAIT_MAX_MS = 60_000;
/**
 * The most busy answers one view takes (review P2-1): each busy answer counts at least BUSY_BACKOFF_MS, or the
 * provider's pace interval when longer, toward BUSY_WAIT_MAX_MS, so a Retry-After of 0 (rpcHttpError keeps it) or a
 * provider that answers busy at once is bounded too; and never more than this many in all.
 */
export const BUSY_TRIES_MAX = Math.ceil(BUSY_WAIT_MAX_MS / BUSY_BACKOFF_MS);
/** Each provider's pace (../pace.ts PACE, one per provider URL for the whole page). */
export { PACE } from "../pace.ts";
const HALT = "FiatToken: paused";
const HEX64 = /^[0-9a-f]{64}$/;
const DIGITS = /^(0|[1-9][0-9]*)$/;
// a block hash: 32 bytes in base58 (43 or 44 characters)
const HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const sleepMs = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((res, rej) => {
    if (signal?.aborted) return rej(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      res();
    }, ms);
    const stop = (): void => {
      clearTimeout(t);
      rej(signal!.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });

/** A provider's answer that says it is busy, with its Retry-After in ms when it sent one (see BUSY_WAIT_MAX_MS). */
export class ProviderBusy extends Error {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ProviderBusy";
    this.retryAfterMs = retryAfterMs;
  }
}
// what in a thrown error says busy: the provider's HTTP 429 or 5xx (the kit's rpcHttpError), or no answer in time
function busyOf(e: unknown): { retryAfterMs: number | undefined } | null {
  if (e instanceof ProviderBusy) return { retryAfterMs: e.retryAfterMs };
  if (!isObj(e)) return null;
  const st = e.status;
  if (typeof st === "number" && (st === 429 || (st >= 500 && st <= 599))) return { retryAfterMs: typeof e.retryAfterMs === "number" ? e.retryAfterMs : undefined };
  if (e.name === "TimeoutError") return { retryAfterMs: undefined };
  return null;
}
// a JSON-RPC error that says busy: FastNEAR's -429 ("Rate limits exceeded"), dRPC's free-plan timeout (code 30)
const busyAnswer = (err: unknown): boolean => isObj(err) && (err.code === -429 || err.code === 429 || (err.code === 30 && /timeout/i.test(String(err.message))));

const randomBit = (): number => globalThis.crypto.getRandomValues(new Uint8Array(1))[0]! & 1;

/** A server's word that an id was used: true says used; false or a throw says nothing. */
export type IdIndexer = (id: string) => Promise<boolean>;
export type IdReaderOpts = {
  tries?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  first?: () => number;
  indexer?: IdIndexer;
  /** Aborts every view in flight and every wait (a sign out): the read throws the signal's reason. */
  signal?: AbortSignal;
  /** The clock of the pace and the busy waits (tests). */
  now?: () => number;
  /** The most one view waits on a busy provider in all (BUSY_WAIT_MAX_MS unless given). */
  busyMaxMs?: number;
  /** The answers kept across a restore's runs (keptIdReader): an id answered at this pass is not asked again. */
  keep?: IdReadKeep;
};

/**
 * What a restore keeps across its runs, so a Retry goes on where the last run stopped (review P2-1: each Retry began
 * again at lane 0): the two providers, the pass and every id's answer at that pass. An answer at one block hash never
 * changes, so it is reused for as long as the pass is fresh (VAULT_SYNC_LAG_MAX). A pass goes stale in about 68 s (120
 * blocks of 565 ms) while one id costs about 7.7 s at FastNEAR's pace, so a new pass keeps the answers that cannot
 * change by age (review P2-2): `lasting`, the ids both providers answered used (registered on the token, an account,
 * a token listed: an id once used was used). Every other answer is asked again at the new pass: unused (a late send can
 * land on any id), money (it can move out) and used on the indexer's word alone. Failed reads are never kept.
 */
export type IdReadKeep = { rpcs?: readonly [NearRpc, NearRpc]; pass?: RestorePass; readonly answers: Map<string, IdState>; readonly lasting: Set<string> };
export const idReadKeep = (): IdReadKeep => ({ answers: new Map(), lasting: new Set() });
/** A pass too far below the providers' finals now (fresh): open a new one. */
export class StalePass extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StalePass";
  }
}
/** The pair disagrees at one block (both answered, differently): one of them is wrong, so nothing is concluded. */
export class PairDisagrees extends Error {
  /** The provider whose answer was the stronger (money over used over unused): the one that would have read the lane on. */
  readonly stronger: string;
  constructor(stronger: string, message: string) {
    super(message);
    this.name = "PairDisagrees";
    this.stronger = stronger;
  }
}
/** Reads of the provider behind before the pass is refused, and the wait between two of them (about 10 s in all). */
export const PASS_TRIES = 10;
export const PASS_WAIT_MS = 1_000;

type Block = { h: number; hash: string };
/** The block a view is asked at: the final one, one by its height (the floor's hash), or the pass's block by its hash. */
type Ask = "final" | { height: number } | Block;
/** The restore pass's one block, read and agreed on both providers by openRestorePass; only its own are taken. */
export type RestorePass = { readonly network: NearNetwork; readonly rpcs: readonly [string, string]; readonly h: number; readonly hash: string };
// each pass openRestorePass opened, with the two provider objects it was opened on (matched by identity, review P2)
// and its block's time in ms (null on providers that do not read blocks)
const PASSES = new WeakMap<RestorePass, { readonly rpcs: readonly [NearRpc, NearRpc]; readonly ms: number | null }>();

/** A NEAR provider that also reads block headers (`block`), as ../withdraw/relay.ts relayRpc. */
export type BlockRpc = NearRpc & { block(params: { block_id: number } | { finality: "final" }, signal?: AbortSignal): Promise<unknown> };
const readsBlocks = (r: NearRpc): r is BlockRpc => typeof (r as Partial<BlockRpc>).block === "function";
/** What a block read by a height with no block answers (NEAR skips heights; an old block is no longer served). */
export const NO_BLOCK = Symbol("no block");
/** One provider's block header: its height, hash and time (ms); NO_BLOCK for UNKNOWN_BLOCK on a read by height. */
export async function blockHeader(r: BlockRpc, params: { block_id: number } | { finality: "final" }, what: string, signal?: AbortSignal): Promise<{ h: number; hash: string; ms: number } | typeof NO_BLOCK> {
  const a = await r.block(params, signal);
  if (!isObj(a)) throw new Error(`${r.name}: ${what}: not a JSON-RPC answer`);
  if (a.error !== undefined) {
    if (busyAnswer(a.error)) throw new ProviderBusy(`${r.name}: ${what}: busy`);
    const cause = isObj(a.error) && isObj(a.error.cause) ? a.error.cause.name : undefined;
    if ("block_id" in params && cause === "UNKNOWN_BLOCK") return NO_BLOCK;
    throw new Error(`${r.name}: ${what}: ${String(isObj(a.error) ? (a.error.name ?? a.error.message) : "an error")}`.slice(0, 200));
  }
  const h = isObj(a.result) && isObj(a.result.header) ? a.result.header : undefined;
  if (!h || !Number.isSafeInteger(h.height) || (h.height as number) <= 0 || typeof h.hash !== "string" || typeof h.timestamp_nanosec !== "string")
    throw new Error(`${r.name}: ${what}: not a block header`);
  if ("block_id" in params && h.height !== params.block_id) throw new Error(`${r.name}: ${what}: answered block ${String(h.height)}, not ${params.block_id}`);
  return { h: h.height as number, hash: h.hash, ms: blockTimeMsOf(h.timestamp_nanosec) };
}
/**
 * blockHeader retried on its provider as the views are (`tries` reads, ID_READ_TRIES unless given, `backoffMs`
 * doubling from ID_READ_BACKOFF_MS; delta review 7: FastNEAR answered a bare HTTP 429 to 9 of 60 opens), so a busy
 * provider or a node a block behind is no refusal. `served`: a block that must exist (the pass's agreed block), so
 * NO_BLOCK is retried too, then refused as "not served"; else NO_BLOCK is returned (a skipped height).
 */
export async function headerRetried(
  r: BlockRpc,
  params: { block_id: number } | { finality: "final" },
  what: string,
  o: Pick<IdReaderOpts, "tries" | "backoffMs" | "sleep" | "signal" | "now" | "busyMaxMs"> = {},
  served = false,
): Promise<{ h: number; hash: string; ms: number } | typeof NO_BLOCK> {
  return asked(r, async (signal) => {
    const y = await blockHeader(r, params, what, signal);
    if (served && y === NO_BLOCK) throw new Error(`${r.name}: ${what} ${"block_id" in params ? params.block_id : "final"} is not served (UNKNOWN_BLOCK)`);
    return y;
  }, askOpts(o));
}

type Asking = { tries: number; backoff: number; sleep: (ms: number, signal?: AbortSignal) => Promise<void>; signal: AbortSignal | undefined; now: () => number; busyMax: number };
function askOpts(o: Pick<IdReaderOpts, "tries" | "backoffMs" | "sleep" | "signal" | "now" | "busyMaxMs">): Asking {
  const tries = o.tries ?? ID_READ_TRIES;
  const backoff = o.backoffMs ?? ID_READ_BACKOFF_MS;
  const busyMax = o.busyMaxMs ?? BUSY_WAIT_MAX_MS;
  if (!Number.isSafeInteger(tries) || tries < 1) throw new Error("tries is a count above 0");
  if (!Number.isSafeInteger(backoff) || backoff < 0) throw new Error("backoffMs is a time in ms");
  if (!Number.isSafeInteger(busyMax) || busyMax < 0) throw new Error("busyMaxMs is a time in ms");
  const signal = o.signal;
  const given = o.sleep;
  // a given sleep (tests) comes with its own clock, which the caller's waits move (delta review 4, P3-2: a clock made
  // here from the sleep was one per options build, so the pass's, the setup's and each header's waits moved apart);
  // it is still cut short by the signal
  if (given !== undefined && o.now === undefined) throw new Error("a given sleep needs its own clock (now)");
  const sleep = given ? async (ms: number): Promise<void> => {
    signal?.throwIfAborted();
    await given(ms);
    signal?.throwIfAborted();
  } : sleepMs;
  const now = o.now ?? (() => performance.now());
  return { tries, backoff, sleep, signal, now, busyMax };
}

/**
 * One request to one provider at its pace (PACE, one per provider URL: ../pace.ts): a busy answer is waited out and
 * asked again, any other failure tried `tries` times with doubling backoff; the signal aborts the request and every
 * wait. One view's bound is wall-clock (review P3-4): the time its requests took and its busy waits, the pace's own
 * queue apart, stay within busyMax (BUSY_WAIT_MAX_MS), and a busy answer past it fails the read by name. Each busy wait
 * counts at least BUSY_BACKOFF_MS or the pace interval (review P2-1: a Retry-After of 0 counted nothing), and a view
 * takes BUSY_TRIES_MAX busy answers at most. A provider paced at its transport (pacedFetch) takes its slot there; any
 * other here, on the clock given.
 */
async function asked<T>(rpc: NearRpc, once: (signal: AbortSignal | undefined) => Promise<T>, o: Asking): Promise<T> {
  const pace = paceOf(rpc.name);
  const here = !isPacedRpc(rpc);
  let fails = 0, busy = 0, spent = 0;
  for (;;) {
    o.signal?.throwIfAborted();
    const w = here ? paceSlot(pace, o.now()) : 0;
    if (w > 0) await o.sleep(w, o.signal);
    const t0 = o.now();
    try {
      return await once(o.signal);
    } catch (e) {
      if (o.signal?.aborted) throw o.signal.reason;
      spent += o.now() - t0;
      const b = busyOf(e);
      if (b !== null) {
        const wait = Math.max(b.retryAfterMs ?? Math.min(BUSY_BACKOFF_CAP_MS, BUSY_BACKOFF_MS * 2 ** busy), BUSY_BACKOFF_MS, pace.every);
        if (++busy > BUSY_TRIES_MAX || spent + wait > o.busyMax) throw new Error(`${rpc.name}: busy past ${o.busyMax} ms of waits (${e instanceof Error ? e.message : "busy"})`.slice(0, 200));
        spent += wait;
        paceHold(pace, o.now(), wait);
        await o.sleep(wait, o.signal);
        continue;
      }
      if (++fails >= o.tries) throw e;
      await o.sleep(o.backoff * 2 ** (fails - 1), o.signal);
    }
  }
}

/** The view's answer and its block, or null for an account the provider says does not exist (view_account only). */
async function view(rpc: NearRpc, params: Obj, what: string, ask: Ask, signal?: AbortSignal): Promise<{ v: unknown; b: Block | null }> {
  const q = ask === "final" ? { ...params, finality: "final" } : { ...params, block_id: "hash" in ask ? ask.hash : ask.height };
  const a = await (signal ? rpc.query(q, signal) : rpc.query(q));
  if (!isObj(a)) throw new Error(`${rpc.name}: ${what}: not a JSON-RPC answer`);
  const text = JSON.stringify(a.error ?? (isObj(a.result) ? a.result.error : undefined) ?? "");
  if (text.includes(HALT)) throw new Error(`${rpc.name}: ${what}: the token is halted (${HALT})`);
  if (busyAnswer(a.error)) throw new ProviderBusy(`${rpc.name}: ${what}: busy`);
  if (a.error !== undefined) {
    const cause = isObj(a.error) && isObj(a.error.cause) ? a.error.cause.name : undefined;
    if (params.request_type === "view_account" && cause === "UNKNOWN_ACCOUNT") return { v: null, b: null };
    throw new Error(`${rpc.name}: ${what}: ${String(isObj(a.error) ? (a.error.name ?? a.error.message) : "an error")}`.slice(0, 200));
  }
  const r = a.result;
  if (!isObj(r) || r.error !== undefined || !Number.isSafeInteger(r.block_height) || (r.block_height as number) <= 0 || typeof r.block_hash !== "string" || !HASH.test(r.block_hash))
    throw new Error(`${rpc.name}: ${what}: not a view result`);
  const b: Block = { h: r.block_height as number, hash: r.block_hash };
  if (ask !== "final" && ("hash" in ask ? b.hash !== ask.hash || b.h !== ask.h : b.h !== ask.height))
    throw new Error(`${rpc.name}: ${what}: answered at block ${b.h} ${b.hash}, not ${"hash" in ask ? `${ask.h} ${ask.hash}` : ask.height}`);
  if (params.request_type === "view_account") {
    if (typeof r.amount !== "string" || !DIGITS.test(r.amount)) throw new Error(`${rpc.name}: ${what}: not an account`);
    return { v: r, b };
  }
  const bytes = r.result;
  if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error(`${rpc.name}: ${what}: no result bytes`);
  try {
    return { v: JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes as number[]))), b };
  } catch {
    throw new Error(`${rpc.name}: ${what}: the result is not JSON`);
  }
}

const call = (account: string, method: string, args: Obj): Obj => ({
  request_type: "call_function",
  account_id: account,
  method_name: method,
  args_base64: base64.encode(new TextEncoder().encode(JSON.stringify(args))),
});
const amount = (x: unknown, what: string): bigint => {
  if (typeof x !== "string" || !DIGITS.test(x)) throw new Error(`${what}: not a decimal string`);
  return BigInt(x);
};

// the pair's checks, the network's token and one view on one provider retried with doubling backoff
function setup(network: NearNetwork, rpcs: readonly [NearRpc, NearRpc], opts: IdReaderOpts) {
  if (typeof network !== "string" || !Object.hasOwn(NEAR_NETWORKS, network)) throw new Error(`unknown network ${String(network)}`);
  if (nearPairNetwork(rpcs) !== network) throw new Error(nearPairRule(network));
  const token = NEAR_NETWORKS[network].usdc;
  const o = askOpts(opts);
  const sleep = (ms: number): Promise<void> => o.sleep(ms, o.signal);
  const first = opts.first ?? randomBit;

  // one view on one provider at its pace, a busy one waited out, a failed one retried with doubling backoff
  const retried = (rpc: NearRpc, params: Obj, what: string, ask: Ask): Promise<{ v: unknown; b: Block | null }> => asked(rpc, (signal) => view(rpc, params, what, ask, signal), o);
  // one provider's block for a view of intents.near's account (the pass's finals and its block)
  const blockOf = async (rpc: NearRpc, ask: Ask, what: string): Promise<Block> => {
    const { b } = await retried(rpc, INTENTS_ACCOUNT, what, ask);
    if (b === null) throw new Error(`${rpc.name}: ${what}: no block`);
    return b;
  };
  return { token, retried, first, sleep, blockOf };
}
type Retried = (rpc: NearRpc, params: Obj, what: string, ask: Ask) => Promise<{ v: unknown; b: Block | null }>;
const INTENTS_ACCOUNT: Obj = { request_type: "view_account", account_id: INTENTS };

/**
 * Opens the restore pass (review N1's fold): both providers' finals within VAULT_SYNC_LAG_MAX, the provider behind
 * re-read until it reaches the higher (PASS_TRIES reads, PASS_WAIT_MS apart), and that block's hash read on both by its
 * height and agreed. Every id and balance read of the pass is at that block. `after`: a pass whose block is not above
 * it is refused (a step that exists to see money after a height: ./after.ts; review P1). Refused by name otherwise; a bad network, pair or option throws at once.
 */
export type PassOpts = Omit<IdReaderOpts, "indexer" | "first"> & { passTries?: number; passWaitMs?: number; after?: number };
export function openRestorePass(network: NearNetwork, rpcs: readonly [NearRpc, NearRpc], opts: PassOpts = {}): Promise<RestorePass> {
  const { sleep, blockOf } = setup(network, rpcs, opts);
  if (opts.after !== undefined && (!Number.isSafeInteger(opts.after) || opts.after < 0)) throw new Error("after is a block height");
  const passTries = opts.passTries ?? PASS_TRIES;
  const passWait = opts.passWaitMs ?? PASS_WAIT_MS;
  if (!Number.isSafeInteger(passTries) || passTries < 1) throw new Error("passTries is a count above 0");
  if (!Number.isSafeInteger(passWait) || passWait < 0) throw new Error("passWaitMs is a time in ms");
  const at = (k: number, ask: Ask, what: string): Promise<Block> => blockOf(rpcs[k]!, ask, what);
  return (async () => {
    const fin = await Promise.all([at(0, "final", "the pass's final"), at(1, "final", "the pass's final")]);
    if (Math.abs(fin[0].h - fin[1].h) > VAULT_SYNC_LAG_MAX) throw new Error(`the RPCs' final heights ${fin[0].h} and ${fin[1].h} are over ${VAULT_SYNC_LAG_MAX} blocks apart; the restore does not start`);
    const floor = Math.max(fin[0].h, fin[1].h);
    const behind = fin[0].h < floor ? 0 : 1;
    for (let k = 0; fin[behind]!.h < floor; k++) {
      if (k >= passTries) throw new Error(`the RPCs' finals did not meet; the restore does not start (${rpcs[behind]!.name} at ${fin[behind]!.h}, the other at ${floor})`);
      await sleep(passWait);
      fin[behind] = await at(behind, "final", "the pass's final");
    }
    const [x, y] = await Promise.all([at(0, { height: floor }, "the pass's block"), at(1, { height: floor }, "the pass's block")]);
    if (x.hash !== y.hash) throw new Error(`the RPCs' blocks at ${floor} differ (${x.hash}, ${y.hash}); the restore does not start`);
    if (opts.after !== undefined && floor <= opts.after) throw new Error(`the pass at block ${floor} is not past block ${opts.after}; read again once the chain is past it`);
    // the block's time, read now while both serve it: both headers name the agreed hash, and both times agree (one
    // provider's early time would end step 7's re-reads at once; delta review 6)
    let ms: number | null = null;
    if (readsBlocks(rpcs[0]) && readsBlocks(rpcs[1])) {
      // retried as the views (a 429, a node a block behind); the hash and time checks below refuse at once
      const hs = await Promise.all(rpcs.map((r) => headerRetried(r as BlockRpc, { block_id: floor }, "the pass's block", opts, true)));
      for (const [k, y] of hs.entries()) if (y === NO_BLOCK || y.hash !== x.hash) throw new Error(`${rpcs[k]!.name}: the pass's block ${floor} is not ${x.hash}; the restore does not start`);
      const [t0, t1] = hs as { ms: number }[];
      if (t0!.ms !== t1!.ms) throw new Error(`the RPCs' times of the restore's block ${floor} differ; the restore does not start`);
      ms = t0!.ms;
    }
    const pass: RestorePass = Object.freeze({ network, rpcs: Object.freeze([rpcs[0].name, rpcs[1].name]) as readonly [string, string], h: floor, hash: x.hash });
    PASSES.set(pass, Object.freeze({ rpcs: Object.freeze([rpcs[0], rpcs[1]] as const), ms }));
    return pass;
  })();
}

/**
 * Whether `pass` is one openRestorePass opened, and with `on` opened on that network and those very provider objects
 * (the owned steps of ./after.ts take only those; review R1).
 */
export function isRestorePass(pass: unknown, on?: { network: NearNetwork; rpcs: readonly [NearRpc, NearRpc] }): pass is RestorePass {
  const own = typeof pass === "object" && pass !== null ? PASSES.get(pass as RestorePass)?.rpcs : undefined;
  if (own === undefined) return false;
  return on === undefined || ((pass as RestorePass).network === on.network && own[0] === on.rpcs[0] && own[1] === on.rpcs[1]);
}

/** The pass's block time in ms, read once at its open (null: opened on providers that do not read blocks, or no pass). */
export function passTimeMs(pass: RestorePass): number | null {
  return PASSES.get(pass)?.ms ?? null;
}

// a pass openRestorePass gave, on this network and these very providers (review P2: by identity, never by name)
function pinOf(pass: RestorePass, network: NearNetwork, rpcs: readonly [NearRpc, NearRpc]): Block {
  const own = PASSES.get(pass)?.rpcs;
  if (own === undefined) throw new Error("the pass is not one openRestorePass opened");
  if (pass.network !== network || own[0] !== rpcs[0] || own[1] !== rpcs[1]) throw new Error("the pass was opened on other RPCs");
  return { h: pass.h, hash: pass.hash };
}

// review P1: a reader is built on a pass only while it is fresh: its block no more than VAULT_SYNC_LAG_MAX below the
// higher of both providers' finals now (as the pass's floor: a provider lying low never widens what passes as fresh;
// one lying high only stops the restore while it lies). An old pass reads a chain from before money landed, and nothing errors until
// the providers drop its block.
async function fresh(pass: RestorePass, rpcs: readonly [NearRpc, NearRpc], blockOf: (rpc: NearRpc, ask: Ask, what: string) => Promise<Block>): Promise<void> {
  const [a, b] = await Promise.all([blockOf(rpcs[0], "final", "the reader's final"), blockOf(rpcs[1], "final", "the reader's final")]);
  if (pass.h < Math.max(a.h, b.h) - VAULT_SYNC_LAG_MAX)
    throw new StalePass(`the pass at block ${pass.h} is stale: the RPCs' finals are at ${a.h} and ${b.h}, over ${VAULT_SYNC_LAG_MAX} blocks past it; open a fresh pass`);
}

/**
 * The IdReader of step 5 on the network's token and intents.near, through one FastNEAR RPC and the dRPC RPC of that
 * network (nearPairNetwork), in either order, every view at the pass's block (openRestorePass).
 */
export function nearIdReader(network: NearNetwork, rpcs: readonly [NearRpc, NearRpc], pass: RestorePass, opts: IdReaderOpts = {}): Promise<IdReader> {
  const { token, retried, first, blockOf } = setup(network, rpcs, opts);
  const at = pinOf(pass, network, rpcs);

  // the strongest answer one provider gives of U at the pass's block
  const readOn = async (rpc: NearRpc, u: string): Promise<IdState> => {
    const storage = (await retried(rpc, call(token, "storage_balance_of", { account_id: u }), "storage_balance_of", at)).v;
    if (storage !== null && !(isObj(storage) && typeof storage.total === "string" && DIGITS.test(storage.total))) throw new Error(`${rpc.name}: storage_balance_of: neither null nor a balance`);
    // an account with no storage on the token holds none of it (NEP-145): the balance is read only when registered
    if (storage !== null && amount((await retried(rpc, call(token, "ft_balance_of", { account_id: u }), "ft_balance_of", at)).v, `${rpc.name}: ft_balance_of`) > 0n) return "money";
    if ((await intentsSum(retried, rpc, u, at)) > 0n) return "money";
    if (storage !== null) return "used";
    return (await retried(rpc, { request_type: "view_account", account_id: u }, "view_account", at)).v === null ? "unused" : "used";
  };
  const RANK: Record<IdState, number> = { unused: 0, used: 1, money: 2 };

  const keep = opts.keep;
  return fresh(pass, rpcs, blockOf).then(() => {
    // answers kept from another pass are not this one's, but for those that last: used on both providers
    if (keep !== undefined && keep.pass !== pass) {
      for (const u of [...keep.answers.keys()]) if (!keep.lasting.has(u)) keep.answers.delete(u);
      keep.pass = pass;
      keep.rpcs = rpcs;
    }
    const read = async (u: string): Promise<IdState> => {
      if (typeof u !== "string" || !HEX64.test(u)) throw new Error("an id is a 64-hex implicit account id");
      const had = keep?.answers.get(u);
      if (had !== undefined) return had;
      const [x, both] = await readId(u);
      keep?.answers.set(u, x);
      if (both && x === "used") keep?.lasting.add(u);
      return x;
    };
    return read;
  });

  // the id's state, and whether it is both providers' own answer (not the indexer's)
  async function readId(u: string): Promise<[IdState, boolean]> {
    const a = first() === 0 ? 0 : 1;
    const order = [a, 1 - a];
    // both providers at once (each at its own pace)
    const got = await Promise.allSettled(order.map((p) => readOn(rpcs[p]!, u)));
    opts.signal?.throwIfAborted();
    const ok = got.flatMap((g, k) => (g.status === "fulfilled" ? [{ p: order[k]!, x: g.value }] : []));
    // both answered and differ: two providers at one block hash read the same state, so one of them is wrong; nothing
    // is concluded, and the provider with the stronger answer (the one that would read the lane on) is named
    if (ok.length === 2 && ok[0]!.x !== ok[1]!.x) {
      const [lo, hi] = RANK[ok[0]!.x] > RANK[ok[1]!.x] ? [ok[1]!, ok[0]!] : [ok[0]!, ok[1]!];
      throw new PairDisagrees(rpcs[hi.p]!.name, `${rpcs[hi.p]!.name} answered ${hi.x} where ${rpcs[lo.p]!.name} answered ${lo.x} at block ${at.h}: one of the pair is wrong at one block, so the restore stops`);
    }
    // every state needs both answers: money on one with the other failed is one provider's word, so the read fails
    // (step 5 counts a failed id as money all the same, and never lets one provider move the lane on)
    const failed = got.find((g): g is PromiseRejectedResult => g.status === "rejected");
    if (failed) throw failed.reason instanceof Error ? failed.reason : new Error("the read failed");
    const state = ok[0]!.x;
    if (state === "unused" && opts.indexer) {
      try {
        if ((await opts.indexer(u)) === true) return ["used", false];
      } catch {
        // a server's silence proves nothing
      }
    }
    return [state, true];
  }
}

/**
 * Step 5's reader on the restore's kept pass while it is fresh (a Retry reads on from the answers kept), else on a new
 * pass opened now on `make()`'s providers, with only the lasting answers kept (IdReadKeep). Every other refusal of the
 * kept pass is thrown.
 */
export async function keptIdReader(network: NearNetwork, make: () => readonly [NearRpc, NearRpc], keep: IdReadKeep, opts: PassOpts & IdReaderOpts = {}): Promise<{ rpcs: readonly [NearRpc, NearRpc]; pass: RestorePass; reader: IdReader }> {
  if (keep.rpcs !== undefined && keep.pass !== undefined) {
    try {
      return { rpcs: keep.rpcs, pass: keep.pass, reader: await nearIdReader(network, keep.rpcs, keep.pass, { ...opts, keep }) };
    } catch (e) {
      if (!(e instanceof StalePass)) throw e;
    }
  }
  const rpcs = make();
  const pass = await openRestorePass(network, rpcs, opts);
  return { rpcs, pass, reader: await nearIdReader(network, rpcs, pass, { ...opts, keep }) };
}

/** What intents.near holds for an account at the pass's block: the sum of its listed tokens (0 when none is listed). */
async function intentsSum(retried: Retried, rpc: NearRpc, a: string, at: Block): Promise<bigint> {
  const listed = (await retried(rpc, call(INTENTS, "mt_tokens_for_owner", { account_id: a }), "mt_tokens_for_owner", at)).v;
  if (!Array.isArray(listed) || !listed.every((t) => isObj(t) && typeof t.token_id === "string" && t.token_id !== "")) throw new Error(`${rpc.name}: mt_tokens_for_owner: not a token list`);
  if (listed.length === 0) return 0n;
  const ids = listed.map((t) => (t as { token_id: string }).token_id);
  const held = (await retried(rpc, call(INTENTS, "mt_batch_balance_of", { account_id: a, token_ids: ids }), "mt_batch_balance_of", at)).v;
  if (!Array.isArray(held) || held.length !== ids.length) throw new Error(`${rpc.name}: mt_batch_balance_of: not one balance per token`);
  return held.reduce((sum: bigint, x) => sum + amount(x, `${rpc.name}: mt_batch_balance_of`), 0n);
}

/** What an account holds on one read (restore/arms.ts BalanceReader): only above 0 matters to step 5. */
export type NearBalanceRead = "usdc" | "near" | "intents";

/**
 * Step 5's balance reads of R, V and A (./arms.ts restoreArmAccounts) on NEAR: "usdc" ft_balance_of on the network's
 * token, "near" the account's own NEAR (view_account; none is 0), "intents" the sum of what intents.near lists for it.
 * As nearIdReader: both providers at once, each at its pace, a busy one waited out, any other failure retried with
 * backoff; the balance needs both answers and the same one at the pass's block (card wallet-id-reader-paced): two that
 * differ throw PairDisagrees naming the higher, so a provider that hides money or fakes it never decides a balance,
 * and the read is listed unread (./arms.ts), never zero. A halt ("FiatToken: paused") fails the read.
 */
export function nearBalanceReader(network: NearNetwork, rpcs: readonly [NearRpc, NearRpc], pass: RestorePass, opts: Omit<IdReaderOpts, "indexer"> = {}): Promise<(what: NearBalanceRead, account: string) => Promise<bigint>> {
  const { token, retried, first, blockOf } = setup(network, rpcs, opts);
  const at = pinOf(pass, network, rpcs);
  const readOn = async (rpc: NearRpc, what: NearBalanceRead, a: string): Promise<bigint> => {
    if (what === "usdc") return amount((await retried(rpc, call(token, "ft_balance_of", { account_id: a }), "ft_balance_of", at)).v, `${rpc.name}: ft_balance_of`);
    if (what === "near") {
      const acct = (await retried(rpc, { request_type: "view_account", account_id: a }, "view_account", at)).v;
      return acct === null ? 0n : amount((acct as Obj).amount, `${rpc.name}: view_account`);
    }
    return intentsSum(retried, rpc, a, at);
  };
  return fresh(pass, rpcs, blockOf).then(() => async (what: NearBalanceRead, a: string): Promise<bigint> => {
    if (what !== "usdc" && what !== "near" && what !== "intents") throw new Error(`unknown read ${String(what)}`);
    if (typeof a !== "string" || !HEX64.test(a)) throw new Error("an account is a 64-hex implicit account id");
    const x = first() === 0 ? 0 : 1;
    // both providers at once, and both must answer the same: one block, one balance
    const order = [x, 1 - x];
    const got = await Promise.allSettled(order.map((p) => readOn(rpcs[p]!, what, a)));
    opts.signal?.throwIfAborted();
    const ok = got.flatMap((g, k) => (g.status === "fulfilled" ? [{ p: order[k]!, v: g.value }] : []));
    if (ok.length === 2 && ok[0]!.v !== ok[1]!.v) {
      const [lo, hi] = ok[0]!.v > ok[1]!.v ? [ok[1]!, ok[0]!] : [ok[0]!, ok[1]!];
      throw new PairDisagrees(rpcs[hi.p]!.name, `${rpcs[hi.p]!.name} answered ${hi.v} where ${rpcs[lo.p]!.name} answered ${lo.v} at block ${at.h}: one of the pair is wrong at one block`);
    }
    const failed = got.find((g): g is PromiseRejectedResult => g.status === "rejected");
    if (failed) throw failed.reason instanceof Error ? failed.reason : new Error("the read failed");
    return ok[0]!.v;
  });
}
