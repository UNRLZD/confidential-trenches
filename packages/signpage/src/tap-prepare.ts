// A buy tapped while the device still prepares the chain's spend waits for it inside the request (card
// taps-wait-inside-the-page; owner 13 Nov 07:53Z: "why can I not spend my own deposited money"). Preparing the spend is
// the page's own business: no app waits on it or names it.
//
// - What is waited for: the chain's proof pass (the wallet's queue.ts refresh), joined when one is in flight, else the
//   queue's next one started; never a prover run of its own, so no note gets a second spend made beside the first (the
//   queue's passes run one after another, and its store moves refuse a note another pass holds). The buy's own pick and
//   take then hold each note to one tap, as they always did (pool-buy.ts claimed, queue.ts take).
// - When: only while `preparing` says so (src/pool-testnet.ts tapPrepared: the chain's first pass of this page life has
//   not ended and the chain holds a note to prove, or a pass makes a note's first proof now). A tap with nothing being
//   prepared waits for nothing.
// - Bounded: at most TAP_PREPARE_MS from the tap, inside the tap's one bound (read-waits.ts READ_WAIT_TOTAL_MS, counted
//   from the request's arrival), so the buy keeps room for its own reads; a sign out ends it at once. Past the bound the
//   buy runs on what is ready then and answers as it would have.
// - Before the buy reads or holds anything (src/pool-kinds.ts): a buy holds its RPC hosts from its run's start and the
//   pass's reads yield to it, so a wait inside the run would hold the pass it waits for. Nothing here logs.

/** The longest a tap waits for its chain's spend to be prepared: two thirds of the tap's one bound (READ_WAIT_TOTAL_MS,
 *  30 s), so the buy's own reads keep 10 s of it. A first pass that adopts the proofs kept on the device ends in a
 *  second or so; one that proves a note takes the prover's few seconds a proof. */
export const TAP_PREPARE_MS = 20_000;
/** The least time between two looks at a chain whose pass ended at once (an open that failed): never a busy loop. */
export const TAP_PREPARE_STEP_MS = 250;

export type TapPrepareDeps = {
  /** True while the chain's spend is being prepared. */
  preparing(): Promise<boolean>;
  /** The chain's pass in flight, joined, or the queue's next one when none is. */
  pass(): Promise<unknown>;
  /** The device's clock, ms. */
  now(): number;
  /** A wait of `ms`, ended early (resolved) when `signal` aborts. */
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  /** The session's sign out: ends the wait. */
  signal?: AbortSignal;
};

/** A wait on the device's timer, ended at once when `signal` aborts. */
export const timerWait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((res) => {
    if (signal?.aborted) return res();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      res();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/** Waits while the chain's spend is being prepared, at most TAP_PREPARE_MS; never throws. */
export async function tapPrepared(d: TapPrepareDeps): Promise<void> {
  const end = d.now() + TAP_PREPARE_MS;
  const stop = new AbortController();
  const out = (): void => stop.abort();
  d.signal?.addEventListener("abort", out, { once: true });
  if (d.signal?.aborted) out();
  const stopped = new Promise<void>((r) => (stop.signal.aborted ? r() : stop.signal.addEventListener("abort", () => r(), { once: true })));
  // the last pass ended at once (an open that failed): the next look at a chain still preparing comes a step later
  let fast: number | null = null;
  try {
    for (;;) {
      if (d.signal?.aborted || d.now() >= end) return;
      if (!(await d.preparing().catch(() => false))) return;
      if (fast !== null) {
        const step = Math.min(TAP_PREPARE_STEP_MS - fast, end - d.now());
        fast = null;
        if (step > 0) await Promise.race([d.wait(step, stop.signal), stopped]);
        continue;
      }
      const left = end - d.now();
      if (left <= 0 || d.signal?.aborted) return;
      const began = d.now();
      // the pass, or the bound, or the sign out, whichever comes first; the bound's timer is let go with the pass
      const lap = new AbortController();
      const ended = () => lap.abort();
      stop.signal.addEventListener("abort", ended, { once: true });
      try {
        await Promise.race([Promise.resolve().then(() => d.pass()).catch(() => {}), d.wait(left, lap.signal), stopped]);
      } finally {
        stop.signal.removeEventListener("abort", ended);
        lap.abort();
      }
      const spent = d.now() - began;
      if (spent < TAP_PREPARE_STEP_MS) fast = spent;
    }
  } finally {
    d.signal?.removeEventListener("abort", out);
  }
}
