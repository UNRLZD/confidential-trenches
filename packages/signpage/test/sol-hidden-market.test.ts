/// <reference types="node" />
// A Solana buy is never priced below the coin's real market (card solana-buy-never-below-a-hidden-market). The coin is
// the kit's recorded PumpSwap coin (packages/kit/test/fixtures/solana-pool.json: its canonical pool read on two
// providers), and beside it a deep Raydium CLMM market, planted: MPLX's real CLMM pool and vaults
// (packages/kit/test/vectors/mplx-clmm-sim.json, read on publicnode and api.mainnet-beta on 21 Nov, 24201 SOL deep) with
// the coin in MPLX's place and its price set so the market pays ten times the coin per SOL that the PumpSwap pool does:
// the PumpSwap pool is a thin one at a tenth of the market. Before this card the reference read no CLMM market, so E was
// the PumpSwap pool's own out and the buy took it (red at main, HM1). Now the market's floor is E and the buy is refused
// below_reference before any move (HM1). A market priced at the PumpSwap pool's own level changes nothing (HM2); a
// market under the cutoff never counts (HM3); a market is never a pool to buy (HM4); a provider that lies about the
// market refuses the read, never prices it (HM5). The page asks its market finder for a buy and never for a sell (HM6),
// keeps it past the tap's table pin and never routes through it (HM7), refuses a tap whose market scan failed (HM8), and
// keeps a coin's market list 10 minutes (HM9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58, base64 } from "@scure/base";
import { readSolanaReferenceWhy, solanaClmmSqrtPriceAtTick, solanaClmmReadList, solanaDecodeClmmPool, SOLANA_CLMM_PROGRAM, type SolanaReference } from "../../kit/src/index.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { keptPools, MARKETS_KEEP_MS, pageReference, pinnedPoolFinders, POOL_FINDER_VENUES, POOLS_KEEP_MS, solanaBuyVenue, type PoolFinders, type PoolsOf } from "../src/page-rpc.ts";

type RawAcc = { owner: string; data: [string, string] } | null;
type Answer = { context: { slot: number }; value: RawAcc[] };
type Scenario = { venue: string; side: "buy" | "sell"; amount: string; crosses?: boolean; lists: Record<"curve" | "pool", string[]>; reads: Record<"curve" | "pool", [Answer, Answer][]> };
const FX = JSON.parse(readFileSync(new URL("../../kit/test/fixtures/solana-pool.json", import.meta.url), "utf8")) as { tokens: { mint: string; venue: string; scenarios: Scenario[] }[] };
const SIM = JSON.parse(readFileSync(new URL("../../kit/test/vectors/mplx-clmm-sim.json", import.meta.url), "utf8")) as { coin: string; pool: string; list: string[]; runs: { providers: Record<"A" | "B", Answer> }[] };
const coin = FX.tokens.find((t) => t.venue === "pumpswap")!;
const buy = coin.scenarios.find((s) => s.side === "buy" && !s.crosses)!;
const A = BigInt(buy.amount);
const POOL = SIM.pool;
const PINNED = new Set(["pump-curve", "pumpswap"]);
const SLIPPAGE = 500;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const show = (x: unknown): string => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? String(v) : v));
const bytes = (a: RawAcc): Uint8Array => base64.decode(a!.data[0]);
const put = (a: RawAcc, d: Uint8Array): void => void (a!.data[0] = base64.encode(d));
const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const setU128 = (d: Uint8Array, o: number, x: bigint) => { dv(d).setBigUint64(o, x & (2n ** 64n - 1n), true); dv(d).setBigUint64(o + 8, x >> 64n, true); };
const isqrt = (n: bigint): bigint => { if (n < 2n) return n; let x = BigInt(Math.floor(Math.sqrt(Number(n)))); while (x * x > n) x--; while ((x + 1n) * (x + 1n) <= n) x++; return x; };
const tickAt = (sqrt: bigint): number => { let lo = -443636, hi = 443636; while (lo < hi) { const m = Math.floor((lo + hi + 1) / 2); if (solanaClmmSqrtPriceAtTick(m) <= sqrt) lo = m; else hi = m - 1; } return lo; };

/** The CLMM market's answer for provider `p` (0 or 1), the coin in MPLX's place, paying `times` × `perLamport` coin
 *  per lamport at its spot, with liquidity enough to keep the buy inside its cell; `lie` edits it last. */
function market(p: 0 | 1, perLamport: { out: bigint; in: bigint }, times: bigint, lie: (acc: RawAcc[]) => void = () => {}): Answer {
  const rec = clone(SIM.runs[0]!.providers[p === 0 ? "A" : "B"]);
  const acc = rec.value;
  const pool = bytes(acc[0]!);
  pool.set(base58.decode(coin.mint), 73); // token 0: the coin; token 1 stays wSOL
  // price (token 1 per token 0) = SOL per coin = in / (times × out)
  const sqrt = isqrt((perLamport.in << 128n) / (times * perLamport.out));
  setU128(pool, 253, sqrt);
  const tick = tickAt(sqrt);
  dv(pool).setInt32(269, tick, true);
  const edge = solanaClmmSqrtPriceAtTick((Math.floor(tick / 10) + 1) * 10);
  setU128(pool, 237, ((A * 4n) << 64n) / (edge - sqrt)); // 4 × the buy's input fits before the cell's edge
  put(acc[0]!, pool);
  const v0 = bytes(acc[2]!);
  v0.set(base58.decode(coin.mint), 0);
  put(acc[2]!, v0);
  // the coin's own mint account, as the PumpSwap read has it
  acc[4] = clone(buy.reads.pool[0]![p].value[0]!);
  lie(acc);
  return rec;
}

/** Two providers: the coin's recorded PumpSwap reads, and the planted market. */
type Lie = { p: 0 | 1 | "both"; f: (acc: RawAcc[]) => void };
function providers(times: bigint | null, lie: Lie | null = null): readonly [SolanaRpc, SolanaRpc] {
  const own = buy.reads.pool[0]!;
  return ([0, 1] as const).map((p) => Object.assign(async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getMultipleAccounts");
    const list = params[0] as string[];
    if (JSON.stringify(list) === JSON.stringify(buy.lists.pool)) return clone(own[p]);
    if (JSON.stringify(list) === JSON.stringify(buy.lists.curve)) return clone(buy.reads.curve[0]![p]);
    assert.ok(times !== null, "a market read where none was asked");
    const m = market(p, PER, times, lie !== null && (lie.p === p || lie.p === "both") ? lie.f : undefined);
    if (JSON.stringify(list) === JSON.stringify([POOL])) return { context: m.context, value: [m.value[0]] };
    const planned = solanaClmmReadList(POOL, solanaDecodeClmmPool({ owner: SOLANA_CLMM_PROGRAM, data: bytes(m.value[0]!) }), coin.mint);
    assert.deepEqual(list, planned);
    return m;
  }, { url: `https://${"ab"[p]}.example` })) as unknown as readonly [SolanaRpc, SolanaRpc];
}
// the PumpSwap pool's own out for the buy, the bar the market is priced against
let PER = { out: 1n, in: A };
const ref = async (clmm: boolean, times: bigint | null, lie: Lie | null = null) =>
  readSolanaReferenceWhy(providers(times, lie), { side: "buy", token: coin.mint, amount: A, ...(clmm ? { clmmPools: [POOL] } : {}) });

test("HM0 the PumpSwap coin's own reference: its pool is E, and a buy of it is taken", async () => {
  const r = await ref(false, null);
  assert.ok("reference" in r, show(r));
  const own = (r as { reference: SolanaReference }).reference;
  PER = { out: own.expectedOut, in: A };
  assert.equal(own.pools[0]!.venue, "pumpswap");
  assert.ok("pool" in solanaBuyVenue(own, PINNED, SLIPPAGE));
});

test("HM1 a thin pinned pool at a tenth of a deep CLMM market: refused below_reference, never bought", async () => {
  const r = await ref(true, 10n);
  assert.ok("reference" in r, show(r));
  const x = (r as { reference: SolanaReference }).reference;
  const pump = x.pools.find((p) => p.venue === "pumpswap")!;
  // the buy first: refused before any move, never the thin pool
  assert.deepEqual(solanaBuyVenue(x, PINNED, SLIPPAGE), { error: "below_reference" });
  // the market's floor is E, near ten times the pool's own out, and it counted: it is the coin's deepest
  assert.equal(x.markets?.length, 1);
  assert.equal(x.markets![0]!.counted, true);
  assert.ok(x.markets![0]!.depth[0] > pump.depth[0]);
  assert.equal(x.expectedOut, x.markets![0]!.expectedOut);
  assert.ok(x.expectedOut > pump.expectedOut * 9n, `E ${x.expectedOut} vs the pool's ${pump.expectedOut}`);
});

test("HM2 a market priced at the pool's own level raises nothing past the slippage: the buy is taken", async () => {
  const r = await ref(true, 1n);
  const x = (r as { reference: SolanaReference }).reference;
  assert.ok(x.markets![0]!.counted);
  assert.ok("pool" in solanaBuyVenue(x, PINNED, SLIPPAGE), show(solanaBuyVenue(x, PINNED, SLIPPAGE)));
});

test("HM3 a market whose depth is under the cutoff never counts, whatever it pays", async () => {
  // its SOL vault (token 1, the list's 4th) down to a lamport on both: far under the PumpSwap pool's depth
  const shallow = (acc: RawAcc[]) => { const d = bytes(acc[3]!); dv(d).setBigUint64(64, 1_000n, true); put(acc[3]!, d); };
  const r = await ref(true, 10n, { p: "both", f: shallow });
  const x = (r as { reference: SolanaReference }).reference;
  assert.equal(x.markets![0]!.counted, false);
  assert.ok("pool" in solanaBuyVenue(x, PINNED, SLIPPAGE));
});

test("HM4 a market is never a pool: not in pools or shallow, and no venue a buy takes", async () => {
  const x = ((await ref(true, 1n)) as { reference: SolanaReference }).reference;
  for (const p of [...x.pools, ...(x.shallow ?? [])]) assert.notEqual(p.venue, "raydium-clmm");
  const v = solanaBuyVenue(x, new Set(["raydium-clmm"]), SLIPPAGE);
  assert.deepEqual(v, { error: "venue_not_pinned" });
});

test("HM5 a provider that lies about the market's price refuses the read, never prices the buy", async () => {
  const lie = (acc: RawAcc[]) => { const d = bytes(acc[0]!); dv(d).setBigUint64(253, dv(d).getBigUint64(253, true) / 2n, true); put(acc[0]!, d); };
  const r = await ref(true, 10n, { p: 1, f: lie });
  assert.ok("refused" in r, show(r));
  assert.match((r as { refused: string }).refused, /raydium-clmm .*(price|static bytes|band)/);
});

// the page's own wiring (src/page-rpc.ts): the market finder is asked for a buy only, its pools reach the read as
// `clmmPools`, it survives the tap's table pin with no table, and a fault of its scan refuses a tap, never prices it bare
const finder = (pools: readonly string[] | Error, asked: string[] = []): PoolsOf => async (token: string) => {
  asked.push(token);
  if (pools instanceof Error) throw pools;
  return pools;
};

test("HM6 the page's buy asks the market finder and is refused below_reference; a sell never asks it", async () => {
  const asked: string[] = [];
  const f: PoolFinders = { clmmPools: finder([POOL], asked) };
  const x = await pageReference(providers(10n), { side: "buy", token: coin.mint, amount: A }, f);
  assert.deepEqual(asked, [coin.mint]);
  assert.equal(x?.markets?.[0]?.address, POOL);
  assert.deepEqual(solanaBuyVenue(x, PINNED, SLIPPAGE), { error: "below_reference" });
  const sold: string[] = [];
  await pageReference(providers(null), { side: "sell", token: coin.mint, amount: A }, { clmmPools: finder([POOL], sold) }).catch(() => null);
  assert.deepEqual(sold, []);
});

test("HM7 the tap's pin keeps the market finder with no table for it; readCoinVenue never takes a market", async () => {
  const f: PoolFinders = { clmmPools: finder([POOL]), cpmmPools: finder([]) };
  const pinned = pinnedPoolFinders(f, { pumpswap: ["x"] });
  assert.deepEqual(Object.keys(pinned ?? {}), ["clmmPools"]);
  assert.deepEqual(Object.values(POOL_FINDER_VENUES).filter((v) => (v as string) === "raydium-clmm"), []);
});

test("HM8 a market scan that faults refuses the tap's buy with its fault; a preview reads on without it", async () => {
  const fault = new Error("the CLMM scan: no answer");
  await assert.rejects(pageReference(providers(null), { side: "buy", token: coin.mint, amount: A }, { clmmPools: finder(fault) }), /CLMM scan/);
  const early = await pageReference(providers(null), { side: "buy", token: coin.mint, amount: A }, { clmmPools: Object.assign(finder(fault), { early: finder(fault) }) }, { early: true });
  assert.equal(early?.pools[0]?.venue, "pumpswap");
});

test("HM9 the device keeps a coin's markets 10 minutes (a venue's pools a minute): one seat scan a coin per 10 min", async () => {
  let t = 0;
  let scans = 0;
  const scanner = (url: string): SolanaRpc => Object.assign(async (method: string) => {
    assert.equal(method, "getProgramAccounts");
    scans++;
    return { context: { slot: 1 }, value: [] };
  }, { url }) as unknown as SolanaRpc;
  const pair = () => [scanner("https://a.example"), scanner("https://b.example")] as const;
  const markets = keptPools("clmmPools", pair, pair, () => t);
  await markets(coin.mint);
  const first = scans;
  assert.equal(first, 4); // wSOL and USDC, once each, on both providers
  t = MARKETS_KEEP_MS - 1;
  await markets(coin.mint);
  assert.equal(scans, first);
  t = MARKETS_KEEP_MS + 1;
  await markets(coin.mint);
  assert.equal(scans, 2 * first);
  // a venue's finder keeps its pools POOLS_KEEP_MS alone
  let v = 0;
  const venue = keptPools("cpmmPools", pair, pair, () => v);
  await venue(coin.mint);
  const one = scans;
  v = POOLS_KEEP_MS + 1;
  await venue(coin.mint);
  assert.ok(scans > one);
  assert.equal(MARKETS_KEEP_MS, 600_000);
});
