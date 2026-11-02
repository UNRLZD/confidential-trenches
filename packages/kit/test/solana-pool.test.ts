/// <reference types="node" />
// The device's on-chain reference E (markets paper S12, §2.0 LD1): replays real mainnet answers recorded by
// test/fixtures/solana-pool-capture.mjs. One live pump.fun bonding-curve token and one graduated token in its PumpSwap
// canonical pool, each read with getMultipleAccounts at `processed` on two public RPCs, and a real Jupiter route on that
// venue alone simulated on both for the same exact input. Good: E within 0.5% of the simulated out on every venue and
// side; a reserve inside the band agrees and the larger-output read sets E. Bad: a reserve outside the band (after one
// re-read), a static byte that differs, a wrong owner or discriminator, a malformed answer, and a liar who inflates a
// pool's depth on one provider are each refused or unable to move the reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base64 } from "@scure/base";
import {
  SOLANA_POOL_READ_TOL_BPS,
  readSolanaReference,
  solanaCurveOut,
  solanaDecodeBondingCurve,
  solanaDecodeFeeConfig,
  solanaDecodeMint,
  solanaDecodePumpGlobal,
  solanaPoolAddresses,
  solanaReferenceSet,
  solanaReservesAgree,
  type SolanaReference,
} from "../src/trade/solana/pool.ts";
import type { SolanaRpc } from "../src/trade/solana/send.ts";

type RawAcc = { owner: string; lamports: number; data: [string, string]; executable?: boolean } | null;
type Answer = { context: { slot: number }; value: RawAcc[] };
type Scenario = {
  venue: "pump-curve" | "pumpswap";
  side: "buy" | "sell";
  amount: string;
  outAccount: string;
  addresses: string[];
  reads: [Answer, Answer][];
  pre: { value: RawAcc[] }[];
  sims: { context: { slot: number }; value: { err: unknown; accounts: RawAcc[] } }[];
};
type Fixture = { rpcs: [string, string]; tokens: { mint: string; venue: string; scenarios: Scenario[] }[] };
const fx = JSON.parse(readFileSync(new URL("./fixtures/solana-pool.json", import.meta.url), "utf8")) as Fixture;
const curveToken = fx.tokens.find((t) => t.venue === "pump-curve")!;
const ammToken = fx.tokens.find((t) => t.venue === "pumpswap")!;
const scenario = (t: Fixture["tokens"][number], side: "buy" | "sell"): Scenario => t.scenarios.find((s) => s.side === side)!;
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const I = { mint: 0, curve: 1, pumpGlobal: 2, pool: 4, ammGlobalConfig: 5 } as const;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const bytes = (a: RawAcc): Uint8Array => base64.decode(a!.data[0]);
const setBytes = (a: RawAcc, d: Uint8Array): void => { a!.data[0] = base64.encode(d); };
const u64 = (d: Uint8Array, o: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
const putU64 = (d: Uint8Array, o: number, v: bigint): void => new DataView(d.buffer, d.byteOffset, d.byteLength).setBigUint64(o, v, true);
const tokenAmount = (a: RawAcc): bigint => (a ? u64(bytes(a), 64) : 0n);

/** A provider that answers getMultipleAccounts from a list of recorded answers, one per call (the last repeats). */
function provider(url: string, answers: unknown[], addresses: string[]): SolanaRpc & { calls: number } {
  const fn = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    assert.equal(method, "getMultipleAccounts");
    assert.deepEqual(params, [addresses, { encoding: "base64", commitment: "processed" }]);
    return clone(answers[Math.min(f.calls++, answers.length - 1)]);
  };
  const f = Object.assign(fn, { url, calls: 0 });
  return f;
}
/** Both providers over a scenario's recorded reads, each changed by `edit(provider, read index, answer)`. */
function pair(s: Scenario, edit: (p: 0 | 1, n: number, a: Answer) => void = () => {}): [SolanaRpc & { calls: number }, SolanaRpc & { calls: number }] {
  const per = ([0, 1] as const).map((p) => s.reads.map((r, n) => { const a = clone(r[p]); edit(p, n, a); return a; }));
  return [provider(fx.rpcs[0], per[0]!, s.addresses), provider(fx.rpcs[1], per[1]!, s.addresses)];
}
const req = (t: Fixture["tokens"][number], s: Scenario) => ({ side: s.side, token: t.mint, amount: BigInt(s.amount) });
const show = (r: SolanaReference | null): string => JSON.stringify(r, (_, v) => (typeof v === "bigint" ? String(v) : v));

test("the fixture's addresses are the kit's own derivation (the capture derives them separately)", () => {
  for (const t of fx.tokens) for (const s of t.scenarios) assert.deepEqual(s.addresses, solanaPoolAddresses(t.mint).list);
});

for (const t of [curveToken, ammToken]) {
  for (const side of ["buy", "sell"] as const) {
    test(`${t.venue} ${side}: E within 0.5% of the simulated out of a real Jupiter route on that venue, for the same exact input`, async () => {
      const s = scenario(t, side);
      const ref = await readSolanaReference(pair(s), req(t, s));
      assert.ok(ref, "a reference");
      assert.equal(ref.pools.length, 1);
      assert.equal(ref.pools[0]!.venue, t.venue);
      assert.equal(ref.pools[0]!.address, t.venue === "pump-curve" ? solanaPoolAddresses(t.mint).curve : solanaPoolAddresses(t.mint).pool);
      for (const [p, sim] of s.sims.entries()) {
        assert.equal(sim.value.err, null);
        const out = tokenAmount(sim.value.accounts[0]!) - tokenAmount(s.pre[p]!.value[0]!);
        assert.ok(out > 0n, `simulated out ${out}`);
        const diff = ref.expectedOut > out ? ref.expectedOut - out : out - ref.expectedOut;
        assert.ok(diff * 10_000n <= 50n * out, `${t.venue} ${side} on ${fx.rpcs[p]}: E ${ref.expectedOut} vs simulated ${out}`);
      }
      assert.ok(ref.spotOut !== null && ref.spotOut >= ref.expectedOut, "spot out is at least E");
    });
  }
}

test("a reserve inside the band agrees, and E comes from the read with the larger output", async () => {
  const s = scenario(curveToken, "buy");
  // provider B reads 1.5% more virtual tokens: inside the 200 bps band, and more tokens out for the same lamports
  let raised = 0n;
  const [a, b] = pair(s, (p, _n, ans) => {
    if (p !== 1) return;
    const d = bytes(ans.value[I.curve]!);
    raised = (u64(d, 8) * 10_150n) / 10_000n;
    putU64(d, 8, raised);
    setBytes(ans.value[I.curve]!, d);
  });
  const ref = await readSolanaReference([a, b], req(curveToken, s));
  assert.ok(ref, show(ref));
  const accB = s.reads[0]![1].value;
  const curveB = solanaDecodeBondingCurve({ owner: PUMP, data: bytes(accB[I.curve]!) });
  const want = solanaCurveOut("buy", BigInt(s.amount), { ...curveB, virtualTokenReserves: raised },
    solanaDecodePumpGlobal({ owner: PUMP, data: bytes(accB[I.pumpGlobal]!) }),
    solanaDecodeFeeConfig({ owner: accB[3]!.owner, data: bytes(accB[3]!) }),
    solanaDecodeMint({ owner: accB[I.mint]!.owner, data: bytes(accB[I.mint]!) }).supply);
  assert.equal(ref.expectedOut, want.out);
  const honest = await readSolanaReference(pair(s), req(curveToken, s));
  assert.ok(honest && ref.expectedOut > honest.expectedOut, "the larger-output read sets E");
  assert.equal(a.calls, 1, "no re-read inside the band");
});

test("a reserve outside the band is read once more on both, then refused", async () => {
  for (const [t, side, index, offset] of [[curveToken, "buy", I.curve, 16], [ammToken, "sell", 9, 64]] as const) {
    const s = scenario(t, side);
    // provider B reads 3% more on the quote side, on every read
    const [a, b] = pair(s, (p, _n, ans) => {
      if (p !== 1) return;
      const d = bytes(ans.value[index]!);
      putU64(d, offset, (u64(d, offset) * 10_300n) / 10_000n);
      setBytes(ans.value[index]!, d);
    });
    assert.equal(await readSolanaReference([a, b], req(t, s)), null, `${t.venue}: refused`);
    assert.deepEqual([a.calls, b.calls], [2, 2], "one re-read on both, no more");
    // the same lie on the first read only: the re-read agrees and the candidate stands
    const [a2, b2] = pair(s, (p, n, ans) => {
      if (p !== 1 || n !== 0) return;
      const d = bytes(ans.value[index]!);
      putU64(d, offset, (u64(d, offset) * 10_300n) / 10_000n);
      setBytes(ans.value[index]!, d);
    });
    assert.ok(await readSolanaReference([a2, b2], req(t, s)), `${t.venue}: agreed on the re-read`);
  }
  assert.equal(solanaReservesAgree(10_000n, 10_200n), true);
  assert.equal(solanaReservesAgree(10_000n, 10_201n), false);
  assert.equal(SOLANA_POOL_READ_TOL_BPS, 200);
});

test("a static byte that differs between the providers is refused (pump Global, PumpSwap GlobalConfig, the mint)", async () => {
  for (const [t, index, at] of [[curveToken, I.pumpGlobal, 105], [ammToken, I.ammGlobalConfig, 48], [curveToken, I.mint, 36], [ammToken, I.mint, 36]] as const) {
    const s = scenario(t, "buy");
    const [a, b] = pair(s, (p, _n, ans) => {
      if (p !== 1) return;
      const d = bytes(ans.value[index]!);
      d[at] = d[at]! ^ 1;
      setBytes(ans.value[index]!, d);
    });
    assert.equal(await readSolanaReference([a, b], req(t, s)), null, `${t.venue}: account ${index} byte ${at}`);
    assert.equal(b.calls, 2);
  }
});

test("a wrong owner or discriminator is refused, even when both providers say it", async () => {
  const cases: [Fixture["tokens"][number], number, (a: NonNullable<RawAcc>) => void][] = [
    [curveToken, I.curve, (acc) => { acc.owner = "11111111111111111111111111111111"; }],
    [curveToken, I.curve, (acc) => { const d = bytes(acc); d[0] = d[0]! ^ 0xff; setBytes(acc, d); }],
    [ammToken, I.pool, (acc) => { acc.owner = PUMP; }],
    [ammToken, I.pool, (acc) => { const d = bytes(acc); d[3] = d[3]! ^ 0xff; setBytes(acc, d); }],
    [ammToken, 9, (acc) => { acc.owner = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"; }], // the WSOL vault under the wrong program
  ];
  for (const [t, index, edit] of cases) {
    const s = scenario(t, "sell");
    assert.equal(await readSolanaReference(pair(s, (_p, _n, ans) => edit(ans.value[index]!)), req(t, s)), null, `${t.venue} account ${index}`);
  }
});

test("a malformed answer is no answer: no reference rests on one provider's word", async () => {
  const s = scenario(curveToken, "buy");
  const bad: unknown[] = [
    null,
    { context: { slot: 1 }, value: [] },
    { context: { slot: -1 }, value: s.reads[0]![1].value },
    { context: { slot: 1 }, value: s.reads[0]![1].value.map((v) => v && { ...v, data: [v.data[0], "base58"] }) },
    { context: { slot: 1 }, value: s.reads[0]![1].value.map((v) => v && { ...v, data: ["A".repeat(30_000), "base64"] }) },
  ];
  for (const answer of bad) {
    const a = provider(fx.rpcs[0], s.reads.map((r) => r[0]), s.addresses);
    const b = provider(fx.rpcs[1], [answer], s.addresses);
    assert.equal(await readSolanaReference([a, b], req(curveToken, s)), null, JSON.stringify(answer)?.slice(0, 80));
  }
  const failing = Object.assign(async () => { throw new Error("HTTP 429"); }, { url: fx.rpcs[1] });
  assert.equal(await readSolanaReference([provider(fx.rpcs[0], s.reads.map((r) => r[0]), s.addresses), failing], req(curveToken, s)), null);
  const one = provider(fx.rpcs[0], s.reads.map((r) => r[0]), s.addresses);
  await assert.rejects(readSolanaReference([one, one], req(curveToken, s)), /same provider/);
  await assert.rejects(readSolanaReference([one, provider(fx.rpcs[0], [], s.addresses)], req(curveToken, s)), /same provider/);
});

test("a liar who inflates one pool's depth on one provider cannot drop the honest pool", async () => {
  // The graduated token's own reads, with its curve account made live again: a curve whose depth is just above the
  // pool's on provider A and 1.99% higher still on provider B (inside the band), at a worse price than the pool.
  const s = scenario(ammToken, "buy");
  const live = bytes(scenario(curveToken, "buy").reads[0]![0].value[I.curve]!);
  const quote = tokenAmount(s.reads[0]![0].value[9]!);
  const pool = bytes(s.reads[0]![0].value[I.pool]!);
  const depth = quote + BigInt.asIntN(128, u64(pool, 245) + (u64(pool, 253) << 64n));
  const vqA = (depth * 1_002n) / 1_000n;
  const vqB = (vqA * 10_199n) / 10_000n;
  const tokens = tokenAmount(s.reads[0]![0].value[8]!) || tokenAmount(s.reads[0]![0].value[7]!);
  const [a, b] = pair(s, (p, _n, ans) => {
    const d = live.slice();
    putU64(d, 8, tokens / 2n); // half the pool's tokens for the same SOL: a worse price
    putU64(d, 16, p === 0 ? vqA : vqB);
    putU64(d, 24, tokens / 2n);
    d[48] = 0;
    ans.value[I.curve] = { owner: PUMP, lamports: 1, data: [base64.encode(d), "base64"] };
  });
  const ref = await readSolanaReference([a, b], req(ammToken, s));
  assert.ok(ref, show(ref));
  const addr = solanaPoolAddresses(ammToken.mint);
  assert.deepEqual(ref.pools.map((x) => x.address).sort(), [addr.curve, addr.pool].sort(), "the honest pool stays in the set");
  const poolE = ref.pools.find((x) => x.address === addr.pool)!.expectedOut;
  assert.equal(ref.expectedOut, poolE, "E is the pool's, the better of the set");
  // the cutoff a max over one provider would give drops the pool: the smaller read is what keeps it
  assert.ok(vqB * 9_800n > depth * 10_000n, "the liar's depth would lift a max-based cutoff over the pool");

  // the same rule on the set alone
  const set = solanaReferenceSet([
    { venue: "pumpswap", address: "P", reads: [{ depth: 1_000n, out: 50n, spotOut: 51n }, { depth: 1_000n, out: 50n, spotOut: 51n }] },
    { venue: "pump-curve", address: "C", reads: [{ depth: 1_002n, out: 40n, spotOut: 41n }, { depth: 1_022n, out: 41n, spotOut: 42n }] },
  ]);
  assert.deepEqual(set?.pools.map((x) => x.address), ["P", "C"]);
  assert.equal(set?.expectedOut, 50n);
  // a pool below the cutoff on both providers is not in the set
  const thin = solanaReferenceSet([
    { venue: "pumpswap", address: "P", reads: [{ depth: 1_000n, out: 50n, spotOut: 51n }, { depth: 1_000n, out: 50n, spotOut: 51n }] },
    { venue: "pump-curve", address: "C", reads: [{ depth: 979n, out: 90n, spotOut: 91n }, { depth: 979n, out: 90n, spotOut: 91n }] },
  ]);
  assert.deepEqual(thin?.pools.map((x) => x.address), ["P"]);
  assert.equal(solanaReferenceSet([]), null);
});

test("no candidate on the chain: no reference pool", async () => {
  const s = scenario(curveToken, "buy");
  // the curve token's reads with its curve gone on both: its pool does not exist either
  assert.equal(await readSolanaReference(pair(s, (_p, _n, ans) => { ans.value[I.curve] = null; }), req(curveToken, s)), null);
  // a complete curve is no candidate
  const done = pair(s, (_p, _n, ans) => { const d = bytes(ans.value[I.curve]!); d[48] = 1; setBytes(ans.value[I.curve]!, d); });
  assert.equal(await readSolanaReference(done, req(curveToken, s)), null);
  assert.equal(done[0].calls, 1, "a complete curve is not a disagreement");
});
