// GeckoTerminal's keyless API: the helper has one address, so every part that reads GeckoTerminal (the Solana token
// page's candles, src/data/solana/token.ts, and the EVM lists, src/data/evm/lists.ts) takes its calls from one budget
// of GT_LIMIT_PER_MIN in any 60 s. The token page goes first: the "lists" lane yields, taking a call only while
// PAGE_RESERVE calls stay free for a page, and none while a page has called in the last YIELD_MS, unless its read is
// urgent (never read, or about to go stale: src/data/evm/lists.ts LIST_URGENT_MS): the lists always keep LIST_FLOOR
// calls of the minute for those, so pages opened back to back never leave Discover's lists empty or stale, and pages
// always keep the other perMin - LIST_FLOOR. A 429 pauses
// every lane, since GeckoTerminal answers our address, not a lane.
//
// The "refresh" lane is a page's re-read of data it already holds (the newest bars past their 60 s, a top pool past its
// 10 min): it takes a call only while COLD_RESERVE stay free for a read of something nobody holds, so a held token's
// refresh never refuses another token's first read; refused, the holder serves what it has, dated (card
// app-console-429: the live suite's candles 429 at 567a181, a cold mint behind another's refreshes). A refresh of the
// newest data held once it is REFRESH_URGENT_MS old is a page read (refreshLane): the lists ask for more calls than the
// budget has (6 lists every LIST_MS), so they keep the window at the refresh lane's own room, perMin - COLD_RESERVE,
// and a refresh refused never makes them yield; a chart read only now and then was served its held bars for good (card
// helper-chart-fresh: PUMP's 1h bars from 12:55:51Z at 14:03Z and 14:21Z, while a key nobody held read fresh).
//
// The limit is measured, not the published one: GeckoTerminal's FAQ says 10 calls a minute (apiguide.geckoterminal.com/
// faq, read 2026-11-03 11:27Z), but read from one address after 70 s with no call, on 2026-11-03 at 14:58:04Z, 14 calls
// back to back answered 200 five times, then 429 (Retry-After "0") nine times, and still 429 30 s later; the deployed
// helper budgeting 10 met GeckoTerminal's 429 within minutes (market-data-solana-token live, 14:47Z).
//
// The window is WINDOW_MS, longer than the minute: a local helper counting 60 s from each call's take met
// GeckoTerminal's 429 twice in 8 minutes (2026-11-03 15:38:14Z with 3 calls in the 60 s before it and 6 in the 63 s,
// 15:44:35Z with 4 and 7 in the 75 s), since GeckoTerminal counts from each call's arrival and over more than 60 s;
// a 429 pauses every lane for a minute, so the margin costs less than the 429 it avoids.
export const GT_LIMIT_PER_MIN = 5;
/** The span GT_LIMIT_PER_MIN calls are counted over. */
export const WINDOW_MS = 75_000;
/** Calls a page may always find free: a token page's first open reads the token's top pool and one candles range. */
export const PAGE_RESERVE = 2;
/** A page call this recent makes the lists lane wait (unless its read is urgent). */
export const YIELD_MS = 60_000;
/** Calls a refresh leaves free: one cold token page's candles, its top pool and its bars (token.ts). */
export const COLD_RESERVE = 2;
/** Calls in the minute the lists may always take for an urgent read (6 lists, each read within LIST_URGENT_MS). */
export const LIST_FLOOR = 2;
/** The newest data held this old is read in the "pages" lane, as the lists' LIST_URGENT_MS (src/data/evm/lists.ts):
 *  four times the bars' 60 s, so a chart is never served more than this behind its last refresh that could run. */
export const REFRESH_URGENT_MS = 240_000;

/** The lane of a read of the newest data, held since `heldAtMs` (null: nothing held): "pages" for a first read and for
 *  data REFRESH_URGENT_MS old, else "refresh". History before a time never changes and stays a refresh, whatever its age. */
export function refreshLane(heldAtMs: number | null, nowMs: number): "pages" | "refresh" {
  return heldAtMs === null || nowMs - heldAtMs >= REFRESH_URGENT_MS ? "pages" : "refresh";
}

export type GeckoBudget = {
  /** One call now in `lane`, or false when the minute, a 429 pause or (for "lists") the yield says no. */
  take(lane: string, urgent?: boolean): boolean;
  /** A 429: no lane calls until `untilMs`. */
  pause(untilMs: number): void;
  /** When a page call can next be taken (now when it can now): the pause's end or the minute's oldest call leaving
   *  the window; what a refused page names as its wait. */
  retryAt(lane: string): number;
  /** The calls in the window, oldest first: what a restart's next process seeds from (../data/warm.ts). */
  calls(): number[];
  /** Calls another process made from our address (a deploy's old helper, read from its warm file): counted as ours. */
  seed(times: readonly number[]): void;
  /** No lane calls until release(): another helper on our address may still be calling (card helper-ready-gate). */
  hold(): void;
  release(): void;
};

/** GeckoTerminal answered 429: pause every lane for its Retry-After (at most 300 s), or WINDOW_MS when it names none or
 *  "0" (as it did at 14:58Z, still refusing 30 s later); returns the pause's end, the wait a page names. */
export function throttledUntil(b: GeckoBudget, retryAfter: string | null, nowMs: number): number {
  const ra = Number(retryAfter);
  const until = nowMs + (retryAfter !== null && Number.isFinite(ra) && ra > 0 ? Math.min(ra, 300) * 1000 : WINDOW_MS);
  b.pause(until);
  return until;
}

/** A budget of at most `perMin` calls in any WINDOW_MS, the "lists" lane yielding to every other. */
export function geckoBudget(now: () => number, perMin = GT_LIMIT_PER_MIN): GeckoBudget {
  const calls: { at: number; lane: string }[] = [];
  let pausedUntil = 0;
  let held = false;
  const prune = (t: number) => {
    while (calls.length > 0 && t - calls[0]!.at >= WINDOW_MS) calls.shift();
  };
  return {
    take(lane, urgent = false) {
      const t = now();
      prune(t);
      if (held || t < pausedUntil || calls.length >= perMin) return false;
      if (lane === "refresh" && calls.length >= perMin - COLD_RESERVE) return false;
      if (lane === "lists") {
        const floor = urgent && calls.filter((c) => c.lane === "lists").length < LIST_FLOOR;
        if (!floor && (calls.length >= perMin - PAGE_RESERVE || calls.some((c) => c.lane !== "lists" && c.lane !== "seed" && t - c.at < YIELD_MS))) return false;
      }
      calls.push({ at: t, lane });
      return true;
    },
    pause(untilMs) {
      pausedUntil = Math.max(pausedUntil, untilMs);
    },
    retryAt() {
      const t = now();
      prune(t);
      let at = Math.max(t, pausedUntil);
      if (held) at = Math.max(at, t + WINDOW_MS);
      if (calls.length >= perMin) at = Math.max(at, calls[calls.length - perMin]!.at + WINDOW_MS);
      return at;
    },
    calls() {
      prune(now());
      return calls.map((c) => c.at);
    },
    seed(times) {
      const t = now();
      for (const at of times) if (Number.isFinite(at) && at <= t && t - at < WINDOW_MS) calls.push({ at, lane: "seed" });
      calls.sort((a, b) => a.at - b.at);
      prune(t);
    },
    hold() {
      held = true;
    },
    release() {
      held = false;
    },
  };
}
