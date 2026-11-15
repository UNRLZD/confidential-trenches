// `run` with setTimeout, clearTimeout, AbortSignal.timeout and performance.now on a clock of the test's own (card
// fresh-run-margin). A quote's waits (a scan's naps between tries, its hold, its bound, a request's deadline) are set
// with setTimeout or AbortSignal.timeout and measured with performance.now, so a test of them waited them out in real
// time: N2, J2, B5 and the like spent 5 to 16 s each idle. Here the clock is virtual, as node:test's mock.timers and
// sinon's fake timers are (card test-clock-runs-on-virtual-time): inside a run it moves only when it skips to the next
// due timer, never with real elapsed time, so a test reads the same times on a slow or busy machine as on a fast one.
// Whenever nothing is left to run but timers (the next setImmediate), it jumps to the first of them: every wait is
// still set and still ends in its turn, in order of its time, ties in the order set. Work takes no time on it: a loop
// that checks the clock between tries sees it move only by the waits it set. Work in the thread pool is work too: while
// a crypto.subtle call (the wallet store's seal, a digest) is in flight the clock holds, so a busy machine's slow
// thread pool never lets a page's polls and passes fire by the hundred before the answer lands. node:test's mock.timers moves neither
// performance.now nor AbortSignal.timeout, which the quote reads. A test run on this clock has every answer mocked
// (no network), so nothing it waits on is outside the clock.
// When `run` ends, the clock runs on until every timer set in it has fired (a request's deadline, a hedge that lost, a
// mocked answer's delay), so no work of the test reaches the tests after it; a timer still set at RUNAWAY_MS (work that
// never ends) fails the test, naming where each was set. A run whose clock passes RUNAWAY_MS of its own time fails, as
// it would at its test's timeout in real time; a busy machine's slow work never brings it closer.
// Date.now skips with it: the head watch keeps a head fresh until a Date.now time, and stops there as it does in real
// time. Date.now is the whole milliseconds of the same clock, so it is always an integer, never runs back, and shows a
// skipped wait exactly as long as it was set, a fraction rounded up (a timer fires at its time). The clock never runs
// back: between runs, performance.now and Date.now move with real time from where the last run left them, so once a
// run has skipped idle time they stay that far ahead for the rest of the process (a quote's state keeps times it read,
// such as a provider held until a time), as after a real wait. The
// wallet's test/pool-evm-restore.test.ts runs its helper route's pace on the same kind of clock.

import { createCipheriv, createDecipheriv, createHash, generateKeySync, KeyObject } from "node:crypto";

// The wallet store's seal (AES-GCM: K_wrap's generateKey, encrypt, decrypt) and the page's digests run in the thread pool,
// whose answer lands after however many event-loop turns the machine's load lets pass: fake-indexeddb's steps run on
// setImmediate meanwhile, so a store's work and a page's reads interleaved differently on a busy machine
// (positions-requests.test.ts: 3 of 12 runs red with each subtle answer 0-15 ms late, none on time). On the clock these
// are worked on the main thread, as the same AES-GCM and SHA of node:crypto, and their promise is settled when made: the
// order of a test's work is the same on any machine. A call this does not cover (another algorithm, a key it cannot
// read) goes to the real crypto.subtle, and the clock holds until it lands.
const HASH: Record<string, string> = { "SHA-1": "sha1", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512" };
const nameOf = (a: unknown) => String(typeof a === "string" ? a : (a as { name?: unknown } | null)?.name ?? "").toUpperCase();
const bytesOf = (b: unknown): Buffer | null =>
  ArrayBuffer.isView(b) ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : b instanceof ArrayBuffer ? Buffer.from(b) : null;
const out = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
/** An AES-GCM key's secret as node:crypto holds it, or null (a key of another kind, or one without `use`). The store's
 *  K_wrap is non-extractable by design; KeyObject.from reads it on this process's own side (its deprecation notice
 *  for that is kept quiet, and should a later Node refuse, the call goes to the real crypto.subtle). */
function aesKey(k: unknown, use: string): KeyObject | null {
  const key = k as CryptoKey;
  if (!(key instanceof CryptoKey) || key.algorithm.name !== "AES-GCM" || !key.usages.includes(use as KeyUsage)) return null;
  const p = process as { noDeprecation?: boolean | undefined };
  const quiet = p.noDeprecation;
  p.noDeprecation = true;
  try {
    return KeyObject.from(key);
  } catch {
    return null;
  } finally {
    p.noDeprecation = quiet;
  }
}
/** The calls worked on the main thread: each returns its settled promise, or undefined for the real crypto.subtle. */
const ON_THREAD: Record<string, (...a: unknown[]) => Promise<unknown> | undefined> = {
  digest: (alg, data) => {
    const h = HASH[nameOf(alg)];
    const b = bytesOf(data);
    return h === undefined || b === null ? undefined : Promise.resolve(out(createHash(h).update(b).digest()));
  },
  generateKey: (alg, extractable, usages) => {
    const a = alg as { name?: unknown; length?: unknown };
    if (nameOf(a) !== "AES-GCM" || ![128, 192, 256].includes(Number(a.length)) || !Array.isArray(usages)) return undefined;
    return Promise.resolve(generateKeySync("aes", { length: Number(a.length) }).toCryptoKey({ name: "AES-GCM" }, Boolean(extractable), usages as KeyUsage[]));
  },
  encrypt: (alg, k, data) => gcm(alg, k, data, true),
  decrypt: (alg, k, data) => gcm(alg, k, data, false),
};
function gcm(alg: unknown, k: unknown, data: unknown, seal: boolean): Promise<unknown> | undefined {
  const a = alg as { iv?: unknown; additionalData?: unknown; tagLength?: unknown };
  const tagBytes = (a.tagLength === undefined ? 128 : Number(a.tagLength)) / 8;
  const iv = bytesOf(a.iv), d = bytesOf(data), aad = a.additionalData === undefined ? null : bytesOf(a.additionalData);
  if (nameOf(alg) !== "AES-GCM" || tagBytes !== 16 || iv === null || iv.length === 0 || d === null || (a.additionalData !== undefined && aad === null)) return undefined;
  const key = aesKey(k, seal ? "encrypt" : "decrypt");
  if (key === null) return undefined;
  const cipher = `aes-${key.symmetricKeySize! * 8}-gcm` as "aes-256-gcm";
  if (seal) {
    const c = createCipheriv(cipher, key, iv, { authTagLength: 16 });
    if (aad !== null) c.setAAD(aad);
    return Promise.resolve(out(Buffer.concat([c.update(d), c.final(), c.getAuthTag()])));
  }
  if (d.length < 16) return Promise.reject(new DOMException("The provided data is too small.", "OperationError"));
  try {
    const c = createDecipheriv(cipher, key, iv, { authTagLength: 16 });
    if (aad !== null) c.setAAD(aad);
    c.setAuthTag(d.subarray(d.length - 16));
    return Promise.resolve(out(Buffer.concat([c.update(d.subarray(0, d.length - 16)), c.final()])));
  } catch {
    return Promise.reject(new DOMException("The operation failed for an operation-specific reason", "OperationError"));
  }
}

/** Ten times the longest test timeout of a test run on this clock (60 s). */
export const RUNAWAY_MS = 600_000;

const READ = performance.now.bind(performance);
// Inside a run the clock reads `at`, moved only to the time of each timer it fires. Between runs it reads the real
// clock plus `ahead`: how far the runs so far have put it ahead, so it carries on from where the last run left it.
let at = 0;
let running = false;
let ahead = 0;
// timer ids are the process's, never reused: a late clear of an earlier run's timer never takes out a later one's
let id = 0;
const now = () => (running ? at : READ() + ahead);
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
  if (running) throw new Error("onTestClock does not nest: one run at a time");
  // whole milliseconds from the start, so a wait reads back exactly as long as it was set (no float remainder)
  at = Math.ceil(READ() + ahead);
  running = true;
  const t0 = at;
  let driving = false, ranAway = false;
  let runaway: (e: Error) => void = () => {};
  const stopped = new Promise<never>((_, no) => (runaway = no));
  stopped.catch(() => {});
  // the timers set and not yet fired or cleared, in the order they fire: by time, ties in the order set
  const queue: { due: number; id: number; fire: () => void; at: Error }[] = [];
  const live = new Set<number>();
  // crypto.subtle calls in flight: while any is, the clock holds (`held`), and the last to settle drives it on
  let outside = 0, held = false;
  const subtle = globalThis.crypto.subtle as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const settle = () => {
    if (--outside === 0 && held) (held = false), setImmediate(drive);
  };
  for (const m of Object.getOwnPropertyNames(Object.getPrototypeOf(subtle))) {
    const f = subtle[m];
    if (m === "constructor" || typeof f !== "function") continue;
    Object.defineProperty(subtle, m, {
      configurable: true,
      writable: true,
      value: (...a: unknown[]) => {
        const now = ON_THREAD[m]?.(...a);
        if (now !== undefined) return now;
        const p = f.apply(subtle, a);
        outside++;
        p.then(settle, settle);
        return p;
      },
    });
  }
  const drive = () => {
    if (outside > 0) return void (held = true);
    let next = queue.shift();
    while (next !== undefined && !live.has(next.id)) next = queue.shift();
    if (next === undefined) return void (driving = false);
    if (Math.max(at, next.due) - t0 > RUNAWAY_MS) {
      queue.unshift(next);
      return void ((driving = false), (ranAway = true), runaway(new Error(`the test clock ran away: past ${RUNAWAY_MS} ms`)));
    }
    live.delete(next.id);
    if (next.due > at) at = next.due;
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
  for (const m of Object.getOwnPropertyNames(subtle)) delete subtle[m];
  // the clock carries on from the run's time with real time; never back (the real clock has only moved on since)
  ahead = at - READ();
  running = false;
  queue.length = 0;
  live.clear();
  if (!out.ok) throw out.e;
  if (left.length > 0) {
    const where = left.slice(0, 3).map((t) => (t.at.stack ?? "").split("\n").slice(2, 5).map((l) => l.trim()).join(" < "));
    throw new Error(`the test left ${left.length} timer(s) that never stop: ${where.join(" | ")}`);
  }
  return out.v;
}
