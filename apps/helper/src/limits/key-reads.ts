// card near-off-the-fastnear-key: every request the helper sends to its FastNEAR key (NEAR_RPC_URL_FASTNEAR), counted per
// UTC day in two buckets, and a daily ceiling on the two together. The key is a Pro key UNRLZD shares (36M requests a
// month across the account, its users' paid fallback included), so what CT spends is named and bounded:
//   - helper: the helper's own reads (the NEAR pair's readers through token-status/status.ts pairFetch: the withdraw fee
//     quoter, the token watch, the deposit and withdrawal carries; and rpc/rpc.ts's identity read of the key);
//   - seat: the reads it relays for devices on /v1/rpc/near, ?keyed=only and plain (rpc/rpc.ts fitPost).
// Past the ceiling (NEAR_KEY_DAY, default NEAR_KEY_DAY_DEFAULT) the key is not asked until the next UTC day: the pair
// reads its free endpoints first, the seat answers 503 so the page reads its keyless spare, the plain route walks on.
// The counts are kept as the keyed day files are (limits/day-spend.ts): each helper (`id`, a random UUID per start)
// writes its own file under HELPER_STORE_DIR (the volume a handover's two helpers both mount), whole (a temp file, fsync,
// one rename), and sums every other helper's, re-read at most every DAY_SYNC_MS; a stopped helper's file counts until its
// days pass, so a restart or a deploy resumes the day. Today and yesterday are kept, so the header names a whole day.
// Every file is hostile input: a name that is not a helper's, a file past FILE_MAX, one that does not parse, or a count
// that is not a whole number at or above 0 counts nothing; a file holding no kept day is removed.
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DAY_SYNC_MS } from "./limits.ts";

export const KEY_READS_DIR = "near-key-reads";
/** GET /v1/health's header naming today's and yesterday's counts, the ceiling and whether today's reached it. */
export const NEAR_KEY_READS_HEADER = "X-Helper-Near-Key-Reads";
/** The settings name of the daily ceiling, helper and seat together. */
export const NEAR_KEY_DAY_ENV = "NEAR_KEY_DAY";
/** [design: 300,000 a UTC day, a quarter of the shared Pro plan's 36,000,000 a month over 30 days (UNRLZD, 26 Nov 13:41Z),
 *  inside the relayed reads' own 322,580 (limits.ts KEYED_DAY fastnear), which stays the inner bound on the seat] */
export const NEAR_KEY_DAY_DEFAULT = 300_000;
export type KeyBucket = "helper" | "seat";
type Counts = { helper: number; seat: number };
const DAY_MS = 86_400_000;
/** A file's size limit: two days' two counts, with room. */
const FILE_MAX = 4 * 1024;
/** The most helpers' files counted. [design: a start each deploy; 256 is far past two days' deploys] */
const FILES_MAX = 256;
const NAME = /^[0-9a-f-]{8,64}\.json$/;
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** NEAR_KEY_DAY from the settings: unset or empty is the default; anything but a whole number above 0 stops the start,
 *  naming the variable. */
export function nearKeyDayOf(env: Record<string, string | undefined>): number {
  const v = env[NEAR_KEY_DAY_ENV];
  if (v === undefined || v === "") return NEAR_KEY_DAY_DEFAULT;
  const n = Number(v);
  if (!/^[0-9]+$/.test(v) || !Number.isSafeInteger(n) || n <= 0) throw new Error(`${NEAR_KEY_DAY_ENV} must be a whole number above 0`);
  return n;
}

export type KeyReads = {
  /** One request sent to the key (`n` of them), in `bucket`. */
  add(bucket: KeyBucket, n?: number): void;
  /** Whether `n` more requests stay within today's ceiling, every helper's counts summed. */
  open(n?: number): boolean;
  /** Today's and yesterday's counts, every helper's summed: "2026-11-26 helper=12 seat=34 of 300000 open, 2026-11-25
   *  helper=0 seat=0 of 300000 open". */
  header(): string;
  /** Keeps the counts under `storeDir` as helper `id` with ceiling `day`; an empty `storeDir` keeps them in memory. */
  attach(storeDir: string, id: string, day: number): void;
  /** Writes this helper's file now (a stop; tests). */
  flush(): void;
};

export function keyReads(now: () => number = Date.now, ceiling = NEAR_KEY_DAY_DEFAULT): KeyReads {
  const own = new Map<number, Counts>();
  let dir: string | undefined;
  let id = "";
  let day = ceiling;
  let wroteAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let peers = new Map<number, Counts>();
  let peersAt = -Infinity;
  const today = () => Math.floor(now() / DAY_MS);
  const iso = (d: number) => new Date(d * DAY_MS).toISOString().slice(0, 10);

  const write = () => {
    if (dir === undefined) return;
    const t = today();
    for (const d of [...own.keys()]) if (d < t - 1) own.delete(d);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.tmp-${id}`);
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify({ days: Object.fromEntries(own) }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, join(dir, `${id}.json`));
    wroteAt = now();
  };
  const sync = () => {
    if (dir === undefined) return;
    const since = now() - wroteAt;
    if (since >= DAY_SYNC_MS) return write();
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      write();
    }, DAY_SYNC_MS - since);
    timer.unref?.();
  };
  const readPeers = (): Map<number, Counts> => {
    const sum = new Map<number, Counts>();
    if (dir === undefined) return sum;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return sum; // no helper has counted yet
    }
    const t = today();
    for (const n of names.filter((x) => NAME.test(x) && x !== `${id}.json`).sort().slice(0, FILES_MAX)) {
      const f = join(dir, n);
      try {
        if (statSync(f).size > FILE_MAX) continue;
        const days = (JSON.parse(readFileSync(f, "utf8")) as { days?: unknown })?.days;
        if (typeof days !== "object" || days === null || Array.isArray(days)) continue;
        let kept = false;
        for (const [k, v] of Object.entries(days)) {
          const d = Number(k);
          if (!Number.isSafeInteger(d) || d < t - 1 || d > t) continue;
          kept = true;
          const c = v as { helper?: unknown; seat?: unknown } | null;
          if (c === null || typeof c !== "object" || !whole(c.helper) || !whole(c.seat)) continue;
          const s = sum.get(d) ?? { helper: 0, seat: 0 };
          sum.set(d, { helper: s.helper + c.helper, seat: s.seat + c.seat });
        }
        if (!kept) rmSync(f, { force: true });
      } catch {
        // a file replaced or removed meanwhile: read again at the next re-read
      }
    }
    return sum;
  };
  const totals = (d: number): Counts => {
    if (now() - peersAt >= DAY_SYNC_MS) {
      peers = readPeers();
      peersAt = now();
    }
    const a = own.get(d);
    const b = peers.get(d);
    return { helper: (a?.helper ?? 0) + (b?.helper ?? 0), seat: (a?.seat ?? 0) + (b?.seat ?? 0) };
  };

  return {
    add(bucket, n = 1) {
      const d = today();
      const c = own.get(d) ?? { helper: 0, seat: 0 };
      c[bucket] += n;
      own.set(d, c);
      sync();
    },
    open(n = 1) {
      const c = totals(today());
      return c.helper + c.seat + n <= day;
    },
    header() {
      const t = today();
      return [t, t - 1]
        .map((d) => {
          const c = totals(d);
          return `${iso(d)} helper=${c.helper} seat=${c.seat} of ${day} ${c.helper + c.seat >= day ? "hit" : "open"}`;
        })
        .join(", ");
    },
    attach(storeDir, newId, newDay) {
      day = newDay;
      if (storeDir === "") return;
      dir = join(storeDir, KEY_READS_DIR);
      id = newId;
      peersAt = -Infinity;
      write();
    },
    flush: () => write(),
  };
}

/** The helper's one counter: every reader of the key counts here (server.ts attaches it to the store at its start). */
export const NEAR_KEY_READS: KeyReads = keyReads();
