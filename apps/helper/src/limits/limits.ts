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
 * limit): the wait to name, 1 s, as a thrown error carries no reset; 0 for any other failure. */
export function throttleOf(e: unknown): number {
  return /\bHTTP 429\b|rate.?limit|too many requests/i.test(String((e as Error | undefined)?.message ?? e)) ? 1 : 0;
}

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

/** One key's limits: its provider takes `total` requests a window from every caller together, and one caller draws
 * at most `perClient` of them (perClient < total). */
export type BudgetLimits = { total: number; perClient: number };

/**
 * A shared upstream budget per key (a chain's RPC provider, a vendor). Every caller draws from the key's `total`
 * requests a window and no caller more than its `perClient` share, so no single caller can make the provider throttle
 * us (the share is sized under the provider's own limit) and an honest caller still draws while one is throttled.
 * take(key, client, n) draws n requests at once (a batch is n calls to the provider); `shareOnly` counts them in the
 * caller's share alone (a cache hit, which reaches no provider). When the provider throttles anyway, hold(key, untilMs)
 * stops every draw on the key until its reset: the helper is the provider's one client, so it waits out what the
 * provider named, and every caller is told the seconds left. A refused draw names the seconds to the window's end.
 */
export function upstreamBudget(limitsOf: (key: string) => BudgetLimits, now: () => number = Date.now, windowMs = LIMIT_WINDOW_MS, clients = LIMIT_CLIENTS) {
  let window = -1;
  const keys = new Map<string, { total: number; counts: Map<string, number> }>();
  /** Per key (never a client): when the provider's own reset ends. */
  const heldUntil = new Map<string, number>();
  const heldFor = (key: string, t: number): number => {
    const until = heldUntil.get(key) ?? 0;
    if (until <= t) {
      heldUntil.delete(key);
      return 0;
    }
    return Math.min(Math.max(Math.ceil((until - t) / 1000), 1), RETRY_AFTER_MAX_S);
  };
  return {
    take(key: string, client: string, n = 1, shareOnly = false): Take {
      const t = now();
      const held = heldFor(key, t);
      if (held > 0) return held;
      const w = Math.floor(t / windowMs);
      if (w !== window) {
        window = w;
        keys.clear();
      }
      const { total, perClient } = limitsOf(key);
      let k = keys.get(key);
      if (k === undefined) keys.set(key, (k = { total: 0, counts: new Map() }));
      const c = k.counts.get(client) ?? 0;
      if (c + n > perClient || (!shareOnly && k.total + n > total)) return toWindowEnd(t, windowMs);
      if (c === 0 && k.counts.size >= clients) k.counts.delete(k.counts.keys().next().value as string);
      k.counts.set(client, c + n);
      if (!shareOnly) k.total += n;
      return 0;
    },
    /** The seconds every draw on `key` must still wait for the provider's reset; 0 when none. */
    heldFor: (key: string): Take => heldFor(key, now()),
    /** The provider throttled: no draw on `key` until `untilMs`, held to at most RETRY_AFTER_MAX_S from now. */
    hold(key: string, untilMs: number): void {
      const t = now();
      heldUntil.set(key, Math.max(heldUntil.get(key) ?? 0, Math.min(untilMs, t + RETRY_AFTER_MAX_S * 1000)));
    },
  };
}

/** `RPC_BUDGET_<CHAIN>`-style limits: "<total>,<perClient>" requests per LIMIT_WINDOW_MS, whole numbers, perClient
 * under total; unset: `fallback`. A start with any other value stops, naming the variable, never the value. */
export function budgetFromEnv(env: Record<string, string | undefined>, name: string, fallback: BudgetLimits): BudgetLimits {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const m = /^([1-9][0-9]{0,6}),([1-9][0-9]{0,6})$/.exec(v);
  if (!m || !(Number(m[2]) < Number(m[1]))) throw new Error(`${name} must be "<total>,<per client>" per 10 s, whole numbers, the share under the total`);
  return { total: Number(m[1]), perClient: Number(m[2]) };
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
