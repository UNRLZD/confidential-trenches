// A SQLite file's WAL checkpoints on a thread of their own (card helper-loop-never-held-by-a-read). The helper's two
// files (the pool index, the swap index store) are written on the event loop in WAL mode with synchronous NORMAL, where
// a commit syncs nothing and only a checkpoint syncs the disk; SQLite runs that checkpoint inside the commit that takes
// the log past 1,000 pages, so it held the loop: a copy's profile under the page checks held keep's commit 637 to
// 1,044 ms with no sample taken, and on the Mac 400 commits of 40 rows each held one 253.7 ms with the checkpoint left
// on, 12.7 ms at most with it off. So the file's own connection turns it off (wal_autocheckpoint = 0) and this thread's
// connection checkpoints PASSIVE every CHECKPOINT_MS: it never waits on a writer or a reader, and a writer never waits
// on it, so its sync holds this thread alone.
import { Worker } from "node:worker_threads";

/** How often the thread checkpoints the file: the log holds at most this long's writes past the last checkpoint. */
export const CHECKPOINT_MS = 1_000;

const BODY = `
const { DatabaseSync } = require("node:sqlite");
const { workerData, parentPort } = require("node:worker_threads");
const db = new DatabaseSync(workerData.file);
const once = () => { try { db.exec("PRAGMA wal_checkpoint(PASSIVE)"); } catch {} };
const t = setInterval(once, workerData.everyMs);
parentPort.on("message", () => { clearInterval(t); once(); db.close(); parentPort.close(); });
`;

/** Checkpoints `file` on its own thread every `everyMs`, until `stop`. `failed` runs when the thread cannot run (the
 *  caller then turns its own connection's checkpoint back on, so the log never grows without bound). */
export function checkpointAside(file: string, failed: (e: Error) => void, everyMs = CHECKPOINT_MS): { stop: () => void } {
  const w = new Worker(BODY, { eval: true, workerData: { file, everyMs } });
  w.unref();
  w.on("error", failed);
  return { stop: () => w.postMessage("stop") };
}
