// node --test apps/helper/src/data/evm/swaps-quiet.test.ts: card evm-chart-opens-without-a-vendor-call. On Base (200 ms
// blocks) a token's discovery looks back VENUES.base.cold = 1,500 blocks (5 min); read 2026-11-11 07:3xZ, 10 of the 20
// GeckoTerminal trending Base pools had no swap in that window. A listed token whose pool is confirmed on chain but quiet
// was "none" (findPool null), and its chart GeckoTerminal's alone, which the keyless budget refuses with a 429. Here:
// a confirmed pool is the token's book even with no swap; a quiet book's price is the pool's own state at the agreed
// head (a mark, ../candles.ts); PancakeSwap v3 on Base is a venue; and a book whose close is off the list's price by
// more than SCALE_BOUND is not served. Every chain answer is planted on the recorded Base fake (test/evm-swaps/base.ts)
// and the clock is the planted one.
import { keccak_256 } from "@noble/hashes/sha3.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as B from "../../../test/evm-swaps/base.ts";
import { geckoBudget, GT_LIMIT_PER_MIN } from "../gecko.ts";
// one namespace, so each test fails for its own reason where an export is missing (the red run at 4589273f)
import * as S from "./swaps.ts";
import { BASE_VENUES, decodeSwap, parseLog, REF_POOL_ID, swapFilter, TOPIC, VENUES, type Pool } from "./swaps.ts";

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const sel = (s: string) => hex(keccak_256(new TextEncoder().encode(s))).slice(0, 10);
const w = (a: string) => a.slice(2).padStart(64, "0");
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
const ZERO = `0x${"0".repeat(40)}`;
const COIN = `0x${"c0".repeat(20)}`; // above USDC and WETH: the pools' token1
const TRADER = (k: number) => `0x${"ab".repeat(19)}${k.toString(16).padStart(2, "0")}`;
const SLOT0 = sel("slot0()");
const EXTSLOAD = sel("extsload(bytes32)");
/** The v4 PoolManager's storage slot of a pool's state, worked out here from v4-core's StateLibrary (POOLS_SLOT 6). */
const stateSlot = (id: string) => hex(keccak_256(Buffer.from(`${id.slice(2)}${w(word(6n))}`, "hex")));
/** ETH at 2^-28 * 10^12 USD (3,725.2902984619140625, exact): the ETH / USDC reference pool's sqrtPriceX96 2^82. */
const REF_SQRT = 1n << 82n;
const REF_CALL = `${BASE_VENUES.poolManager} ${EXTSLOAD}${stateSlot(REF_POOL_ID).slice(2)}`;

type Filter = { address?: string; topics?: (string | string[] | null)[]; fromBlock: string; toBlock: string };
/** The recorded Base fake with planted answers in front: `calls` by "to data" (a function may answer "error" for a
 *  failed read), `logs` for the filters it knows (undefined: the fake's own). Any other eth_call answers "0x", as an
 *  account with no code does. GeckoTerminal is counted and refused (the budget is spent before it). */
function rig(o: { calls: Map<string, string | (() => string)>; logs: (q: Filter) => unknown[] | undefined }) {
  const chain = B.fakeChain();
  const gt: string[] = [];
  const st = { transfers: 0 };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (url.includes("geckoterminal")) return gt.push(url), new Response("{}", { status: 500 });
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    const mine = reqs.map((r): object | undefined => {
      if (r.method === "eth_call") {
        const c = r.params[0] as { to: string; data: string };
        const a = o.calls.get(`${c.to} ${c.data}`);
        const v = typeof a === "function" ? a() : a;
        if (v === "error") return { error: { code: -32603, message: "internal error" } };
        return { result: v ?? "0x" };
      }
      if (r.method === "eth_getLogs") {
        const q = r.params[0] as Filter;
        if (q.address === COIN && q.topics?.[0] === TOPIC.transfer) st.transfers++;
        const got = o.logs(q);
        return got === undefined ? undefined : { result: got };
      }
      return undefined;
    });
    const rest = reqs.filter((_, i) => mine[i] === undefined);
    const fwd = rest.length === 0 ? [] : ((await (await chain.fetch(url, { ...init, body: JSON.stringify(rest) })).json()) as { id: number }[]);
    const out = reqs.map((r, i) => (mine[i] !== undefined ? { jsonrpc: "2.0", id: r.id, ...mine[i] } : fwd.find((x) => x.id === r.id)));
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  const clock = { t: 1_000_000 };
  const budget = geckoBudget(() => clock.t);
  budget.seed(Array.from({ length: GT_LIMIT_PER_MIN }, () => clock.t - 1_000));
  return { chain, fetch, gt, st, clock, budget };
}
const inRange = (q: Filter, b: number) => b >= parseInt(q.fromBlock, 16) && b <= parseInt(q.toBlock, 16);
/** `n` transfers of COIN from `pool` to traders, a block apart, ending 10 blocks under the head. */
const transfersFrom = (pool: string, n: number, head: number, k0 = 0) =>
  Array.from({ length: n }, (_, i) => ({ address: COIN, topics: [TOPIC.transfer, `0x${w(pool)}`, `0x${w(TRADER(k0 + i))}`], data: word(10n ** 18n), blockNumber: `0x${(head - 10 - k0 - i).toString(16)}`, blockTimestamp: `0x${B.timeOf(head - 10 - k0 - i).toString(16)}`, logIndex: "0x1", transactionHash: `0x${"ef".repeat(31)}${(k0 + i).toString(16).padStart(2, "0")}`, removed: false }));
/** The factory's getPool(USDC, COIN, fee) call, as "to data". */
const getPool = (fee: bigint) => `${BASE_VENUES.uniswapV3} ${sel("getPool(address,address,uint24)")}${w(BASE_VENUES.usdc)}${w(COIN)}${w(word(fee))}`;
/** A Uniswap v3 COIN / USDC pool of `fee`: its factory, tokens and fee, the factory's getPool naming it, and (when
 *  given) its slot0 with `sqrt`. */
function v3Pool(calls: Map<string, string | (() => string)>, pool: string, sqrt?: bigint, fee = 3000n) {
  calls.set(`${pool} 0xc45a0155`, word(BigInt(BASE_VENUES.uniswapV3)));
  calls.set(`${pool} 0x0dfe1681`, word(BigInt(BASE_VENUES.usdc)));
  calls.set(`${pool} 0xd21220a7`, word(BigInt(COIN)));
  calls.set(`${pool} ${sel("fee()")}`, word(fee));
  calls.set(getPool(fee), word(BigInt(pool)));
  // Uniswap v3's slot0 is seven words, sqrtPriceX96 first
  if (sqrt !== undefined) calls.set(`${pool} ${SLOT0}`, `${word(sqrt)}${"0".repeat(64 * 6)}`);
}
const base = () => new Map<string, string | (() => string)>([[`${COIN} 0x313ce567`, word(18n)]]);
const HEAD = B.REC.firstHead;
const bucket = (tf: number) => B.timeOf(HEAD) - (B.timeOf(HEAD) % tf);

test("GeckoTerminal's budget spent, a quiet listed Base token whose pool is confirmed (found by its transfers, no hint) answers candles 200 from the chain: one bar at the pool's state price, own_from_s set; its tape 200 and empty (red at 4589273f: 429 geckoterminal budget)", async () => {
  const POOL = `0x${"f0".repeat(20)}`;
  const calls = base();
  // 0.25 USD per COIN: token0 USDC per token1 COIN is 2^192 / sqrtPriceX96^2 = 0.25e6 / 1e18
  v3Pool(calls, POOL, 2_000_000n << 96n);
  const r = rig({ calls, logs: (q) => (q.address === COIN ? transfersFrom(POOL, 3, HEAD).filter((l) => inRange(q, parseInt(l.blockNumber, 16))) : q.address === POOL ? [] : undefined) });
  const s = B.open(r.chain, r.clock, { fetch: r.fetch as never, pools: new Map(), gecko: r.budget, sleep: async () => undefined, hint: async () => null });
  const a = await s.candles(COIN, "1h", null, 500);
  const t = await s.trades(COIN, 50);
  s.stop();
  assert.equal(a.status, 200, a.body);
  const body = JSON.parse(a.body) as { candles: unknown[]; src: string; own_from_s?: number };
  assert.equal(body.src, "chain");
  assert.deepEqual(body.candles, [[bucket(3_600), "0.25", "0.25", "0.25", "0.25", "0"]]);
  assert.equal(body.own_from_s, bucket(3_600));
  assert.deepEqual(r.gt, [], "no GeckoTerminal call went out");
  assert.equal(t.status, 200, t.body);
  assert.deepEqual(JSON.parse(t.body).trades, [], "a mark is never a trade");
  assert.equal(s.kept(COIN)?.pool, POOL);
});

test("a quiet listed token whose list names its pool (fromHint confirms it): the same one bar from the pool's state (red at 4589273f: 429)", async () => {
  const POOL = `0x${"f0".repeat(20)}`;
  const calls = base();
  v3Pool(calls, POOL, 2_000_000n << 96n);
  const r = rig({ calls, logs: (q) => (q.address === COIN ? [] : q.address === POOL ? [] : undefined) });
  const s = B.open(r.chain, r.clock, { fetch: r.fetch as never, pools: new Map(), gecko: r.budget, sleep: async () => undefined, hint: async () => POOL });
  const a = await s.candles(COIN, "15m", null, 500);
  s.stop();
  assert.equal(a.status, 200, a.body);
  assert.deepEqual(JSON.parse(a.body).candles, [[bucket(900), "0.25", "0.25", "0.25", "0.25", "0"]]);
  assert.equal(r.st.transfers, 0, "the list's pool needs no discovery");
});

test("several confirmed pools and no swap in the window: the top transfer counterparty is the book, not the lower id (red at 4589273f: no pool)", async () => {
  const [A, Bp] = [`0x${"a1".repeat(20)}`, `0x${"b1".repeat(20)}`];
  const calls = base();
  v3Pool(calls, A, 2_000_000n << 96n);
  v3Pool(calls, Bp, 2_000_000n << 96n, 500n);
  const transfers = [...transfersFrom(A, 1, HEAD, 0), ...transfersFrom(Bp, 3, HEAD, 1)];
  const r = rig({ calls, logs: (q) => (q.address === COIN ? transfers.filter((l) => inRange(q, parseInt(l.blockNumber, 16))) : q.address === A || q.address === Bp ? [] : undefined) });
  const s = B.open(r.chain, r.clock, { fetch: r.fetch as never, pools: new Map(), gecko: r.budget, sleep: async () => undefined, hint: async () => null });
  const a = await s.candles(COIN, "1h", null, 500);
  s.stop();
  assert.equal(a.status, 200, a.body);
  assert.equal(s.kept(COIN)?.pool, Bp);
});

test("several confirmed pools and no swap: the list's pool when the discovery confirms it (its own check's reads failed first) (red at 4589273f: no pool)", async () => {
  const [A, Bp] = [`0x${"a1".repeat(20)}`, `0x${"b1".repeat(20)}`];
  const calls = base();
  v3Pool(calls, A, 2_000_000n << 96n);
  v3Pool(calls, Bp, 2_000_000n << 96n, 500n);
  const transfers = [...transfersFrom(A, 1, HEAD, 0), ...transfersFrom(Bp, 3, HEAD, 1)];
  let r: ReturnType<typeof rig> | undefined;
  // A's factory() fails until the discovery has read the coin's transfers: fromHint cannot confirm A, findPool can
  calls.set(`${A} 0xc45a0155`, () => (r!.st.transfers === 0 ? "error" : word(BigInt(BASE_VENUES.uniswapV3))));
  r = rig({ calls, logs: (q) => (q.address === COIN ? transfers.filter((l) => inRange(q, parseInt(l.blockNumber, 16))) : q.address === A || q.address === Bp ? [] : undefined) });
  const s = B.open(r.chain, r.clock, { fetch: r.fetch as never, pools: new Map(), gecko: r.budget, sleep: async () => undefined, hint: async () => A });
  const a = await s.candles(COIN, "1h", null, 500);
  s.stop();
  assert.equal(a.status, 200, a.body);
  assert.ok(r.st.transfers > 0, "discovered");
  assert.equal(s.kept(COIN)?.pool, A);
});

test("guard: a confirmed quiet pool beside a candidate whose getPool no two providers agreed is no answer (503), never a book or \"no pool\"", async () => {
  const [A, Bp] = [`0x${"a1".repeat(20)}`, `0x${"b1".repeat(20)}`];
  const calls = base();
  v3Pool(calls, A, 2_000_000n << 96n);
  v3Pool(calls, Bp, 2_000_000n << 96n, 500n);
  // A's getPool answers; B's fails on every provider
  calls.set(getPool(500n), "error");
  const transfers = [...transfersFrom(A, 1, HEAD, 0), ...transfersFrom(Bp, 3, HEAD, 1)];
  const r = rig({ calls, logs: (q) => (q.address === COIN ? transfers.filter((l) => inRange(q, parseInt(l.blockNumber, 16))) : q.address === A || q.address === Bp ? [] : undefined) });
  const s = B.open(r.chain, r.clock, { fetch: r.fetch as never, pools: new Map(), gecko: r.budget, sleep: async () => undefined, hint: async () => null });
  const a = await s.candles(COIN, "1h", null, 500);
  s.stop();
  assert.equal(a.status, 503, a.body);
  assert.equal(s.kept(COIN), undefined);
});

test("a quiet native-ETH v4 pool (the list's id, its key from the PositionManager): the mark is its Slot0 read by extsload, at the ETH price the reference pool's Slot0 gives at the same block (red at 4589273f: 429)", async () => {
  // currency0 native ETH, currency1 COIN, fee 3000, tick spacing 60, no hook
  const key = `0x${w(ZERO)}${w(COIN)}${w(word(3000n))}${w(word(60n))}${w(ZERO)}`;
  const id = hex(keccak_256(Buffer.from(key.slice(2), "hex")));
  const calls = base();
  calls.set(`${BASE_VENUES.positionManager} 0x86b6be7d${id.slice(2, 52).padEnd(64, "0")}`, key);
  // 0.0004 ETH per COIN: COIN per wei (token1 / token0) is sqrtPriceX96^2 / 2^192 = 2500; the high bits are lpFee and tick, as on chain
  calls.set(`${BASE_VENUES.poolManager} ${EXTSLOAD}${stateSlot(id).slice(2)}`, word((0x0bb8n << 184n) | (50n << 96n)));
  calls.set(REF_CALL, word((0x01f4n << 184n) | REF_SQRT));
  const r = rig({ calls, logs: (q) => (q.address === COIN ? [] : q.address === BASE_VENUES.poolManager && q.topics?.[1] === id ? [] : undefined) });
  const s = B.open(r.chain, r.clock, { fetch: r.fetch as never, pools: new Map(), gecko: r.budget, sleep: async () => undefined, hint: async () => id });
  const a = await s.candles(COIN, "1h", null, 500);
  s.stop();
  assert.equal(a.status, 200, a.body);
  // 0.0004 * 3,725.2902984619140625
  assert.deepEqual(JSON.parse(a.body).candles, [[bucket(3_600), "1.490116119384765625", "1.490116119384765625", "1.490116119384765625", "1.490116119384765625", "0"]]);
});

for (const stable of [false, true])
  test(`a quiet Aerodrome v2 ${stable ? "stable pool: no mark (its spot is no reserve ratio), the chart is what GeckoTerminal's refusal answers (guard)" : "volatile WETH pool: the mark is its reserves' ratio at the ETH price of the same block (red at 4589273f: 429)"}`, async () => {
    const POOL = `0x${"f2".repeat(20)}`;
    const f = BASE_VENUES.aerodromeV2;
    const calls = base();
    calls.set(`${POOL} 0xc45a0155`, word(BigInt(f)));
    calls.set(`${POOL} 0x0dfe1681`, word(BigInt(BASE_VENUES.weth)));
    calls.set(`${POOL} 0xd21220a7`, word(BigInt(COIN)));
    calls.set(`${POOL} ${sel("stable()")}`, word(stable ? 1n : 0n));
    calls.set(`${f} ${sel("getPool(address,address,bool)")}${w(BASE_VENUES.weth)}${w(COIN)}${w(word(stable ? 1n : 0n))}`, word(BigInt(POOL)));
    // 1 WETH against 2,500 COIN: 0.0004 ETH per COIN
    calls.set(`${POOL} ${sel("getReserves()")}`, `${word(10n ** 18n)}${w(word(2_500n * 10n ** 18n))}${w(word(1_793_000_000n))}`);
    calls.set(REF_CALL, word(REF_SQRT));
    const r = rig({ calls, logs: (q) => (q.address === COIN || q.address === POOL ? [] : undefined) });
    const s = B.open(r.chain, r.clock, { fetch: r.fetch as never, pools: new Map(), gecko: r.budget, sleep: async () => undefined, hint: async () => POOL });
    const a = await s.candles(COIN, "1h", null, 500);
    s.stop();
    if (stable) {
      // no bar of ours, GeckoTerminal's budget spent: the 429 with the wait, never an empty 200 (swaps-cold-chart.test.ts)
      assert.equal(a.status, 429, a.body);
      return;
    }
    assert.equal(a.status, 200, a.body);
    assert.deepEqual(JSON.parse(a.body).candles, [[bucket(3_600), "1.490116119384765625", "1.490116119384765625", "1.490116119384765625", "1.490116119384765625", "0"]]);
  });

test("the pool state reads: the v4 slot is the one read on chain; Slipstream's six-word slot0 and v3's seven both give sqrtPriceX96; a Pons curve has none", () => {
  // read 2026-11-11 07:3xZ: extsload of this slot on Base's PoolManager at block 55960906 answered sqrtPriceX96
  // 3597025213628878668095763, the one the reference pool's Swap logged in that block (base-rpc.publicnode.com)
  assert.equal(S.v4StateSlot(REF_POOL_ID), "0x13a3a697324ba564aa9497aa769e6a226bd6bfbabf96e0d0db3a141173b2893d");
  assert.equal(S.v4StateSlot(REF_POOL_ID), stateSlot(REF_POOL_ID));
  const v3: Pool = { venue: "v3", id: `0x${"f0".repeat(20)}`, token: COIN, tokenIs0: false, quote: { kind: "usd", decimals: 6 } };
  assert.deepEqual(S.poolStateCalls(v3), [{ to: v3.id, data: SLOT0 }]);
  const sqrt = 2_000_000n << 96n;
  for (const words of [6, 7]) assert.deepEqual(S.poolStateLegs(v3, [`${word(sqrt)}${"0".repeat(64 * (words - 1))}`]), { amt: sqrt * sqrt, quote: 1n << 192n });
  assert.equal(S.poolStateLegs(v3, [word(0n)]), null, "an unset price is no mark");
  assert.equal(S.poolStateLegs(v3, [undefined]), null);
  assert.equal(S.poolStateLegs(v3, [word(1n << 160n)]), null, "a sqrtPriceX96 past 160 bits is no slot0");
  const curve: Pool = { venue: "curve", id: `0x${"f1".repeat(20)}`, token: COIN, tokenIs0: false, quote: { kind: "eth", decimals: 18 } };
  assert.equal(S.poolStateCalls(curve), null);
});

// -- PancakeSwap v3 on Base ----------------------------------------------------------------------------------------

/** Read through the namespace's type, so the file loads where the venue is missing (4589273f). */
const PANCAKE_TOPIC = (TOPIC as Record<string, string>).swapPancake;
const PCS = JSON.parse(readFileSync(new URL("./fixtures/swaps-pancake-base.json", import.meta.url), "utf8")) as { pool: string; factory: string; asset0: string; asset1: string; fee: number; log: Record<string, unknown> & { topics: string[] } };
const PCS_POOL: Pool = { venue: "v3", id: PCS.pool, token: PCS.asset0, tokenIs0: true, quote: { kind: "usd", decimals: 6 }, log: "pancake" };

test("PancakeSwap v3: its Swap topic (two protocol-fee fields more than Uniswap v3's) is the one its pools log, read and decoded from a real log (red at 4589273f)", () => {
  assert.equal(PANCAKE_TOPIC, hex(keccak_256(new TextEncoder().encode("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"))));
  assert.equal(PCS.log.topics[0], PANCAKE_TOPIC);
  assert.notEqual(PANCAKE_TOPIC, TOPIC.swap3);
  assert.equal((BASE_VENUES as Record<string, unknown>).pancakeV3, PCS.factory);
  assert.ok(VENUES.base.v3.includes(PCS.factory));
  assert.equal(VENUES.base.getPool[PCS.factory], "fee");
  assert.deepEqual(swapFilter(PCS_POOL, 1, 2).topics, [PANCAKE_TOPIC]);
  const l = parseLog(PCS.log)!;
  // the pool paid 868.503865188635487108 ELSA (amount0 negative) for 57.137132 USDC
  assert.deepEqual(decodeSwap(PCS_POOL, l), { kind: "swap", block: 0x355e3da, index: 0x39, tx: PCS.log.transactionHash, side: "b", amt: 868_503_865_188_635_487_108n, quote: 57_137_132n });
  // the same log is no Uniswap v3 pool's swap, and a Uniswap-shaped log no PancakeSwap pool's
  assert.equal(decodeSwap({ ...PCS_POOL, log: undefined }, l), null);
  assert.equal(decodeSwap(PCS_POOL, { ...l, topics: [TOPIC.swap3, ...l.topics.slice(1)], data: l.data.slice(0, 2 + 64 * 5) }), null);
  // Slipstream's third factory (GeckoTerminal's aerodrome-slipstream-3: RSC / WETH 0x6cda37dd names it) is a venue
  assert.ok(BASE_VENUES.slipstream.includes("0xf8f2eb4940cfe7d13603dddd87f123820fc061ef"));
});

test("a listed token whose list names its PancakeSwap v3 pool: confirmed by the factory's getPool(token0, token1, fee), its swaps read by PancakeSwap's topic, on the tape (red at 4589273f: no trade)", async () => {
  const chain = B.fakeChain();
  const head = chain.st.head;
  const tok = PCS.asset0;
  const calls = new Map<string, string>([
    [`${tok} 0x313ce567`, word(18n)],
    [`${PCS.pool} 0xc45a0155`, word(BigInt(PCS.factory))],
    [`${PCS.pool} 0x0dfe1681`, word(BigInt(PCS.asset0))],
    [`${PCS.pool} 0xd21220a7`, word(BigInt(PCS.asset1))],
    [`${PCS.pool} ${sel("fee()")}`, word(BigInt(PCS.fee))],
    [`${PCS.factory} ${sel("getPool(address,address,uint24)")}${w(PCS.asset0)}${w(PCS.asset1)}${w(word(BigInt(PCS.fee)))}`, word(BigInt(PCS.pool))],
  ]);
  // the recorded log moved to 5 blocks under the head, timed as the fake times that block
  const at = head - 5;
  const log = { ...PCS.log, blockNumber: `0x${at.toString(16)}`, blockTimestamp: `0x${B.timeOf(at).toString(16)}` };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    const mine = reqs.map((r): object | undefined => {
      if (r.method === "eth_call") {
        const c = r.params[0] as { to: string; data: string };
        return { result: calls.get(`${c.to} ${c.data}`) ?? "0x" };
      }
      if (r.method !== "eth_getLogs") return undefined;
      const q = r.params[0] as Filter;
      if (q.address === tok) return { result: [] };
      if (q.address === PCS.pool) return { result: q.topics?.[0] === PANCAKE_TOPIC && inRange(q, at) ? [log] : [] };
      return undefined;
    });
    const rest = reqs.filter((_, i) => mine[i] === undefined);
    const fwd = rest.length === 0 ? [] : ((await (await chain.fetch(url, { ...init, body: JSON.stringify(rest) })).json()) as { id: number }[]);
    const out = reqs.map((r, i) => (mine[i] !== undefined ? { jsonrpc: "2.0", id: r.id, ...mine[i] } : fwd.find((x) => x.id === r.id)));
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  const s = B.open(chain, undefined, { fetch: fetch as never, pools: new Map(), hint: async () => PCS.pool });
  const a = await s.trades(tok, 50);
  s.stop();
  assert.equal(a.status, 200, a.body);
  const trades = JSON.parse(a.body).trades as { side: string; usd: string; amt: string; tx: string }[];
  assert.deepEqual(trades.map((x) => [x.side, x.usd, x.amt, x.tx]), [["b", "57.137132", "868.503865188635487108", PCS.log.transactionHash]]);
});

// -- a bar off the list's price -------------------------------------------------------------------------------------

/** The recorded chain 200 blocks into the recording, where ICNT's pool has swapped (swaps.test.ts reads it so). */
const icntChain = () => {
  const c = B.fakeChain();
  c.st.head = B.REC.firstHead + 200;
  return c;
};
/** ICNT's recorded book's newest close, as served with no list price. */
async function icntClose(): Promise<number> {
  const s = B.open(icntChain());
  const a = await s.candles(B.ICNT, "1m", null, 500);
  s.stop();
  return Number((JSON.parse(a.body).candles as string[][]).at(-1)![4]);
}

test(`SCALE_BOUND ${S.SCALE_BOUND}: a book whose close is 10^11 under the list's price is not served: the answer is a token with no pool's, logged once per book with both prices (red at 4589273f: served)`, async () => {
  const close = await icntClose();
  const lines: string[] = [];
  const s = B.open(icntChain(), undefined, { price: (t) => (t === B.ICNT ? close * 1e11 : null), log: (l) => lines.push(l) });
  const a = await s.candles(B.ICNT, "1m", null, 500);
  const again = await s.candles(B.ICNT, "5m", null, 500);
  s.stop();
  // noneCandles with no GeckoTerminal budget: our own empty chart
  for (const x of [a, again]) {
    assert.equal(x.status, 200, x.body);
    const body = JSON.parse(x.body) as { candles: unknown[]; src: string; own_from_s?: number };
    assert.deepEqual(body.candles, []);
    assert.equal(body.src, "chain");
    assert.equal(body.own_from_s, undefined);
  }
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, new RegExp(B.ICNT));
  assert.ok(lines[0]!.includes(String(close)) && lines[0]!.includes(String(close * 1e11)), lines[0]);
});

for (const [name, price] of [["50 times over the list's price", (c: number) => c / 50], ["no list price", () => null]] as const)
  test(`guard: a book whose close is ${name} is served`, async () => {
    const close = await icntClose();
    const lines: string[] = [];
    const s = B.open(icntChain(), undefined, { price: () => price(close), log: (l) => lines.push(l) });
    const a = await s.candles(B.ICNT, "1m", null, 500);
    s.stop();
    assert.equal(a.status, 200, a.body);
    assert.ok((JSON.parse(a.body).candles as unknown[]).length > 0);
    assert.deepEqual(lines, []);
  });
