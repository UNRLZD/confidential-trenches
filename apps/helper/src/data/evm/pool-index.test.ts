// card evm-pool-index-from-the-first-pool: the helper's index of every PoolManager pool from its first block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKFILL_DAY_SHARE, createPoolIndex, INITIALIZE, poolIdOf, POOL_INDEX_SPAN_LOGS, type PoolKey, type PoolIndexConfig } from "./pool-index.ts";
import { CALLER_ROOM, providerHolds, type Pace } from "../../limits/limits.ts";

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
    const forged = { ...logOf(keyOf(tok(7), t), 200), topics: [INITIALIZE, poolIdOf(good), "0x" + W(BigInt(tok(7))), "0x" + W(BigInt(t))] };
    const other = { ...logOf(keyOf(tok(8), t), 300), address: "0x0000000000000000000000000000000000000001" };
    const ix = createPoolIndex(join(d, "rh.sqlite"), cfg(), deps(chain(() => 2_000, [forged, other, logOf(good, 400)])));
    await until(ix);
    assert.deepEqual(ix.pools(t).pools.map((p) => p.id), [poolIdOf(good)]);
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

test("GET /v1/market/pools: one chain the helper indexes and one token address, else 400 or 404; the answer is the index's, complete or not", async () => {
  const { createServer, request } = await import("node:http");
  const { handler } = await import("../../server.ts");
  const { createProxy } = await import("../../proxy/proxy.ts");
  const { createRpc } = await import("../../rpc/rpc.ts");
  const stub = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  const asked: string[] = [];
  const answer = (t: string) => ({ chainId: 4663, poolManager: PM, complete: false, through: 99, pools: [{ id: "0x" + "ab".repeat(32), key: keyOf(tok(0), t) }] });
  const ix = { pools: (t: string) => (asked.push(t), answer(t)) };
  const h = createServer(handler("0123456789abcdef0123456789abcdef01234567", createProxy({}, { fetch: stub }), createRpc({}, { fetch: stub }), undefined, undefined, undefined, undefined, undefined, undefined, null, new Map(), new Map(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { robinhood: ix }));
  await new Promise<void>((r) => h.listen(0, "127.0.0.1", r));
  const port = (h.address() as { port: number }).port;
  const get = (path: string) =>
    new Promise<{ status: number; text: string }>((ok, no) => {
      const q = request({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => ok({ status: res.statusCode ?? 0, text }));
      });
      q.on("error", no);
      q.end();
    });
  try {
    const T = "0x00000000000000000000000000000000000ABCde";
    const ok = await get(`/v1/market/pools?chain=robinhood&token=${T}`);
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.text), answer(T.toLowerCase()));
    assert.deepEqual(asked, [T.toLowerCase()]);
    for (const bad of [`?chain=robinhood`, `?chain=robinhood&token=0x12`, `?chain=robinhood&token=${T}&token=${T}`, `?chain=robinhood&token=${T}&x=1`]) assert.equal((await get(`/v1/market/pools${bad}`)).status, 400, bad);
    for (const none of [`?chain=base&token=${T}`, `?chain=solana&token=${T}`]) assert.equal((await get(`/v1/market/pools${none}`)).status, 404, none);
    assert.equal(asked.length, 1, "a refused ask reads nothing");
  } finally {
    await new Promise((r) => h.close(r));
  }
});
