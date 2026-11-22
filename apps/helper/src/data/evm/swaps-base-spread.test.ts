// node --test apps/helper/src/data/evm/swaps-base-spread.test.ts: card base-tapes-fill-inside-their-bound. A dozen cold
// Base coins whose newest 50 trades lie spread over the hour, opened at once on the public providers alone at their real
// paces, each finish filling inside the live checks' 45 s.
// Live run 44942886709 (helper 61fa14a08, 21 Nov 20:14Z), robinhood-tapes-read-ahead-bounded: 7 of 12 listed Base tapes
// "still filling 45013-46874 ms after its first read", 0 of 12 whole at their first answer; the same check failed at
// 4e03fcbac and 8713b1ca3 and against helper-18 (f28b6bd56, 20:44Z, 3 of 12), and passed only where the read ahead had 8
// or 9 of the 12 ready. A cold Base tape read back in agreed steps of 1,500 blocks, each 1,000-block span asked of two
// providers, up to 12 steps a tape: a dozen at once is some 300 to 600 log reads at the public providers' 9 a second.
// base-rpc.publicnode.com answers one pool's swaps over 50,000 blocks in one read (read from the Mac 21 Nov 21:1xZ: a v3
// pool's address, 1,584 logs in 478 ms; a v4 pool id, 308 logs in 516 ms), while base.gateway.tenderly.co and
// rpc.sentio.xyz refuse past 1,000 blocks and base-pokt.nodies.app past 50.
//
// The coins here: 12 Uniswap v3 pools against USDC, 60 swaps each in 20 bursts of 3 (a buy and two sells within 40
// blocks), the bursts 900 blocks apart, the newest 2,000 blocks before the head (past the cold window): the newest 50
// trades over some 15,000 blocks, inside the hour's tapeBack. The providers are Base's public list (SWAP_RPCS.base) at
// their real paces (limits.ts PROVIDER_PACE) and the spans each answered above, every answer LATE_MS late.
import assert from "node:assert/strict";
import { test } from "node:test";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { timeOf } from "../../../test/evm-swaps/base.ts";
import { blockSecondMs, createSwaps, SWAP_RPCS, TOPIC, TRADES_MAX, VENUES, type Pool } from "./swaps.ts";

const PUBLICNODE = "https://base-rpc.publicnode.com";
const LATE_MS = 300;
/** The live checks' bound (scripts/live-checks/tape-read.mjs FILLED_MS). */
const FILLED_MS = 45_000;
const HEAD = 60_000_000;
/** The widest span each provider answered for one pool's swaps (read above); mainnet.base.org is sent no log read. */
const SPAN: Record<string, number> = { [PUBLICNODE]: 50_000, "https://base.gateway.tenderly.co": 1_000, "https://rpc.sentio.xyz/base": 1_000, "https://base-pokt.nodies.app": 50 };

const w = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const int = (x: bigint) => (x < 0n ? (1n << 256n) + x : x).toString(16).padStart(64, "0");
const ROUTER = `0x${"7e".repeat(20)}`;
const BURSTS = 20;
const PER_BURST = 3;
const TOKENS = Array.from({ length: 12 }, (_, i) => ({ token: `0x${(0xba5e00 + i).toString(16).padStart(40, "0")}`, pool: `0x${(0x9ba5e00 + i).toString(16).padStart(40, "0")}` }));
const POOLS = new Map(TOKENS.map(({ token, pool }) => [token, { pool: { venue: "v3", id: pool, token, tokenIs0: true, quote: { kind: "usd", decimals: 6 } } as Pool, decimals: 18 }]));

type L = { b: number; i: number; tx: string; a: string; t: string[]; d: string };
const SWAPS = new Map<string, L[]>();
TOKENS.forEach(({ pool }, n) => {
  const logs: L[] = [];
  for (let k = 0; k < BURSTS; k++)
    for (let j = 0; j < PER_BURST; j++) {
      const b = HEAD - 2_000 - k * 900 - j * 20 - n * 7;
      const tx = `0x${"cd".repeat(29)}${n.toString(16).padStart(2, "0")}${k.toString(16).padStart(2, "0")}${j.toString(16).padStart(2, "0")}`;
      const amt = 1_000n * 10n ** 18n + BigInt(k * 10 + j);
      const usd = 5_000_000n + BigInt(k * 10 + j);
      // a buy (token out of the pool, USDC in), then two sells
      const [a0, a1] = j === 0 ? [-amt, usd] : [amt, -usd];
      logs.push({ b, i: 1, tx, a: pool, t: [TOPIC.swap3, w(ROUTER), w(ROUTER)], d: `0x${int(a0)}${int(a1)}${int(1n << 96n)}${int(10n ** 18n)}${int(0n)}` });
    }
  SWAPS.set(pool, logs.sort((x, y) => x.b - y.b));
});
const ALL = [...SWAPS.values()].flat();

function rig() {
  /** Each provider's eth_getLogs, by url. */
  const reads = new Map<string, number>();
  const wire = (l: L) => ({ address: l.a, topics: l.t, data: l.d, blockNumber: `0x${l.b.toString(16)}`, logIndex: `0x${l.i.toString(16)}`, transactionHash: l.tx, blockTimestamp: `0x${timeOf(l.b).toString(16)}`, removed: false });
  const one = (url: string, r: { method: string; params: unknown[] }): object => {
    if (r.method === "eth_blockNumber") return { result: `0x${HEAD.toString(16)}` };
    if (r.method === "eth_getBlockByNumber") {
      const n = r.params[0] === "latest" ? HEAD : parseInt(r.params[0] as string, 16);
      return n > HEAD ? { result: null } : { result: { number: `0x${n.toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, timestamp: `0x${timeOf(n).toString(16)}` } };
    }
    if (r.method === "eth_getTransactionByHash") return { result: { hash: r.params[0], from: `0x${(r.params[0] as string).slice(26, 66)}` } };
    // a v3 pool's slot0 (the quiet book's mark, markQuiet): price 1, tick 0, unlocked
    if (r.method === "eth_call" && (r.params[0] as { data?: string }).data === "0x3850c7bd") return { result: `0x${int(1n << 96n)}${int(0n).repeat(5)}${int(1n)}` };
    if (r.method !== "eth_getLogs") return { error: { code: -32601, message: "the method does not exist" } };
    if (SPAN[url] === undefined) return { error: { code: -32011, message: "request limit reached" } };
    const q = r.params[0] as { address?: string | string[]; topics?: (string | string[] | null)[]; fromBlock: string; toBlock: string };
    const [from, to] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
    if (!(to <= HEAD) || !(from <= to) || to - from + 1 > SPAN[url]!) return { error: { code: -32602, message: "invalid params" } };
    reads.set(url, (reads.get(url) ?? 0) + 1);
    const addrs = q.address === undefined ? null : [q.address].flat().map((a) => a.toLowerCase());
    const pos = (q.topics ?? []).map((x) => (x === null || x === undefined ? null : [x].flat()));
    return { result: ALL.filter((l) => l.b >= from && l.b <= to && (addrs === null || addrs.includes(l.a)) && pos.every((p, k) => p === null || p.includes(l.t[k]!))).map(wire) };
  };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    await new Promise((go) => setTimeout(go, LATE_MS));
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    const reqs = [body].flat();
    const out = reqs.map((r) => ({ jsonrpc: "2.0", id: r.id, ...one(url, r) }));
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, reads };
}

test("card base-tapes-fill-inside-their-bound: 12 cold Base coins whose newest 50 trades lie spread over the hour, opened at once on the public providers at their real paces: by 45 s of the virtual clock every tape answers its newest 50 trades, filling false (red at f28b6bd56: agreed 1,000-block spans a step, tapes still filling at 45 s, as live run 44942886709)", async () => {
  const r = rig();
  const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms));
  const { value } = await onVirtualTime(9_000_000, async () => {
    const s = createSwaps("base", { fetch: r.fetch as never, now: () => Date.now(), listed: async () => true, rpcs: SWAP_RPCS.base, pools: POOLS, tickMs: 0 });
    // each tape's latest answer, and the page's reads of it so far (3 s apart, as swaps-search.test.ts reads them)
    const latest = new Map<string, { status: number; filling: boolean; n: number; tx: unknown; reads: number; tick: number }>();
    // the helper ticks the loop below has run, each answer's place in the message (no clock read: no-wall-clock-asserts)
    let ticks = 0;
    let over = false;
    const poll = async (token: string) => {
      for (let reads = 1; !over; reads++) {
        const a = await s.trades(token, 50);
        const j = a.status === 200 ? (JSON.parse(a.body) as { trades: { tx: unknown }[]; filling?: boolean }) : null;
        latest.set(token, { status: a.status, filling: j?.filling === true, n: j?.trades.length ?? -1, tx: j?.trades[0]?.tx, reads, tick: ticks });
        if (j === null || j.filling !== true) return;
        await sleep(3_000);
      }
    };
    const by = sleep(FILLED_MS).then(() => {
      over = true;
      return TOKENS.map(({ token }) => latest.get(token));
    });
    const polls = Promise.all(TOKENS.map(({ token }) => poll(token)));
    // the helper's tick, a second apart, until the bound
    for (let i = 0; i < FILLED_MS / 1_000 && !over; i++) {
      await sleep(1_000);
      ticks = i + 1;
      await s.tick();
    }
    const got = await by;
    await polls;
    s.stop();
    return got;
  });
  const line = value.map((g, i) => `${TOKENS[i]!.token.slice(-4)} ${g?.status} ${g?.filling ? "filling" : "done"} n${g?.n} read ${g?.reads} after tick ${g?.tick}`).join(", ");
  console.log(`${line}; pool log reads: ${[...r.reads].map(([u, n]) => `${new URL(u).hostname} ${n}`).join(", ")}`);
  TOKENS.forEach(({ pool }, i) => {
    const g = value[i];
    assert.equal(g?.status, 200, line);
    assert.equal(g.filling, false, `a tape still filling at 45 s: ${line}`);
    assert.equal(g.n, TRADES_MAX, `the token's newest ${TRADES_MAX} trades: ${line}`);
    assert.equal(g.tx, SWAPS.get(pool)!.at(-1)!.tx, `newest first: ${line}`);
  });
});

// card helper-fresh-tapes-whole-from-the-first-minute: helper-25's live run 45032297159 (ee5c7dac4, 22 Nov 14:36Z) read
// Base 0x20ef8496 (AiSTR, whose pools last traded days before) "short and done at its first answer, naming neither
// filling nor whole_ms", and the warm helper 90776a37e answered it the same at 16:1xZ: a quiet coin whose day read (the
// one wide read on base-rpc.publicnode.com, locate) names no swap is done with no trade, and its reach (wholeOf) took
// a located read back's from its oldest trade alone, so an empty tape claimed none. The day read covered every block
// from tapeBack before the first read: the tape holds every swap since that block's second.
const QUIET = { token: `0x${"ba5e99".padStart(40, "0")}`, pool: `0x${"9ba5e99".padStart(40, "0")}` };
const QUIET_POOLS = new Map([...POOLS, [QUIET.token, { pool: { venue: "v3", id: QUIET.pool, token: QUIET.token, tokenIs0: true, quote: { kind: "usd", decimals: 6 } } as Pool, decimals: 18 }]]);

test("a quiet Base coin with no swap in the hour, opened cold and handed over to a new helper: done only naming whole_ms, the second of the first block its day read covered (red at ee5c7dac4: done, no whole_ms)", async () => {
  const r = rig();
  const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms));
  const { value } = await onVirtualTime(9_000_000, async () => {
    const make = () => createSwaps("base", { fetch: r.fetch as never, now: () => Date.now(), listed: async () => true, rpcs: SWAP_RPCS.base, pools: QUIET_POOLS, tickMs: 0 });
    const read = async (s: ReturnType<typeof make>) => JSON.parse((await s.trades(QUIET.token, TRADES_MAX)).body) as { trades: unknown[]; filling?: boolean; whole_ms?: number };
    const s = make();
    const answers: { trades: unknown[]; filling?: boolean; whole_ms?: number }[] = [await read(s)];
    for (let i = 0; i < 20 && answers.at(-1)!.filling === true; i++) {
      await sleep(1_000);
      await s.tick();
      answers.push(await read(s));
    }
    // the new helper: the old one's state handed over (books-handover), its first answer before any read of its own
    const next = make();
    next.restore(JSON.parse(JSON.stringify(s.state())));
    const handed = await read(next);
    s.stop();
    next.stop();
    return { answers, handed };
  });
  const last = value.answers.at(-1)!;
  const line = `cold ${JSON.stringify(value.answers.map((a) => ({ n: a.trades.length, filling: a.filling === true, whole_ms: a.whole_ms })))}, handed ${JSON.stringify({ n: value.handed.trades.length, filling: value.handed.filling === true, whole_ms: value.handed.whole_ms })}`;
  console.log(line);
  assert.equal(last.filling, undefined, `the cold tape ends: ${line}`);
  assert.equal(last.trades.length, 0, line);
  const floor = blockSecondMs("base", Math.max(0, HEAD - VENUES.base.cold + 1 - VENUES.base.tapeBack))! + 1_000;
  for (const [name, a] of [["cold", last], ["handed", value.handed]] as const) {
    assert.ok(a.filling === true || a.whole_ms !== undefined, `${name}: done naming neither filling nor whole_ms: ${line}`);
    if (a.filling !== true) assert.ok(a.whole_ms! <= floor && a.whole_ms! >= blockSecondMs("base", HEAD - VENUES.base.tapeBack - VENUES.base.cold - 2_000)!, `${name}: whole_ms ${a.whole_ms} at the day read's first block's second ${floor}: ${line}`);
  }
});
