// node --test apps/helper/src/data/evm/swaps-third-quote.test.ts: card index-evm-swaps-v4-route-tape. A Base coin whose
// market is a Uniswap v4 pool quoted in a token that is neither the USD token nor WETH (cbBTC, ZORA, VIRTUAL...) has that
// pool's tape, each row priced through the quote token's own pool, found by our own discovery.
// Live run 44942886709 (helper 61fa14a08, 21 Nov 20:05Z), index-evm-swaps on Base 0x86fb3335: the coin's market was its
// cbBTC v4 pool 0xc265b42f (332 swap transactions in the window) and the tape read its USDC v4 pool 0xb26e93a3 (18), which
// an arbitrage passed through (USDC -> cbBTC in 0xae13e6e6 -> the coin in 0xc265 -> USDC in 0xb26e, tx 0x9ac65494, read
// on base-rpc.publicnode.com 21 Nov 22:3xZ): 315 of the 332 missing, and each sampled trade's amount judged against the
// wrong pool's leg. The helper took only USD- or WETH-quoted pools (swaps.ts quoteOf), so the cbBTC pool was never one.
//
// The chain here is planted, every answer the same on each provider: the coin's 60 swaps in its third-token v4 pool, every
// fifth an arbitrage that also swaps in its USDC v4 pool (12 there); the quote token's own Uniswap v3 pool (against USDC
// in the first case, cbBTC's own address; against WETH in the second, a token no table names), found by its transfers
// and confirmed by its factory; GeckoTerminal answers nothing.
import { keccak_256 } from "@noble/hashes/sha3.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { timeOf } from "../../../test/evm-swaps/base.ts";
// one namespace, so each test fails for its own reason where an export is missing (the red run at 3fa850c8c)
import * as S from "./swaps.ts";
import { BASE_VENUES, createSwaps, REF_POOL_ID, TOPIC, TRADES_MAX } from "./swaps.ts";

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const sel = (s: string) => hex(keccak_256(new TextEncoder().encode(s))).slice(0, 10);
const w = (a: string) => a.slice(2).padStart(64, "0");
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
const int = (x: bigint) => (x < 0n ? (1n << 256n) + x : x).toString(16).padStart(64, "0");
const ZERO = `0x${"0".repeat(40)}`;
const HEAD = 60_000_000;
const URLS = ["https://a.test", "https://b.test", "https://c.test"];
const PM = BASE_VENUES.poolManager;
const USDC = BASE_VENUES.usdc;
const WETH = BASE_VENUES.weth;
const COIN = `0x${"c0".repeat(20)}`;
const TRADER = (k: number) => `0x${"ab".repeat(18)}${k.toString(16).padStart(4, "0")}`;
/** The v4 PoolManager's storage slot of a pool's state (v4-core StateLibrary, POOLS_SLOT 6). */
const stateSlot = (id: string) => hex(keccak_256(Buffer.from(`${id.slice(2)}${w(word(6n))}`, "hex")));
/** ETH at 3,725.2902984619140625 USD: the reference pool's sqrtPriceX96 2^82 (swaps-quiet.test.ts). */
const REF_CALL = `${PM} ${sel("extsload(bytes32)")}${stateSlot(REF_POOL_ID).slice(2)}`;
const keyOf = (c0: string, c1: string, fee: bigint, spacing: bigint) => `0x${w(c0)}${w(c1)}${w(word(fee))}${w(word(spacing))}${w(ZERO)}`;
const idOf = (key: string) => hex(keccak_256(Buffer.from(key.slice(2), "hex")));

type L = { address: string; topics: string[]; data: string; blockNumber: string; logIndex: string; transactionHash: string; blockTimestamp: string; removed: false };
const log = (b: number, i: number, tx: string, address: string, topics: string[], data: string): L => ({ address, topics, data, blockNumber: `0x${b.toString(16)}`, logIndex: `0x${i.toString(16)}`, transactionHash: tx, blockTimestamp: `0x${timeOf(b).toString(16)}`, removed: false });
/** A v4 Swap: the swapper's deltas (positive: what it gets). */
const swap4 = (b: number, i: number, tx: string, id: string, a0: bigint, a1: bigint) => log(b, i, tx, PM, [TOPIC.swap4, id, `0x${w(TRADER(0))}`], `0x${int(a0)}${int(a1)}${int(1n << 96n)}${int(10n ** 18n)}${int(0n)}${int(0n)}`);
const transfer = (b: number, i: number, tx: string, token: string, from: string, to: string, v: bigint) => log(b, i, tx, token, [TOPIC.transfer, `0x${w(from)}`, `0x${w(to)}`], word(v));

type Case = { name: string; quote: string; other: string; sqrt: bigint; usdPerQuoteUnit: number };
/**
 * The planted chain of one case: the coin's third-token v4 pool MAIN (the coin currency0, `quote` currency1), its USDC
 * v4 pool SIDE, and the quote token's own Uniswap v3 pool against `other` (USDC or WETH) at `sqrt`.
 */
function planted(c: Case) {
  const mainKey = keyOf(COIN, c.quote, 0n, 200n);
  const sideKey = keyOf(USDC, COIN, 40_000n, 400n);
  const [MAIN, SIDE] = [idOf(mainKey), idOf(sideKey)];
  const QPOOL = `0x${"f7".repeat(20)}`;
  const logs: L[] = [];
  const receipts = new Map<string, L[]>();
  const from = new Map<string, string>();
  /** MAIN's swaps, oldest first: [block, tx, quote paid]. */
  const mains: { b: number; tx: string; q: bigint; amt: bigint }[] = [];
  for (let k = 0; k < 60; k++) {
    const b = HEAD - 1_300 + k * 20;
    const tx = `0x${"9a".repeat(30)}${k.toString(16).padStart(4, "0")}`;
    const amt = 2_000n * 10n ** 18n + BigInt(k) * 10n ** 17n;
    const q = c.name === "cbBTC" ? 90n + BigInt(k) : 4n * 10n ** 18n + BigInt(k) * 10n ** 15n;
    const mine: L[] = [];
    // MAIN: the swapper gets the coin, pays the quote (a buy)
    mine.push(swap4(b, 1, tx, MAIN, amt, -q));
    // every fifth an arbitrage on through SIDE: the coin sold for USDC there
    if (k % 5 === 4) mine.push(swap4(b, 2, tx, SIDE, 1_000_000n + BigInt(k), -amt));
    mine.push(transfer(b, 3, tx, COIN, PM, TRADER(k), amt));
    logs.push(...mine);
    receipts.set(tx, mine);
    from.set(tx, TRADER(k));
    mains.push({ b, tx, q, amt });
  }
  // the quote token's own pool: its swaps (30 blocks) and its transfers, found as the coin's pools are; log places 7 and 8,
  // past the coin's, as a block's logs never share one
  const [t0, t1] = c.other < c.quote ? [c.other, c.quote] : [c.quote, c.other];
  for (let k = 0; k < 30; k++) {
    const b = HEAD - 1_200 + k * 30;
    const tx = `0x${"5b".repeat(30)}${k.toString(16).padStart(4, "0")}`;
    const mine = [
      log(b, 7, tx, QPOOL, [TOPIC.swap3, `0x${w(TRADER(900))}`, `0x${w(TRADER(900))}`], `0x${int(1_000n)}${int(-1_000n)}${int(c.sqrt)}${int(10n ** 18n)}${int(0n)}`),
      transfer(b, 8, tx, c.quote, QPOOL, TRADER(900 + k), 1_000n),
    ];
    logs.push(...mine);
    receipts.set(tx, mine);
    from.set(tx, TRADER(900 + k));
  }
  const calls = new Map<string, string | ((n: number) => string)>([
    [`${COIN} 0x313ce567`, word(18n)],
    [`${c.quote} 0x313ce567`, word(c.name === "cbBTC" ? 8n : 18n)],
    [`${BASE_VENUES.positionManager} 0x86b6be7d${MAIN.slice(2, 52).padEnd(64, "0")}`, mainKey],
    [`${BASE_VENUES.positionManager} 0x86b6be7d${SIDE.slice(2, 52).padEnd(64, "0")}`, sideKey],
    [`${QPOOL} 0xc45a0155`, word(BigInt(BASE_VENUES.uniswapV3))],
    [`${QPOOL} 0x0dfe1681`, word(BigInt(t0))],
    [`${QPOOL} 0xd21220a7`, word(BigInt(t1))],
    [`${QPOOL} ${sel("fee()")}`, word(3000n)],
    [`${BASE_VENUES.uniswapV3} ${sel("getPool(address,address,uint24)")}${w(t0)}${w(t1)}${w(word(3000n))}`, word(BigInt(QPOOL))],
    // Uniswap v3's slot0: seven words, sqrtPriceX96 first
    [`${QPOOL} ${sel("slot0()")}`, `${word(c.sqrt)}${"0".repeat(64 * 6)}`],
    // the quote side it holds, deep: 10^30 of the other token's smallest units
    [`${c.other} 0x70a08231${w(QPOOL)}`, word(10n ** 30n)],
    [REF_CALL, word(1n << 82n)],
  ]);
  return { MAIN, SIDE, logs, receipts, from, calls, mains };
}

/** The planted chain's provider, every answer the same on each URL; `counts`: the requests each method was asked, and
 *  the posts. An eth_call's answer may be a function of its block. */
function rig(p: ReturnType<typeof planted>) {
  const counts: Record<string, number> = { posts: 0 };
  const one = (r: { method: string; params: unknown[] }): object => {
    counts[r.method] = (counts[r.method] ?? 0) + 1;
    if (r.method === "eth_blockNumber") return { result: `0x${HEAD.toString(16)}` };
    if (r.method === "eth_chainId") return { result: "0x2105" };
    if (r.method === "eth_getBlockByNumber") {
      const n = r.params[0] === "latest" ? HEAD : parseInt(r.params[0] as string, 16);
      return n > HEAD ? { result: null } : { result: { number: `0x${n.toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, timestamp: `0x${timeOf(n).toString(16)}` } };
    }
    if (r.method === "eth_getTransactionByHash") {
      const t = r.params[0] as string;
      return { result: p.from.has(t) ? { hash: t, from: p.from.get(t), to: `0x${"7e".repeat(20)}`, input: "0x" } : null };
    }
    if (r.method === "eth_getTransactionReceipt") {
      const t = r.params[0] as string;
      const ls = p.receipts.get(t);
      return { result: ls === undefined ? null : { transactionHash: t, status: "0x1", from: p.from.get(t), blockNumber: ls[0]!.blockNumber, logs: ls } };
    }
    if (r.method === "eth_call") {
      const c = r.params[0] as { to: string; data: string };
      const v = p.calls.get(`${c.to.toLowerCase()} ${c.data.toLowerCase()}`);
      const n = r.params[1] === "latest" ? HEAD : parseInt(r.params[1] as string, 16);
      return { result: (typeof v === "function" ? v(n) : v) ?? "0x" };
    }
    if (r.method === "eth_getLogs") {
      const q = r.params[0] as { address?: string | string[]; topics?: (string | string[] | null)[]; fromBlock: string; toBlock: string };
      const [lo, hi] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
      const addrs = q.address === undefined ? null : [q.address].flat().map((a) => a.toLowerCase());
      const pos = (q.topics ?? []).map((x) => (x == null ? null : [x].flat()));
      return { result: p.logs.filter((l) => parseInt(l.blockNumber, 16) >= lo && parseInt(l.blockNumber, 16) <= hi && (addrs === null || addrs.includes(l.address)) && pos.every((v, k) => v === null || v.includes(l.topics[k]!))) };
    }
    return { error: { code: -32601, message: "the method does not exist" } };
  };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (!URLS.includes(url)) return new Response("{}", { status: 500 });
    counts.posts!++;
    await new Promise((go) => setTimeout(go, 50));
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    const out = [body].flat().map((r) => ({ jsonrpc: "2.0", id: r.id, ...one(r) }));
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { "content-type": "application/json" } });
  };
  return Object.assign(fetch, { counts });
}

const CASES: Case[] = [
  // cbBTC (8 decimals) against USDC (token0): 625 USDC units a satoshi (sqrtPriceX96 = 2^96 / 25), BTC at 62,500 USD
  { name: "cbBTC", quote: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", other: USDC, sqrt: (1n << 96n) / 25n, usdPerQuoteUnit: 0.000625 },
  // a quote token no table names, against WETH (token0): 2,500 of it a WETH (sqrtPriceX96 = 50 * 2^96), ETH at
  // 3,725.2902984619140625 USD, so 1.490116119384765625 USD a whole token
  { name: "a quote no table names", quote: `0x${"d0".repeat(20)}`, other: WETH, sqrt: 50n << 96n, usdPerQuoteUnit: 1.490116119384765625e-18 },
];

for (const c of CASES)
  test(`card index-evm-swaps-v4-route-tape (${c.name}): a coin whose market is its v4 pool quoted in ${c.name}, with an arbitrage's USDC side pool, has that pool's whole tape, each row priced through the quote's own pool our discovery found (red at 3fa850c8c: the USDC side pool's 12 rows)`, async () => {
    const p = planted(c);
    const f = rig(p);
    const { value } = await onVirtualTime(9_000_000, async () => {
      const s = createSwaps("base", { fetch: f as never, now: () => Date.now(), listed: async () => true, rpcs: URLS, pools: new Map(), tickMs: 0, sleep: async () => undefined });
      let a = await s.trades(COIN, 50);
      for (let i = 0; i < 40 && a.status === 200 && JSON.parse(a.body).filling === true; i++) {
        await new Promise((go) => setTimeout(go, 1_000));
        await s.tick();
        a = await s.trades(COIN, 50);
      }
      s.stop();
      return a;
    });
    // the reads of one open to its whole tape, on each of the three providers together (card index-evm-swaps-v4-route-tape)
    console.log(`calls per open (${c.name}): ${JSON.stringify(f.counts)}`);
    assert.equal(value.status, 200, value.body);
    const j = JSON.parse(value.body) as { trades: { tx: string; usd: string; amt: string; side: string }[]; filling?: boolean };
    const want = p.mains.slice(-TRADES_MAX).reverse();
    assert.equal(j.trades.length, TRADES_MAX, `the third-token pool's newest ${TRADES_MAX} trades: ${j.trades.length} rows, ${j.trades.slice(0, 3).map((t) => t.tx.slice(0, 10)).join(", ")}`);
    assert.notEqual(j.filling, true);
    j.trades.forEach((t, i) => {
      assert.equal(t.tx, want[i]!.tx, `row ${i}`);
      assert.equal(t.side, "b", `row ${i}`);
      const usd = Number(want[i]!.q) * c.usdPerQuoteUnit;
      assert.ok(Math.abs(Number(t.usd) - usd) <= usd * 1e-9, `row ${i}: usd ${t.usd}, want ${usd} (the quote's amount at its own pool's price)`);
    });
  });

test("card index-evm-swaps-v4-route-tape (guard): a busier third-token pool whose quote's route was not read (the vendor refused, its own pool too shallow to price) is answered as a coin with no pool of ours, 200 and no rows: never the USDC side pool's rows in its place (3fa850c8c), never a 503 (c3b72179a)", async () => {
  const p = planted(CASES[0]!);
  // the quote's own pool holds 999 USDC: under LIQ_MIN_USD (1,000), so no route is picked, and the vendor's list was refused
  p.calls.set(`${USDC} 0x70a08231${w(`0x${"f7".repeat(20)}`)}`, word(999n * 10n ** 6n));
  const { value } = await onVirtualTime(9_000_000, async () => {
    const s = createSwaps("base", { fetch: rig(p) as never, now: () => Date.now(), listed: async () => true, rpcs: URLS, pools: new Map(), tickMs: 0, sleep: async () => undefined });
    const a = await s.trades(COIN, 50);
    s.stop();
    return a;
  });
  assert.equal(value.status, 200, value.body);
  assert.deepEqual((JSON.parse(value.body) as { trades: unknown[] }).trades, [], value.body);
});

test("card index-evm-swaps-v4-route-tape (no route): a coin whose only pool is quoted in a token with no route read answers as the build without third quotes does, 200 and no rows, never a 503 (red at c3b72179a: 503)", async () => {
  const p = planted(CASES[0]!);
  // no arbitrage through the USDC pool: the third-token pool is the coin's only one
  for (let i = p.logs.length - 1; i >= 0; i--) if (p.logs[i]!.topics[1] === p.SIDE) p.logs.splice(i, 1);
  for (const ls of p.receipts.values()) for (let i = ls.length - 1; i >= 0; i--) if (ls[i]!.topics[1] === p.SIDE) ls.splice(i, 1);
  p.calls.set(`${USDC} 0x70a08231${w(`0x${"f7".repeat(20)}`)}`, word(999n * 10n ** 6n));
  const { value } = await onVirtualTime(9_000_000, async () => {
    const s = createSwaps("base", { fetch: rig(p) as never, now: () => Date.now(), listed: async () => true, rpcs: URLS, pools: new Map(), tickMs: 0, sleep: async () => undefined });
    const a = await s.trades(COIN, 50);
    s.stop();
    return a;
  });
  assert.equal(value.status, 200, value.body);
  assert.deepEqual((JSON.parse(value.body) as { trades: unknown[] }).trades, [], value.body);
});

test("card index-evm-swaps-v4-route-tape (moving quote): each row is priced at the quote's price in force at its own log, from the quote pool's own Swap logs: a coin swap in the block where cbBTC's price moves, but before that move's log, keeps the old price (red at c3b72179a: priced at the block's end state)", async () => {
  const c = CASES[0]!;
  const p = planted(c);
  // from the quote pool's 17th swap (block HEAD - 720, log 7, after the coin's swap at log 1 of the same block) cbBTC is
  // worth four times as much: sqrtPriceX96 halved (USDC is token0: the price is 2^192 / sqrt^2 USDC units a satoshi)
  const MOVE = HEAD - 720;
  const sqrt2 = c.sqrt / 2n;
  for (const l of p.logs) if (l.address === `0x${"f7".repeat(20)}` && parseInt(l.blockNumber, 16) >= MOVE) l.data = `0x${int(1_000n)}${int(-1_000n)}${int(sqrt2)}${int(10n ** 18n)}${int(0n)}`;
  p.calls.set(`0x${"f7".repeat(20)} ${sel("slot0()")}`, (n: number) => `${word(n >= MOVE ? sqrt2 : c.sqrt)}${"0".repeat(64 * 6)}`);
  const { value } = await onVirtualTime(9_000_000, async () => {
    const s = createSwaps("base", { fetch: rig(p) as never, now: () => Date.now(), listed: async () => true, rpcs: URLS, pools: new Map(), tickMs: 0, sleep: async () => undefined });
    let a = await s.trades(COIN, 50);
    for (let i = 0; i < 40 && a.status === 200 && JSON.parse(a.body).filling === true; i++) {
      await new Promise((go) => setTimeout(go, 1_000));
      await s.tick();
      a = await s.trades(COIN, 50);
    }
    s.stop();
    return a;
  });
  assert.equal(value.status, 200, value.body);
  const j = JSON.parse(value.body) as { trades: { tx: string; usd: string }[] };
  const want = p.mains.slice(-TRADES_MAX).reverse();
  assert.equal(j.trades.length, TRADES_MAX, value.body.slice(0, 200));
  assert.ok(want.some((m) => m.b === MOVE), "a coin swap in the move's block");
  j.trades.forEach((t, i) => {
    const m = want[i]!;
    const usd = Number(m.q) * c.usdPerQuoteUnit * (m.b > MOVE ? 4 : 1);
    assert.ok(Math.abs(Number(t.usd) - usd) <= usd * 1e-9, `row ${i} (block ${HEAD - m.b} under the head): usd ${t.usd}, want ${usd}`);
  });
});

test("card index-evm-swaps-v4-route-tape: seedQuotes finds each QUOTE_SEEDS token's route by our own reads at start (cbBTC's own USDC pool here; ZORA and VIRTUAL, with no pool on this chain and the vendor refused, not read)", async () => {
  const p = planted(CASES[0]!);
  const { value } = await onVirtualTime(9_000_000, async () => {
    const s = createSwaps("base", { fetch: rig(p) as never, now: () => Date.now(), listed: async () => true, rpcs: URLS, pools: new Map(), tickMs: 0, sleep: async () => undefined });
    const r = await s.seedQuotes();
    s.stop();
    return r;
  });
  assert.deepEqual(value, { [S.QUOTE_SEEDS.base[0]!]: `0x${"f7".repeat(20)}`, [S.QUOTE_SEEDS.base[1]!]: undefined, [S.QUOTE_SEEDS.base[2]!]: undefined });
});
