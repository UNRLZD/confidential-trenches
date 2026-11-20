// One quote per ask (card dry-ask-joins-the-running-quote). The kit's client gives up on a dry at 10 s
// (packages/kit/src/signpage/client.ts SIGNPAGE_TIMEOUT_MS) and the buy box asks again at once, under a new id; each ask
// started a new quote on the same paced reads, so a slow coin's quotes piled up until the reads ran out (NEAR, release
// 171: 148 seat reads for token.rhealab.near, then "down" for the next coin; Base: asks at 10, 20 and 30 s never
// answered in 75 s).
// joinRunning wraps a dry kind's handler: a request whose params are exactly a running one's (every field, as dryKey
// writes them) gets that run's own `after` and `answer`, so one quote runs and every asker is answered with it, each under
// its own id (src/api.ts keeps an id's answer, replay and id_reused apart from every other id). Any field that differs
// (chain, coin, amount, side, slippage, share, or one a later payload adds) is another key and its own run. A run leaves
// the map the moment it settles, before src/api.ts posts its answer, so an ask after that starts a new quote: no answer is
// served from memory. A handler's answer given at once (a refusal, no run) joins nothing. src/main.ts wraps the buy and
// sell dries at its kinds map, above the routing to each chain, so every chain joins in this one place.
import type { Running } from "./api.ts";

/** The join key: every field of `params` (the request's fields past v, id and type, as the kit's schema passed them),
 *  keys sorted at every depth, as JSON; types kept, so "1" and 1 differ. */
export function dryKey(params: Record<string, unknown>): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sorted(params));
}

const isRunning = (v: unknown): v is Running<never> => typeof v === "object" && v !== null && (v as { running?: unknown }).running === true;

/** `run` with every request that matches a running one exactly answered by that run (see above). */
export function joinRunning<F extends (params: Record<string, unknown>) => unknown>(run: F): F {
  const running = new Map<string, Running<never>>();
  return ((params: Record<string, unknown>) => {
    const key = dryKey(params);
    const on = running.get(key);
    // a new object for the asker: the run's own wait and answer, nothing of the first asker's
    if (on) return { running: true, after: on.after, answer: on.answer };
    const got = run(params);
    if (!isRunning(got)) return got;
    running.set(key, got);
    // settled either way: out of the map now, ahead of every answer src/api.ts posts for it (its handlers come after)
    const end = (): void => void (running.get(key) === got && running.delete(key));
    got.after.then(end, end);
    return got;
  }) as F;
}
