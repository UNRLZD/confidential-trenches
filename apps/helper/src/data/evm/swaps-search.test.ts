// node --test apps/helper/src/data/evm/swaps-search.test.ts: a dozen cold Robinhood tokens whose pool only the discovery
// finds (card helper-robinhood-search-ahead). Live at 38249ca, 2026-11-05 07:2xZ, the 4 of 12 pinned tokens whose listed
// pool the helper cannot read fell to findPool, whose reads ran one round after another (the head, the transfers, each
// address's factory, the two tokens of a venue's, the pool's parameter, the factory's getPool, the v4 receipts, the
// PositionManager's keys, the Pons records, then the swaps): with each provider's answer some 0.3 to 2 s late under 12
// tapes at once, the slowest tape took 15.5 s and one run 5 of 12 within 15 s. A discovery now asks what no answer it
// waits for names in one round (swaps.ts findPool), and the lists' tokens are looked for as the lists load (ahead).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, open, REC, timeAt } from "../../../test/evm-swaps/robinhood.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { HEADER_TIMED, ROBINHOOD_VENUES, SWAP_RPCS, TOPIC } from "./swaps.ts";

const CHAIN_RPC = "https://rpc.mainnet.chain.robinhood.com";
const BLOCKVECTRA = "https://api.blockvectra.com/v1/robinhood_mainnet/public";
const POCKET = "https://robinhood.api.pocket.network";
const WIDE = ["https://robinhood.daybreak-rpc.network", "https://rpc-robinhood.blockmachine.io", POCKET, CHAIN_RPC];
const http429 = (s = 30) => new Response("{}", { status: 429, headers: { "retry-after": String(s) } });
/** Each provider's answer, this many virtual ms after its post: the live answers under 12 tapes at once (0.3 to 2 s). */
const LATE_MS = 700;
/** The bound every tape answers within (scripts/live-checks/helper-robinhood-search-ahead.mjs). */
const BOUND_MS = 15_000;

const w = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const int = (x: bigint) => (x < 0n ? (1n << 256n) + x : x).toString(16).padStart(64, "0");
const ROUTER = `0x${"7e".repeat(20)}`;
const FEE = 3000n;
/** Twelve tokens, each traded only on its own Uniswap v3 pool against USDG, 20 swaps in the cold window, through a router
 *  (pool to router to trader: two transfers a swap), no list naming the pool. */
const TOKENS = Array.from({ length: 12 }, (_, i) => ({ token: `0x${(0xc01d00 + i).toString(16).padStart(40, "0")}`, pool: `0x${(0x9001d00 + i).toString(16).padStart(40, "0")}` }));
const SWAPS = 20;

/** The fake chain behind the real Robinhood provider list, as swaps-capacity.test.ts has it (the wide providers take
 *  1,000 blocks; `refusing` answer 429), with the twelve tokens' transfers and pools, every answer LATE_MS late. Counts
 *  each token's transfer reads. */
function rig(refusing: string[]) {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  for (const u of WIDE) chain.st.faults.set(u, { span: 1_000 });
  for (const u of refusing) chain.st.faults.set(u, { ...chain.st.faults.get(u), refuse: () => http429() });
  const head = REC.lastHead;
  const times = new Map<number, number>();
  const at = (b: number) => times.get(b) ?? (times.set(b, timeAt(b)), times.get(b)!);
  type L = { b: number; i: number; tx: string; a: string; t: string[]; d: string };
  const transfers = new Map<string, L[]>();
  const swaps = new Map<string, L[]>();
  TOKENS.forEach(({ token, pool }, n) => {
    const tl: L[] = [];
    const sl: L[] = [];
    for (let k = 0; k < SWAPS; k++) {
      const b = head - 2_900 + k * 140 + n;
      const tx = `0x${"ab".repeat(30)}${n.toString(16).padStart(2, "0")}${k.toString(16).padStart(2, "0")}`;
      const trader = `0x${tx.slice(26, 66)}`;
      const amt = 1_000n * 10n ** 18n + BigInt(k);
      tl.push({ b, i: 0, tx, a: token, t: [TOPIC.transfer, w(pool), w(ROUTER)], d: `0x${int(amt)}` });
      sl.push({ b, i: 1, tx, a: pool, t: [TOPIC.swap3, w(ROUTER), w(ROUTER)], d: `0x${int(-amt)}${int(5_000_000n + BigInt(k))}${int(1n << 96n)}${int(10n ** 18n)}${int(0n)}` });
      tl.push({ b, i: 2, tx, a: token, t: [TOPIC.transfer, w(ROUTER), w(trader)], d: `0x${int(amt)}` });
    }
    transfers.set(token, tl);
    swaps.set(pool, sl);
  });
  const reads = new Map<string, number>();
  const wire = (l: L) => ({ address: l.a, topics: l.t, data: l.d, blockNumber: `0x${l.b.toString(16)}`, logIndex: `0x${l.i.toString(16)}`, transactionHash: l.tx, blockTimestamp: `0x${at(l.b).toString(16)}`, removed: false });
  const local = (url: string, r: { method: string; params: unknown[] }): unknown => {
    if (r.method === "eth_getLogs") {
      const q = r.params[0] as { address?: string; topics?: (string | string[])[]; fromBlock: string; toBlock: string };
      const [from, to] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
      const mine = q.address === undefined ? undefined : (transfers.get(q.address) ?? swaps.get(q.address));
      if (mine === undefined) return undefined;
      if (to > head || to - from + 1 > (chain.st.faults.get(url)?.span ?? 100)) return { error: { code: -32602, message: "eth_getLogs block range exceeds 100 blocks" } };
      if (transfers.has(q.address!)) reads.set(q.address!, (reads.get(q.address!) ?? 0) + 1);
      const want = [q.topics?.[0]].flat();
      return { result: mine.filter((l) => l.b >= from && l.b <= to && want.includes(l.t[0])).map(wire) };
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
    await new Promise((go) => setTimeout(go, LATE_MS));
    const f = chain.st.faults.get(url) ?? {};
    const no = f.refuse?.();
    if (no) return no;
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    const mine = reqs.map((r) => local(url, r));
    const rest = reqs.filter((_, i) => mine[i] === undefined);
    const fwd = rest.length === 0 ? [] : ((await (await chain.fetch(url, { ...init, body: JSON.stringify(rest) })).json()) as { id: number }[]);
    const out = reqs.map((r, i) => (mine[i] !== undefined ? { jsonrpc: "2.0", id: r.id, ...(mine[i] as object) } : fwd.find((x) => x.id === r.id)));
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { chain, fetch, reads };
}

const clock = { get t() { return Date.now(); } };
type Ahead = { ahead?: (tokens: string[]) => Promise<void> };

test("card helper-robinhood-search-ahead: 12 cold tokens whose pool only the discovery finds, the lists loaded before they are opened at once, the chain's own RPC holding after its 429s, every other provider at its pace and each answer 700 ms late: all 12 answer 200 with their own tape within 15 s, and no open reads a token's transfers (red at 04bb10f: each open looked for its pool itself, the slowest past 15 s)", async () => {
  const r = rig([CHAIN_RPC]);
  const { value } = await onVirtualTime(9_000_000, async () => {
    const s = open(r.chain, clock, { pools: new Map(), rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never });
    // the lists' answer loads (server.ts evmSwapsFromEnv calls ahead with its tokens)
    await (s as Ahead).ahead?.(TOKENS.map((x) => x.token));
    const before = [...r.reads.values()].reduce((a, b) => a + b, 0);
    const t0 = Date.now();
    const got = await Promise.all(TOKENS.map(({ token }) => s.trades(token, 50).then((a) => ({ a, ms: Date.now() - t0 }))));
    s.stop();
    return { got, opened: [...r.reads.values()].reduce((a, b) => a + b, 0) - before };
  });
  const line = value.got.map((g, i) => `${TOKENS[i]!.token.slice(-4)} ${g.a.status} ${(g.ms / 1000).toFixed(1)} s`).join(", ");
  for (const g of value.got) {
    assert.equal(g.a.status, 200, line);
    assert.equal((JSON.parse(g.a.body) as { trades: unknown[] }).trades.length, SWAPS, `the token's own tape: ${line}`);
  }
  const slowest = Math.max(...value.got.map((g) => g.ms));
  assert.ok(slowest <= BOUND_MS, `the slowest tape took ${(slowest / 1000).toFixed(1)} s, past 15 s: ${line}`);
  assert.equal(value.opened, 0, "an open read its token's transfers: its pool was not looked for as the lists loaded");
});

test("card helper-robinhood-search-ahead: a lone cold token's discovery asks each read with every other no answer it waits for names: its tape within 7 answer times (at 04bb10f 9: the factories, the pairs, the parameter, the getPool, the receipts, the keys and the Pons records one after another)", async () => {
  const r = rig([]);
  const { value: got, ms } = await onVirtualTime(9_000_000, async () => {
    const s = open(r.chain, clock, { pools: new Map(), rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never });
    const a = await s.trades(TOKENS[0]!.token, 50);
    s.stop();
    return a;
  });
  assert.equal(got.status, 200);
  assert.equal((JSON.parse(got.body) as { trades: unknown[] }).trades.length, SWAPS);
  assert.ok(ms <= 7 * LATE_MS, `${(ms / LATE_MS).toFixed(1)} answer times (${ms} ms)`);
});
