// The helper's long background work, cut into turns of the event loop (card helper-loop-never-held-by-a-write): no turn
// holds the loop past TURN_MS of it, however many such jobs run at once.
//
// Why: a CPU profile of a copy of the helper at e35007152 on mainnet's public providers, under the live run's jupiter-budget
// page checks (helper-token-page-cold, market-data-solana-token, token-page-data-complete-and-fast,
// solana-legs-share-wait; the Mac, 20 Nov 00:4xZ), held the loop 100 ms or more 147 times: the pool index's span write
// (evm/pool-index.ts keep, one transaction of a span's pools, 300 to 376 ms) and the v4 key searches (evm/swaps.ts
// v4KeySliced, 132 to 171 ms). Each search let the loop run every 1,000 keys (8 ms alone), but every search waiting
// resumed in the same check phase, so a page's cold opens, each a search, held the loop for their sum.
//
// So a job asks `pass()` between its items: null while the loop's turn is under TURN_MS, else a promise that resumes it
// on a later turn, one job a turn in the order they asked (the cooperative time slice of browsers' scheduler.yield and
// React's scheduler, which give the loop back every few ms). [design: TURN_MS 20, a fifth of the 100 ms a turn may take,
// so a job's own item past it (a span's one insert, one key's hash) stays inside; a turn is timed on the host itself, so
// a slower box takes more turns, never longer ones.]

/** The most of one loop turn a job's slice takes before it gives the loop back. */
export const TURN_MS = 20;

/** A turn slicer on `now` (ms, monotonic): `pass()` is null while the current slice is under `turnMs`, else a promise
 *  that resolves on a later turn of the loop, one waiter a turn, first come first served. */
export function turnSlicer(now: () => number = () => performance.now(), turnMs = TURN_MS) {
  const waiting: (() => void)[] = [];
  let since = now();
  const next = (): void =>
    void setImmediate(() => {
      since = now();
      waiting.shift()?.();
      if (waiting.length > 0) next();
    });
  return {
    pass(): Promise<void> | null {
      if (now() - since < turnMs) return null;
      return new Promise<void>((go) => {
        waiting.push(go);
        if (waiting.length === 1) next();
      });
    },
    /** The current slice starts again at now(): for a clock that moved under the slicer, a test's own. */
    restart(): void {
      since = now();
    },
  };
}

/** This process's one slicer: every sliced job of the helper shares its turns. */
const shared = turnSlicer();
/** null while this turn has room, else a promise that resumes the caller on a later turn (shared's pass). */
export const pass = (): Promise<void> | null => shared.pass();
/** For a test's own clock (test/evm-swaps/virtual-time.ts; not in the index): the shared slice starts again now, on the
 *  clock performance.now reads at the call. A run on virtual time measured its first slices from the machine's time at
 *  the module's load, so how slowly a busy runner loaded the file moved where they fell, and with them the order of the
 *  run's reads (README run 45337579406: swaps-back-resume's Robinhood tapes at other times than on a quick machine). */
export const restartTurns = (): void => shared.restart();
