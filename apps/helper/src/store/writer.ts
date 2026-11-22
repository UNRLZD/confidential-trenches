// A SQLite file's one write connection on a thread of its own (card pool-index-writer-off-the-main-thread). A write on
// the event loop holds it for the disk's time: in a bench of the pool index's backfill (300k pools in 5k-pool spans,
// WAL with synchronous NORMAL, the real turn slicer, macOS) single commits took 100 to 601 ms whatever the slice's size,
// so no slicing on the loop bounds them. Here each transaction runs on this thread's connection, the loop only posts
// its rows and awaits the answer, and the caller's own connection only reads (WAL: a reader runs beside the writer).
//
// The caller makes the file and its tables on its own connection before the thread starts; the thread opens the file
// read-write only (mode=rw, which refuses a file that is not there). Transactions run in the order they are posted, each
// one BEGIN IMMEDIATE .. COMMIT, rolled back whole on any error, which the caller's promise is rejected with. A thread
// that dies rejects every transaction it holds, and the next one starts a new thread. `close` waits, bounded by
// CLOSE_WAIT_MS, until the thread has finished what it holds and closed its connection, so a file closed by its caller
// is never written again behind it.
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

/** The longest `close` waits for the thread to finish its transactions and close [design: a commit took 601 ms at the
 *  worst read; a span's transaction is at most POOL_INDEX_SPAN_LOGS rows]. */
export const CLOSE_WAIT_MS = 5_000;
/** How long the thread's connection waits for the file's write lock before a transaction fails (busy_timeout). */
export const WRITER_BUSY_MS = 10_000;

const BODY = `
const { DatabaseSync } = require("node:sqlite");
const { workerData, parentPort } = require("node:worker_threads");
const done = new Int32Array(workerData.done);
let db = null;
let statements = null;
const open = () => {
  if (db !== null) return;
  db = new DatabaseSync(new URL(workerData.url));
  db.exec(workerData.pragmas + " PRAGMA busy_timeout = " + workerData.busyMs + ";");
  statements = workerData.statements.map((s) => db.prepare(s));
};
parentPort.on("message", (m) => {
  if (m === "close") {
    try { db?.close(); } catch {}
    db = null;
    Atomics.store(done, 0, 1);
    Atomics.notify(done, 0);
    parentPort.close();
    return;
  }
  try {
    open();
    if (typeof m.sql === "string") {
      db.exec(m.sql);
    } else {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const [k, params] of m.ops) statements[k].run(...params);
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch {}
        throw e;
      }
    }
    parentPort.postMessage({ id: m.id });
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: String(e?.message ?? e) });
  }
});
`;

/** One transaction's writes: each the index of a statement given at the start and its parameters. */
export type WriteOps = [number, unknown[]][];
export type Writer = {
  /** Runs `ops` in one transaction on the thread's connection: resolves once committed, rejects (rolled back) on any
   *  error. */
  tx(ops: WriteOps): Promise<void>;
  /** Runs `sql` (a pragma) on the thread's connection. */
  exec(sql: string): Promise<void>;
  /** Waits, bounded, for the thread to finish and close its connection. */
  close(): void;
};

/** `file`'s write connection on its own thread: `pragmas` run when it opens, `statements` prepared once. */
export function writerAside(file: string, pragmas: string, statements: readonly string[]): Writer {
  const url = pathToFileURL(file);
  url.searchParams.set("mode", "rw");
  let w: Worker | null = null;
  let done: SharedArrayBuffer | null = null;
  let closed = false;
  let seq = 0;
  const pending = new Map<number, { ok: () => void; no: (e: Error) => void }>();
  // the thread holds the loop only while it holds a transaction, so a process with an idle writer exits on its own
  const hold = (): void => void (pending.size > 0 ? w?.ref() : w?.unref());
  const lost = (why: Error): void => {
    w = null;
    for (const p of pending.values()) p.no(why);
    pending.clear();
  };
  const thread = (): Worker => {
    if (w !== null) return w;
    done = new SharedArrayBuffer(4);
    // execArgv []: the thread runs none of the process's own flags or preloads (store/checkpoint.ts)
    const t = new Worker(BODY, { eval: true, execArgv: [], workerData: { url: url.href, pragmas, statements: [...statements], busyMs: WRITER_BUSY_MS, done } });
    t.on("message", (m: { id: number; error?: string }) => {
      const p = pending.get(m.id);
      if (p === undefined) return;
      pending.delete(m.id);
      if (m.error === undefined) p.ok();
      else p.no(new Error(`write of ${file}: ${m.error}`));
      hold();
    });
    t.on("error", (e) => t === w && lost(e));
    t.on("exit", () => t === w && lost(new Error(`write of ${file}: its thread ended`)));
    w = t;
    hold();
    return t;
  };
  const send = (m: { ops: WriteOps } | { sql: string }): Promise<void> => {
    if (closed) return Promise.reject(new Error(`write of ${file}: closed`));
    const t = thread();
    const id = ++seq;
    return new Promise<void>((ok, no) => {
      pending.set(id, { ok, no });
      hold();
      t.postMessage({ id, ...m });
    });
  };
  return {
    tx: (ops) => send({ ops }),
    exec: (sql) => send({ sql }),
    close: () => {
      if (closed) return;
      closed = true;
      if (w === null || done === null) return;
      w.postMessage("close");
      Atomics.wait(new Int32Array(done), 0, 0, CLOSE_WAIT_MS);
    },
  };
}
