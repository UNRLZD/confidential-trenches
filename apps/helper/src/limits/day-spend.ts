// The keyed accounts' daily spend, kept in the helper's store and shared (card rpc-keyed-lists, review H1 of 424dce1e).
// Each account's daily budget (limits.ts KEYED_DAY) bounds its plan's month only if every helper on the keys counts it:
// a deploy starts a new helper, which kept its spend in memory from zero, beside the old one still spending during the
// handover, so each start granted a whole new day. Each helper (`id`, a random UUID per start) keeps its own spend of the
// UTC day in a file under HELPER_STORE_DIR (the volume both mount), and counts every other helper's file of the same day:
// a stopped helper's file counts until its day ends, so a restart resumes the day's spend; a running one's is re-read
// every DAY_PEERS_MS, so the two in a handover count each other's within that. The same shape as the vendor calls'
// shared counter (proxy/shared-calls.ts): one file per helper, written whole (a temp file, fsync, one rename), no lock,
// so neither helper waits on the other. The relayers' store (store/durable.ts) is not used: one process holds its
// folder at a time, and the handover's two helpers both spend.
//
// Every file is hostile input: a name that is not a helper's, a file past DAY_FILE_MAX, one that does not parse, a
// spend that is not a finite number at or above 0, or another day's file counts nothing; a file of an earlier day is
// removed.
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

export const DAY_DIR = "rpc-day";
/** A file's size limit: a few dozen accounts' names and numbers, with room. */
export const DAY_FILE_MAX = 16 * 1024;
/** The most helpers' files counted in a day. [design: a start each deploy; 256 is far past a day's deploys.] */
export const DAY_FILES_MAX = 256;
const NAME = /^[0-9a-f-]{8,64}\.json$/;

/** This helper's day file and the others'. `read`: every other helper's spend in UTC day `day`, each account's summed;
 *  `write`: this helper's spend in `day`, replaced whole. */
export type DayPeers = {
  read(day: number): Map<string, number>;
  write(day: number, units: ReadonlyMap<string, number>): void;
};

/** The day files under `storeDir` for this helper (`id`), or none when the helper has no store (memory only). */
export function dayFiles(storeDir: string, id: string): DayPeers | undefined {
  if (storeDir === "") return undefined;
  const dir = join(storeDir, DAY_DIR);
  const own = `${id}.json`;
  return {
    write(day, units) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = join(dir, `.tmp-${id}`);
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, JSON.stringify({ day, units: Object.fromEntries(units) }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, join(dir, own));
    },
    read(day) {
      const sum = new Map<string, number>();
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return sum; // no helper has spent yet
      }
      for (const n of names.filter((x) => NAME.test(x) && x !== own).sort().slice(0, DAY_FILES_MAX)) {
        const f = join(dir, n);
        try {
          if (statSync(f).size > DAY_FILE_MAX) continue;
          const w = JSON.parse(readFileSync(f, "utf8")) as { day?: unknown; units?: unknown };
          if (typeof w?.day !== "number") continue;
          if (w.day < day) {
            rmSync(f, { force: true });
            continue;
          }
          if (w.day !== day || typeof w.units !== "object" || w.units === null || Array.isArray(w.units)) continue;
          for (const [k, v] of Object.entries(w.units)) if (typeof v === "number" && Number.isFinite(v) && v >= 0) sum.set(k, (sum.get(k) ?? 0) + v);
        } catch {
          // a file replaced or removed meanwhile: read again at the next re-read
        }
      }
      return sum;
    },
  };
}
