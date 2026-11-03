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
import { resetMs } from "../proxy/proxy.ts";

/** The window every limit counts in [design: 10 s, the pool routes' window since M356 (3)]. */
export const LIMIT_WINDOW_MS = 10_000;
/** The most clients one limit remembers in one window; past it the oldest goes [design: memory bound under a flood]. */
export const LIMIT_CLIENTS = 50_000;
/** The longest wait the helper ever names: an upstream's own reset is held to it [design: one minute, as before]. */
export const RETRY_AFTER_MAX_S = 60;

/** The client's address as the proxy forwarded it (the last X-Forwarded-For entry), else the socket's peer. */
export function clientOf(req: IncomingMessage): string {
  const f = req.headers["x-forwarded-for"];
  const last = (Array.isArray(f) ? f.join(",") : (f ?? "")).split(",").pop()!.trim();
  return last !== "" ? last : (req.socket?.remoteAddress ?? "");
}

/** 0: go ahead; otherwise the whole seconds (1 or more) the caller is told to wait. */
export type Take = number;

/** The 429 every throttle answers: the code only, and the wait. */
export function throttled(retryAfterS: number, code = "rate_limited"): { status: 429; headers: Record<string, string>; body: string } {
  return { status: 429, headers: { "Retry-After": String(retryAfterS) }, body: JSON.stringify({ error: { code } }) };
}

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

/**
 * A shared upstream budget per key (a chain's RPC provider, a vendor): every caller draws from `total` requests a
 * window, and no client draws more than `perClient` of them (perClient < total). So one heavy caller is throttled at
 * its share while every other caller still draws from the rest; only callers that together pass `total` throttle the
 * key. A refused draw names the seconds to the window's end. This replaces a key-wide pause on an upstream 429: such
 * a 429 is answered to the caller that drew it (upstreamRetryAfterS) and stops nobody else.
 */
export function upstreamBudget(total: number, perClient: number, now: () => number = Date.now, windowMs = LIMIT_WINDOW_MS, clients = LIMIT_CLIENTS): { take(key: string, client: string): Take } {
  if (!(perClient < total)) throw new Error("a client's share must be under the shared total");
  let window = -1;
  const keys = new Map<string, { total: number; counts: Map<string, number> }>();
  return {
    take(key, client) {
      const t = now();
      const w = Math.floor(t / windowMs);
      if (w !== window) {
        window = w;
        keys.clear();
      }
      let k = keys.get(key);
      if (k === undefined) keys.set(key, (k = { total: 0, counts: new Map() }));
      const n = k.counts.get(client) ?? 0;
      if (n >= perClient || k.total >= total) return toWindowEnd(t, windowMs);
      if (n === 0 && k.counts.size >= clients) k.counts.delete(k.counts.keys().next().value as string);
      k.counts.set(client, n + 1);
      k.total++;
      return 0;
    },
  };
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
