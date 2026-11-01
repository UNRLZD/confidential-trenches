/// <reference types="node" />
// T2.2's device checks on two real Solana swaps: the G1 phone proof's buy and sell (research
// proofs/g1-phone-trade/results/live-2026-10-26T11-29-51-268Z.json results[0..1]), read back keyless on two public RPCs
// by test/fixtures/solana-capture.mjs into test/fixtures/solana-swaps.json. The untouched buy passes; the paper's sell
// shape (the real sell minus its two closes, T2.1 "Sell = 06c S-2") passes; every refusal rule has a case built from
// the real bytes with one field changed; and a seeded sweep changes every field the request binds and finds each refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58 } from "@scure/base";
import {
  checkSolanaQuote,
  solanaPumpVolumeAccumulator,
  type SolanaAccountRead,
  type SolanaQuoteCheckId,
  type SolanaQuoteReads,
  type SolanaQuoteRequest,
  type SolanaSimulation,
} from "../src/checks/solana/checks.ts";
import { solanaAta, solanaDecodeLookupTable, solanaDecodeTransaction, solanaResolveKeys, type SolanaMessage } from "../src/checks/solana/message.ts";

type Acc = { owner: string; lamports: number; data: string };
type Trade = { side: "buy" | "sell"; sig: string; amount: string; minOut: string; tx: string; meta: { preBalances: number[]; postBalances: number[]; fee: number } };
const F = JSON.parse(readFileSync(new URL("./fixtures/solana-swaps.json", import.meta.url), "utf8")) as {
  wallet: string;
  mint: string;
  trades: Trade[];
  tables: Record<string, [Acc, Acc]>;
  mintReads: [Acc, Acc];
  rentExempt: Record<string, { 137: number; 170: number }>;
};
const W = F.wallet;
const read = (a: Acc): SolanaAccountRead => ({ owner: a.owner, data: Uint8Array.from(Buffer.from(a.data, "base64")) });
const [BUY, SELL] = F.trades as [Trade, Trade];
const [RENT_A, RENT_B] = Object.values(F.rentExempt) as [{ 137: number; 170: number }, { 137: number; 170: number }];

// ---- a v0 encoder for the mutation cases (test only; the kit only decodes)
function compact(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if (n === 0) { out.push(b); return out; }
    out.push(b | 0x80);
  }
}
function encode(m: SolanaMessage, signatures = m.requiredSignatures): Uint8Array {
  const b: number[] = [...compact(signatures), ...new Array<number>(64 * signatures).fill(0)];
  b.push(0x80, m.requiredSignatures, m.readonlySigned, m.readonlyUnsigned, ...compact(m.staticKeys.length));
  for (const k of m.staticKeys) b.push(...base58.decode(k));
  b.push(...base58.decode(m.blockhash), ...compact(m.instructions.length));
  for (const ix of m.instructions) b.push(ix.programIndex, ...compact(ix.accounts.length), ...ix.accounts, ...compact(ix.data.length), ...ix.data);
  b.push(...compact(m.lookups.length));
  for (const l of m.lookups) b.push(...base58.decode(l.table), ...compact(l.writable.length), ...l.writable, ...compact(l.readonly.length), ...l.readonly);
  return Uint8Array.from(b);
}
const msgOf = (t: Trade): SolanaMessage => structuredClone(solanaDecodeTransaction(Buffer.from(t.tx, "base64")).message);
// A new read-only, unsigned static key at the end; returns its index. Loaded keys shift by one.
function addKey(m: SolanaMessage, key: string): number {
  const at = m.staticKeys.length;
  for (const ix of m.instructions) {
    if (ix.programIndex >= at) ix.programIndex++;
    for (let j = 0; j < ix.accounts.length; j++) if ((ix.accounts[j] as number) >= at) ix.accounts[j] = (ix.accounts[j] as number) + 1;
  }
  m.staticKeys.push(key);
  m.readonlyUnsigned++;
  return at;
}
const indexOf = (m: SolanaMessage, key: string): number => {
  const i = m.staticKeys.indexOf(key);
  if (i < 0) throw new Error(`${key} not static`);
  return i;
};
const progAt = (m: SolanaMessage, prog: string): number[] =>
  m.instructions.flatMap((ix, i) => (m.staticKeys[ix.programIndex] === prog ? [i] : []));
const setU64 = (d: Uint8Array, o: number, v: bigint): void => new DataView(d.buffer, d.byteOffset, d.byteLength).setBigUint64(o, v, true);
const setU16 = (d: Uint8Array, o: number, v: number): void => new DataView(d.buffer, d.byteOffset, d.byteLength).setUint16(o, v, true);
const setU32 = (d: Uint8Array, o: number, v: number): void => new DataView(d.buffer, d.byteOffset, d.byteLength).setUint32(o, v, true);
let seed = 0x5eed;
const rand = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed);
const randomKey = (): string => base58.encode(Uint8Array.from({ length: 32 }, () => rand() & 0xff));

const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SYSTEM = "11111111111111111111111111111111";
const CB = "ComputeBudget111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// ---- the good cases, from the real trades
// The buy's numbers: E from the G1 device's own pool read (live results[0].pool.expectedOut 51111993061), s = 950 bps
// (the slippage in the signed route), so minOut_k = floor(E × 9050 / 10000) = 46256353720; S12's tolerance is the kit's
// SOLANA_SIM_TOL_BPS = 200. The simulation is the landed tx's own balances (meta), the same on both providers.
const buyToken = 55_991_176_135n; // the landed buy's token in (meta.postTokenBalances of the wallet's account)
function buyCase(): { m: SolanaMessage; req: SolanaQuoteRequest; reads: SolanaQuoteReads } {
  const sim: SolanaSimulation = {
    err: null,
    walletLamports: { pre: BigInt(BUY.meta.preBalances[0] as number), post: BigInt(BUY.meta.postBalances[0] as number) },
    tokenAccount: { pre: 0n, post: buyToken },
    tokenAccountLamports: { pre: 0n, post: 1_513_840n }, // the landed buy: ECDKZF… 0 -> 1,513,840 (meta)
    pumpVolumeAccumulator: { pre: 0n, post: 1_346_200n },
    otherWallets: [{ pre: 9_874_873n, post: 9_874_873n }],
  };
  return {
    m: msgOf(BUY),
    req: { side: "buy", wallet: W, token: F.mint, amount: 9_874_873n, spendable: BigInt(BUY.meta.preBalances[0] as number), minOut: 46_256_353_720n },
    reads: {
      tables: Object.fromEntries(Object.entries(F.tables).map(([k, [a, b]]) => [k, [read(a), read(b)] as const])),
      mint: [read(F.mintReads[0]), read(F.mintReads[1])],
      rent: { tokenAccount: [BigInt(RENT_A[170]), BigInt(RENT_B[170])], pumpVolumeAccumulator: [BigInt(RENT_A[137]), BigInt(RENT_B[137])] },
      simulations: [sim, structuredClone(sim)],
      reference: { expectedOut: 51_111_993_061n, slippageBps: 950 },
    },
  };
}
// The sell in the paper's shape: the real sell minus its close of the token account and its top-level pump
// close_user_volume_accumulator (T2.1: "P4's tx minus two instructions"). Its simulation is the landed one less the two
// rents those closes returned (1,513,840 + 1,346,200). E = live results[1].pool.expectedOut 9656210, s = 950 bps.
function sellCase(): { m: SolanaMessage; req: SolanaQuoteRequest; reads: SolanaQuoteReads } {
  const m = msgOf(SELL);
  const t22 = progAt(m, T22);
  const pump = progAt(m, PUMP);
  assert.equal(t22.length, 1);
  assert.equal(pump.length, 1);
  m.instructions = m.instructions.filter((_, i) => i !== t22[0] && i !== pump[0]);
  const pre = BigInt(SELL.meta.preBalances[0] as number);
  const post = BigInt(SELL.meta.postBalances[0] as number) - 1_513_840n - 1_346_200n;
  const sim: SolanaSimulation = {
    err: null,
    walletLamports: { pre, post },
    tokenAccount: { pre: buyToken, post: 0n },
    tokenAccountLamports: { pre: 1_513_840n, post: 1_513_840n },
    pumpVolumeAccumulator: { pre: 1_346_200n, post: 1_346_200n },
    otherWallets: [],
  };
  const b = buyCase();
  return {
    m,
    req: { side: "sell", wallet: W, token: F.mint, amount: buyToken, spendable: buyToken, minOut: 8_738_870n },
    reads: { ...b.reads, simulations: [sim, structuredClone(sim)], reference: { expectedOut: 9_656_210n, slippageBps: 950 } },
  };
}
const run = (c: { m: SolanaMessage; req: SolanaQuoteRequest; reads: SolanaQuoteReads }, bytes?: Uint8Array) => checkSolanaQuote(bytes ?? encode(c.m), c.req, c.reads);
const failed = (v: ReturnType<typeof checkSolanaQuote>): string[] => v.results.filter((r) => !r.ok).map((r) => r.id);
function refusedBy(id: SolanaQuoteCheckId, v: ReturnType<typeof checkSolanaQuote>): void {
  assert.equal(v.ok, false, `expected a refusal by ${id}`);
  assert.ok(failed(v).includes(id), `expected ${id} among ${failed(v).join(",")}: ${v.results.filter((r) => !r.ok).map((r) => `${r.id} ${r.detail}`).join(" | ")}`);
}

test("encoder round-trips the real bytes", () => {
  for (const t of F.trades) {
    const raw = Uint8Array.from(Buffer.from(t.tx, "base64"));
    const again = encode(msgOf(t));
    assert.deepEqual(again.subarray(65), raw.subarray(65));
  }
});

test("the real buy passes every check", () => {
  const v = checkSolanaQuote(Uint8Array.from(Buffer.from(BUY.tx, "base64")), buyCase().req, buyCase().reads);
  assert.equal(v.ok, true, v.results.filter((r) => !r.ok).map((r) => `${r.id} ${r.detail}`).join(" | "));
  assert.equal(v.results.length, 13);
});

test("the paper's sell shape passes every check", () => {
  const v = run(sellCase());
  assert.equal(v.ok, true, v.results.filter((r) => !r.ok).map((r) => `${r.id} ${r.detail}`).join(" | "));
});

test("the real sell as built is refused: a top-level pump call (S3) and a close of an account it did not create (S13)", () => {
  const c = sellCase();
  const v = checkSolanaQuote(Uint8Array.from(Buffer.from(SELL.tx, "base64")), c.req, c.reads);
  refusedBy("S3", v);
  refusedBy("S13", v);
});

// ---- one field changed per refusal rule
const jupData = (m: SolanaMessage): Uint8Array => (m.instructions[progAt(m, JUP)[0] as number] as { data: Uint8Array }).data;
const jupIx = (m: SolanaMessage) => m.instructions[progAt(m, JUP)[0] as number] as SolanaMessage["instructions"][number];

const CASES: [string, SolanaQuoteCheckId, (c: ReturnType<typeof buyCase>) => Uint8Array | void][] = [
  ["S1 in amount + 1", "S1", (c) => setU64(jupData(c.m), 8, 9_874_874n)],
  ["S1 output mint changed", "S1", (c) => { jupIx(c.m).accounts[4] = addKey(c.m, randomKey()); }],
  ["S1 route authority not the wallet", "S1", (c) => { jupIx(c.m).accounts[0] = addKey(c.m, randomKey()); }],
  ["S1 source account a stranger's", "S1", (c) => { jupIx(c.m).accounts[1] = addKey(c.m, randomKey()); }],
  ["S1 amount above the spendable", "S1", (c) => { c.req.spendable = c.req.amount - 1n; }],
  ["S1 event authority changed", "S1", (c) => { jupIx(c.m).accounts[8] = addKey(c.m, randomKey()); }],
  ["S2 provider B differs at a used index", "S2", (c) => {
    const [k, pair] = Object.entries(c.reads.tables)[0] as [string, readonly [SolanaAccountRead, SolanaAccountRead]];
    const b = { owner: pair[1].owner, data: pair[1].data.slice() };
    const used = c.m.lookups[0]?.readonly[0] as number;
    (b.data[56 + used * 32] as number) ^= 1;
    (c.reads as { tables: unknown }).tables = { [k]: [pair[0], b] };
  }],
  ["S2 provider B has no table", "S2", (c) => {
    const [k, pair] = Object.entries(c.reads.tables)[0] as [string, readonly [SolanaAccountRead, SolanaAccountRead]];
    (c.reads as { tables: unknown }).tables = { [k]: [pair[0], null] };
  }],
  ["S2 table deactivated", "S2", (c) => {
    const [k, pair] = Object.entries(c.reads.tables)[0] as [string, readonly [SolanaAccountRead, SolanaAccountRead]];
    const off = (a: SolanaAccountRead) => { const d = a.data.slice(); setU64(d, 4, 5n); return { owner: a.owner, data: d }; };
    (c.reads as { tables: unknown }).tables = { [k]: [off(pair[0]), off(pair[1])] };
  }],
  ["S3 a foreign program added", "S3", (c) => { c.m.instructions.push({ programIndex: addKey(c.m, "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [], data: Uint8Array.of(1) }); }],
  ["S4 fee payer not the wallet", "S4", (c) => { c.m.staticKeys[0] = randomKey(); }],
  ["S4 a second signer", "S4", (c) => {
    c.m.staticKeys.splice(1, 0, randomKey());
    for (const ix of c.m.instructions) { ix.programIndex = ix.programIndex >= 1 ? ix.programIndex + 1 : ix.programIndex; ix.accounts = ix.accounts.map((a) => (a >= 1 ? a + 1 : a)); }
    c.m.requiredSignatures = 2;
    return encode(c.m, 2);
  }],
  ["S5 Sender tip 5,001", "S5", (c) => { const i = c.m.instructions.filter((ix) => c.m.staticKeys[ix.programIndex] === SYSTEM)[1] as { data: Uint8Array }; setU64(i.data, 4, 5_001n); }],
  ["S5 Jito tip to a stranger", "S5", (c) => { const i = c.m.instructions.filter((ix) => c.m.staticKeys[ix.programIndex] === SYSTEM)[2] as { accounts: number[] }; i.accounts[1] = addKey(c.m, randomKey()); }],
  ["S5 wrap 1 lamport more", "S5", (c) => { const i = c.m.instructions.filter((ix) => c.m.staticKeys[ix.programIndex] === SYSTEM)[0] as { data: Uint8Array }; setU64(i.data, 4, 9_874_874n); }],
  ["S5 an extra transfer", "S5", (c) => { c.m.instructions.push({ programIndex: indexOf(c.m, SYSTEM), accounts: [0, addKey(c.m, randomKey())], data: Uint8Array.of(2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0) }); }],
  ["S5 a token Approve on the wallet's wSOL", "S5", (c) => {
    const sync = c.m.instructions[4] as { accounts: number[] };
    c.m.instructions.splice(5, 0, { programIndex: indexOf(c.m, TOKEN), accounts: [sync.accounts[0] as number, addKey(c.m, randomKey()), 0], data: Uint8Array.of(4, 255, 255, 255, 255, 255, 255, 255, 255) });
  }],
  ["S6 output to a stranger's account", "S6", (c) => { jupIx(c.m).accounts[2] = addKey(c.m, randomKey()); }],
  ["S6 destination_token_account set", "S6", (c) => { jupIx(c.m).accounts[7] = addKey(c.m, randomKey()); }],
  ["S7 slippage 951 bps", "S7", (c) => setU16(jupData(c.m), 24, 951)],
  ["S7 quoted out - 1", "S7", (c) => setU64(jupData(c.m), 16, 51_111_993_060n)],
  ["S7 platform fee 1 bps", "S7", (c) => setU16(jupData(c.m), 26, 1)],
  ["S7 positive slippage 1 bps", "S7", (c) => setU16(jupData(c.m), 28, 1)],
  ["S8 CU price 1,000,001", "S8", (c) => setU64((c.m.instructions[1] as { data: Uint8Array }).data, 1, 1_000_001n)],
  ["S8 CU limit 200,001 on a pump buy", "S8", (c) => setU32((c.m.instructions[0] as { data: Uint8Array }).data, 1, 200_001)],
  ["S8 a third budget instruction", "S8", (c) => { c.m.instructions.unshift({ programIndex: indexOf(c.m, CB), accounts: [], data: Uint8Array.of(1, 0, 0, 1, 0) }); }],
  ["S9 the tx grows past 1,232 bytes", "S9", (c) => { const t = c.m.instructions[c.m.instructions.length - 1] as { accounts: number[] }; t.accounts = [...t.accounts]; c.m.instructions.push(...Array.from({ length: 40 }, () => ({ programIndex: indexOf(c.m, CB), accounts: [], data: new Uint8Array(9) }))); }],
  ["S10 the providers disagree on the mint", "S10", (c) => { const d = (c.reads.mint[1] as SolanaAccountRead).data.slice(); (d[0] as number) ^= 1; (c.reads as { mint: unknown }).mint = [c.reads.mint[0], { owner: T22, data: d }]; }],
  ["S10 a transfer hook with an authority", "S10", (c) => { const m = withExt(c.reads.mint[0] as SolanaAccountRead, 14, Uint8Array.from({ length: 64 }, (_, i) => (i < 32 ? 7 : 9))); (c.reads as { mint: unknown }).mint = [m, m]; }],
  ["S10 a confidential transfer mint", "S10", (c) => { const m = withExt(c.reads.mint[0] as SolanaAccountRead, 4, new Uint8Array(65)); (c.reads as { mint: unknown }).mint = [m, m]; }],
  ["S10 non-transferable", "S10", (c) => { const m = withExt(c.reads.mint[0] as SolanaAccountRead, 9, new Uint8Array(0)); (c.reads as { mint: unknown }).mint = [m, m]; }],
  ["S11 provider B's simulation fails", "S11", (c) => { (c.reads.simulations[1] as SolanaSimulation).err = { InstructionError: [6, { Custom: 6001 }] }; }],
  ["S11 a simulation error that cannot be printed refuses, never throws", "S11", (c) => { (c.reads.simulations[1] as SolanaSimulation).err = 1n; }],
  ["S11 no simulation on provider B", "S11", (c) => { (c.reads as { simulations: unknown }).simulations = [c.reads.simulations[0], null]; }],
  ["S11 native out 1 lamport over the bound", "S11", (c) => { const s = c.reads.simulations[0] as SolanaSimulation; s.walletLamports.post -= 1n + (s.walletLamports.pre - s.walletLamports.post - (9_874_873n + 13_001n + 15_000n + 1_513_840n + 1_346_200n)); }],
  ["S11 token in below minOut", "S11", (c) => { (c.reads.simulations[1] as SolanaSimulation).tokenAccount.post = 46_256_353_719n; }],
  ["S11 another wallet of this user changes", "S11", (c) => { ((c.reads.simulations[0] as SolanaSimulation).otherWallets[0] as { post: bigint }).post -= 1n; }],
  ["S11 the pump volume account takes more than its rent", "S11", (c) => { (c.reads.simulations[0] as SolanaSimulation).pumpVolumeAccumulator.post = 1_346_201n; }],
  ["S12 no reference pool", "S12", (c) => { (c.reads as { reference: unknown }).reference = null; }],
  ["S12 simulated out below E less 200 bps", "S12", (c) => { (c.reads.reference as { expectedOut: bigint }).expectedOut = (buyToken * 10_000n) / 9_800n + 2n; }],
  ["S12 minOut below E less s", "S12", (c) => { c.req.minOut = 46_256_353_719n; setU64(jupData(c.m), 16, 51_111_993_061n); }],
  ["S13 the wSOL close removed", "S13", (c) => { const closes = progAt(c.m, TOKEN).filter((i) => (c.m.instructions[i] as { data: Uint8Array }).data[0] === 9); c.m.instructions.splice(closes[0] as number, 1); }],
  ["S13 the wSOL close pays a stranger", "S13", (c) => { const i = progAt(c.m, TOKEN).find((j) => (c.m.instructions[j] as { data: Uint8Array }).data[0] === 9) as number; (c.m.instructions[i] as { accounts: number[] }).accounts[1] = addKey(c.m, randomKey()); }],
  ["S13 the output account closed", "S13", (c) => { const create = c.m.instructions[5] as { accounts: number[] }; c.m.instructions.push({ programIndex: create.accounts[5] as number, accounts: [create.accounts[1] as number, 0, 0], data: Uint8Array.of(9) }); }],
  ["DECODE a byte after the message", "DECODE", (c) => Uint8Array.from([...encode(c.m), 0])],
  ["DECODE a legacy message", "DECODE", (c) => { const b = encode(c.m); b[65] = 1; return b; }],
];

function withExt(m: SolanaAccountRead, type: number, body: Uint8Array): SolanaAccountRead {
  const d = Uint8Array.from([...m.data, type & 0xff, type >> 8, body.length & 0xff, body.length >> 8, ...body]);
  return { owner: m.owner, data: d };
}

for (const [name, id, mutate] of CASES) {
  test(`refused: ${name}`, () => {
    const c = buyCase();
    const bytes = mutate(c);
    refusedBy(id, run(c, bytes ?? undefined));
  });
}

test("refused on a sell: token out not the signed amount, native in below minOut", () => {
  const a = sellCase();
  (a.reads.simulations[0] as SolanaSimulation).tokenAccount.post = 1n;
  refusedBy("S11", run(a));
  const b = sellCase();
  (b.reads.simulations[1] as SolanaSimulation).walletLamports.post -= 1_000_000n;
  refusedBy("S11", run(b));
  const c = sellCase();
  setU64(jupData(c.m), 8, buyToken - 1n);
  refusedBy("S1", run(c));
});

// ---- the property sweep: change any field the request binds, at random, and the swap is refused.
// Fields: every data byte of every instruction other than the route and the budget; the route's discriminator,
// in_amount, platform fee and positive slippage; every account slot of those instructions and of the route's ten named
// accounts, pointed at a fresh key; the static keys those slots name, replaced; every used lookup entry on provider B.
function sweep(build: () => ReturnType<typeof buyCase>, runs: number, start: number): number {
  seed = start;
  const base = build().m;
  const jup = progAt(base, JUP)[0] as number;
  const cb = new Set(progAt(base, CB));
  const others = base.instructions.map((_, i) => i).filter((i) => i !== jup && !cb.has(i));
  const keySlots = new Set<number>([0]);
  for (const i of others) for (const a of (base.instructions[i] as { accounts: number[] }).accounts) keySlots.add(a);
  for (const a of jupIx(base).accounts.slice(0, 10)) keySlots.add(a);
  const staticSlots = [...keySlots].filter((k) => k < base.staticKeys.length);
  const kinds = ["dataByte", "jupHead", "slot", "staticKey", "tableB"] as const;
  let n = 0;
  for (let r = 0; r < runs; r++) {
    const c = build();
    const kind = kinds[rand() % kinds.length];
    let what = "";
    if (kind === "dataByte") {
      const i = others[rand() % others.length] as number;
      const d = (c.m.instructions[i] as { data: Uint8Array }).data;
      if (d.length === 0) continue;
      const o = rand() % d.length;
      d[o] = ((d[o] as number) + 1 + (rand() % 255)) & 0xff;
      what = `ix ${i} byte ${o}`;
    } else if (kind === "jupHead") {
      const offs = [...Array(16).keys(), 26, 27, 28, 29];
      const o = offs[rand() % offs.length] as number;
      const d = jupData(c.m);
      d[o] = ((d[o] as number) + 1 + (rand() % 255)) & 0xff;
      what = `route byte ${o}`;
    } else if (kind === "slot") {
      const pool = [...others.flatMap((i) => (c.m.instructions[i] as { accounts: number[] }).accounts.map((_, j) => [i, j] as const)), ...Array.from({ length: 10 }, (_, j) => [jup, j] as const)];
      const [i, j] = pool[rand() % pool.length] as readonly [number, number];
      (c.m.instructions[i] as { accounts: number[] }).accounts[j] = addKey(c.m, randomKey());
      what = `ix ${i} account ${j}`;
    } else if (kind === "staticKey") {
      const k = staticSlots[rand() % staticSlots.length] as number;
      c.m.staticKeys[k] = randomKey();
      what = `static key ${k}`;
    } else {
      const [k, pair] = Object.entries(c.reads.tables)[0] as [string, readonly [SolanaAccountRead, SolanaAccountRead]];
      const l = c.m.lookups[0] as { writable: number[]; readonly: number[] };
      const used = [...l.writable, ...l.readonly];
      const idx = used[rand() % used.length] as number;
      const b = pair[1].data.slice();
      const o = 56 + idx * 32 + (rand() % 32);
      b[o] = ((b[o] as number) + 1 + (rand() % 255)) & 0xff;
      (c.reads as { tables: unknown }).tables = { [k]: [pair[0], { owner: pair[1].owner, data: b }] };
      what = `table entry ${idx} on B`;
    }
    const v = run(c);
    assert.equal(v.ok, false, `${kind} ${what} passed`);
    n++;
  }
  return n;
}
test("property: any changed bound field is refused on the buy (seeded, 600 runs)", () => {
  assert.ok(sweep(buyCase, 600, 0xc0ffee) > 500);
});
test("property: any changed bound field is refused on the sell (seeded, 600 runs)", () => {
  assert.ok(sweep(sellCase, 600, 0x5e11) > 500);
});

test("the fixture's lookup table and mint are the same bytes on both providers", () => {
  for (const [a, b] of Object.values(F.tables)) assert.equal(a.data, b.data);
  assert.equal(F.mintReads[0].data, F.mintReads[1].data);
  for (const [a] of Object.values(F.tables)) assert.ok(solanaDecodeLookupTable(read(a).data).addresses.length > 0);
});

test("derivations match the landed buy: the wallet's token and wSOL accounts, and the pump volume account it funded", () => {
  const m = msgOf(BUY);
  const keys = m.staticKeys;
  assert.ok(keys.includes(solanaAta(W, F.mint, T22)));
  assert.ok(keys.includes(solanaAta(W, "So11111111111111111111111111111111111111112", TOKEN)));
  // the address whose lamports went from 0 to 1,346,200 in the landed buy (meta, account 3UTBLM…)
  assert.equal(solanaPumpVolumeAccumulator(W), "3UTBLMLavCztd5WPvTiiLwKsZXFNakuafLtxo7da7Qyi");
});

// ---- round 2 (the review of 4f4e106): one case per sub-condition, each built from the real bytes. The knockout run
// (switch the sub-condition off, see the card's report) turns each red.
const TABLES = Object.fromEntries(Object.entries(F.tables).map(([k, [a]]) => [k, solanaDecodeLookupTable(read(a).data)]));
const allKeys = (m: SolanaMessage): string[] => solanaResolveKeys(m, TABLES).map((k) => k.key);
// Move a key that the message loads from a table into the static keys (a program id must be static), keeping every
// instruction pointed at the same keys.
function staticize(m: SolanaMessage, key: string): number {
  const before = allKeys(m);
  if (m.staticKeys.includes(key)) return m.staticKeys.indexOf(key);
  const t = TABLES[m.lookups[0]?.table as string] as { addresses: string[] };
  for (const l of m.lookups) {
    l.writable = l.writable.filter((i) => t.addresses[i] !== key);
    l.readonly = l.readonly.filter((i) => t.addresses[i] !== key);
  }
  m.staticKeys.push(key);
  m.readonlyUnsigned++;
  const after = allKeys(m);
  for (const ix of m.instructions) {
    ix.programIndex = after.indexOf(before[ix.programIndex] as string);
    for (let j = 0; j < ix.accounts.length; j++) ix.accounts[j] = after.indexOf(before[ix.accounts[j] as number] as string);
  }
  return m.staticKeys.indexOf(key);
}
const jupPos = (m: SolanaMessage): number => progAt(m, JUP)[0] as number;
const move = (m: SolanaMessage, from: number, to: number): void => {
  const [ix] = m.instructions.splice(from, 1);
  m.instructions.splice(to, 0, ix as SolanaMessage["instructions"][number]);
};
const ix = (m: SolanaMessage, i: number) => m.instructions[i] as SolanaMessage["instructions"][number];
const wsolClose = (m: SolanaMessage): number => progAt(m, TOKEN).find((i) => ix(m, i).data[0] === 9) as number;
// A middle mint M under a token program: its account created before the route and (optionally) harvested and closed
// after it, the U-6 shape (T2.1 step 6a).
function middle(c: ReturnType<typeof buyCase>, tp: string, opts: { close?: string | null; harvest?: "before-close" | "early" | "other-mint" } = {}): { acc: number; mint: number } {
  const m = c.m;
  const mintKey = randomKey();
  const accKey = solanaAta(W, mintKey, tp);
  const tpAt = staticize(m, tp);
  const ataAt = indexOf(m, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const sys = indexOf(m, SYSTEM);
  const mint = addKey(m, mintKey);
  const acc = addKey(m, accKey);
  m.instructions.splice(jupPos(m), 0, { programIndex: ataAt, accounts: [0, acc, 0, mint, sys, tpAt], data: Uint8Array.of(1) });
  const closeProg = opts.close === null ? null : staticize(m, opts.close ?? tp);
  const after = jupPos(m) + 1;
  if (closeProg !== null) m.instructions.splice(after, 0, { programIndex: closeProg, accounts: [acc, 0, 0], data: Uint8Array.of(9) });
  if (opts.harvest) {
    const t22 = staticize(m, T22);
    const hMint = opts.harvest === "other-mint" ? addKey(m, randomKey()) : mint;
    const h = { programIndex: t22, accounts: [hMint, acc], data: Uint8Array.of(26, 4) };
    m.instructions.splice(opts.harvest === "early" ? jupPos(m) + 1 : after, 0, h);
    if (opts.harvest === "early") move(m, after + 1, after + 2 < m.instructions.length ? after + 2 : after + 1); // a tip between the harvest and the close
  }
  return { acc, mint };
}

const ACCEPTED: [string, (c: ReturnType<typeof buyCase>) => void][] = [
  ["S11 an existing output account topped up during the swap: lamports into W_k's own account, counted up to its rent", (c) => {
    for (const s of c.reads.simulations) (s as SolanaSimulation).tokenAccountLamports = { pre: 1_513_840n, post: 3_027_680n };
  }],
  ["S11 a stranger pre-funds W_k's output address with 650,240 lamports: W_k pays only the 863,600 rest, within the bound", (c) => {
    for (const s of c.reads.simulations) {
      const x = s as SolanaSimulation;
      x.tokenAccountLamports = { pre: 650_240n, post: 1_513_840n };
      x.walletLamports.post += 650_240n;
    }
  }],
  ["U-6: an SPL middle account created before the route and closed after it, native out unchanged", (c) => { middle(c, TOKEN); }],
  ["U-6: a Token-2022 middle account harvested right before its close", (c) => { middle(c, T22, { harvest: "before-close" }); }],
];
for (const [name, mutate] of ACCEPTED) {
  test(`accepted: ${name}`, () => {
    const c = buyCase();
    mutate(c);
    const v = run(c);
    assert.equal(v.ok, true, v.results.filter((r) => !r.ok).map((r) => `${r.id} ${r.detail}`).join(" | "));
  });
}

const R2: [string, SolanaQuoteCheckId, (c: ReturnType<typeof buyCase>) => Uint8Array | void][] = [
  ["S11 provider A lies about the token account rent", "S11", (c) => { (c.reads.rent as { tokenAccount: unknown }).tokenAccount = [501_513_840n, 1_513_840n]; }],
  ["S11 provider B lies about the pump volume account rent", "S11", (c) => { (c.reads.rent as { pumpVolumeAccumulator: unknown }).pumpVolumeAccumulator = [1_346_200n, 501_346_200n]; }],
  ["S11 the output account existed before, so its rent is not in the bound", "S11", (c) => { for (const s of c.reads.simulations) (s as SolanaSimulation).tokenAccountLamports = { pre: 1_513_840n, post: 1_513_840n }; }],
  ["S12 simulated out at the rounding edge: 1 below the bar rounded up", "S12", (c) => {
    // E × 9800 / 10000 = 55,991,176,135.02: rounded down the bar equals the simulated out, rounded up it is 1 above
    // s = 2000 bps keeps minOut_k above floor(E × (1 − s)), so only the simulated-out bar decides
    (c.reads as { reference: unknown }).reference = { expectedOut: 57_133_853_199n, slippageBps: 2_000 };
  }],
  ["S13 close before the route", "S13", (c) => { move(c.m, wsolClose(c.m), jupPos(c.m)); }],
  ["S13 create after the route", "S13", (c) => { move(c.m, 5, jupPos(c.m)); }],
  ["S5 wrap after the route", "S5", (c) => { move(c.m, 3, jupPos(c.m)); }],
  ["S13 harvest not right before its close", "S13", (c) => { middle(c, T22, { harvest: "early" }); }],
  ["S13 harvest of another mint", "S13", (c) => { middle(c, T22, { harvest: "other-mint" }); }],
  ["S5 SyncNative on an account other than the wallet's wSOL", "S5", (c) => { ix(c.m, 4).accounts[0] = ix(c.m, 5).accounts[1] as number; }],
  ["S13 a Token-2022 middle account closed under the SPL Token program", "S13", (c) => { middle(c, T22, { close: TOKEN }); }],
  ["S13 the wSOL account closed twice", "S13", (c) => { const i = wsolClose(c.m); c.m.instructions.splice(i, 0, structuredClone(ix(c.m, i))); }],
  ["S13 U-6: a middle account left open", "S13", (c) => { middle(c, TOKEN, { close: null }); }],
  ["S11 U-6: dust left in a middle account fails its simulated close", "S11", (c) => { middle(c, TOKEN); for (const s of c.reads.simulations) (s as SolanaSimulation).err = { InstructionError: [8, { Custom: 11 }] }; }],
  ["S11 the pump volume account drained (delta < 0)", "S11", (c) => {
    // it existed before (so the buy does not fund it) and the swap takes its 1,346,200 lamports elsewhere
    for (const s of c.reads.simulations) { const x = s as SolanaSimulation; x.pumpVolumeAccumulator = { pre: 1_346_200n, post: 0n }; x.walletLamports.post += 1_346_200n; }
  }],
  ["S2 provider B's table not owned by the table program", "S2", (c) => {
    const [k, pair] = Object.entries(c.reads.tables)[0] as [string, readonly [SolanaAccountRead, SolanaAccountRead]];
    (c.reads as { tables: unknown }).tables = { [k]: [pair[0], { owner: SYSTEM, data: pair[1].data }] };
  }],
  ["S10 nonzero bytes after the last extension", "S10", (c) => { const a = c.reads.mint[0] as SolanaAccountRead; const m = { owner: a.owner, data: Uint8Array.from([...a.data, 0, 0, 0, 0, 7]) }; (c.reads as { mint: unknown }).mint = [m, m]; }],
  ["S13 an account created with a stranger as owner", "S13", (c) => { ix(c.m, 5).accounts[2] = addKey(c.m, randomKey()); }],
  ["DECODE a compact-u16 not in its shortest form", "DECODE", (c) => { const b = encode(c.m); return Uint8Array.from([0x81, 0x00, ...b.subarray(1)]); }],
  ["DECODE two signature slots for one signer", "DECODE", (c) => { const b = encode(c.m); return Uint8Array.from([2, ...new Array<number>(64).fill(0), ...b.subarray(1)]); }],
  ["S12 E of zero", "S12", (c) => { (c.reads.reference as { expectedOut: bigint }).expectedOut = 0n; }],
  ["S12 slippage over 10,000 bps", "S12", (c) => { (c.reads.reference as { slippageBps: number }).slippageBps = 10_001; }],
];
for (const [name, id, mutate] of R2) {
  test(`refused: ${name}`, () => {
    const c = buyCase();
    const bytes = mutate(c);
    refusedBy(id, run(c, bytes ?? undefined));
  });
}

test("refused: S11 a sell that funds the pump volume account", () => {
  const c = sellCase();
  for (const s of c.reads.simulations) (s as SolanaSimulation).pumpVolumeAccumulator = { pre: 0n, post: 1_346_200n };
  refusedBy("S11", run(c));
});

// ---- the reviewer's sweep: swap in keys already in the message, move instructions, duplicate them. Every variant that
// still passes must be one of the named accepted variants below, each with the reason it is harmless or fails on chain.
function keySweep(): { swaps: number; moves: number; dups: number; passed: string[] } {
  const base = buyCase().m;
  const n = allKeys(base).length;
  const jup = jupPos(base);
  const passed: string[] = [];
  let swaps = 0;
  let moves = 0;
  let dups = 0;
  const slots: [number, number][] = [];
  base.instructions.forEach((x, i) => {
    slots.push([i, -1]);
    const upto = i === jup ? 10 : x.accounts.length;
    for (let j = 0; j < upto; j++) slots.push([i, j]);
  });
  for (const [i, j] of slots) {
    const cur = j < 0 ? ix(base, i).programIndex : (ix(base, i).accounts[j] as number);
    for (let k = 0; k < n; k++) {
      if (k === cur) continue;
      const c = buyCase();
      if (j < 0) {
        if (k >= c.m.staticKeys.length) continue; // a program id must be a static key: the runtime refuses a loaded one
        ix(c.m, i).programIndex = k;
      } else ix(c.m, i).accounts[j] = k;
      swaps++;
      if (run(c).ok) passed.push(`swap ix ${i} ${j < 0 ? "program" : `account ${j}`} -> key ${k}`);
    }
  }
  for (let i = 0; i < base.instructions.length; i++) {
    for (let to = 0; to < base.instructions.length; to++) {
      if (to === i) continue;
      const c = buyCase();
      move(c.m, i, to);
      moves++;
      if (run(c).ok) passed.push(`move ix ${i} -> ${to}`);
    }
    for (let at = 0; at <= base.instructions.length; at++) {
      const c = buyCase();
      c.m.instructions.splice(at, 0, structuredClone(ix(c.m, i)));
      dups++;
      if (run(c).ok) passed.push(`duplicate ix ${i} at ${at}`);
    }
  }
  return { swaps, moves, dups, passed };
}
// The buy's instructions: 0-1 budget, 2 create wSOL, 3 wrap, 4 SyncNative, 5 create the output account, 6 the route,
// 7 close wSOL, 8-9 the two tips.
const ACCEPTED_VARIANTS: [RegExp, string][] = [
  [/^swap ix 6 account 7 -> key 2$/, "the route's optional destination set to key 2, W_k's own output account (S6 allows only that)"],
  [/^move ix [01] -> \d$/, "a compute budget instruction applies wherever it sits in the tx"],
  [/^move ix (8 -> \d|9 -> \d|7 -> [89])$/, "the two fixed tips and the wSOL close move the same lamports to the same accounts in any order"],
  [/^move ix [2-5] -> [0-5]$/, "the setup in another order before the route: lamports go only to W_k's own wSOL address and accounts W_k owns; a wrong order fails on chain"],
  [/^duplicate ix [245] at [0-6]$/, "a second CreateIdempotent is a no-op, a second SyncNative re-syncs W_k's own wSOL (or fails on chain before the create)"],
];
test("sweep: 844 key swaps, 90 moves and 110 duplicates; every one that passes is a named harmless or chain-rejected variant", () => {
  const r = keySweep();
  assert.deepEqual([r.swaps, r.moves, r.dups], [844, 90, 110]);
  const unnamed = r.passed.filter((p) => !ACCEPTED_VARIANTS.some(([re]) => re.test(p)));
  assert.deepEqual(unnamed, []);
  const counts = ACCEPTED_VARIANTS.map(([re, why]) => `${r.passed.filter((p) => re.test(p)).length} ${why}`);
  assert.equal(r.passed.length, 80, counts.join("; "));
});
