// The EVM pools' finalized logs, whole (card helper-keyed-logs-serve-a-whole-pool-range). A fresh device reads its
// chain's pool history on the keyed-only route in one eth_getLogs, from the pool's deploy block to the finalized head
// (packages/wallet/src/pool/evm.ts wideOf). Base's keyed list serves at most 100 blocks a call (rpc.ts KEYED_LOGS_SPAN:
// QuickNode's trial 5, dRPC's free keys 100), so the route's paging, at LOGS_PAGES_MAX pages, reaches 10,000 blocks and
// refused the pool's 3.6 million. The helper keeps each pool's logs here instead: filled in the background from the
// deploy block to the finalized head, a page at a time within each provider's span and pace (rpc.ts fillPool), and any
// range of it answered from here, filtered to the caller's topics.
//
// Only the pools the kit pins (evmPoolVenues, the chain's one `pool`) with a deploy block here (POOL_LOGS_FROM) are kept:
// never an arbitrary address over an arbitrary range. Every log kept is a provider's well-formed log of that pool
// inside the page asked, in block and index order (poolLog); the store is in memory and, with HELPER_STORE_DIR set, in
// one file per chain there (a deploy's new helper starts warm), and that file is hostile input read by the same checks.
// The device still takes a log only when its two seats give the same bytes and the trees from them are the pool's at
// the anchor (wideOf), so a kept answer can slow a sign-in, never steer one.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Each pool's deploy block, its logs' first (the wallet's pins, packages/wallet/src/pool/evm.ts EVM_POOLS `fromBlock`;
 *  logs-cache.test.ts holds the same). A chain not here has no store. */
export const POOL_LOGS_FROM: Readonly<Record<string, bigint>> = { base: 54_325_671n, robinhood: 108_420_674n };
/** The store's bound, logs' bytes: past it the fill stops and the route answers as before. [design: 64 MiB: a pool log is
 *  about 700 bytes, so some 95,000 logs; the answer cap (rpc.ts RPC_ANSWER_MAX, 4 MiB) is reached long before.] */
export const POOL_LOGS_BYTES = 64 * 1024 * 1024;
/** The store's folder under HELPER_STORE_DIR. */
export const POOL_LOGS_DIR = "rpc-pool-logs";
const HASH = /^0x[0-9a-f]{64}$/;
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]{0,15})$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

/** One log kept: its block, its index, its topics (lowercase) and its JSON text as the provider wrote it, re-serialized. */
export type PoolLog = { block: bigint; index: bigint; topics: readonly string[]; text: string };
export type PoolStore = { pool: string; from: bigint; covered: bigint; logs: PoolLog[]; bytes: number };

export const emptyStore = (pool: string, from: bigint): PoolStore => ({ pool, from, covered: from - 1n, logs: [], bytes: 0 });

const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** A provider's log, checked: the pool's (its address, any case), a block number in `a`..`b`, an index, at most four
 *  topics of 32 bytes, not removed; else null. */
export function poolLog(x: unknown, pool: string, a: bigint, b: bigint): PoolLog | null {
  if (!plain(x) || typeof x.address !== "string" || x.address.toLowerCase() !== pool) return null;
  if (typeof x.blockNumber !== "string" || typeof x.logIndex !== "string") return null;
  const bn = x.blockNumber.toLowerCase();
  const li = x.logIndex.toLowerCase();
  if (!QUANTITY.test(bn) || !QUANTITY.test(li) || x.removed === true) return null;
  if (!Array.isArray(x.topics) || x.topics.length > 4 || !x.topics.every((t) => typeof t === "string" && HASH.test(t.toLowerCase()))) return null;
  const block = BigInt(bn);
  if (block < a || block > b) return null;
  return { block, index: BigInt(li), topics: (x.topics as string[]).map((t) => t.toLowerCase()), text: JSON.stringify(x) };
}

/** A page's result list, checked whole (poolLog each, block and index strictly rising): its logs, or null. */
export function poolPage(result: unknown, pool: string, a: bigint, b: bigint): PoolLog[] | null {
  if (!Array.isArray(result)) return null;
  const out: PoolLog[] = [];
  for (const x of result) {
    const l = poolLog(x, pool, a, b);
    if (l === null) return null;
    const p = out.at(-1);
    if (p !== undefined && (l.block < p.block || (l.block === p.block && l.index <= p.index))) return null;
    out.push(l);
  }
  return out;
}

/** A caller's topics filter the store answers: absent, or at most four positions each null, a 32-byte topic or a list
 *  of at most 16 of them; anything else null (the route answers it as before). Lowercase. */
export function topicsOf(t: unknown): (string[] | null)[] | null {
  if (t === undefined) return [];
  if (!Array.isArray(t) || t.length > 4) return null;
  const out: (string[] | null)[] = [];
  for (const p of t) {
    if (p === null) out.push(null);
    else if (typeof p === "string" && HASH.test(p.toLowerCase())) out.push([p.toLowerCase()]);
    else if (Array.isArray(p) && p.length <= 16 && p.every((s) => typeof s === "string" && HASH.test(s.toLowerCase()))) out.push(p.length === 0 ? null : p.map((s: string) => s.toLowerCase()));
    else return null;
  }
  return out;
}

/** Whether a log's topics match a filter as a node matches them (go-ethereum's filter: a position past the log's topics
 *  never matches; null or an empty list any topic; a list any of its topics). */
export const topicsMatch = (log: readonly string[], f: readonly (string[] | null)[]): boolean => f.length <= log.length && f.every((p, i) => p === null || p.includes(log[i]!));

/** The store's logs of blocks `from`..`to` matching `topics`, as JSON texts in order. */
export function storeLogs(s: PoolStore, from: bigint, to: bigint, topics: readonly (string[] | null)[]): string[] {
  // the first log at or past `from`, by binary search (the logs rise)
  let lo = 0;
  let hi = s.logs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (s.logs[m]!.block < from) lo = m + 1;
    else hi = m;
  }
  const out: string[] = [];
  for (let i = lo; i < s.logs.length && s.logs[i]!.block <= to; i++) if (topicsMatch(s.logs[i]!.topics, topics)) out.push(s.logs[i]!.text);
  return out;
}

/** A page's logs appended: its blocks must start right past what is covered. False (nothing kept) past the bound. */
export function storeAppend(s: PoolStore, a: bigint, b: bigint, logs: readonly PoolLog[]): boolean {
  if (a !== s.covered + 1n || b < a) return false;
  const bytes = logs.reduce((n, l) => n + Buffer.byteLength(l.text), 0);
  if (s.bytes + bytes > POOL_LOGS_BYTES) return false;
  s.logs.push(...logs);
  s.bytes += bytes;
  s.covered = b;
  return true;
}

/** The store's file for `chain` under `dir` (HELPER_STORE_DIR), or none when the helper has no store (memory only). */
export function poolFile(dir: string, chain: string): { read(pool: string, from: bigint): PoolStore | null; write(s: PoolStore): void } | undefined {
  if (dir === "") return undefined;
  const d = join(dir, POOL_LOGS_DIR);
  const f = join(d, `${chain}.json`);
  return {
    /** The file's store when it is this pool's from this deploy block and every log in it passes poolPage over what it
     *  covers; else null (a file of another pool, past the bound, that does not parse or holds a log out of place). */
    read(pool, from) {
      try {
        if (statSync(f).size > POOL_LOGS_BYTES * 2) return null;
        const j = JSON.parse(readFileSync(f, "utf8")) as unknown;
        if (!plain(j) || j.v !== 1 || j.pool !== pool || j.from !== `0x${from.toString(16)}` || typeof j.covered !== "string" || !QUANTITY.test(j.covered)) return null;
        if (!ADDRESS.test(pool)) return null;
        const covered = BigInt(j.covered);
        if (covered < from - 1n) return null;
        const logs = poolPage(j.logs, pool, from, covered);
        if (logs === null) return null;
        const s = emptyStore(pool, from);
        return storeAppend(s, from, covered, logs) || covered === from - 1n ? s : null;
      } catch {
        return null;
      }
    },
    /** The store written whole: a temp file, fsync, one rename. */
    write(s) {
      mkdirSync(d, { recursive: true, mode: 0o700 });
      const tmp = join(d, `.tmp-${chain}-${process.pid}`);
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, `{"v":1,"pool":${JSON.stringify(s.pool)},"from":"0x${s.from.toString(16)}","covered":"0x${s.covered.toString(16)}","logs":[${s.logs.map((l) => l.text).join(",")}]}`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, f);
    },
  };
}
