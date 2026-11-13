// One pace per NEAR provider URL for the whole page (card wallet-id-reader-paced, review P3-5): every request a
// device sends to one provider URL takes a slot of that URL's one token bucket (GCRA), whichever reader sends it: the
// restore's IdReader (restore/id-reader.ts asked), the deposit follow (deposit/follow.ts followRpc), the held deposit's
// way out (deposit/moveout.ts), the withdraw relay's reads (withdraw/relay.ts relayRpc) and the bind (deposit/bind.ts).
// A busy answer one reader gets holds that URL for every reader. Before, each NearRpc object had its own bucket, so
// each new object got a fresh burst and a busy hold died with its object (review P3-5).
// A reader built on the default fetch goes through pacedFetch (the real clock); one given its own fetch (tests) is not
// paced there, and the IdReader then takes the slot itself (asked), on the clock it is given.
// A request on pacedFetch waits for its slot under its caller's own signal only, and its deadline (RPC_TIMEOUT_MS)
// starts when the slot comes; a wait its caller ends gives the slot back (delta review 2, P1: with the deadline
// started before the queue, the fourth request queued on FastNEAR's 2.56 s gap timed out unsent, its slot lost and its
// retry queued behind it again, so four chains at once stalled for good). Every ended wait gives its own slot back,
// never one inside a busy hold (delta review 4: giving back only the queue's tail kept every slot a sign-out ended but
// the last, since one signal's listeners run in slot order, 51.2 s for the next request after 20 queued; lowering tat
// one gap for a slot in the middle instead put the next request on the tail's slot, 12 at one instant on a burst of 8).
import { NEAR_NETWORKS, type NearNetwork, type NearRpc, nearRpc, RPC_TIMEOUT_MS, type RpcHttpError } from "./deposit/account.ts";

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
 * 01:27-01:38Z). dRPC's own docs: "Under normal conditions for the free tier, we have a limit of 25 RPS"
 * (docs.drpc.org/howitworks/ratelimiting, read 2026-11-12 22:1xZ), so its pace is 10 a second, 20 at once, 40% of that
 * (card near-quote-under-the-pace: at 3.5 a second a quote's five reads took 1.4 s of turns alone); a busy answer still
 * holds it (pacedNearRpc).
 *
 * `seat`: the helper's FastNEAR seat (NEAR_NETWORKS seat, card near-quote-under-the-pace), FastNEAR's key behind the
 * helper's own pace for it (apps/helper/src/limits/limits.ts KEYED_PACE fastnear: 5 a second, 5 at once). The device
 * asks no faster than the key, but faster than the helper's share for one caller (apps/helper/src/rpc/rpc.ts
 * RPC_PAGE_NEED near: 30 a 10 s window), so a session's first buy meets that 429 once: its busiest 10 s asks the seat
 * 52 times (Rhea's 6 pool pages and the buy's reads; packages/signpage/test/near-seat-down.test.ts, on the test clock),
 * the share answers the rest 429 with the seconds left, and pacedNearRpc waits it out. Measured there (review P3-3 of
 * e6c66cce3), the buy fills in 10.0 s with no share, 14.4 s at 5 a second with the share (1 refused), 17.0 s at 3 (1
 * refused), 19.2 s at 2.5 (none: 5 + 25 fits 30) and 24.0 s at 2: the share's one wait costs less than any slower
 * pace, and no share fits the 52 inside the key's own 50 a 10 s. Another device's reads at the same moment can meet the
 * key's 429 too; past NEAR_BUSY_TRIES the keyless seat answers (nearSeatRpc).
 */
export const PACE: Readonly<Record<"fastnear" | "drpc" | "seat", { perSec: number; burst: number }>> = Object.freeze({
  fastnear: Object.freeze({ perSec: 0.39, burst: 8 }),
  drpc: Object.freeze({ perSec: 10, burst: 20 }),
  seat: Object.freeze({ perSec: 5, burst: 5 }),
});

/** A provider URL's pace: the theoretical arrival time of its next request, the gap one request takes, the floor the
 *  last busy hold set (tat as it held it: a slot given back never takes tat below it), and the slots given back that
 *  are still ahead (send times, in order), which the next requests take before a new slot. */
export type Pace = { tat: number; every: number; burst: number; floor: number; holes: number[] };
const PACES = new Map<string, Pace>();
/** The one pace of provider `url` (a FastNEAR URL, a dRPC URL or the helper's seat of NEAR_NETWORKS; any other URL is
 *  not paced). */
export function paceOf(url: string): Pace {
  let p = PACES.get(url);
  if (p === undefined) {
    const net = Object.values(NEAR_NETWORKS).find((n) => (n.fastnear as readonly string[]).includes(url) || n.drpc === url || n.seat === url);
    const pace = net === undefined ? null : PACE[(net.fastnear as readonly string[]).includes(url) ? "fastnear" : net.seat === url ? "seat" : "drpc"];
    p = pace === null ? { tat: 0, every: 0, burst: 1, floor: 0, holes: [] } : { tat: 0, every: 1000 / pace.perSec, burst: pace.burst, floor: 0, holes: [] };
    PACES.set(url, p);
  }
  return p;
}
/** The send time of this provider's next request (and the slot taken): the first slot given back still ahead and not
 *  inside a busy hold, else a new one: `burst` at once, then one every `every` ms. A slot given back is one the pace
 *  had already let out, so the sends stay within it (GCRA) whichever order waits end in. */
export function paceTake(p: Pace, now: number): number {
  const held = p.floor - (p.burst - 1) * p.every; // the last busy hold's end
  while (p.holes.length > 0 && (p.holes[0]! < now || p.holes[0]! < held)) p.holes.shift();
  const hole = p.holes.shift();
  if (hole !== undefined) return hole;
  p.tat = Math.max(p.tat, now);
  const at = p.tat - (p.burst - 1) * p.every;
  p.tat += p.every;
  return Math.max(at, now);
}
/** The wait before this provider's next request (and the slot taken: paceTake). */
export function paceSlot(p: Pace, now: number): number {
  return paceTake(p, now) - now;
}
/** A slot taken and not used (its wait, ending at `at`, ended by its caller) given back (delta review 4): the next
 *  request takes it; the queue's tail slots come off tat, never below a busy hold's floor (P3-1: a hold tat had already
 *  passed was cut short by one slot given back). Tail by its send time to a microsecond, not float equality (P2-1:
 *  `===` on tat missed about 1.2% of the time). */
export function paceGiveBack(p: Pace, at: number): void {
  const i = p.holes.findIndex((h) => h > at);
  p.holes.splice(i < 0 ? p.holes.length : i, 0, at);
  for (;;) {
    const last = p.holes.at(-1);
    if (last === undefined || Math.abs(last - (p.tat - p.burst * p.every)) > 1e-3 || p.tat <= p.floor) break;
    p.holes.pop();
    p.tat = Math.max(p.tat - p.every, p.floor);
  }
}
/** A busy answer holds the provider's every request for `ms`, its burst spent; the hold is the floor a slot given back
 *  stops at (delta review 4, P3-1: a hold tat had already passed was cut short by one slot given back). */
export function paceHold(p: Pace, now: number, ms: number): void {
  p.floor = Math.max(p.floor, now + ms + (p.burst - 1) * p.every);
  p.tat = Math.max(p.tat, p.floor);
}
/** Forgets every provider's pace (tests: each test's clock starts at its own zero). */
export function resetPaces(): void {
  PACES.clear();
  SEATS_DOWN.clear();
}

const PACED = new WeakSet<object>();
/** Whether `fetchFn` is a pacedFetch (a reader built on it is paced at its transport). */
export const isPacedFetch = (fetchFn: unknown): boolean => typeof fetchFn === "function" && PACED.has(fetchFn);
/**
 * fetch to `url`, each request after `url`'s slot on the real clock, then bounded by `timeoutMs` from that slot on. The
 * request's signal is its caller's own (no deadline in it: a reader on a pacedFetch leaves the deadline to it,
 * requestSignal); it ends the wait, and the slot is given back.
 */
export function pacedFetch(url: string, fetchFn: typeof fetch = (...a) => fetch(...a), timeoutMs: number = RPC_TIMEOUT_MS): typeof fetch {
  const p = paceOf(url);
  const f = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    await paceTurn(p, signal);
    return deadlineFetch(fetchFn, timeoutMs)(input, init);
  };
  PACED.add(f);
  return f as typeof fetch;
}
/** The wait for one slot of `p` on the real clock, under the caller's signal only: an ended wait gives its slot back
 *  (delta review 4) and throws the signal's reason; a signal already ended takes no slot. */
async function paceTurn(p: Pace, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const t = performance.now();
  const at = paceTake(p, t);
  const w = at - t;
  if (w <= 0) return;
  await new Promise<void>((res, rej) => {
    const k = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      res();
    }, w);
    const stop = (): void => {
      clearTimeout(k);
      // every ended wait gives its own slot back (delta review 4)
      paceGiveBack(p, at);
      rej(signal!.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}
/** `fetchFn` with no pace, each request bounded by `timeoutMs` from its send and by its caller's signal. */
const deadlineFetch = (fetchFn: typeof fetch, timeoutMs: number): typeof fetch => (input, init) => {
  const signal = init?.signal ?? undefined;
  const deadline = AbortSignal.timeout(timeoutMs);
  return fetchFn(input, { ...init, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
};

const PACED_RPCS = new WeakSet<object>();
/** `rpc`, marked paced at its transport when `fetchFn` is a pacedFetch (so the IdReader takes no second slot). */
export function pacedRpc<T extends object>(rpc: T, fetchFn: unknown): T {
  if (isPacedFetch(fetchFn)) PACED_RPCS.add(rpc);
  return rpc;
}
/** Whether `rpc` is paced at its transport (pacedRpc on a pacedFetch). */
export const isPacedRpc = (rpc: object): boolean => PACED_RPCS.has(rpc);
/** A reader's deadline on `fetchFn`: none on a pacedFetch (it bounds each request from its slot on), else `timeoutMs`. */
export const deadlineOf = (fetchFn: unknown, timeoutMs: number): number | null => (isPacedFetch(fetchFn) ? null : timeoutMs);
/** One request's signal on `fetchFn`: the caller's `signal`, bounded by `timeoutMs` unless the fetch bounds it itself. */
export function requestSignal(fetchFn: unknown, timeoutMs: number, signal?: AbortSignal): AbortSignal | undefined {
  const ms = deadlineOf(fetchFn, timeoutMs);
  if (ms === null) return signal;
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}
/** The most tries of one request a provider answers busy (HTTP 429) on (pacedNearRpc), and the waits between them:
 *  its Retry-After, else NEAR_BUSY_WAIT_MS doubling, at least the pace's gap, at most NEAR_BUSY_WAIT_MAX_MS. */
export const NEAR_BUSY_TRIES = 4;
export const NEAR_BUSY_WAIT_MS = 1_000;
export const NEAR_BUSY_WAIT_MAX_MS = 10_000;
const isBusy = (e: unknown): e is RpcHttpError => e instanceof Error && (e as Partial<RpcHttpError>).status === 429;

/**
 * The kit's nearRpc for `url` on its one pace (the withdraw form's pair, the NEAR trade's pair). A busy answer (HTTP
 * 429) holds the URL's pace for every reader for its Retry-After (or the backoff) and the request is asked again after
 * it, up to NEAR_BUSY_TRIES in all: a provider's "not now" is waited out, never read as a failed read. `reserve` takes
 * the URL's next turn and gives back a sender whose first query goes at once (the kit's nearFinal: two providers' final
 * heights asked at one moment); its later queries, and a first one answered busy, take turns as any other.
 */
export function pacedNearRpc(url: string, fetchFn: typeof fetch = (...a) => fetch(...a)): NearRpc {
  const p = paceOf(url);
  const f = pacedFetch(url, fetchFn);
  const paced = nearRpc(url, f, null);
  // the helper's seat alone names a wait past NEAR_BUSY_WAIT_MAX_MS on purpose (its day cap): it is not waited out, the
  // seat falls to its spare (nearSeatRpc); any other provider's long wait is waited out in its tries as before
  const seat = Object.values(NEAR_NETWORKS).some((n) => n.seat === url);
  const again = async (first: () => Promise<unknown>, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    for (let k = 0; ; k++) {
      try {
        return await (k === 0 ? first() : paced.query(params, signal));
      } catch (e) {
        if (!isBusy(e) || k + 1 >= NEAR_BUSY_TRIES || signal?.aborted || (seat && (e.retryAfterMs ?? 0) > NEAR_BUSY_WAIT_MAX_MS)) throw e;
        const wait = Math.min(NEAR_BUSY_WAIT_MAX_MS, Math.max(e.retryAfterMs ?? NEAR_BUSY_WAIT_MS * 2 ** k, p.every));
        paceHold(p, performance.now(), wait);
      }
    }
  };
  const rpc: NearRpc = {
    name: url,
    query: (params, signal) => again(() => paced.query(params, signal), params, signal),
    async reserve(signal) {
      await paceTurn(p, signal);
      const now = nearRpc(url, deadlineFetch(fetchFn, RPC_TIMEOUT_MS), null);
      let used = false;
      return {
        name: url,
        query: (params, s) => {
          if (used) return rpc.query(params, s);
          used = true;
          return again(() => now.query(params, s), params, s);
        },
      };
    },
  };
  return pacedRpc(rpc, f);
}

/** Whether the helper's seat failed a read the keyless seat may answer instead: a busy answer past its tries (HTTP
 *  429), the helper or its upstream down (5xx: its 503 upstream when FastNEAR's key answers nothing), no answer in
 *  time, or no answer at all (a network error). Any other status (a 4xx: the page's request or origin refused) is a
 *  fault of ours that shows, never hidden by the spare. */
const seatDown = (e: unknown): boolean => {
  if (!(e instanceof Error)) return false;
  const status = (e as Partial<RpcHttpError>).status;
  if (typeof status === "number") return status === 429 || status >= 500;
  return e.name === "TimeoutError" || e.name === "TypeError";
};
/**
 * How long a seat that fell to its spare stays down: its reads go straight to the spare meanwhile, then the seat is
 * asked again (review P2-1 of e6c66cce3: with nothing remembered, every read of a trade waited the seat out again, up
 * to the 10 s deadline or four busy tries, before the spare). [design: 10 s, the helper's window (apps/helper
 * src/limits/limits.ts LIMIT_WINDOW_MS): its per-caller 429 names at most the seconds to that window's end, so the
 * seat is asked again once the window that refused it has turned; a trade loses at most one seat wait per 10 s.]
 */
export const SEAT_DOWN_MS = 10_000;
/** The longest a busy seat's named wait keeps it down: the longest wait the helper names (apps/helper/src/limits/limits.ts
 *  RETRY_AFTER_MAX_S, 75 s; its day cap names it), so a seat that names more is asked again no later than that. */
export const SEAT_DOWN_MAX_MS = 75_000;
/** Each seat's down-until time (performance.now), for the whole page as its paces are; seatsUp() clears it. */
const SEATS_DOWN = new Map<string, number>();
/** Forget every seat taken for down (the page's sign out, so nothing of a session outlives it; resetPaces too). */
export function seatsUp(): void {
  SEATS_DOWN.clear();
}
/**
 * The page's FastNEAR seat on `network` (card near-quote-under-the-pace): the helper's POST /v1/rpc/near?keyed=only,
 * FastNEAR's key at PACE.seat, a 429 waited out as pacedNearRpc does; past that, or with the helper down or slow
 * (seatDown), the same read on FastNEAR's keyless URL at its own pace (PACE.fastnear), so a trade never stops for the
 * helper. Both are FastNEAR's, so the seat stays one operator and its name is the helper's URL (the kit's
 * nearPairNetwork). A caller's own abort is never taken for the seat down. `reserve` takes the helper's turn (the kit's
 * nearFinal); a first query it fails goes to the keyless seat in turn. A network with no seat (testnet) has FastNEAR's
 * keyless URL alone.
 */
export function nearSeatRpc(network: NearNetwork, fetchFn: typeof fetch = (...a) => fetch(...a)): NearRpc {
  const net = NEAR_NETWORKS[network];
  const spare = pacedNearRpc(net.fastnear[0], fetchFn);
  if (net.seat === null) return spare;
  const url = net.seat;
  const seat = pacedNearRpc(url, fetchFn);
  const down = () => (SEATS_DOWN.get(url) ?? -Infinity) > performance.now();
  const or = async (read: () => Promise<unknown>, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    try {
      return await read();
    } catch (e) {
      if (signal?.aborted || !seatDown(e)) throw e;
      // down SEAT_DOWN_MS, or as long as a busy seat names up to SEAT_DOWN_MAX_MS (the helper's day cap)
      const named = isBusy(e) ? Math.min(SEAT_DOWN_MAX_MS, e.retryAfterMs ?? 0) : 0;
      SEATS_DOWN.set(url, performance.now() + Math.max(SEAT_DOWN_MS, named));
      return spare.query(params, signal);
    }
  };
  const rpc: NearRpc = {
    name: url,
    query: (params, signal) => (down() ? spare.query(params, signal) : or(() => seat.query(params, signal), params, signal)),
    async reserve(signal) {
      // the reserved turn is the first query's alone; every later one goes through rpc.query, so a seat that fell to
      // its spare meanwhile is not asked again (review P3-5 of 997ce7a7f)
      let used = false;
      const later = (params: Record<string, unknown>, s?: AbortSignal) => rpc.query(params, s);
      if (down()) {
        const first = await spare.reserve!(signal);
        return { name: url, query: (params, s) => (used ? later(params, s) : ((used = true), first.query(params, s))) };
      }
      const first = await seat.reserve!(signal);
      return { name: url, query: (params, s) => (used ? later(params, s) : ((used = true), or(() => first.query(params, s), params, s))) };
    },
  };
  return rpc;
}
