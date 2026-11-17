// node --test apps/helper/src/data/evm/swaps-back-window.test.ts: card base-tape-fills-inside-45s. Helper 179's live run
// 44008440768: Base 0xf1d0e72a, 5 trades in its hour (Uniswap v2 pair 0x0ebedb7e, 03:07:46-03:09:38Z), its tape "first 0
// trade(s) filling, still filling at 46205 ms (read back)"; read cold again from the Mac at 03:52Z and 03:56Z it ended
// filling at 63.5 s and 48.2 s. Its read back walked the hour (tapeBack 18,000 blocks) in 12 steps of 1,500 blocks, one
// after another, each waiting the helper's paces (a cold open's Server-Timing at 02:13Z: 5 posts, 4,218 ms of pace); the
// same code idle, in-process on the public providers, took 17.7 to 28.6 s. Here each provider answers one post at a time,
// PACE_MS apart, on virtual time: the providers' paces as the loaded helper met them.
// - a quiet coin (5 swaps 45 minutes back) ends filling inside FILLED_MS;
// - a coin whose swaps are spread over its hour shows them as their spans agree, filling until the window is whole;
// - a busy coin (its newest step fills the tape) reads what it read before, post for post;
// - a caller's read in the middle of a cold fill waits no more than one PACE_MS more than it did behind the walk.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as B from "../../../test/evm-swaps/base.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { geckoBudget } from "../gecko.ts";
import { TRADES_MAX, VENUES } from "./swaps.ts";

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const sel = (s: string) => hex(keccak_256(new TextEncoder().encode(s))).slice(0, 10);
const w = (a: string) => a.slice(2).padStart(64, "0");
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
type Filter = { address?: string; topics?: (string | string[] | null)[]; fromBlock: string; toBlock: string };
type Fx = { pool: string; factory: string; asset0: string; asset1: string; fee?: number; log: Record<string, unknown> & { topics: string[]; transactionHash: string } };
const PCS = JSON.parse(readFileSync(new URL("./fixtures/swaps-pancake-base.json", import.meta.url), "utf8")) as Fx;
/** A provider's pace as the loaded helper met it: one post answered every PACE_MS (live: 4,218 ms for 5 posts). */
const PACE_MS = 850;
/** The helper's other reads on each provider (the other open books' ticks, the lists' search ahead): one post every
 *  LOAD_MS, so the read back has about half of each provider's posts. [design: at it the walk of 9855b8fbe ends the quiet
 *  coin's fill at about the 48 to 63 s the live helper took] */
const LOAD_MS = 1_700;
/** The bound a filling tape is given (scripts/live-checks/tape-read.mjs FILLED_MS). */
const FILLED_MS = 45_000;
const V = VENUES.base;

/**
 * The fake Base chain at `head` with PCS's pool planted: its confirming calls, and its recorded swap copied to each block
 * of `at` (each its own transaction). Every provider answers one post at a time, PACE_MS after the one before it.
 * `posts` counts every post sent; `logs` each eth_getLogs of the pool.
 */
function rig(head: number, at: readonly number[], gt?: (url: string) => Promise<Response>) {
  const chain = B.fakeChain();
  chain.st.head = head;
  const getPool = `${PCS.factory} ${sel("getPool(address,address,uint24)")}${w(PCS.asset0)}${w(PCS.asset1)}${w(word(BigInt(PCS.fee!)))}`;
  const calls = new Map<string, string>([
    [`${PCS.asset0} 0x313ce567`, word(18n)],
    [`${PCS.pool} 0xc45a0155`, word(BigInt(PCS.factory))],
    [`${PCS.pool} 0x0dfe1681`, word(BigInt(PCS.asset0))],
    [`${PCS.pool} 0xd21220a7`, word(BigInt(PCS.asset1))],
    [`${PCS.pool} ${sel("fee()")}`, word(BigInt(PCS.fee!))],
    [getPool, word(BigInt(PCS.pool))],
  ]);
  const swaps = at.map((b, k) => ({ ...PCS.log, blockNumber: `0x${b.toString(16)}`, blockTimestamp: `0x${B.timeOf(b).toString(16)}`, logIndex: "0x1", transactionHash: `0x${(k + 1).toString(16).padStart(64, "e")}` }));
  const st = { posts: 0, poolReads: 0, callerWaits: [] as number[] };
  const free = new Map<string, number>();
  const answer = async (url: string, init: RequestInit): Promise<Response> => {
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    const mine = reqs.map((r): object | undefined => {
      if (r.method === "eth_call") {
        const c = r.params[0] as { to: string; data: string };
        return { result: calls.get(`${c.to} ${c.data}`) ?? "0x" };
      }
      if (r.method !== "eth_getLogs") return undefined;
      const q = r.params[0] as Filter;
      if (q.address === PCS.asset0) return { result: [] };
      if (q.address !== PCS.pool) return undefined;
      st.poolReads++;
      const t0 = [q.topics?.[0]].flat();
      const [lo, hi] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
      return { result: t0.includes(PCS.log.topics[0]!) ? swaps.filter((l) => parseInt(l.blockNumber, 16) >= lo && parseInt(l.blockNumber, 16) <= hi) : [] };
    });
    const rest = reqs.filter((_, i) => mine[i] === undefined);
    const fwd = rest.length === 0 ? [] : ((await (await chain.fetch(url, { ...init, body: JSON.stringify(rest) })).json()) as { id: number }[]);
    const out = reqs.map((r, i) => (mine[i] !== undefined ? { jsonrpc: "2.0", id: r.id, ...mine[i] } : fwd.find((x) => x.id === r.id)));
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  // the other reads' posts, on every provider the fake knows
  // (setTimeout, which the virtual clock runs; setInterval it does not)
  let loading = true;
  const load = (): void => {
    if (!loading) return;
    for (const u of B.URLS) free.set(u, Math.max(Date.now(), free.get(u) ?? 0) + PACE_MS);
    setTimeout(load, LOAD_MS);
  };
  setTimeout(load, LOAD_MS);
  // one post at a time a provider, each PACE_MS after the last
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (url.includes("geckoterminal")) return gt!(url);
    st.posts++;
    const go = Math.max(Date.now(), free.get(url) ?? 0) + PACE_MS;
    free.set(url, go);
    // a caller's post (the ICNT tape's open): its wait behind the posts already queued at this provider
    if (String(init.body).includes(B.POOL_ICNT.id)) st.callerWaits.push(go - PACE_MS - Date.now());
    await new Promise((ok) => setTimeout(ok, go - Date.now()));
    return answer(url, init);
  };
  const s = B.open(chain, undefined, { fetch: fetch as never, now: () => Date.now(), pools: new Map([[B.ICNT, B.KNOWN.get(B.ICNT)!]]), hint: async (t) => (t === PCS.asset0 ? PCS.pool : null), ...(gt === undefined ? {} : { gecko: geckoBudget(() => Date.now()) }) });
  const halt = s.stop;
  return { s: Object.assign(s, { stop: () => ((loading = false), halt()) }), st };
}

/** The tape read every 500 ms (the tick every TICK_MS) until it says filling no longer or `maxMs` passes: each answer's
 *  time from the first read, its trades and whether it said filling. */
async function fill(s: ReturnType<typeof B.open>, token: string, maxMs: number, during?: (ms: number) => Promise<void>) {
  const t0 = Date.now();
  const seen: { ms: number; n: number; filling: boolean }[] = [];
  let nextTick = t0;
  let fired = false;
  for (;;) {
    const ms = Date.now() - t0;
    const b = JSON.parse((await s.trades(token, TRADES_MAX)).body) as { trades: unknown[]; filling?: boolean };
    seen.push({ ms: Date.now() - t0, n: b.trades.length, filling: b.filling === true });
    if (b.filling !== true || ms > maxMs) break;
    if (during !== undefined && !fired && ms >= 8_000) {
      fired = true;
      await during(ms);
    }
    if (Date.now() >= nextTick) {
      nextTick = Date.now() + 1_000;
      void s.tick();
    }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  return seen;
}

const HEAD = B.REC.firstHead + 200;
const FIRST = HEAD - V.cold + 1;
/** The live coin's shape: 5 swaps over 2 minutes, 45 minutes before the first read (13,500 of Base's 200 ms blocks). */
const QUIET = [0, 120, 300, 450, 560].map((d) => FIRST - 13_500 + d);

test("a quiet Base coin, 5 swaps 45 minutes back, ends filling inside 45 s with each provider answering a post every 850 ms beside the helper's other reads (red at 9855b8fbe: the walk's 12 steps one after another)", async () => {
  const { value } = await onVirtualTime(1_800_000_000_000, async () => {
    const { s, st } = rig(HEAD, QUIET);
    try {
      const seen = await fill(s, PCS.asset0, 120_000);
      return { seen, posts: st.posts };
    } finally {
      s.stop();
    }
  });
  const last = value.seen.at(-1)!;
  console.log(`quiet coin: filling ended at ${last.ms} ms, ${last.n} trades, ${value.posts} posts; answers ${JSON.stringify(value.seen.filter((x, i, a) => i === 0 || x.n !== a[i - 1]!.n || x.filling !== a[i - 1]!.filling))}`);
  assert.equal(last.filling, false, `still filling at ${last.ms} ms`);
  assert.equal(last.n, 5);
  assert.ok(last.ms <= FILLED_MS, `filling ended at ${last.ms} ms, past ${FILLED_MS}`);
  // every answer short of the floor said filling
  for (const a of value.seen.slice(0, -1)) assert.ok(a.filling, JSON.stringify(a));
});

test("a busy Base coin whose newest step fills the tape reads what it read at 9855b8fbe, post for post (BUSY_POSTS)", async () => {
  // 60 swaps in the newest step back, past the cold window: the step fills the tape, no window is read
  const busy = Array.from({ length: 60 }, (_, k) => FIRST - 1_400 + k * 20);
  const { value } = await onVirtualTime(1_800_000_000_000, async () => {
    const { s, st } = rig(HEAD, busy);
    try {
      const seen = await fill(s, PCS.asset0, 120_000);
      return { seen, posts: st.posts, poolReads: st.poolReads };
    } finally {
      s.stop();
    }
  });
  const last = value.seen.at(-1)!;
  console.log(`busy coin: filling ended at ${last.ms} ms, ${last.n} trades, ${value.posts} posts, ${value.poolReads} pool log reads`);
  assert.equal(last.filling, false);
  assert.equal(last.n, TRADES_MAX);
  assert.equal(value.poolReads, BUSY_POOL_READS, "the pool's log reads, as at 9855b8fbe");
  assert.equal(value.posts, BUSY_POSTS, "the posts, as at 9855b8fbe");
});

test("a caller's read in the middle of a quiet coin's cold fill waits in the providers' queues no more than one PACE_MS over its wait behind the walk (CALLER_WAIT_MS at 9855b8fbe)", async () => {
  const { value } = await onVirtualTime(1_800_000_000_000, async () => {
    const { s, st } = rig(HEAD, QUIET);
    try {
      await fill(s, PCS.asset0, 120_000, async () => {
        const a = await s.trades(B.ICNT, TRADES_MAX);
        assert.equal(a.status, 200, a.body);
      });
      return { waits: st.callerWaits };
    } finally {
      s.stop();
    }
  });
  const most = Math.max(...value.waits);
  console.log(`a caller's tape open 8 s into the fill: ${value.waits.length} posts, each queued ${JSON.stringify(value.waits)} ms behind those before it, at most ${most} ms`);
  assert.ok(value.waits.length > 0, "the caller's read posted");
  assert.ok(most <= CALLER_WAIT_MS + PACE_MS, `the caller's post waited ${most} ms in a provider's queue, past ${CALLER_WAIT_MS} + ${PACE_MS}`);
});

test("rows arrive as their spans agree: a coin with a swap every 3,000 blocks of its hour shows more trades answer after answer, each answer short of the hour saying filling, and ends filling only with the window whole", async () => {
  const spread = [2_000, 5_000, 8_000, 11_000, 14_000].map((d) => FIRST - d);
  const { value } = await onVirtualTime(1_800_000_000_000, async () => {
    const { s } = rig(HEAD, spread);
    try {
      return await fill(s, PCS.asset0, 120_000);
    } finally {
      s.stop();
    }
  });
  const steps = value.filter((x, i, a) => i === 0 || x.n !== a[i - 1]!.n || x.filling !== a[i - 1]!.filling);
  console.log(`spread coin: ${JSON.stringify(steps)}`);
  const last = value.at(-1)!;
  assert.equal(last.filling, false);
  assert.equal(last.n, 5);
  assert.ok(last.ms <= FILLED_MS, `filling ended at ${last.ms} ms`);
  // some trades shown while it still filled, never all at once at the end
  assert.ok(value.some((x) => x.filling && x.n > 0 && x.n < 5), `no answer showed part of the tape while filling: ${JSON.stringify(steps)}`);
  for (const a of value.slice(0, -1)) assert.ok(a.filling, JSON.stringify(a));
});

test("an answer says filling as its rows were taken: a chart asked while the read back goes on, its GeckoTerminal read answered only once the read back has ended, says filling or holds every trade's bar", async () => {
  const spread = [2_000, 5_000, 8_000, 11_000, 14_000].map((d) => FIRST - d);
  const { value } = await onVirtualTime(1_800_000_000_000, async () => {
    let release = (): void => undefined;
    const ended = new Promise<void>((ok) => (release = ok));
    const { s } = rig(HEAD, spread, async () => {
      await ended;
      return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [] } } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      let chart: Promise<{ body: string }> | undefined;
      const seen = await fill(s, PCS.asset0, 120_000, async () => {
        chart = s.candles(PCS.asset0, "1m", null, 500);
      });
      release();
      const c = JSON.parse((await chart!).body) as { candles: unknown[]; filling?: boolean };
      return { seen, bars: c.candles.length, filling: c.filling === true };
    } finally {
      s.stop();
    }
  });
  console.log(`a chart asked at 8 s, answered after the read back ended at ${value.seen.at(-1)!.ms} ms: ${value.bars} bars, filling ${value.filling}`);
  assert.equal(value.seen.at(-1)!.filling, false, "the read back ended");
  assert.ok(value.filling || value.bars >= 5, `a chart of ${value.bars} bars said not filling`);
});

/** The busy coin's posts and pool log reads at 9855b8fbe (its newest step fills the tape: no window): 36 and 12. */
const BUSY_POSTS = 36;
const BUSY_POOL_READS = 12;
/** The most a caller's post waited in a provider's queue in the middle of the walk at 9855b8fbe: 5,100 ms (its 15 posts
 *  queued 1,050 to 5,100 ms behind those before them). */
const CALLER_WAIT_MS = 5_100;
