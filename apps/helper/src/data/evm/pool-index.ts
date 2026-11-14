// Every pool of an EVM chain's Uniswap v4 PoolManager, from its first block (card evm-pool-index-from-the-first-pool).
//
// The device scans the PoolManager's Initialize logs only so far back (Base 1M blocks, Robinhood 10M), so a token whose
// only pool is older was never a candidate: NOVAAI's native pool on Robinhood was made at block 40,138,722, the scan's
// floor at 103,963,019 (2026-11-14). This keeps every Initialize log from the PoolManager's first block on disk and
// answers a currency's pools (GET /v1/market/pools), which the device adds to its own scan, each key hashed to its id
// and read on its two providers before it counts (kit checks/evm/quote.ts evmPoolServedUse). The helper can leave a pool
// out, which only lowers the device's reference; it cannot add one the chain does not hold.
//
// Sizes (read 2026-11-14 07:04-08:10Z): Robinhood's PoolManager logged its first Initialize at block 9,505 and 5,013 pools
// in blocks 0-5M (rpc.mainnet.chain.robinhood.com); Base's logged 354, 651, 510 and 321 pools in 500 blocks at blocks 34M,
// 37M, 40M and 45M (base.api.pocket.network), about one a block through 2025: millions in all. So the index is a SQLite
// file on the helper's store volume, never memory: per pool its id, currencies, fee, tick spacing, hooks and block, as
// bytes, indexed on each currency.
//
// The backfill reads ascending from the first block, one span a request with that span's last block in the same batch
// (a provider that does not hold that block answers no span), and writes each span's pools and the next block in one
// transaction: a restart goes on from the last span written, never from the first block. A span answered with an error
// or at the log cap is asked as its halves. Each request is a background read on the helper's provider holds (limits.ts
// take, background: it leaves CALLER_ROOM of each provider's burst to callers and waits behind any caller's read), so
// a user's read never waits on it. It stays `margin` blocks behind the head; until it reaches that, every answer says
// `complete: false`, which the device treats as no answer.
import { DatabaseSync } from "node:sqlite";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { ProviderHolds } from "../../limits/limits.ts";

/** Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing,
 *  address hooks, uint160 sqrtPriceX96, int24 tick). */
export const INITIALIZE = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
/** A span answered with this many logs or more may be one its provider cut (Robinhood's: "logs matched by query exceeds
 *  limit of 10000"), so it is asked as its halves. */
export const POOL_INDEX_SPAN_LOGS = 10_000;
/** The most pools one answer names: one past the kit's EVM_SERVED_MAX, so a currency with more is refused whole there,
 *  never cut here. */
export const POOL_INDEX_ANSWER_MAX = 4097;
/** The longest a backfill request waits for its provider before it is asked of the next. */
const WAIT_MAX_MS = 10_000;
const BACKOFF_MS = 1_000;
/** The share of a provider's daily budget (limits.ts Pace day: a keyed plan's) the backfill may spend in a UTC day.
 *  [design: a tenth: the day is the users' and the senders'; the backfill finishes over more days where it must.] */
export const BACKFILL_DAY_SHARE = 0.1;
/** The least time between two backfill posts to a provider the helper has no pace for. [design: 1 s, under every
 *  public endpoint's measured limit; such a provider is a spare here.] */
export const BACKFILL_GAP_MS = 1_000;
const DAY_MS = 86_400_000;
/** A provider's hold after a 429 that names no Retry-After. */
const BACKFILL_HOLD_S = 10;
/** The largest answer the backfill reads (a span's logs at the cap are about 10,000 x 1 KB). */
export const POOL_INDEX_ANSWER_BYTES = 32 * 1024 * 1024;

export type PoolKey = { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
export type ServedPool = { id: string; key: PoolKey };
export type PoolsAnswer = { chainId: number; poolManager: string; complete: boolean; through: number; pools: ServedPool[] };

export type PoolIndexConfig = {
  chain: "base" | "robinhood";
  chainId: number;
  poolManager: string;
  /** The PoolManager's first block (or any block at or before its first Initialize). */
  first: number;
  /** Blocks a request starts at, on each provider; halved for a span its provider refuses or cuts. */
  span: number;
  /** Blocks the backfill stays behind the head (the device scans the newest blocks itself). */
  margin: number;
  /** The providers, in order: the first that answers a span gives it. */
  urls: readonly string[];
};
export type PoolIndexDeps = {
  /** One JSON-RPC batch to `url`, its answers in order; throws on a transport error or a 429 (with `afterS`). */
  post(url: string, calls: { method: string; params: unknown[] }[]): Promise<unknown[]>;
  /** The helper's one hold and pace per provider, which every path draws on (server.ts providerHolds). */
  holds: Pick<ProviderHolds, "heldMs" | "hold" | "take" | "paceOf">;
  sleep(ms: number): Promise<void>;
  /** The holds' clock (epoch ms). */
  now(): number;
};

const hexOf = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
const bytesOf = (h: string) => Buffer.from(h.slice(2), "hex");
const isWord = (x: unknown): x is string => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
const isQty = (x: unknown): x is string => typeof x === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(x);
const word = (n: bigint) => BigInt.asUintN(256, n).toString(16).padStart(64, "0");
const addrOf = (w: string) => "0x" + w.slice(-40).toLowerCase();
/** v4's PoolId: keccak256(abi.encode(PoolKey)). */
export const poolIdOf = (k: PoolKey): string =>
  hexOf(keccak_256(Buffer.from(word(BigInt(k.currency0)) + word(BigInt(k.currency1)) + word(BigInt(k.fee)) + word(BigInt.asUintN(256, BigInt(k.tickSpacing))) + word(BigInt(k.hooks)), "hex")));

/** `log` as a pool of the PoolManager `pm` made in blocks a to b: null where it is not one (another address or topic,
 *  outside the span, removed, malformed) or its key does not hash to its id word. */
export function poolOfLog(log: unknown, pm: string, a: number, b: number): (ServedPool & { block: number }) | null {
  if (typeof log !== "object" || log === null) return null;
  const l = log as { address?: unknown; topics?: unknown; data?: unknown; blockNumber?: unknown; removed?: unknown };
  if (l.removed === true || typeof l.address !== "string" || l.address.toLowerCase() !== pm || !Array.isArray(l.topics) || l.topics.length !== 4) return null;
  const [t0, id, c0, c1] = l.topics as unknown[];
  if (typeof t0 !== "string" || t0.toLowerCase() !== INITIALIZE || !isWord(id) || !isWord(c0) || !isWord(c1) || !isQty(l.blockNumber)) return null;
  const block = Number(l.blockNumber);
  if (block < a || block > b || typeof l.data !== "string" || !/^0x[0-9a-fA-F]{320}$/.test(l.data)) return null;
  const d = l.data.slice(2);
  const fee = Number(BigInt("0x" + d.slice(0, 64)));
  const tickSpacing = Number(BigInt.asIntN(256, BigInt("0x" + d.slice(64, 128))));
  if (fee > 0xffffff || tickSpacing < 1 || tickSpacing > 32767 || /[^0]/.test(c0.slice(2, 26) + c1.slice(2, 26) + d.slice(128, 152))) return null;
  const key: PoolKey = { currency0: addrOf(c0), currency1: addrOf(c1), fee, tickSpacing, hooks: addrOf(d.slice(128, 192)) };
  if (BigInt(key.currency0) >= BigInt(key.currency1)) return null;
  const ids = poolIdOf(key);
  return ids === id.toLowerCase() ? { id: ids, key, block } : null;
}

export function createPoolIndex(file: string, c: PoolIndexConfig, d: PoolIndexDeps) {
  const pm = c.poolManager.toLowerCase();
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS pools (id BLOB PRIMARY KEY, c0 BLOB NOT NULL, c1 BLOB NOT NULL, fee INTEGER NOT NULL, ts INTEGER NOT NULL, hooks BLOB NOT NULL, block INTEGER NOT NULL) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS pools_c0 ON pools (c0);
    CREATE INDEX IF NOT EXISTS pools_c1 ON pools (c1);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;`);
  const get = db.prepare("SELECT v FROM meta WHERE k = ?");
  const set = db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v");
  const put = db.prepare("INSERT OR IGNORE INTO pools (id, c0, c1, fee, ts, hooks, block) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const of = db.prepare(`SELECT id, c0, c1, fee, ts, hooks FROM pools WHERE c0 = ? UNION SELECT id, c0, c1, fee, ts, hooks FROM pools WHERE c1 = ? LIMIT ${POOL_INDEX_ANSWER_MAX}`);
  // a file of another chain or PoolManager is refused, never mixed
  const same = (k: string, v: string) => {
    const was = (get.get(k) as { v: string } | undefined)?.v;
    if (was === undefined) set.run(k, v);
    else if (was !== v) throw new Error(`pool index ${file}: its ${k} is ${was}, not ${v}`);
  };
  same("chainId", String(c.chainId));
  same("poolManager", pm);
  const metaNum = (k: string, fallback: number) => Number((get.get(k) as { v: string } | undefined)?.v ?? fallback);
  /** The next block the backfill reads; every block before it is in the file. */
  let next = metaNum("next", c.first);
  /** The last head a provider named. */
  let head = metaNum("head", -1);
  const spans = new Map<string, number>(c.urls.map((u) => [u, c.span]));
  /** Per provider: the largest span it may still answer (one less than the least it refused with an error). */
  const limits = new Map<string, number>();
  const CALLS = 3;
  /** Per provider with no pace of ours: when the backfill last posted to it. */
  const lastPost = new Map<string, number>();
  /** A background draw of `calls` on `url`: the ms to wait first, 0 to go (and drawn). Below the users' reads on every
   *  provider: a held provider waits; a paced one is drawn as a background read (limits.ts take: it leaves CALLER_ROOM of
   *  its burst to callers and waits behind any caller's wait); a daily budget only to BACKFILL_DAY_SHARE of it, the
   *  backfill's spend kept in the file so a restart does not spend the share again; one with no pace once a
   *  BACKFILL_GAP_MS. */
  const draw = (url: string, calls: number): number => {
    const t = d.now();
    const held = d.holds.heldMs(url);
    if (held > 0) return held;
    const p = d.holds.paceOf(url);
    if (p === undefined) {
      const w = (lastPost.get(url) ?? -Infinity) + BACKFILL_GAP_MS - t;
      if (w > 0) return Math.ceil(w);
      lastPost.set(url, t);
      return 0;
    }
    const day = Math.floor(t / DAY_MS);
    const k = `day:${p.group ?? url}`;
    const was = /^(\d+):(\d+)$/.exec((get.get(k) as { v: string } | undefined)?.v ?? "");
    const used = was !== null && Number(was[1]) === day ? Number(was[2]) : 0;
    const need = calls * (p.cost ?? 1);
    if (p.day !== undefined && used + need > p.day * BACKFILL_DAY_SHARE) return (day + 1) * DAY_MS - t;
    const w = d.holds.take(url, calls, true);
    if (w === 0 && p.day !== undefined) set.run(k, `${day}:${used + need}`);
    return w;
  };

  /** Writes a span's pools and the block after it, in one transaction. */
  const keep = (pools: (ServedPool & { block: number })[], to: number) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const p of pools) put.run(bytesOf(p.id), bytesOf(p.key.currency0), bytesOf(p.key.currency1), p.key.fee, p.key.tickSpacing, bytesOf(p.key.hooks), p.block);
      set.run("next", String(to + 1));
      set.run("head", String(head));
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    next = to + 1;
  };

  /** One span from `next` on `url`: the blocks it proved (0 where it gave none). */
  async function spanOn(url: string): Promise<number> {
    const wait = draw(url, CALLS);
    if (wait > 0) {
      if (wait > WAIT_MAX_MS) return 0;
      await d.sleep(wait);
      if (draw(url, CALLS) > 0) return 0;
    }
    const want = spans.get(url) ?? c.span;
    const a = next;
    // the span: `want` blocks, none past the margin behind the last head named (the first request learns the head)
    const b = Math.max(a, Math.min(a + want - 1, head < 0 ? a + want - 1 : head - c.margin));
    let answers: unknown[];
    try {
      answers = await d.post(url, [
        { method: "eth_blockNumber", params: [] },
        { method: "eth_getLogs", params: [{ address: pm, topics: [INITIALIZE], fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16) }] },
        { method: "eth_getBlockByNumber", params: ["0x" + b.toString(16), false] },
      ]);
    } catch (e) {
      const s = (e as { afterS?: unknown } | null)?.afterS;
      if (typeof s === "number") d.holds.hold(url, Math.max(1, s));
      return 0;
    }
    const r = (i: number) => (answers[i] as { result?: unknown; error?: unknown } | undefined) ?? {};
    const h = r(0).result;
    if (isQty(h)) head = Math.max(head, Number(h));
    // past the margin: nothing to read yet (the head read again on the next step)
    if (head >= 0 && a > head - c.margin) return 0;
    if (b > head - c.margin) return 0;
    const logs = r(1).result;
    const blk = r(2).result as { number?: unknown } | null | undefined;
    if (r(1).error !== undefined || !Array.isArray(logs) || logs.length >= POOL_INDEX_SPAN_LOGS) {
      // a refused or cut span: its halves next time on this provider; one it refused never grows back to that size
      if (r(1).error !== undefined) limits.set(url, Math.min(limits.get(url) ?? Infinity, b - a));
      if (b > a) spans.set(url, Math.max(1, Math.floor((b - a + 1) / 2)));
      return 0;
    }
    // the span's last block from the same batch: a provider that does not hold it answers no span
    if (typeof blk !== "object" || blk === null || !isQty(blk.number) || Number(blk.number) !== b) return 0;
    const pools = logs.map((l) => poolOfLog(l, pm, a, b)).filter((p) => p !== null);
    keep(pools, b);
    // a span answered whole: grow back toward the starting span
    if (want < c.span) spans.set(url, Math.max(1, Math.min(c.span, want * 2, limits.get(url) ?? Infinity)));
    return b - a + 1;
  }

  return {
    /** One span on the first provider that gives it: the blocks proved, 0 where none did. */
    async step(): Promise<number> {
      for (const url of c.urls) {
        const n = await spanOn(url);
        if (n > 0) return n;
      }
      return 0;
    },
    /** Steps until `stop` (or, `untilComplete`, until the backfill reaches its head's margin); at the head, and where no
     *  provider gave a span, waits before the next. */
    async run(stop: { stopped: boolean }, untilComplete = false): Promise<void> {
      while (!stop.stopped && !(untilComplete && this.complete())) {
        const n = await this.step().catch(() => 0);
        if (n === 0) await d.sleep(BACKOFF_MS);
      }
    },
    /** Whether every block from the first to within one span of `margin` behind the last head named is in the file: the
     *  blocks after it are inside the device's own scan (margin + span is far under its depth, Base 1M, Robinhood 10M). */
    complete: (): boolean => head >= 0 && next > head - c.margin - c.span,
    /** The pools of `token` (lowercase address) in the file. */
    pools(token: string): PoolsAnswer {
      const t = bytesOf(token);
      const rows = of.all(t, t) as { id: Uint8Array; c0: Uint8Array; c1: Uint8Array; fee: number; ts: number; hooks: Uint8Array }[];
      return {
        chainId: c.chainId,
        poolManager: pm,
        complete: this.complete(),
        through: next - 1,
        pools: rows.map((x) => ({ id: hexOf(x.id), key: { currency0: hexOf(x.c0), currency1: hexOf(x.c1), fee: x.fee, tickSpacing: x.ts, hooks: hexOf(x.hooks) } })),
      };
    },
    state: () => ({ next, head }),
    close: () => db.close(),
  };
}
export type PoolIndex = ReturnType<typeof createPoolIndex>;

/** One JSON-RPC batch over HTTP POST: each answer at its call's place (by id); a 429, or an answer whose error names a
 *  rate limit, throws with `afterS` (its Retry-After, else BACKFILL_HOLD_S); any other transport failure throws. The
 *  URL is never in an error (a keyed one holds its key). */
export function jsonRpcPost(fetchFn: typeof fetch = fetch, timeoutMs = 20_000) {
  return async (url: string, calls: { method: string; params: unknown[] }[]): Promise<unknown[]> => {
    const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(calls.map((x, id) => ({ jsonrpc: "2.0", id, ...x }))), signal: AbortSignal.timeout(timeoutMs) });
    const after = Number(r.headers.get("retry-after"));
    const limited = (): never => {
      throw Object.assign(new Error("rate limited"), { afterS: Number.isFinite(after) && after > 0 ? Math.min(after, 600) : BACKFILL_HOLD_S });
    };
    if (r.status === 429) limited();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (text.length > POOL_INDEX_ANSWER_BYTES) throw new Error("answer too large");
    const j = JSON.parse(text) as unknown;
    const all = Array.isArray(j) ? j : [j];
    const out = calls.map((_, i) => all.find((x) => (x as { id?: unknown } | null)?.id === i) ?? {});
    if (out.some((x) => /rate.?limit|too many requests/i.test(String((x as { error?: { message?: unknown } }).error?.message ?? "")))) limited();
    return out;
  };
}
