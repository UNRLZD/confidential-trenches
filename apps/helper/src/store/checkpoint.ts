// A SQLite file's WAL checkpoints on a thread of their own (card helper-loop-never-held-by-a-read). The helper's two
// files (the pool index, the swap index store) are written on the event loop in WAL mode with synchronous NORMAL, where
// a commit syncs nothing and only a checkpoint syncs the disk; SQLite runs that checkpoint inside the commit that takes
// the log past 1,000 pages, so it held the loop: a copy's profile under the page checks held keep's commit 637 to
// 1,044 ms with no sample taken, and on the Mac 400 commits of 40 rows each held one 253.7 ms with the checkpoint left
// on, 12.7 ms at most with it off. So the file's own connection turns it off (wal_autocheckpoint = 0) and this thread's
// connection checkpoints PASSIVE every CHECKPOINT_MS: it never waits on a writer or a reader, and a writer never waits
// on it, so its sync holds this thread alone.
//
// The thread never makes a file: it opens the file read-write only (mode=rw, which refuses a file that is not there),
// on its first round that finds it, and keeps that connection. `stop` waits, bounded by STOP_WAIT_MS, until the thread
// has closed it, so a file closed by its owner is never opened again behind it (the helper suite at 179ee8d66: a thread
// that opened its file after the test removed it left the test's directory not empty).
//
// A checkpoint that fails (the file will not open, an I/O error) is told to the owner and ends the thread: `failed` runs,
// and the owner turns its own connection's checkpoint back on, so the log never grows while nothing checkpoints it.
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

/** How often the thread checkpoints the file: the log holds at most this long's writes past the last checkpoint. */
export const CHECKPOINT_MS = 1_000;
/** The longest `stop` waits for the thread to close its connection [design: a checkpoint's sync, the one thing it can be
 *  doing, took 1,044 ms at the worst read]. */
export const STOP_WAIT_MS = 2_000;

const BODY = `
const { DatabaseSync } = require("node:sqlite");
const { existsSync } = require("node:fs");
const { workerData, parentPort } = require("node:worker_threads");
const done = new Int32Array(workerData.done);
let db = null;
const once = () => {
  try {
    if (db === null) {
      if (!existsSync(workerData.path)) return;
      db = new DatabaseSync(new URL(workerData.url));
    }
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  } catch (e) {
    clearInterval(t);
    try { db?.close(); } catch {}
    db = null;
    parentPort.postMessage({ failed: String(e?.message ?? e) });
  }
};
const t = setInterval(once, workerData.everyMs);
parentPort.on("message", () => {
  clearInterval(t);
  try { db?.close(); } catch {}
  Atomics.store(done, 0, 1);
  Atomics.notify(done, 0);
  parentPort.close();
});
`;

/** Checkpoints `file` on its own thread every `everyMs`, until `stop`. `failed` runs when the thread cannot run (the
 *  caller then turns its own connection's checkpoint back on, so the log never grows without bound). */
export function checkpointAside(file: string, failed: (e: Error) => void, everyMs = CHECKPOINT_MS): { stop: () => void } {
  const url = pathToFileURL(file);
  url.searchParams.set("mode", "rw");
  const done = new SharedArrayBuffer(4);
  const w = new Worker(BODY, { eval: true, workerData: { path: file, url: url.href, everyMs, done } });
  w.unref();
  let alive = true;
  let told = false;
  const fail = (e: Error): void => {
    if (told) return;
    told = true;
    failed(e);
  };
  w.on("error", (e) => {
    alive = false;
    fail(e);
  });
  w.on("message", (m: { failed?: string }) => {
    if (typeof m?.failed === "string") fail(new Error(`checkpoint of ${file}: ${m.failed}`));
  });
  w.on("exit", () => void (alive = false));
  return {
    stop: () => {
      if (!alive) return;
      w.postMessage("stop");
      Atomics.wait(new Int32Array(done), 0, 0, STOP_WAIT_MS);
    },
  };
}
