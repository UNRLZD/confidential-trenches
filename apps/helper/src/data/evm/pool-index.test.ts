// card evm-pool-index-from-the-first-pool: the helper's index of every PoolManager pool from its first block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKFILL_DAY_SHARE, createPoolIndex, WRITE_PRAGMAS, INITIALIZE, poolIdOf, POOL_INDEX_SPAN_LOGS, type PoolKey, type PoolIndexConfig } from "./pool-index.ts";
import { CALLER_ROOM, providerHolds, type Pace } from "../../limits/limits.ts";
import { turnSlicer } from "../../limits/turn.ts";
import { call, listening } from "../../../test/servers.ts";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { checkpointAside } from "../../store/checkpoint.ts";
import { writerAside } from "../../store/writer.ts";

/** A still clock: a caller's share and a provider's budget are fixed windows on the helper's clock (limits.ts
 *  clientWindow, upstreamBudget; card helper-share-tests-on-a-still-clock), so on the machine's clock a window's turn
 *  inside a test clears the share its counts and 429s assert (PR 979's merge queue run 44243609488). */
const STILL = (): number => 1_800_000_000_000;
const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const URL_A = "https://a.example";
const URL_B = "https://b.example";
const W = (n: bigint) => BigInt.asUintN(256, n).toString(16).padStart(64, "0");
const tok = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const keyOf = (a: string, b: string, fee = 3000, ts = 60, hooks = tok(0)): PoolKey => (BigInt(a) < BigInt(b) ? { currency0: a, currency1: b, fee, tickSpacing: ts, hooks } : { currency0: b, currency1: a, fee, tickSpacing: ts, hooks });
const logOf = (k: PoolKey, block: number, id = poolIdOf(k)) => ({
  address: PM,
  blockNumber: "0x" + block.toString(16),
  topics: [INITIALIZE, id, "0x" + W(BigInt(k.currency0)), "0x" + W(BigInt(k.currency1))],
  data: "0x" + W(BigInt(k.fee)) + W(BigInt(k.tickSpacing)) + W(BigInt(k.hooks)) + W(1n << 96n) + W(0n),
});

/** A chain at `head` whose PoolManager logged `logs`; `cap`: the most blocks a getLogs spans (more: an error). */
function chain(head: () => number, logs: ReturnType<typeof logOf>[], asked: [string, number, number][] = [], cap = Infinity) {
  return async (url: string, calls: { method: string; params: unknown[] }[]): Promise<unknown[]> =>
    calls.map((c, id) => {
      if (c.method === "eth_blockNumber") return { id, result: "0x" + head().toString(16) };
      if (c.method === "eth_getBlockByNumber") {
        const n = Number(c.params[0]);
        return { id, result: n <= head() ? { number: "0x" + n.toString(16) } : null };
      }
      const f = c.params[0] as { fromBlock: string; toBlock: string };
      const [a, b] = [Number(f.fromBlock), Number(f.toBlock)];
      asked.push([url, a, b]);
      if (b - a + 1 > cap) return { id, error: { code: -32602, message: "block range too large" } };
      return { id, result: logs.filter((l) => Number(l.blockNumber) >= a && Number(l.blockNumber) <= b) };
    });
}
const cfg = (o: Partial<PoolIndexConfig> = {}): PoolIndexConfig => ({ chain: "robinhood", chainId: 4663, poolManager: PM, first: 0, span: 1_000, margin: 10, urls: [URL_A], ...o });
const dir = () => mkdtempSync(join(tmpdir(), "pool-index-"));
const holdsNone = { heldMs: () => 0, hold: () => {}, take: () => 0, paceOf: () => undefined as Pace | undefined };
let clock = 1_000_000;
const deps = (post: ReturnType<typeof chain>, holds: typeof holdsNone = holdsNone) => ({ post, holds, sleep: async (ms: number) => void (clock += ms), now: () => clock });
/** Steps until a step reads nothing more (the head's margin reached). */
const until = async (ix: ReturnType<typeof createPoolIndex>, max = 1_000) => {
  for (let i = 0; i < max; i++) if ((await ix.step()) === 0 && ix.complete()) return;
};

test("the backfill reads every pool from the first block to the head's margin; a currency's pools are answered, complete only once it is there", async () => {
  const d = dir();
  try {
    const t = tok(0xabc);
    const ks = [keyOf(tok(0), t), keyOf(t, tok(0x5fc5), 0x800000, 200, tok(0x4e34)), keyOf(tok(1), tok(2))];
    const logs = [logOf(ks[0]!, 9_505), logOf(ks[1]!, 4_100), logOf(ks[2]!, 9_990)];
    const ix = createPoolIndex(join(d, "rh.sqlite"), cfg(), deps(chain(() => 10_000, logs)));
    assert.equal(ix.pools(t).complete, false, "nothing read yet: partial");
    await ix.step();
    const mid = ix.pools(t);
    assert.equal(mid.complete, false);
    assert.equal(mid.through, 999);
    await until(ix);
    const a = ix.pools(t);
    assert.equal(a.complete, true);
    assert.equal(a.chainId, 4663);
    assert.equal(a.poolManager, PM);
    assert.equal(a.through, 9_990);
    assert.deepEqual(new Set(a.pools.map((p) => p.id)), new Set([poolIdOf(ks[0]!), poolIdOf(ks[1]!)]));
    assert.deepEqual(a.pools.find((p) => p.id === poolIdOf(ks[1]!))?.key, ks[1]);
    ix.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("planted: a restart goes on from the last span written, never from the first block", async () => {
  const d = dir();
  try {
    const t = tok(0xabc);
    const asked: [string, number, number][] = [];
    const logs = [logOf(keyOf(tok(0), t), 500), logOf(keyOf(tok(1), t), 7_500)];
    const file = join(d, "rh.sqlite");
    const one = createPoolIndex(file, cfg(), deps(chain(() => 10_000, logs, asked)));
    for (let i = 0; i < 5; i++) await one.step();
    assert.equal(one.state().next, 5_000);
    // killed here: the process ends with nothing more written
    one.close();
    asked.length = 0;
    const two = createPoolIndex(file, cfg(), deps(chain(() => 10_000, logs, asked)));
    assert.equal(two.state().next, 5_000);
    await until(two);
    assert.equal(Math.min(...asked.map((x) => x[1])), 5_000, "the restart's first span starts where the last one written ended");
    assert.equal(two.pools(t).pools.length, 2, "the pool written before the restart is still there");
    two.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("planted: a log whose key does not hash to its id, of another address, or outside its span is never kept", async () => {
  const d = dir();
  try {
    const t = tok(0xabc);
    const good = keyOf(tok(0), t);
    // a forged Initialize whose topic id is a real pool's (logged first, so a kept forgery would hold that id), and one
    // whose topic id is no pool's: neither key hashes to its id, so neither is kept under any id
    const forged = { ...logOf(keyOf(tok(7), t), 200), topics: [INITIALIZE, poolIdOf(good), "0x" + W(BigInt(tok(7))), "0x" + W(BigInt(t))] };
    const loose = logOf(keyOf(tok(9), t), 250, "0x" + "ab".repeat(32));
    const other = { ...logOf(keyOf(tok(8), t), 300), address: "0x0000000000000000000000000000000000000001" };
    const ix = createPoolIndex(join(d, "rh.sqlite"), cfg(), deps(chain(() => 2_000, [forged, loose, other, logOf(good, 400)])));
    await until(ix);
    const served = ix.pools(t).pools;
    assert.deepEqual(served, [{ id: poolIdOf(good), key: good }]);
    for (const p of served) assert.equal(poolIdOf(p.key), p.id);
    ix.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("planted: a span its provider refuses or cuts at the log cap is asked as its halves; one provider short of the span's last block gives none, the next does", async () => {
  const d = dir();
  try {
    const t = tok(0xabc);
    const asked: [string, number, number][] = [];
    const ix = createPoolIndex(join(d, "rh.sqlite"), cfg({ span: 1_000 }), deps(chain(() => 5_000, [logOf(keyOf(tok(0), t), 3_000)], asked, 250)));
    await until(ix);
    assert.equal(ix.pools(t).pools.length, 1);
    assert.ok(asked.every(([, a, b]) => b - a + 1 <= 1_000));
    assert.ok(asked.some(([, a, b]) => b - a + 1 === 250), "halved to the provider's cap");
    ix.close();
    // a provider whose logs reach the cap: halves
    const many = Array.from({ length: POOL_INDEX_SPAN_LOGS }, (_, i) => logOf(keyOf(tok(i + 10), t), 100 + (i % 50)));
    const d2 = join(d, "cap.sqlite");
    const asked2: [string, number, number][] = [];
    const ix2 = createPoolIndex(d2, cfg({ span: 1_000 }), deps(chain(() => 2_000, many, asked2)));
    await ix2.step();
    assert.equal(ix2.state().next, 0, "a span at the log cap is not kept");
    await ix2.step();
    assert.deepEqual(asked2.slice(-1)[0]!.slice(1), [0, 499]);
    ix2.close();
    // the first provider behind the span's last block: the span comes from the second
    const behind = chain(() => 5_000, []);
    const post = async (url: string, calls: { method: string; params: unknown[] }[]) => {
      const out = await behind(url, calls);
      return url === URL_A ? out.map((x, i) => (calls[i]!.method === "eth_getBlockByNumber" ? { id: i, result: null } : x)) : out;
    };
    const ix3 = createPoolIndex(join(d, "behind.sqlite"), cfg({ urls: [URL_A, URL_B] }), deps(post));
    assert.equal(await ix3.step(), 1_000);
    ix3.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("planted: a file of another chain or PoolManager is refused, never mixed", async () => {
  const d = dir();
  try {
    const file = join(d, "x.sqlite");
    createPoolIndex(file, cfg(), deps(chain(() => 100, []))).close();
    assert.throws(() => createPoolIndex(file, cfg({ chainId: 8453 }), deps(chain(() => 100, []))), /chainId/);
    assert.throws(() => createPoolIndex(file, cfg({ poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b" }), deps(chain(() => 100, []))), /poolManager/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("planted: users' reads come first: the backfill running flat out leaves every caller's read its room at once, yields to a caller's wait, and spends at most its share of a provider's day", async () => {
  const d = dir();
  try {
    let now = 5_000_000;
    const pace: Record<string, Pace> = { [URL_A]: { perS: 4, burst: 8, unit: "call" }, [URL_B]: { perS: 100, burst: 100, unit: "call", day: 3_000 } };
    const holds = providerHolds(() => now, pace);
    const read = chain(() => 50_000_000, []);
    const posts: number[] = [];
    const post: typeof read = (url, calls) => (posts.push(now), read(url, calls));
    const sleep = async (ms: number) => void (now += ms);
    const ix = createPoolIndex(join(d, "a.sqlite"), cfg({ urls: [URL_A] }), { post, holds, sleep, now: () => now });
    // the backfill alone: it draws down to CALLER_ROOM of the burst and no further
    for (let i = 0; i < 20; i++) await ix.step();
    const callerRoom = 8 * CALLER_ROOM;
    // a caller arriving now: its read of up to CALLER_ROOM goes at once, with the backfill running beside it
    for (let i = 0; i < 20; i++) {
      await ix.step();
      assert.equal(holds.take(URL_A, callerRoom, false), 0, `caller read ${i} waited behind the backfill`);
      now += Math.ceil((callerRoom * 1000) / 4);
    }
    // a caller that must wait for the refill holds it: the backfill draws nothing meanwhile
    holds.take(URL_A, 8, false);
    const w = holds.take(URL_A, 8, false);
    assert.ok(w > 0);
    const callerDone = now + w;
    await ix.step();
    assert.ok(posts.at(-1)! >= callerDone, "the backfill posts only once the caller's wait for the refill is over");
    ix.close();
    // a daily budget: the backfill spends at most BACKFILL_DAY_SHARE of it, across a restart too
    const file = join(d, "b.sqlite");
    const b1 = createPoolIndex(file, cfg({ urls: [URL_B] }), { post, holds, sleep: async (ms) => void (now += Math.min(ms, 1_000)), now: () => now });
    let spans = 0;
    for (let i = 0; i < 200; i++) spans += (await b1.step()) > 0 ? 1 : 0;
    b1.close();
    const b2 = createPoolIndex(file, cfg({ urls: [URL_B] }), { post, holds, sleep: async (ms) => void (now += Math.min(ms, 1_000)), now: () => now });
    for (let i = 0; i < 200; i++) spans += (await b2.step()) > 0 ? 1 : 0;
    b2.close();
    assert.equal(spans, Math.floor((3_000 * BACKFILL_DAY_SHARE) / 3), "the day's share in 3-call posts, the restart's included");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("the file's size per 100,000 pools, with both currency indexes (printed for the card's projection)", async () => {
  const d = dir();
  try {
    const n = 100_000;
    const logs = Array.from({ length: n }, (_, i) => logOf(keyOf(tok(i % 2 === 0 ? 0 : 0x4200), tok(0x10000 + i), 10_000, 200, tok(0x1000 + (i % 7))), i));
    const file = join(d, "size.sqlite");
    const ix = createPoolIndex(file, cfg({ span: 5_000, margin: 1 }), deps(chain(() => n + 10, logs)));
    await until(ix, 100);
    assert.equal(ix.pools(tok(0x10000 + 7)).pools.length, 1);
    ix.close();
    const bytes = statSync(file).size;
    console.log(`pool index: ${n} pools, ${bytes} bytes, ${(bytes / n).toFixed(1)} bytes a pool`);
    assert.ok(bytes / n < 400);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("GET /v1/market/pools: one chain the helper indexes and one token address, else 400 or 404; the answer is the index's, complete or not, and a chain whose index is off answers nothing read", async () => {
  const { createServer, request } = await import("node:http");
  const { handler } = await import("../../server.ts");
  const { createProxy } = await import("../../proxy/proxy.ts");
  const { createRpc } = await import("../../rpc/rpc.ts");
  const stub = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  const asked: string[] = [];
  const answer = (t: string) => ({ chainId: 4663, poolManager: PM, complete: false, through: 99, pools: [{ id: "0x" + "ab".repeat(32), key: keyOf(tok(0), t) }] });
  const ix = { pools: (t: string) => (asked.push(t), answer(t)) };
  const h = createServer(handler("0123456789abcdef0123456789abcdef01234567", createProxy({}, { fetch: stub }), createRpc({}, { now: STILL, fetch: stub }), undefined, undefined, undefined, undefined, undefined, undefined, null, new Map(), new Map(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { robinhood: ix }));
  await listening(h.listen(0, "127.0.0.1"), "the helper");
  const port = (h.address() as { port: number }).port;
  const get = async (path: string) => {
    const r = await call(port, { path }, "the helper");
    return { status: r.status, text: r.body };
  };
  try {
    const T = "0x00000000000000000000000000000000000ABCde";
    const ok = await get(`/v1/market/pools?chain=robinhood&token=${T}`);
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.text), answer(T.toLowerCase()));
    assert.deepEqual(asked, [T.toLowerCase()]);
    for (const bad of [`?chain=robinhood`, `?chain=robinhood&token=0x12`, `?chain=robinhood&token=${T}&token=${T}`, `?chain=robinhood&token=${T}&x=1`]) assert.equal((await get(`/v1/market/pools${bad}`)).status, 400, bad);
    // card market-data-matches-the-page: a chain the helper could index but keeps no index of (Base, POOL_INDEX_ON) is
    // answered as an index with nothing read, never 404 (live 16 Nov 20:2xZ: every Base token page's signing page logged
    // GET /v1/market/pools?chain=base 404 as a failed load); the kit adds no pool from an answer that is not complete
    const base = await get(`/v1/market/pools?chain=base&token=${T}`);
    assert.equal(base.status, 200);
    const { POOL_INDEX_CHAINS } = await import("../../server.ts");
    assert.deepEqual(JSON.parse(base.text), { chainId: 8453, poolManager: POOL_INDEX_CHAINS.base.poolManager, complete: false, through: POOL_INDEX_CHAINS.base.first - 1, pools: [] });
    assert.equal((await get(`/v1/market/pools?chain=solana&token=${T}`)).status, 404, "a chain no index is for");
    assert.equal((await get(`/v1/market/pools?chain=base&token=0x12`)).status, 400, "the same refusals before the answer");
    assert.equal(asked.length, 1, "a refused ask reads nothing");
  } finally {
    await new Promise((r) => h.close(r));
  }
});

test("the helper keeps Robinhood's index only by default: Base's is off until its volume is read for its room", async () => {
  const { poolIndexesFromEnv, POOL_INDEX_ON } = await import("../../server.ts");
  const d = dir();
  try {
    assert.deepEqual(POOL_INDEX_ON, ["robinhood"]);
    const ixs = poolIndexesFromEnv({}, d, holdsNone as never)!;
    assert.deepEqual(Object.keys(ixs), ["robinhood"]);
    ixs.robinhood!.close();
    assert.equal(poolIndexesFromEnv({}, "", holdsNone as never), null, "no store folder: no index");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("card helper-loop-never-held-by-a-write: a span at the log cap (9,999 pools) is checked a turn's slice at a time and written on the writer's thread (card pool-index-writer-off-the-main-thread), and lands whole: every pool, then the next block (red at e35007152: keep wrote the span in one turn, 300 to 376 ms in the copy's profile)", async () => {
  const d = dir();
  const logs = Array.from({ length: POOL_INDEX_SPAN_LOGS - 1 }, (_, i) => logOf(keyOf(tok(1), tok(i + 2)), i));
  // work counted a turn: a slicer on a counting clock (each log checked asks it once, one unit; the writes are the
  // writer thread's and ask it nothing),
  // and the most items asked between two turns, read by an immediate that sets itself again every turn
  let items = 0;
  let atTick = 0;
  let most = 0;
  let on = true;
  const tick = (): void => {
    most = Math.max(most, items - atTick);
    atTick = items;
    if (on) setImmediate(tick);
  };
  setImmediate(tick);
  const slicer = turnSlicer(() => items++, 20);
  const ix = createPoolIndex(join(d, "p.sqlite"), cfg({ span: POOL_INDEX_SPAN_LOGS }), { ...deps(chain(() => 50_000, logs)), pass: () => slicer.pass() });
  // a caller's read of the index while the span is written answers at once, from what has landed (never a later block)
  let mid: number | null = null;
  const reader = setTimeout(() => void (mid = ix.pools(tok(2)).through), 1);
  const n = await ix.step();
  on = false;
  clearTimeout(reader);
  assert.equal(n, POOL_INDEX_SPAN_LOGS);
  assert.ok(items >= POOL_INDEX_SPAN_LOGS - 1, `every log asked the slicer: ${items} items`);
  assert.ok(most <= 2 * 22, `${most} items in one turn`);
  for (const i of [0, 4_999, POOL_INDEX_SPAN_LOGS - 2]) assert.equal(ix.pools(tok(i + 2)).pools.length, 1, `pool ${i}`);
  assert.equal(ix.pools(tok(1)).through, POOL_INDEX_SPAN_LOGS - 1, "the next block moves only once every pool of the span is in the file");
  if (mid !== null) assert.equal(mid, -1, "mid-span the index still says it holds no block of it");
  ix.close();
  rmSync(d, { recursive: true });
});

test("card pool-index-writer-off-the-main-thread: a span is written by the writer's thread: no BEGIN, COMMIT or INSERT runs on the loop's thread while it lands (red at daa00c5c9: keep's transactions ran on the loop, single commits 100 to 601 ms in a 300k-pool bench)", async (t) => {
  const d = dir();
  const logs = Array.from({ length: 500 }, (_, i) => logOf(keyOf(tok(1), tok(i + 2)), i));
  const ix = createPoolIndex(join(d, "p.sqlite"), cfg({ span: 500 }), deps(chain(() => 50_000, logs)));
  // from here on: every statement run and every exec on this thread's connections
  const seen: string[] = [];
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, q: string) {
    seen.push(q);
    return exec.call(this, q);
  });
  const run = StatementSync.prototype.run;
  t.mock.method(StatementSync.prototype, "run", function (this: StatementSync, ...a: Parameters<StatementSync["run"]>) {
    seen.push(this.sourceSQL);
    return run.apply(this, a);
  });
  try {
    assert.equal(await ix.step(), 500);
    assert.deepEqual(seen.filter((q) => /^\s*(BEGIN|COMMIT|INSERT|UPDATE|DELETE)/i.test(q)), [], "no write on the loop's thread");
    assert.equal(ix.pools(tok(1)).through, 499, "the span landed, read on this thread's connection");
    assert.equal(ix.pools(tok(250)).pools.length, 1);
  } finally {
    t.mock.restoreAll();
    ix.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test("card pool-index-writer-off-the-main-thread: a writer stalled 500 ms (another connection holds the file's write lock) never holds the loop: the loop turns all the while, inside helper-loop-never-held-by-a-write's bound, and the span lands once the lock is let go (red at daa00c5c9: the write is the loop's, and its BEGIN refused the held lock, the span lost)", async () => {
  const d = dir();
  const file = join(d, "p.sqlite");
  const logs = Array.from({ length: 2_000 }, (_, i) => logOf(keyOf(tok(1), tok(i + 2)), i));
  // work counted a turn, as helper-loop-never-held-by-a-write does: a slicer on a counting clock, and the most items
  // asked between two turns, read by an immediate that sets itself again every turn (which also counts the turns)
  let items = 0;
  let atTick = 0;
  let most = 0;
  let turns = 0;
  let on = true;
  const tick = (): void => {
    turns++;
    most = Math.max(most, items - atTick);
    atTick = items;
    if (on) setImmediate(tick);
  };
  const slicer = turnSlicer(() => items++, 20);
  // the turns the loop takes between the span's transaction posted to the writer and its commit
  let during = -1;
  const writer: typeof writerAside = (f, p, st) => {
    const w = writerAside(f, p, st);
    return {
      ...w,
      tx: (ops) => {
        const at = turns;
        return w.tx(ops).then(() => void (ops.length > 2 && (during = turns - at)));
      },
    };
  };
  const ix = createPoolIndex(file, cfg({ span: 2_000 }), { ...deps(chain(() => 50_000, logs)), pass: () => slicer.pass(), writer });
  // the stall: another connection takes the write lock and lets it go 500 ms on, by a timer of the loop
  const blocker = new DatabaseSync(file);
  blocker.exec("BEGIN IMMEDIATE");
  let held = true;
  const letGo = setTimeout(() => {
    blocker.exec("ROLLBACK");
    held = false;
  }, 500);
  try {
    setImmediate(tick);
    let landed = false;
    const stepping = ix.step().then((n) => void (landed = n === 2_000));
    while (held) await new Promise((r) => setImmediate(r));
    await stepping;
    on = false;
    assert.equal(landed, true, "the span landed once the lock was let go");
    assert.ok(during >= 10, `the loop turned ${during} times while the writer held the span`);
    assert.ok(most <= 2 * 22, `${most} items in one turn`);
    assert.equal(ix.pools(tok(1)).through, 1_999);
  } finally {
    on = false;
    clearTimeout(letGo);
    if (held) blocker.exec("ROLLBACK");
    blocker.close();
    ix.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test("card pool-index-writer-off-the-main-thread: the writer runs each transaction whole, in the order posted: one that fails rolls back every write in it and rejects, naming the file, and the next goes on; once closed it writes nothing", async () => {
  const d = dir();
  const file = join(d, "w.sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);");
    const w = writerAside(file, WRITE_PRAGMAS, ["INSERT INTO kv (k, v) VALUES (?, ?)", "UPDATE kv SET v = ? WHERE k = ?"]);
    const first = w.tx([[0, ["a", "1"]], [0, ["b", "2"]]]);
    // the second fails at its second write (a null into NOT NULL): its first write is rolled back with it
    const second = w.tx([[0, ["c", "3"]], [0, ["d", null]]]);
    const third = w.tx([[1, ["9", "a"]]]);
    await first;
    await assert.rejects(second, /write of .*w\.sqlite: .*NOT NULL/);
    await third;
    const rows = db.prepare("SELECT k, v FROM kv ORDER BY k").all() as { k: string; v: string }[];
    assert.deepEqual(rows.map((r) => `${r.k}=${r.v}`), ["a=9", "b=2"], "the failed transaction left nothing; the third ran after the first");
    w.close();
    await assert.rejects(w.tx([[0, ["e", "5"]]]), /closed/);
    assert.equal((db.prepare("SELECT count(*) AS n FROM kv").get() as { n: number }).n, 2);
  } finally {
    db.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test("card helper-loop-never-held-by-a-read: the index's file is WAL with synchronous NORMAL, so a slice's commit syncs nothing in a turn of the loop (red at c6711e2c3: synchronous FULL, every slice's commit an fsync, 637 and 757 ms holds in a copy's profile)", async (t) => {
  const d = dir();
  const sql: string[] = [];
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, q: string) {
    sql.push(q);
    return exec.call(this, q);
  });
  try {
    const ix = createPoolIndex(join(d, "rh.sqlite"), cfg(), deps(chain(() => 10_000, [])));
    const pragmas = sql.join("\n");
    assert.match(pragmas, /PRAGMA journal_mode = WAL;/);
    assert.match(pragmas, /PRAGMA synchronous = NORMAL;/);
    assert.doesNotMatch(pragmas, /synchronous = (FULL|EXTRA)/);
    assert.match(pragmas, /PRAGMA wal_autocheckpoint = 0;/, "no commit runs the log's checkpoint (its sync) in a turn of the loop");
    ix.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("card helper-loop-never-held-by-a-read: a file whose connection never checkpoints is checkpointed by its own thread (store/checkpoint.ts): the log's pages reach the file while the writer goes on, and a stop ends the thread", async () => {
  const d = dir();
  try {
    const file = join(d, "x.sqlite");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE p (id INTEGER PRIMARY KEY, v BLOB NOT NULL);");
    const put = db.prepare("INSERT INTO p (id, v) VALUES (?, ?)");
    db.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < 2_000; i++) put.run(i, Buffer.alloc(200, i % 256));
    db.exec("COMMIT");
    const small = statSync(file).size;
    assert.ok(statSync(file + "-wal").size > 400_000, "the rows are in the log, not yet in the file");
    let failed: Error | null = null;
    const aside = checkpointAside(file, (e) => void (failed = e), 10);
    // the thread's checkpoint is seen by the file's size, asked once a turn, for at most 2,000 turns of 5 ms
    for (let k = 0; k < 2_000 && statSync(file).size <= small; k++) await new Promise((r) => setTimeout(r, 5));
    aside.stop();
    assert.equal(failed, null);
    assert.ok(statSync(file).size > 400_000, `the log's pages reached the file: ${small} -> ${statSync(file).size} bytes`);
    assert.equal((db.prepare("SELECT count(*) AS n FROM p").get() as { n: number }).n, 2_000);
    db.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("card helper-loop-never-held-by-a-read: the checkpoint thread never makes a file: one not there is never created, and once stopped it never opens its file again (red at 179ee8d66: the thread opened its path when it started, after the suite's tests had removed it)", async () => {
  const d = dir();
  try {
    const none = join(d, "none.sqlite");
    let failed: Error | null = null;
    const a = checkpointAside(none, (e) => void (failed = e), 1);
    // 200 turns of 5 ms: rounds of the thread's 1 ms checkpoint
    for (let k = 0; k < 200; k++) await new Promise((r) => setTimeout(r, 5));
    a.stop();
    assert.equal(existsSync(none), false, "no file made where none was");
    const file = join(d, "x.sqlite");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE p (id INTEGER PRIMARY KEY);");
    const b = checkpointAside(file, (e) => void (failed = e), 1);
    b.stop();
    db.close();
    for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
    for (let k = 0; k < 200; k++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual([file, `${file}-wal`, `${file}-shm`].filter((f) => existsSync(f)), [], "a stopped thread opens nothing again");
    assert.equal(failed, null);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("card helper-loop-never-held-by-a-read: a checkpoint that fails is told to the owner: the thread's file will not open (a directory where it was), `failed` runs once, and the pool index turns its own connection's checkpoint back on, so its log never grows unchecked (red at b45f34f7b: the thread caught the error and said nothing)", async (t) => {
  const d = dir();
  try {
    // the thread alone: a path that is there and cannot open
    const bad = join(d, "bad.sqlite");
    mkdirSync(bad);
    const told: Error[] = [];
    const a = checkpointAside(bad, (e) => void told.push(e), 1);
    for (let k = 0; k < 400 && told.length === 0; k++) await new Promise((r) => setTimeout(r, 5));
    for (let k = 0; k < 20; k++) await new Promise((r) => setTimeout(r, 5));
    a.stop();
    assert.equal(told.length, 1, "told once, the thread then stops checkpointing");
    assert.match(told[0]!.message, /checkpoint of .*bad\.sqlite/);
    // the pool index: its file moved aside and a directory put at its path once it is open, so its thread's first
    // checkpoint (CHECKPOINT_MS in) cannot open it
    // the writer's connection (card pool-index-writer-off-the-main-thread: it is the file's one writer) is the one
    // whose checkpoint comes back on
    const sql: string[] = [];
    const writer: typeof writerAside = (f, p, st) => {
      const w = writerAside(f, p, st);
      return { ...w, exec: (q: string) => (sql.push(q), w.exec(q)) };
    };
    const file = join(d, "rh.sqlite");
    const ix = createPoolIndex(file, cfg(), { ...deps(chain(() => 10_000, [])), writer });
    renameSync(file, join(d, "moved.sqlite"));
    mkdirSync(file);
    // 1,000 turns of 5 ms at most: the thread's first round is a second in
    for (let k = 0; k < 1_000 && !sql.includes("PRAGMA wal_autocheckpoint = 1000"); k++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(sql.includes("PRAGMA wal_autocheckpoint = 1000"), "the owner's checkpoint back on");
    ix.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
