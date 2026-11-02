// The relayers' one durable store rule (the deposit relayer's records, bind/send.ts, and the withdrawal send records,
// withdraw/index.ts): a directory of small JSON files owned by one process, every write whole and durable.
//
// The owner holds an exclusive SQLite lock on `dir/lock` (node:sqlite, a BEGIN EXCLUSIVE never ended): an fcntl lock
// the kernel keeps for the life of the process and drops when it dies, however it dies, so a killed process never
// leaves a stale lock and two starts at once leave one holder. A replace is write, fsync, rename, fsync of the
// directory; a create-if-absent is write and fsync of a temp file, link to the name (EEXIST: it is there), unlink of
// the temp, fsync of the directory, so no name ever holds a partial file. Temp names are random; the holder sweeps any
// left. Every call here is synchronous: one process holds the directory, so a read and the write after it, with no
// await between, are one step.
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/** The fs calls the store makes; a test passes a recorder to check their order. */
export type StoreFs = Pick<typeof nodeFs, "closeSync" | "fsyncSync" | "linkSync" | "mkdirSync" | "openSync" | "readFileSync" | "readdirSync" | "renameSync" | "unlinkSync" | "writeSync">;

export type DurableDir = {
  /** The names in the directory (temps and the lock left out). */
  names(): string[];
  /** The file's text, or null when it is absent. */
  text(name: string): string | null;
  /** Create-if-absent, durable before it returns: false, with nothing written, when the name is there. */
  createOnce(name: string, v: string): boolean;
  /** Durable whole replace. */
  replace(name: string, v: string): void;
  /** Durable delete; an absent name is no error. */
  remove(name: string): void;
  /** Throws once the lock is given up. */
  held(): void;
  /** Gives the lock up (a test's restart; the process's exit does it too). */
  close(): void;
};

/** How long a start waits for another holder's lock before it refuses (two simultaneous starts: one holds). */
const LOCK_WAIT_MS = 250;
/**
 * Every lock this process holds, until its store's close(): a DatabaseSync nothing references is closed by the garbage
 * collector, and its lock with it (the f487d98 re-check's gc-child), so a store the caller dropped keeps its lock.
 */
const HELD_LOCKS = new Set<DatabaseSync>();

/**
 * Takes `dir`'s lock and sweeps the temps a crash left. `start` runs once the lock is held and the temps are gone; a
 * throw there, or in the sweep, gives the lock up, so this process can open the store again.
 */
export function openDurableDir<T>(dir: string, fs: StoreFs, start: (d: DurableDir) => T): T {
  fs.mkdirSync(dir, { recursive: true });
  const path = (name: string) => join(dir, name);

  // The lock: one process per store. Only take() opens this path: POSIX drops all of a process's fcntl locks on a
  // file when any descriptor of that file in the process closes, so nothing else in this process may ever open it
  // (no record name can be "lock"; the truncate below runs only before the lock is held).
  const take = (): DatabaseSync => {
    const db = new DatabaseSync(path("lock"), { timeout: LOCK_WAIT_MS });
    try {
      db.exec("BEGIN EXCLUSIVE");
      return db;
    } catch (e) {
      db.close();
      throw e;
    }
  };
  let lock: DatabaseSync;
  try {
    try {
      lock = take();
    } catch (e) {
      // a holder never writes to the file (it stays an empty database), so content that is not a database was left by
      // something else: emptied in place, the same file, so a holder that took it meanwhile keeps it
      if (!(e instanceof Error && /not a database/.test(e.message))) throw e;
      nodeFs.truncateSync(path("lock"), 0);
      lock = take();
    }
  } catch (e) {
    throw new Error(`store: ${dir} is held by another process (${e instanceof Error ? e.message : String(e)})`);
  }
  HELD_LOCKS.add(lock);
  let open = true;
  const release = () => {
    if (!open) return;
    open = false;
    HELD_LOCKS.delete(lock);
    lock.close();
  };
  const held = () => {
    if (!open) throw new Error("store: closed");
  };

  const syncDir = () => {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  const writeTemp = (v: string): string => {
    const tmp = path(`.tmp-${randomBytes(16).toString("hex")}`);
    const fd = fs.openSync(tmp, "wx");
    try {
      fs.writeSync(fd, v);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return tmp;
  };

  const d: DurableDir = {
    names: () => fs.readdirSync(dir).filter((f) => !f.startsWith(".tmp-") && f !== "lock"),
    text(name) {
      try {
        return fs.readFileSync(path(name), "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    createOnce(name, v) {
      held();
      const tmp = writeTemp(v);
      try {
        fs.linkSync(tmp, path(name));
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e;
      } finally {
        fs.unlinkSync(tmp);
        syncDir();
      }
    },
    replace(name, v) {
      held();
      fs.renameSync(writeTemp(v), path(name));
      syncDir();
    },
    remove(name) {
      held();
      try {
        fs.unlinkSync(path(name));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
      }
      syncDir();
    },
    held,
    close: release,
  };

  // everything a start reads once the lock is held: a throw gives the lock up, so this process can open the store again
  try {
    // temps a crash left behind: never a record, swept once the lock is held
    for (const f of fs.readdirSync(dir)) if (f.startsWith(".tmp-")) fs.unlinkSync(path(f));
    return start(d);
  } catch (e) {
    release();
    throw e;
  }
}
