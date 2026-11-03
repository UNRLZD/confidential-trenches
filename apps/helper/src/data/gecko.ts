// GeckoTerminal's keyless API allows 10 calls a minute per caller ("from 10 calls/min to 250 calls/min" on a paid
// plan, apiguide.geckoterminal.com/faq, read 2026-11-03 11:27Z). The helper has one address, so every part that reads
// GeckoTerminal (the Solana token page's candles, src/data/solana/token.ts, and the EVM lists, src/data/evm/lists.ts)
// takes its calls from one budget: at most PER_MIN in any 60 s, split into lanes with fixed caps so one part can never
// spend another's calls, and a 429 pauses every lane.
export const GT_LIMIT_PER_MIN = 10;

export type GeckoBudget = {
  /** One call now in `lane`, or false when the lane's cap, the minute's total or a 429 pause says no. */
  take(lane: string): boolean;
  /** A 429: no lane calls until `untilMs`. */
  pause(untilMs: number): void;
};

/** A budget of at most `perMin` calls in any 60 s, with each lane held to its cap (a lane not named has `perMin`). */
export function geckoBudget(now: () => number, caps: Readonly<Record<string, number>> = {}, perMin = GT_LIMIT_PER_MIN): GeckoBudget {
  const calls: { at: number; lane: string }[] = [];
  let pausedUntil = 0;
  return {
    take(lane) {
      const t = now();
      while (calls.length > 0 && t - calls[0]!.at >= 60_000) calls.shift();
      if (t < pausedUntil || calls.length >= perMin) return false;
      if (calls.filter((c) => c.lane === lane).length >= (caps[lane] ?? perMin)) return false;
      calls.push({ at: t, lane });
      return true;
    },
    pause(untilMs) {
      pausedUntil = Math.max(pausedUntil, untilMs);
    },
  };
}
