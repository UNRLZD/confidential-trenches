// The tests' one way to let work settle (card settle-checks-wait-for-crypto): never a count of event-loop turns. The
// thread pool runs WebCrypto's jobs (the wallet store's AES-GCM reads and writes, digests, key work) and the file system's,
// and each answer comes back on a later turn that no immediate waits for, so N turns of setImmediate is a clock in
// disguise: a machine whose threads are busy keeps a job past any N (merge queue run 44907577683: past 500 turns for one
// note read, packages/signpage/test/tap-prepare-page.test.ts). quiet() runs turns until no immediate is active and no
// thread-pool job is in flight; settle(until) until `until()` holds or the loop is quiet. A job is any async resource
// whose type ends in REQUEST, REQCALLBACK, REQPROMISE or REQWRAP; the sync random bytes behind getRandomValues
// (RANDOMBYTESREQUEST) never call back and are left out. scripts/ci/turn-settle.mjs refuses a new raw turn loop in a
// test. The same file sits in packages/kit, packages/signpage and packages/wallet, byte for byte: no package imports
// another's tests.
import { createHook } from "node:async_hooks";
import { pbkdf2 } from "node:crypto";

const JOB = /(?:REQUEST|REQCALLBACK|REQPROMISE|REQWRAP)$/;
const jobs = new Map<number, string>();
// on at import, before the test's first job: a job begun before it is never seen
createHook({
  init: (id, type) => void (JOB.test(type) && type !== "RANDOMBYTESREQUEST" && jobs.set(id, type)),
  before: (id) => void jobs.delete(id),
  destroy: (id) => void jobs.delete(id),
}).enable();

/** The thread-pool jobs in flight now, by type. */
export const jobsInFlight = (): string[] => [...jobs.values()];

const turn = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
// microtask chains that start an immediate only after a few turns of their own (a store read's await chain) are given
// MIN_TURNS before the loop may call itself quiet
const MIN_TURNS = 30;
// a job that never answers (a socket that hangs) is a test's fault, named, never a silent hang
const MAX_TURNS = 1_000_000;

/** Runs turns until `until()` holds or nothing is left to run but a timer: no immediate active and no thread-pool job
 *  in flight, after MIN_TURNS. Returns `until()`; an async `until` (a store read) is awaited at each turn. */
export async function settle(until: () => boolean | Promise<boolean> = () => false): Promise<boolean> {
  for (let i = 0; !(await until()) && (i < MIN_TURNS || jobs.size > 0 || process.getActiveResourcesInfo().includes("Immediate")); i++) {
    if (i > MAX_TURNS) throw new Error(`the loop never went quiet: ${jobsInFlight().join(", ")}`);
    await turn();
  }
  return await until();
}

/** Runs turns until nothing is left to run but a timer (settle with no condition). */
export async function quiet(): Promise<void> {
  await settle();
}

/** The plant: eight key derivations on the thread pool, each a few hundred ms, so the thread pool's next jobs (the
 *  wallet store's AES-GCM) queue behind them, as on a busy machine. A wait that counts turns fails under it; settle and
 *  quiet wait them out. */
export function busyThreads(): void {
  for (let i = 0; i < 8; i++) pbkdf2("busy", "threads", 1_000_000, 32, "sha256", () => {});
}
