// node --test apps/helper/src/data/evm/swaps-tapes-ahead.test.ts: card robinhood-tapes-read-ahead. Live helper run
// 44279880076 (18 Nov 10:17Z, helper at ff65a0403): 10 of the 12 listed Robinhood coins opened cold were "still filling
// 45xxx ms after its first read (21 reads), past 45000 ms" in index-evm-swaps, robinhood-spread-tapes-fill-inside-45s,
// robinhood-listed-tape-opens and helper-robinhood-capacity. A book rested past IDLE_MS reopens at once (card
// robinhood-spread-tapes-fill-inside-45s), but a coin nobody had opened was read from nothing at its first open: its pool
// was looked for ahead (helper-robinhood-search-ahead), its tape only when a page asked, a dozen at once. Now the lists'
// coins' tapes are read ahead too (swaps.ts ahead), in the helper's background lane, at most AHEAD_AT_ONCE at a time,
// none started while a first open waits for its pool or while a provider is held, and rested ready for the first open.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as base from "../../../test/evm-swaps/base.ts";
import { fakeChain, open, REC, timeAt, URLS } from "../../../test/evm-swaps/robinhood.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { providerHolds } from "../../limits/limits.ts";
import { HEADER_TIMED, OPEN_BOUND_MS, ROBINHOOD_VENUES, SWAP_RPCS, TOPIC, type Pool } from "./swaps.ts";

const CHAIN_RPC = "https://rpc.mainnet.chain.robinhood.com";
const POCKET = "https://robinhood.api.pocket.network";
const WIDE = ["https://robinhood.daybreak-rpc.network", "https://rpc-robinhood.blockmachine.io", POCKET, CHAIN_RPC];
/** Each provider's answer, this many virtual ms after its post (swaps-search.test.ts: the live answers under load). */
const LATE_MS = 700;

const w = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const int = (x: bigint) => (x < 0n ? (1n << 256n) + x : x).toString(16).padStart(64, "0");
const ROUTER = `0x${"7e".repeat(20)}`;
const FEE = 3000n;
/** Thirteen tokens, each traded only on its own Uniswap v3 pool against USDG: 20 swaps, spread over the hour before the
 *  head (a spread coin: its tape is short of TRADES_MAX, so a cold open reads the day back before it is whole). The
 *  first twelve are the lists'; the last is a coin a page opens that no list carries yet. */
const TOKENS = Array.from({ length: 13 }, (_, i) => ({ token: `0x${(0xa4ead00 + i).toString(16).padStart(40, "0")}`, pool: `0x${(0x9a4ead00 + i).toString(16).padStart(40, "0")}` }));
const LISTED = TOKENS.slice(0, 12);
const PAGE = TOKENS[12]!;
const SWAPS = 20;
const http429 = (s = 20) => new Response("{}", { status: 429, headers: { "retry-after": String(s) } });

/** The fake chain behind the real Robinhood provider list (swaps-search.test.ts's rig: the wide providers take 1,000
 *  blocks, the chain's own RPC the day in one read), every answer LATE_MS late. Counts each post, each 429 and each
 *  pool's swap reads; `limit` refuses a provider's posts past that many in a second (429, its Retry-After 1 s). */
function rig(o: { limit?: number } = {}) {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  // each provider as live (swaps-back-resume.test.ts): the chain's own RPC the day in one read, untimed; pocket and
  // daybreak old blocks in their BACK_SPAN; blockmachine the newest 5,000 blocks
  for (const u of WIDE) chain.st.faults.set(u, { span: 1_000 });
  chain.st.faults.set(CHAIN_RPC, { zeroTime: true, span: 1_000_000 });
  chain.st.faults.set(POCKET, { span: 10_000, addressOnly: true });
  chain.st.faults.set("https://rpc-robinhood.blockmachine.io", { span: 1_000, window: 5_000 });
  chain.st.faults.set("https://robinhood.daybreak-rpc.network", { span: 2_000 });
  const head = REC.lastHead;
  const tHead = timeAt(head);
  /** A block's time at Robinhood's 10 blocks a second, back from the head. */
  const at = (b: number) => tHead - Math.ceil((head - b) / 10);
  type L = { b: number; i: number; tx: string; a: string; t: string[]; d: string };
  const transfers = new Map<string, L[]>();
  const swaps = new Map<string, L[]>();
  TOKENS.forEach(({ token, pool }, n) => {
    const tl: L[] = [];
    const sl: L[] = [];
    for (let k = 0; k < SWAPS; k++) {
      // one swap every 1,700 blocks (about 3 minutes) back from the head: the newest in the cold window, the rest older
      const b = head - 100 - k * 1_700 - n;
      const tx = `0x${"cd".repeat(30)}${n.toString(16).padStart(2, "0")}${k.toString(16).padStart(2, "0")}`;
      const trader = `0x${tx.slice(26, 66)}`;
      const amt = 1_000n * 10n ** 18n + BigInt(k);
      tl.push({ b, i: 0, tx, a: token, t: [TOPIC.transfer, w(pool), w(ROUTER)], d: `0x${int(amt)}` });
      sl.push({ b, i: 1, tx, a: pool, t: [TOPIC.swap3, w(ROUTER), w(ROUTER)], d: `0x${int(-amt)}${int(5_000_000n + BigInt(k))}${int(1n << 96n)}${int(10n ** 18n)}${int(0n)}` });
      tl.push({ b, i: 2, tx, a: token, t: [TOPIC.transfer, w(ROUTER), w(trader)], d: `0x${int(amt)}` });
    }
    transfers.set(token, tl.reverse());
    swaps.set(pool, sl.reverse());
  });
  const n = { posts: 0, refused: 0, poolReads: new Map<string, number>() };
  const sent = new Map<string, number[]>();
  const wire = (l: L, zero: boolean) => ({ address: l.a, topics: l.t, data: l.d, blockNumber: `0x${l.b.toString(16)}`, logIndex: `0x${l.i.toString(16)}`, transactionHash: l.tx, blockTimestamp: `0x${(zero ? 0 : at(l.b)).toString(16)}`, removed: false });
  const local = (url: string, r: { method: string; params: unknown[] }): unknown => {
    const f = chain.st.faults.get(url) ?? {};
    if (r.method === "eth_getBlockByNumber" && r.params[0] !== "latest" && parseInt(r.params[0] as string, 16) < REC.firstHead) {
      const b = parseInt(r.params[0] as string, 16);
      return { result: { number: `0x${b.toString(16)}`, timestamp: `0x${at(b).toString(16)}` } };
    }
    if (r.method === "eth_getTransactionByHash") return { result: { hash: r.params[0], from: `0x${(r.params[0] as string).slice(26, 66)}` } };
    if (r.method === "eth_getLogs") {
      const q = r.params[0] as { address?: string | string[]; topics?: (string | string[])[]; fromBlock: string; toBlock: string };
      const [from, to] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
      const addrs = [q.address].flat().filter((a): a is string => typeof a === "string");
      if (addrs.length === 0 || !addrs.some((a) => transfers.has(a) || swaps.has(a))) return undefined;
      if (to > head || to - from + 1 > (f.span ?? 100)) return { error: { code: -32602, message: "eth_getLogs block range exceeds 100 blocks" } };
      if (f.window !== undefined && from < head - f.window) return { error: { code: -32011, message: "block reference is outside the public history window" } };
      for (const a of addrs) if (swaps.has(a)) n.poolReads.set(a, (n.poolReads.get(a) ?? 0) + 1);
      const want = (q.topics?.[0] === undefined || q.topics[0] === null ? null : [q.topics[0]].flat());
      return { result: addrs.flatMap((a) => transfers.get(a) ?? swaps.get(a) ?? []).filter((l) => l.b >= from && l.b <= to && (want === null || want.includes(l.t[0]!))).sort((x, y) => x.b - y.b || x.i - y.i).map((l) => wire(l, f.zeroTime === true)) };
    }
    if (r.method !== "eth_call") return undefined;
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
  };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    n.posts++;
    if (o.limit !== undefined) {
      const t = Date.now();
      const mine = (sent.get(url) ?? []).filter((x) => t - x < 1_000);
      mine.push(t);
      sent.set(url, mine);
      if (mine.length > o.limit) {
        n.refused++;
        return http429(1);
      }
    }
    await new Promise((go) => setTimeout(go, LATE_MS));
    const reqs = [JSON.parse(String(init.body))].flat() as { id: number; method: string; params: unknown[] }[];
    const mine = reqs.map((r) => local(url, r));
    const rest = reqs.filter((_, i) => mine[i] === undefined);
    const fwd = rest.length === 0 ? [] : ((await (await chain.fetch(url, { ...init, body: JSON.stringify(rest) })).json()) as { id: number }[]);
    const out = reqs.map((r, i) => (mine[i] !== undefined ? { jsonrpc: "2.0", id: r.id, ...(mine[i] as object) } : fwd.find((x) => x.id === r.id)));
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { chain, fetch, n };
}

const clock = { get t() { return Date.now(); } };
const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms));
type Tape = { status: number; filling: boolean; n: number; ms: number };
const tapeOf = (a: { status: number; body: string }, ms: number): Tape => {
  const j = a.status === 200 ? (JSON.parse(a.body) as { trades: unknown[]; filling?: boolean }) : null;
  return { status: a.status, filling: j?.filling === true, n: j?.trades.length ?? -1, ms };
};
const line = (got: Tape[], toks = TOKENS) => got.map((g, i) => `${toks[i]!.token.slice(-2)} ${g.status}${g.filling ? " filling" : ""} n${g.n} ${(g.ms / 1000).toFixed(1)} s`).join(", ");

test("card robinhood-tapes-read-ahead: Robinhood, 12 listed spread coins nobody opened, the lists loaded a minute before a page opens them all at once: every first answer is the whole list (20 trades, not filling), within the open's bound (red at f5049c481: each read its tape from nothing at its first open, its first answer filling, 2.1 to 8.0 s)", async () => {
  const r = rig();
  const { value } = await onVirtualTime(9_000_000, async () => {
    const s = open(r.chain, clock, { pools: new Map(), rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never });
    // the lists' answer loads (server.ts evmSwapsFromEnv calls ahead with its tokens), and a minute passes
    void s.ahead(LISTED.map((x) => x.token));
    await sleep(60_000);
    const t0 = Date.now();
    const got = await Promise.all(LISTED.map(({ token }) => s.trades(token, 50).then((a) => tapeOf(a, Date.now() - t0))));
    s.stop();
    return got;
  });
  const l = line(value);
  console.log(`first answers: ${l}`);
  for (const g of value) {
    assert.equal(g.status, 200, l);
    assert.equal(g.filling, false, `a first answer still filling: ${l}`);
    assert.equal(g.n, SWAPS, `the coin's whole list: ${l}`);
    assert.ok(g.ms < OPEN_BOUND_MS, `a first answer at the open's bound: ${l}`);
  }
});

test("card robinhood-tapes-read-ahead: Base, a listed coin nobody opened, the lists loaded before its first open: the first answer is its whole list at once, the list a cold open reads (red at f5049c481: the first open read it from nothing)", async () => {
  const run = async (ahead: boolean) => {
    const c = base.fakeChain();
    c.st.head = base.REC.firstHead + 200;
    const clk = { t: 5_000_000 };
    const s = base.open(c, clk, {});
    try {
      if (ahead) await s.ahead([base.VVV]);
      const a = await s.trades(base.VVV, 50);
      assert.equal(a.status, 200, a.body);
      return JSON.parse(a.body) as { trades: { tx: string }[]; filling?: true };
    } finally {
      s.stop();
    }
  };
  const cold = await run(false);
  const ahead = await run(true);
  console.log(`base: cold first answer ${cold.trades.length} trades${cold.filling ? " filling" : ""}; read ahead ${ahead.trades.length}${ahead.filling ? " filling" : ""}`);
  assert.equal(ahead.filling, undefined, `the first answer after the read ahead is still filling: ${JSON.stringify(ahead).slice(0, 200)}`);
  assert.deepEqual(ahead.trades.map((r) => r.tx), (await (async () => {
    // the list a cold open reads once it is whole (settled by ticks), the same as the read ahead's
    const c = base.fakeChain();
    c.st.head = base.REC.firstHead + 200;
    const s = base.open(c, { t: 5_000_000 }, {});
    try {
      let j = JSON.parse((await s.trades(base.VVV, 50)).body) as { trades: { tx: string }[]; filling?: true };
      for (let i = 0; i < 20 && j.filling === true; i++) {
        await s.tick();
        j = JSON.parse((await s.trades(base.VVV, 50)).body) as typeof j;
      }
      return j.trades.map((r) => r.tx);
    } finally {
      s.stop();
    }
  })()), "the read ahead's list is the one a cold open settles on");
  assert.ok(cold.filling === true, "the rig's cold first open fills (else this test proves nothing)");
});

test("card robinhood-tapes-read-ahead: a page's open of a coin no list carries, arriving while the lists' 12 tapes are read ahead, answers as fast as with no read ahead running (its posts go first: the read ahead is the background lane and starts no tape while a first open waits)", async () => {
  const pageOpen = async (withAhead: boolean) => {
    const r = rig();
    const { value } = await onVirtualTime(9_000_000, async () => {
      const s = open(r.chain, clock, { pools: new Map(), rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never });
      if (withAhead) {
        void s.ahead(LISTED.map((x) => x.token));
        await sleep(3_000);
      }
      const t0 = Date.now();
      const a = await s.trades(PAGE.token, 50);
      const got = tapeOf(a, Date.now() - t0);
      s.stop();
      return got;
    });
    return value;
  };
  const alone = await pageOpen(false);
  const mid = await pageOpen(true);
  console.log(`page open alone ${alone.ms} ms (${alone.status}${alone.filling ? " filling" : ""} n${alone.n}), mid read ahead ${mid.ms} ms (${mid.status}${mid.filling ? " filling" : ""} n${mid.n})`);
  assert.equal(mid.status, 200);
  assert.ok(mid.n > 0, "the page's coin answered its trades");
  assert.ok(mid.ms <= alone.ms + 2 * LATE_MS, `the page's open took ${mid.ms} ms mid read ahead, ${alone.ms} ms alone`);
});

test("card robinhood-tapes-read-ahead: a provider held (its 429) when the lists load: no tape is read ahead (no pool read at all, the pools kept); once no provider is held the next lists answer reads them, and their first opens are whole", async () => {
  const r = rig();
  // the two coins' pools kept (an earlier search's), so every pool read here is a tape's
  const kept = new Map(LISTED.slice(0, 2).map(({ token, pool }) => [token, { pool: { venue: "v3", id: pool, token, tokenIs0: true, quote: { kind: "usd", decimals: 6 } } as Pool, decimals: 18 }]));
  const { value } = await onVirtualTime(9_000_000, async () => {
    const holds = providerHolds(() => Date.now());
    holds.hold(POCKET, 30);
    const s = open(r.chain, clock, { pools: kept, rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never, holds });
    await s.ahead(LISTED.slice(0, 2).map((x) => x.token));
    const held = LISTED.slice(0, 2).map(({ pool }) => r.n.poolReads.get(pool) ?? 0);
    await sleep(31_000);
    await s.ahead(LISTED.slice(0, 2).map((x) => x.token));
    const after = LISTED.slice(0, 2).map(({ pool }) => r.n.poolReads.get(pool) ?? 0);
    const t0 = Date.now();
    const got = await Promise.all(LISTED.slice(0, 2).map(({ token }) => s.trades(token, 50).then((a) => tapeOf(a, Date.now() - t0))));
    s.stop();
    return { held, after, got };
  });
  console.log(`pool reads while held ${value.held.join(", ")}; after ${value.after.join(", ")}; ${line(value.got)}`);
  for (const x of value.held) assert.equal(x, 0, `a tape was read ahead while a provider was held: ${value.held.join(", ")}`);
  for (const x of value.after) assert.ok(x > 0, `no tape was read ahead once no provider was held: ${value.after.join(", ")}`);
  for (const g of value.got) assert.equal(g.filling, false, `read ahead once no provider was held: ${line(value.got)}`);
});

test("card robinhood-tapes-read-ahead: posts and 429s against the base, every provider refusing past 4 posts a second: the lists load and answer again each minute (LIST_MS), three minutes on a page opens the 12 at once and reads each until whole; every tape whole by 45 s (FILLED_MS), the posts and 429s printed (red at f5049c481: all 12 still filling at 45 s, 6 to 20 trades each, the opens' 429s 104 of 435 posts; now whole by 5.1 s, 7 of 67)", async () => {
  const r = rig({ limit: 4 });
  const { value } = await onVirtualTime(9_000_000, async () => {
    const s = open(r.chain, clock, { pools: new Map(), rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never });
    // the read ahead stops at a provider's hold (its 429) and the lists' next answer asks again
    for (let k = 0; k < 3; k++) {
      void s.ahead(LISTED.map((x) => x.token));
      await sleep(60_000);
    }
    const before = { posts: r.n.posts, refused: r.n.refused };
    const t0 = Date.now();
    let over = false;
    const latest = new Map<string, Tape>();
    const poll = async (token: string) => {
      while (!over) {
        const a = await s.trades(token, 50);
        const g = tapeOf(a, Date.now() - t0);
        latest.set(token, g);
        if (g.status === 200 && !g.filling) return;
        await sleep(2_000);
      }
    };
    const polls = Promise.all(LISTED.map(({ token }) => poll(token)));
    const bound = sleep(45_000).then(() => (over = true));
    while (!over && [...latest.values()].filter((g) => !g.filling && g.status === 200).length < LISTED.length) {
      await sleep(1_000);
      await s.tick();
    }
    over = true;
    void bound;
    await polls;
    s.stop();
    return { got: LISTED.map(({ token }) => latest.get(token)!), ahead: before, opens: { posts: r.n.posts - before.posts, refused: r.n.refused - before.refused } };
  });
  const l = line(value.got);
  console.log(`429s: read ahead ${value.ahead.refused} of ${value.ahead.posts} posts; the opens' ${value.opens.refused} of ${value.opens.posts} posts; ${l}`);
  for (const g of value.got) {
    assert.equal(g.status, 200, l);
    assert.equal(g.filling, false, `a tape still filling at 45 s: ${l}`);
  }
});
