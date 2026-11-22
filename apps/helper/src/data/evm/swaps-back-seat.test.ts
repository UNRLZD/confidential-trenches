// node --test apps/helper/src/data/evm/swaps-back-seat.test.ts: card robinhood-few-trade-tapes-fill-inside-45s. A Robinhood
// coin whose 50 trades lie one a named block over the day reads them in rounds of two providers that serve old blocks
// with their times (pocket and daybreak). Pocket answers part of a round 429 with Retry-After 1 past its own share (read
// from the Mac 22 Nov 05:2xZ: 16 such answers over one open of 0x7fe995a8, x-ratelimit-remaining 0), and the next round
// found one of the two free and took the chain's own RPC as the other: its logs carry no block time, a header a named
// block at its post a second, and its rounds took 3.6 to 12.4 s where the two's took 0.5 to 1.4 s. 0x7fe995a8 filled in
// 59.2, 65.3 and 79.2 s with 7 or 8 rounds there. Now a seat held a moment only is waited for: the chain's own RPC reads
// none of the named blocks while the two serve them. drpc, the narrow seat, is left out: an ETH-quoted pool's named
// block reads the ETH price's 1,000 blocks before it, a wide span either way, two a round (BACK_ROUND_SPANS).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, open, REC, timeAt } from "../../../test/evm-swaps/robinhood.ts";
import { callsIn, pocketRefusal } from "../../../test/pocket.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { HEADER_TIMED, INDEX_RPCS, SWAP_RPCS, TOPIC, TRADES_MAX, type Pool } from "./swaps.ts";

const OWN = "https://rpc.mainnet.chain.robinhood.com";
const POCKET = "https://robinhood.api.pocket.network";
const DAYBREAK = "https://robinhood.daybreak-rpc.network";
const DRPC = "https://robinhood.drpc.org";
const LATE_MS = 200;
const HEAD = REC.lastHead;
const T_HEAD = timeAt(HEAD);
const tsOf = (b: number) => T_HEAD - Math.ceil((HEAD - b) / 10);
const w = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const int = (x: bigint) => (x < 0n ? (1n << 256n) + x : x).toString(16).padStart(64, "0");
const ROUTER = `0x${"7e".repeat(20)}`;
const TOKEN = `0x${"ba0d".repeat(10)}`;
const POOL = `0x${"9ba0d".repeat(8)}`;
const POOLS = new Map([[TOKEN, { pool: { venue: "v3", id: POOL, token: TOKEN, tokenIs0: true, quote: { kind: "usd", decimals: 6 } } as Pool, decimals: 18 }]]);
/** 60 swaps, one a block, 14,000 blocks apart (a read back step and more), the newest 4,000 under the head: past the cold
 *  window, every one its own span of a round. */
const SWAPS = Array.from({ length: 60 }, (_, k) => {
  const b = HEAD - 4_000 - k * 14_000;
  const tx = `0x${"ce".repeat(30)}${k.toString(16).padStart(4, "0")}`;
  const amt = 1_000n * 10n ** 18n + BigInt(k);
  return { b, i: 1, tx, a: POOL, t: [TOPIC.swap3, w(ROUTER), w(ROUTER)], d: `0x${int(amt)}${int(-5_000_000n - BigInt(k))}${int(1n << 96n)}${int(10n ** 18n)}${int(0n)}` };
}).sort((x, y) => x.b - y.b);

function rig() {
  const chain = fakeChain();
  chain.st.head = HEAD;
  chain.st.faults.set(OWN, { zeroTime: true, span: 1_000_000 });
  chain.st.faults.set(POCKET, { span: 10_000, addressOnly: true });
  chain.st.faults.set("https://rpc-robinhood.blockmachine.io", { span: 1_000, window: 5_000 });
  chain.st.faults.set(DAYBREAK, { span: 2_000 });
  /** The chain's own RPC's reads of the pool's swaps under the cold window narrower than a day: a round's, not the locate's. */
  const own = { rounds: 0 };
  let pocketPosts = 0;
  const wire = (l: (typeof SWAPS)[number], zero: boolean) => ({ address: l.a, topics: l.t, data: l.d, blockNumber: `0x${l.b.toString(16)}`, logIndex: `0x${l.i.toString(16)}`, transactionHash: l.tx, blockTimestamp: `0x${(zero ? 0 : tsOf(l.b)).toString(16)}`, removed: false });
  const local = (url: string, r: { method: string; params: unknown[] }): unknown => {
    const f = chain.st.faults.get(url) ?? {};
    if (r.method === "eth_getBlockByNumber" && r.params[0] !== "latest" && parseInt(r.params[0] as string, 16) < REC.firstHead) {
      const n = parseInt(r.params[0] as string, 16);
      return { result: { number: `0x${n.toString(16)}`, timestamp: `0x${tsOf(n).toString(16)}` } };
    }
    if (r.method === "eth_getTransactionByHash") return { result: { hash: r.params[0], from: `0x${(r.params[0] as string).slice(26, 66)}` } };
    if (r.method !== "eth_getLogs") return undefined;
    const q = r.params[0] as { address?: string; topics?: (string | string[])[]; fromBlock: string; toBlock: string };
    if (q.address !== POOL) return undefined;
    const [from, to] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
    if (to > HEAD || to - from + 1 > (f.span ?? 100)) return { error: { code: -32602, message: "eth_getLogs block range exceeds 100 blocks" } };
    if (f.window !== undefined && from < HEAD - f.window) return { error: { code: -32011, message: "block reference is outside the public history window" } };
    if (url === OWN && to < HEAD - 3_000 && to - from + 1 < 100_000) own.rounds++;
    const want = [q.topics?.[0]].flat();
    return { result: SWAPS.filter((l) => l.b >= from && l.b <= to && want.includes(l.t[0])).map((l) => wire(l, f.zeroTime === true)) };
  };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    await new Promise((go) => setTimeout(go, LATE_MS));
    const f = chain.st.faults.get(url) ?? {};
    if (f.down) return new Response("down", { status: 503 });
    const pocket = pocketRefusal(url, callsIn(init.body));
    if (pocket) return pocket;
    const reqs = [JSON.parse(String(init.body))].flat() as { id: number; method: string; params: unknown[] }[];
    // pocket past its own per-second share: every third post that reads logs answered 429, Retry-After 1
    if (url === POCKET && reqs.some((r) => r.method === "eth_getLogs") && ++pocketPosts % 3 === 0) return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "1" } });
    const mine = reqs.map((r) => local(url, r));
    const rest = reqs.filter((_, i) => mine[i] === undefined);
    const fwd = rest.length === 0 ? [] : ((await (await chain.fetch(url, { ...init, body: JSON.stringify(rest) })).json()) as { id: number }[]);
    const out = reqs.map((r, i) => (mine[i] !== undefined ? { jsonrpc: "2.0", id: r.id, ...(mine[i] as object) } : fwd.find((x) => x.id === r.id)));
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { chain, fetch, own };
}

const clock = { get t() { return Date.now(); } };

test("card robinhood-few-trade-tapes-fill-inside-45s: a coin whose 50 trades lie one a named block over the day, pocket refusing a post in three for a second as live: the read back waits for its turn and the chain's own RPC (untimed, a header a block at a post a second) reads none of the named blocks; the tape is its newest 50 trades, not filling (red at b3593c25d: the chain's own RPC read named blocks in the rounds pocket sat out)", async () => {
  const r = rig();
  const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms));
  const { value } = await onVirtualTime(9_000_000, async () => {
    const s = open(r.chain, clock, { pools: POOLS, rpcs: SWAP_RPCS.robinhood.filter((u) => u !== DRPC), index: INDEX_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never });
    let a = await s.trades(TOKEN, 50);
    for (let i = 0; i < 60 && a.status === 200 && JSON.parse(a.body).filling === true; i++) {
      await sleep(1_000);
      await s.tick();
      a = await s.trades(TOKEN, 50);
    }
    s.stop();
    return a;
  });
  assert.equal(value.status, 200, value.body);
  const j = JSON.parse(value.body) as { trades: { tx: string }[]; filling?: boolean };
  assert.notEqual(j.filling, true, `still filling: ${j.trades.length} trades`);
  assert.equal(j.trades.length, TRADES_MAX);
  assert.deepEqual(j.trades.map((t) => t.tx), SWAPS.slice(-TRADES_MAX).reverse().map((l) => l.tx));
  assert.equal(r.own.rounds, 0, `the chain's own RPC read ${r.own.rounds} of the rounds' named blocks`);
});
