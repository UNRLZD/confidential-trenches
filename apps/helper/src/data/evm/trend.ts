// Discover's trending candidates from the chain's own swaps (card robinhood-lists-own-reads, the first slice of
// helper-lists-own-index): the swap index (index.ts) already reads every swap event of the chain, by topic and with no
// address, on two agreeing providers, for the tapes. Each swap it takes in is counted here by pool and by the minute of
// its block, an hour kept, so the pools that traded most in the last 5 minutes and the last hour are each trending
// list's candidates with no call of their own; lists.ts names their rows.
//
// Why (read 2026-11-25 07:0x-07:3xZ): GeckoTerminal's keyless budget is 5 calls in 75 s for the whole helper
// (../gecko.ts), and on helper 9beef52db its lists lane made 78 of the 125 calls of an hour while charts and token pages
// were refused 5,065 asks. Robinhood's chain-wide swaps are about 1,850 a minute (index.ts), held for the tapes already.
//
// Display only: nothing here feeds a signature. A log is hostile input: it counts only with a swap topic the index
// reads, a pool key in its exact form and a block time; a minute holds at most POOLS_PER_MINUTE pools, so a flood of
// made-up emitters bounds what it costs, and it can only add candidates, which are listed only when a vendor that names
// the chain's pools names them too (lists.ts ownRows).
import type { Log } from "./swaps.ts";

/** The minutes of counts kept: the longest list's window. */
export const TREND_MINUTES = 60;
/** The most pools one minute counts; a pool first seen past it is not counted [design: Robinhood's busiest 2,600
 *  blocks (5 minutes) named 746 pools, read 2026-11-25 07:37Z; a minute holds far fewer]. */
export const POOLS_PER_MINUTE = 2_000;
/** Candidates per list, the busiest first [design: a list shows 20 rows; pairs of the chain's own quotes (WETH/USDG),
 *  pools no vendor names and one token's other pools fall out first, 40 of 746 left 23 distinct coins in the read above]. */
export const CANDIDATES_MAX = 40;

const POOL_ID = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

/** Swaps per pool per minute of block time (unix seconds / 60), and the newest block counted. */
export type TrendCounts = { minutes: Map<number, Map<string, number>>; seen: number };
export const emptyCounts = (): TrendCounts => ({ minutes: new Map(), seen: -1 });

/** The pool a swap log is of: a v4 pool's id (the PoolManager's log, topic 1), any other pool's address; null for a log
 *  that is not one of `topics` or has no key in its exact form. */
export function poolKey(l: Pick<Log, "address" | "topics">, poolManager: string, topics: ReadonlySet<string>): string | null {
  const t0 = l.topics[0]?.toLowerCase();
  if (t0 === undefined || !topics.has(t0)) return null;
  const address = l.address.toLowerCase();
  if (address === poolManager.toLowerCase()) {
    const id = l.topics[1]?.toLowerCase();
    return id !== undefined && POOL_ID.test(id) ? id : null;
  }
  return ADDRESS.test(address) ? address : null;
}

/** Counts the swaps of `logs` past the newest block counted, then drops the minutes older than TREND_MINUTES before
 *  `nowS`; `to` is the newest block the logs cover (the index's range), counted from the next call on. */
export function countSwaps(c: TrendCounts, logs: readonly Log[], to: number, nowS: number, poolManager: string, topics: ReadonlySet<string>): void {
  const oldest = Math.floor(nowS / 60) - TREND_MINUTES;
  for (const l of logs) {
    if (l.block <= c.seen || l.t == null || !Number.isSafeInteger(l.t) || l.t <= 0) continue;
    const minute = Math.floor(l.t / 60);
    if (minute <= oldest) continue;
    const key = poolKey(l, poolManager, topics);
    if (key === null) continue;
    let m = c.minutes.get(minute);
    if (m === undefined) c.minutes.set(minute, (m = new Map()));
    const n = m.get(key);
    if (n === undefined && m.size >= POOLS_PER_MINUTE) continue;
    m.set(key, (n ?? 0) + 1);
  }
  c.seen = Math.max(c.seen, to);
  for (const minute of c.minutes.keys()) if (minute <= oldest) c.minutes.delete(minute);
}

/** The pools with the most swaps over the last `windowS` seconds before `nowS` (whole minutes, the current one in),
 *  the busiest first, at most `max`. */
export function candidates(c: TrendCounts, nowS: number, windowS: number, max = CANDIDATES_MAX): string[] {
  const from = Math.floor(nowS / 60) - Math.ceil(windowS / 60) + 1;
  const sum = new Map<string, number>();
  for (const [minute, m] of c.minutes) if (minute >= from) for (const [k, n] of m) sum.set(k, (sum.get(k) ?? 0) + n);
  return [...sum].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, max).map(([k]) => k);
}

/** The counts as a next process takes them over (../warm.ts): each minute's pools and the newest block counted. */
export function countsState(c: TrendCounts): { seen: number; minutes: [number, [string, number][]][] } {
  return { seen: c.seen, minutes: [...c.minutes].map(([minute, m]) => [minute, [...m]]) };
}

/** A previous process's counts (hostile input): a minute within TREND_MINUTES of `nowS` and not after it, each pool key
 *  in its exact form, each count a positive safe integer, at most POOLS_PER_MINUTE a minute; anything else is dropped. */
export function restoreCounts(st: unknown, nowS: number): TrendCounts {
  const out = emptyCounts();
  const o = (typeof st === "object" && st !== null ? st : {}) as { seen?: unknown; minutes?: unknown };
  const now = Math.floor(nowS / 60);
  if (!Array.isArray(o.minutes) || !Number.isSafeInteger(o.seen)) return out;
  for (const e of o.minutes.slice(0, TREND_MINUTES + 1)) {
    if (!Array.isArray(e) || e.length !== 2 || !Number.isSafeInteger(e[0]) || e[0] <= now - TREND_MINUTES || e[0] > now || !Array.isArray(e[1])) continue;
    const m = new Map<string, number>();
    for (const p of (e[1] as unknown[]).slice(0, POOLS_PER_MINUTE)) {
      if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string" || !(POOL_ID.test(p[0]) || ADDRESS.test(p[0])) || !Number.isSafeInteger(p[1]) || (p[1] as number) <= 0) continue;
      m.set(p[0], p[1] as number);
    }
    if (m.size > 0) out.minutes.set(e[0] as number, m);
  }
  out.seen = o.seen as number;
  return out;
}
