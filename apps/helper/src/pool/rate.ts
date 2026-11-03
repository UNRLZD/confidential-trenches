// The pool routes' per-client rate limit (card helper-pool-senders, M356 (3)): a fixed window per client, kept in
// memory only. The client is the address Caddy forwards (deploy/Caddyfile: reverse_proxy sets X-Forwarded-For to the
// peer it saw and keeps no access log), else the socket's peer. The address is a map key and nothing else: never
// logged, never answered, gone at restart or when the window's map is cleared.
import type { IncomingMessage } from "node:http";

/** Requests one client may make to the pool routes per window [design: a device sends one release per tap and reads
 * the fee once an epoch; 30 per 10 s leaves room for a ladder of sells while one client cannot flood the RPC reads]. */
export const POOL_RATE_MAX = 30;
export const POOL_RATE_WINDOW_MS = 10_000;
/** The most clients remembered in one window; past it the oldest goes [design: memory bound under a flood]. */
export const POOL_RATE_CLIENTS = 50_000;

/** The client's address as the proxy forwarded it (the last X-Forwarded-For entry), else the socket's peer. */
export function clientOf(req: IncomingMessage): string {
  const f = req.headers["x-forwarded-for"];
  const last = (Array.isArray(f) ? f.join(",") : (f ?? "")).split(",").pop()!.trim();
  return last !== "" ? last : (req.socket?.remoteAddress ?? "");
}

export type RateLimit = { take(client: string): boolean };

/** take(client): true while the client is under POOL_RATE_MAX in the current window. */
export function poolRateLimit(now: () => number = Date.now, max = POOL_RATE_MAX, windowMs = POOL_RATE_WINDOW_MS, clients = POOL_RATE_CLIENTS): RateLimit {
  let window = -1;
  const counts = new Map<string, number>();
  return {
    take(client) {
      const w = Math.floor(now() / windowMs);
      if (w !== window) {
        window = w;
        counts.clear();
      }
      const n = (counts.get(client) ?? 0) + 1;
      if (n === 1 && counts.size >= clients) counts.delete(counts.keys().next().value as string);
      counts.set(client, n);
      return n <= max;
    },
  };
}
