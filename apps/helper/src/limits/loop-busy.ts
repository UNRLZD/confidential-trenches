// Whether the helper's event loop is busy now (card robinhood-tapes-read-ahead-bounded): the background reads ahead
// (data/evm/swaps.ts ahead: the lists' pools searched and their tapes read before anyone opens them) stand down while
// callers wait on the loop, so they never add their work to a burst's.
//
// Why: helper live run 44298379284 at 6b1926fc9, the build that first read the lists' tapes ahead, had 21 red jobs, all
// started 11:51:21-11:52:24Z, while the helper's log read "event loop held up to 1714 ms this minute (p99 1278 ms)" and
// then 2162 ms (p99 1771 ms); the build before it had 2 red jobs (run 44290570091). The read ahead alone never held the
// loop: on the public providers, both chains' lists read ahead and 24 listed coins opened at once, the longest hold in
// 150 s was 22 ms, and 34 ms with the tapes' read ahead off (a burst replay on a laptop, 18 Nov 13:2xZ). A p99
// that near its max is a loop that is late all minute, a backlog, not one long step: the read ahead's extra work came on
// top of a live run's burst. So it is gated on the load, the way Fastify's under-pressure gates a server's routes: a
// timer every SAMPLE_MS, and how late it fired.
//
// [design: SAMPLE_MS 100, a tenth of the quote bar, so a burst is seen within one; busy when a sample fired LOOP_BUSY_MS
// late or more, 100 ms, five times the longest hold the read ahead made alone, so it never stops itself; busy for
// BUSY_HOLD_MS after, 2 s, so a burst that comes in waves (a live run's jobs start over a minute) keeps it stood down
// between them rather than restarting it into the next wave.]

/** How often the loop's lateness is sampled. */
export const SAMPLE_MS = 100;
/** A sample this late or more is a busy loop. */
export const LOOP_BUSY_MS = 100;
/** How long the loop counts as busy after a late sample. */
export const BUSY_HOLD_MS = 2_000;

/** A probe on `now` (a monotonic clock, ms): `sample(at)` records a timer that was due at `at`; `busy()` is true while
 *  the latest late sample is within BUSY_HOLD_MS, or while no sample has come for SAMPLE_MS + LOOP_BUSY_MS (the loop is
 *  held right now, past what a sample would show). */
export function loopProbe(now: () => number) {
  let lateAt = -Infinity;
  let lastAt = now();
  return {
    sample(due: number): void {
      const t = now();
      if (t - due >= LOOP_BUSY_MS) lateAt = t;
      lastAt = t;
    },
    busy(): boolean {
      const t = now();
      return t - lateAt < BUSY_HOLD_MS || t - lastAt >= SAMPLE_MS + LOOP_BUSY_MS;
    },
  };
}

let probe: ReturnType<typeof loopProbe> | null = null;
/** This process's loop, sampled from the first ask on (an unref'd timer: it never keeps the process up). */
export function loopBusy(): boolean {
  if (probe === null) {
    const p = (probe = loopProbe(() => performance.now()));
    let due = performance.now() + SAMPLE_MS;
    setInterval(() => {
      p.sample(due);
      due = performance.now() + SAMPLE_MS;
    }, SAMPLE_MS).unref();
  }
  return probe.busy();
}
