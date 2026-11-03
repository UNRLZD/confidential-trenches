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
import { resetMs } from "../proxy/proxy.ts";

/** The window every limit counts in [design: 10 s, the pool routes' window since M356 (3)]. */
export const LIMIT_WINDOW_MS = 10_000;
/** The most clients one limit remembers in one window; past it the oldest goes [design: memory bound under a flood]. */
export const LIMIT_CLIENTS = 50_000;
/** The longest wait the helper ever names: an upstream's own reset is held to it [design: one minute, as before]. */
export const RETRY_AFTER_MAX_S = 60;

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

/** The 429 every throttle answers: the code only, and the wait. */
export function throttled(retryAfterS: number, code = "rate_limited"): { status: 429; headers: Record<string, string>; body: string } {
  return { status: 429, headers: { "Retry-After": String(retryAfterS) }, body: JSON.stringify({ error: { code } }) };
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

/** A read behind a cached answer was throttled (its upstream's 429, the helper's own budget, a paused queue): the
 * cache answers 429 with `retryAfterS` instead of 503 when it has nothing good to serve. */
export class Throttled extends Error {
  readonly retryAfterS: number;
  constructor(retryAfterS: number) {
    super("throttled");
    this.retryAfterS = retryAfterS;
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
 * batched search): only a draw marked reserved may use it, so no set of callers can make those reads stale. */
export type BudgetLimits = { total: number; perClient: number; windowMs?: number; reserve?: number };

/**
 * A shared upstream budget per key (a chain's RPC provider, one RPC method on it, a vendor). Every call that reaches
 * the provider draws from the key's `total`, the helper's own reads included (they pass no client), counted over a
 * sliding window as long as the provider's plus a second, so no stretch of the provider's window ever holds more than
 * the total we sent; a caller draws at most its `perClient` share per fixed window, so an honest caller still draws
 * while one is throttled. takeEach([[key, n], ...], client) draws on every key at once or on none (a batch is n calls
 * to the provider, one per method key too); `shareOnly` counts them in the caller's share alone (a cache hit or a call
 * joining one in flight, which reach no provider). When the provider throttles anyway, hold(key, untilMs) stops every
 * draw on the key until its reset: the helper is the provider's one client, so it waits out what the provider named,
 * and every caller is told the seconds left. A refused draw names the seconds until it would go ahead.
 */
export function upstreamBudget(limitsOf: (key: string) => BudgetLimits, now: () => number = Date.now, windowMs = LIMIT_WINDOW_MS, clients = LIMIT_CLIENTS) {
  let window = -1;
  /** Per key and client: the share drawn in the current fixed window. */
  const shares = new Map<string, Map<string, number>>();
  /** Per key: [second, requests sent in it, of them not reserved], oldest first, kept while the provider's window may
   * still count them. */
  const sent = new Map<string, [number, number, number][]>();
  /** Per key (never a client): when the provider's own reset ends. */
  const heldUntil = new Map<string, number>();
  const heldFor = (key: string, t: number): number => {
    const until = heldUntil.get(key) ?? 0;
    if (until <= t) {
      heldUntil.delete(key);
      return 0;
    }
    return secondsUntil(until, t);
  };
  /** The seconds until `n` more fit (0: they fit now): every draw under the key's total, and a draw not reserved also
   * with every other such draw under the total less the reserve, so the helper's own reads always find their room. A
   * request sent in second s may still be in the provider's window until the end of second s + W, W its window in
   * seconds. */
  const totalWait = (key: string, n: number, t: number, lim: BudgetLimits, reserved: boolean): number => {
    const w = Math.ceil((lim.windowMs ?? windowMs) / 1000);
    const sec = Math.floor(t / 1000);
    const q = sent.get(key) ?? [];
    while (q.length > 0 && q[0]![0] < sec - w) q.shift();
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
    return Math.max(until(1, lim.total), reserved ? 0 : until(2, lim.total - (lim.reserve ?? 0)));
  };
  /** `reserved`: the helper's own read that may use the key's reserve; every other draw stops at total less reserve. */
  function takeEach(draws: readonly (readonly [string, number])[], client?: string, shareOnly = false, reserved = false): Take {
    const t = now();
    const want = new Map<string, number>();
    for (const [key, n] of draws) want.set(key, (want.get(key) ?? 0) + n);
    let wait = 0;
    for (const key of want.keys()) wait = Math.max(wait, heldFor(key, t));
    if (wait > 0) return wait;
    const w = Math.floor(t / windowMs);
    if (w !== window) {
      window = w;
      shares.clear();
    }
    for (const [key, n] of want) {
      const lim = limitsOf(key);
      if (client !== undefined && Number.isFinite(lim.perClient) && (shares.get(key)?.get(client) ?? 0) + n > lim.perClient) wait = Math.max(wait, toWindowEnd(t, windowMs));
      if (!shareOnly) wait = Math.max(wait, totalWait(key, n, t, lim, reserved));
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
    /** One key: n requests for `client` (undefined: the helper's own read, which draws from the total only). */
    take: (key: string, client: string | undefined, n = 1, shareOnly = false, reserved = false): Take => takeEach([[key, n]], client, shareOnly, reserved),
    /** The seconds every draw on `key` must still wait for the provider's reset; 0 when none. */
    heldFor: (key: string): Take => heldFor(key, now()),
    /** The provider throttled: no draw on `key` until `untilMs`, held to at most RETRY_AFTER_MAX_S from now. */
    hold(key: string, untilMs: number): void {
      const t = now();
      heldUntil.set(key, Math.max(heldUntil.get(key) ?? 0, Math.min(untilMs, t + RETRY_AFTER_MAX_S * 1000)));
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
