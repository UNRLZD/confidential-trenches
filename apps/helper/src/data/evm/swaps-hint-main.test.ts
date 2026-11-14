// node --test apps/helper/src/data/evm/swaps-hint-main.test.ts: card helper-live-run-green-after-122. A listed token's
// list row names one of its pools (lists.ts EvmSnapshot.pools, GeckoTerminal's row), and fromHint takes it once the chain
// confirms it is the token's, never asking whether it is the MAIN pool (the one that carried most of its swaps in the
// cold window, the header's rule). Read 2026-11-12 16:3xZ on Base: PENNY 0xeb3841d0's row named its 7-swap v4 pool B
// (ETH/PENNY fee 60000, minutes old, in new_pools) while its v4 pool A (hooked, not in the PositionManager) carried 44
// swaps in the same 1,000 blocks; the deployed tape held only B's 17 rows and index-evm-swaps (run 43250937996) failed
// with 36 of A's 45 swap txs missing. Here: the hint answers the first open at once, the background search
// (findPool) then decides the main pool, and the tape serves it.
//
// The fixture: the recorded Base fake (test/evm-swaps/base.ts) with two Uniswap v3 COIN / USDC pools planted in front of
// it, both confirmed by the factory's getPool, both COIN's transfer counterparties, BUSY with 12 swaps and QUIET with 3.
import { keccak_256 } from "@noble/hashes/sha3.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as B from "../../../test/evm-swaps/base.ts";
import { BASE_VENUES, POOL_KEEP_MS, TOPIC } from "./swaps.ts";

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const sel = (s: string) => hex(keccak_256(new TextEncoder().encode(s))).slice(0, 10);
const w = (a: string) => a.slice(2).padStart(64, "0");
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
const COIN = `0x${"c0".repeat(20)}`; // above USDC: the pools' token1
const BUSY = `0x${"a1".repeat(20)}`;
const QUIET = `0x${"b1".repeat(20)}`;
const HEAD = B.REC.firstHead;
const TRADER = (k: number) => `0x${"ab".repeat(19)}${k.toString(16).padStart(2, "0")}`;

type Filter = { address?: string; topics?: (string | string[] | null)[]; fromBlock: string; toBlock: string };
const inRange = (q: Filter, b: number) => b >= parseInt(q.fromBlock, 16) && b <= parseInt(q.toBlock, 16);
const at = (b: number) => ({ blockNumber: `0x${b.toString(16)}`, blockTimestamp: `0x${B.timeOf(b).toString(16)}`, removed: false });

/** A Uniswap v3 COIN / USDC pool of `fee`: its factory, tokens and fee, and the factory's getPool naming it. */
function v3Pool(calls: Map<string, string>, pool: string, fee: bigint) {
  calls.set(`${pool} 0xc45a0155`, word(BigInt(BASE_VENUES.uniswapV3)));
  calls.set(`${pool} 0x0dfe1681`, word(BigInt(BASE_VENUES.usdc)));
  calls.set(`${pool} 0xd21220a7`, word(BigInt(COIN)));
  calls.set(`${pool} ${sel("fee()")}`, word(fee));
  calls.set(`${BASE_VENUES.uniswapV3} ${sel("getPool(address,address,uint24)")}${w(BASE_VENUES.usdc)}${w(COIN)}${w(word(fee))}`, word(BigInt(pool)));
}
/** `n` buys in `pool`, a block apart ending 10 under the head, each in its own transaction (the pool paid 1 COIN for
 *  0.25 USDC), and the transfer of COIN from the pool to the trader in the same transaction. */
function trades(pool: string, n: number, tag: string) {
  const tx = (i: number) => `0x${tag.repeat(31)}${i.toString(16).padStart(2, "0")}`;
  const swaps = Array.from({ length: n }, (_, i) => ({
    address: pool,
    topics: [TOPIC.swap3, `0x${w(TRADER(i))}`, `0x${w(TRADER(i))}`],
    data: `0x${w(word(250_000n))}${w(word((1n << 256n) - 10n ** 18n))}${w(word(2_000_000n << 96n))}${w(word(1n))}${w(word(0n))}`,
    logIndex: "0x2",
    transactionHash: tx(i),
    ...at(HEAD - 10 - i),
  }));
  const transfers = swaps.map((s, i) => ({ address: COIN, topics: [TOPIC.transfer, `0x${w(pool)}`, `0x${w(TRADER(i))}`], data: word(10n ** 18n), logIndex: "0x1", transactionHash: s.transactionHash, ...at(HEAD - 10 - i) }));
  return { swaps, transfers, txs: swaps.map((s) => s.transactionHash) };
}

/** The fake: COIN's two pools, their swaps and transfers planted; `failTransfers` fails the token's transfer reads (the
 *  discovery's walk) on every provider. Counts the transfer reads (a discovery) and each pool's swap reads. */
function rig(hint: string) {
  const chain = B.fakeChain();
  const calls = new Map<string, string>([[`${COIN} 0x313ce567`, word(18n)]]);
  v3Pool(calls, BUSY, 3000n);
  v3Pool(calls, QUIET, 500n);
  const busy = trades(BUSY, 12, "aa");
  const quiet = trades(QUIET, 3, "bb");
  const st = { transfers: 0, poolReads: new Map<string, number>(), failTransfers: false, hold: null as Promise<void> | null };
  const isTransfers = (r: { method: string; params: unknown[] }) => r.method === "eth_getLogs" && (r.params[0] as Filter).address === COIN && (r.params[0] as Filter).topics?.[0] === TOPIC.transfer;
  const logsOf = (q: Filter): unknown[] | "error" | undefined => {
    if (q.address === COIN && q.topics?.[0] === TOPIC.transfer) {
      st.transfers++;
      if (st.failTransfers) return "error";
      return [...busy.transfers, ...quiet.transfers].filter((l) => inRange(q, parseInt(l.blockNumber, 16))).sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16));
    }
    for (const [pool, t] of [[BUSY, busy], [QUIET, quiet]] as const)
      if (q.address === pool) {
        st.poolReads.set(pool, (st.poolReads.get(pool) ?? 0) + 1);
        return t.swaps.filter((l) => inRange(q, parseInt(l.blockNumber, 16))).sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16));
      }
    return undefined;
  };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    // `hold`: the token's transfer reads (the discovery's walk) answer only once it settles
    if (st.hold !== null && reqs.some(isTransfers)) await st.hold;
    const mine = reqs.map((r): object | undefined => {
      if (r.method === "eth_call") {
        const c = r.params[0] as { to: string; data: string };
        return { result: calls.get(`${c.to} ${c.data}`) ?? "0x" };
      }
      if (r.method === "eth_getLogs") {
        const got = logsOf(r.params[0] as Filter);
        return got === undefined ? undefined : got === "error" ? { error: { code: -32603, message: "internal error" } } : { result: got };
      }
      return undefined;
    });
    const rest = reqs.filter((_, i) => mine[i] === undefined);
    const fwd = rest.length === 0 ? [] : ((await (await chain.fetch(url, { ...init, body: JSON.stringify(rest) })).json()) as { id: number }[]);
    const out = reqs.map((r, i) => (mine[i] !== undefined ? { jsonrpc: "2.0", id: r.id, ...mine[i] } : fwd.find((x) => x.id === r.id)));
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  const clock = { t: 1_000_000 };
  const s = B.open(chain, clock, { fetch: fetch as never, pools: new Map(), sleep: async () => undefined, hint: async () => hint });
  return { s, st, clock, busy, quiet };
}
const txsOf = (body: string) => new Set((JSON.parse(body) as { trades: { tx: string }[] }).trades.map((x) => x.tx));

test("card helper-live-run-green-after-122: a listed token whose list names its quieter pool: the first open answers at once from that pool (no discovery in it), the background search then finds the busier one, and the next tape serves the main pool's swaps (red at 1cfd3add8: the hint's pool stays the tape for POOL_KEEP_MS)", async () => {
  const { s, st, busy, quiet } = rig(QUIET);
  // the discovery's transfer reads hang until the first open has answered: it waits on none of them
  let release!: () => void;
  st.hold = new Promise<void>((go) => (release = go));
  const first = await s.trades(COIN, 50);
  assert.equal(first.status, 200, first.body);
  // within its bound: the hint's pool's tape (an answer past it serves what is held, none here); and, short of
  // TRADES_MAX, filling while its older trades are read back (swaps.ts readBack, card every-cell-shows-a-value)
  assert.deepEqual(txsOf(first.body), new Set(quiet.txs), "the first open is the hint's pool's tape");
  assert.equal(JSON.parse(first.body).filling, quiet.txs.length < 50 ? true : undefined, "filling only while read back");
  release();
  // the background search the hint left (ahead's queue) settles
  await s.ahead([]);
  assert.ok(st.transfers > 0, "the token was discovered in the background");
  assert.equal(s.kept(COIN)?.pool, BUSY, "the main pool is kept");
  const next = await s.trades(COIN, 50);
  assert.equal(next.status, 200, next.body);
  assert.deepEqual(txsOf(next.body), new Set(busy.txs), "the next tape is the main pool's swaps");
  s.stop();
});

test("card helper-live-run-green-after-122: a hint that is the main pool: one background discovery confirms it, the book is kept (no read of it again), and no second discovery within POOL_KEEP_MS, the lists' later loads included", async () => {
  const { s, st, clock, busy } = rig(BUSY);
  const first = await s.trades(COIN, 50);
  assert.equal(first.status, 200, first.body);
  assert.deepEqual(txsOf(first.body), new Set(busy.txs));
  await s.ahead([]);
  const found = st.transfers;
  assert.ok(found > 0, "searched once in the background");
  const reads = st.poolReads.get(BUSY) ?? 0;
  const next = await s.trades(COIN, 50);
  assert.deepEqual(txsOf(next.body), new Set(busy.txs));
  assert.equal(st.poolReads.get(BUSY) ?? 0, reads, "the book was not reset: the next tape read nothing again");
  clock.t += POOL_KEEP_MS - 1;
  await s.ahead([COIN]);
  await s.trades(COIN, 50);
  await s.ahead([]);
  assert.equal(st.transfers, found, "no second discovery within POOL_KEEP_MS");
  assert.equal(s.kept(COIN)?.pool, BUSY);
  s.stop();
});

test("card helper-live-run-green-after-122: a background discovery that fails keeps the hint's pool served, and the token is searched again at the lists' next load (which then finds the main pool)", async () => {
  const { s, st, busy, quiet } = rig(QUIET);
  st.failTransfers = true;
  const first = await s.trades(COIN, 50);
  assert.deepEqual(txsOf(first.body), new Set(quiet.txs));
  await s.ahead([]);
  const failed = st.transfers;
  assert.ok(failed > 0, "the discovery was tried");
  assert.equal(s.kept(COIN)?.pool, QUIET, "the hint's pool stays kept");
  const still = await s.trades(COIN, 50);
  assert.equal(still.status, 200, still.body);
  assert.deepEqual(txsOf(still.body), new Set(quiet.txs), "and served");
  // the lists load again: the hinted token is searched again
  st.failTransfers = false;
  await s.ahead([COIN]);
  assert.ok(st.transfers > failed, "searched again");
  assert.equal(s.kept(COIN)?.pool, BUSY);
  assert.deepEqual(txsOf((await s.trades(COIN, 50)).body), new Set(busy.txs));
  s.stop();
});
