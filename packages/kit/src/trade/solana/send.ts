// The Solana set send (markets paper T2.1 "Sending" and LD2, docs/plan1/markets.md l.93 and l.336-346; row M1.3).
// Device side. It carries only bytes the device already signed: it holds no key, builds no transaction and changes no
// byte. Signed bytes cannot be altered by whoever carries them and the first copy to land wins, so every path gets
// the same bytes and no single path can hold a trade back (LD2).
//
// - Send: in the first tick, before sendSolanaSet returns, every tx goes to every RPC path that its URL's queue lets
//   start now (a public RPC, and the helper's `/v1/rpc/solana` `sendTransaction` when the app has a helper; see the
//   provider queue below: 40 a method in any 10 s keyless, so a set of 40 all goes at once),
//   and one tx to each 1-request-a-second path whose URL has had no request in the last second (keyless Helius Sender
//   `/fast?swqos_only=true` gets the set's first tx, the Jito block engine `/api/v1/transactions` its second; both
//   limits count refused requests too). A path that is down, refusing or slow is recorded and holds nothing back.
// - Rebroadcast: every SOLANA_REBROADCAST_MS (2 s, the paper's DESIGN interval from P4S) on the unlimited paths; on
//   each 1-rps URL one request a second, shared by every set in flight on this page (one pacer per URL), each set
//   rotating through its undecided txs. A tx is never sent again once it is decided, or
//   once both providers' finalized height is past its lastValidBlockHeight and both read its blockhash as no longer
//   valid at `processed` (06c §3.4).
// - Fill: read on two providers (the same [A, B] pair the quote checks read, checks/solana/checks.ts SolanaQuoteReads;
//   §2.0 LD1: at least one device-direct, the second may be the helper's /v1/rpc), never the same one twice. A tx is
//   filled only when both have read it at `confirmed` or `finalized` with no error, failed only when both read it
//   landed with an error. Dead (expired) follows 06c A4 (06c-chain-adapters.md l.98), on each provider: its finalized
//   height past lastValidBlockHeight, its blockhash read valid and then, from a bank at or above that one, no longer
//   valid at `processed` (so a lowered lastValidBlockHeight from whoever built the tx cannot make a live tx look dead;
//   valid first, because Agave answers false alike for an expired hash and for one its bank does not hold yet,
//   accounts-db blockhash_queue.rs:98-108 at v4.3.2), and then a status read with searchTransactionHistory: true
//   (so a landing older than the status cache's 300 roots is still found) that has no signature, taken from a bank at
//   or past the slot the height and the blockhash check were read at (so a node behind a load balancer that has not
//   replayed the landing block cannot answer it). Anything else, one provider's word included, decides nothing; at
//   the deadline it stays "unknown", which the caller must re-read before it moves money on, never a fill and never
//   dead.
//
// Every answer from a path or a provider is hostile input: it is size-bounded, shape-checked, and an answer that fails
// a check counts as no answer. A provider answering 429 is backed off, up to 8 s; a 429 is no answer.
import { base58, base64 } from "@scure/base";
import { HELPER_FETCH_INIT, HELPER_V1_PREFIX } from "../../helper/v1.ts";
import { SOLANA_MAX_TX_BYTES, solanaDecodeTransaction } from "../../checks/solana/message.ts";
import { SOLANA_SYSTEM_PROGRAM } from "../../checks/solana/checks.ts";
import { deepFreeze } from "../../freeze.ts";

// Helius Sender, the global HTTPS endpoint with the SWQoS-only route: https://www.helius.dev/docs/sending-transactions/sender.md
// ("https://sender.helius-rpc.com/fast # Global HTTPS endpoint", which "resolves CORS preflight failures ... with
// browser-based applications"; "Add `?swqos_only=true` to any endpoint URL"; keyless "limited to 1 request per second").
// Its preflight answered Access-Control-Allow-Origin: * between 2026-11-02 01:54Z and 01:57Z (date -u before and after the read).
export const SOLANA_SENDER_FAST_URL = "https://sender.helius-rpc.com/fast?swqos_only=true";
// The Jito block engine's sendTransaction: https://docs.jito.wtf/lowlatencytxnsend/ ("this method always sets
// skip_preflight=true"; its examples send params [tx, { encoding }] only). Its preflight from the app's origin answered
// that origin between 2026-11-02 01:54Z and 01:57Z (date -u before and after the read).
export const SOLANA_JITO_TRANSACTIONS_URL = "https://mainnet.block-engine.jito.wtf/api/v1/transactions";
// The public mainnet RPC: https://solana.com/docs/references/clusters (100 requests per 10 s per IP). Its preflight
// from the app's origin answered that origin between 2026-11-02 01:54Z and 01:57Z (date -u before and after the read).
export const SOLANA_PUBLIC_RPC_URL = "https://api.mainnet-beta.solana.com";

/** The paper's rebroadcast interval (T2.1, DESIGN from P4S). */
export const SOLANA_REBROADCAST_MS = 2_000;
/** Keyless Helius Sender and the Jito block engine each take 1 request a second per IP, refused ones included
 * (helius.dev/docs/sending-transactions/sender.md "Keyless requests are limited to 1 request per second";
 * docs.jito.wtf/lowlatencytxnsend "1 request per second per IP per region"). */
export const SOLANA_KEYLESS_PATH_INTERVAL_MS = 1_000;
/** How often the fill is read on each provider: about two slots (mainnet slots ran about 212 ms on 2026-11-02, the
 * reviewer's getRecentPerformanceSamples read). A read still open when the next is due is not stacked. */
export const SOLANA_STATUS_POLL_MS = 400;
/** One path call or provider read is given up after this. */
export const SOLANA_CALL_TIMEOUT_MS = 5_000;
/** The set is given up after this, its undecided txs "unknown". A blockhash lives 150 blocks, about 32 s at 212 ms
 * slots, and a finalized height trails the tip by about 32 slots, so a tx with no verdict by then needs a fresh read. */
export const SOLANA_SET_DEADLINE_MS = 120_000;
/** An answer larger than this is refused unread. A status or send answer is well under 64 KiB for a set of 256. */
export const SOLANA_ANSWER_MAX_BYTES = 1024 * 1024;
/** Agave answers getLatestBlockhash with lastValidBlockHeight = the bank's block height + MAX_PROCESSING_AGE (150)
 * for the bank's own latest blockhash, so the finalized bank's height is that minus 150, from the same bank as its
 * context.slot. */
const MAX_PROCESSING_AGE = 150;
/** A provider answering 429 waits 1 s, then twice as long each time, up to this. */
const BACKOFF_MAX_MS = 8_000;
/** A provider's limit: at most `total` calls, and at most `perMethod` calls of one method, starting in any `windowMs`. */
export type SolanaRpcLimit = { readonly windowMs: number; readonly total: number; readonly perMethod: number };
/** A keyless provider's limit: Solana's public RPC allows 100 requests per 10 s per IP, and 40 per 10 s for one method
 * (solana.com/docs/references/clusters.md, read 2026-10-25); PublicNode publishes no number and is held to the same. */
export const SOLANA_KEYLESS_RPC_LIMIT: SolanaRpcLimit = { windowMs: 10_000, total: 100, perMethod: 40 };
deepFreeze(SOLANA_KEYLESS_RPC_LIMIT);
/** A keyed provider named by its requests a second: that many in any second, of all methods. */
export const solanaRpsLimit = (rps: number): SolanaRpcLimit => ({ windowMs: 1_000, total: rps, perMethod: rps });

// One queue per provider, shared by every call the kit makes on it: a trade's reads, simulations, re-reads, fill reads,
// settle reads and every teardown's, the sends on an RPC path, and any other set or trade in flight on the same
// provider. Keyed on the provider's URL (the limit is the provider's, per caller IP), or on its own function when it has
// none, so a provider wrapped by solanaPacedRpc and the same provider passed bare share one queue. Every limit named for
// the provider is kept and each call fits all of them, so the strictest holds whoever names it. Calls of one method start
// in the order they asked (first in, first out, so no caller starves another), each at the first time the limits allow:
// a method whose budget is spent waits alone, and the others go on, the total still counted over all methods.
// Each call is a slot: reserved at the first time the limits allow after the slot of its method before it, then checked
// again when its time comes against the calls that really started, and started then or later (a busy page starts a
// timer late, and the limits hold on the times the calls went out).
type RpcSlot = { t: number; method: string; started: boolean };
// fillSteady: when each steady fill read (past its set's burst, fillPool) went out on the provider, by every set on it.
type RpcQueue = { lastOf: Map<string, number>; slots: RpcSlot[]; limits: Map<string, SolanaRpcLimit>; fillSteady: number[] };
const queueOfUrl = new Map<string, RpcQueue>();
const queueOfFn = new WeakMap<SolanaRpc, RpcQueue>();
const bareOf = new WeakMap<SolanaRpc, SolanaRpc>();
// The queue whose slot is making its call in this tick. A slot calls the outermost wrapper it was given (a caller's
// fault watch runs under pacing), never the bare provider; a paced wrapper on that queue called inside it (paced again,
// or under a caller's wrapper) is that slot's own call, sent at once, never queued behind the slot it runs in.
let inSlot: RpcQueue | null = null;
const WINDOW_MAX_MS = 60_000;
// The queue's clock: monotonic, so a step of the wall clock (an NTP fix, a user changing the time) can never make the
// calls in a window look older than they are and let one more through.
const queueNow = (): number => performance.now();
// A URL as one key whatever its spelling (a trailing slash, the case of the host), so one provider is one queue.
const urlKeys = new Map<string, string>();
function urlKey(u: string): string {
  let k = urlKeys.get(u);
  if (k === undefined) {
    try { k = new URL(u).href; } catch { k = u; }
    if (urlKeys.size < 10_000) urlKeys.set(u, k);
  }
  return k;
}
/** The first time at or after `from` that a call of `method` fits every limit beside `slots`. Times are whole ms, so a
 * window is held 1 ms longer: a call at 0.9 ms and one at 1000.0 ms are in one second on a finer clock. */
function fitsAt(slots: readonly RpcSlot[], limits: Iterable<SolanaRpcLimit>, method: string, from: number): number {
  let t = from;
  const all = slots.map((x) => x.t).sort((x, y) => x - y);
  const same = slots.filter((x) => x.method === method).map((x) => x.t).sort((x, y) => x - y);
  for (const limit of limits) {
    if (all.length >= limit.total) t = Math.max(t, all[all.length - limit.total]! + limit.windowMs + 1);
    if (same.length >= limit.perMethod) t = Math.max(t, same[same.length - limit.perMethod]! + limit.windowMs + 1);
  }
  return t;
}
/** The provider's queue, with this limit named in it: named as soon as a caller holds the provider under it (a paced
 * wrapper made, a set or trade started), so the strictest limit binds every caller's calls from then, before its own. */
function queueWith(rpc: SolanaRpc, limit: SolanaRpcLimit): RpcQueue {
  if (![limit?.windowMs, limit?.total, limit?.perMethod].every((x) => typeof x === "number" && Number.isSafeInteger(x) && x > 0) || limit.windowMs > WINDOW_MAX_MS) throw new Error("a provider's limit must be whole numbers above 0, its window at most 60 s");
  const bare = bareOf.get(rpc) ?? rpc;
  let q = bare.url === undefined ? queueOfFn.get(bare) : queueOfUrl.get(urlKey(bare.url));
  if (!q) {
    q = { lastOf: new Map(), slots: [], limits: new Map(), fillSteady: [] };
    if (bare.url === undefined) queueOfFn.set(bare, q);
    else queueOfUrl.set(urlKey(bare.url), q);
  }
  q.limits.set(`${limit.windowMs}/${limit.total}/${limit.perMethod}`, { windowMs: limit.windowMs, total: limit.total, perMethod: limit.perMethod });
  return q;
}
function rpcSlot(rpc: SolanaRpc, limit: SolanaRpcLimit, method: string): { run: (params: readonly unknown[]) => Promise<unknown>; wait: Promise<void> | null; drop: () => void } {
  const queue = queueWith(rpc, limit);
  const now = queueNow();
  queue.slots = queue.slots.filter((x) => !x.started || x.t > now - WINDOW_MAX_MS);
  const slot: RpcSlot = { t: fitsAt(queue.slots, queue.limits.values(), method, Math.max(now, queue.lastOf.get(method) ?? 0)), method, started: false };
  queue.lastOf.set(method, slot.t);
  queue.slots.push(slot);
  // How long until the calls that really went out leave room for this one (0: now).
  const room = (): number => {
    const at = queueNow();
    return fitsAt(queue.slots.filter((x) => x.started), queue.limits.values(), method, at) - at;
  };
  // The call itself: checked against the calls that went out, then marked started and sent in the same tick, so no
  // other call is let through on a start time this one has not kept (a caller that runs it late waits again).
  const run = (params: readonly unknown[]): Promise<unknown> => {
    const ms = room();
    if (ms > 0) return new Promise<void>((r) => setTimeout(r, ms)).then(() => run(params));
    slot.t = queueNow();
    slot.started = true;
    const was = inSlot;
    inSlot = queue;
    // Stamped again once the call has been handed over: a pause in between (a GC, a slow tick) then makes the call look
    // later, never earlier, than when it left this queue, so the window this queue counts never starts too soon.
    try {
      return rpc(method, params);
    } finally {
      inSlot = was;
      slot.t = queueNow();
    }
  };
  // A turn its caller gives up on before the call starts (the set is over; never a started one): taken out of the
  // queue, so it holds back no later call and the queue keeps no slot for it.
  const drop = (): void => {
    queue.slots = queue.slots.filter((x) => x !== slot);
    const last = queue.slots.filter((x) => x.method === method).reduce((m, x) => Math.max(m, x.t), -Infinity);
    if (last === -Infinity) queue.lastOf.delete(method);
    else queue.lastOf.set(method, last);
  };
  if (slot.t <= now && room() <= 0) return { run, wait: null, drop };
  return {
    run,
    drop,
    wait: new Promise<void>((resolve) => {
      const go = () => { const ms = room(); if (ms <= 0) resolve(); else setTimeout(go, ms); };
      setTimeout(go, Math.max(0, slot.t - now));
    }),
  };
}
/** How long a call of `method` on the provider would wait if asked now (0: it starts at once, behind no call of the
 * method that waits there); it asks nothing and books nothing. */
function methodWaitMs(rpc: SolanaRpc, limit: SolanaRpcLimit, method: string): number {
  const queue = queueWith(rpc, limit);
  const now = queueNow();
  return Math.max(0, fitsAt(queue.slots, queue.limits.values(), method, Math.max(now, queue.lastOf.get(method) ?? 0)) - now);
}
// The fill poll's share of a provider's budget for getSignatureStatuses, B calls in any window W (keyless: 40 in 10 s;
// one signature a read, so no request links two of the user's wallets: n txs cost n reads a round). Counted, not timed,
// so a fast round trip spends no more:
// - each set's first C = B/5 reads are its burst (keyless 8), spaced by pollMs over its open txs and spread over at
//   least FILL_BURST_MS (most txs land within it): a 3-tx sell landing 0.8 s in is read filled about 0.6 s after;
// - after it, the set reads no faster than the steady pool, B - 2C in any W (keyless 24, one read every 417 ms), and
//   every set's steady reads on the provider share that one pool (RpcQueue.fillSteady);
// - so a set's own reads in any window are at most C + (B - 2C) = B - C, and with every steady read held to B - 2C
//   at least C stay free for a set that starts later: its whole burst goes at once, whatever ran before (two at once
//   once the older set's burst has left the window).
// A lone open tx of an n-tx set is read again at least every n x max(pollMs / n, W / (B - 2C)) plus the round trip
// (keyless, 9 txs: 3.75 s; 3 txs: 1.25 s; 1 tx: 0.42 s).
const FILL_BURST_MS = 1_600;
const fillBurst = (l: SolanaRpcLimit): number => Math.max(1, Math.floor(l.perMethod / 5));
const fillPool = (l: SolanaRpcLimit): number => Math.max(1, l.perMethod - 2 * fillBurst(l));
/** Provider A's and B's requests a second when keyed; undefined in a place holds that provider to the keyless limit. */
export type SolanaProviderRps = readonly [number | undefined, number | undefined];
/** Each provider's limit: its requests a second when the caller names them (a keyed provider), else the keyless one. */
export function solanaProviderLimits(providerRps?: SolanaProviderRps): readonly [SolanaRpcLimit, SolanaRpcLimit] {
  if (providerRps === undefined) return [SOLANA_KEYLESS_RPC_LIMIT, SOLANA_KEYLESS_RPC_LIMIT];
  if (!Array.isArray(providerRps) || providerRps.length !== 2 || !providerRps.every((r) => r === undefined || (Number.isSafeInteger(r) && r > 0))) throw new Error("providerRps must be two whole numbers above 0, or undefined for a keyless provider");
  const one = (r: number | undefined) => (r === undefined ? SOLANA_KEYLESS_RPC_LIMIT : solanaRpsLimit(r));
  return [one(providerRps[0]), one(providerRps[1])];
}
/** Whether two providers are the same one: the same function under any wrapping, or the same URL. */
export function solanaSameProvider(a: SolanaRpc, b: SolanaRpc): boolean {
  return (bareOf.get(a) ?? a) === (bareOf.get(b) ?? b) || (a.url !== undefined && b.url !== undefined && urlKey(a.url) === urlKey(b.url));
}
/** `call` as the provider `rpc` under a wrapper of the caller's (a fault watch): the same provider to
 *  solanaSameProvider and in the same shared queue, its URL carried. `call` calls the provider once, synchronously: a
 *  paced call of the same queue made synchronously inside a slot's call is that slot's own, so a second one would go
 *  out on the first one's turn, past the queue. */
export function solanaWrappedRpc(rpc: SolanaRpc, call: (method: string, params: readonly unknown[]) => Promise<unknown>): SolanaRpc {
  const bare = bareOf.get(rpc) ?? rpc;
  const out: SolanaRpc = rpc.url === undefined ? call : Object.assign(call, { url: rpc.url });
  bareOf.set(out, bare);
  return out;
}
/** The provider with every call in its shared queue (SOLANA_KEYLESS_RPC_LIMIT when no limit is named). */
export function solanaPacedRpc(rpc: SolanaRpc, limit: SolanaRpcLimit = SOLANA_KEYLESS_RPC_LIMIT): SolanaRpc {
  const bare = bareOf.get(rpc) ?? rpc;
  const queue = queueWith(bare, limit);
  const paced = (method: string, params: readonly unknown[]): Promise<unknown> => {
    if (inSlot === queue) return rpc(method, params);
    const s = rpcSlot(rpc, limit, method);
    // a call its limit allows now starts in this tick, as the bare provider's would
    return s.wait ? s.wait.then(() => s.run(params)) : s.run(params);
  };
  const out: SolanaRpc = bare.url === undefined ? paced : Object.assign(paced, { url: bare.url });
  bareOf.set(out, bare);
  return out;
}
/** The provider with each call timed out `ms` after it goes out, never counting its wait for a turn (card
 *  solana-release-reads-paced): when a caller holds the provider under a limit (a paced wrapper made, a set or trade
 *  started), every call takes its turn in the provider's shared queue under the limits named there, naming none of its
 *  own; a provider no caller paces is called as given. The provider is called synchronously inside its turn, so a paced
 *  wrapper given here is that turn's own call, never queued twice. `ms` as a function is asked when the turn comes (a
 *  throw there ends the call unsent, its error the call's); `late` makes the timeout's error (the caller's own type). */
export function solanaTimedRpc(rpc: SolanaRpc, ms: number | (() => number), late?: (ms: number) => Error): SolanaRpc {
  const timed = solanaWrappedRpc(rpc, (method, params) => {
    let p: Promise<unknown>;
    let bound: number;
    try {
      bound = typeof ms === "function" ? ms() : ms;
      p = Promise.resolve(rpc(method, params));
    } catch (e) {
      return Promise.reject(e);
    }
    return withTimeout(p, bound, late);
  });
  const bare = bareOf.get(rpc) ?? rpc;
  const queue = bare.url === undefined ? queueOfFn.get(bare) : queueOfUrl.get(urlKey(bare.url));
  const named = queue?.limits.values().next().value;
  return named ? solanaPacedRpc(timed, named) : timed;
}

export type SolanaFetch = (url: string, init: RequestInit) => Promise<Response>;
/** One JSON-RPC call on one Solana provider: resolves the call's `result`, rejects on any other answer. `url`, when
 * set (solanaJsonRpc sets it), is what tells two providers apart; the set send refuses two with the same one. */
export type SolanaRpc = ((method: string, params: readonly unknown[]) => Promise<unknown>) & { readonly url?: string };
/** One send path: posts the base64 bytes, resolves the signature the path answered. A path with `minIntervalMs` gets
 * one tx per that interval, rotating through the set; one without gets every tx every rebroadcast. */
export type SolanaSendPath = {
  readonly name: string;
  readonly send: (base64Tx: string) => Promise<string>;
  readonly minIntervalMs?: number;
  /** Paths with the same paceKey (the URL, for solanaSendPaths' own) share one pacer across every set in flight. */
  readonly paceKey?: string;
};
/** A tx the device signed, and the lastValidBlockHeight of its blockhash from the device's own getLatestBlockhash. */
export type SolanaSignedTx = { readonly wire: Uint8Array; readonly lastValidBlockHeight: number };

export type SolanaSendAttempt = { path: string; attempt: number; ok: boolean; ms: number; error?: string };
export type SolanaTxState = "filled" | "failed" | "expired" | "unknown";
export type SolanaTxOutcome = {
  signature: string;
  state: SolanaTxState;
  /** The landed slot as provider A read it, when filled or failed. */
  slot?: number;
  /** Each provider's error, when failed. */
  err?: readonly [unknown, unknown];
  /** From the first send to the read that decided it. */
  ms?: number;
  sends: SolanaSendAttempt[];
};
export type SolanaSetResult = { txs: SolanaTxOutcome[] };
export type SolanaSetHandle = {
  readonly signatures: readonly string[];
  readonly done: Promise<SolanaSetResult>;
  /** Stops every send and read now; undecided txs end "unknown". */
  stop(): void;
};
export type SolanaSetOptions = {
  readonly paths: readonly SolanaSendPath[];
  /** Provider A (device-direct) and provider B, as the quote checks read them. */
  readonly providers: readonly [SolanaRpc, SolanaRpc];
  readonly rebroadcastMs?: number;
  readonly pollMs?: number;
  readonly deadlineMs?: number;
  readonly callTimeoutMs?: number;
  /** A keyed provider's requests a second, every call on it counted, this set's and every other caller's; a provider
   * not named here (absent, or undefined in its place) is held to SOLANA_KEYLESS_RPC_LIMIT. */
  readonly providerRps?: SolanaProviderRps;
};

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e).slice(0, 200);

function withTimeout<T>(p: Promise<T>, ms: number, late?: (ms: number) => Error): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(late ? late(ms) : new Error(`no answer in ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
}

async function readBounded(r: Response): Promise<string> {
  if (Number(r.headers.get("content-length") ?? "0") > SOLANA_ANSWER_MAX_BYTES) throw new Error("answer too large");
  if (!r.body) return "";
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > SOLANA_ANSWER_MAX_BYTES) {
      void reader.cancel().catch(() => {});
      throw new Error("answer too large");
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}

function httpsUrl(raw: string, what: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`${what} must be an https URL`); }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error(`${what} must be an https URL`);
  if (u.username || u.password || u.hash) throw new Error(`${what} must carry no credentials or fragment`);
  return u;
}

let nextId = 1;

/** A JSON-RPC client's retry of transport faults (card signpage-rpc-throttle-retry): the call ends within `deadlineMs` of
 * its start, waits and attempts counted; an attempt may take all the time left (a slow answer inside it lands, as the
 * client without retry takes it), and no wait is begun that would end past it. A wait is `backoffMs` doubled per try,
 * or the provider's Retry-After when that is longer (a Retry-After of 0 still waits the backoff). */
export type SolanaRpcRetry = { readonly deadlineMs: number; readonly backoffMs: number };
/** The signing page's: a pool buy reads the venue and then the blockhash (its slot the device's own) after the reference,
 * so two calls at their deadline (7 s) stay inside SOLANA_POOL_QUOTE_MAX_AGE_SLOTS (25) at a slot of 360 ms (9 s; the
 * cluster's target is 400 ms, agave sdk clock.rs DEFAULT_MS_PER_SLOT), and the quote rule never sees a retry age it. */
export const SOLANA_RPC_RETRY: SolanaRpcRetry = Object.freeze({ deadlineMs: 3_500, backoffMs: 250 });
/** A fault the retry takes: HTTP 429 or 5xx, a JSON-RPC throttle (RPC_THROTTLE_CODES) in a 200, an answer that is not JSON,
 * an attempt with no answer in time, or no connection. */
export type SolanaRpcFault = "http_429" | "http_5xx" | "rpc_throttled" | "not_json" | "timeout" | "network";
/** A call whose transport faults outlasted its retry: the fault named, with the tries and the provider's host. */
export class SolanaRpcTransportError extends Error {
  readonly fault: SolanaRpcFault;
  readonly tries: number;
  readonly host: string;
  /** The last answer's Retry-After in ms, when it named one: a caller that asks the provider again waits at least this. */
  readonly afterMs: number | null;
  constructor(fault: SolanaRpcFault, detail: string, tries: number, host: string, afterMs: number | null = null) {
    super(`${detail} (${fault}, ${tries} ${tries === 1 ? "try" : "tries"} at ${host})`);
    this.name = "SolanaRpcTransportError";
    this.fault = fault;
    this.tries = tries;
    this.host = host;
    this.afterMs = afterMs;
  }
}
/** The JSON-RPC throttle codes a provider may answer inside an HTTP 200: -32029 and -32429 (the card's brief), -429 and
 * dRPC's 15 "You reached Public endpoint rate limit" (the answers recorded in scripts/live-checks/vault-testnet-t02.mjs
 * and scripts/ci/money-gate.mjs). */
const RPC_THROTTLE_CODES: ReadonlySet<number> = new Set([-32029, -32429, -429, 15]);
/** A transport fault inside one attempt; `orig` is what the call rejected with before the retry (and still does without it). */
class Fault extends Error {
  readonly fault: SolanaRpcFault;
  readonly afterMs: number | null;
  readonly orig: unknown;
  constructor(fault: SolanaRpcFault, detail: string, orig: unknown, afterMs: number | null = null) {
    super(detail);
    this.fault = fault;
    this.afterMs = afterMs;
    this.orig = orig;
  }
}
const timedOut = (e: unknown): boolean => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
/** ": RPC error <code>: <message>" when `text` is a JSON-RPC error object, else "". */
function rpcErrorWords(text: string): string {
  try {
    const e = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown; data?: unknown } } | null)?.error;
    return e && typeof e === "object" && (typeof e.code === "number" || typeof e.message === "string") ? `: ${rpcErrorText(e)}` : "";
  } catch {
    return "";
  }
}
/** A JSON-RPC error's words: its code, its message and, when it is text, its data, where a provider may name its cap
 *  (base.gateway.tenderly.co: message "invalid params", data "Block range too large: maximum 1000 blocks without an
 *  access key. ...", read 2026-11-09 19:43Z; review of 39a4c67a, P3-4). Each part bounded. */
function rpcErrorText(e: { code?: unknown; message?: unknown; data?: unknown } | null): string {
  const data = typeof e?.data === "string" && e.data !== "" ? `: ${e.data.slice(0, 200)}` : "";
  return `RPC error ${String(e?.code)}: ${String(e?.message).slice(0, 120)}${data}`;
}
/** Retry-After in ms: delta-seconds or an HTTP date (RFC 9110 10.2.3); null when absent or unreadable. */
function retryAfterMs(h: string | null, now: number): number | null {
  if (h === null || h.trim() === "") return null;
  const t = h.trim();
  if (/^\d{1,6}$/.test(t)) return Number(t) * 1000;
  const at = Date.parse(t);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** JSON-RPC over HTTP POST to one URL. `init` is merged into every request (the helper's HELPER_FETCH_INIT). The id is
 * a string of digits, so an echo of it as the string or as the same number both match, and nothing else does. With
 * `retry`, a transport fault (SolanaRpcFault) is tried again within its bounds and then rejects as a
 * SolanaRpcTransportError; any other answer (an RPC error, a foreign id, no result, a 4xx) rejects at once. */
export function solanaJsonRpc(url: string, opts: { fetch?: SolanaFetch; init?: RequestInit; timeoutMs?: number; retry?: SolanaRpcRetry } = {}): SolanaRpc {
  const href = httpsUrl(url, "an RPC URL").href;
  const host = new URL(href).host;
  const doFetch: SolanaFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? SOLANA_CALL_TIMEOUT_MS;
  const retry = opts.retry;
  const once = (method: string, params: readonly unknown[], ms: number): Promise<unknown> => {
    const id = String(nextId++);
    const init: RequestInit = {
      ...opts.init,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(ms),
    };
    // fetch is called here, synchronously: a caller that starts several calls starts them all in one tick.
    return doFetch(url, init).then(
      async (r) => {
        let text: string;
        try {
          text = await readBounded(r);
        } catch (e) {
          if (e instanceof Error && e.message === "answer too large") throw e;
          throw new Fault(timedOut(e) ? "timeout" : "network", timedOut(e) ? `no answer in ${ms} ms` : "the answer broke off", e);
        }
        if (r.status === 429) throw new Fault("http_429", "HTTP 429", new Error("HTTP 429"), retryAfterMs(r.headers.get("retry-after"), Date.now()));
        if (r.status >= 500 && r.status <= 599) throw new Fault("http_5xx", `HTTP ${r.status}`, new Error(`HTTP ${r.status}`), retryAfterMs(r.headers.get("retry-after"), Date.now()));
        // a refusal's own words, when its body is a JSON-RPC error, after the status: a provider's range cap (dRPC answers
        // its cap as HTTP 400, code 35 "ranges over 10000 blocks are not supported on free plan", read 4 Nov 12:41Z) is
        // then told apart from any other 400; the "HTTP <status>" start every caller matches stays
        if (!r.ok) throw new Error(`HTTP ${r.status}${rpcErrorWords(text)}`);
        let j: unknown;
        try {
          j = JSON.parse(text) as unknown;
        } catch (e) {
          throw new Fault("not_json", "not a JSON answer", e);
        }
        if (typeof j !== "object" || j === null || Array.isArray(j)) throw new Error("not a JSON-RPC answer");
        const o = j as Record<string, unknown>;
        if (!(o.id === id || (typeof o.id === "number" && String(o.id) === id))) throw new Error(`answer id ${JSON.stringify(o.id)} is not request id ${id}`);
        if (o.error !== undefined) {
          const e = o.error as { code?: unknown; message?: unknown; data?: unknown } | null;
          const msg = rpcErrorText(e);
          if (typeof e?.code === "number" && RPC_THROTTLE_CODES.has(e.code)) throw new Fault("rpc_throttled", msg, new Error(msg));
          throw new Error(msg);
        }
        if (!("result" in o)) throw new Error("no result");
        return o.result;
      },
      (e: unknown) => {
        throw new Fault(timedOut(e) ? "timeout" : "network", timedOut(e) ? `no answer in ${ms} ms` : "no connection", e);
      },
    );
  };
  // without `retry`, one attempt, its faults as plain errors (the kit's own send paths and the helper keep their rules)
  const plain = (method: string, params: readonly unknown[]): Promise<unknown> =>
    once(method, params, timeoutMs).catch((e: unknown) => {
      throw e instanceof Fault ? e.orig : e;
    });
  const call = !retry
    ? plain
    : (method: string, params: readonly unknown[]): Promise<unknown> => {
        const start = Date.now();
        const end = start + retry.deadlineMs;
        const go = async (tries: number): Promise<unknown> => {
          const left = end - Date.now();
          try {
            return await once(method, params, Math.max(1, Math.min(timeoutMs, left)));
          } catch (e) {
            if (!(e instanceof Fault)) throw e;
            // the backoff is a floor: a Retry-After of 0 never makes a throttled call a burst
            const waitMs = Math.max(e.afterMs ?? 0, retry.backoffMs * 2 ** (tries - 1));
            // a wait that ends past the deadline is not begun: the call answers now, its fault named
            if (Date.now() + waitMs >= end) throw new SolanaRpcTransportError(e.fault, e.message, tries, host, e.afterMs);
            await new Promise((res) => setTimeout(res, waitMs));
            return go(tries + 1);
          }
        };
        return go(1);
      };
  return Object.assign(call, { url: href });
}

/** The helper's POST /v1/rpc/solana (helper/v1.ts HELPER_RPC_METHODS: sendTransaction, getSignatureStatuses,
 * getLatestBlockhash and isBlockhashValid are on its list), with the kit's HELPER_FETCH_INIT. `origin` is the helper's origin only. */
export function solanaHelperRpc(origin: string, opts: { fetch?: SolanaFetch; timeoutMs?: number; retry?: SolanaRpcRetry } = {}): SolanaRpc {
  const u = httpsUrl(origin, "the helper origin");
  if (u.pathname !== "/" || u.search !== "" || !(origin === u.origin || origin === `${u.origin}/`)) throw new Error("the helper origin must be an origin only");
  return solanaJsonRpc(`${u.origin}${HELPER_V1_PREFIX}/rpc/solana`, { ...opts, init: HELPER_FETCH_INIT });
}

const SEND_CONFIG = { encoding: "base64", skipPreflight: true, maxRetries: 0 } as const;

function rpcPath(name: string, rpc: SolanaRpc, config: Record<string, unknown>, minIntervalMs?: number): SolanaSendPath {
  return {
    name,
    ...(minIntervalMs === undefined ? {} : { minIntervalMs, ...(rpc.url ? { paceKey: rpc.url } : {}) }),
    send: (b64) => solanaPacedRpc(rpc)("sendTransaction", [b64, config]).then((sig) => {
      if (typeof sig !== "string") throw new Error("the path answered no signature");
      return sig;
    }),
  };
}

/**
 * The paper's send paths: Sender, Jito and a public RPC from the device, keyless, and the helper's keyed send when
 * the app has a helper. With no helper the set goes on three paths; nothing waits for a fourth.
 */
export function solanaSendPaths(opts: { helper?: SolanaRpc | null; rpcUrl?: string; fetch?: SolanaFetch; timeoutMs?: number } = {}): SolanaSendPath[] {
  const o = { ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) };
  const paths = [
    rpcPath("sender", solanaJsonRpc(SOLANA_SENDER_FAST_URL, o), SEND_CONFIG, SOLANA_KEYLESS_PATH_INTERVAL_MS),
    rpcPath("jito", solanaJsonRpc(SOLANA_JITO_TRANSACTIONS_URL, o), { encoding: "base64" }, SOLANA_KEYLESS_PATH_INTERVAL_MS),
    rpcPath("rpc", solanaJsonRpc(opts.rpcUrl ?? SOLANA_PUBLIC_RPC_URL, o), SEND_CONFIG),
  ];
  if (opts.helper) paths.push(rpcPath("helper", opts.helper, SEND_CONFIG));
  return paths;
}

// One pacer per 1-rps URL (or per path object without a paceKey), shared by every set in flight: at most one request
// per interval, each turn going to the next set that has a tx to send. A request is never sent sooner than one
// interval after the last; a set that joins a pacer idle for an interval sends at once.
type PaceClient = () => (() => void) | null;
type Pacer = {
  interval: number;
  last: number;
  idleUntil: number;
  clients: PaceClient[];
  turn: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Set while the pacer has no client: it leaves the map one interval after its last request, not sooner, so a set
   * that starts right after another on the same URL still waits out that URL's second. */
  dropTimer: ReturnType<typeof setTimeout> | undefined;
};
const pacers = new Map<unknown, Pacer>();

/** How many 1-rps pacers this page holds: a diagnostic read (the kit's tests check that a finished set's pacer goes). */
export function solanaSendPacerCount(): number {
  return pacers.size;
}
/** How many turns the provider's queue holds, booked (not yet started) and started (in the last minute), of one method
 * when named: a diagnostic read (the kit's tests check that a turn given up on leaves none behind, and that the fill
 * poll books none while it reads). */
export function solanaRpcQueueSize(rpc: SolanaRpc, method?: string): { booked: number; started: number } {
  const bare = bareOf.get(rpc) ?? rpc;
  const q = bare.url === undefined ? queueOfFn.get(bare) : queueOfUrl.get(urlKey(bare.url));
  const slots = (q?.slots ?? []).filter((x) => method === undefined || x.method === method);
  return { booked: slots.filter((x) => !x.started).length, started: slots.filter((x) => x.started).length };
}

function paceFire(p: Pacer): boolean {
  const n = p.clients.length;
  for (let k = 0; k < n; k++) {
    const send = p.clients[(p.turn + k) % n]!();
    if (send) {
      p.turn = (p.turn + k + 1) % n;
      p.last = Date.now();
      send();
      return true;
    }
  }
  return false;
}

function paceArm(p: Pacer): void {
  if (p.timer !== undefined || p.clients.length === 0) return;
  const now = Date.now();
  if (p.last > now) p.last = -Infinity; // a clock that went back
  if (p.idleUntil > now + p.interval) p.idleUntil = 0;
  p.timer = setTimeout(() => {
    p.timer = undefined;
    const t = Date.now();
    // A timer that fires early (some browsers do, by a millisecond) sends nothing and re-arms for the rest.
    if (t - p.last >= p.interval && !paceFire(p)) p.idleUntil = t + p.interval; // nothing to send: look again in one interval
    paceArm(p);
  }, Math.max(0, p.last + p.interval - now, p.idleUntil - now));
}

/** Joins `client` to the pacer of `key`; returns the leave call. */
function paceJoin(key: unknown, interval: number, client: PaceClient): () => void {
  let p = pacers.get(key);
  if (!p) {
    p = { interval, last: -Infinity, idleUntil: 0, clients: [], turn: 0, timer: undefined, dropTimer: undefined };
    pacers.set(key, p);
  }
  const pacer = p;
  if (pacer.dropTimer !== undefined) {
    clearTimeout(pacer.dropTimer);
    pacer.dropTimer = undefined;
  }
  pacer.interval = Math.max(pacer.interval, interval);
  pacer.clients.push(client);
  const now = Date.now();
  if (pacer.last > now) pacer.last = -Infinity;
  pacer.idleUntil = 0;
  if (now - pacer.last >= pacer.interval && paceFire(pacer) && pacer.timer !== undefined) {
    clearTimeout(pacer.timer);
    pacer.timer = undefined;
  }
  paceArm(pacer);
  return () => {
    const i = pacer.clients.indexOf(client);
    if (i >= 0) pacer.clients.splice(i, 1);
    if (pacer.clients.length > 0) return;
    if (pacer.timer !== undefined) {
      clearTimeout(pacer.timer);
      pacer.timer = undefined;
    }
    const drop = () => {
      pacer.dropTimer = undefined;
      if (pacer.clients.length === 0 && pacers.get(key) === pacer) pacers.delete(key);
    };
    const wait = pacer.last + pacer.interval - Date.now();
    if (wait <= 0 || pacer.last > Date.now()) drop();
    else if (pacer.dropTimer === undefined) pacer.dropTimer = setTimeout(drop, wait);
  };
}

type Prepared = { signature: string; b64: string; lvbh: number; blockhash: string };

/** The set's own checks before anything is sent: signed bytes the kit can decode, each once, a usable height. */
function prepare(set: readonly SolanaSignedTx[], opts: Pick<SolanaSetOptions, "paths" | "providers" | "providerRps">): Prepared[] {
  if (!Array.isArray(set) || set.length === 0) throw new Error("the set is empty");
  if (!Array.isArray(opts.paths) || opts.paths.length === 0) throw new Error("no send path");
  if (!Array.isArray(opts.providers) || opts.providers.length !== 2 || typeof opts.providers[0] !== "function" || typeof opts.providers[1] !== "function") throw new Error("two providers are needed");
  const [pa, pb] = opts.providers;
  if (solanaSameProvider(pa, pb)) throw new Error("the two providers are the same provider: a fill must never rest on one provider's word");
  // Each provider's limit named in its queue before the set's first call (its sends on an RPC path to the same URL too).
  const limits = solanaProviderLimits(opts.providerRps);
  queueWith(pa, limits[0]);
  queueWith(pb, limits[1]);
  for (const p of opts.paths) {
    if (p.minIntervalMs !== undefined && !(Number.isSafeInteger(p.minIntervalMs) && p.minIntervalMs > 0)) throw new Error(`path ${p.name}: minIntervalMs ${String(p.minIntervalMs)}`);
  }
  const seen = new Set<string>();
  return set.map((t, i) => {
    if (!(t?.wire instanceof Uint8Array)) throw new Error(`tx ${i}: no wire bytes`);
    if (t.wire.length > SOLANA_MAX_TX_BYTES) throw new Error(`tx ${i}: ${t.wire.length} bytes, over ${SOLANA_MAX_TX_BYTES}`);
    const decoded = solanaDecodeTransaction(t.wire); // throws on bytes that are not one whole transaction
    if (decoded.signatures < 1 || decoded.signatures > 0x7f) throw new Error(`tx ${i}: ${decoded.signatures} signature slots`);
    for (let s = 0; s < decoded.signatures; s++) {
      if (t.wire.subarray(1 + 64 * s, 65 + 64 * s).every((b: number) => b === 0)) throw new Error(`tx ${i}: signature ${s} is not signed`);
    }
    // A durable-nonce tx (first instruction System AdvanceNonceAccount, u32 LE 4; Agave's get_durable_nonce) never
    // expires by height, so lastValidBlockHeight says nothing of it.
    const first = decoded.message.instructions[0];
    const d = first?.data;
    if (first && decoded.message.staticKeys[first.programIndex] === SOLANA_SYSTEM_PROGRAM && d && d.length >= 4 && d[0] === 4 && d[1] === 0 && d[2] === 0 && d[3] === 0) throw new Error(`tx ${i}: a durable nonce tx has no lastValidBlockHeight`);
    if (!Number.isSafeInteger(t.lastValidBlockHeight) || t.lastValidBlockHeight < 0 || t.lastValidBlockHeight >= 2 ** 53 - 1) throw new Error(`tx ${i}: lastValidBlockHeight ${String(t.lastValidBlockHeight)}`);
    const signature = base58.encode(t.wire.subarray(1, 65));
    if (seen.has(signature)) throw new Error(`tx ${i}: the same tx is in the set twice`);
    seen.add(signature);
    return { signature, b64: base64.encode(t.wire), lvbh: t.lastValidBlockHeight, blockhash: decoded.message.blockhash };
  });
}

// One provider's read of one signature, after the shape checks.
type Read = "none" | "pending" | "ok" | "err" | "bad";
type StatusRead = { kind: Read; slot?: number; err?: unknown };
const STATUSES = new Set(["processed", "confirmed", "finalized"]);
const isSlot = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A getSignatureStatuses answer for n signatures: each read, and the slot of the bank that answered; null when the
 * answer is not one. */
function readStatuses(answer: unknown, n: number): { reads: StatusRead[]; slot: number } | null {
  if (typeof answer !== "object" || answer === null) return null;
  const slot = (answer as { context?: { slot?: unknown } }).context?.slot;
  if (!isSlot(slot)) return null;
  const v = (answer as { value?: unknown }).value;
  if (!Array.isArray(v) || v.length !== n) return null;
  const reads = v.map((s): StatusRead => {
    if (s === null) return { kind: "none" };
    if (typeof s !== "object" || Array.isArray(s)) return { kind: "bad" };
    const o = s as Record<string, unknown>;
    if (typeof o.confirmationStatus !== "string" || !STATUSES.has(o.confirmationStatus) || !("err" in o) || !Number.isSafeInteger(o.slot)) return { kind: "bad" };
    if (o.confirmationStatus === "processed") return { kind: "pending" };
    return o.err === null ? { kind: "ok", slot: o.slot as number } : { kind: "err", slot: o.slot as number, err: o.err };
  });
  return { reads, slot };
}

/** A getLatestBlockhash answer at finalized: the bank's slot and block height. */
function readAnchor(answer: unknown): { slot: number; height: number } | null {
  if (typeof answer !== "object" || answer === null) return null;
  const a = answer as { context?: { slot?: unknown }; value?: { lastValidBlockHeight?: unknown } };
  const slot = a.context?.slot;
  const lvbh = a.value?.lastValidBlockHeight;
  if (!isSlot(slot) || !isSlot(lvbh) || lvbh < MAX_PROCESSING_AGE) return null;
  return { slot, height: lvbh - MAX_PROCESSING_AGE };
}

/** An isBlockhashValid answer: the bank's slot and the verdict. */
function readValid(answer: unknown): { slot: number; valid: boolean } | null {
  if (typeof answer !== "object" || answer === null) return null;
  const a = answer as { context?: { slot?: unknown }; value?: unknown };
  if (!isSlot(a.context?.slot) || typeof a.value !== "boolean") return null;
  return { slot: a.context.slot, valid: a.value };
}

/** One provider's reads for 06c A4: a landed status, its finalized bank (slot and height), the slot of the bank that
 * read the blockhash no longer valid at processed, and the slot of the bank of a searchTransactionHistory: true read
 * that had no status for the signature. */
export type SolanaDeadReads = {
  landed: boolean;
  anchor: { slot: number; height: number } | null;
  invalidAt: number | undefined;
  histNone: number | undefined;
};

/**
 * 06c A4 on one provider, the one rule the send loop (deadOn) and a later session's re-read (readSolanaTxEnd) decide
 * by: never landed there; its finalized bank's height past the tx's lastValidBlockHeight; the blockhash read no longer
 * valid at processed; and a history read with no status from a bank at or past both the anchor's slot and that
 * validity read's slot (a node that has not replayed the landing block cannot answer it). A tx is dead only when both
 * providers say so.
 */
export function solanaDeadOn(r: SolanaDeadReads, lastValidBlockHeight: number): boolean {
  if (!isSlot(lastValidBlockHeight) || r.landed || r.anchor === null || r.invalidAt === undefined || r.histNone === undefined) return false;
  return r.anchor.height > lastValidBlockHeight && r.histNone >= r.anchor.slot && r.histNone >= r.invalidAt;
}

/**
 * How a tx signed in an earlier session ended (a reload or a closed tab: its send loop is gone), read on both
 * providers, each in A4's order: its finalized bank, then the blockhash at processed, then the status with
 * searchTransactionHistory: true. filled or failed when both read it landed so; expired when solanaDeadOn holds on
 * both; unknown otherwise (one provider's word, an error or a lagging node decides nothing). The send loop also wants
 * a valid read of the blockhash before an invalid one counts, against a hash too fresh for a bank to hold; here the
 * invalid read counts only from a bank at or past that provider's finalized anchor, whose height is past the hash's
 * lastValidBlockHeight, so that bank comes after the hash and its no is the hash's age, not a bank that never held
 * it; and the signer records the higher lastValidBlockHeight of the two providers' reads (readSolanaBlockhashBoth),
 * so one provider cannot lower it.
 */
export async function readSolanaTxEnd(
  providers: readonly [SolanaRpc, SolanaRpc],
  tx: { signature: string; blockhash: string; lastValidBlockHeight: number },
  callTimeoutMs = SOLANA_CALL_TIMEOUT_MS,
): Promise<"filled" | "failed" | "expired" | "unknown"> {
  const one = async (rpc: SolanaRpc): Promise<{ read: StatusRead | null; dead: boolean }> => {
    try {
      // each call timed from when it goes out, in the provider's queue when a caller paces it (solanaTimedRpc)
      const timed = solanaTimedRpc(rpc, callTimeoutMs);
      const call = (method: string, params: readonly unknown[]) => Promise.resolve().then(() => timed(method, params));
      const anchor = readAnchor(await call("getLatestBlockhash", [{ commitment: "finalized" }]));
      const v = readValid(await call("isBlockhashValid", [tx.blockhash, { commitment: "processed" }]));
      const st = readStatuses(await call("getSignatureStatuses", [[tx.signature], { searchTransactionHistory: true }]), 1);
      if (!st) return { read: null, dead: false };
      const read = st.reads[0]!;
      const reads: SolanaDeadReads = {
        landed: read.kind === "ok" || read.kind === "err",
        anchor,
        // an invalid read counts only from a bank at or past this provider's finalized anchor: a bank behind it may
        // predate the blockhash, and with a lowered lastValidBlockHeight the height says nothing
        invalidAt: v && !v.valid && anchor !== null && v.slot >= anchor.slot ? v.slot : undefined,
        histNone: read.kind === "none" ? st.slot : undefined,
      };
      return { read, dead: solanaDeadOn(reads, tx.lastValidBlockHeight) };
    } catch {
      return { read: null, dead: false };
    }
  };
  const [a, b] = await Promise.all(providers.map(one));
  if (a!.read?.kind === "ok" && b!.read?.kind === "ok") return "filled";
  if (a!.read?.kind === "err" && b!.read?.kind === "err") return "failed";
  return a!.dead && b!.dead ? "expired" : "unknown";
}

/**
 * Sends a signed set on every path and reads its fills on two providers. Throws before any send when the set fails
 * its own checks; after that it never throws, and `done` resolves with one outcome per tx, in set order.
 */
export function sendSolanaSet(set: readonly SolanaSignedTx[], opts: SolanaSetOptions): SolanaSetHandle {
  const txs = prepare(set, opts);
  const rebroadcastMs = opts.rebroadcastMs ?? SOLANA_REBROADCAST_MS;
  const pollMs = opts.pollMs ?? SOLANA_STATUS_POLL_MS;
  if (!(typeof pollMs === "number" && Number.isFinite(pollMs) && pollMs > 0)) throw new Error("pollMs must be a number of ms above 0");
  const deadlineMs = opts.deadlineMs ?? SOLANA_SET_DEADLINE_MS;
  const callTimeoutMs = opts.callTimeoutMs ?? SOLANA_CALL_TIMEOUT_MS;
  const limits = solanaProviderLimits(opts.providerRps);
  const t0 = queueNow();
  const outcomes: SolanaTxOutcome[] = txs.map((t) => ({ signature: t.signature, state: "unknown", sends: [] }));
  const decided = txs.map(() => false);
  // Per provider:
  // - landed: the first landed read of each signature (ok or err). A confirmed tx stays confirmed, so a later null
  //   from a node behind a load balancer, or from a status cache that has dropped it, never takes a landing back.
  // - anchor: its finalized bank's slot and block height (one getLatestBlockhash answer, one bank).
  // - validMin: per blockhash, the lowest slot of a bank that read it valid at processed.
  // - invalidAt: per blockhash, the slot of the bank that read it as no longer valid at processed, counted only after
  //   a valid read from a bank at or below that slot: valid, then expired. A false with no valid read before it is no
  //   answer.
  // - histNone: per signature, the slot of the bank of the latest searchTransactionHistory: true read that had none.
  const landed = [new Map<string, StatusRead>(), new Map<string, StatusRead>()] as const;
  const chased = [new Set<string>(), new Set<string>()] as const; // txs read on p first because the other read them landed
  const burstLeft = [fillBurst(limits[0]), fillBurst(limits[1])]; // each provider's burst reads (fillBurst) not yet made
  const lastFast = [t0, t0]; // when a fill read last went out (or was booked) on each provider
  const anchor: [{ slot: number; height: number } | null, { slot: number; height: number } | null] = [null, null];
  const validMin = [new Map<string, number>(), new Map<string, number>()] as const;
  const invalidAt = [new Map<string, number>(), new Map<string, number>()] as const;
  const histNone = [new Map<string, number>(), new Map<string, number>()] as const;
  const fastInFlight = [false, false];
  // Per provider: the fill poll's round-robin position over the undecided txs.
  const fastCursor = [-1, -1];
  const deadInFlight = [false, false];
  const backoffMs = [0, 0];
  const backoffUntil = [0, 0];
  const pending = new Set<() => void>(); // the turns this set's calls wait for, given back when the set ends
  let attempt = 0;
  let over = false;
  let finish!: (r: SolanaSetResult) => void;
  const done = new Promise<SolanaSetResult>((r) => { finish = r; });

  const unlimited = opts.paths.filter((p) => p.minIntervalMs === undefined);
  const limited = opts.paths.filter((p) => p.minIntervalMs !== undefined);

  const pastOn = (p: 0 | 1, i: number): boolean => {
    const a = anchor[p];
    return a !== null && a.height > txs[i]!.lvbh && invalidAt[p].has(txs[i]!.blockhash);
  };
  const past = (i: number): boolean => pastOn(0, i) && pastOn(1, i);
  const eligible = (i: number): boolean => !decided[i] && !past(i);

  /** One call on provider p, in the provider's shared queue (rpcSlot), timed out, with its 429 back-off. Rejects on
   * any failure, and without calling once the set is over: a turn whose time comes after the end is given back.
   * end() gives back the turns pending then; every caller reads `over` before it asks, and this gives back a turn
   * asked after the end by a caller that did not (the dead check's loop once did, and its turn stayed booked). */
  function call(p: 0 | 1, method: string, params: readonly unknown[]): Promise<unknown> {
    const { run, wait, drop } = rpcSlot(opts.providers[p], limits[p], method);
    pending.add(drop);
    return (wait ?? Promise.resolve()).then(() => {
      pending.delete(drop);
      if (over) { drop(); throw new Error("the set is over"); }
      return withTimeout(Promise.resolve().then(() => run(params)), callTimeoutMs);
    }).then(
      (v) => { backoffMs[p] = 0; return v; },
      (e) => {
        if (/\b429\b/.test(errText(e))) {
          backoffMs[p] = Math.min(Math.max(backoffMs[p]! * 2, 1_000), BACKOFF_MAX_MS);
          backoffUntil[p] = queueNow() + backoffMs[p]!;
        }
        throw e;
      },
    );
  }
  const backedOff = (p: 0 | 1): boolean => queueNow() < backoffUntil[p]!;

  function sendOne(i: number, p: SolanaSendPath, n: number): void {
    const t = txs[i]!;
    const start = Date.now();
    let sent: Promise<string>;
    try {
      sent = p.send(t.b64);
    } catch (e) {
      sent = Promise.reject(e);
    }
    withTimeout(Promise.resolve(sent), callTimeoutMs).then(
      (sig) => {
        if (over) return; // the result is final once `done` resolves
        const ok = sig === t.signature;
        outcomes[i]!.sends.push({ path: p.name, attempt: n, ok, ms: Date.now() - start, ...(ok ? {} : { error: "the path answered another signature" }) });
      },
      (e) => { if (!over) outcomes[i]!.sends.push({ path: p.name, attempt: n, ok: false, ms: Date.now() - start, error: errText(e) }); },
    );
  }

  function broadcast(): void {
    const n = attempt++;
    for (let i = 0; i < txs.length; i++) if (eligible(i)) for (const p of unlimited) sendOne(i, p, n);
  }

  // Each 1-rps path: when its pacer gives this set a turn, the next eligible tx after the last it was given. The k-th
  // such path starts at tx k, so Sender and Jito carry different txs of a set in the same second.
  const cursor = limited.map((_, k) => k - 1);
  const limitedSent = limited.map(() => 0);
  const nextFor = (k: number): (() => void) | null => {
    if (over) return null;
    for (let step = 1; step <= txs.length; step++) {
      const i = (((cursor[k]! + step) % txs.length) + txs.length) % txs.length;
      if (!eligible(i)) continue;
      return () => {
        cursor[k] = i;
        sendOne(i, limited[k]!, limitedSent[k]!++);
      };
    }
    return null;
  };

  function record(p: 0 | 1, sig: string, r: StatusRead): void {
    if (r.kind !== "ok" && r.kind !== "err") return;
    if (!landed[p].has(sig)) landed[p].set(sig, r);
  }

  function deadOn(p: 0 | 1, i: number): boolean {
    const t = txs[i]!;
    return solanaDeadOn({ landed: landed[p].has(t.signature), anchor: anchor[p], invalidAt: invalidAt[p].get(t.blockhash), histNone: histNone[p].get(t.signature) }, t.lvbh);
  }

  function decide(): void {
    for (let i = 0; i < txs.length; i++) {
      if (decided[i]) continue;
      const sig = txs[i]!.signature;
      const ra = landed[0].get(sig);
      const rb = landed[1].get(sig);
      const o = outcomes[i]!;
      if (ra?.kind === "ok" && rb?.kind === "ok") {
        o.state = "filled";
        o.slot = ra.slot!;
      } else if (ra?.kind === "err" && rb?.kind === "err") {
        o.state = "failed";
        o.slot = ra.slot!;
        o.err = [ra.err, rb.err];
      } else if (deadOn(0, i) && deadOn(1, i)) {
        o.state = "expired";
      } else continue;
      o.ms = Math.round(queueNow() - t0);
      decided[i] = true;
    }
    if (decided.every(Boolean)) end();
  }

  /** getSignatureStatuses for one tx on p: one signature a request, never a batch, since each signature names its fee
   * payer, one of the user's wallets, and no request may carry two of them. Null when it is not an answer. */
  async function status(p: 0 | 1, i: number, history: boolean): Promise<{ r: StatusRead; slot: number } | null> {
    const ans = readStatuses(await call(p, "getSignatureStatuses", [[txs[i]!.signature], { searchTransactionHistory: history }]), 1);
    return ans ? { r: ans.reads[0]!, slot: ans.slot } : null;
  }

  // The fill poll: the status cache only (searchTransactionHistory: false), one undecided tx a call, in turn, the calls
  // spaced by fastPeriod. Whether a read went out.
  function readFast(p: 0 | 1): boolean {
    if (fastInFlight[p] || over || backedOff(p)) return false;
    // A tx p has read landed is not read again on p (its first read is the one kept); one the other provider has read
    // landed goes first, once, so the second read a fill needs follows the first at once; the rest in turn, so a tx
    // one provider never sees land never holds the others back.
    const open = (k: number): boolean => !decided[k] && !landed[p].has(txs[k]!.signature);
    let i = txs.findIndex((t, k) => open(k) && landed[p === 0 ? 1 : 0].has(t.signature) && !chased[p].has(t.signature));
    if (i >= 0) chased[p].add(txs[i]!.signature);
    else {
      for (let step = 1; step <= txs.length; step++) {
        const k = (fastCursor[p]! + step) % txs.length;
        if (open(k)) { i = k; break; }
      }
      if (i < 0) return false;
      fastCursor[p] = i;
    }
    fastInFlight[p] = true;
    status(p, i, false)
      .then((got) => {
        if (over || !got) return; // a broken answer is no answer
        record(p, txs[i]!.signature, got.r);
        decide();
      }, () => {})
      .finally(() => { fastInFlight[p] = false; });
    return true;
  }
  /** The fill poll's spacing on p: pollMs over the txs p still reads, and no closer than the steady pool allows
   * (W / (B - 2C)); a burst read, spread over FILL_BURST_MS, never further apart than a steady one. */
  const fastPeriod = (p: 0 | 1): number => {
    const n = Math.max(1, txs.filter((t, k) => !decided[k] && !landed[p].has(t.signature)).length); // the txs p still reads
    const l = limits[p];
    const steady = Math.max(pollMs / n, l.windowMs / fillPool(l));
    return burstLeft[p]! > 0 ? Math.min(steady, Math.max(pollMs / n, FILL_BURST_MS / fillBurst(l))) : steady;
  };

  // The dead check on p, every rebroadcast: the finalized bank's height and slot; every undecided tx's blockhash at
  // processed; for each tx past its lastValidBlockHeight there, a status read with searchTransactionHistory: true. Each step's answer carries its bank's slot, which deadOn compares.
  function readDead(p: 0 | 1): void {
    if (deadInFlight[p] || over || backedOff(p)) return;
    deadInFlight[p] = true;
    (async () => {
      const a = readAnchor(await call(p, "getLatestBlockhash", [{ commitment: "finalized" }]));
      if (a && (anchor[p] === null || (a.height >= anchor[p]!.height && a.slot >= anchor[p]!.slot))) anchor[p] = a; // never goes back
      if (over) return;
      // Every undecided tx's blockhash, from the first cycle on, so a fresh hash is read valid before it can read expired.
      const open = txs.map((_, i) => i).filter((i) => !decided[i]);
      for (const bh of new Set(open.map((i) => txs[i]!.blockhash))) {
        if (over) return;
        let answer: unknown;
        try {
          answer = await call(p, "isBlockhashValid", [bh, { commitment: "processed" }]);
        } catch {
          continue; // refused (a helper whose allowlist predates it), rate-limited or timed out: no answer, the cycle goes on
        }
        const v = readValid(answer);
        if (!v) continue;
        if (v.valid) {
          invalidAt[p].delete(bh);
          const m = validMin[p].get(bh);
          if (m === undefined || v.slot < m) validMin[p].set(bh, v.slot);
        } else {
          const m = validMin[p].get(bh);
          if (m !== undefined && m <= v.slot) invalidAt[p].set(bh, v.slot);
        }
      }
      const cur = anchor[p];
      if (over || cur === null) return;
      // Every tx past its lastValidBlockHeight on this bank is read with the history: it can find a landing the status
      // cache has dropped (a fill) whatever the blockhash reads; it counts toward dead only through deadOn's gates.
      const check = open.filter((i) => !decided[i] && cur.height > txs[i]!.lvbh);
      if (over || check.length === 0) return;
      for (const i of check) {
        if (over || decided[i]) continue;
        const got = await status(p, i, true);
        if (over) return;
        if (!got) continue;
        const sig = txs[i]!.signature;
        record(p, sig, got.r);
        if (got.r.kind === "none") histNone[p].set(sig, got.slot);
        else histNone[p].delete(sig);
      }
      decide();
    })()
      .catch(() => {})
      .finally(() => { deadInFlight[p] = false; });
  }

  broadcast(); // the first send, in this tick, before anything is awaited
  const leaves = limited.map((p, k) => paceJoin(p.paceKey ?? p, p.minIntervalMs!, () => nextFor(k)));
  const timers = [setInterval(() => { readDead(0); readDead(1); broadcast(); }, rebroadcastMs)];
  const fastTimers: (ReturnType<typeof setTimeout> | undefined)[] = [undefined, undefined];
  // Past its burst, a fill read goes only while the steady reads of every set on the provider are under the pool
  // (fillPool) in the window, else at the time the oldest of them leaves it.
  const fastTick = (p: 0 | 1): void => {
    if (over) return;
    // A fill read that would wait is not asked, so the calls waiting on p go first; but once no fill read has gone on p
    // for a whole window (a slow keyed provider whose budget the dead check's reads fill), the next one books its turn
    // behind them, so the poll reads at every limit.
    const waitMs = methodWaitMs(opts.providers[p], limits[p], "getSignatureStatuses");
    if (waitMs > 0 && queueNow() - lastFast[p]! < limits[p].windowMs) { fastTimers[p] = setTimeout(() => fastTick(p), waitMs); return; }
    if (burstLeft[p]! > 0) {
      if (readFast(p)) { burstLeft[p]!--; lastFast[p] = queueNow(); }
    } else {
      const l = limits[p];
      const q = queueWith(opts.providers[p], l);
      const now = queueNow();
      q.fillSteady = q.fillSteady.filter((x) => x > now - l.windowMs);
      if (q.fillSteady.length >= fillPool(l)) {
        fastTimers[p] = setTimeout(() => fastTick(p), q.fillSteady[0]! + l.windowMs - now + 1);
        return;
      }
      if (readFast(p)) { q.fillSteady.push(now); lastFast[p] = now; }
    }
    fastTimers[p] = setTimeout(() => fastTick(p), fastPeriod(p));
  };
  fastTimers[0] = setTimeout(() => fastTick(0), fastPeriod(0));
  fastTimers[1] = setTimeout(() => fastTick(1), fastPeriod(1));
  const deadline = setTimeout(end, deadlineMs);

  function end(): void {
    if (over) return;
    over = true;
    for (const drop of pending) drop();
    pending.clear();
    for (const t of timers) clearInterval(t);
    for (const t of fastTimers) clearTimeout(t);
    for (const leave of leaves) leave();
    clearTimeout(deadline);
    finish({ txs: outcomes });
  }

  return { signatures: txs.map((t) => t.signature), done, stop: end };
}

export type SolanaDryTx = {
  signature: string;
  state: "simulated" | "sim-failed";
  /** Each provider's simulation: its error (null when clean) and compute units, or why it gave none. */
  simulations: readonly [{ err: unknown; units: number | null } | { error: string }, { err: unknown; units: number | null } | { error: string }];
};

/**
 * The --dry form (row M1.3's proof): the set's own checks, then each tx simulated on both providers
 * (simulateTransaction, sigVerify off, the blockhash replaced, at `confirmed`). No path is called and nothing is sent.
 * `paths` names the paths a real send would use, each getting the same base64 the simulations read.
 */
export async function dryRunSolanaSet(set: readonly SolanaSignedTx[], opts: SolanaSetOptions): Promise<{ paths: string[]; txs: SolanaDryTx[] }> {
  const txs = prepare(set, opts);
  const timeoutMs = opts.callTimeoutMs ?? SOLANA_CALL_TIMEOUT_MS;
  const config = { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" };
  const limits = solanaProviderLimits(opts.providerRps);
  const one = (p: 0 | 1, b64: string) => {
    const { run, wait } = rpcSlot(opts.providers[p], limits[p], "simulateTransaction");
    return (wait ?? Promise.resolve()).then(() => withTimeout(Promise.resolve().then(() => run([b64, config])), timeoutMs)).then(
      (ans) => {
        const v = (ans as { value?: { err?: unknown; unitsConsumed?: unknown } } | null)?.value;
        if (typeof v !== "object" || v === null || !("err" in v)) return { error: "not a simulation answer" };
        return { err: v.err, units: Number.isSafeInteger(v.unitsConsumed) ? (v.unitsConsumed as number) : null };
      },
      (e) => ({ error: errText(e) }),
    );
  };
  const out = await Promise.all(
    txs.map(async (t): Promise<SolanaDryTx> => {
      const sims = (await Promise.all([one(0, t.b64), one(1, t.b64)])) as SolanaDryTx["simulations"];
      const clean = sims.every((s) => "err" in s && s.err === null);
      return { signature: t.signature, state: clean ? "simulated" : "sim-failed", simulations: sims };
    }),
  );
  return { paths: opts.paths.map((p) => p.name), txs: out };
}
