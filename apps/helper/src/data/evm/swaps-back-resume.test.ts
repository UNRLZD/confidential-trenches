// node --test apps/helper/src/data/evm/swaps-back-resume.test.ts: card robinhood-trades-finish-filling. A dozen Robinhood
// coins whose pools only the discovery finds, opened at once, each finish filling inside the live checks' 45 s while the
// helper's tick is slow and providers refuse. Helper release 179 (909222c27), live run 44008440768: 0xca9c78dd and
// 0x9f4ba41f still filling at 46.2 s, 0x39dbed3a filled at 46.1 s. The same 12 coins read from the Mac on d59370557
// (17 Nov 05:0x-05:1xZ, swaps.ts timed by phase) filled at 95 s and at 121 s, the read back waiting with providers free:
//   - a tape the discovery seeded read back only from the next tick (open never started it), and a tick of the 12 books
//     took 5.0, 5.1, 8.2, 9.4, 12.4 and 13.1 s: read backs of tapes seeded at 10 s began at 23 s;
//   - a read back step that read no new block (a locate paced to its turn a second on, a read answered in part) was
//     left to the next tick, 5 to 13 s on;
//   - the 12 locates, one wide read each on the chain's own RPC at a post a second, went one post at a time: the last
//     located at 34 to 86 s;
//   - a located read back asked all of a spread coin's spans at once, daybreak one call a post: 220 posts queued in its
//     3 places at 7 a second, and rounds of 14 to 20 s agreed none;
//   - a row waited for its trader behind the read backs' own reads (a lookup started ahead, in the background).
// With the read back going on at each hold's end, a refused locate counted as a fail would send a tape to the steps
// in seconds: a locate refused for our rate is held, never a fail, for LOCATE_HELD_MAX_MS. Not fixed here: pocket's
// 429 at 42 s held it 58 s, and every located tape waited it out with daybreak and the chain's own RPC free.
// The coins here: 12 Uniswap v3 pools against USDG, 60 swaps each, spaced as the 12 live coins' swaps over the day
// (SPACING), the newest 1,000 blocks before the head (inside the cold window, so the discovery finds each pool by its
// transfers and seeds its book). The providers as swaps-back-located.test.ts has them, at their real paces, every
// answer 400 ms late; the helper's tick every 8.8 s (the median of the six measured). Measured on this rig: at
// d59370557 six of the eight coins whose newest 50 trades lie in at most 30 of daybreak's 2,000-block spans filled past
// 45 s (48.8 to 83.0 s); now 16.2 to 39.5 s, and the four spread over 50 spans 51.5 to 53.9 s (27.4 to 77.0 s before):
// each of their 50 spans is a daybreak post of its own (one call a post, 7 a second), the bound left for a provider
// that serves old blocks in batches. The chain's own RPC's refusals (the rig's option) are asserted on their own below.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fakeChain, open, REC, timeAt } from "../../../test/evm-swaps/robinhood.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { HEADER_TIMED, ROBINHOOD_VENUES, SWAP_RPCS, TOPIC, TRADES_MAX } from "./swaps.ts";

const OWN = "https://rpc.mainnet.chain.robinhood.com";
const POCKET = "https://robinhood.api.pocket.network";
const DAYBREAK = "https://robinhood.daybreak-rpc.network";
const LATE_MS = 400;
/** The live checks' bound (scripts/live-checks/tape-read.mjs FILLED_MS). */
const FILLED_MS = 45_000;
/** The helper's tick of 12 books while they fill: 5.0 to 13.1 s, median 8.8 s (read from the Mac, above). */
const TICK_EVERY_MS = 8_800;
const HEAD = REC.lastHead;
const T_HEAD = timeAt(HEAD);
/** A block's time at Robinhood's 10 blocks a second, back from the head. */
const tsOf = (b: number) => T_HEAD - Math.ceil((HEAD - b) / 10);

const w = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const int = (x: bigint) => (x < 0n ? (1n << 256n) + x : x).toString(16).padStart(64, "0");
const ROUTER = `0x${"7e".repeat(20)}`;
const FEE = 3000n;
/** Each coin's blocks between two of its swaps: the 12 capacity coins' (live run 44008440768), the day's 864,000 blocks
 *  over the blocks their locate named (17 Nov 05:1xZ from the Mac: 3,417, 294, 1,267, 4,172, 175, 764, 1,762, 88, 4,219,
 *  154, 1,858 and 2,418), so a coin's newest 50 trades lie from 10 minutes to 16 hours back. */
const SPACING = [253, 2_939, 682, 207, 4_937, 1_131, 490, 9_818, 205, 5_610, 465, 357];
const PER_COIN = 60;
const TOKENS = Array.from({ length: 12 }, (_, i) => ({ token: `0x${(0xbe5000 + i).toString(16).padStart(40, "0")}`, pool: `0x${(0x9be5000 + i).toString(16).padStart(40, "0")}` }));

type L = { b: number; i: number; tx: string; a: string; t: string[]; d: string };
const SWAPS = new Map<string, L[]>();
const TRANSFERS = new Map<string, L[]>();
TOKENS.forEach(({ token, pool }, n) => {
  const sl: L[] = [];
  const tl: L[] = [];
  for (let k = 0; k < PER_COIN; k++) {
    const b = HEAD - 1_000 - k * SPACING[n]! - n;
    const tx = `0x${"ce".repeat(30)}${n.toString(16).padStart(2, "0")}${k.toString(16).padStart(2, "0")}`;
    const trader = `0x${tx.slice(26, 66)}`;
    const amt = 1_000n * 10n ** 18n + BigInt(k);
    const usd = 5_000_000n + BigInt(k);
    // a buy (token out of the pool, USDG in) every third swap, else a sell; the token's transfers through the router
    const buy = k % 3 === 0;
    const [a0, a1] = buy ? [-amt, usd] : [amt, -usd];
    sl.push({ b, i: 1, tx, a: pool, t: [TOPIC.swap3, w(ROUTER), w(ROUTER)], d: `0x${int(a0)}${int(a1)}${int(1n << 96n)}${int(10n ** 18n)}${int(0n)}` });
    const [from, to] = buy ? [pool, ROUTER] : [ROUTER, pool];
    tl.push({ b, i: 0, tx, a: token, t: [TOPIC.transfer, w(from), w(to)], d: `0x${int(amt)}` });
    tl.push({ b, i: 2, tx, a: token, t: [TOPIC.transfer, w(buy ? ROUTER : trader), w(buy ? trader : ROUTER)], d: `0x${int(amt)}` });
  }
  SWAPS.set(pool, sl.sort((x, y) => x.b - y.b || x.i - y.i));
  TRANSFERS.set(token, tl.sort((x, y) => x.b - y.b || x.i - y.i));
});

function rig(o: { ownFrom?: number; ownTo?: number; traderLateMs?: number } = {}) {
  const chain = fakeChain();
  chain.st.head = HEAD;
  chain.st.faults.set(OWN, { zeroTime: true, span: 1_000_000 });
  chain.st.faults.set(POCKET, { span: 10_000, addressOnly: true });
  chain.st.faults.set("https://rpc-robinhood.blockmachine.io", { span: 1_000, window: 5_000 });
  chain.st.faults.set(DAYBREAK, { span: 2_000 });
  let t0 = 0;
  /** The chain's own RPC's refusals: every post 429 (Retry-After 1) from `ownFrom` to `ownTo`. */
  const refused = (url: string): Response | null => {
    const at = clock.t - t0;
    if (url === OWN && o.ownFrom !== undefined && at >= o.ownFrom && at < (o.ownTo ?? Infinity)) return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    return null;
  };
  /** The pool log reads of each provider (eth_getLogs of one of the twelve pools), and its posts. */
  const reads = new Map<string, number>();
  const posts = new Map<string, number>();
  /** The blocks each eth_getLogs of the pools spans. */
  const spans: number[] = [];
  const wire = (l: L, zero: boolean) => ({ address: l.a, topics: l.t, data: l.d, blockNumber: `0x${l.b.toString(16)}`, logIndex: `0x${l.i.toString(16)}`, transactionHash: l.tx, blockTimestamp: `0x${(zero ? 0 : tsOf(l.b)).toString(16)}`, removed: false });
  const local = (url: string, r: { method: string; params: unknown[] }): unknown => {
    const f = chain.st.faults.get(url) ?? {};
    if (r.method === "eth_getBlockByNumber" && r.params[0] !== "latest" && parseInt(r.params[0] as string, 16) < REC.firstHead) {
      const n = parseInt(r.params[0] as string, 16);
      return { result: { number: `0x${n.toString(16)}`, timestamp: `0x${tsOf(n).toString(16)}` } };
    }
    if (r.method === "eth_getTransactionByHash") return { result: { hash: r.params[0], from: `0x${(r.params[0] as string).slice(26, 66)}` } };
    if (r.method === "eth_call") {
      const c = r.params[0] as { to: string; data: string };
      const p = TOKENS.find((x) => x.pool === c.to);
      if (p !== undefined) {
        if (c.data === "0xc45a0155") return { result: w(ROBINHOOD_VENUES.uniswapV3) };
        if (c.data === "0x0dfe1681") return { result: w(p.token) };
        if (c.data === "0xd21220a7") return { result: w(ROBINHOOD_VENUES.usdg) };
        if (c.data === "0xddca3f43") return { result: `0x${int(FEE)}` };
        return { error: { code: 3, message: "execution reverted" } };
      }
      if (c.to === ROBINHOOD_VENUES.uniswapV3 && c.data.startsWith("0x1698ee82")) {
        const q = TOKENS.find((x) => c.data === `0x1698ee82${w(x.token).slice(2)}${w(ROBINHOOD_VENUES.usdg).slice(2)}${int(FEE)}`);
        return { result: w(q?.pool ?? `0x${"0".repeat(40)}`) };
      }
      return undefined;
    }
    if (r.method !== "eth_getLogs") return undefined;
    const q = r.params[0] as { address?: string; topics?: (string | string[])[]; fromBlock: string; toBlock: string };
    const mine = q.address === undefined ? undefined : (SWAPS.get(q.address) ?? TRANSFERS.get(q.address));
    if (mine === undefined) return undefined;
    const [from, to] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
    if (to > HEAD || to - from + 1 > (f.span ?? 100)) return { error: { code: -32602, message: "eth_getLogs block range exceeds 100 blocks" } };
    if (f.window !== undefined && from < HEAD - f.window) return { error: { code: -32011, message: "block reference is outside the public history window" } };
    if (SWAPS.has(q.address!)) reads.set(url, (reads.get(url) ?? 0) + 1), spans.push(to - from + 1);
    const want = [q.topics?.[0]].flat();
    return { result: mine.filter((l) => l.b >= from && l.b <= to && want.includes(l.t[0])).map((l) => wire(l, f.zeroTime === true)) };
  };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    // a post that looks up a trader (eth_getTransactionByHash) answered `traderLateMs` late on top
    const late = o.traderLateMs !== undefined && String(init.body).includes("eth_getTransactionByHash") ? o.traderLateMs : 0;
    await new Promise((go) => setTimeout(go, LATE_MS + late));
    posts.set(url, (posts.get(url) ?? 0) + 1);
    const f = chain.st.faults.get(url) ?? {};
    if (f.down) return new Response("down", { status: 503 });
    const no = refused(url);
    if (no) return no;
    const reqs = [JSON.parse(String(init.body))].flat() as { id: number; method: string; params: unknown[] }[];
    const mine = reqs.map((r) => local(url, r));
    const rest = reqs.filter((_, i) => mine[i] === undefined);
    const fwd = rest.length === 0 ? [] : ((await (await chain.fetch(url, { ...init, body: JSON.stringify(rest) })).json()) as { id: number }[]);
    const out = reqs.map((r, i) => (mine[i] !== undefined ? { jsonrpc: "2.0", id: r.id, ...(mine[i] as object) } : fwd.find((x) => x.id === r.id)));
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { chain, fetch, reads, posts, spans, start: () => (t0 = clock.t) };
}

/** The swaps' injected clock (open's `now`), and the one every time here is read on: each test runs in onVirtualTime,
 *  so it is the virtual clock the timers move, never the machine's. */
const clock = { get t() { return Date.now(); } };

/** How long the rig runs: past the live checks' bound, so a tape that fills after it is timed too. */
const RUN_MS = 120_000;
/** The 2,000-block spans (daybreak's BACK_SPAN) a coin's newest 50 trades lie in: a located read back reads
 *  BACK_ROUND_SPANS of them a round. */
const SPANS_OF = (n: number) => new Set(SWAPS.get(TOKENS[n]!.pool)!.slice(-TRADES_MAX).map((l) => Math.floor((HEAD - l.b) / 2_000))).size;

/** The 12 coins opened at once on the rig: each tape's time to its newest 50 trades, filling false, from the open. */
async function fillTimes(r: ReturnType<typeof rig>, only: number[] = TOKENS.map((_, n) => n), runMs = RUN_MS) {
  const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms));
  const { value } = await onVirtualTime(9_000_000, async () => {
    r.start();
    const t0 = clock.t;
    const s = open(r.chain, clock, { pools: new Map(), rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never });
    let over = false;
    // each tape read as the page reads it, 3 s apart while it fills; its time the answer's that holds the whole tape
    const poll = async (n: number): Promise<{ ms: number | null; n: number; filling: boolean }> => {
      const { token, pool } = TOKENS[n]!;
      let last = { n: -1, filling: true };
      while (!over) {
        const a = await s.trades(token, 50);
        const j = a.status === 200 ? (JSON.parse(a.body) as { trades: { tx: unknown }[]; filling?: boolean }) : null;
        last = { n: j?.trades.length ?? -1, filling: j?.filling === true };
        if (j !== null && j.filling !== true) {
          // settled: the whole tape, newest first, or it settled short
          const whole = j.trades.length === TRADES_MAX && j.trades[0]!.tx === SWAPS.get(pool)!.at(-1)!.tx;
          return { ms: whole ? clock.t - t0 : null, ...last };
        }
        await sleep(3_000);
      }
      return { ms: null, ...last };
    };
    const polls = Promise.all(only.map((n) => poll(n)));
    // the helper's tick, as slow as 12 filling books made it
    for (let i = 0; i < runMs / TICK_EVERY_MS; i++) {
      await sleep(TICK_EVERY_MS);
      await s.tick();
    }
    over = true;
    const got = await polls;
    s.stop();
    return got;
  });
  return value;
}

test("card robinhood-trades-finish-filling: 12 Robinhood coins the discovery finds, opened at once with the helper's tick 8.8 s apart, each at its live coin's trades over the day: the 8 whose newest 50 trades lie in at most 30 of daybreak's 2,000-block spans answer them, filling false, inside the live checks' 45 s, and the 4 spread over 50 spans inside 60 s (red at d59370557: a seeded tape read back only from a tick, a step that read no new block waited the next, each locate waited for a post of its own, and a spread coin asked all its spans at once: six of the eight past 45 s, the slowest at 83 s)", async () => {
  const r = rig({});
  const got = await fillTimes(r);
  const line = got.map((g, n) => `${TOKENS[n]!.token.slice(-4)} ${SPANS_OF(n)} spans ${g.ms === null ? `not filled (n${g.n}${g.filling ? " filling" : " settled"})` : `${(g.ms / 1000).toFixed(1)} s`}`).join(", ");
  console.log(`${line}; pool log reads: ${[...r.reads].map(([u, n]) => `${new URL(u).hostname} ${n}`).join(", ")}; posts: ${[...r.posts].map(([u, n]) => `${new URL(u).hostname} ${n}`).join(", ")}`);
  got.forEach((g, n) => {
    assert.notEqual(g.ms, null, `a tape not filled with its newest 50 trades: ${line}`);
    assert.ok(g.ms! <= (SPANS_OF(n) <= 30 ? FILLED_MS : 60_000), `${TOKENS[n]!.token.slice(-4)} past its bound: ${line}`);
  });
  // every swap shown was read from two providers, never the locate's untimed word alone
  assert.ok((r.reads.get(DAYBREAK) ?? 0) > 0 && (r.reads.get(POCKET) ?? 0) > 0, `the read back asked daybreak and pocket: ${[...r.reads].join(" ")}`);
});

test("card robinhood-trades-finish-filling: a coin whose locate the chain's own RPC refuses 429 for 20 s is still located, not read in 10,000-block steps: a refusal is one held locate, never a fail and a hold (red at d59370557: each refusal counted two of BACK_FAILS_MAX, and the day was read in steps)", async () => {
  const r = rig({ ownFrom: 0, ownTo: 20_000 });
  const [g] = await fillTimes(r, [3], 90_000);
  const steps = r.spans.filter((n) => n === 10_000).length;
  assert.notEqual(g!.ms, null, `not filled (n${g!.n})`);
  assert.equal(steps, 0, `the day read in ${steps} steps of 10,000 blocks`);
});

/** Each coin opened alone, at 909222c27 (#943, the located read back before this card) on this rig: its time to its
 *  newest 50 trades, its posts and its pool log reads. */
const SOLO_909 = [
  { what: "busy", n: 8, ms: 11_800, posts: 56, reads: 30 },
  { what: "medium", n: 6, ms: 12_000, posts: 68, reads: 40 },
  { what: "medium", n: 2, ms: 14_800, posts: 83, reads: 54 },
  { what: "quiet", n: 7, ms: 17_800, posts: 152, reads: 122 },
];

test("card robinhood-trades-finish-filling: a coin opened alone, busy (its newest 50 trades in 6 spans), medium (13 and 18 spans: a few steps past the newest) or quiet (50 spans), fills no later than at 909222c27 and reads no more pool logs; the busy coin sends no more posts (at 909222c27: busy 11.8 s 56 posts 30 reads, medium 12.0 s 68/40 and 14.8 s 83/54, quiet 17.8 s 152/122; now 5.8 s 54/28, 8.8 s 69/40 and 8.8 s 87/54, 15.2 s 169/120: rounds of BACK_ROUND_SPANS cost a medium coin up to 4 posts more, a quiet one 17)", async () => {
  for (const b of SOLO_909) {
    const r = rig({});
    const [g] = await fillTimes(r, [b.n], 120_000);
    const posts = [...r.posts.values()].reduce((x, y) => x + y, 0);
    const reads = [...r.reads.values()].reduce((x, y) => x + y, 0);
    const line = `${b.what} ${SPANS_OF(b.n)} spans: ${g!.ms === null ? "not filled" : `${(g!.ms / 1000).toFixed(1)} s`}, ${posts} posts, ${reads} pool reads (909222c27: ${(b.ms / 1000).toFixed(1)} s, ${b.posts}, ${b.reads})`;
    console.log(line);
    assert.ok(g!.ms !== null && g!.ms <= b.ms, `slower than at 909222c27: ${line}`);
    assert.ok(reads <= b.reads, `more pool reads than at 909222c27: ${line}`);
    if (b.what === "busy") assert.ok(posts <= b.posts, `a busy coin sent more posts than at 909222c27: ${line}`);
  }
});

test("card robinhood-trades-finish-filling: an answer's rows and its filling are of one moment: a coin whose read back ends while an answer waits on its rows' traders (each trader lookup 5 s late) never answers filling false over the rows taken before the read back ended (red at 70adfdca3: rows taken before the traders' wait, filling judged after it, so the answer said done with part of the tape)", async () => {
  const r = rig({ traderLateMs: 5_000 });
  const { token, pool } = TOKENS[2]!;
  const newest = SWAPS.get(pool)!.at(-1)!.tx;
  const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms));
  const { value } = await onVirtualTime(9_000_000, async () => {
    r.start();
    const t0 = clock.t;
    const s = open(r.chain, clock, { pools: new Map(), rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never });
    const seen: { ms: number; n: number; filling: boolean; whole: boolean; newest: boolean }[] = [];
    let over = false;
    // readers 500 ms apart, each its own call, so one is waiting on traders whenever the read back ends
    const reader = async (lag: number) => {
      await sleep(lag);
      while (!over) {
        const a = await s.trades(token, TRADES_MAX);
        if (a.status === 200) {
          const j = JSON.parse(a.body) as { trades: { tx: string }[]; filling?: boolean; whole_ms?: number };
          seen.push({ ms: clock.t - t0, n: j.trades.length, filling: j.filling === true, whole: j.whole_ms !== undefined, newest: j.trades[0]?.tx === newest });
        }
        await sleep(500);
      }
    };
    const readers = Promise.all([0, 500, 1_000, 1_500, 2_000, 2_500].map(reader));
    for (let i = 0; i < 60_000 / TICK_EVERY_MS; i++) {
      await sleep(TICK_EVERY_MS);
      await s.tick();
    }
    over = true;
    await readers;
    s.stop();
    return seen;
  });
  const done = value.filter((a) => !a.filling);
  const short = done.filter((a) => a.n !== TRADES_MAX || !a.newest);
  console.log(`${value.length} answers, ${done.length} filling false, the first at ${done[0]?.ms} ms; filling false short of the tape: ${JSON.stringify(short.slice(0, 5))}`);
  assert.ok(done.length > 0, "the tape never filled");
  assert.deepEqual(short, [], "an answer said filling false over rows taken before the read back ended");
});

test("card robinhood-trades-finish-filling: each locate provider has its own line (queue, post out, locates asked alone), keyed by its URL, so a second BACK_LOCATE provider's locates are never sent in the first one's post (a source pin: BACK_LOCATE is one URL today and not injectable; red at 70adfdca3: one module-wide queue and out flag)", () => {
  const src = readFileSync(new URL("./swaps.ts", import.meta.url), "utf8");
  assert.match(src, /type LocateLine = \{ queue: LocateAsk\[\]; out: boolean; alone: Set<string> \};\n  const locateLines = new Map<string, LocateLine>\(\)/, "the locate lines are a Map from the provider's URL");
  const pump = src.slice(src.indexOf("async function locatePump("), src.indexOf("\n  }\n", src.indexOf("async function locatePump(")));
  assert.ok(pump.length > 0, "locatePump found");
  assert.match(pump, /^async function locatePump\(u: string, l: LocateLine\)/, "the pump is handed its URL's line");
  assert.doesNotMatch(src, /\blocate(Queue|Out|Alone)\b/, "no module-wide locate queue, out flag or alone set");
  // every queue, out and alone the pump touches is its line's
  for (const m of pump.matchAll(/\b(queue|out)\b|\b(alone)\.(?:add|delete|size|has)/g)) assert.equal(pump.slice(m.index - 2, m.index), "l.", `locatePump touches ${m[1] ?? m[2]} off its line at ${pump.slice(Math.max(0, m.index - 20), m.index + 10)}`);
});
