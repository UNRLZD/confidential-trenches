// The chain's swap index on disk (card helper-evm-tapes-survive-a-restart): a SQLite file on the helper's store volume
// (HELPER_STORE_DIR, the volume compose.yaml mounts and pool-index.ts already keeps its file on), written as the index
// grows and read at the next start, so a deploy's new helper holds the window the old one read and reads only the blocks
// since (index.ts createSwapIndex `store`). Before this every start read Robinhood's whole window again (4,500 blocks,
// about 14,000 logs, nine chain-wide reads on the keyed providers the tapes read), and the live run that followed each
// deploy met tapes still filling (run 44249482613: helper-tape-4337-trader and token-stats-count-every-trade failed
// 11 and 15 min after the deploy, both PASS on the warm helper at 07:00-07:10Z).
//
// Each write is one transaction (a chunk's logs, the blocks dropped off the window's back and the range held), so the
// file holds a whole range or the one before. A file that does not open, fails SQLite's quick_check, was written for
// other topics or another layout, or holds one row that fails a check (each field as parseLog takes it from a provider,
// every block inside the range held) is deleted and started again empty: a copy is read in full or not at all, never
// served in part. A copy says nothing of the chain's head: index.ts serves it only once it has read up to a head
// read after the start (a copy past its window behind that head is dropped), so a stale copy is never complete.
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { checkpointAside } from "../../store/checkpoint.ts";
import type { Log } from "./swaps.ts";

/** The layout this file writes; a file of another is started again. */
const LAYOUT = "1";
const WORD = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DATA = /^0x([0-9a-f]{64}){0,16}$/;

export type IndexCopy = { from: number; to: number; logs: Log[] };
export type IndexStore = {
  /** The copy the file holds, in block and log order, or null (none, or one that failed a check and was dropped). */
  load(): IndexCopy | null;
  /** Holds blocks from..to: adds `logs` (blocks past the old range), drops every row before `from`; with `whole`, the
   *  file's rows are replaced by `logs`. One transaction. */
  put(from: number, to: number, logs: readonly Log[], whole?: boolean): void;
  /** Holds nothing. */
  clear(): void;
  /** Ends the file's checkpoint thread and closes the file. */
  close(): void;
};

type Row = { block: unknown; idx: unknown; tx: unknown; address: unknown; topics: unknown; data: unknown; t: unknown };

const nat = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** The row as a Log, or null when any field fails the check parseLog makes of a provider's answer. */
function logOf(r: Row, topics: ReadonlySet<string>, from: number, to: number): Log | null {
  if (!nat(r.block) || r.block < from || r.block > to || !nat(r.idx)) return null;
  if (typeof r.tx !== "string" || !WORD.test(r.tx) || typeof r.address !== "string" || !ADDRESS.test(r.address)) return null;
  if (typeof r.topics !== "string" || typeof r.data !== "string" || !DATA.test(r.data)) return null;
  const ts = r.topics.split(",");
  if (ts.length < 1 || ts.length > 4 || !ts.every((x) => WORD.test(x)) || !topics.has(ts[0]!)) return null;
  if (r.t !== null && !nat(r.t)) return null;
  return { block: r.block, index: r.idx, tx: r.tx, address: r.address, topics: ts, data: r.data, t: r.t as number | null };
}

/** How long a statement waits for the other helper of a deploy to finish a write (both mount the store volume while
 *  they overlap; only the one that holds the senders writes, index.ts `writable`). */
const BUSY_MS = 5_000;

function open(file: string, topicsKey: string): DatabaseSync {
  const db = new DatabaseSync(file, { timeout: BUSY_MS });
  try {
    // synchronous NORMAL, SQLite's own setting for WAL: a write's commit syncs nothing in a turn of the loop (card
    // helper-loop-never-held-by-a-read: under FULL a pool index commit's sync held a copy's loop 637 and 757 ms). A
    // crash never tears the file; a power loss rolls back only the newest writes, so the file still holds a whole range
    // or one before it. The log's checkpoint, the one sync left, runs on a thread of its own (store/checkpoint.ts).
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE IF NOT EXISTS logs (block INTEGER NOT NULL, idx INTEGER NOT NULL, tx TEXT NOT NULL, address TEXT NOT NULL, topics TEXT NOT NULL, data TEXT NOT NULL, t INTEGER, PRIMARY KEY (block, idx)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;`);
    const ok = db.prepare("PRAGMA quick_check").all() as { quick_check?: unknown }[];
    if (ok.length !== 1 || ok[0]!.quick_check !== "ok") throw new Error("quick_check failed");
    const meta = new Map((db.prepare("SELECT k, v FROM meta").all() as { k: string; v: string }[]).map((m) => [m.k, m.v]));
    if (meta.size > 0 && (meta.get("layout") !== LAYOUT || meta.get("topics") !== topicsKey)) throw new Error("another layout or topics");
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

/** The store at `file`, started again empty when the file is torn, corrupt or of another layout; null when even an
 *  empty file cannot be made (the index then runs in memory alone, as before). `log` names each drop. */
export function openIndexStore(file: string, topicList: readonly string[], log: (line: string) => void = () => undefined): IndexStore | null {
  const topics = new Set(topicList.map((t) => t.toLowerCase()));
  const topicsKey = [...topics].sort().join(",");
  const drop = () => {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
  };
  let db: DatabaseSync;
  try {
    db = open(file, topicsKey);
  } catch (e) {
    // a file the other helper holds locked is that helper's, never dropped: this one runs in memory
    if (/locked|busy/i.test((e as Error).message)) {
      log(`swap index store ${file}: not opened (${(e as Error).message}), the index runs in memory`);
      return null;
    }
    log(`swap index store ${file}: dropped (${(e as Error).message}), started again`);
    try {
      drop();
      db = open(file, topicsKey);
    } catch (e2) {
      log(`swap index store ${file}: not opened (${(e2 as Error).message}), the index runs in memory`);
      return null;
    }
  }
  // the thread never holds the loop (unref'd), and ends with the store's close
  const aside = checkpointAside(file, () => db.isOpen && db.exec("PRAGMA wal_autocheckpoint = 1000"));
  const setMeta = db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v");
  const put = db.prepare("INSERT OR REPLACE INTO logs (block, idx, tx, address, topics, data, t) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const before = db.prepare("DELETE FROM logs WHERE block < ?");
  const tx = (f: () => void) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      f();
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const empty = () => db.exec("DELETE FROM logs; DELETE FROM meta;");
  const read = (): IndexCopy | null => {
    const meta = new Map((db.prepare("SELECT k, v FROM meta").all() as { k: string; v: string }[]).map((m) => [m.k, m.v]));
    const from = Number(meta.get("from"));
    const to = Number(meta.get("to"));
    if (!nat(from) || !nat(to) || from > to) {
      if (meta.size > 0) log(`swap index store ${file}: no range held, started again`);
      tx(empty);
      return null;
    }
    const logs: Log[] = [];
    for (const r of db.prepare("SELECT block, idx, tx, address, topics, data, t FROM logs ORDER BY block, idx").iterate() as Iterable<Row>) {
      const l = logOf(r, topics, from, to);
      if (l === null) {
        log(`swap index store ${file}: a row failed its check, dropped whole and started again`);
        tx(empty);
        return null;
      }
      logs.push(l);
    }
    return { from, to, logs };
  };
  return {
    close() {
      aside.stop();
      if (db.isOpen) db.close();
    },
    load() {
      try {
        return read();
      } catch (e) {
        // a page that does not read past quick_check: the copy is dropped, and the file emptied for the writes after
        log(`swap index store ${file}: not read (${(e as Error).message}), dropped`);
        try {
          tx(empty);
        } catch {
          // the writes then fail and stop (index.ts save); the index runs in memory
        }
        return null;
      }
    },
    put(from, to, logs, whole = false) {
      tx(() => {
        if (whole) db.exec("DELETE FROM logs");
        else before.run(from);
        for (const l of logs) put.run(l.block, l.index, l.tx, l.address, l.topics.join(","), l.data, l.t ?? null);
        setMeta.run("layout", LAYOUT);
        setMeta.run("topics", topicsKey);
        setMeta.run("from", String(from));
        setMeta.run("to", String(to));
      });
    },
    clear() {
      tx(empty);
    },
  };
}
