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
import { solanaAta, solanaDecodeLookupTable, solanaDecodeTransaction, type SolanaMessage } from "../src/checks/solana/message.ts";

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
const RENT = Object.values(F.rentExempt)[0] as { 137: number; 170: number };

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
// (the slippage in the signed route), so minOut_k = floor(E × 9050 / 10000) = 46256353720; tol 100 bps (the paper
// leaves tol open). The simulation is the landed tx's own balances (meta), the same on both providers.
const buyToken = 55_991_176_135n; // the landed buy's token in (meta.postTokenBalances of the wallet's account)
function buyCase(): { m: SolanaMessage; req: SolanaQuoteRequest; reads: SolanaQuoteReads } {
  const sim: SolanaSimulation = {
    err: null,
    walletLamports: { pre: BigInt(BUY.meta.preBalances[0] as number), post: BigInt(BUY.meta.postBalances[0] as number) },
    tokenAccount: { pre: 0n, post: buyToken },
    pumpVolumeAccumulator: { pre: 0n, post: 1_346_200n },
    otherWallets: [{ pre: 9_874_873n, post: 9_874_873n }],
  };
  return {
    m: msgOf(BUY),
    req: { side: "buy", wallet: W, token: F.mint, amount: 9_874_873n, spendable: BigInt(BUY.meta.preBalances[0] as number), minOut: 46_256_353_720n },
    reads: {
      tables: Object.fromEntries(Object.entries(F.tables).map(([k, [a, b]]) => [k, [read(a), read(b)] as const])),
      mint: [read(F.mintReads[0]), read(F.mintReads[1])],
      rent: { tokenAccount: BigInt(RENT[170]), pumpVolumeAccumulator: BigInt(RENT[137]) },
      simulations: [sim, structuredClone(sim)],
      reference: { expectedOut: 51_111_993_061n, tolBps: 100, slippageBps: 950 },
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
    pumpVolumeAccumulator: { pre: 1_346_200n, post: 1_346_200n },
    otherWallets: [],
  };
  const b = buyCase();
  return {
    m,
    req: { side: "sell", wallet: W, token: F.mint, amount: buyToken, spendable: buyToken, minOut: 8_738_870n },
    reads: { ...b.reads, simulations: [sim, structuredClone(sim)], reference: { expectedOut: 9_656_210n, tolBps: 100, slippageBps: 950 } },
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
  ["S11 no simulation on provider B", "S11", (c) => { (c.reads as { simulations: unknown }).simulations = [c.reads.simulations[0], null]; }],
  ["S11 native out 1 lamport over the bound", "S11", (c) => { const s = c.reads.simulations[0] as SolanaSimulation; s.walletLamports.post -= 1n + (s.walletLamports.pre - s.walletLamports.post - (9_874_873n + 13_001n + 15_000n + 1_513_840n + 1_346_200n)); }],
  ["S11 token in below minOut", "S11", (c) => { (c.reads.simulations[1] as SolanaSimulation).tokenAccount.post = 46_256_353_719n; }],
  ["S11 another wallet of this user changes", "S11", (c) => { ((c.reads.simulations[0] as SolanaSimulation).otherWallets[0] as { post: bigint }).post -= 1n; }],
  ["S11 the pump volume account takes more than its rent", "S11", (c) => { (c.reads.simulations[0] as SolanaSimulation).pumpVolumeAccumulator.post = 1_346_201n; }],
  ["S12 no reference pool", "S12", (c) => { (c.reads as { reference: unknown }).reference = null; }],
  ["S12 simulated out below E less tol", "S12", (c) => { (c.reads.reference as { expectedOut: bigint }).expectedOut = (buyToken * 10_000n) / 9_900n + 2n; }],
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
test("property: any changed bound field is refused (seeded, 600 runs)", () => {
  seed = 0xc0ffee;
  const base = buyCase().m;
  const jup = progAt(base, JUP)[0] as number;
  const cb = new Set(progAt(base, CB));
  const others = base.instructions.map((_, i) => i).filter((i) => i !== jup && !cb.has(i));
  const keySlots = new Set<number>([0]);
  for (const i of others) for (const a of (base.instructions[i] as { accounts: number[] }).accounts) keySlots.add(a);
  for (const a of jupIx(base).accounts.slice(0, 10)) keySlots.add(a);
  const staticSlots = [...keySlots].filter((k) => k < base.staticKeys.length);
  const kinds = ["dataByte", "jupHead", "slot", "staticKey", "tableB"] as const;
  let n = 0;
  for (let r = 0; r < 600; r++) {
    const c = buyCase();
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
  assert.ok(n > 500, `${n} runs`);
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
