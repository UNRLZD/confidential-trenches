// A run on virtual time, for the tests whose outcome is the providers' paces (swaps-capacity, swaps-pace): the helper's
// waits (setTimeout), its clock (Date and performance.now) and the fake providers' own windows all read one clock, which
// moves 1 ms only once the run has had DRAIN turns of the event loop, so how fast the machine is never changes what the
// run sends or answers. Before, these tests ran on wall time: on a loaded runner the waits overran the paces' refills
// and one of 12 cold tapes answered 503 at 19.4 s (#248's CI, run 41967652884), and drpc's share of the reads moved
// with the load (#266's CI, run 41968997025).
//
// Card virtual-clock-skips-idle: a run that has nothing left to do but wait for its next timer moves the clock to that
// timer's ms in one tick, never 1 ms and DRAIN turns at a time. Those turns ran nothing: no timer was due before it, no
// immediate was set and no handle or request was open past the run's start, so the run sends and answers exactly what
// it did, at the same ms. 1 ms at a time, swaps-back-resume.test.ts's 120 s runs were 960,000 turns each, and the file
// alone took 332 s on this Mac (23 Nov 19:4xZ); the README's test line ran past its 8 minutes on GitHub's runner every
// night from 15 to 23 Nov (run 45216461207: the helper's suite last, this file unfinished at the limit).
import { mock } from "node:test";
import { enableTimers, resetTimers } from "../mock-timers.ts";

/** The event loop turns a run is given between two ticks of the clock: every fake answer here is settled in a few. */
const DRAIN = 8;

/** A mocked timer as node:test hands it back: its id, one more than the timer set before it, and the ms it fires at. */
type Mocked = { id: number; runAt: number };

/** The process's open handles and requests by type (process.getActiveResourcesInfo), each counted. */
function resources(): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of process.getActiveResourcesInfo()) m.set(r, (m.get(r) ?? 0) + 1);
  return m;
}

/** Runs `work` with setTimeout, Date and performance.now on one virtual clock from `start` (ms); its value and the
 *  virtual ms it took. Real timers and I/O are not stopped: the fakes it runs against must use neither. `turn`, when
 *  given, is told each turn's real ms (the synchronous span from one turn of the loop to the next, a tick's timers and
 *  their microtasks in it) and the virtual ms it ran at (card robinhood-tapes-read-ahead-bounded). */
export async function onVirtualTime<T>(start: number, work: () => Promise<T>, turn?: (realMs: number, at: number) => void): Promise<{ value: T; ms: number }> {
  const g = globalThis as unknown as Record<string, (...a: unknown[]) => unknown>;
  const immediate = globalThis.setImmediate;
  const [setI, clearI] = [g.setImmediate!, g.clearImmediate!];
  const perf = Object.getOwnPropertyDescriptor(performance, "now");
  enableTimers(mock.timers, { apis: ["setTimeout", "Date"], now: start });
  Object.defineProperty(performance, "now", { configurable: true, value: () => Date.now() - start });
  // every timer the run sets, kept until it fires or is cleared, and each immediate it waits on
  const [set, clear] = [g.setTimeout!, g.clearTimeout!];
  const timers = new Map<Mocked, number>();
  const immediates = new Set<unknown>();
  // node:test numbers every mocked timer in turn, whatever set it: a number skipped is a timer set past these wrappers
  // (node:timers, its promises), whose ms is not known here, and the run keeps to 1 ms steps from then on
  const first = set(() => {}, 0) as Mocked;
  clear(first);
  let lastId = first.id;
  let blind = false;
  const seen = (h: Mocked) => {
    if (h.id !== lastId + 1) blind = true;
    lastId = h.id;
  };
  g.setTimeout = (f: unknown, ...a: unknown[]) => {
    const h = set(typeof f === "function" ? (...b: unknown[]) => (timers.delete(h), (f as (...b: unknown[]) => unknown)(...b)) : f, ...a) as Mocked;
    seen(h);
    timers.set(h, h.runAt);
    return h;
  };
  g.clearTimeout = (h: unknown) => (timers.delete(h as Mocked), clear(h));
  g.setImmediate = (f: unknown, ...a: unknown[]) => {
    const h = setI(typeof f === "function" ? (...b: unknown[]) => (immediates.delete(h), (f as (...b: unknown[]) => unknown)(...b)) : f, ...a);
    immediates.add(h);
    return h;
  };
  g.clearImmediate = (h: unknown) => (immediates.delete(h), clearI(h));
  const before = resources();
  /** The ms the next timer fires at, when nothing else is left: no immediate, no handle or request past the run's start
   *  (a real timer, a socket, a file read), and every timer set known here. */
  const next = (): number | null => {
    if (blind || timers.size === 0 || immediates.size > 0) return null;
    for (const [k, n] of resources()) if (n > (before.get(k) ?? 0)) return null;
    const probe = set(() => {}, 0) as Mocked;
    clear(probe);
    seen(probe);
    if (blind) return null;
    let at = Infinity;
    for (const t of timers.values()) at = Math.min(at, t);
    return at;
  };
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
    let last = process.hrtime.bigint();
    while (!done) {
      for (let i = 0; i < DRAIN && !done; i++) {
        await new Promise((go) => immediate(go));
        if (turn !== undefined) {
          const t = process.hrtime.bigint();
          turn(Number(t - last) / 1e6, Date.now());
          last = t;
        }
      }
      if (done) break;
      // to the next timer's ms (a whole ms: the clock never stops between two), or 1 ms on
      const at = next();
      mock.timers.tick(at === null ? 1 : Math.max(1, Math.floor(at - Date.now())));
    }
    ms = Date.now() - start;
  } finally {
    g.setImmediate = setI;
    g.clearImmediate = clearI;
    resetTimers(mock.timers);
    if (perf === undefined) delete (performance as { now?: unknown }).now;
    else Object.defineProperty(performance, "now", perf);
  }
  if (failed) throw error;
  return { value: value as T, ms };
}
