// A run on virtual time, for the tests whose outcome is the providers' paces (swaps-capacity, swaps-pace): the helper's
// waits (setTimeout), its clock (Date and performance.now) and the fake providers' own windows all read one clock, which
// moves 1 ms only once the run has had DRAIN turns of the event loop, so how fast the machine is never changes what the
// run sends or answers. Before, these tests ran on wall time: on a loaded runner the waits overran the paces' refills
// and one of 12 cold tapes answered 503 at 19.4 s (#248's CI, run 41967652884), and drpc's share of the reads moved
// with the load (#266's CI, run 41968997025).
import { mock } from "node:test";
import { enableTimers, resetTimers } from "../mock-timers.ts";

/** The event loop turns a run is given between two ticks of the clock: every fake answer here is settled in a few. */
const DRAIN = 8;

/** Runs `work` with setTimeout, Date and performance.now on one virtual clock from `start` (ms); its value and the
 *  virtual ms it took. Real timers and I/O are not stopped: the fakes it runs against must use neither. */
export async function onVirtualTime<T>(start: number, work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const immediate = globalThis.setImmediate;
  const perf = Object.getOwnPropertyDescriptor(performance, "now");
  enableTimers(mock.timers, { apis: ["setTimeout", "Date"], now: start });
  Object.defineProperty(performance, "now", { configurable: true, value: () => Date.now() - start });
  let done = false;
  let value: T | undefined;
  let error: unknown;
  let failed = false;
  void work().then(
    (v) => ((value = v), (done = true)),
    (e) => ((error = e), (failed = done = true)),
  );
  let ms = 0;
  try {
    while (!done) {
      for (let i = 0; i < DRAIN && !done; i++) await new Promise((go) => immediate(go));
      if (!done) mock.timers.tick(1);
    }
    ms = Date.now() - start;
  } finally {
    resetTimers(mock.timers);
    if (perf === undefined) delete (performance as { now?: unknown }).now;
    else Object.defineProperty(performance, "now", perf);
  }
  if (failed) throw error;
  return { value: value as T, ms };
}
