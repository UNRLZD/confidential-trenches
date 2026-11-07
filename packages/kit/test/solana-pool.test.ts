/// <reference types="node" />
// The device's on-chain reference E (markets paper S12, §2.0 LD1): replays real mainnet answers recorded by
// test/fixtures/solana-pool-capture.mjs. One live pump.fun bonding-curve token and one graduated token in its PumpSwap
// canonical pool, each venue's accounts read with one getMultipleAccounts at `confirmed` on two public RPCs, and a real
// Jupiter route on that venue alone simulated on both for the same exact input, kept only when the venue's accounts
// read the same before and after. Good: E equal to the simulated out on every venue and side, and on a buy that
// crosses the curve's end; a reserve inside the band agrees and the larger-output read sets E; each leg's E comes from
// that same read. Bad: a reserve outside the band (after one re-read, which refuses the whole route), a static byte
// that differs, a wrong owner, discriminator, vault or canonical pool, a malformed answer, and a liar who inflates a
// pool's depth on one provider are each refused or unable to move the reference. Unit vectors pin each fee and
// rounding rule on decoded inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58, base64 } from "@scure/base";
import {
  SOLANA_POOL_READ_TOL_BPS,
  readSolanaReference,
  solanaCurveOut,
  solanaCurveRates,
  solanaDecodeBondingCurve,
  solanaDecodeFeeConfig,
  solanaDecodeMint,
  solanaDecodePumpGlobal,
  solanaFeeTier,
  solanaPoolAddresses,
  solanaPumpSwapOut,
  solanaPumpSwapRates,
  solanaReferenceSet,
  solanaReservesAgree,
  type SolanaBondingCurve,
  type SolanaFeeConfig,
  type SolanaPumpGlobal,
  type SolanaPumpSwapConfig,
  type SolanaPumpSwapPool,
  type SolanaReference,
} from "../src/trade/solana/pool.ts";
import { solanaPacedRpc, type SolanaRpc } from "../src/trade/solana/send.ts";

type RawAcc = { owner: string; lamports: number; data: [string, string]; executable?: boolean } | null;
type Answer = { context: { slot: number }; value: RawAcc[] };
type Venue = "curve" | "pool";
type Scenario = {
  venue: "pump-curve" | "pumpswap";
  side: "buy" | "sell";
  amount: string;
  amounts: string[];
  outAccount: string;
  crosses?: boolean;
  lists: Record<Venue, string[]>;
  reads: Record<Venue, [Answer, Answer][]>;
  pre: { value: RawAcc[] }[];
  sims: { context: { slot: number }; value: { err: unknown; accounts: RawAcc[] } }[];
};
type Token = { mint: string; venue: string; scenarios: Scenario[] };
type Fixture = { rpcs: [string, string]; tokens: Token[] };
const fx = JSON.parse(readFileSync(new URL("./fixtures/solana-pool.json", import.meta.url), "utf8")) as Fixture;
const curveToken = fx.tokens.find((t) => t.venue === "pump-curve")!;
const ammToken = fx.tokens.find((t) => t.venue === "pumpswap")!;
const scenario = (t: Token, side: "buy" | "sell"): Scenario => t.scenarios.find((s) => s.side === side && !s.crosses)!;
const crossing = curveToken.scenarios.find((s) => s.crosses)!;
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SYSTEM = "11111111111111111111111111111111";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const CI = { mint: 0, curve: 1, pumpGlobal: 2, pumpFeeConfig: 3, baseT: 4, baseT22: 5 } as const;
const PI = { mint: 0, pool: 1, ammGlobalConfig: 2, ammFeeConfig: 3, baseT: 4, baseT22: 5, quote: 6 } as const;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const bytes = (a: RawAcc): Uint8Array => base64.decode(a!.data[0]);
const setBytes = (a: RawAcc, d: Uint8Array): void => { a!.data[0] = base64.encode(d); };
const u64 = (d: Uint8Array, o: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
const putU64 = (d: Uint8Array, o: number, v: bigint): void => new DataView(d.buffer, d.byteOffset, d.byteLength).setBigUint64(o, v, true);
const tokenAmount = (a: RawAcc): bigint => (a ? u64(bytes(a), 64) : 0n);
const edit = (a: RawAcc, f: (d: Uint8Array) => void): void => { const d = bytes(a); f(d); setBytes(a, d); };

type Fake = SolanaRpc & { calls: number; by: Record<Venue, number> };
/** A provider that answers each venue's getMultipleAccounts from that venue's recorded answers, one per call (the
 * last repeats). */
function provider(url: string, answers: Record<Venue, unknown[]>, lists: Record<Venue, string[]>): Fake {
  const fn = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    assert.equal(method, "getMultipleAccounts");
    const v: Venue = JSON.stringify(params[0]) === JSON.stringify(lists.curve) ? "curve" : "pool";
    assert.deepEqual(params, [lists[v], { encoding: "base64", commitment: "confirmed" }]);
    f.calls++;
    const list = answers[v];
    return clone(list[Math.min(f.by[v]++, list.length - 1)]);
  };
  const f = Object.assign(fn, { url, calls: 0, by: { curve: 0, pool: 0 } });
  return f;
}
/** Both providers over a scenario's recorded reads, each changed by `change(provider, venue, read index, answer)`. */
function pair(s: Scenario, change: (p: 0 | 1, v: Venue, n: number, a: Answer) => void = () => {}): [Fake, Fake] {
  const per = ([0, 1] as const).map((p) => {
    const one = (v: Venue) => s.reads[v].map((r, n) => { const a = clone(r[p]); change(p, v, n, a); return a; });
    return { curve: one("curve"), pool: one("pool") };
  });
  return [provider(fx.rpcs[0], per[0]!, s.lists), provider(fx.rpcs[1], per[1]!, s.lists)];
}
const req = (t: Token, s: Scenario, legs = false) => ({ side: s.side, token: t.mint, amount: BigInt(s.amount), ...(legs ? { amounts: s.amounts.map(BigInt) } : {}) });
const show = (r: SolanaReference | null): string => JSON.stringify(r, (_, v) => (typeof v === "bigint" ? String(v) : v));
const simulatedOut = (s: Scenario, p: number): bigint => tokenAmount(s.sims[p]!.value.accounts[0]!) - tokenAmount(s.pre[p]!.value[0]!);

test("the fixture's addresses are the kit's own derivation (the capture derives them separately)", () => {
  for (const t of fx.tokens) for (const s of t.scenarios) {
    const a = solanaPoolAddresses(t.mint);
    assert.deepEqual(s.lists, { curve: a.curveList, pool: a.poolList });
    assert.ok(a.curveList.length <= 10 && a.poolList.length <= 10, "at most 10 accounts in one call");
  }
});

for (const [t, s, name] of [
  [curveToken, scenario(curveToken, "buy"), "pump-curve buy"],
  [curveToken, scenario(curveToken, "sell"), "pump-curve sell"],
  [curveToken, crossing, "pump-curve buy past the curve's end"],
  [ammToken, scenario(ammToken, "buy"), "pumpswap buy"],
  [ammToken, scenario(ammToken, "sell"), "pumpswap sell"],
] as const) {
  test(`${name}: E equals the simulated out of a real Jupiter route on that venue, for the same exact input`, async () => {
    const [a, b] = pair(s);
    const ref = await readSolanaReference([a, b], req(t, s, true));
    assert.ok(ref, "a reference");
    assert.equal(ref.pools.length, 1);
    assert.equal(ref.pools[0]!.venue, t.venue);
    assert.equal(ref.pools[0]!.address, t.venue === "pump-curve" ? solanaPoolAddresses(t.mint).curve : solanaPoolAddresses(t.mint).pool);
    for (const [p, sim] of s.sims.entries()) {
      assert.equal(sim.value.err, null);
      assert.equal(ref.expectedOut, simulatedOut(s, p), `${name} on ${fx.rpcs[p]}`);
    }
    assert.ok(ref.spotOut !== null && ref.spotOut >= ref.expectedOut, "spot out is at least E");
    // each leg's E from the same read, with no extra call
    assert.deepEqual([a.calls, b.calls], [2, 2], "one call per venue per provider");
    assert.equal(ref.expectedOuts.length, s.amounts.length);
    for (const [k, x] of s.amounts.entries()) {
      const alone = await readSolanaReference(pair(s), { side: s.side, token: t.mint, amount: BigInt(x) });
      assert.equal(ref.expectedOuts[k], alone!.expectedOut, `leg ${k}`);
    }
    if (s.crosses) {
      const curve = solanaDecodeBondingCurve({ owner: PUMP, data: bytes(s.reads.curve[0]![0].value[CI.curve]!) });
      assert.ok(ref.expectedOut > curve.realTokenReserves, "the buy crosses the curve's end");
    }
  });
}

test("each leg's E comes from the read that set E, and a bad leg list is refused", async () => {
  const s = scenario(curveToken, "buy");
  // provider B reads 1.5% more virtual tokens: B's read sets E, and every leg's E must be B's too
  const [a, b] = pair(s, (p, v, _n, ans) => { if (p === 1 && v === "curve") edit(ans.value[CI.curve]!, (d) => putU64(d, 8, (u64(d, 8) * 10_150n) / 10_000n)); });
  const ref = await readSolanaReference([a, b], req(curveToken, s, true));
  assert.ok(ref, show(ref));
  const [a2, b2] = pair(s, (_p, v, _n, ans) => { if (v === "curve") edit(ans.value[CI.curve]!, (d) => putU64(d, 8, (u64(d, 8) * 10_150n) / 10_000n)); });
  for (const [k, x] of s.amounts.entries()) {
    const raised = await readSolanaReference([a2, b2], { side: "buy", token: curveToken.mint, amount: BigInt(x) });
    assert.equal(ref.expectedOuts[k], raised!.expectedOut, `leg ${k} from B's read`);
  }
  assert.deepEqual((await readSolanaReference(pair(s), req(curveToken, s)))!.expectedOuts, []);
  await assert.rejects(readSolanaReference(pair(s), { ...req(curveToken, s), amounts: [0n] }), /positive u64/);
  await assert.rejects(readSolanaReference(pair(s), { ...req(curveToken, s), amounts: Array.from({ length: 65 }, () => 1n) }), /at most 64/);
});

test("a reserve inside the band agrees, and E comes from the read with the larger output", async () => {
  const s = scenario(curveToken, "buy");
  // provider B reads 1.5% more virtual tokens: inside the 200 bps band, and more tokens out for the same lamports
  let raised = 0n;
  const [a, b] = pair(s, (p, v, _n, ans) => {
    if (p !== 1 || v !== "curve") return;
    edit(ans.value[CI.curve]!, (d) => { raised = (u64(d, 8) * 10_150n) / 10_000n; putU64(d, 8, raised); });
  });
  const ref = await readSolanaReference([a, b], req(curveToken, s));
  assert.ok(ref, show(ref));
  const accB = s.reads.curve[0]![1].value;
  const curveB = solanaDecodeBondingCurve({ owner: PUMP, data: bytes(accB[CI.curve]!) });
  const want = solanaCurveOut("buy", BigInt(s.amount), { ...curveB, virtualTokenReserves: raised },
    solanaDecodePumpGlobal({ owner: PUMP, data: bytes(accB[CI.pumpGlobal]!) }),
    solanaDecodeFeeConfig({ owner: accB[CI.pumpFeeConfig]!.owner, data: bytes(accB[CI.pumpFeeConfig]!) }),
    solanaDecodeMint({ owner: accB[CI.mint]!.owner, data: bytes(accB[CI.mint]!) }).supply,
    tokenAmount(accB[CI.baseT22]!));
  assert.equal(ref.expectedOut, want.out);
  const honest = await readSolanaReference(pair(s), req(curveToken, s));
  assert.ok(honest && ref.expectedOut > honest.expectedOut, "the larger-output read sets E");
  assert.equal(a.by.curve, 1, "no re-read inside the band");
});

test("a reserve outside the band is read once more on both, then the route is refused", async () => {
  for (const [t, side, v, index, offset] of [
    [curveToken, "buy", "curve", CI.curve, 16],
    [curveToken, "buy", "curve", CI.curve, 8],
    [curveToken, "buy", "curve", CI.baseT22, 64],
    [ammToken, "sell", "pool", PI.quote, 64],
    [ammToken, "sell", "pool", PI.baseT22, 64],
  ] as const) {
    const s = scenario(t, side);
    const lie = (d: Uint8Array) => putU64(d, offset, (u64(d, offset) * 10_300n) / 10_000n);
    // provider B reads 3% more, on every read
    const [a, b] = pair(s, (p, w, _n, ans) => { if (p === 1 && w === v) edit(ans.value[index]!, lie); });
    assert.equal(await readSolanaReference([a, b], req(t, s)), null, `${t.venue} ${index}@${offset}: refused`);
    assert.deepEqual([a.by[v], b.by[v]], [2, 2], "one re-read on both, no more");
    // the same lie on the first read only: the re-read agrees and the candidate stands
    const [a2, b2] = pair(s, (p, w, n, ans) => { if (p === 1 && w === v && n === 0) edit(ans.value[index]!, lie); });
    assert.ok(await readSolanaReference([a2, b2], req(t, s)), `${t.venue}: agreed on the re-read`);
  }
  assert.equal(solanaReservesAgree(10_000n, 10_200n), true);
  assert.equal(solanaReservesAgree(10_200n, 10_000n), true);
  assert.equal(solanaReservesAgree(10_000n, 10_201n), false);
  assert.equal(solanaReservesAgree(10_201n, 10_000n), false);
  assert.equal(SOLANA_POOL_READ_TOL_BPS, 200);
});

test("a candidate that still disagrees after the re-read refuses the route, even with another candidate agreed", async () => {
  // the graduated token's reads, with a live curve beside its pool whose SOL reserve B reads 3% higher, every read
  const s = scenario(ammToken, "buy");
  const live = scenario(curveToken, "buy").reads.curve[0]![0].value;
  const addr = solanaPoolAddresses(ammToken.mint);
  const [a, b] = pair(s, (p, v, _n, ans) => {
    if (v !== "curve") return;
    const d = bytes(live[CI.curve]!);
    if (p === 1) putU64(d, 16, (u64(d, 16) * 10_300n) / 10_000n);
    ans.value[CI.curve] = { owner: PUMP, lamports: 1, data: [base64.encode(d), "base64"] };
    const t = bytes(live[CI.baseT22]!);
    t.set(base58.decode(ammToken.mint), 0);
    t.set(base58.decode(addr.curve), 32);
    ans.value[CI.baseT22] = { owner: T22, lamports: 1, data: [base64.encode(t), "base64"] };
  });
  assert.equal(await readSolanaReference([a, b], req(ammToken, s)), null);
  assert.deepEqual([a.by.curve, a.by.pool], [2, 1]);
});

test("a static byte that differs between the providers is refused (pump Global, PumpSwap GlobalConfig, the mint)", async () => {
  for (const [t, v, index, at] of [
    [curveToken, "curve", CI.pumpGlobal, 105],
    [curveToken, "curve", CI.pumpGlobal, 146],
    [curveToken, "curve", CI.pumpFeeConfig, 80],
    [ammToken, "pool", PI.ammGlobalConfig, 48],
    [ammToken, "pool", PI.ammFeeConfig, 80],
    [curveToken, "curve", CI.mint, 50],
    [ammToken, "pool", PI.mint, 50],
    [curveToken, "curve", CI.mint, 44],
    [ammToken, "pool", PI.mint, 44],
    [curveToken, "curve", CI.curve, 60],
    [ammToken, "pool", PI.pool, 220],
  ] as const) {
    const s = scenario(t, "buy");
    const [a, b] = pair(s, (p, w, _n, ans) => { if (p === 1 && w === v) edit(ans.value[index]!, (d) => { d[at] = d[at]! ^ 1; }); });
    assert.equal(await readSolanaReference([a, b], req(t, s)), null, `${t.venue}: account ${index} byte ${at}`);
    assert.equal(b.by[v], 2);
  }
});

// Card solana-mint-supply-moves: each provider reads the mint at its own slot, and a burn between the two moves its
// supply (C5xph…pump, 6 Nov 04:20Z: every leg refused "no reference pool" behind S10's same refusal). The supply sets
// the fee tier, so it is held to the reserves' band: inside it the reference stands, outside it the read is refused.
const supplyTimes = (t: Token, v: Venue, f: (x: bigint) => bigint) => (p: 0 | 1, w: Venue, _n: number, ans: Answer): void => {
  if (p === 1 && w === v) edit(ans.value[t === curveToken ? CI.mint : PI.mint]!, (d) => putU64(d, 36, f(u64(d, 36))));
};
test("the mint's supply moved by a burn between the two providers' reads, inside the band: the reference stands", async () => {
  for (const [t, v] of [[curveToken, "curve"], [ammToken, "pool"]] as const) {
    for (const f of [(x: bigint) => x - 559_661n, (x: bigint) => (x * 9_810n) / 10_000n]) {
      const s = scenario(t, "buy");
      const ref = await readSolanaReference(pair(s, supplyTimes(t, v, f)), req(t, s));
      assert.ok(ref, `${t.venue}: ${show(ref)}`);
      assert.equal(ref.pools[0]!.venue, t.venue);
    }
  }
});
test("the mint's supply outside the band on one provider: refused after its one re-read", async () => {
  for (const [t, v] of [[curveToken, "curve"], [ammToken, "pool"]] as const) {
    const s = scenario(t, "buy");
    const [a, b] = pair(s, supplyTimes(t, v, (x) => (x * 9_790n) / 10_000n));
    assert.equal(await readSolanaReference([a, b], req(t, s)), null, t.venue);
    assert.equal(b.by[v], 2);
  }
});

test("the mint missing on provider B is refused after its one re-read, never priced on provider A's read alone", async () => {
  for (const [t, v] of [[curveToken, "curve"], [ammToken, "pool"]] as const) {
    const s = scenario(t, "buy");
    const [a, b] = pair(s, (p, w, _n, ans) => { if (p === 1 && w === v) ans.value[t === curveToken ? CI.mint : PI.mint] = null; });
    assert.equal(await readSolanaReference([a, b], req(t, s)), null, t.venue);
    assert.equal(b.by[v], 2, t.venue);
  }
});
// The fee tier is chosen by the market cap each read's own supply gives: a fee config whose second tier (no fees) starts
// one lamport above the market cap at provider A's supply, the first tier (100 bps LP, 50 bps protocol) below it. B
// reads the supply 1.5% higher (a mint between the reads, inside the band), so only B's read reaches the free tier, and
// E is what B's read prices on B's supply: the same E as when both providers read B's supply, more than when both
// read A's. A read priced on the other provider's supply would take A's tier and E would fall to that.
const raised = (x: bigint): bigint => (x * 10_150n) / 10_000n;
function tiered(t: Token, s: Scenario): { v: Venue; fees: number; mint: number; tier: (ans: Answer) => void } {
  const v: Venue = t === curveToken ? "curve" : "pool";
  const fees = t === curveToken ? CI.pumpFeeConfig : PI.ammFeeConfig;
  const mint = t === curveToken ? CI.mint : PI.mint;
  const r = s.reads[v][0]![0].value;
  const supply = u64(bytes(r[mint]!), 36);
  // the market cap at A's supply: a curve's vQ x supply / vT (a mayhem curve, whose tier reads the mint's supply), a
  // pool's (quote vault + virtual_quote_reserves) x supply / base vault
  const cap = t === curveToken
    ? (u64(bytes(r[CI.curve]!), 16) * supply) / u64(bytes(r[CI.curve]!), 8)
    : ((tokenAmount(r[PI.quote]!) + u64(bytes(r[PI.pool]!), 245)) * supply) / tokenAmount(r[PI.baseT22]!);
  assert.ok((raised(supply) * cap) / supply > cap + 1n, "B's supply crosses the tier");
  const tier = (ans: Answer): void => {
    edit(ans.value[fees]!, (d) => {
      new DataView(d.buffer, d.byteOffset, d.byteLength).setUint32(65, 2, true);
      d.fill(0, 69, 69 + 80);
      putU64(d, 69 + 16, 100n);
      putU64(d, 69 + 24, 50n);
      putU64(d, 69 + 40, cap + 1n);
    });
    if (t === curveToken) edit(ans.value[CI.curve]!, (d) => { d[81] = 1; });
  };
  return { v, fees, mint, tier };
}
test("each provider's read is priced on its own supply: a fee tier only B's supply reaches sets E", async () => {
  for (const t of [curveToken, ammToken]) {
    const s = scenario(t, "buy");
    const { v, mint, tier } = tiered(t, s);
    const run = (who: (0 | 1)[]) => readSolanaReference(pair(s, (p, w, _n, ans) => {
      if (w !== v) return;
      tier(ans);
      if (who.includes(p)) edit(ans.value[mint]!, (d) => putU64(d, 36, raised(u64(d, 36))));
    }), req(t, s));
    const [own, both, none] = await Promise.all([run([1]), run([0, 1]), run([])]);
    assert.ok(own && both && none, `${t.venue}: ${show(own)} ${show(both)} ${show(none)}`);
    assert.equal(own.expectedOut, both.expectedOut, `${t.venue}: B's read priced on B's supply`);
    assert.ok(own.expectedOut > none.expectedOut, `${t.venue}: the free tier raises E (${own.expectedOut} > ${none.expectedOut})`);
  }
});
test("a wrong owner, discriminator, vault or canonical pool is refused, even when both providers say it", async () => {
  const addr = solanaPoolAddresses(ammToken.mint);
  const other = base58.decode(SYSTEM.replace(/1$/, "2"));
  const cases: [Token, Venue, number, (a: NonNullable<RawAcc>) => void][] = [
    [curveToken, "curve", CI.curve, (acc) => { acc.owner = SYSTEM; }],
    [curveToken, "curve", CI.curve, (acc) => edit(acc, (d) => { d[0] = d[0]! ^ 0xff; })],
    [curveToken, "curve", CI.baseT22, (acc) => { acc.owner = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; }], // the curve's tokens under the wrong program
    [curveToken, "curve", CI.baseT22, (acc) => edit(acc, (d) => d.set(other, 0))], // another mint
    [curveToken, "curve", CI.baseT22, (acc) => edit(acc, (d) => d.set(other, 32))], // another owner
    [ammToken, "pool", PI.pool, (acc) => { acc.owner = PUMP; }],
    [ammToken, "pool", PI.pool, (acc) => edit(acc, (d) => { d[3] = d[3]! ^ 0xff; })],
    [ammToken, "pool", PI.pool, (acc) => edit(acc, (d) => { d[9] = 1; })], // index 1: not the canonical pool
    [ammToken, "pool", PI.pool, (acc) => edit(acc, (d) => d.set(other, 11))], // another creator
    [ammToken, "pool", PI.pool, (acc) => edit(acc, (d) => d.set(other, 43))], // another base mint
    [ammToken, "pool", PI.pool, (acc) => edit(acc, (d) => d.set(other, 75))], // another quote mint
    [ammToken, "pool", PI.pool, (acc) => edit(acc, (d) => d.set(base58.decode(addr.baseVaultToken), 139))], // base vault not its T22 account
    [ammToken, "pool", PI.pool, (acc) => edit(acc, (d) => d.set(other, 171))], // quote vault not its account
    [ammToken, "pool", PI.quote, (acc) => { acc.owner = T22; }], // the WSOL vault under the wrong program
    [ammToken, "pool", PI.quote, (acc) => edit(acc, (d) => d.set(other, 0))], // the WSOL vault of another mint
    [ammToken, "pool", PI.baseT22, (acc) => edit(acc, (d) => d.set(other, 32))], // the base vault of another owner
  ];
  for (const [i, [t, v, index, change]] of cases.entries()) {
    const s = scenario(t, "sell");
    assert.equal(await readSolanaReference(pair(s, (_p, w, _n, ans) => { if (w === v) change(ans.value[index]!); }), req(t, s)), null, `case ${i}: ${t.venue} account ${index}`);
  }
});

test("a malformed answer is no answer: no reference rests on one provider's word", async () => {
  const s = scenario(curveToken, "buy");
  const good = { curve: s.reads.curve.map((r) => r[0]), pool: s.reads.pool.map((r) => r[0]) };
  const v = s.reads.curve[0]![1].value;
  const bad: unknown[] = [
    null,
    { context: { slot: 1 }, value: [] },
    { context: { slot: -1 }, value: v },
    { context: { slot: 1 }, value: v.map((x) => x && { ...x, data: [x.data[0], "base58"] }) },
    { context: { slot: 1 }, value: v.map((x) => x && { ...x, data: ["A".repeat(30_000), "base64"] }) },
  ];
  for (const answer of bad) {
    const a = provider(fx.rpcs[0], good, s.lists);
    const b = provider(fx.rpcs[1], { curve: [answer], pool: s.reads.pool.map((r) => r[1]) }, s.lists);
    assert.equal(await readSolanaReference([a, b], req(curveToken, s)), null, JSON.stringify(answer)?.slice(0, 80));
  }
  const failing = Object.assign(async () => { throw new Error("HTTP 429"); }, { url: fx.rpcs[1] });
  assert.equal(await readSolanaReference([provider(fx.rpcs[0], good, s.lists), failing], req(curveToken, s)), null);
  const one = provider(fx.rpcs[0], good, s.lists);
  await assert.rejects(readSolanaReference([one, one], req(curveToken, s)), /same provider/);
  await assert.rejects(readSolanaReference([one, provider(fx.rpcs[0], good, s.lists)], req(curveToken, s)), /same provider/);
  // one provider bare and wrapped, with no URL to compare: the same provider
  const bare: SolanaRpc = async () => null;
  await assert.rejects(readSolanaReference([bare, solanaPacedRpc(bare)], req(curveToken, s)), /same provider/);
  await assert.rejects(readSolanaReference([solanaPacedRpc(bare), bare], req(curveToken, s)), /same provider/);
});

test("a liar who inflates one pool's depth on one provider cannot drop the honest pool", async () => {
  // The graduated token's own reads, with its curve account made live again: a curve whose depth is just above the
  // pool's on provider A and 1.99% higher still on provider B (inside the band), at a worse price than the pool.
  const s = scenario(ammToken, "buy");
  const live = scenario(curveToken, "buy").reads.curve[0]![0].value;
  const P = s.reads.pool[0]![0].value;
  const quote = tokenAmount(P[PI.quote]!);
  const pool = bytes(P[PI.pool]!);
  const depth = quote + BigInt.asIntN(128, u64(pool, 245) + (u64(pool, 253) << 64n));
  const vqA = (depth * 1_002n) / 1_000n;
  const vqB = (vqA * 10_199n) / 10_000n;
  const tokens = tokenAmount(P[PI.baseT22]!) || tokenAmount(P[PI.baseT]!);
  const addr = solanaPoolAddresses(ammToken.mint);
  const [a, b] = pair(s, (p, v, _n, ans) => {
    if (v !== "curve") return;
    const d = bytes(live[CI.curve]!);
    putU64(d, 8, tokens / 2n); // half the pool's tokens for the same SOL: a worse price
    putU64(d, 16, p === 0 ? vqA : vqB);
    putU64(d, 24, tokens / 4n);
    d[48] = 0;
    ans.value[CI.curve] = { owner: PUMP, lamports: 1, data: [base64.encode(d), "base64"] };
    const t = bytes(live[CI.baseT22]!);
    t.set(base58.decode(ammToken.mint), 0);
    t.set(base58.decode(addr.curve), 32);
    putU64(t, 64, tokens);
    ans.value[CI.baseT22] = { owner: T22, lamports: 1, data: [base64.encode(t), "base64"] };
  });
  const ref = await readSolanaReference([a, b], req(ammToken, s));
  assert.ok(ref, show(ref));
  assert.deepEqual(ref.pools.map((x) => x.address).sort(), [addr.curve, addr.pool].sort(), "the honest pool stays in the set");
  const poolE = ref.pools.find((x) => x.address === addr.pool)!.expectedOut;
  assert.equal(ref.expectedOut, poolE, "E is the pool's, the better of the set");
  // the cutoff a max over one provider would give drops the pool: the smaller read is what keeps it
  assert.ok(vqB * 9_800n > depth * 10_000n, "the liar's depth would lift a max-based cutoff over the pool");

  // the same rule on the set alone
  const set = solanaReferenceSet([
    { venue: "pumpswap", address: "P", reads: [{ depth: 1_000n, out: 50n, spotOut: 51n, outs: [20n] }, { depth: 1_000n, out: 49n, spotOut: 51n, outs: [19n] }] },
    { venue: "pump-curve", address: "C", reads: [{ depth: 1_002n, out: 40n, spotOut: 41n }, { depth: 1_022n, out: 41n, spotOut: 42n }] },
  ]);
  assert.deepEqual(set?.pools.map((x) => x.address), ["P", "C"]);
  assert.equal(set?.expectedOut, 50n);
  assert.deepEqual(set?.expectedOuts, [20n], "the legs from the read that set E");
  // a pool below the cutoff on both providers is not in the set
  const thin = solanaReferenceSet([
    { venue: "pumpswap", address: "P", reads: [{ depth: 1_000n, out: 50n, spotOut: 51n }, { depth: 1_000n, out: 50n, spotOut: 51n }] },
    { venue: "pump-curve", address: "C", reads: [{ depth: 979n, out: 90n, spotOut: 91n }, { depth: 979n, out: 90n, spotOut: 91n }] },
  ]);
  assert.deepEqual(thin?.pools.map((x) => x.address), ["P"]);
  // exactly at the cutoff is in the set
  const edge = solanaReferenceSet([
    { venue: "pumpswap", address: "P", reads: [{ depth: 1_000n, out: 50n, spotOut: 51n }, { depth: 1_000n, out: 50n, spotOut: 51n }] },
    { venue: "pump-curve", address: "C", reads: [{ depth: 980n, out: 90n, spotOut: 91n }, { depth: 970n, out: 90n, spotOut: 91n }] },
  ]);
  assert.equal(edge?.expectedOut, 90n);
  assert.equal(solanaReferenceSet([]), null);
  assert.equal(solanaReferenceSet([{ venue: "pumpswap", address: "P", reads: [{ depth: 1n, out: 0n, spotOut: 0n }, { depth: 1n, out: 0n, spotOut: 0n }] }]), null);
});

test("no candidate on the chain: no reference pool", async () => {
  const s = scenario(curveToken, "buy");
  // the curve token's reads with its curve gone on both: its pool does not exist either
  assert.equal(await readSolanaReference(pair(s, (_p, v, _n, ans) => { if (v === "curve") ans.value[CI.curve] = null; }), req(curveToken, s)), null);
  // a complete curve is no candidate
  const done = pair(s, (_p, v, _n, ans) => { if (v === "curve") edit(ans.value[CI.curve]!, (d) => { d[48] = 1; }); });
  assert.equal(await readSolanaReference(done, req(curveToken, s)), null);
  assert.equal(done[0].by.curve, 1, "a complete curve is not a disagreement");
  // a curve quoted in another token is no candidate
  const other = pair(s, (_p, v, _n, ans) => { if (v === "curve") edit(ans.value[CI.curve]!, (d) => d.set(base58.decode("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), 83)); });
  assert.equal(await readSolanaReference(other, req(curveToken, s)), null);
  assert.equal(other[0].by.curve, 1);
});

// ------------------------------------------------------------------------------------------------- unit vectors

const tier = (lp: bigint, p: bigint, c: bigint, at = 0n) => ({ marketCapLamportsThreshold: at, fees: { lpFeeBps: lp, protocolFeeBps: p, creatorFeeBps: c } });
const fc = (...tiers: ReturnType<typeof tier>[]): SolanaFeeConfig => ({ flatFees: { lpFeeBps: 0n, protocolFeeBps: 0n, creatorFeeBps: 0n }, feeTiers: tiers });
const G: SolanaPumpGlobal = { feeBasisPoints: 0n, poolMigrationFee: 15_000_001n, creatorFeeBasisPoints: 0n, creatorFeeConfigurable: false };
const BILLION = 1_000_000_000_000_000n;
// a SOL curve 10e12 tokens from its end (pump's initial 1,073e12 × 30 SOL product)
const vT0 = 289_900_000_000_000n;
const vQ0 = (30_000_000_000n * 1_073_000_000_000_000n) / vT0;
const endCurve: SolanaBondingCurve = {
  virtualTokenReserves: vT0, virtualQuoteReserves: vQ0, realTokenReserves: 10_000_000_000_000n, realQuoteReserves: vQ0 - 30_000_000_000n,
  tokenTotalSupply: BILLION, complete: false, creator: PUMP, isMayhemMode: false, isCashbackCoin: false, quoteMint: SYSTEM, creatorFeeBps: 0n,
};
const END_BALANCE = 216_900_000_000_000n;
const pumpFees = fc(tier(0n, 95n, 30n));

test("crossing: a buy past the curve's end buys the rest from the pool-to-be, as pump-sdk 4.3.1 prices it", () => {
  // expected values from pump-sdk 4.3.1 getBuyV3TokenAmountFromQuoteAmount on the same inputs
  assert.equal(solanaCurveOut("buy", 5_000_000_000n, endCurve, G, pumpFees, BILLION, END_BALANCE).out, 12_337_575_211_021n);
  assert.equal(solanaCurveOut("buy", 3_000_000_000n, endCurve, G, pumpFees, BILLION, END_BALANCE).out, 7_534_680_077_004n, "below the end: the plain curve");
  // the pool-to-be depends on the balance and on the migration fee on a SOL curve
  assert.notEqual(solanaCurveOut("buy", 5_000_000_000n, endCurve, G, pumpFees, BILLION, END_BALANCE + 1_000_000_000_000n).out, 12_337_575_211_021n);
  assert.notEqual(solanaCurveOut("buy", 5_000_000_000n, endCurve, { ...G, poolMigrationFee: 0n }, pumpFees, BILLION, END_BALANCE).out, 12_337_575_211_021n);
  // not on a curve quoted in the Token-2022 native mint: no migration fee comes off its pool-to-be
  const t22 = { ...endCurve, quoteMint: "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP" };
  assert.equal(solanaCurveOut("buy", 5_000_000_000n, t22, G, pumpFees, BILLION, END_BALANCE).out, solanaCurveOut("buy", 5_000_000_000n, endCurve, { ...G, poolMigrationFee: 0n }, pumpFees, BILLION, END_BALANCE).out);
  // an empty pool-to-be is refused, not priced
  assert.throws(() => solanaCurveOut("buy", 5_000_000_000n, endCurve, G, pumpFees, BILLION, endCurve.realTokenReserves), /empty pool-to-be/);
});

test("crossing: a curve that stores WSOL as its quote is a SOL curve too (pump-sdk isLegacyQuoteMint): the migration fee comes off", () => {
  const wsol = { ...endCurve, quoteMint: "So11111111111111111111111111111111111111112" };
  assert.equal(solanaCurveOut("buy", 5_000_000_000n, wsol, G, pumpFees, BILLION, END_BALANCE).out, 12_337_575_211_021n);
});

test("crossing: a budget that covers the curve's end with under 2 lamports left after fees buys exactly the end", () => {
  // what R costs: curveNet = R × vQ / (vT − R) + 1, and its ceil fees (95 + 30 bps)
  const R = endCurve.realTokenReserves;
  const curveNet = (R * vQ0) / (vT0 - R) + 1n;
  const ceil = (x: bigint, bps: bigint) => (x * bps + 9_999n) / 10_000n;
  const curveCost = curveNet + ceil(curveNet, 95n) + ceil(curveNet, 30n);
  for (const left of [1n, 2n]) assert.equal(solanaCurveOut("buy", curveCost + left, endCurve, G, pumpFees, BILLION, END_BALANCE).out, R, `${left} left`);
  assert.ok(solanaCurveOut("buy", curveCost + 1_000_000n, endCurve, G, pumpFees, BILLION, END_BALANCE).out > R, "more left buys past the end");
});

test("a mayhem curve stops at its end, as the program does", () => {
  const mayhem = { ...endCurve, isMayhemMode: true };
  assert.equal(solanaCurveOut("buy", 5_000_000_000n, mayhem, G, pumpFees, BILLION, END_BALANCE).out, endCurve.realTokenReserves);
  assert.equal(solanaCurveOut("buy", 3_000_000_000n, mayhem, G, pumpFees, BILLION, END_BALANCE).out, 7_534_680_077_004n);
});

test("curve rates: no creator fee without a creator; the curve's own rate only when Global allows it; the mayhem supply", () => {
  const c = { ...endCurve, virtualTokenReserves: 1_000n, virtualQuoteReserves: 1_000n, creatorFeeBps: 50n };
  assert.deepEqual(solanaCurveRates(c, G, pumpFees, BILLION), { protocolFeeBps: 95n, creatorFeeBps: 30n });
  assert.deepEqual(solanaCurveRates({ ...c, creator: SYSTEM }, G, pumpFees, BILLION), { protocolFeeBps: 95n, creatorFeeBps: 0n });
  assert.deepEqual(solanaCurveRates(c, { ...G, creatorFeeConfigurable: true }, pumpFees, BILLION), { protocolFeeBps: 95n, creatorFeeBps: 50n });
  assert.deepEqual(solanaCurveRates({ ...c, creatorFeeBps: 0n }, { ...G, creatorFeeConfigurable: true }, pumpFees, BILLION), { protocolFeeBps: 95n, creatorFeeBps: 30n });
  // market cap vQ × supply / vT = supply: 1e15 on a plain curve, the mint's 2e15 on a mayhem curve
  const two = fc(tier(0n, 95n, 30n), tier(0n, 10n, 5n, 1_500_000_000_000_000n));
  assert.equal(solanaCurveRates(c, G, two, 2n * BILLION).protocolFeeBps, 95n);
  assert.equal(solanaCurveRates({ ...c, isMayhemMode: true }, G, two, 2n * BILLION).protocolFeeBps, 10n);
});

test("fee tiers: the first below its threshold, else the last one the market cap reaches", () => {
  const cfg = fc(tier(1n, 1n, 1n, 50n), tier(2n, 2n, 2n, 100n), tier(3n, 3n, 3n, 200n));
  assert.equal(solanaFeeTier(cfg, 10n).lpFeeBps, 1n);
  assert.equal(solanaFeeTier(cfg, 99n).lpFeeBps, 1n);
  assert.equal(solanaFeeTier(cfg, 150n).lpFeeBps, 2n);
  assert.equal(solanaFeeTier(cfg, 200n).lpFeeBps, 3n);
  assert.equal(solanaFeeTier(cfg, 10n ** 30n).lpFeeBps, 3n);
});

test("fees round up: a curve sell pays ceil fees", () => {
  const c = { ...endCurve, virtualTokenReserves: 1_000n, virtualQuoteReserves: 1_000n, realTokenReserves: 1_000n };
  // gross 500: ceil(4.75) + ceil(1.5) = 7, where floor would take 5
  assert.equal(solanaCurveOut("sell", 1_000n, c, G, pumpFees, BILLION, 0n).out, 493n);
  assert.equal(solanaCurveOut("sell", 1_000n, { ...c, creator: SYSTEM }, G, pumpFees, BILLION, 0n).out, 495n);
});

const swapPool: SolanaPumpSwapPool = {
  index: 0, creator: SYSTEM, baseMint: SYSTEM, quoteMint: SYSTEM, baseVault: SYSTEM, quoteVault: SYSTEM, coinCreator: PUMP,
  isMayhemMode: false, virtualQuoteReserves: 0n, creatorFeeBps: 0n, protocolFees: 0n, creatorFees: 0n,
};
const swapCfg: SolanaPumpSwapConfig = { lpFeeBps: 0n, protocolFeeBps: 0n, coinCreatorFeeBps: 0n, disableFlags: 0, creatorFeeConfigurable: false };
const swapFees = fc(tier(20n, 5n, 5n));
const M = 1_000_000n;

test("PumpSwap: virtual_quote_reserves in Q, the creator rates, the mayhem supply", () => {
  assert.equal(solanaPumpSwapOut("buy", 10_000n, swapPool, swapCfg, swapFees, BILLION, M, M).out, 9_870n);
  assert.equal(solanaPumpSwapOut("buy", 10_000n, { ...swapPool, virtualQuoteReserves: M }, swapCfg, swapFees, BILLION, M, M).out, 4_959n);
  assert.equal(solanaPumpSwapOut("buy", 10_000n, { ...swapPool, coinCreator: SYSTEM }, swapCfg, swapFees, BILLION, M, M).out, 9_875n);
  assert.equal(solanaPumpSwapOut("buy", 10_000n, { ...swapPool, creatorFeeBps: 50n }, { ...swapCfg, creatorFeeConfigurable: true }, swapFees, BILLION, M, M).out, 9_826n);
  assert.equal(solanaPumpSwapOut("buy", 10_000n, { ...swapPool, creatorFeeBps: 50n }, swapCfg, swapFees, BILLION, M, M).out, 9_870n);
  // market cap Q × supply / B = supply: the mint's 2e15 on a plain pool, 1e15 on a mayhem pool
  const two = fc(tier(20n, 5n, 5n), tier(10n, 1n, 1n, 1_500_000_000_000_000n));
  assert.equal(solanaPumpSwapRates(swapPool, swapCfg, two, 2n * BILLION, M, M).lpFeeBps, 10n);
  assert.equal(solanaPumpSwapRates({ ...swapPool, isMayhemMode: true }, swapCfg, two, 2n * BILLION, M, M).lpFeeBps, 20n);
});

test("PumpSwap sell: the pool must hold the quote out of its real reserve; a disabled side pays nothing", () => {
  assert.equal(solanaPumpSwapOut("sell", 10_000n, swapPool, swapCfg, swapFees, BILLION, M, M).out, 9_870n);
  // q 9,900 less the LP fee 20 is 9,880: a vault of 1e6 with 990,120 in fee buckets holds exactly that, 1 more does not
  assert.equal(solanaPumpSwapOut("sell", 10_000n, { ...swapPool, protocolFees: 990_120n }, swapCfg, swapFees, BILLION, M, M).out, 9_870n);
  assert.equal(solanaPumpSwapOut("sell", 10_000n, { ...swapPool, protocolFees: 990_000n, creatorFees: 121n }, swapCfg, swapFees, BILLION, M, M).out, 0n);
  assert.deepEqual(solanaPumpSwapOut("buy", 10_000n, swapPool, { ...swapCfg, disableFlags: 8 }, swapFees, BILLION, M, M), { out: 0n, spotOut: null });
  assert.equal(solanaPumpSwapOut("sell", 10_000n, swapPool, { ...swapCfg, disableFlags: 8 }, swapFees, BILLION, M, M).out, 9_870n);
  assert.deepEqual(solanaPumpSwapOut("sell", 10_000n, swapPool, { ...swapCfg, disableFlags: 16 }, swapFees, BILLION, M, M), { out: 0n, spotOut: null });
  assert.equal(solanaPumpSwapOut("buy", 10_000n, swapPool, { ...swapCfg, disableFlags: 16 }, swapFees, BILLION, M, M).out, 9_870n);
});

// Card solana-release-reads-paced: a provider a caller holds under a limit (the trade's pacedDeps, the signing page's
// pair) has one queue, and the reference's reads join it: with the pace full, no read goes out past it, and each read's
// READ_TIMEOUT_MS (5 s) counts from when it goes out, never from its wait, so a wait past 5 s is still the reference,
// never a read refused as down. Own URLs, so the limit named here binds no other test's provider.
test("card solana-release-reads-paced: with a provider's pace full the reference sends no read past it, and a wait past 5 s is still its reference", async () => {
  const s = scenario(curveToken, "buy");
  const unpaced = await readSolanaReference(pair(s), req(curveToken, s, true));
  assert.ok(unpaced, "the recorded reads give a reference");
  const recorded = pair(s);
  const a = Object.assign(async (m: string, p: readonly unknown[]) => recorded[0](m, p), { url: "https://pace-a.example/" });
  const b = Object.assign(async (m: string, p: readonly unknown[]) => recorded[1](m, p), { url: "https://pace-b.example/" });
  const sentA: number[] = [];
  const watchedA = Object.assign(async (m: string, p: readonly unknown[]) => { sentA.push(performance.now()); return a(m, p); }, { url: a.url });
  // the pace full: a caller holding provider A under 2 calls in any 5.6 s has made its 2
  const filler = solanaPacedRpc(Object.assign(async () => null, { url: a.url }), { windowMs: 5_600, total: 2, perMethod: 2 });
  await Promise.all([filler("getSlot", []), filler("getSlot", [])]);
  const full = performance.now();
  const ref = readSolanaReference([watchedA, b], req(curveToken, s, true));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sentA.length, 0, "no read went to provider A past its full pace");
  assert.equal(show(await ref), show(unpaced), "the reference, read after its wait");
  assert.ok(sentA.length >= 2 && sentA.every((t) => t - full >= 5_500), `each read on A went out once the pace let it: ${sentA.map((t) => Math.round(t - full)).join(", ")} ms`);
});
