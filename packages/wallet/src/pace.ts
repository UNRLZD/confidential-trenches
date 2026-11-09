// One pace per NEAR provider URL for the whole page (card wallet-id-reader-paced, review P3-5): every request a
// device sends to one provider URL takes a slot of that URL's one token bucket (GCRA), whichever reader sends it: the
// restore's IdReader (restore/id-reader.ts asked), the deposit follow (deposit/follow.ts followRpc), the held deposit's
// way out (deposit/moveout.ts), the withdraw relay's reads (withdraw/relay.ts relayRpc) and the bind (deposit/bind.ts).
// A busy answer one reader gets holds that URL for every reader. Before, each NearRpc object had its own bucket, so
// each new object got a fresh burst and a busy hold died with its object (review P3-5).
// A reader built on the default fetch goes through pacedFetch (the real clock); one given its own fetch (tests) is not
// paced there, and the IdReader then takes the slot itself (asked), on the clock it is given.
import { NEAR_NETWORKS } from "./deposit/account.ts";

/**
 * Each provider's pace: `perSec` requests a second, `burst` at once. FastNEAR's is its sustained rate, read 9 Nov
 * 02:59-03:20Z (the IdReader's three views of fresh random ids, one at a time on the clock). Offered 2.5 a second for
 * 360 s it answered 75 of the first 75, then about 1.6 a second for 90 s, then stopped answering at all for about 3
 * minutes (460 failed fetches, 32 timeouts): 0.389 a second answered over the last 270 s. After a drain (its first 429
 * at view 101), held at 0.66 a second for 600 s it answered every view for 7 minutes, then 60 of 99 over the last 150 s
 * (0.40 a second). So 0.39 a second is what it holds over time, and asking faster earns its block, which no wait
 * outlasts: an empty scope's step 5 at 0.39 read all 168 ids on both providers in 1338.2 s with 14 busy answers (9 Nov
 * 03:23-03:45Z; at 1.5 a second, 763 s with 513 busy of 1016). Its 429 carries access-control-allow-origin: * (read
 * 03:20Z with the page's Origin), so the page sees the status and waits it out. dRPC answered 181 of 181 at 3 a second,
 * 151 of 151 asked at 5 a second (3.8 a second answered, p50 253 ms) and 300 of 300 flat out, with no 429 (9 Nov
 * 01:27-01:38Z).
 */
export const PACE: Readonly<Record<"fastnear" | "drpc", { perSec: number; burst: number }>> = Object.freeze({ fastnear: Object.freeze({ perSec: 0.39, burst: 8 }), drpc: Object.freeze({ perSec: 3.5, burst: 10 }) });

/** A provider URL's pace: the theoretical arrival time of its next request, and the gap one request takes. */
export type Pace = { tat: number; every: number; burst: number };
const PACES = new Map<string, Pace>();
/** The one pace of provider `url` (a FastNEAR URL or a dRPC URL of NEAR_NETWORKS; any other URL is not paced). */
export function paceOf(url: string): Pace {
  let p = PACES.get(url);
  if (p === undefined) {
    const net = Object.values(NEAR_NETWORKS).find((n) => (n.fastnear as readonly string[]).includes(url) || n.drpc === url);
    const pace = net === undefined ? null : PACE[(net.fastnear as readonly string[]).includes(url) ? "fastnear" : "drpc"];
    p = pace === null ? { tat: 0, every: 0, burst: 1 } : { tat: 0, every: 1000 / pace.perSec, burst: pace.burst };
    PACES.set(url, p);
  }
  return p;
}
/** The wait before this provider's next request (and the slot taken): `burst` at once, then one every `every` ms. */
export function paceSlot(p: Pace, now: number): number {
  p.tat = Math.max(p.tat, now);
  const at = p.tat - (p.burst - 1) * p.every;
  p.tat += p.every;
  return Math.max(0, at - now);
}
/** A busy answer holds the provider's every request for `ms`, its burst spent. */
export function paceHold(p: Pace, now: number, ms: number): void {
  p.tat = Math.max(p.tat, now + ms + (p.burst - 1) * p.every);
}
/** Forgets every provider's pace (tests: each test's clock starts at its own zero). */
export function resetPaces(): void {
  PACES.clear();
}

const PACED = new WeakSet<object>();
/** Whether `fetchFn` is a pacedFetch (a reader built on it is paced at its transport). */
export const isPacedFetch = (fetchFn: unknown): boolean => typeof fetchFn === "function" && PACED.has(fetchFn);
/** fetch to `url`, each request after `url`'s slot on the real clock; the request's own signal aborts the wait. */
export function pacedFetch(url: string, fetchFn: typeof fetch = (...a) => fetch(...a)): typeof fetch {
  const p = paceOf(url);
  const f = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const w = paceSlot(p, performance.now());
    if (w > 0) {
      const signal = init?.signal ?? undefined;
      await new Promise<void>((res, rej) => {
        if (signal?.aborted) return rej(signal.reason);
        const t = setTimeout(() => {
          signal?.removeEventListener("abort", stop);
          res();
        }, w);
        const stop = (): void => {
          clearTimeout(t);
          rej(signal!.reason);
        };
        signal?.addEventListener("abort", stop, { once: true });
      });
    }
    return fetchFn(input, init);
  };
  PACED.add(f);
  return f as typeof fetch;
}

const PACED_RPCS = new WeakSet<object>();
/** `rpc`, marked paced at its transport when `fetchFn` is a pacedFetch (so the IdReader takes no second slot). */
export function pacedRpc<T extends object>(rpc: T, fetchFn: unknown): T {
  if (isPacedFetch(fetchFn)) PACED_RPCS.add(rpc);
  return rpc;
}
/** Whether `rpc` is paced at its transport (pacedRpc on a pacedFetch). */
export const isPacedRpc = (rpc: object): boolean => PACED_RPCS.has(rpc);
