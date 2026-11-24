/// <reference types="node" />
// A Raydium CLMM pool read as a market the device does not trade (cards solana-buy-never-below-a-hidden-market and
// clmm-floor-covers-the-whole-buy): replays MPLX's wSOL pool BxRhW4q1… as mainnet answered on 24 Nov
// (test/vectors/mplx-clmm-sim.json: the pool, its AmmConfig, both vaults, MPLX's mint, the Clock and the three tick
// arrays a buy walks, on publicnode (A) and api.mainnet-beta (B), each beside the program's own swap_v2 out for that
// read, from simulateTransaction; test/fixtures/solana-clmm-capture.mjs records it). Good: the kit's floor is the
// program's out to the unit for a buy of 1, 10, 25 and 60 SOL, across up to 8 tick-spacing cells, and for 260 SOL across
// the pool's real initialized tick -2460 (test/vectors/mplx-cross-clmm-sim.json, CL17); a tick crossed takes its
// liquidity_net; the tick math is the program's at its bounds. Bad: a provider that lies about any field the read
// takes (a mint, a vault, the swap switch, the open time, the fee, the price, the liquidity, the SOL vault, a vault's
// owner, mint or program) is refused after one read more, never priced; a lie once is read again; a tick array the
// providers read differently, or one not the pool's, ends the walk before it (CL16); nothing is credited past the arrays
// read (CL15). The set rule a market enters (pool.ts solanaReferenceSet): it can only raise E, never be a pool (CL13).
// The finder scans each quote once, in the program's mint order (CL14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58, base64 } from "@scure/base";
import {
  SOLANA_CLMM_PROGRAM,
  SOLANA_SOL_MINT,
  readSolanaClmmMarket,
  readSolanaClmmPools,
  solanaClmmAgreedTicks,
  solanaClmmFloorFeeRate,
  solanaClmmPoolScan,
  solanaClmmSqrtPriceAtTick,
  solanaClmmSwapOut,
  solanaClmmTickArray,
  solanaClmmWalkStarts,
  solanaDecodeClmmPool,
  solanaLamportsAsUsdc,
  solanaReferenceSet,
  solanaUsdcAsLamports,
} from "../src/index.ts";
import type { SolanaRpc } from "../src/trade/solana/send.ts";

type Answer = { context: { slot: number }; value: ({ owner: string; data: [string, "base64"] } | null)[] };
const V = JSON.parse(readFileSync(new URL("./vectors/mplx-clmm-sim.json", import.meta.url), "utf8")) as {
  coin: string; pool: string; list: string[]; runs: { amount: string; programOut: string; providers: { A: Answer; B: Answer } }[];
};
const SOL = 1_000_000_000n;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
type Edit = (ans: Answer, list: readonly string[]) => Answer;

/** A provider that answers getMultipleAccounts from run `r`'s recording, each asked account by its address. */
function replay(name: "A" | "B", edit: Edit = (a) => a, calls: string[][] = [], r = 0): SolanaRpc {
  const rec = V.runs[r]!.providers[name];
  const byKey = new Map(V.list.map((k, i) => [k, rec.value[i]!]));
  const rpc = (async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getMultipleAccounts");
    const list = params[0] as string[];
    calls.push(list);
    const ans: Answer = { context: { slot: rec.context.slot }, value: list.map((k) => structuredClone(byKey.get(k) ?? null)) };
    return edit(ans, list);
  }) as SolanaRpc;
  return Object.assign(rpc, { url: `https://${name.toLowerCase()}.example` });
}
const bytes = (a: { data: [string, "base64"] }): Uint8Array => base64.decode(a.data[0]);
const put = (a: { data: [string, "base64"] }, d: Uint8Array): void => void (a.data[0] = base64.encode(d));
/** Changes the bytes of the asked account `k` in an answer that has it. */
const on = (k: string, f: (d: Uint8Array, a: { owner: string }) => void): Edit => (ans, list) => {
  const i = list.indexOf(k);
  const a = ans.value[i];
  if (i >= 0 && a) { const d = bytes(a); f(d, a); put(a, d); }
  return ans;
};
const onPool = (f: (d: Uint8Array) => void) => on(V.pool, f);
const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u128 = (d: Uint8Array, o: number) => dv(d).getBigUint64(o, true) + (dv(d).getBigUint64(o + 8, true) << 64n);
const setU128 = (d: Uint8Array, o: number, x: bigint) => { dv(d).setBigUint64(o, x & (2n ** 64n - 1n), true); dv(d).setBigUint64(o + 8, x >> 64n, true); };
const req = { token: V.coin, pool: V.pool, side: "buy" as const, amount: SOL };
const CONFIG = V.list[1]!;
const SOL_VAULT = V.list[3]!;
const COIN_VAULT = V.list[2]!;
// the tick arrays a buy walks: the one that holds the pool's tick (-3000 to -2401), then -2400 and -1800 (tick_array.rs)
const ARRAYS = V.list.slice(6);
/** Puts liquidity `gross` with liquidity_net `net` at tick `t` of the array that holds the pool's tick (TickState at
 *  44 + 168 × slot: tick, liquidity_net i128 at 4, liquidity_gross u128 at 20). */
const plantTick = (t: number, net: bigint, gross: bigint): Edit => on(ARRAYS[0]!, (d) => {
  const o = 44 + ((t - dv(d).getInt32(40, true)) / 10) * 168;
  dv(d).setInt32(o, t, true);
  setU128(d, o + 4, BigInt.asUintN(128, net));
  setU128(d, o + 20, gross);
});
const onArray = (f: (d: Uint8Array) => void): Edit => on(ARRAYS[0]!, f);

test("CL1 the tick math is the program's at its bounds and at 0 (tick_math.rs MIN/MAX_SQRT_PRICE_X64)", () => {
  assert.equal(solanaClmmSqrtPriceAtTick(-443636), 4295048016n);
  assert.equal(solanaClmmSqrtPriceAtTick(443636), 79226673521066979257578248091n);
  assert.equal(solanaClmmSqrtPriceAtTick(0), 1n << 64n);
  assert.throws(() => solanaClmmSqrtPriceAtTick(443637));
  // each tick's price is above the one before
  for (const t of [-28861, -1, 0, 1, 28861]) assert.ok(solanaClmmSqrtPriceAtTick(t + 1) > solanaClmmSqrtPriceAtTick(t));
});

test("CL2 the floor is the program's swap_v2 out to the unit for a buy across many tick-spacing cells, on both providers", async () => {
  // the recording: 1 SOL stays in the pool's cell; 10, 25 and 60 SOL cross 1 to 8 more (a cell held 6.4 to 9 SOL, 24 Nov)
  assert.deepEqual(V.runs.map((r) => r.amount), ["1000000000", "10000000000", "25000000000", "60000000000"]);
  for (const [r, run] of V.runs.entries()) {
    const v = await readSolanaClmmMarket([replay("A", undefined, [], r), replay("B", undefined, [], r)], { ...req, amount: BigInt(run.amount) });
    assert.equal(v.kind, "ok");
    if (v.kind !== "ok") continue;
    for (const x of v.market.reads) {
      assert.ok(x.whole, `${run.amount} lamports in: priced whole`);
      assert.equal(x.out, BigInt(run.programOut), `${run.amount} lamports in`);
    }
  }
});

test("CL3 two honest providers: a wSOL market, its depth the wSOL vault on each, the slots each read's", async () => {
  const r = await readSolanaClmmMarket([replay("A"), replay("B")], req);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.equal(r.market.quote, "sol");
  const vault = (n: "A" | "B") => dv(bytes(V.runs[0]!.providers[n].value[3]!)).getBigUint64(64, true);
  assert.deepEqual(r.market.reads.map((x) => x.depth), [vault("A"), vault("B")]);
  assert.ok(r.market.reads[0].depth > 20_000n * SOL);
  assert.deepEqual(r.market.slots, [V.runs[0]!.providers.A.context.slot, V.runs[0]!.providers.B.context.slot]);
  // the floor is under the price's own bound, by the fee at least
  assert.ok(r.market.reads[0].out < r.market.reads[0].spotOut);
});

test("CL4 the floor's fee: the config's, plus a dynamic fee at its cap, never over 10%; fee on output taken off the out", () => {
  const p = { dynamicFee: null, tickSpacing: 10 };
  assert.equal(solanaClmmFloorFeeRate(1600n, p), 1600n);
  // swap.rs compute_dynamic_fee_rate: ceil(control × (va × spacing)² / (1e5 × 1e4 × 1e4)); control 50,000, cap 20,000,
  // spacing 10: ceil(5e4 × 4e10 / 1e13) = 200
  assert.equal(solanaClmmFloorFeeRate(1600n, { dynamicFee: { control: 50_000n, maxVolatility: 20_000n }, tickSpacing: 10 }), 1800n);
  assert.equal(solanaClmmFloorFeeRate(1600n, { dynamicFee: { control: 3n, maxVolatility: 1n }, tickSpacing: 1 }), 1601n); // ceil
  assert.equal(solanaClmmFloorFeeRate(90_000n, { dynamicFee: { control: 100_000n, maxVolatility: 100_000n }, tickSpacing: 10 }), 100_000n);
  const pool = solanaDecodeClmmPool({ owner: SOLANA_CLMM_PROGRAM, data: bytes(V.runs[0]!.providers.B.value[0]!) });
  const onIn = solanaClmmSwapOut(pool, 1600n, false, SOL);
  const onOut = solanaClmmSwapOut({ ...pool, feeOn: 1 }, 1600n, false, SOL); // token 0 only: a wSOL-in buy (token 1 in) pays it out
  assert.ok(onIn.whole && onOut.whole);
  // the same fee off the out instead of the in pays a little less (the whole input moves the price), within 1 ppm
  assert.ok(onOut.out < onIn.out && (onIn.out - onOut.out) * 1_000_000n < onIn.out, `${onIn.out} ${onOut.out}`);
  assert.ok(solanaClmmSwapOut(pool, 1600n, false, SOL).out < solanaClmmSwapOut(pool, 0n, false, SOL).out);
});

test("CL5 a USDC market is priced through SOL/USD at one dollar a USDC, floor both ways", () => {
  const u = { price: 13_000_000_000n, expo: -8 }; // $130.00
  assert.equal(solanaLamportsAsUsdc(SOL, u), 130_000_000n);
  assert.equal(solanaUsdcAsLamports(130_000_000n, u), SOL);
  assert.equal(solanaUsdcAsLamports(1n, u), 7n); // 1e-6 USD = 7.69 lamports, floor
  assert.equal(solanaLamportsAsUsdc(7n, u), 0n);
});

// every field the read takes, lied about by one provider on every read: refused, never priced
const lies: [string, Edit, RegExp][] = [
  ["another coin as token 0", onPool((d) => d.set(base58.decode(SOLANA_SOL_MINT), 73)), /static bytes differ/],
  ["another vault", onPool((d) => d.set(base58.decode(V.coin), 169)), /static bytes differ/],
  ["swaps switched off", onPool((d) => void (d[389] = d[389]! | 16)), /static bytes differ/],
  ["an open time to come", onPool((d) => dv(d).setBigUint64(1080, 2n ** 62n, true)), /static bytes differ/],
  ["a dynamic fee", onPool((d) => dv(d).setUint32(1102, 100_000, true)), /static bytes differ/],
  ["the trade fee", on(CONFIG, (d) => dv(d).setUint32(47, 100, true)), /config differs/],
  ["the price 5% up", onPool((d) => setU128(d, 253, (u128(d, 253) * 1025n) / 1000n)), /price is outside the band/],
  ["the liquidity 5% up", onPool((d) => setU128(d, 237, (u128(d, 237) * 105n) / 100n)), /liquidity is outside the band/],
  ["the SOL vault 5% up", on(SOL_VAULT, (d) => dv(d).setBigUint64(64, (dv(d).getBigUint64(64, true) * 105n) / 100n, true)), /quote vault is outside the band/],
  ["a vault of another owner", on(SOL_VAULT, (d) => d.set(base58.decode(V.coin), 32)), /another mint or owner/],
  ["a vault of another mint", on(COIN_VAULT, (d) => d.set(base58.decode(SOLANA_SOL_MINT), 0)), /another mint or owner/],
  ["a vault not a token account", on(SOL_VAULT, (_d, a) => void (a.owner = SOLANA_CLMM_PROGRAM)), /not a token account/],
];
for (const [name, lie, why] of lies) {
  test(`CL6 a provider that lies about ${name} on every read: refused after one read more`, async () => {
    const calls: string[][] = [];
    for (const liar of ["A", "B"] as const) {
      const ps = [replay("A", liar === "A" ? lie : undefined, calls), replay("B", liar === "B" ? lie : undefined)] as const;
      const r = await readSolanaClmmMarket(ps, req);
      assert.equal(r.kind, "bad", `${liar} lying: ${JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`);
      if (r.kind === "bad") assert.match(r.why, why);
    }
    // two rounds of a pool read then the pool's own list, per provider, per liar
    assert.equal(calls.length, 8);
  });
}

test("CL7 a lie inside the band is priced on each provider's own read; the judge never mixes them", async () => {
  const r = await readSolanaClmmMarket([replay("A", on(SOL_VAULT, (d) => dv(d).setBigUint64(64, (dv(d).getBigUint64(64, true) * 101n) / 100n, true))), replay("B")], req);
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") assert.ok(r.market.reads[0].depth > r.market.reads[1].depth);
});

test("CL8 a provider that lies once is read again, and the market is agreed", async () => {
  let n = 0;
  const once: Edit = (ans, list) => (list.length > 1 && n++ === 0 ? on(SOL_VAULT, (d) => dv(d).setBigUint64(64, 1n, true))(ans, list) : ans);
  const r = await readSolanaClmmMarket([replay("A", once), replay("B")], req);
  assert.equal(r.kind, "ok");
});

test("CL9 no market: no account on both, a pool of another coin, another program's account, swaps off or not open on both", async () => {
  const gone: Edit = (ans) => ({ ...ans, value: ans.value.map(() => null) });
  assert.deepEqual(await readSolanaClmmMarket([replay("A", gone), replay("B", gone)], req), { kind: "none" });
  assert.deepEqual(await readSolanaClmmMarket([replay("A"), replay("B")], { ...req, token: SOLANA_SOL_MINT }), { kind: "none" });
  assert.deepEqual(await readSolanaClmmMarket([replay("A"), replay("B")], { ...req, token: USDC }), { kind: "none" });
  const other: Edit = (ans, list) => { const a = ans.value[list.indexOf(V.pool)]; if (a) a.owner = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"; return ans; };
  assert.deepEqual(await readSolanaClmmMarket([replay("A", other), replay("B", other)], req), { kind: "none" });
  const off = onPool((d) => void (d[389] = d[389]! | 16));
  assert.deepEqual(await readSolanaClmmMarket([replay("A", off), replay("B", off)], req), { kind: "none" });
  const later = onPool((d) => dv(d).setBigUint64(1080, 2n ** 62n, true));
  assert.deepEqual(await readSolanaClmmMarket([replay("A", later), replay("B", later)], req), { kind: "none" });
});

test("CL10 one provider's fault or a malformed answer is no answer: refused with the fault named, never priced", async () => {
  const dead = Object.assign((async () => { throw Object.assign(new Error("HTTP 429 at https://a.example/?k=hidden"), { status: 429 }); }) as SolanaRpc, { url: "https://a.example" });
  const r = await readSolanaClmmMarket([dead, replay("B")], req);
  assert.equal(r.kind, "bad");
  if (r.kind === "bad") { assert.match(r.why, /provider A gave no answer/); assert.doesNotMatch(r.why, /hidden|example/); }
  const junk: Edit = () => ({ context: { slot: -1 }, value: [] }) as unknown as Answer;
  assert.equal((await readSolanaClmmMarket([replay("A"), replay("B", junk)], req)).kind, "bad");
});

test("CL11 a USDC market with no SOL/USD read is refused, never priced at a guess", async () => {
  const usdc: Edit = (ans, list) => {
    onPool((d) => d.set(base58.decode(USDC), 105))(ans, list);
    return on(SOL_VAULT, (d) => d.set(base58.decode(USDC), 0))(ans, list);
  };
  const r = await readSolanaClmmMarket([replay("A", usdc), replay("B", usdc)], req);
  assert.equal(r.kind, "bad");
  if (r.kind === "bad") assert.match(r.why, /no SOL\/USD price for a USDC market/);
  const priced = await readSolanaClmmMarket([replay("A", usdc), replay("B", usdc)], req, async () => ({ price: 13_000_000_000n, expo: -8 }));
  assert.equal(priced.kind, "ok");
  if (priced.kind === "ok") assert.equal(priced.market.quote, "usdc");
});

test("CL12 the request is checked: two providers that are one, a bad side, amount, leg or address throw", async () => {
  const a = replay("A");
  await assert.rejects(readSolanaClmmMarket([a, a], req), /same provider/);
  await assert.rejects(readSolanaClmmMarket([replay("A"), replay("B")], { ...req, amount: 0n }), /positive u64/);
  await assert.rejects(readSolanaClmmMarket([replay("A"), replay("B")], { ...req, amount: 1n << 64n }), /positive u64/);
  await assert.rejects(readSolanaClmmMarket([replay("A"), replay("B")], { ...req, amounts: [0n] }), /leg/);
  await assert.rejects(readSolanaClmmMarket([replay("A"), replay("B")], { ...req, side: "swap" as "buy" }), /side/);
  await assert.rejects(readSolanaClmmMarket([replay("A"), replay("B")], { ...req, pool: "short" }));
});

// the set rule (pool.ts solanaReferenceSet): a market only read raises E when its depth reaches the cutoff over every
// candidate, never lowers it, is never a pool of the set, and alone makes no reference
const cand = (venue: "pumpswap" | "raydium-clmm", depth: bigint, out: bigint, address: string = venue) =>
  ({ venue, address, reads: [{ depth, out, spotOut: out + 1n }, { depth, out, spotOut: out + 1n }] as const });
test("CL13 the set rule: E is the larger of the traded set's and a counted market's; a market is never a pool", () => {
  const pump = cand("pumpswap", 100n * SOL, 1_000n);
  const deep = solanaReferenceSet([pump, cand("raydium-clmm", 1_000n * SOL, 10_000n)])!;
  assert.equal(deep.expectedOut, 10_000n);
  assert.equal(deep.spotOut, 10_001n);
  assert.deepEqual(deep.pools.map((p) => p.venue), ["pumpswap"]);
  assert.deepEqual(deep.markets?.map((m) => [m.venue, m.counted, m.expectedOut]), [["raydium-clmm", true, 10_000n]]);
  // a market at the cutoff counts; just under it does not (98% of the deepest over every candidate)
  const at = solanaReferenceSet([cand("pumpswap", 98n * SOL, 1_000n), cand("raydium-clmm", 100n * SOL, 5_000n)])!;
  assert.equal(at.expectedOut, 5_000n);
  const under = solanaReferenceSet([pump, cand("raydium-clmm", 97n * SOL, 5_000n)])!;
  assert.equal(under.expectedOut, 1_000n);
  assert.equal(under.markets?.[0]?.counted, false);
  // a deep market's traded pools still form their own set: the market's depth never pushes a traded pool to shallow
  const two = solanaReferenceSet([pump, cand("pumpswap", 99n * SOL, 900n, "p2"), cand("raydium-clmm", 1_000n * SOL, 500n)])!;
  assert.deepEqual(two.pools.map((p) => p.address), ["pumpswap", "p2"]);
  assert.equal(two.shallow, undefined);
  // a market that pays less never lowers E
  assert.equal(two.expectedOut, 1_000n);
  // markets alone make no reference; no market read leaves no `markets`
  assert.equal(solanaReferenceSet([cand("raydium-clmm", 1_000n * SOL, 10_000n)]), null);
  assert.equal(solanaReferenceSet([pump])!.markets, undefined);
  // the cutoff is over every candidate, markets included: a market under a deeper market's cutoff never counts
  const m2 = solanaReferenceSet([pump, cand("raydium-clmm", 1_000n * SOL, 2_000n, "m1"), cand("raydium-clmm", 500n * SOL, 9_000n, "m2")])!;
  assert.equal(m2.expectedOut, 2_000n);
  assert.deepEqual(m2.markets?.map((m) => m.counted), [true, false]);
});

test("CL14 the finder: one scan per quote, in the program's own mint order, on both providers; the union, sorted", async () => {
  const NVDA = "NVDAVuiB7hwd3m5Wa1JuHNovPaPG6BH1QNztbKFxNjv";
  const scans: unknown[][] = [];
  // mainnet's answers on 21 Nov (the seat, public.rpc.solanavibestation.com): NVDAx is token 0 beside both quotes
  const lists: Record<string, string[]> = {
    [JSON.stringify(solanaClmmPoolScan(NVDA, SOLANA_SOL_MINT))]: ["7JPd8k2RngCuRwaBEw1TyqPyyGu6RzGc8jSjaTtjCius", "39WocYEPr94xTaR7xpc9phndeH7cm1mBzQTkg7aHh1cZ"],
    [JSON.stringify(solanaClmmPoolScan(NVDA, USDC))]: ["8HLazC9JupCbmQViNXmZCaQAHZ5opSk2YHH1Yim5SLaQ", "6rgDmdoKjCMz1cQuuXt12Qo6TgkmSwihYDx2nFgABGNE"],
  };
  const scanner = (url: string): SolanaRpc => Object.assign(async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getProgramAccounts");
    scans.push([url, ...params]);
    return { context: { slot: 1 }, value: (lists[JSON.stringify(params)] ?? []).map((pubkey) => ({ pubkey, account: null })) };
  }, { url }) as SolanaRpc;
  const pools = await readSolanaClmmPools([scanner("https://a.example"), scanner("https://b.example")], [replay("A"), replay("B")], NVDA);
  assert.deepEqual(pools, [...Object.values(lists).flat()].sort());
  assert.equal(scans.length, 4);
  // MPLX's own pool has MPLX as token 0: the order the finder scans it in
  const order: unknown[][] = [];
  const one = (url: string): SolanaRpc => Object.assign(async (_m: string, params: readonly unknown[]) => (order.push([...params]), { context: { slot: 1 }, value: [] }), { url }) as SolanaRpc;
  await readSolanaClmmPools([one("https://a.example"), one("https://b.example")], [replay("A"), replay("B")], V.coin);
  const want = [solanaClmmPoolScan(V.coin, SOLANA_SOL_MINT), solanaClmmPoolScan(V.coin, USDC)].map((x) => JSON.stringify(x));
  assert.deepEqual(order.map((x) => JSON.stringify(x)).sort(), [...want, ...want].sort());
  assert.deepEqual(await readSolanaClmmPools([one("https://a.example"), one("https://b.example")], [replay("A"), replay("B")], USDC), []);
});

test("CL15 a buy walks the ticks both providers read: across each initialized tick with its liquidity_net, never past the arrays read", async () => {
  const pool = solanaDecodeClmmPool({ owner: SOLANA_CLMM_PROGRAM, data: bytes(V.runs[2]!.providers.B.value[0]!) });
  // a buy puts wSOL (token 1) in, so MPLX's price moves up: the array that holds tick -2582, then the next two up
  assert.equal(pool.tickCurrent, -2582);
  assert.deepEqual(solanaClmmWalkStarts(pool, V.coin, "buy"), [-3000, -2400, -1800]);
  assert.deepEqual(solanaClmmWalkStarts(pool, V.coin, "sell"), [-3000, -3600, -4200]);
  assert.deepEqual(ARRAYS, [-3000, -2400, -1800].map((s) => solanaClmmTickArray(V.pool, s)));
  // past the arrays read nothing is credited: 20,000 and 40,000 SOL pay the same out, neither whole
  const big = await readSolanaClmmMarket([replay("A", undefined, [], 2), replay("B", undefined, [], 2)], { ...req, amount: 20_000n * SOL, amounts: [20_000n * SOL, 40_000n * SOL] });
  assert.equal(big.kind, "ok");
  if (big.kind === "ok") {
    for (const x of big.market.reads) {
      assert.equal(x.whole, false);
      assert.equal(x.outs[0], x.outs[1]);
      assert.ok(x.out > BigInt(V.runs[3]!.programOut), "the arrays read hold more than 60 SOL's out");
    }
  }
  // a tick crossed takes its liquidity_net: half the pool's liquidity off at -2570 pays less for 25 SOL, as much on pays more
  const L = pool.liquidity;
  const at = async (net: bigint): Promise<bigint> => {
    const v = await readSolanaClmmMarket([replay("A", plantTick(-2570, net, L), [], 2), replay("B", plantTick(-2570, net, L), [], 2)], { ...req, amount: 25n * SOL });
    assert.equal(v.kind, "ok");
    if (v.kind !== "ok") return 0n;
    assert.ok(v.market.reads.every((x) => x.whole));
    return v.market.reads[0].out;
  };
  const program = BigInt(V.runs[2]!.programOut);
  const [less, more] = [await at(-L / 2n), await at(L)];
  assert.ok(less < program && program < more, `${less} < ${program} < ${more}`);
});

test("CL16 a tick array the providers read differently, or one not the pool's, ends the walk before it: never one provider's ticks", async () => {
  const ten = { ...req, amount: 10n * SOL };
  const program = BigInt(V.runs[1]!.programOut);
  const walk = (ea?: Edit, eb?: Edit) => readSolanaClmmMarket([replay("A", ea, [], 1), replay("B", eb, [], 1)], ten);
  const same = await walk();
  assert.ok(same.kind === "ok" && same.market.reads.every((x) => x.whole && x.out === program));
  const cases: [string, Edit | undefined, Edit][] = [
    ["a tick on B alone", undefined, plantTick(-2900, 1n, 1n)],
    ["a liquidity_net B reads one unit off", plantTick(-2900, 5n, 5n), plantTick(-2900, 6n, 5n)],
    ["another pool's array on both", onArray((d) => void (d[8] = d[8]! ^ 1)), onArray((d) => void (d[8] = d[8]! ^ 1))],
    ["another account kind on both", onArray((d) => void (d[0] = d[0]! ^ 1)), onArray((d) => void (d[0] = d[0]! ^ 1))],
  ];
  for (const [name, ea, eb] of cases) {
    const v = await walk(ea, eb);
    assert.equal(v.kind, "ok", name);
    // the array that holds the price is the first, so the walk keeps the pool's own cell alone: 10 SOL is past it
    if (v.kind === "ok") for (const x of v.market.reads) assert.ok(!x.whole && x.out < program, `${name}: ${x.out} whole ${x.whole}`);
  }
  // ticks of another moment (arrays that do not hold the read's price) leave the read its own cell
  const pool = solanaDecodeClmmPool({ owner: SOLANA_CLMM_PROGRAM, data: bytes(V.runs[1]!.providers.B.value[0]!) });
  const cell = solanaClmmSwapOut(pool, 1600n, false, 10n * SOL);
  assert.equal(cell.whole, false);
  assert.deepEqual(solanaClmmSwapOut(pool, 1600n, false, 10n * SOL, { lo: -1800, hi: -1200, at: new Map() }), cell);
});

// test/vectors/mplx-cross-clmm-sim.json: the same pool read on mainnet 24 Nov 11:1xZ with the program's out for a 700 SOL
// buy, which crosses the pool's real initialized tick -2460 (510 SOL from that read's tick -2731); its payer is a public
// wallet holding that much SOL and no MPLX account (solana-clmm-capture.mjs --payer), simulated unsigned like the others
const X = JSON.parse(readFileSync(new URL("./vectors/mplx-cross-clmm-sim.json", import.meta.url), "utf8")) as typeof V;
const replayCross = (name: "A" | "B", edit: Edit = (a) => a): SolanaRpc => {
  const rec = X.runs[0]!.providers[name];
  const byKey = new Map(X.list.map((k, i) => [k, rec.value[i]!]));
  return Object.assign((async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getMultipleAccounts");
    return edit({ context: { slot: rec.context.slot }, value: (params[0] as string[]).map((k) => structuredClone(byKey.get(k) ?? null)) }, params[0] as string[]);
  }) as SolanaRpc, { url: `https://${name.toLowerCase()}.example` });
};

test("CL17 a buy across a real initialized tick is the program's swap_v2 out to the unit: the input's fee spent at the tick, its liquidity_net taken", async () => {
  const run = X.runs[0]!;
  assert.equal(X.pool, V.pool);
  const pool = solanaDecodeClmmPool({ owner: SOLANA_CLMM_PROGRAM, data: bytes(run.providers.B.value[0]!) });
  const ticks = [...solanaClmmAgreedTicks(run.providers.A.value.slice(6).map((a) => a && { owner: a.owner, data: bytes(a) }), run.providers.B.value.slice(6).map((a) => a && { owner: a.owner, data: bytes(a) }), solanaClmmWalkStarts(pool, X.coin, "buy"), X.pool, pool.tickSpacing)!.at];
  // the buy's way up from the pool's tick meets the initialized tick -2460, whose liquidity_net is real (not planted)
  const met = ticks.filter(([t]) => t > pool.tickCurrent && t <= -2460);
  assert.ok(met.length > 0 && met.every(([, net]) => net !== 0n), JSON.stringify(met.map(([t, n]) => [t, String(n)])));
  // and the buy crosses it: the wSOL that moves the price to -2460 on the read's liquidity, with the fee at its 10% cap,
  // is under the buy (an earlier capture at 260 SOL stopped short of it once the price had moved: nothing crossed)
  const toTick = (pool.liquidity * (solanaClmmSqrtPriceAtTick(-2460) - pool.sqrtPriceX64)) >> 64n;
  assert.ok((toTick * 10n) / 9n < BigInt(run.amount), `${toTick} lamports to -2460 from ${pool.tickCurrent}, the buy ${run.amount}`);
  const v = await readSolanaClmmMarket([replayCross("A"), replayCross("B")], { ...req, amount: BigInt(run.amount) });
  assert.equal(v.kind, "ok");
  if (v.kind !== "ok") return;
  for (const x of v.market.reads) {
    assert.ok(x.whole, "priced whole: the arrays read hold the buy");
    assert.equal(x.out, BigInt(run.programOut), `${run.amount} lamports in, across ${met.map(([t]) => t).join(", ")}`);
  }
});
