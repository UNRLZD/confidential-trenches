// The helper's abuse limits (card helper-abuse-limits): one throttling contract on every route, with no IP stored.
//
// The contract: when the helper's own budget or its upstream throttles, the answer is 429 { error: { code } } with a
// Retry-After in whole seconds, which the browser can read (server.ts exposes it by CORS). A 503 stays fatal and never
// means "wait". No answer body carries upstream text.
//
// The client is the address Caddy forwards (deploy/Caddyfile: reverse_proxy writes X-Forwarded-For from the peer it saw
// and keeps no access log), else the socket's peer. It is a map key in memory and nothing else: never logged, never
// answered, never written, and gone when its window ends (every map below is cleared at the window's turn) or at
// restart.
import type { IncomingMessage } from "node:http";
import { isIPv6 } from "node:net";
import { WINDOW_MS } from "../data/gecko.ts";
import { resetMs } from "../proxy/proxy.ts";

/** The window every limit counts in [design: 10 s, the pool routes' window since M356 (3)]. */
export const LIMIT_WINDOW_MS = 10_000;
/** The most clients one limit remembers in one window; past it the oldest goes [design: memory bound under a flood]. */
export const LIMIT_CLIENTS = 50_000;
/** The longest wait the helper ever names, an upstream's own reset held to it: GeckoTerminal's WINDOW_MS (75 s), the
 *  longest true wait one of the helper's own budgets can have, so a wait is never named shorter than it is (a shorter one
 *  only has the app retry into a second 429). */
export const RETRY_AFTER_MAX_S = WINDOW_MS / 1000;

/** The client's address as the proxy forwarded it (the last X-Forwarded-For entry), else the socket's peer; an IPv6
 * address is keyed by its /64, the block one subscriber is given (RFC 6177), so one subscriber cannot rotate through
 * its own addresses to draw many shares. */
export function clientOf(req: IncomingMessage): string {
  const f = req.headers["x-forwarded-for"];
  const last = (Array.isArray(f) ? f.join(",") : (f ?? "")).split(",").pop()!.trim();
  return keyOf(last !== "" ? last : (req.socket?.remoteAddress ?? ""));
}

/** An IPv6 address as its /64 (its first four groups, written out), an IPv4 one (mapped ones included) as itself. */
export function keyOf(address: string): string {
  if (isIPv6(address) && !/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address)) {
    const [head, tail] = address.toLowerCase().split("%")[0]!.split("::");
    const h = head === "" ? [] : head!.split(":");
    const t = tail === undefined || tail === "" ? [] : tail.split(":");
    const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
    return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
  }
  return address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
}

/** 0: go ahead; otherwise the whole seconds (1 or more) the caller is told to wait. */
export type Take = number;

/** The 429 every throttle answers: the code only, and the wait. `why` names the limit that refused (card
 *  app-console-429: "<budget key> share", "geckoterminal budget", ...) for the helper's refusal log (refusalLog below);
 *  it is never sent: the server answers the status, the headers and the body only. */
export function throttled(retryAfterS: number, code = "rate_limited", why?: string): { status: 429; headers: Record<string, string>; body: string; why?: string } {
  return { status: 429, headers: { "Retry-After": String(retryAfterS) }, body: JSON.stringify({ error: { code } }), ...(why === undefined ? {} : { why }) };
}

/**
 * The helper's caller refusals as log lines (card app-console-429): count(route, why) for every 429 a caller is
 * answered, one line a window per route and reason with its count, "refused <route> <why> <n> in 10 s", never one per
 * request and never the caller (route and why are the helper's own names: a mounted route, a budget key of a listed
 * chain, vendor or method, a limit's name). A window with no refusal writes nothing.
 */
export function refusalLog(log: (line: string) => void = (l) => console.log(`helper: ${l}`), windowMs = LIMIT_WINDOW_MS): { count(route: string, why: string): void; flush(): void } {
  const counts = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const [k, n] of counts) log(`refused ${k} ${n} in ${windowMs / 1000} s`);
    counts.clear();
  };
  return {
    count(route, why) {
      const k = `${route} ${why}`;
      // the keys are the helper's own names, a few dozen at most; the bound only keeps a bug from growing the map
      if (!counts.has(k) && counts.size >= 256) return;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (timer === null) {
        timer = setTimeout(flush, windowMs);
        timer.unref?.();
      }
    },
    flush,
  };
}

/** A provider read that threw for a throttle (the kit's RPC clients throw "HTTP 429"; a JSON-RPC error naming a rate
 * limit; on an EVM chain, `evm`, also EVM_LIMIT_CODE): the wait to name, 1 s, as a thrown error carries no reset; 0 for
 * any other failure. Never -32005 off EVM: Solana's -32005 is a node behind, not a throttle. */
export function throttleOf(e: unknown, evm = false): number {
  const m = String((e as Error | undefined)?.message ?? e);
  return /\bHTTP 429\b|rate.?limit|too many requests/i.test(m) || (evm && new RegExp(`^RPC error ${EVM_LIMIT_CODE}\\b`).test(m)) ? 1 : 0;
}

/** EIP-1474's "Limit exceeded" code, which the major EVM providers answer for a rate or request-count limit: Infura's
 * error table, "-32005 | Limit exceeded | The request exceeds your request limit.", and its rate-limited example,
 * {"code": -32005, "message": "project ID request rate exceeded"} (docs.infura.io/reference/ethereum/json-rpc-methods,
 * read 2026-11-03 09:16Z). Any other -320xx stays a provider failure. */
export const EVM_LIMIT_CODE = -32005;
/** A JSON-RPC error message that names a rate or request limit, whatever its code: mainnet.base.org's "request limit
 *  reached", Tenderly's "rate limit exceeded", and on Robinhood (read 2026-11-04 19:37-19:42Z) blockvectra's "public
 *  request rate limit exceeded", daybreak's "too many concurrent requests", blockmachine's -32029 "rate limit exceeded".
 *  A limit on what one read asks is not a throttle (EVM_RANGE_MESSAGE). */
export const EVM_LIMIT_MESSAGE = /rate.?limit|too many (concurrent )?requests|request limit/i;
/** A JSON-RPC error that names a limit on one read's size, not on our rate: daybreak's "query exceeds max block range
 *  2000", drpc's "ranges over 10000 blocks are not supported on freetier", "block range limit exceeded", Infura's -32005
 *  "query returned more than 10000 results", "Log response size exceeded". Asked again, it answers the same. */
export const EVM_RANGE_MESSAGE = /block range|max(imum)? (block )?range|ranges? over|returned more than|response size/i;
/** The one rule for what an EVM provider's JSON-RPC error is (card helper-robinhood-capacity: rpc.ts, data/evm/swaps.ts
 *  and lists.ts read it alike): the seconds it asks us to wait, 1 to RETRY_AFTER_MAX_S (its data.backoff_seconds, else
 *  1), when it is EVM_LIMIT_CODE or names a rate or request limit and no limit on the read's size; else 0. */
export function evmThrottleS(error: unknown): number {
  const e = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; message?: unknown; data?: { backoff_seconds?: unknown } };
  const m = String(e.message ?? "");
  if (EVM_RANGE_MESSAGE.test(m) || (e.code !== EVM_LIMIT_CODE && !EVM_LIMIT_MESSAGE.test(m))) return 0;
  const s = Number(e.data?.backoff_seconds);
  return Number.isFinite(s) && s > 0 ? Math.min(Math.ceil(s), RETRY_AFTER_MAX_S) : 1;
}

/**
 * One hold per provider URL, shared by every path of this helper that reads it (card helper-robinhood-capacity): the
 * Robinhood swap reads (data/evm/swaps.ts), the maker reads (data/evm/lists.ts) and /v1/rpc/robinhood (rpc/rpc.ts) all
 * read rpc.mainnet.chain.robinhood.com from the one address the provider limits. hold(url, s) holds it s seconds more
 * from now unless it is held longer (at most RETRY_AFTER_MAX_S); heldFor(url) is the seconds left, 0 when it is free, and
 * heldMs(url) the same in milliseconds.
 *
 * And one pace per provider (card helper-robinhood-capacity fold 2), a token bucket (PROVIDER_PACE) every path draws
 * from before it sends: take(url, calls, background) takes the post's units (1, or its calls for a provider that counts
 * calls) and answers 0, or the ms until they fit and takes nothing. Background reads (the swap and maker reads) draw
 * only down to the CALLER_ROOM a provider keeps for callers' reads (/v1/rpc), so our own load never spends the room a
 * user's call needs. room(url) is the bucket's free share, 0 to 1 (1 for a provider with no pace), by which the swap
 * reads pick the providers they ask; paceOf(url) the pace they were made with.
 */
export type ProviderHolds = {
  heldFor(url: string): number;
  heldMs(url: string): number;
  hold(url: string, seconds: number): void;
  take(url: string, calls: number, background: boolean): number;
  room(url: string): number;
  paceOf(url: string): Pace | undefined;
};

/** A provider's pace: `perS` units a second, at most `burst` at once; a unit is a post (one HTTP request, a batch or
 *  not) or a call (each request in a batch); `inflight`, the posts it takes at once. */
export type Pace = { perS: number; burst: number; unit: "post" | "call"; inflight?: number };
/**
 * Each paced provider, set under the point where it refuses (reads cited):
 *   - robinhood.daybreak-rpc.network: refuses two ways. -32005 "rate limited" with Retry-After 10 at 61 to 72 posts in
 *     the 5 s before it, 12 to 14 a second (the markets lead's upstream logs, 4 runs 2026-11-04 20:0xZ, 151 to 341 calls
 *     in the 10 s before); and -32005 "too many concurrent requests" past about 4 calls at once: single 1,000-block
 *     eth_getLogs at 10 posts a second (4.4 in flight, p50 442 ms) refused at 4.1 s, at 8 a second (3.2 in flight) none
 *     in 12 s, and batches of 5 at 4 posts a second refused at the 4th post (sweep from the Mac 2026-11-04 20:48-20:52Z).
 *     Its concurrency, measured (single 1,000-block PoolManager eth_getLogs from the Mac, 2026-11-04 23:32-23:35Z): bursts
 *     of 3 and of 4 at once (five each, 2.5 s apart) all served, 15 of 15 and 20 of 20; of 6, 20 of 30, and of 8, 20 of
 *     40, each refused HTTP 429 -32005 "too many concurrent requests" with no Retry-After; held at 3, 4, 6 and 8 in flight
 *     at most 7 posts a second for 10 s, all served (63, 56, 71, 71). It serves 4 at once. Paced at 7 posts a second, one
 *     call a post (lists.ts BATCH_MAX) and 3 out at once: the 4th is left for /v1/rpc's callers (rpc.ts callEvm sends to
 *     it with no in-flight count), the in-flight form of CALLER_ROOM.
 *   - rpc-robinhood.blockmachine.io: its 429 names x-ratelimit-limit 60, x-ratelimit-unit cu_per_minute (the same logs,
 *     Retry-After 41-42 s); the sweep's single eth_getLogs, 1 then 2 a second for 12 s each, passed, and 4 a second was
 *     refused at its 31st post, the minute's 67th call, Retry-After 23 (20:53Z). Paced under its header's 60 a minute: half
 *     a call a second, 25 at once, at most 55 in any minute.
 *   - robinhood.api.pocket.network: x-ratelimit-limit 1200, its reset 60 s ahead, remaining one less per call (read
 *     2026-11-04 20:49Z). Paced at 15 calls a second, 200 at once: 1,100 in any minute.
 *   - robinhood.drpc.org: 33 calls a second for 8 s, none refused (SWAP_RPCS' note, 2026-11-04 19:4xZ). Paced at 15, 15 at once: at most 30 in
 *     any second.
 *   - rpc.mainnet.chain.robinhood.com, the chain's own and /v1/rpc/robinhood's first: 3.8 posts a second, then 429 (the
 *     same note), and a fourth quick read refused 429 (19:2xZ). Paced at 1, 2 at once: at most 3 in any second.
 * api.blockvectra.com (100 blocks, last) is not paced: its holds keep it, as before.
 * Base's swap providers, swept from the Mac 2026-11-05 19:2xZ with single 1,000-block eth_getLogs for 6 s (card
 * helper-ready-page-warm: once Base made 200 ms blocks and base.drpc.org refused 250 blocks and more, the two left took
 * the walks' bursts and 429'd them, and a quiet token's cold tape found no pair, 503):
 *   - base-rpc.publicnode.com: 3 a second none refused, 5 a second refused 3 of 30 (-32005, from 1.4 s); 8 at once served.
 *     Paced at 3 calls a second, 6 at once.
 *   - base.gateway.tenderly.co: 2 a second none refused, 4 a second refused 2 of 24 at once; batches of 3 a second refused
 *     1 of 18. Paced at 2 calls a second, 3 at once.
 *   - base.api.pocket.network (in blockpi's place, card helper-evm-range-cap-walk: blockpi answered HTTP 521 on every
 *     chain from about 16:00Z 6 Nov): x-ratelimit-limit 1200, its reset 60 s ahead, a count of its own apart from
 *     Robinhood's (read 6 Nov 18:49-18:50Z), and x-ratelimit-limit-global 90000, one count shared by every user of
 *     its gateway, which none of ours can pace; single 1,000-block eth_getLogs at 10 a second for 6 s and batches of 10 a
 *     second none throttled, 3 batches of 10 eth_call at once 18 of 18 answered (18:47Z); about 75 calls a second for
 *     40 s, past the minute's 1,200, answered 429 (18:45Z). Paced at 10 calls a second, 30 at once: at most 630 in any
 *     minute.
 */
export const PROVIDER_PACE: Readonly<Record<string, Pace>> = {
  "https://robinhood.daybreak-rpc.network": { perS: 7, burst: 7, unit: "post", inflight: 3 },
  "https://rpc-robinhood.blockmachine.io": { perS: 0.5, burst: 25, unit: "call" },
  "https://robinhood.api.pocket.network": { perS: 15, burst: 200, unit: "call" },
  "https://robinhood.drpc.org": { perS: 15, burst: 15, unit: "call" },
  "https://rpc.mainnet.chain.robinhood.com": { perS: 1, burst: 2, unit: "post" },
  "https://base-rpc.publicnode.com": { perS: 3, burst: 6, unit: "call" },
  "https://base.gateway.tenderly.co": { perS: 2, burst: 3, unit: "call" },
  "https://base.api.pocket.network": { perS: 10, burst: 30, unit: "call" },
  // mainnet.base.org, Base's own and /v1/rpc/base's first: 5 eth_getTransactionByHash posts a second for 5 s and
  // batches of 10 at 2 a second (20 calls a second) none refused (2026-11-05 19:3xZ, from the Mac). Paced at 10 calls a
  // second, 20 at once. It refuses every eth_getLogs (LOGS_REFUSED).
  "https://mainnet.base.org": { perS: 10, burst: 20, unit: "call" },
};
/** Providers that refuse every `eth_getLogs` and answer the other reads: no path sends them one (rpc.ts callEvm, the
 *  swap reads), so a log read never holds the provider for the reads it does answer. mainnet.base.org answered every
 *  eth_getLogs, of 1 to 1,000 blocks, from the helper box and from the Mac, -32011 "request limit reached" (HTTP 429;
 *  2026-11-03 and again 2026-11-05 18:5x-19:0xZ), and eth_blockNumber and eth_getTransactionByHash 200; a caller's log
 *  read sent there held it 1 s about every 3 s on the box (the helper's log, 5 Nov 18:5xZ: 231 holds in 8 min). */
export const LOGS_REFUSED: ReadonlySet<string> = new Set(["https://mainnet.base.org"]);
/** How long a caller's draw on a paced provider keeps its refill from background reads (card helper-deploy-reads-fast):
 *  a caller's read is several posts one after another (the head, then its spans, then the traders), and background
 *  that drew the refill between them left each post waiting for the bucket from its floor (a planted run: 39 open
 *  books' ticks held a cold candles read 7.7 s on the paces, at 600 ms an answer). [design: 1 s, about one post's answer
 *  and the next post's start; background goes again once no caller drew for that long.] */
export const CALLER_HOLD_MS = 1_000;
/** The share of a paced provider's burst background reads leave for callers' reads. [design: a quarter, so a caller's
 *  read finds room at once on the provider it asks first while the walks run at three quarters of its pace.] */
export const CALLER_ROOM = 0.25;

// the holds' and paces' clock: monotonic, in epoch ms, as rpc.ts's (card helper-crowd-429: the box's wall clock stepped
// back inside a test, which would hold a provider for the step's length)
export function providerHolds(now: () => number = () => performance.timeOrigin + performance.now(), pace: Readonly<Record<string, Pace>> = PROVIDER_PACE): ProviderHolds {
  const until = new Map<string, number>();
  const buckets = new Map<string, { tokens: number; at: number }>();
  /** Per provider: until when a caller's read that found no room waits for it (card helper-deploy-reads-fast). Background
   *  draws none of the bucket meanwhile, so the refill it waits for is its own: a background post of fewer units would
   *  win every refill race against a caller's larger batch (a planted run: 39 open books' ticks held a cold candles read
   *  6.4 s on the paces alone). Cleared by the caller's draw; a caller that asks another provider instead leaves it to
   *  end on its own, at most the wait it was named. */
  const callerWaits = new Map<string, number>();
  const fill = (url: string, p: Pace) => {
    const t = now();
    const b = buckets.get(url) ?? { tokens: p.burst, at: t };
    b.tokens = Math.min(p.burst, b.tokens + ((t - b.at) * p.perS) / 1000);
    b.at = t;
    buckets.set(url, b);
    return b;
  };
  return {
    take(url, calls, background) {
      const p = pace[url];
      if (p === undefined) return 0;
      const b = fill(url, p);
      const t = now();
      const waiting = (callerWaits.get(url) ?? 0) - t;
      if (background && waiting > 0) return Math.max(1, Math.ceil(waiting));
      const floor = background ? p.burst * CALLER_ROOM : 0;
      // a post larger than the bucket waits for a full one
      const units = Math.min(p.unit === "post" ? 1 : Math.max(calls, 1), p.burst - floor);
      // a caller's draw, or its wait, keeps the bucket's refill for callers CALLER_HOLD_MS on (or until its wait ends)
      const keep = (ms: number) => callerWaits.set(url, Math.max(callerWaits.get(url) ?? 0, t + ms));
      if (b.tokens - units >= floor) {
        b.tokens -= units;
        if (!background) keep(CALLER_HOLD_MS);
        return 0;
      }
      const w = Math.max(1, Math.ceil(((units + floor - b.tokens) * 1000) / p.perS));
      if (!background) keep(Math.max(w, CALLER_HOLD_MS));
      return w;
    },
    room(url) {
      const p = pace[url];
      return p === undefined ? 1 : fill(url, p).tokens / p.burst;
    },
    paceOf(url) {
      return pace[url];
    },
    heldFor(url) {
      const u = until.get(url) ?? 0;
      if (u <= now()) return 0;
      return secondsUntil(u, now());
    },
    heldMs(url) {
      return Math.max((until.get(url) ?? 0) - now(), 0);
    },
    hold(url, seconds) {
      const t = now();
      until.set(url, Math.max(until.get(url) ?? 0, t + Math.min(Math.max(seconds, 0), RETRY_AFTER_MAX_S) * 1000));
    },
  };
}

/** A read behind a cached answer was throttled (its upstream's 429, the helper's own budget, a paused queue): the
 * cache answers 429 with `retryAfterS` instead of 503 when it has nothing good to serve. */
export class Throttled extends Error {
  readonly retryAfterS: number;
  /** The limit that refused, for the refusal log (throttled() above). */
  readonly why: string | undefined;
  constructor(retryAfterS: number, why?: string) {
    super("throttled");
    this.retryAfterS = retryAfterS;
    this.why = why;
  }
}

/** The wait a helper answer (throttled() above, from the RPC or proxy part) names: its Retry-After, 1 to
 * RETRY_AFTER_MAX_S; 1 when it names none. */
export function retryAfterOf(h: Record<string, string> | undefined): number {
  const s = Number(h?.["Retry-After"]);
  return Number.isSafeInteger(s) && s >= 1 ? Math.min(s, RETRY_AFTER_MAX_S) : 1;
}

/** The whole seconds from `now` until `untilMs`, 1 to RETRY_AFTER_MAX_S. */
export const secondsUntil = (untilMs: number, now: number): number => Math.min(Math.max(Math.ceil((untilMs - now) / 1000), 1), RETRY_AFTER_MAX_S);

/** An upstream's 429 as the wait to name: its Retry-After or rate-limit reset, in whole seconds, 1 to RETRY_AFTER_MAX_S. */
export function upstreamRetryAfterS(h: Headers, now: number): number {
  const ms = resetMs(h, now);
  return Math.min(Math.max(Math.ceil((Number.isFinite(ms) ? ms : 1000) / 1000), 1), RETRY_AFTER_MAX_S);
}

/** The whole seconds from `now` to the end of its window, at least 1. */
const toWindowEnd = (now: number, windowMs: number): number => Math.max(1, Math.ceil(((Math.floor(now / windowMs) + 1) * windowMs - now) / 1000));

/**
 * A per-client fixed window: take(client) goes ahead while the client is under `max` requests in the current window,
 * else names the seconds to the window's end. The map is cleared at every window's turn.
 */
export function clientWindow(max: number, now: () => number = Date.now, windowMs = LIMIT_WINDOW_MS, clients = LIMIT_CLIENTS): { take(client: string): Take } {
  let window = -1;
  const counts = new Map<string, number>();
  return {
    take(client) {
      const t = now();
      const w = Math.floor(t / windowMs);
      if (w !== window) {
        window = w;
        counts.clear();
      }
      const n = (counts.get(client) ?? 0) + 1;
      if (n === 1 && counts.size >= clients) counts.delete(counts.keys().next().value as string);
      counts.set(client, n);
      return n <= max ? 0 : toWindowEnd(t, windowMs);
    },
  };
}

/** One key's limits: its provider takes `total` requests from every caller together in any `windowMs` (a sliding
 * window, the provider's own: 10 s for a chain's RPC, a minute for a vendor; unset, the budget's window), and one
 * caller draws at most `perClient` of them per fixed LIMIT_WINDOW_MS window (perClient under total; Infinity: no share).
 * `reserve` of the total is kept for the helper's own reads that serve every user (Discover's lists, the token page's
 * batched search): only a draw marked reserved may use it, so no set of callers can make those reads stale.
 * `userRoom` of the total is kept for callers (card helper-ready-gate): the helper's own background reads (no caller,
 * not reserved: the trade walks) go only while every draw in the window, callers' included, leaves it free, so callers
 * go ahead of them and a walk never makes a caller wait for room it took. */
/** `lend` (card helper-crowd-429): the share is work-conserving. A caller past its 10 s share, or whose draws in the
 * vendor's window already took LEND_FREE_SHARES shares or half the callers' part, still draws while the total, less
 * the reserve, keeps LEND_NEW_SHARES shares free for callers not seen yet and one for each other caller with a draw in
 * the vendor's window (folds 3 and 4): the share only orders callers when the total is contended (the heavy one goes
 * behind), and a device's second trade inside 10 s is no longer refused while the budget sits idle. A draw that
 * reaches no vendor (a cache hit) keeps its share. The total and the reserve are unchanged. */
/** A lending key's caller draws its first LEND_FREE_SHARES shares in the vendor's window (two trades of Jupiter
 * builds a minute) on the total alone; past them it is lent, behind every other caller (card helper-crowd-429 fold 3:
 * with half the callers' part as the only mark, two heavy callers drew all of it before either was lent, and a third
 * caller's trade got 429). */
export const LEND_FREE_SHARES = 2;
/** The shares a lent caller leaves free for callers not seen yet in the vendor's window, beside one for each caller
 * seen (card helper-crowd-429 fold 4: with one, a heavy device and one user drawing inside its share refused a third
 * first-time user for up to a minute). A lone heavy device draws 26 - 3 * 4 = 14 of Jupiter's callers' part a minute. */
export const LEND_NEW_SHARES = 3;
export type BudgetLimits = { total: number; perClient: number; windowMs?: number; reserve?: number; userRoom?: number; lend?: boolean };

/**
 * A shared upstream budget per key (a chain's RPC provider, one RPC method on it, a vendor). Every call that reaches
 * the provider draws from the key's `total`, the helper's own reads included (they pass no client), counted over a
 * sliding window as long as the provider's plus a second, so no stretch of the provider's window ever holds more than
 * the total we sent; a caller draws at most its `perClient` share per fixed window, so an honest caller still draws
 * while one is throttled. takeEach([[key, n], ...], client) draws on every key at once or on none (a batch is n calls
 * to the provider, one per method key too); `shareOnly` counts them in the caller's share alone (a cache hit or a call
 * joining one in flight, which reach no provider). When the provider throttles a caller's read anyway, hold(key,
 * untilMs) stops every draw on the key until its reset: the helper is the provider's one client, so it waits out what
 * the provider named, and every caller is told the seconds left. When it throttles a background read (no caller, not
 * reserved: the trade walks), hold(key, untilMs, true) stops only the background draws: those reads go behind callers
 * (userRoom), so their reset never refuses a caller; a caller's read the provider throttles in turn holds every draw.
 * A refused draw names the seconds until it would go ahead.
 */
export function upstreamBudget(limitsOf: (key: string) => BudgetLimits, now: () => number = Date.now, windowMs = LIMIT_WINDOW_MS, clients = LIMIT_CLIENTS) {
  let window = -1;
  /** Per key and client: the share drawn in the current fixed window. */
  const shares = new Map<string, Map<string, number>>();
  /** Per lending key and client: when each of its draws reached the vendor, kept for the vendor's window. */
  const drawn = new Map<string, Map<string, number[]>>();
  const drawnBy = (key: string, client: string, t: number, lim: BudgetLimits): number => {
    const d = drawn.get(key)?.get(client);
    if (d === undefined) return 0;
    const from = t - (lim.windowMs ?? windowMs);
    while (d.length > 0 && d[0]! <= from) d.shift();
    return d.length;
  };
  /** Per lending key: each client's last draw that reached the vendor, oldest first (card helper-crowd-429 fold 3). */
  const active = new Map<string, Map<string, number>>();
  /** Per lending key: when each client last asked as a lent caller, drawn or refused, oldest first (fold 4). A caller
   * that asked past its free shares in the vendor's window keeps one share a window on the total alone and is lent the
   * rest: without this a heavy caller drew all its free shares again each time its old draws left the window, and two
   * heavy callers' free shares beside two users' trades overran the callers' part. */
  const lentAt = new Map<string, Map<string, number>>();
  const lentIn = (key: string, client: string, t: number, lim: BudgetLimits): boolean => {
    const l = lentAt.get(key);
    if (l === undefined) return false;
    const from = t - (lim.windowMs ?? windowMs);
    for (const [c, at] of l) {
      if (at > from) break;
      l.delete(c);
    }
    return l.has(client);
  };
  const markLent = (key: string, client: string, t: number): void => {
    let l = lentAt.get(key);
    if (l === undefined) lentAt.set(key, (l = new Map()));
    l.delete(client);
    if (l.size >= clients) l.delete(l.keys().next().value as string);
    l.set(client, t);
  };
  /** The other clients with a draw in the vendor's window: the oldest leave first, their draws with them. */
  const activeOthers = (key: string, client: string, t: number, lim: BudgetLimits): number => {
    const a = active.get(key);
    if (a === undefined) return 0;
    const from = t - (lim.windowMs ?? windowMs);
    for (const [c, at] of a) {
      if (at > from) break;
      a.delete(c);
      drawn.get(key)?.delete(c);
    }
    return a.size - (a.has(client) ? 1 : 0);
  };
  /** Per key: [second, requests sent in it, of them not reserved], oldest first, kept while the provider's window may
   * still count them. */
  const sent = new Map<string, [number, number, number][]>();
  /** Per key: the draws another helper on the same upstream made (card helper-deploy-reads-fast: the one a deploy runs
   *  beside this one, proxy/shared-calls.ts), [second, requests, requests], oldest first; counted as every draw is, and replaced
   *  whole by the next seed of the key, so a file read twice counts once. */
  const seeded = new Map<string, [number, number, number][]>();
  /** The key's draws in its window, ours and the seeded ones, oldest first. */
  const windowOf = (key: string, sec: number, w: number): [number, number, number][] => {
    const q = sent.get(key) ?? [];
    while (q.length > 0 && q[0]![0] < sec - w) q.shift();
    const s = (seeded.get(key) ?? []).filter((b) => b[0] >= sec - w);
    return s.length === 0 ? q : [...q, ...s].sort((a, b) => a[0] - b[0]);
  };
  /** Per key (never a client): when the provider's own reset ends, for every draw; and for background draws only. */
  const heldUntil = new Map<string, number>();
  const backgroundHeldUntil = new Map<string, number>();
  const heldIn = (m: Map<string, number>, key: string, t: number): number => {
    const until = m.get(key) ?? 0;
    if (until <= t) {
      m.delete(key);
      return 0;
    }
    return secondsUntil(until, t);
  };
  /** The seconds a draw on `key` waits for a provider's reset: a background draw also for a background read's. */
  const heldFor = (key: string, t: number, background = false): number => Math.max(heldIn(heldUntil, key, t), background ? heldIn(backgroundHeldUntil, key, t) : 0);
  /** What refused the last draw that was refused: "<key> held", "<key> share" or "<key> total" (card app-console-429). */
  let refusedBy = "";
  /** The seconds until `n` more fit (0: they fit now): every draw under the key's total, and a draw not reserved also
   * with every other such draw under the total less the reserve, so the helper's own reads always find their room. A
   * request sent in second s may still be in the provider's window until the end of second s + W, W its window in
   * seconds. A background draw (`background`) also leaves the key's userRoom free. */
  const totalWait = (key: string, n: number, t: number, lim: BudgetLimits, reserved: boolean, background: boolean): number => {
    const w = Math.ceil((lim.windowMs ?? windowMs) / 1000);
    const sec = Math.floor(t / 1000);
    const q = windowOf(key, sec, w);
    const until = (i: 1 | 2, cap: number): number => {
      let used = 0;
      for (const b of q) used += b[i];
      if (used + n <= cap) return 0;
      if (n > cap) return RETRY_AFTER_MAX_S;
      for (const b of q) {
        used -= b[i];
        if (used + n <= cap) return secondsUntil((b[0] + w + 1) * 1000, t);
      }
      return RETRY_AFTER_MAX_S;
    };
    return Math.max(until(1, lim.total), reserved ? 0 : until(2, lim.total - (lim.reserve ?? 0) - (background ? (lim.userRoom ?? 0) : 0)));
  };
  /** `reserved`: the helper's own read that may use the key's reserve; every other draw stops at total less reserve. */
  function takeEach(draws: readonly (readonly [string, number])[], client?: string, shareOnly = false, reserved = false): Take {
    const t = now();
    const want = new Map<string, number>();
    for (const [key, n] of draws) want.set(key, (want.get(key) ?? 0) + n);
    let wait = 0;
    const background = client === undefined && !reserved;
    for (const key of want.keys()) {
      const h = heldFor(key, t, background);
      if (h > wait) (wait = h), (refusedBy = `${key} held`);
    }
    if (wait > 0) return wait;
    const w = Math.floor(t / windowMs);
    if (w !== window) {
      window = w;
      shares.clear();
    }
    for (const [key, n] of want) {
      const lim = limitsOf(key);
      const overShare = client !== undefined && Number.isFinite(lim.perClient) && (shares.get(key)?.get(client) ?? 0) + n > lim.perClient;
      // a lending key's caller past its share, or past LEND_FREE_SHARES shares or half the callers' part in the vendor's
      // window, is lent only while LEND_NEW_SHARES shares stay free for callers not seen yet and one for each other
      // caller with a draw in the vendor's window (card helper-crowd-429 folds 3 and 4: counted over the vendor's window,
      // a minute for Jupiter, not the 10 s share window, so a caller that drew earlier in the minute never drops out of
      // the count at a 10 s boundary): it goes behind them when the total is contended, never ahead
      const heavy = lim.lend === true && client !== undefined && !shareOnly && (overShare || drawnBy(key, client, t, lim) + n > (lentIn(key, client, t, lim) ? lim.perClient : Math.min(LEND_FREE_SHARES * lim.perClient, Math.ceil((lim.total - (lim.reserve ?? 0)) / 2))));
      if (heavy) {
        markLent(key, client, t);
        const keep = lim.perClient * (LEND_NEW_SHARES + activeOthers(key, client, t, lim));
        const tk = totalWait(key, n + keep, t, lim, reserved, background);
        if (tk > wait) (wait = tk), (refusedBy = `${key} ${overShare ? "share" : "total"}`);
      } else if (overShare) {
        const s = toWindowEnd(t, windowMs);
        if (s > wait) (wait = s), (refusedBy = `${key} share`);
      }
      const tw = shareOnly ? 0 : totalWait(key, n, t, lim, reserved, background);
      if (tw > wait) (wait = tw), (refusedBy = `${key} total`);
    }
    if (wait > 0) return wait;
    const sec = Math.floor(t / 1000);
    for (const [key, n] of want) {
      if (client !== undefined && Number.isFinite(limitsOf(key).perClient)) {
        let k = shares.get(key);
        if (k === undefined) shares.set(key, (k = new Map()));
        const c = k.get(client) ?? 0;
        if (c === 0 && k.size >= clients) k.delete(k.keys().next().value as string);
        k.set(client, c + n);
      }
      if (shareOnly) continue;
      if (client !== undefined && limitsOf(key).lend === true) {
        let m = drawn.get(key);
        if (m === undefined) drawn.set(key, (m = new Map()));
        const d = m.get(client) ?? [];
        if (d.length === 0 && m.size >= clients) m.delete(m.keys().next().value as string);
        for (let i = 0; i < n; i++) d.push(t);
        m.set(client, d);
        let a = active.get(key);
        if (a === undefined) active.set(key, (a = new Map()));
        a.delete(client);
        if (a.size >= clients) {
          const first = a.keys().next().value as string;
          a.delete(first);
          m.delete(first);
        }
        a.set(client, t);
      }
      let q = sent.get(key);
      if (q === undefined) sent.set(key, (q = []));
      const last = q[q.length - 1];
      const others = reserved ? 0 : n;
      if (last !== undefined && last[0] === sec) (last[1] += n), (last[2] += others);
      else q.push([sec, n, others]);
    }
    return 0;
  }
  return {
    takeEach,
    /** The ms times of this helper's own draws on `key` its upstream may still count (its window and a second), oldest
     *  first, never the seeded ones: what the other helpers on the same upstream count (card helper-deploy-reads-fast). */
    calls(key: string): number[] {
      const lim = limitsOf(key);
      const w = Math.ceil((lim.windowMs ?? windowMs) / 1000);
      const sec = Math.floor(now() / 1000);
      return (sent.get(key) ?? []).filter((b) => b[0] >= sec - w).flatMap((b) => Array.from({ length: b[1] }, () => b[0] * 1000));
    },
    /** Counts `times` (ms) as draws another helper made on `key`'s upstream, in place of the last seed of the key. */
    seed(key: string, times: readonly number[]): void {
      const by = new Map<number, number>();
      for (const x of times) if (Number.isFinite(x)) by.set(Math.floor(x / 1000), (by.get(Math.floor(x / 1000)) ?? 0) + 1);
      seeded.set(key, [...by].sort((a, b) => a[0] - b[0]).map(([sec, n]) => [sec, n, n]));
    },
    /** What refused the last refused draw (read right after it): "<key> held", "<key> share" or "<key> total". */
    refusedBy: (): string => refusedBy,
    /** One key: n requests for `client` (undefined: the helper's own read, which draws from the total only). */
    take: (key: string, client: string | undefined, n = 1, shareOnly = false, reserved = false): Take => takeEach([[key, n]], client, shareOnly, reserved),
    /** The seconds a draw on `key` must still wait for the provider's reset (`background`: a background draw); 0 when none. */
    heldFor: (key: string, background = false): Take => heldFor(key, now(), background),
    /** When the provider's reset on `key` ends, in ms on the budget's clock, for every draw; 0 when none holds it (card
     *  helper-crowd-429: a caller waits out a short one, ../rpc/rpc.ts). */
    heldUntil: (key: string): number => (heldIn(heldUntil, key, now()) > 0 ? heldUntil.get(key)! : 0),
    /** The provider throttled: no draw on `key` until `untilMs`, held to at most RETRY_AFTER_MAX_S from now; with
     *  `background`, it throttled a background read, and only background draws wait. */
    hold(key: string, untilMs: number, background = false): void {
      const t = now();
      const m = background ? backgroundHeldUntil : heldUntil;
      m.set(key, Math.max(m.get(key) ?? 0, Math.min(untilMs, t + RETRY_AFTER_MAX_S * 1000)));
    },
  };
}

/** Rules a budget variable may add: the least share (`minShare`, a batch's size where a call can be one), a third
 * number, the most one RPC method may draw of the total (`perMethod`, at least `minShare` plus the reserve, at most the
 * total), and the key's own-read `reserve`, which the share must stay under the total less. */
export type BudgetRules = { minShare?: number; perMethod?: boolean; reserve?: number };

/** `RPC_BUDGET_<CHAIN>`-style limits: "<total>,<perClient>" (or with `perMethod`, "<total>,<perClient>[,<perMethod>]"),
 * whole numbers, perClient at least `minShare` and under total; unset: `fallback`. A start with any other value stops,
 * naming the variable, never the value. */
export function budgetFromEnv(env: Record<string, string | undefined>, name: string, fallback: BudgetLimits & { perMethod?: number }, rules: BudgetRules = {}): BudgetLimits & { perMethod?: number } {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const min = rules.minShare ?? 1;
  const reserve = rules.reserve ?? 0;
  const m = (rules.perMethod ? /^([1-9][0-9]{0,6}),([1-9][0-9]{0,6})(?:,([1-9][0-9]{0,6}))?$/ : /^([1-9][0-9]{0,6}),([1-9][0-9]{0,6})$/).exec(v);
  const total = Number(m?.[1]);
  const perClient = Number(m?.[2]);
  const perMethod = m?.[3] === undefined ? undefined : Number(m[3]);
  if (!m || !(perClient < total - reserve) || perClient < min || (perMethod !== undefined && !(perMethod >= min + reserve && perMethod <= total))) {
    const form = rules.perMethod ? `"<total>,<per client>[,<per method>]"` : `"<total>,<per client>"`;
    throw new Error(`${name} must be ${form}, whole numbers, the share at least ${min} and under the total less the helper's own ${reserve}${rules.perMethod ? ", a method's at least " + (min + reserve) + " and at most the total" : ""}`);
  }
  return perMethod === undefined ? { total, perClient } : { total, perClient, perMethod };
}

/**
 * Requests one client holds open at once (M374 (5)): enter(client) is false once the client holds `max`; every true
 * enter is paired with one leave when that request's answer is decided. The address leaves the map with its last
 * held request.
 */
export function heldPerClient(max: number): { enter(client: string): boolean; leave(client: string): void; readonly size: number } {
  const held = new Map<string, number>();
  return {
    enter(client) {
      const n = held.get(client) ?? 0;
      if (n >= max) return false;
      held.set(client, n + 1);
      return true;
    },
    leave(client) {
      const n = (held.get(client) ?? 1) - 1;
      if (n > 0) held.set(client, n);
      else held.delete(client);
    },
    get size() {
      return held.size;
    },
  };
}
