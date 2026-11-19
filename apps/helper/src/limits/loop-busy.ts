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
 *  the latest sample `lateMs` late or more is within `holdMs`, or while no sample has come for SAMPLE_MS + `lateMs` (the
 *  loop is held right now, past what a sample would show). */
export function loopProbe(now: () => number, lateMs = LOOP_BUSY_MS, holdMs = BUSY_HOLD_MS) {
  let lateAt = -Infinity;
  let lastAt = now();
  return {
    sample(due: number): void {
      const t = now();
      if (t - due >= lateMs) lateAt = t;
      lastAt = t;
    },
    busy(): boolean {
      const t = now();
      return t - lateAt < holdMs || t - lastAt >= SAMPLE_MS + lateMs;
    },
  };
}

// The shed (card helper-answers-through-a-burst): past the helper's capacity a market data read is answered a fast 503
// at once (server.ts SHED_PATHS), never queued behind the loop, so a relay, a proof, a quote and a device's money read
// keep the loop. [design: a sample SHED_LATE_MS late or more, 500 ms: half the quote bar, so a read still queued behind
// such a loop misses it; five times LOOP_BUSY_MS, so the reads ahead stand down long before a caller is shed. On a copy
// of main pinned to the helper host's 2 CPUs, 300 pages opened at once through Caddy made its health read take up to
// 1417 ms (deploy/burst-proof.sh, 19 Nov 16:2xZ). Shed for SHED_HOLD_MS after, 1 s, ten samples, so a burst's next
// wave is shed rather than let in to hold the loop again.]
/** A sample this late or more is a loop past its capacity. */
export const SHED_LATE_MS = 500;
/** How long market data is shed after such a sample. */
export const SHED_HOLD_MS = 1_000;

let probes: { busy: ReturnType<typeof loopProbe>; shed: ReturnType<typeof loopProbe> } | null = null;
/** This process's loop, sampled from the first ask on (one unref'd timer: it never keeps the process up). */
function sampled(): NonNullable<typeof probes> {
  if (probes === null) {
    const now = () => performance.now();
    const p = (probes = { busy: loopProbe(now), shed: loopProbe(now, SHED_LATE_MS, SHED_HOLD_MS) });
    let due = performance.now() + SAMPLE_MS;
    setInterval(() => {
      p.busy.sample(due);
      p.shed.sample(due);
      due = performance.now() + SAMPLE_MS;
    }, SAMPLE_MS).unref();
  }
  return probes;
}
/** Whether this process's loop is busy now (the reads ahead stand down). */
export function loopBusy(): boolean {
  return sampled().busy.busy();
}
/** Whether this process's loop is past its capacity now (market data is shed). */
export function loopShed(): boolean {
  return sampled().shed.busy();
}
