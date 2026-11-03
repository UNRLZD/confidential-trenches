// GeckoTerminal's keyless API: the helper has one address, so every part that reads GeckoTerminal (the Solana token
// page's candles, src/data/solana/token.ts, and the EVM lists, src/data/evm/lists.ts) takes its calls from one budget
// of GT_LIMIT_PER_MIN in any 60 s. The token page goes first: the "lists" lane yields, taking a call only while
// PAGE_RESERVE calls stay free for a page, and none while a page has called in the last YIELD_MS, unless its read is
// urgent (never read, or about to go stale: src/data/evm/lists.ts LIST_URGENT_MS): the lists always keep LIST_FLOOR
// calls of the minute for those, so pages opened back to back never leave Discover's lists empty or stale, and pages
// always keep the other perMin - LIST_FLOOR. A 429 pauses
// every lane, since GeckoTerminal answers our address, not a lane.
//
// The limit is measured, not the published one: GeckoTerminal's FAQ says 10 calls a minute (apiguide.geckoterminal.com/
// faq, read 2026-11-03 11:27Z), but read from one address after 70 s with no call, on 2026-11-03 at 14:58:04Z, 14 calls
// back to back answered 200 five times, then 429 (Retry-After "0") nine times, and still 429 30 s later; the deployed
// helper budgeting 10 met GeckoTerminal's 429 within minutes (market-data-solana-token live, 14:47Z).
export const GT_LIMIT_PER_MIN = 5;
/** Calls a page may always find free: a token page's first open reads the token's top pool and one candles range. */
export const PAGE_RESERVE = 2;
/** A page call this recent makes the lists lane wait (unless its read is urgent). */
export const YIELD_MS = 60_000;
/** Calls in the minute the lists may always take for an urgent read (6 lists, each read within LIST_URGENT_MS). */
export const LIST_FLOOR = 2;

export type GeckoBudget = {
  /** One call now in `lane`, or false when the minute, a 429 pause or (for "lists") the yield says no. */
  take(lane: string, urgent?: boolean): boolean;
  /** A 429: no lane calls until `untilMs`. */
  pause(untilMs: number): void;
  /** When a page call can next be taken (now when it can now): the pause's end or the minute's oldest call leaving
   *  the window; what a refused page names as its wait. */
  retryAt(lane: string): number;
};

/** A budget of at most `perMin` calls in any 60 s, the "lists" lane yielding to every other. */
export function geckoBudget(now: () => number, perMin = GT_LIMIT_PER_MIN): GeckoBudget {
  const calls: { at: number; lane: string }[] = [];
  let pausedUntil = 0;
  const prune = (t: number) => {
    while (calls.length > 0 && t - calls[0]!.at >= 60_000) calls.shift();
  };
  return {
    take(lane, urgent = false) {
      const t = now();
      prune(t);
      if (t < pausedUntil || calls.length >= perMin) return false;
      if (lane === "lists") {
        const floor = urgent && calls.filter((c) => c.lane === "lists").length < LIST_FLOOR;
        if (!floor && (calls.length >= perMin - PAGE_RESERVE || calls.some((c) => c.lane !== "lists" && t - c.at < YIELD_MS))) return false;
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
      if (calls.length >= perMin) at = Math.max(at, calls[calls.length - perMin]!.at + 60_000);
      return at;
    },
  };
}
