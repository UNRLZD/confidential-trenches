// `run` with setTimeout, clearTimeout, AbortSignal.timeout and performance.now on a clock of the test's own (card
// fresh-run-margin). A quote's waits (a scan's naps between tries, its hold, its bound, a request's deadline) are set
// with setTimeout or AbortSignal.timeout and measured with performance.now, so a test of them waited them out in real
// time: N2, J2, B5 and the like spent 5 to 16 s each idle. Here the clock runs as the real one does, and whenever
// nothing is left to run but timers (the next setImmediate), it jumps to the first of them: every wait is still set and
// still ends in its turn, in order of its time, ties in the order set, and only the idle time is skipped. Work runs in
// real time, so a loop that checks the clock between tries sees it move as it would. node:test's mock.timers moves
// neither performance.now nor AbortSignal.timeout, which the quote reads. A test run on this clock has every answer
// mocked (no network), so nothing it waits on is outside the clock.
// When `run` ends, the clock runs on until every timer set in it has fired (a request's deadline, a hedge that lost, a
// mocked answer's delay), so no work of the test reaches the tests after it; a timer still set at RUNAWAY_MS (work that
// never ends) fails the test, naming where each was set. A run whose clock passes RUNAWAY_MS fails, as it would at its
// test's timeout in real time. A clear of a timer set outside the clock goes to the real clearTimeout.
// Date.now skips with it: the head watch keeps a head fresh until a Date.now time, and stops there as it does in real
// time. Date.now is the whole milliseconds of the same clock, so it is always an integer, never runs back, and shows a
// skipped wait at least as long as it was set (skipped time is whole milliseconds, a timer fires at or after its time). The clock never runs back: once a run has skipped idle time, performance.now and Date.now stay that far ahead
// for the rest of the process (a quote's state keeps times it read, such as a provider held until a time), as after a
// real wait. The
// wallet's test/pool-evm-restore.test.ts runs its helper route's pace on the same kind of clock.

/** Ten times the longest test timeout of a test run on this clock (60 s). */
export const RUNAWAY_MS = 600_000;

const READ = performance.now.bind(performance);
// the idle time every run so far has skipped, whole milliseconds: performance.now reads the real clock plus it, from the
// first run on
let skipped = 0;
// timer ids are the process's, never reused: a late clear of an earlier run's timer never takes out a later one's
let id = 0;
const now = () => READ() + skipped;
const DATE = Date.now.bind(Date);
// Date.now on the clock: the wall time at the first run, rounded up so it never reads below the real one then, moved on by
// the clock; set once, so it never runs back across runs
let dateAt: number | undefined;
const dateNow = () => Math.floor(dateAt! + now());

/** A timer of the clock: the handle setTimeout returns, as Node's (a quote unrefs some of its timers). */
class Timer {
  readonly id: number;
  constructor(n: number) {
    this.id = n;
  }
  unref() { return this; }
  ref() { return this; }
  hasRef() { return true; }
  [Symbol.toPrimitive]() { return this.id; }
}

export async function onTestClock<T>(run: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as Record<"setTimeout" | "clearTimeout", unknown>;
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, timeout: AbortSignal.timeout };
  const t0 = now();
  let driving = false, ranAway = false;
  let runaway: (e: Error) => void = () => {};
  const stopped = new Promise<never>((_, no) => (runaway = no));
  stopped.catch(() => {});
  // the timers set and not yet fired or cleared, in the order they fire: by time, ties in the order set
  const queue: { due: number; id: number; fire: () => void; at: Error }[] = [];
  const live = new Set<number>();
  const drive = () => {
    let next = queue.shift();
    while (next !== undefined && !live.has(next.id)) next = queue.shift();
    if (next === undefined) return void (driving = false);
    if (Math.max(now(), next.due) - t0 > RUNAWAY_MS) {
      queue.unshift(next);
      return void ((driving = false), (ranAway = true), runaway(new Error(`the test clock ran away: past ${RUNAWAY_MS} ms`)));
    }
    live.delete(next.id);
    skipped += Math.max(0, Math.ceil(next.due - now()));
    setImmediate(drive);
    next.fire();
  };
  g.setTimeout = (f: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
    // a delay in whole milliseconds, a fraction rounded up: the wait it shows on Date.now is never shorter than it was set
    const t = { due: now() + Math.ceil(Math.max(0, Number(ms) || 0)), id: ++id, fire: () => f(...a), at: new Error("set here") };
    let lo = 0, hi = queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (queue[mid]!.due <= t.due) lo = mid + 1;
      else hi = mid;
    }
    queue.splice(lo, 0, t);
    live.add(t.id);
    if (!driving && !ranAway) (driving = true), setImmediate(drive);
    return new Timer(t.id);
  };
  g.clearTimeout = (h: unknown) => (h instanceof Timer ? void live.delete(h.id) : real.clearTimeout(h as Parameters<typeof clearTimeout>[0]));
  AbortSignal.timeout = (ms: number) => {
    const c = new AbortController();
    (g.setTimeout as typeof setTimeout)(() => c.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
    return c.signal;
  };
  Object.defineProperty(performance, "now", { value: now, configurable: true, writable: true });
  if (dateAt === undefined) {
    dateAt = DATE() + 1 - now();
    Date.now = dateNow;
  }
  let out: { ok: true; v: T } | { ok: false; e: unknown };
  try {
    out = { ok: true, v: await Promise.race([run(), stopped]) };
  } catch (e) {
    out = { ok: false, e };
  }
  // the test's own work runs out on the clock: every timer it set fires, or the clock runs away
  while (driving) await new Promise((r) => setImmediate(r));
  const left = queue.filter((t) => live.has(t.id));
  g.setTimeout = real.setTimeout;
  g.clearTimeout = real.clearTimeout;
  AbortSignal.timeout = real.timeout;
  queue.length = 0;
  live.clear();
  if (!out.ok) throw out.e;
  if (left.length > 0) {
    const where = left.slice(0, 3).map((t) => (t.at.stack ?? "").split("\n").slice(2, 5).map((l) => l.trim()).join(" < "));
    throw new Error(`the test left ${left.length} timer(s) that never stop: ${where.join(" | ")}`);
  }
  return out.v;
}
