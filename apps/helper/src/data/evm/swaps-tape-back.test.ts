// node --test apps/helper/src/data/evm/swaps-tape-back.test.ts: card every-cell-shows-a-value. A tape read only the cold
// window (VENUES.base.cold, 1,500 blocks: 5 minutes of Base's 200 ms blocks), so a token whose newest trade was older
// opened with none: 16 of the 41 listed Base tokens answered an empty tape on the live helper 2026-11-14 05:0xZ, REVVY's
// 31 swaps and PEACEFROG's 32 in the hour before all past the window. Here a short tape reads back (readBack) in the
// background, step after step, to TRADES_MAX trades or VENUES[chain].tapeBack blocks, each trade priced by the one rule (an ETH-quoted one at
// the ETH price in force before it, read with it). Every chain answer is the recorded Base fake (test/evm-swaps/base.ts)
// with the pool's planted in front; the logs are real (fixtures/swaps-pancake-base.json, swaps-univ2-base.json).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as B from "../../../test/evm-swaps/base.ts";
import { fixed } from "../candles.ts";
import * as S from "./swaps.ts";
import { VENUES } from "./swaps.ts";

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const sel = (s: string) => hex(keccak_256(new TextEncoder().encode(s))).slice(0, 10);
const w = (a: string) => a.slice(2).padStart(64, "0");
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
type Filter = { address?: string; topics?: (string | string[] | null)[]; fromBlock: string; toBlock: string };
type Fx = { pool: string; factory: string; asset0: string; asset1: string; log: Record<string, unknown> & { topics: string[]; transactionHash: string } };
const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Fx & { fee?: number };
const PCS = fx("swaps-pancake-base.json");
const UNI2 = fx("swaps-univ2-base.json");
/** Base's VENUES sizes, read through the namespace so the file loads where tapeBack is missing (red at cd426e5b9). */
/** Uniswap v3's (and Slipstream's, PancakeSwap v3's) pool event at its creation: Initialize(uint160 sqrtPriceX96, int24 tick). */
const INIT3 = hex(keccak_256(new TextEncoder().encode("Initialize(uint160,int24)")));
const TAPE_BACK = (VENUES.base as unknown as Record<string, number>).tapeBack ?? 18_000;

/** The fake chain at `head`, the pool's confirming calls planted, its one recorded swap moved to block `at`; `asked`
 *  collects each pool logs read's first block. */
function rig(p: Fx & { fee?: number }, getPool: string, head: number, at: number, failBefore?: number, born?: number, clock?: { t: number }) {
  const chain = B.fakeChain();
  chain.st.head = head;
  const calls = new Map<string, string>([
    [`${p.asset0} 0x313ce567`, word(18n)],
    [`${p.pool} 0xc45a0155`, word(BigInt(p.factory))],
    [`${p.pool} 0x0dfe1681`, word(BigInt(p.asset0))],
    [`${p.pool} 0xd21220a7`, word(BigInt(p.asset1))],
    ...(p.fee === undefined ? [] : [[`${p.pool} ${sel("fee()")}`, word(BigInt(p.fee))] as [string, string]]),
    [getPool, word(BigInt(p.pool))],
  ]);
  const log = { ...p.log, blockNumber: `0x${at.toString(16)}`, blockTimestamp: `0x${B.timeOf(at).toString(16)}` };
  const asked: number[] = [];
  // every eth_getLogs asked of any provider: its filter's address, second topic (a v4 pool's id) and first block
  const reads: { address: string; id: string | null; from: number }[] = [];
  const live = { out: 0, sent: 0 };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    live.out++;
    live.sent++;
    try {
      return await answer(url, init);
    } finally {
      live.out--;
    }
  };
  const answer = async (url: string, init: RequestInit): Promise<Response> => {
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    const mine = reqs.map((r): object | undefined => {
      if (r.method === "eth_call") {
        const c = r.params[0] as { to: string; data: string };
        return { result: calls.get(`${c.to} ${c.data}`) ?? "0x" };
      }
      if (r.method !== "eth_getLogs") return undefined;
      const q = r.params[0] as Filter;
      reads.push({ address: String(q.address), id: typeof q.topics?.[1] === "string" ? q.topics[1] : null, from: parseInt(q.fromBlock, 16) });
      if (q.address === p.asset0) return { result: [] };
      if (q.address === p.pool) {
        asked.push(parseInt(q.fromBlock, 16));
        if (failBefore !== undefined && parseInt(q.fromBlock, 16) < failBefore) return { error: { code: -32603, message: "internal error" } };
        const t0 = [q.topics?.[0]].flat();
        const inRange = (b: number) => b >= parseInt(q.fromBlock, 16) && b <= parseInt(q.toBlock, 16);
        // the pool's own Initialize(uint160,int24) at `born`: its first log, none before it
        const birth = born !== undefined && t0.includes(INIT3) && inRange(born) ? [{ address: p.pool, topics: [INIT3], data: `0x${"0".repeat(63)}1${"0".repeat(64)}`, blockNumber: `0x${born.toString(16)}`, blockTimestamp: `0x${B.timeOf(born).toString(16)}`, transactionHash: `0x${"bb".repeat(32)}`, logIndex: "0x0", blockHash: `0x${"cc".repeat(32)}`, transactionIndex: "0x0", removed: false }] : [];
        return { result: [...birth, ...(t0.includes(p.log.topics[0]!) && inRange(at) && (born === undefined || at >= born) ? [log] : [])] };
      }
      return undefined;
    });
    const rest = reqs.filter((_, i) => mine[i] === undefined);
    const fwd = rest.length === 0 ? [] : ((await (await chain.fetch(url, { ...init, body: JSON.stringify(rest) })).json()) as { id: number }[]);
    const out = reqs.map((r, i) => (mine[i] !== undefined ? { jsonrpc: "2.0", id: r.id, ...mine[i] } : fwd.find((x) => x.id === r.id)));
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  const s = B.open(chain, clock, { fetch: fetch as never, pools: new Map(), hint: async () => p.pool });
  posts.set(s, live);
  return { s, asked, reads };
}
/** Each rig's posts to its providers: `out` sent and unanswered, `sent` ever sent. */
const posts = new WeakMap<object, { out: number; sent: number }>();
/** A read back is settled once no post is out and none is sent for this many 5 ms looks in a row. */
const QUIET_LOOKS = 20;
/** Ticks, each followed by the read back it starts settling (its own background read, never the tick's wait): 200 ms,
 *  then until no post is out and none is sent for QUIET_LOOKS looks, so its end is the read back's own, not a time. A
 *  fixed 200 ms alone ended before it on a loaded machine: each answer 60 ms late failed this file (card
 *  readme-run-fits-an-agent-timeout: the README's fresh run on GitHub's 4-core runner, 23 Nov 21:39Z). The bound is a
 *  hang bound only: a read back that never settles fails the test's own assert. */
const ticks = async (s: ReturnType<typeof B.open>, n: number) => {
  const live = posts.get(s)!;
  const look = () => new Promise((ok) => setTimeout(ok, 5));
  for (let i = 0; i < n; i++) {
    await s.tick();
    for (let k = 0; k < 40; k++) await look();
    let [quiet, seen] = [0, live.sent];
    for (const end = performance.now() + 60_000; quiet < QUIET_LOOKS && performance.now() < end; ) {
      await look();
      [quiet, seen] = live.out === 0 && live.sent === seen ? [quiet + 1, seen] : [0, live.sent];
    }
  }
};
/** The tape's reach (whole_ms, card token-stats-count-every-trade), or undefined when it claims none. */
const reach = async (s: ReturnType<typeof B.open>, tok: string) => JSON.parse((await s.trades(tok, 50)).body).whole_ms as number | undefined;
/** Whether the tape's answer says it is filling (its older trades still being read). */
const filling = async (s: ReturnType<typeof B.open>, tok: string) => JSON.parse((await s.trades(tok, 50)).body).filling === true;
const rows = async (s: ReturnType<typeof B.open>, tok: string) => {
  const a = await s.trades(tok, 50);
  assert.equal(a.status, 200, a.body);
  return (JSON.parse(a.body).trades as { side: string; usd: string; amt: string; tx: string }[]).map((x) => [x.side, x.usd, x.amt, x.tx]);
};

test("a token whose only trade lies past the cold window: its first open has none, and the tape read back finds it within TAPE_BACK blocks, in the background, then reads no further (red at cd426e5b9: never found)", async () => {
  const head = B.REC.firstHead + 200;
  const V = VENUES.base;
  // 300 blocks before the first read's window: the first step back holds it
  const at = head - V.cold - 300;
  const { s, asked } = rig(PCS, `${PCS.factory} ${sel("getPool(address,address,uint24)")}${w(PCS.asset0)}${w(PCS.asset1)}${w(word(BigInt(PCS.fee!)))}`, head, at);
  // the read back starts with the first read, in the background (card helper-listed-charts-own-reads: at the tick after,
  // a dozen cold Robinhood tapes said filling for a minute): the first answer holds the trade read back already, or none
  // and filling, so the page shows it loading
  const opened = await rows(s, PCS.asset0);
  assert.ok(opened.length === 1 || (opened.length === 0 && (await filling(s, PCS.asset0))), `first answer: ${JSON.stringify(opened)}`);
  await ticks(s, 2);
  assert.deepEqual(await rows(s, PCS.asset0), [["b", "57.137132", "868.503865188635487108", PCS.log.transactionHash]]);
  // the read back went to TAPE_BACK blocks before the first read (one trade is short of TRADES_MAX), never past it
  const first = head - V.cold + 1;
  assert.equal(Math.min(...asked), first - TAPE_BACK);
  const n = asked.length;
  await ticks(s, 3);
  assert.equal(asked.filter((b) => b < first).length, asked.slice(0, n).filter((b) => b < first).length, "done: no step back once TAPE_BACK is read");
  assert.equal(await filling(s, PCS.asset0), false, "done: not filling");
  // card token-stats-count-every-trade: every trade from the second after the lowest block read is on the tape, Base's
  // blocks on a fixed clock (BLOCK_CLOCK)
  assert.equal(await reach(s, PCS.asset0), S.blockSecondMs("base", first - TAPE_BACK)! + 1_000);
  s.stop();
});

test("an ETH-quoted trade read back is priced at the ETH price in force before it, read in the same step (Uniswap v2 SPCX / WETH) (red at cd426e5b9: never found)", async () => {
  const V = VENUES.base;
  // the swap 400 blocks into the recording, the head past it by the cold window and 100 blocks: the recorded ETH price
  // swaps before it lie in the same step back
  const at = B.REC.firstHead + 400;
  const head = at + V.cold + 100;
  const { s } = rig(UNI2, `${UNI2.factory} ${sel("getPair(address,address)")}${w(UNI2.asset0)}${w(UNI2.asset1)}`, head, at);
  assert.deepEqual(await rows(s, UNI2.asset0), []);
  await ticks(s, 2);
  const ref = B.REC.logs.ref.filter((x) => x.b < at).map(B.toLog).map((x) => S.decodeRef(x)).filter((x) => x !== null).at(-1)!;
  assert.deepEqual(await rows(s, UNI2.asset0), [["b", fixed((3_577_223_829n * ref.ethUsd) / 10n ** 18n, 18), "123989.534258606247275177", UNI2.log.transactionHash]]);
  s.stop();
});

test("guard: a trade read back with no ETH price before it in what was read is not on the tape (never priced by a later price)", async () => {
  const V = VENUES.base;
  // before the recording's first ETH price swap: nothing read prices it
  const at = B.REC.firstHead + 5;
  const head = at + V.cold + 100;
  const { s } = rig(UNI2, `${UNI2.factory} ${sel("getPair(address,address)")}${w(UNI2.asset0)}${w(UNI2.asset1)}`, head, at);
  await ticks(s, 2);
  assert.deepEqual(await rows(s, UNI2.asset0), []);
  s.stop();
});

test("guard: a read back whose steps fail BACK_FAILS_MAX times in a row stays filling, never settled short on a failed read: it waits BACK_RETRY_MS, doubling to BACK_RETRY_MAX_MS, then asks the step again (card robinhood-trades-finish-filling; red at d3ae40db4: settled, not filling, after three fails)", async () => {
  const head = B.REC.firstHead + 200;
  const first = head - VENUES.base.cold + 1;
  const clock = { t: 1_000_000 };
  const { s, asked } = rig(PCS, `${PCS.factory} ${sel("getPool(address,address,uint24)")}${w(PCS.asset0)}${w(PCS.asset1)}${w(word(BigInt(PCS.fee!)))}`, head, head - VENUES.base.cold - 300, first, undefined, clock);
  assert.equal(await filling(s, PCS.asset0), true);
  assert.equal(await reach(s, PCS.asset0), undefined, "no reach while it fills");
  await ticks(s, S.BACK_FAILS_MAX + 2);
  assert.equal(await filling(s, PCS.asset0), true, "still filling after its fails");
  assert.deepEqual(await rows(s, PCS.asset0), []);
  // still short: no reach claimed (whole_ms) while it fills, never the book's own first block on a read that failed
  assert.equal(await reach(s, PCS.asset0), undefined, "no reach while it fills after its fails");
  // past the fails, none asked within the wait: each failed step asked its spans of both providers, max times
  const n = asked.filter((b) => b < first).length;
  await ticks(s, 2);
  assert.equal(asked.filter((b) => b < first).length, n, "asked again within the wait");
  // the wait passed: the step is asked again, and the tape still says filling
  clock.t += S.BACK_RETRY_MAX_MS;
  await ticks(s, 1);
  assert.ok(asked.filter((b) => b < first).length > n, "asked again after the wait");
  assert.equal(await filling(s, PCS.asset0), true);
  s.stop();
});

test("a short ETH-quoted tape reads back with the ETH price read only in the steps that hold a trade: a step with none asks its pool's swaps alone (card evm-tape-from-our-index-fast: a cold Base tape still filling at 180 s on the keyed providers' quota; red at a00fdfa56: every one of the 12 steps asked the ETH price too)", async () => {
  const V = VENUES.base;
  // the one trade in the first step back (as the ETH-quoted test above), so the other steps back hold none
  const at = B.REC.firstHead + 400;
  const head = at + V.cold + 100;
  const { s, reads } = rig(UNI2, `${UNI2.factory} ${sel("getPair(address,address)")}${w(UNI2.asset0)}${w(UNI2.asset1)}`, head, at);
  assert.deepEqual(await rows(s, UNI2.asset0), []);
  await ticks(s, 4);
  assert.equal(await filling(s, UNI2.asset0), false, "the read back is done");
  const ref = B.REC.logs.ref.filter((x) => x.b < at).map(B.toLog).map((x) => S.decodeRef(x)).filter((x) => x !== null).at(-1)!;
  assert.deepEqual(await rows(s, UNI2.asset0), [["b", fixed((3_577_223_829n * ref.ethUsd) / 10n ** 18n, 18), "123989.534258606247275177", UNI2.log.transactionHash]], "priced as before, at the ETH price in force before it");
  const first = head - V.cold + 1;
  const back = reads.filter((r) => r.from < first - V.refBack);
  const refReads = back.filter((r) => r.id === S.REF_POOL_ID).length;
  const poolReads = back.filter((r) => r.address === UNI2.pool).length;
  // the step back that holds the trade: its spans of the ETH price, on the providers that agreed; the other 11 none
  const spansAStep = Math.ceil(V.step / V.span);
  console.log(`read back: ${back.length} eth_getLogs (${poolReads} the pool's, ${refReads} the ETH price's) over ${TAPE_BACK} blocks`);
  assert.ok(refReads <= 3 * spansAStep, `the ETH price read in the trade's step only: ${refReads} reads, at most ${3 * spansAStep}`);
  assert.ok(back.length <= poolReads + 3 * spansAStep, `no read back asks more than the pool's swaps and one step's ETH price: ${back.length}`);
  s.stop();
});

test("a pool born inside the hour: its read back ends at the step that holds its own Initialize, no step before it is read (card evm-tape-from-our-index-fast: a new list's tapes read all 12 steps of an hour their pools were not in, still filling at 45 s; red at a00fdfa56: every step read)", async () => {
  const V = VENUES.base;
  const head = B.REC.firstHead + 200;
  const first = head - V.cold + 1;
  // the pool made 2,000 blocks before the first read (its second step back), its one trade 100 blocks after
  const born = first - 2_000;
  const at = born + 100;
  const { s, asked } = rig(PCS, `${PCS.factory} ${sel("getPool(address,address,uint24)")}${w(PCS.asset0)}${w(PCS.asset1)}${w(word(BigInt(PCS.fee!)))}`, head, at, undefined, born);
  assert.equal(await filling(s, PCS.asset0), true);
  await ticks(s, 3);
  assert.deepEqual(await rows(s, PCS.asset0), [["b", "57.137132", "868.503865188635487108", PCS.log.transactionHash]]);
  assert.equal(await filling(s, PCS.asset0), false, "done at its birth: not filling");
  assert.equal(await reach(s, PCS.asset0), 0, "the tape holds every trade since the pool's birth");
  const back = asked.filter((b) => b < first);
  console.log(`read back of a pool born ${first - born} blocks before the first read: ${back.length} pool reads, the oldest from block ${Math.min(...back)} (born ${born})`);
  assert.ok(Math.min(...back) >= born - V.step, `no step read wholly before its birth: the oldest read from ${Math.min(...back)}, born ${born}`);
  s.stop();
});

test("card token-stats-count-every-trade: a block's second on Base's fixed clock (BLOCK_CLOCK), none on Robinhood's", () => {
  // the 200 ms era's first block at its own time, five blocks a second after it; the 2 s era before it
  assert.equal(S.blockSecondMs("base", 53_556_127), 1_793_901_601_000);
  assert.equal(S.blockSecondMs("base", 53_556_131), 1_793_901_601_000);
  assert.equal(S.blockSecondMs("base", 53_556_132), 1_793_901_602_000);
  assert.equal(S.blockSecondMs("base", 0), 1_686_789_347_000);
  assert.equal(S.blockSecondMs("base", 1), 1_686_789_349_000);
  assert.equal(S.blockSecondMs("robinhood", 53_556_127), null);
  assert.equal(S.blockSecondMs("base", -1), null);
});
