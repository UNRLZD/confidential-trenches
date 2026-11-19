// node --test apps/helper/src/data/evm/swaps-v4-busy-tape.test.ts: a busy v4 coin's tape shows its trades, never a 200
// with none (card helper-v4-busy-tape-empty). The fixture (fixtures/swaps-v4-busy-tape.json) holds the PoolManager's
// Swap logs of three busy v4 pools as `eth_getLogs` by pool id answered them on two providers, alike byte for byte,
// read 2026-11-19 07:2x-07:34Z while the live helper (282da1e4) answered each coin's tape with exactly those swaps:
//   - WORM 0x3ba500f1 on Robinhood, its USDG pool 0x5ea36826 (no hook): 50 swaps over blocks 117,715,843-118,050,285,
//     pocket and daybreak, and the tape's 50 rows the same 50 transactions;
//   - MOW 0x0b7c6c13 on Robinhood, its ETH pool 0x5291cfd0 (hook 0xb3ca29cf, a dynamic fee): 50 over 118,042,739-
//     118,054,450, pocket and daybreak, the tape's 50 the same;
//   - VVV 0xacfe6019 on Base, its USDC pool 0x0faae4ff (no hook): 50 over 59,415,255-59,416,421, publicnode and
//     tenderly, the tape's 50 the same.
// Each pool's filter must select every one of its logs and the decode must read every one as a trade, on each chain,
// hooked and not; and the tape served from them (the Robinhood pools through createSwaps) has one row a swap.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fakeChain, open, REC, timeAt } from "../../../test/evm-swaps/robinhood.ts";
import { decodeSwap, poolFilters, TOPIC, VENUES, type Log, type Pool } from "./swaps.ts";
import type { EvmChain } from "./lists.ts";

type RecLog = { b: number; i: number; tx: string; a: string; t: string[]; d: string; ts: number | null };
type RecPool = { chain: EvmChain; coin: string; id: string; key: { c0: string; c1: string; hook: string }; from: number; to: number; logs: RecLog[] };
const FIX = JSON.parse(readFileSync(new URL("./fixtures/swaps-v4-busy-tape.json", import.meta.url), "utf8")) as { pools: Record<"worm" | "mow" | "vvv", RecPool> };
const ZERO = `0x${"0".repeat(40)}`;
const USD: Record<EvmChain, string> = { base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", robinhood: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" };

/** The pool as the helper keeps it, from its recorded key. */
function poolOf(p: RecPool): Pool {
  const tokenIs0 = p.key.c0 === p.coin;
  const other = tokenIs0 ? p.key.c1 : p.key.c0;
  const quote = other === USD[p.chain] ? { kind: "usd" as const, decimals: 6 } : { kind: "eth" as const, decimals: 18 };
  assert.ok(other === USD[p.chain] || other === ZERO, `${p.coin}: a quote of ours`);
  return { venue: "v4", id: p.id, token: p.coin, tokenIs0, quote, ...(p.key.hook === ZERO ? {} : { hook: p.key.hook }) };
}
const toLog = (l: RecLog): Log => ({ block: l.b, index: l.i, tx: l.tx, address: l.a, topics: l.t, data: l.d, t: l.ts });

/** Whether `eth_getLogs` with filter `f` answers log `l`: its address, each topic position (null any, a list any of
 *  them) and its block range, as the JSON-RPC spec reads a filter. */
function selects(f: Record<string, unknown>, l: RecLog): boolean {
  if (f.address !== undefined && f.address !== l.a) return false;
  if (l.b < parseInt(f.fromBlock as string, 16) || l.b > parseInt(f.toBlock as string, 16)) return false;
  const topics = (f.topics ?? []) as (string | string[] | null)[];
  return topics.every((want, k) => want === null || (Array.isArray(want) ? want.includes(l.t[k]!) : want === l.t[k]));
}

/** The swapper's token leg as the log writes it, read here apart from swaps.ts: amount0 and amount1 are the swapper's
 *  deltas as int128 (v4-core IPoolManager.Swap), so a positive token leg is a buy. */
function sideOf(p: RecPool, l: RecLog): "b" | "s" {
  const w = BigInt(`0x${l.d.slice(2 + 64 * (p.key.c0 === p.coin ? 0 : 1), 2 + 64 * (p.key.c0 === p.coin ? 1 : 2))}`);
  const v = w >= 1n << 255n ? w - (1n << 256n) : w;
  return v > 0n ? "b" : "s";
}

for (const [name, p] of Object.entries(FIX.pools)) {
  const pool = poolOf(p);
  test(`card helper-v4-busy-tape-empty: ${name} (${p.chain}, ${pool.hook === undefined ? "no hook" : "hooked"}): the pool's filter selects every one of its ${p.logs.length} recorded Swap logs and each decodes as a trade, on the side the log writes`, () => {
    assert.equal(p.logs.length, 50);
    const filters = poolFilters(pool, p.from, p.to, p.chain);
    for (const l of p.logs) {
      assert.equal(l.a, VENUES[p.chain].poolManager);
      assert.ok(filters.some((f) => selects(f, l)), `${l.tx}: no filter of the pool's selects it: ${JSON.stringify(filters)}`);
      const s = decodeSwap(pool, toLog(l), p.chain);
      assert.ok(s !== null, `${l.tx}: not decoded as a swap`);
      assert.equal(s.tx, l.tx);
      assert.equal(s.side, sideOf(p, l), `${l.tx}: side`);
      assert.ok(s.amt > 0n && s.quote > 0n, `${l.tx}: both legs`);
    }
  });
}

/** The recorded swaps moved onto the Robinhood harness's blocks (test/evm-swaps/robinhood.ts), each recorded block its
 *  own, in order, after the harness's first ETH price (1,907 blocks before its head, so an ETH pool's swaps are each
 *  priced) and the newest 135 blocks before the head; topics, data and hashes as recorded. */
function rebased(p: RecPool, head: number): RecLog[] {
  const blocks = [...new Set(p.logs.map((l) => l.b))].sort((a, b) => a - b);
  const at = new Map(blocks.map((b, j) => [b, head - 1_850 + j * 35]));
  return p.logs.map((l) => ({ ...l, b: at.get(l.b)!, ts: timeAt(at.get(l.b)!) }));
}

for (const name of ["worm", "mow"] as const) {
  const p = FIX.pools[name];
  const pool = poolOf(p);
  test(`card helper-v4-busy-tape-empty: ${name}'s tape (Robinhood, ${pool.hook === undefined ? "no hook" : "hooked"}) served from its recorded swaps answers 200 with one row a swap, the same transactions, never a 200 with none`, async () => {
    const chain = fakeChain();
    chain.st.head = REC.lastHead;
    const mine = rebased(p, REC.lastHead);
    const wire = (l: RecLog) => ({ address: l.a, topics: l.t, data: l.d, blockNumber: `0x${l.b.toString(16)}`, logIndex: `0x${l.i.toString(16)}`, transactionHash: l.tx, blockTimestamp: `0x${l.ts!.toString(16)}`, removed: false });
    // the harness's chain, with the pool's recorded logs added to every eth_getLogs answer whose filter selects them
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      const res = await chain.fetch(url, init);
      if (res.status !== 200) return res;
      const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
      const out = (await res.json()) as { id: number; result?: unknown }[];
      for (const o of out) {
        const r = reqs.find((q) => q.id === o.id);
        if (r?.method !== "eth_getLogs" || !Array.isArray(o.result)) continue;
        const f = r.params[0] as Record<string, unknown>;
        const add = mine.filter((l) => selects(f, l)).map(wire);
        if (add.length > 0) o.result = [...(o.result as { blockNumber: string; logIndex: string }[]), ...add].sort((x, y) => parseInt(x.blockNumber, 16) - parseInt(y.blockNumber, 16) || parseInt(x.logIndex, 16) - parseInt(y.logIndex, 16));
      }
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    };
    const s = open(chain, { get t() { return Date.now(); } }, { pools: new Map([[p.coin, { pool, decimals: 18 }]]), fetch: fetch as never });
    const a = await s.trades(p.coin, 50);
    s.stop();
    assert.equal(a.status, 200, a.body);
    const rows = (JSON.parse(a.body) as { trades: { tx: string; side: string }[] }).trades;
    assert.equal(rows.length, p.logs.length, `rows served for ${p.logs.length} swaps: ${a.body.slice(0, 300)}`);
    assert.deepEqual(new Set(rows.map((r) => r.tx)), new Set(p.logs.map((l) => l.tx)));
    for (const l of p.logs) assert.equal(rows.find((r) => r.tx === l.tx)!.side, sideOf(p, l), `${l.tx}: side`);
  });
}

test("card helper-v4-busy-tape-empty: the Swap topic the filters ask is v4-core's event", () => {
  assert.equal(TOPIC.swap4, "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f");
});
