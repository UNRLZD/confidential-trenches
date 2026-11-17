// node --test apps/helper/src/data/evm/swaps-back-located.test.ts: card robinhood-trades-finish-filling. A dozen
// Robinhood coins whose trades lie apart over the day, opened at once, each finish filling inside the live checks' 45 s.
// Helper release 178 (e570f96db), live run 43989230034: helper-robinhood-capacity had 8 of 12 tapes and
// helper-robinhood-search-ahead 5 of 12 still filling 45.8 s after their first read. Solo, 0xe934e36a filled in 32 s:
// its 50 trades span 179 minutes, and after the one wide read of the day (locate) named their blocks, the read back still
// read one agreed 10,000-block step under each (pocket one read a step, daybreak five, one call a post), a step after a
// step. A located read back now reads only the blocks the locate named, packed into the spans each provider takes
// (BACK_SPAN) and batched: a few posts a tape, still each block agreed on two providers.
//
// The coins here: 12 Uniswap v3 pools against USDG, 60 swaps each in 20 bursts of 3 (a buy and two sells within 40
// blocks), the bursts 10,000 blocks (a read back step) apart, the newest 4,000 blocks before the head (past the cold
// window): about 20 steps of the day. The providers as swaps-day-tape.test.ts has them (read from the Mac 15 Nov 23:2xZ:
// the chain's own RPC and pocket serve 10,000 blocks of old blocks a call, the chain's own untimed; daybreak 2,000;
// blockmachine the newest 5,000), at their real paces (limits.ts PROVIDER_PACE), every answer 400 ms late.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, open, REC, timeAt } from "../../../test/evm-swaps/robinhood.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { HEADER_TIMED, INDEX_RPCS, SWAP_RPCS, TOPIC, TRADES_MAX, type Pool } from "./swaps.ts";

const OWN = "https://rpc.mainnet.chain.robinhood.com";
const POCKET = "https://robinhood.api.pocket.network";
const DAYBREAK = "https://robinhood.daybreak-rpc.network";
const LATE_MS = 400;
/** The live checks' bound (scripts/live-checks/tape-read.mjs FILLED_MS). */
const FILLED_MS = 45_000;
const HEAD = REC.lastHead;
const T_HEAD = timeAt(HEAD);
/** A block's time at Robinhood's 10 blocks a second, back from the head. */
const tsOf = (b: number) => T_HEAD - Math.ceil((HEAD - b) / 10);

const w = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const int = (x: bigint) => (x < 0n ? (1n << 256n) + x : x).toString(16).padStart(64, "0");
const ROUTER = `0x${"7e".repeat(20)}`;
const BURSTS = 20;
const PER_BURST = 3;
const TOKENS = Array.from({ length: 12 }, (_, i) => ({ token: `0x${(0xba0c00 + i).toString(16).padStart(40, "0")}`, pool: `0x${(0x9ba0c00 + i).toString(16).padStart(40, "0")}` }));
const POOLS = new Map(TOKENS.map(({ token, pool }) => [token, { pool: { venue: "v3", id: pool, token, tokenIs0: true, quote: { kind: "usd", decimals: 6 } } as Pool, decimals: 18 }]));

type L = { b: number; i: number; tx: string; a: string; t: string[]; d: string };
const SWAPS = new Map<string, L[]>();
TOKENS.forEach(({ pool }, n) => {
  const logs: L[] = [];
  for (let k = 0; k < BURSTS; k++)
    for (let j = 0; j < PER_BURST; j++) {
      const b = HEAD - 4_000 - k * 10_000 - j * 20 - n * 7;
      const tx = `0x${"cd".repeat(29)}${n.toString(16).padStart(2, "0")}${k.toString(16).padStart(2, "0")}${j.toString(16).padStart(2, "0")}`;
      const amt = 1_000n * 10n ** 18n + BigInt(k * 10 + j);
      const usd = 5_000_000n + BigInt(k * 10 + j);
      // a buy (token out of the pool, USDG in), then two sells
      const [a0, a1] = j === 0 ? [-amt, usd] : [amt, -usd];
      logs.push({ b, i: 1, tx, a: pool, t: [TOPIC.swap3, w(ROUTER), w(ROUTER)], d: `0x${int(a0)}${int(a1)}${int(1n << 96n)}${int(10n ** 18n)}${int(0n)}` });
    }
  SWAPS.set(pool, logs.sort((x, y) => x.b - y.b));
});

function rig() {
  const chain = fakeChain();
  chain.st.head = HEAD;
  chain.st.faults.set(OWN, { zeroTime: true, span: 1_000_000 });
  chain.st.faults.set(POCKET, { span: 10_000, addressOnly: true });
  chain.st.faults.set("https://rpc-robinhood.blockmachine.io", { span: 1_000, window: 5_000 });
  chain.st.faults.set(DAYBREAK, { span: 2_000 });
  /** Each provider's eth_getLogs of the twelve pools. */
  const reads = new Map<string, number>();
  const wire = (l: L, zero: boolean) => ({ address: l.a, topics: l.t, data: l.d, blockNumber: `0x${l.b.toString(16)}`, logIndex: `0x${l.i.toString(16)}`, transactionHash: l.tx, blockTimestamp: `0x${(zero ? 0 : tsOf(l.b)).toString(16)}`, removed: false });
  const local = (url: string, r: { method: string; params: unknown[] }): unknown => {
    const f = chain.st.faults.get(url) ?? {};
    if (r.method === "eth_getBlockByNumber" && r.params[0] !== "latest" && parseInt(r.params[0] as string, 16) < REC.firstHead) {
      const n = parseInt(r.params[0] as string, 16);
      return { result: { number: `0x${n.toString(16)}`, timestamp: `0x${tsOf(n).toString(16)}` } };
    }
    if (r.method === "eth_getTransactionByHash") return { result: { hash: r.params[0], from: `0x${(r.params[0] as string).slice(26, 66)}` } };
    if (r.method !== "eth_getLogs") return undefined;
    const q = r.params[0] as { address?: string; topics?: (string | string[])[]; fromBlock: string; toBlock: string };
    const mine = q.address === undefined ? undefined : SWAPS.get(q.address);
    if (mine === undefined) return undefined;
    const [from, to] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
    if (to > HEAD || to - from + 1 > (f.span ?? 100)) return { error: { code: -32602, message: "eth_getLogs block range exceeds 100 blocks" } };
    if (f.window !== undefined && from < HEAD - f.window) return { error: { code: -32011, message: "block reference is outside the public history window" } };
    reads.set(url, (reads.get(url) ?? 0) + 1);
    const want = [q.topics?.[0]].flat();
    return { result: mine.filter((l) => l.b >= from && l.b <= to && want.includes(l.t[0])).map((l) => wire(l, f.zeroTime === true)) };
  };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    await new Promise((go) => setTimeout(go, LATE_MS));
    const f = chain.st.faults.get(url) ?? {};
    if (f.down) return new Response("down", { status: 503 });
    const reqs = [JSON.parse(String(init.body))].flat() as { id: number; method: string; params: unknown[] }[];
    const mine = reqs.map((r) => local(url, r));
    const rest = reqs.filter((_, i) => mine[i] === undefined);
    const fwd = rest.length === 0 ? [] : ((await (await chain.fetch(url, { ...init, body: JSON.stringify(rest) })).json()) as { id: number }[]);
    const out = reqs.map((r, i) => (mine[i] !== undefined ? { jsonrpc: "2.0", id: r.id, ...(mine[i] as object) } : fwd.find((x) => x.id === r.id)));
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { chain, fetch, reads };
}

const clock = { get t() { return Date.now(); } };

test("card robinhood-trades-finish-filling: 12 Robinhood coins whose trades lie in 20 bursts a read back step apart, opened at once at the providers' real paces: by 45 s of the virtual clock every tape answers its newest 50 trades, filling false, the located read back reading the named blocks only (red at 012884a43: one agreed 10,000-block step under each, tapes still filling at 45 s, as live run 43989230034)", async () => {
  const r = rig();
  const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms));
  const { value } = await onVirtualTime(9_000_000, async () => {
    const s = open(r.chain, clock, { pools: POOLS, rpcs: SWAP_RPCS.robinhood, index: INDEX_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never });
    // each tape's latest answer, and the page's reads of it so far (3 s apart, as swaps-search.test.ts reads them)
    const latest = new Map<string, { status: number; filling: boolean; n: number; tx: unknown; reads: number }>();
    let over = false;
    const poll = async (token: string) => {
      for (let reads = 1; !over; reads++) {
        const a = await s.trades(token, 50);
        const j = a.status === 200 ? (JSON.parse(a.body) as { trades: { tx: unknown }[]; filling?: boolean }) : null;
        latest.set(token, { status: a.status, filling: j?.filling === true, n: j?.trades.length ?? -1, tx: j?.trades[0]?.tx, reads });
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
      await s.tick();
    }
    const got = await by;
    await polls;
    s.stop();
    return got;
  });
  const line = value.map((g, i) => `${TOKENS[i]!.token.slice(-4)} ${g?.status} ${g?.filling ? "filling" : "done"} n${g?.n} read ${g?.reads}`).join(", ");
  console.log(`${line}; pool log reads: ${[...r.reads].map(([u, n]) => `${new URL(u).hostname} ${n}`).join(", ")}`);
  TOKENS.forEach(({ pool }, i) => {
    const g = value[i];
    assert.equal(g?.status, 200, line);
    assert.equal(g.filling, false, `a tape still filling at 45 s: ${line}`);
    assert.equal(g.n, TRADES_MAX, `the token's newest ${TRADES_MAX} trades: ${line}`);
    assert.equal(g.tx, SWAPS.get(pool)!.at(-1)!.tx, `newest first: ${line}`);
  });
  // every swap shown was read from two providers, never the locate's untimed word alone
  assert.ok((r.reads.get(POCKET) ?? 0) > 0 && (r.reads.get(DAYBREAK) ?? 0) > 0, `the read back asked pocket and daybreak: ${[...r.reads].join(" ")}`);
});
