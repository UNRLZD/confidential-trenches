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
  SOLANA_PUMP_AMM_PROGRAM,
  SolanaWalletLinks,
  checkSolanaQuote,
  solanaMintDisagreement,
  solanaPumpVolumeAccumulator,
  solanaTokenAccountSize,
  solanaVolumeAccumulator,
  type SolanaAccountRead,
  type SolanaHeldRead,
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
// Another wallet of the same user, which the good trades never name.
const OTHER = base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
const buyToken = 55_991_176_135n; // the landed buy's token in (meta.postTokenBalances of the wallet's account)
// The wallet's account of the token (Token-2022), which both trades write: S11 holds its base after each simulation
// (card solana-written-accounts-whole), so each case reads it back: the buy creates it clean, the sell empties it.
const OWN = solanaAta(W, F.mint, T22);
function buyCase(): { m: SolanaMessage; req: SolanaQuoteRequest; reads: SolanaQuoteReads } {
  const sim: SolanaSimulation = {
    err: null,
    walletLamports: { pre: BigInt(BUY.meta.preBalances[0] as number), post: BigInt(BUY.meta.postBalances[0] as number) },
    tokenAccount: { pre: 0n, post: buyToken },
    tokenAccountLamports: { pre: 0n, post: 1_513_840n }, // the landed buy: ECDKZF… 0 -> 1,513,840 (meta)
    pumpVolumeAccumulator: { pre: 0n, post: 1_346_200n },
    pumpSwapVolumeAccumulator: { pre: 0n, post: 0n },
    walletAccounts: { [OWN]: wide(held(W, F.mint, T22, buyToken, 1_513_840n)) },
  };
  return {
    m: msgOf(BUY),
    req: { side: "buy", wallet: W, token: F.mint, amount: 9_874_873n, spendable: BigInt(BUY.meta.preBalances[0] as number), minOut: 46_256_353_720n, otherWallets: [OTHER] },
    reads: {
      tables: Object.fromEntries(Object.entries(F.tables).map(([k, [a, b]]) => [k, [read(a), read(b)] as const])),
      mint: [read(F.mintReads[0]), read(F.mintReads[1])],
      rent: { tokenAccount: [BigInt(RENT_A[170]), BigInt(RENT_B[170])], pumpVolumeAccumulator: [BigInt(RENT_A[137]), BigInt(RENT_B[137])] },
      simulations: [sim, structuredClone(sim)],
      writable: {},
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
    pumpSwapVolumeAccumulator: { pre: 0n, post: 0n },
    walletAccounts: { [OWN]: wide(held(W, F.mint, T22, 0n, 1_513_840n)) },
  };
  const b = buyCase();
  const own = wide(held(W, F.mint, T22, buyToken, 1_513_840n));
  return {
    m,
    req: { side: "sell", wallet: W, token: F.mint, amount: buyToken, spendable: buyToken, minOut: 8_738_870n, otherWallets: [] },
    reads: { ...b.reads, simulations: [sim, structuredClone(sim)], writable: { [OWN]: [own, own] }, reference: { expectedOut: 9_656_210n, slippageBps: 950 } },
  };
}
// The device's reads of the accounts a tx writes: the case's own, and every other one as no account (none of them is
// the wallet's token account before these trades: the buy creates the token account and the wSOL account it closes).
function writes(bytes: Uint8Array, reads: SolanaQuoteReads): SolanaQuoteReads {
  let keys: string[] = [];
  try {
    const m = solanaDecodeTransaction(bytes).message;
    const tables = Object.fromEntries(m.lookups.map((l) => [l.table, solanaDecodeLookupTable((reads.tables[l.table] as readonly [SolanaAccountRead, SolanaAccountRead])[0].data)]));
    keys = solanaResolveKeys(m, tables).filter((k) => k.writable).map((k) => k.key);
  } catch { /* a case that breaks the bytes or a table: the check refuses it before any account matters */ }
  return { ...reads, writable: { ...Object.fromEntries(keys.map((k) => [k, [null, null]])), ...reads.writable } };
}
const run = (c: { m: SolanaMessage; req: SolanaQuoteRequest; reads: SolanaQuoteReads }, bytes?: Uint8Array) => {
  const b = bytes ?? encode(c.m);
  return checkSolanaQuote(b, c.req, writes(b, c.reads));
};
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
  const v = run(buyCase(), Uint8Array.from(Buffer.from(BUY.tx, "base64")));
  assert.equal(v.ok, true, v.results.filter((r) => !r.ok).map((r) => `${r.id} ${r.detail}`).join(" | "));
  assert.equal(v.results.length, 13);
});

test("the trade's map of the user's wallets: the real buy passes with it, and it holds every account S11 looks for", () => {
  const links = new SolanaWalletLinks([W, OTHER]);
  const v = run({ ...buyCase(), req: { ...buyCase().req, links } }, Uint8Array.from(Buffer.from(BUY.tx, "base64")));
  assert.equal(v.ok, true, v.results.filter((r) => !r.ok).map((r) => `${r.id} ${r.detail}`).join(" | "));
  const WSOL = "So11111111111111111111111111111111111111112";
  const sva = solanaVolumeAccumulator(OTHER, SOLANA_PUMP_AMM_PROGRAM);
  for (const k of [OTHER, solanaVolumeAccumulator(OTHER, PUMP), sva, solanaAta(sva, WSOL, TOKEN), solanaAta(OTHER, WSOL, TOKEN), solanaAta(OTHER, WSOL, T22), solanaAta(OTHER, F.mint, TOKEN), solanaAta(OTHER, F.mint, T22)]) assert.equal(links.ownerOf(k), OTHER, k);
  // before any tx's keys: the wallet, its volume accounts, its cashback account and its WSOL accounts (a tx can name a
  // WSOL account without the WSOL mint, as a close or a sync does)
  const fresh = new SolanaWalletLinks([OTHER]);
  for (const k of [OTHER, solanaVolumeAccumulator(OTHER, PUMP), sva, solanaAta(sva, WSOL, TOKEN), solanaAta(OTHER, WSOL, TOKEN), solanaAta(OTHER, WSOL, T22)]) assert.equal(fresh.ownerOf(k), OTHER, k);
  const any = allKeys(buyCase().m).at(-1) as string;
  assert.equal(links.ownerOf(solanaAta(OTHER, any, TOKEN)), OTHER, "grown by the check with the tx's own keys");
  assert.equal(links.ownerOf(solanaAta(W, F.mint, TOKEN)), W);
});

test("one long-lived map: it grows only by new wallets and new keys, a wallet joins once its accounts are all derived, and grows run in turn", async () => {
  const WSOL = "So11111111111111111111111111111111111111112";
  const k1 = base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff));
  const W2 = base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 1) & 0xff));
  // a wallet joins only once its last account is derived: a check between two slices does not trust the map with it
  const part = new SolanaWalletLinks();
  part.add([k1, OTHER, W2, W]);
  const growing = part.grow([OTHER], [], 0);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(part.holds([OTHER]), false, "half derived, not held");
  await growing;
  assert.equal(part.holds([OTHER]), true);
  const m = new SolanaWalletLinks();
  const first = m.grow([OTHER], [k1], 0);
  const second = m.grow([W2], [], 0);
  assert.equal(m.holds([OTHER]), false, "nothing is derived before the grow runs");
  await second;
  assert.equal(m.holds([OTHER, W2]), true, "an awaited grow means every earlier one is done");
  await first;
  for (const w of [OTHER, W2]) for (const k of [WSOL, k1]) for (const prog of [TOKEN, T22]) assert.equal(m.ownerOf(solanaAta(w, k, prog)), w, `${w} ${k}`);
  // a later trade: the same wallets and keys cost nothing; a new key reaches every wallet in the map
  let t = performance.now();
  await m.grow([OTHER, W2], [k1, WSOL]);
  m.add([k1, WSOL]);
  assert.ok(performance.now() - t < 20, "nothing derived again");
  const k2 = base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 17 + 9) & 0xff));
  t = performance.now();
  await m.grow([], [k2]);
  assert.equal(m.ownerOf(solanaAta(W2, k2, T22)), W2);
  // S11 trusts it only while it holds every other wallet
  const c = buyCase();
  (c.req as { links?: SolanaWalletLinks }).links = m;
  assert.equal(run(c).ok, true);
  assert.equal(m.holds([W]), false, "S11 grows a given map by the tx's keys only, never by a wallet");
  assert.equal(m.ownerOf(solanaAta(OTHER, allKeys(c.m).at(-1) as string, TOKEN)), OTHER, "and by the tx's keys");
});

test("grows in flight, seeded interleavings: a wallet the map holds always has its accounts and every finished key's, and S11's add() right after a holds() leaves nothing missing", async () => {
  // grow() at slice 0 yields after every derivation; addWallets(), add() and S11's pattern run between the slices
  let seed = 0x5eed_1234;
  const rand = (): number => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296; };
  const keyOf = (): string => base58.encode(Uint8Array.from({ length: 32 }, () => Math.floor(rand() * 256)));
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)] as T;
  const WS = Array.from({ length: 8 }, keyOf);
  const KS = Array.from({ length: 10 }, keyOf);
  const WSOL = "So11111111111111111111111111111111111111112";
  const missing: string[] = [];
  const owns = (m: SolanaWalletLinks, o: string, k: string) => m.ownerOf(solanaAta(o, k, TOKEN)) === o && m.ownerOf(solanaAta(o, k, T22)) === o;
  for (let round = 0; round < 30; round++) {
    const m = new SolanaWalletLinks();
    const done = new Set<string>([WSOL]);
    const grows: Promise<void>[] = [];
    for (let step = 0; step < 30; step++) {
      const r = rand();
      if (r < 0.35) {
        const ws = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(WS));
        const ks = Array.from({ length: Math.floor(rand() * 4) }, () => pick(KS));
        grows.push(m.grow(ws, ks, 0).then(() => { for (const k of ks) done.add(k); }));
      } else if (r < 0.45) {
        m.addWallets([pick(WS)]);
      } else if (r < 0.65) {
        const others = [...m.wallets].filter(() => rand() < 0.6);
        if (m.holds(others)) {
          const ks = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(KS));
          m.add(ks);
          for (const k of ks) done.add(k);
          for (const o of others) for (const k of ks) if (!owns(m, o, k)) missing.push(`round ${round} S11: ${o.slice(0, 4)} ${k.slice(0, 4)}`);
        }
      } else {
        for (const o of m.wallets) {
          const sva = solanaVolumeAccumulator(o, SOLANA_PUMP_AMM_PROGRAM);
          for (const x of [o, solanaVolumeAccumulator(o, PUMP), sva, solanaAta(sva, WSOL, TOKEN)]) if (m.ownerOf(x) !== o) missing.push(`round ${round}: ${o.slice(0, 4)}'s base account`);
          for (const k of done) if (!owns(m, o, k)) missing.push(`round ${round} held: ${o.slice(0, 4)} ${k.slice(0, 4)}`);
        }
      }
      const turns = Math.floor(rand() * 4);
      for (let i = 0; i < turns; i++) await new Promise((res) => setTimeout(res, 0));
    }
    await Promise.all(grows);
    for (const o of m.wallets) for (const k of done) if (!owns(m, o, k)) missing.push(`round ${round} end: ${o.slice(0, 4)} ${k.slice(0, 4)}`);
  }
  assert.deepEqual(missing.slice(0, 5), []);
});

test("a mint another wallet holds that the tx never names: S11 refuses its token account once the caller names the mint", () => {
  const M = base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 19 + 2) & 0xff));
  const named = () => { const c = buyCase(); addKey(c.m, solanaAta(OTHER, M, TOKEN)); return c; };
  assert.equal(run(named()).ok, true, "without the held mint the map cannot know the account");
  for (const links of [undefined, new SolanaWalletLinks([W, OTHER])]) {
    const c = named();
    (c.req as { heldMints?: readonly string[] }).heldMints = [M];
    if (links) (c.req as { links?: SolanaWalletLinks }).links = links;
    refusedBy("S11", run(c));
  }
  for (const m of ["not a key", "11111111", base58.encode(new Uint8Array(31).fill(3))]) {
    const bad = buyCase();
    (bad.req as { heldMints?: unknown }).heldMints = [m];
    const v = run(bad);
    refusedBy("S11", v);
    assert.match(v.results.find((r) => r.id === "S11")!.detail, /held mints must be addresses/, m);
  }
});

test("the paper's sell shape passes every check", () => {
  const v = run(sellCase());
  assert.equal(v.ok, true, v.results.filter((r) => !r.ok).map((r) => `${r.id} ${r.detail}`).join(" | "));
});

test("the real sell as built is refused: a top-level pump call (S3) and a close of an account it did not create (S13)", () => {
  const c = sellCase();
  const v = run(c, Uint8Array.from(Buffer.from(SELL.tx, "base64")));
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
  // One wallet a request: no other wallet of the user, nor its accounts for this trade, in the tx at all, in any role.
  ["S11 the tx names another wallet of the user, read-only", "S11", (c) => { addKey(c.m, OTHER); }],
  ["S11 the tx names another wallet of the user, writable", "S11", (c) => { const k = c.m.staticKeys[c.m.requiredSignatures] as string; assert.ok(c.m.requiredSignatures < c.m.staticKeys.length - c.m.readonlyUnsigned); (c.req as { otherWallets: readonly string[] }).otherWallets = [k]; }],
  ["S11 the tx names another wallet of the user through a lookup table", "S11", (c) => { const k = allKeys(c.m)[c.m.staticKeys.length] as string; assert.ok(!c.m.staticKeys.includes(k)); (c.req as { otherWallets: readonly string[] }).otherWallets = [k]; }],
  ["S11 the tx names another wallet's token account (Token-2022)", "S11", (c) => { addKey(c.m, solanaAta(OTHER, F.mint, T22)); }],
  ["S11 the tx names another wallet's token account (Token)", "S11", (c) => { addKey(c.m, solanaAta(OTHER, F.mint, TOKEN)); }],
  ["S11 the tx names another wallet's WSOL account", "S11", (c) => { addKey(c.m, solanaAta(OTHER, "So11111111111111111111111111111111111111112", TOKEN)); }],
  ["S11 the tx names another wallet's pump volume account", "S11", (c) => { addKey(c.m, solanaVolumeAccumulator(OTHER, PUMP)); }],
  ["S11 the tx names another wallet's PumpSwap volume account", "S11", (c) => { addKey(c.m, solanaVolumeAccumulator(OTHER, SOLANA_PUMP_AMM_PROGRAM)); }],
  // PumpSwap adds this on a cashback coin (pump-swap-sdk 2.2.0 offlinePumpAmm.ts, buy 797-808, sell 1055-1070).
  ["S11 the tx names another wallet's PumpSwap cashback account (the WSOL account of its PumpSwap volume account)", "S11", (c) => { addKey(c.m, solanaAta(solanaVolumeAccumulator(OTHER, SOLANA_PUMP_AMM_PROGRAM), "So11111111111111111111111111111111111111112", TOKEN)); }],
  // Another wallet's associated token account for any mint the tx names: here a pool key named statically, and one
  // named only through the lookup table, under each token program.
  ["S11 the tx names another wallet's token account for another key of the tx (Token)", "S11", (c) => { const k = c.m.staticKeys[c.m.staticKeys.length - 1] as string; assert.ok(k !== F.mint); addKey(c.m, solanaAta(OTHER, k, TOKEN)); }],
  ["S11 the tx names another wallet's token account for a lookup-table key (Token-2022)", "S11", (c) => { const k = allKeys(c.m)[c.m.staticKeys.length] as string; assert.ok(!c.m.staticKeys.includes(k)); addKey(c.m, solanaAta(OTHER, k, T22)); }],
  ["S11 a map without the other wallet in it is not used: S11 builds its own", "S11", (c) => { (c.req as { links?: SolanaWalletLinks }).links = new SolanaWalletLinks([W]); addKey(c.m, OTHER); }],
  ["S11 the wallet in its own list of other wallets", "S11", (c) => { (c.req as { otherWallets: readonly string[] }).otherWallets = [W]; }],
  ["S11 no list of the user's other wallets", "S11", (c) => { (c.req as { otherWallets: unknown }).otherWallets = undefined; }],
  ["S11 the pump volume account takes more than its rent", "S11", (c) => { (c.reads.simulations[0] as SolanaSimulation).pumpVolumeAccumulator.post = 1_346_201n; }],
  ["S11 the PumpSwap volume account takes more than its rent", "S11", (c) => { const s = c.reads.simulations[0] as SolanaSimulation; s.pumpSwapVolumeAccumulator.post = 1_346_201n; s.walletLamports.post -= 1_346_201n; }],
  ["S11 the PumpSwap volume account drained (delta < 0)", "S11", (c) => { for (const s of c.reads.simulations) { const x = s as SolanaSimulation; x.pumpSwapVolumeAccumulator = { pre: 1_346_200n, post: 0n }; x.walletLamports.post += 1_346_200n; } }],
  ["S12 minOut below E_k less s, with E(a_k) above E_k", "S12", (c) => { (c.reads as { reference: unknown }).reference = { expectedOut: 51_111_993_061n, minOutBase: 51_111_993_061n, slippageBps: 900 }; }],
  ["S12 E_k above E(a_k)", "S12", (c) => { (c.reads as { reference: unknown }).reference = { expectedOut: 51_111_993_061n, minOutBase: 51_111_993_062n, slippageBps: 950 }; }],
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

// Provider B's read of the mint with one change (card solana-mint-supply-moves): the two providers read each at its own
// slot, and a burn between them moves the supply alone.
// A `base` mint of other extensions gives the account of the token the buy creates the size it asks (a transfer-fee
// mint: TransferFeeAmount, type 2, 8 bytes after the 170), which S11 holds that account to.
function mintB(c: ReturnType<typeof buyCase>, change: (d: Uint8Array) => void, base?: SolanaAccountRead): void {
  const a = base ?? (c.reads.mint[0] as SolanaAccountRead);
  const d = a.data.slice();
  change(d);
  (c.reads as { mint: unknown }).mint = [a, { owner: a.owner, data: d }];
  if (!base) return;
  const n = solanaTokenAccountSize(a);
  for (const s of c.reads.simulations) {
    const x = s as SolanaSimulation;
    const own = x.walletAccounts[OWN] as SolanaHeldRead;
    if (own.data.length >= n) continue;
    const g = new Uint8Array(n);
    g.set(own.data);
    setU16(g, own.data.length, 2);
    setU16(g, own.data.length + 2, n - own.data.length - 4);
    x.walletAccounts = { ...x.walletAccounts, [OWN]: { ...own, data: g } };
  }
}
// A TransferFeeConfig body (108 bytes): two authorities 7…7 and 8…8, withheld_amount, then the older and newer
// TransferFee { epoch, maximum_fee, basis_points }.
function feeBody(withheld: bigint, bps: number): Uint8Array {
  const b = new Uint8Array(108);
  b.fill(7, 0, 32);
  b.fill(8, 32, 64);
  setU64(b, 64, withheld);
  for (const at of [72, 90]) { setU64(b, at, 1n); setU64(b, at + 8, 1_000n); setU16(b, at + 16, bps); }
  return b;
}
const SUPPLY = 36; // spl-token Mint: mint_authority COption<Pubkey> (36), supply u64, decimals u8, is_initialized, freeze_authority COption<Pubkey>

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
  ["S10 the providers' mint reads differ in supply only (a burn between their slots: C5xph…pump, 6 Nov 04:20Z)", (c) => {
    mintB(c, (d) => { setU64(d, SUPPLY, 999_921_247_000_000n); });
  }],
  ["S10 the providers' mint reads differ in a transfer-fee mint's withheld fees only (a harvest between their slots)", (c) => {
    const fee = withExt(c.reads.mint[0] as SolanaAccountRead, 1, feeBody(5_000n, 0));
    mintB(c, (d) => { setU64(d, d.length - 108 + 64, 6_000n); setU64(d, SUPPLY, 1n); }, fee);
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
  ["S10 the providers disagree on the mint's freeze authority", "S10", (c) => mintB(c, (d) => { setU32(d, 46, 1); d.fill(9, 50, 82); })],
  ["S10 the providers disagree on the mint's mint authority", "S10", (c) => mintB(c, (d) => { setU32(d, 0, 1); d.fill(9, 4, 36); })],
  ["S10 the providers disagree on the mint's decimals", "S10", (c) => mintB(c, (d) => { d[44] = 9; })],
  ["S10 the providers disagree on the mint's supply and its freeze authority", "S10", (c) => mintB(c, (d) => { setU64(d, SUPPLY, 1n); setU32(d, 46, 1); d.fill(9, 50, 82); })],
  ["S10 the providers disagree on the mint's transfer fee", "S10", (c) => { const fee = withExt(c.reads.mint[0] as SolanaAccountRead, 1, feeBody(0n, 0)); mintB(c, (d) => { setU16(d, d.length - 2, 100); }, fee); }],
  ["S10 the providers disagree on the mint's transfer fee authority", "S10", (c) => { const fee = withExt(c.reads.mint[0] as SolanaAccountRead, 1, feeBody(0n, 0)); mintB(c, (d) => { d[d.length - 108] = 1; }, fee); }],
  ["S10 the providers disagree on the mint's metadata pointer", "S10", (c) => mintB(c, (d) => { d[170] = (d[170] as number) ^ 1; })],
  ["S10 the providers disagree on the mint's last byte", "S10", (c) => mintB(c, (d) => { d[d.length - 1] = (d[d.length - 1] as number) ^ 1; })],
  ["S10 the providers disagree inside a 108-byte extension that is not the fee config", "S10", (c) => { const m = withExt(c.reads.mint[0] as SolanaAccountRead, 10, feeBody(5_000n, 0)); mintB(c, (d) => { setU64(d, d.length - 108 + 64, 6_000n); }, m); }],
  // a fee config shorter than its 108 bytes is not one: its bytes 64..72 are compared, never masked as withheld fees
  ["S10 the providers disagree inside a fee config shorter than 108 bytes", "S10", (c) => { const m = withExt(c.reads.mint[0] as SolanaAccountRead, 1, feeBody(5_000n, 0).slice(0, 100)); mintB(c, (d) => { setU64(d, d.length - 100 + 64, 6_000n); }, m); }],
  ["S10 provider B reads the mint one byte longer", "S10", (c) => { const a = c.reads.mint[0] as SolanaAccountRead; (c.reads as { mint: unknown }).mint = [a, { owner: a.owner, data: Uint8Array.from([...a.data, 0]) }]; }],
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
// Each mint disagreement above, refused by S10 alone, naming the first field that differs (the fixture's extensions:
// MetadataPointer 18 at 166, TokenMetadata 19 at 234, then the test's own at 394).
const MINT_FIELDS: Record<string, string> = {
  "S10 the providers disagree on the mint's freeze authority": "freeze authority",
  "S10 the providers disagree on the mint's mint authority": "mint authority",
  "S10 the providers disagree on the mint's decimals": "decimals",
  "S10 the providers disagree on the mint's supply and its freeze authority": "freeze authority",
  "S10 the providers disagree on the mint's transfer fee": "extension 1",
  "S10 the providers disagree on the mint's transfer fee authority": "extension 1",
  "S10 the providers disagree on the mint's metadata pointer": "extension 18",
  "S10 the providers disagree on the mint's last byte": "extension 19",
  "S10 the providers disagree inside a 108-byte extension that is not the fee config": "extension 10",
  "S10 the providers disagree inside a fee config shorter than 108 bytes": "extension 1",
  "S10 provider B reads the mint one byte longer": "length (394 / 395 bytes)",
};
test("refused: S10 each of its mint disagreements is refused as one, by S10 alone, naming the field", () => {
  const rows = R2.filter(([name]) => /^S10 (the providers disagree|provider B reads)/.test(name));
  assert.deepEqual(rows.map(([name]) => name).sort(), Object.keys(MINT_FIELDS).sort());
  for (const [name, , mutate] of rows) {
    const c = buyCase();
    mutate(c);
    const v = run(c);
    assert.deepEqual(v.results.filter((r) => !r.ok).map((r) => `${r.id} ${r.detail}`), [`S10 the providers disagree on the mint's ${MINT_FIELDS[name]}`], name);
  }
});
test("the real C5xph…pump pair a burn moved (fixtures/solana-mint-c5xph-burn.json): it agrees, and any other byte of it changed refuses", () => {
  const X = JSON.parse(readFileSync(new URL("./fixtures/solana-mint-c5xph-burn.json", import.meta.url), "utf8")) as { reads: [Acc & { slot: number }, Acc & { slot: number }] };
  const [a, b] = X.reads.map((r) => read({ ...r, lamports: 0 })) as [SolanaAccountRead, SolanaAccountRead];
  const supply = (m: SolanaAccountRead): bigint => new DataView(m.data.buffer, m.data.byteOffset).getBigUint64(36, true);
  assert.notEqual(supply(a), supply(b), "the burn moved the supply between the two slots");
  assert.equal(solanaMintDisagreement(a, b), null);
  for (let i = 0; i < b.data.length; i++) {
    if (i >= 36 && i < 44) continue; // the supply
    const d = b.data.slice();
    d[i] = (d[i] as number) ^ 1;
    assert.notEqual(solanaMintDisagreement(a, { owner: b.owner, data: d }), null, `byte ${i}`);
  }
});
test("refused: S10 a mint whose owner differs names both owners", () => {
  const c = buyCase();
  const a = c.reads.mint[0] as SolanaAccountRead;
  (c.reads as { mint: unknown }).mint = [a, { owner: TOKEN, data: a.data }];
  const v = run(c);
  assert.equal(v.results.find((r) => r.id === "S10")?.detail, `the providers disagree on the mint's owner program (${T22} / ${TOKEN})`);
});

test("accepted: a first PumpSwap buy from a fresh wallet that creates its PumpSwap volume account (rent 1,346,200)", () => {
  const c = buyCase();
  for (const s of c.reads.simulations) {
    const x = s as SolanaSimulation;
    x.pumpSwapVolumeAccumulator = { pre: 0n, post: 1_346_200n };
    x.walletLamports.post -= 1_346_200n;
  }
  const v = run(c);
  assert.ok(v.ok, JSON.stringify(v.results.filter((r) => !r.ok)));
});

test("accepted: S12 holds the simulated out to E(a_k) and minOut to E_k = floor(E(A) a_k / A) below it", () => {
  const c = buyCase();
  // E(a_k) above E_k, as a set's smaller leg prices on a convex curve; minOut_k stays on E_k's floor.
  (c.reads as { reference: unknown }).reference = { expectedOut: 51_111_993_061n, minOutBase: 50_000_000_000n, slippageBps: 950 };
  c.req.minOut = (50_000_000_000n * 9_050n) / 10_000n;
  setU64(jupData(c.m), 16, (c.req.minOut * 10_000n + 9_049n) / 9_050n);
  const v = run(c);
  assert.ok(v.ok, JSON.stringify(v.results.filter((r) => !r.ok)));
});

test("refused: S11 a sell that funds the PumpSwap volume account", () => {
  const c = sellCase();
  for (const s of c.reads.simulations) (s as SolanaSimulation).pumpSwapVolumeAccumulator = { pre: 0n, post: 1_346_200n };
  refusedBy("S11", run(c));
});

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

// The legs and the wallet's other accounts (card solana-legs-checked). route_v2 names 10 accounts, then the legs, which go
// into Jupiter's closed program with the wallet's signature; the solana-checks-shared-route review (2 Nov 06:50Z)
// found S6 read none of them and S11 read only the wallet's lamports and its account of the token. Each case rewrites the
// real buy or sell so a writable leg is a token account of the wallet's the device reads as such.
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// A token account of `owner`'s as a provider answers it: the 165-byte base (mint, owner, amount, state, is_native).
function held(owner: string, mint: string, program: string, amount: bigint, lamports = 2_039_280n, native = false): SolanaHeldRead {
  const d = new Uint8Array(165);
  d.set(base58.decode(mint), 0);
  d.set(base58.decode(owner), 32);
  setU64(d, 64, amount);
  d[108] = 1;
  if (native) { setU32(d, 109, 1); setU64(d, 113, 2_039_280n); }
  return { owner: program, lamports, data: d };
}
// A new writable, unsigned static key, put where the header keeps them (before the read-only unsigned ones); every
// index at or past it moves up one. Returns its index.
function addWritableKey(m: SolanaMessage, key: string): number {
  const at = m.staticKeys.length - m.readonlyUnsigned;
  for (const ix of m.instructions) {
    if (ix.programIndex >= at) ix.programIndex++;
    for (let j = 0; j < ix.accounts.length; j++) if ((ix.accounts[j] as number) >= at) ix.accounts[j] = (ix.accounts[j] as number) + 1;
  }
  m.staticKeys.splice(at, 0, key);
  return at;
}
// The real trade with its first writable leg past route_v2's 10 accounts (neither its source nor its destination)
// rewritten to `key`.
function legTo(c: ReturnType<typeof buyCase>, key: string): void {
  const j = progAt(c.m, JUP)[0] as number;
  const at = addWritableKey(c.m, key);
  const ix = c.m.instructions[j]!;
  const keys = solanaResolveKeys(c.m, Object.fromEntries(c.m.lookups.map((l) => [l.table, solanaDecodeLookupTable(c.reads.tables[l.table]![0]!.data)])));
  const pinned = [ix.accounts[1], ix.accounts[2]];
  const leg = ix.accounts.findIndex((a, k) => k >= 10 && keys[a]!.writable && !pinned.includes(a) && a !== at);
  assert.ok(leg >= 10, "a writable leg");
  ix.accounts[leg] = at;
}
const s6 = (v: ReturnType<typeof checkSolanaQuote>) => v.results.find((r) => r.id === "S6")!;
const s11 = (v: ReturnType<typeof checkSolanaQuote>) => v.results.find((r) => r.id === "S11")!;

for (const [side, make] of [["buy", buyCase], ["sell", sellCase]] as const) {
  test(`S6 legs, route_v2 ${side}: a leg rewritten to a token account of the wallet's is refused (an associated one, a non-associated Token-2022 one read so by provider B alone)`, () => {
    assert.equal(s6(run(make())).ok, true, "the unchanged trade passes S6");
    const ata = solanaAta(W, USDC, TOKEN);
    const odd = randomKey();
    for (const [key, pair] of [[ata, [held(W, USDC, TOKEN, 7n), held(W, USDC, TOKEN, 7n)]], [odd, [null, held(W, USDC, T22, 7n)]]] as const) {
      const c = make();
      legTo(c, key);
      c.reads.writable = { [key]: pair };
      const got = s6(run(c));
      assert.equal(got.ok, false, `S6 passed: ${got.detail}`);
      assert.ok(got.detail.includes(`leg account ${key} is a token account of the wallet's`), got.detail);
    }
  });
}

test("S11: a writable token account of the wallet's is held to its read before: moved or not read back is refused, unmoved passes", () => {
  const ata = solanaAta(W, USDC, TOKEN);
  const before = held(W, USDC, TOKEN, 7_000_000n);
  const at = (after: SolanaHeldRead | null | undefined) => {
    const c = buyCase();
    legTo(c, ata);
    c.reads.writable = { [ata]: [before, before] };
    for (const s of c.reads.simulations) { const x = s as SolanaSimulation; x.walletAccounts = after === undefined ? { ...x.walletAccounts } : { ...x.walletAccounts, [ata]: after }; }
    return s11(run(c));
  };
  assert.equal(at(held(W, USDC, TOKEN, 7_000_000n)).ok, true, "unmoved");
  const drained = at(held(W, USDC, TOKEN, 0n));
  assert.equal(drained.ok, false);
  assert.match(drained.detail, new RegExp(`provider A: the wallet's account ${ata} moves: 7000000 -> 0`));
  assert.match(at(null).detail, new RegExp(`the wallet's account ${ata} moves: 7000000 -> not the wallet's`));
  assert.match(at(held(randomKey(), USDC, TOKEN, 7_000_000n)).detail, /moves: 7000000 -> not the wallet's/);
  assert.match(at(undefined).detail, new RegExp(`the wallet's account ${ata} is not read back`));
  // the providers disagree on it: refused before any simulation
  const c = buyCase();
  legTo(c, ata);
  c.reads.writable = { [ata]: [before, held(W, USDC, TOKEN, 6_999_999n)] };
  assert.match(s11(run(c)).detail, new RegExp(`the providers disagree on the wallet's account ${ata}`));
});

// A wSOL account the wallet already holds, which the trade writes (the buy's source, the sell's destination): its
// lamports count with the wallet's, so what it held is never read as the trade's.
const WSOL_ATA = solanaAta(W, "So11111111111111111111111111111111111111112", TOKEN);
const X = 50_000_000n; // the wSOL it held, 0.05 SOL
const wsolHeld = held(W, "So11111111111111111111111111111111111111112", TOKEN, X, X + 2_039_280n, true);
test("S11 wSOL: the buy's wSOL account held 0.05 SOL; closed back into the wallet passes, closed anywhere else is refused", () => {
  const ok = buyCase();
  ok.reads.writable = { [WSOL_ATA]: [wsolHeld, wsolHeld] };
  for (const s of ok.reads.simulations) { const x = s as SolanaSimulation; x.walletAccounts = { ...x.walletAccounts, [WSOL_ATA]: null }; x.walletLamports.post += X + 2_039_280n; }
  assert.equal(s11(run(ok)).ok, true, s11(run(ok)).detail);
  const gone = buyCase();
  gone.reads.writable = { [WSOL_ATA]: [wsolHeld, wsolHeld] };
  for (const s of gone.reads.simulations) { const x = s as SolanaSimulation; x.walletAccounts = { ...x.walletAccounts, [WSOL_ATA]: null }; }
  const v = s11(run(gone));
  assert.equal(v.ok, false);
  assert.match(v.detail, /provider A: native out \d+ > \d+/);
});
test("S11 wSOL: a sell whose own out is under minOut is refused though the wallet's wSOL account it closes held 0.05 SOL", () => {
  const c = sellCase();
  // the wallet's lamports after: its own native in (before fees and tips) one lamport under minOut, plus the 0.05 SOL
  // and the rent the close of its wSOL account returned
  const base = run(c).results.find((r) => r.id === "S11")!.detail.match(/fees (\d+), tips (\d+)/)!;
  const ft = BigInt(base[1]!) + BigInt(base[2]!);
  for (const s of c.reads.simulations) {
    const x = s as SolanaSimulation;
    x.walletLamports.post = x.walletLamports.pre + c.req.minOut - 1n - ft + X + 2_039_280n;
    x.walletAccounts = { ...x.walletAccounts, [WSOL_ATA]: null };
  }
  c.reads.writable = { [WSOL_ATA]: [wsolHeld, wsolHeld] };
  const v = s11(run(c));
  assert.equal(v.ok, false, v.detail);
  assert.match(v.detail, new RegExp(`provider A: native in ${c.req.minOut - 1n} < minOut ${c.req.minOut}`));
});

// Card solana-written-accounts-whole. The solana-legs-checked review (7 Nov 06:35Z) found S11 held a written account of
// the wallet's to its amount, lamports and owner field only, and the providers to agree on lamports and amount only: a
// route could leave a stranger as the delegate or close authority of the wallet's held wSOL account and pass S11 and S6.
// S11 now holds every byte of the 165-byte base: all but the amount on a wSOL account, all on any other, the providers
// agreeing on all of it; and the wallet's account of the token keeps its base or, created, a clean one.
const copyHeld = (a: SolanaHeldRead): SolanaHeldRead => ({ owner: a.owner, lamports: a.lamports, data: Uint8Array.from(a.data) });
// The account with a stranger as its delegate for all of it, and as its close authority.
const hostile = (a: SolanaHeldRead): SolanaHeldRead => {
  const x = copyHeld(a);
  setU32(x.data, 72, 1); x.data.set(base58.decode(randomKey()), 76); x.data.set(x.data.subarray(64, 72), 121);
  setU32(x.data, 129, 1); x.data.set(base58.decode(randomKey()), 133);
  return x;
};
// A Token-2022 account as the chain holds it: the base, the account type byte (2) and ImmutableOwner (type 7, length 0);
// 170 bytes, the size the associated token program gives the account of the recorded token (its mint's extensions add
// none), which S11 holds the account a buy creates to.
function wide(a: SolanaHeldRead): SolanaHeldRead {
  const d = new Uint8Array(170);
  d.set(a.data.subarray(0, 165));
  d[165] = 2;
  setU16(d, 166, 7);
  return { owner: T22, lamports: a.lamports, data: d };
}
// S11 on the buy whose route writes the wallet's USDC account (a leg, so S6 refuses it too; S11 is read alone here),
// read `pair` before and `after` after on both providers.
const writtenUsdc = (pair: readonly [SolanaHeldRead, SolanaHeldRead], after: SolanaHeldRead | null) => {
  const ata = solanaAta(W, USDC, pair[0].owner);
  const c = buyCase();
  legTo(c, ata);
  c.reads.writable = { [ata]: pair };
  for (const s of c.reads.simulations) { const x = s as SolanaSimulation; x.walletAccounts = { ...x.walletAccounts, [ata]: after }; }
  return { ata, v: s11(run(c)) };
};
test("S11 whole base: an account of the wallet's the route leaves with a stranger as delegate and close authority is refused, naming both", () => {
  const before = held(W, USDC, TOKEN, 7_000_000n);
  const { ata, v } = writtenUsdc([before, before], hostile(before));
  assert.equal(v.ok, false, v.detail);
  assert.match(v.detail, new RegExp(`provider A: the wallet's account ${ata} moves: 7000000 -> 7000000, lamports 2039280 -> 2039280, its delegate, delegated_amount, close authority changed`));
});
test("S11 whole base: the buy's held wSOL source left open with a stranger as delegate and close authority is refused, by S11", () => {
  const c = buyCase();
  c.reads.writable = { [WSOL_ATA]: [wsolHeld, wsolHeld] };
  for (const s of c.reads.simulations) { const x = s as SolanaSimulation; x.walletAccounts = { ...x.walletAccounts, [WSOL_ATA]: hostile(wsolHeld) }; }
  const v = s11(run(c));
  assert.equal(v.ok, false, v.detail);
  assert.match(v.detail, new RegExp(`provider A: the wallet's wSOL account ${WSOL_ATA} is left with its delegate, delegated_amount, close authority changed`));
  // its amount and lamports alone may move: synced to 0.04 SOL with the 0.01 SOL that left counted as native out, it passes
  const ok = buyCase();
  ok.reads.writable = { [WSOL_ATA]: [wsolHeld, wsolHeld] };
  const less = copyHeld(wsolHeld);
  less.lamports -= 10_000_000n;
  setU64(less.data, 64, X - 10_000_000n);
  for (const s of ok.reads.simulations) { const x = s as SolanaSimulation; x.walletAccounts = { ...x.walletAccounts, [WSOL_ATA]: less }; x.walletLamports.post += 10_000_000n; }
  assert.equal(s11(run(ok)).ok, true, s11(run(ok)).detail);
});
test("S11 whole base: a wSOL account handed to another owner with its lamports kept is refused (no longer the wallet's never counts)", () => {
  const c = buyCase();
  c.reads.writable = { [WSOL_ATA]: [wsolHeld, wsolHeld] };
  const theirs = copyHeld(wsolHeld);
  theirs.data.set(base58.decode(randomKey()), 32);
  for (const s of c.reads.simulations) { const x = s as SolanaSimulation; x.walletAccounts = { ...x.walletAccounts, [WSOL_ATA]: theirs }; x.walletLamports.post += X + 2_039_280n; }
  const v = s11(run(c));
  assert.equal(v.ok, false, v.detail);
  assert.match(v.detail, new RegExp(`the wallet's wSOL account ${WSOL_ATA} is left with its owner changed`));
});
test("S11 whole base: an account of the wallet's whose lamports alone change is refused", () => {
  const before = held(W, USDC, TOKEN, 7_000_000n);
  const after = copyHeld(before);
  after.lamports += 1n;
  const { ata, v } = writtenUsdc([before, before], after);
  assert.equal(v.ok, false, v.detail);
  assert.match(v.detail, new RegExp(`the wallet's account ${ata} moves: 7000000 -> 7000000, lamports 2039280 -> 2039281$|the wallet's account ${ata} moves: 7000000 -> 7000000, lamports 2039280 -> 2039281;`));
});
test("S11 whole base: the providers disagreeing on an account of the wallet's in its lamports alone, or its delegate alone, is refused", () => {
  const before = held(W, USDC, TOKEN, 7_000_000n);
  const richer = copyHeld(before);
  richer.lamports += 1n;
  const delegated = copyHeld(before);
  setU32(delegated.data, 72, 1); delegated.data.set(base58.decode(randomKey()), 76);
  for (const b of [richer, delegated]) {
    const { ata, v } = writtenUsdc([before, b], before);
    assert.equal(v.ok, false, v.detail);
    assert.equal(v.detail, `the providers disagree on the wallet's account ${ata}`);
  }
});
test("S11 whole base: a Token-2022 account of the wallet's at its real size (170 bytes) is held too, as a leg by S6 and moved by S11", () => {
  const before = wide(held(W, USDC, T22, 7_000_000n));
  const drained = copyHeld(before);
  setU64(drained.data, 64, 0n);
  const { ata, v } = writtenUsdc([before, before], drained);
  assert.equal(v.ok, false, v.detail);
  assert.match(v.detail, new RegExp(`the wallet's account ${ata} moves: 7000000 -> 0`));
  const odd = randomKey();
  const c = buyCase();
  legTo(c, odd);
  c.reads.writable = { [odd]: [null, before] };
  const got = s6(run(c));
  assert.equal(got.ok, false, got.detail);
  assert.ok(got.detail.includes(`leg account ${odd} is a token account of the wallet's`), got.detail);
});
test("S11 whole base: the wallet's account of the token after the buy (created) or the sell (kept) with a stranger as delegate or close authority is refused", () => {
  for (const make of [buyCase, sellCase]) {
    const c = make();
    for (const s of c.reads.simulations) { const x = s as SolanaSimulation; x.walletAccounts = { ...x.walletAccounts, [OWN]: hostile(x.walletAccounts[OWN] as SolanaHeldRead) }; }
    const v = s11(run(c));
    assert.equal(v.ok, false, `${c.req.side}: ${v.detail}`);
    assert.match(v.detail, new RegExp(`provider A: the wallet's account of the token ${OWN} is left with its delegate, (delegated_amount, )?close authority changed`)); // the sold-out account delegates 0
    // frozen, or another owner's: refused too; not read back: refused
    const frozen = make();
    for (const s of frozen.reads.simulations) { const x = s as SolanaSimulation; const a = copyHeld(x.walletAccounts[OWN] as SolanaHeldRead); a.data[108] = 2; x.walletAccounts = { ...x.walletAccounts, [OWN]: a }; }
    assert.match(s11(run(frozen)).detail, /of the token \S+ is left with its state changed/);
    const unread = make();
    for (const s of unread.reads.simulations) { const x = s as SolanaSimulation; const { [OWN]: _, ...rest } = x.walletAccounts; x.walletAccounts = rest; }
    assert.match(s11(run(unread)).detail, new RegExp(`the wallet's account ${OWN} is not read back`));
  }
  // a sell that closes it, its rent back to the wallet: nothing left to hold
  const closed = sellCase();
  for (const s of closed.reads.simulations) { const x = s as SolanaSimulation; x.walletAccounts = { ...x.walletAccounts, [OWN]: null }; x.walletLamports.post += 1_513_840n; }
  assert.equal(s11(run(closed)).ok, true, s11(run(closed)).detail);
});
// The legs from the first one (card solana-written-accounts-whole: S6 scans every account the route names, no offset).
test("S6 legs: the wallet's account at route_v2's first leg (index 10) is refused", () => {
  for (const make of [buyCase, sellCase]) {
    const c = make();
    const ata = solanaAta(W, USDC, TOKEN);
    const at = addWritableKey(c.m, ata);
    c.m.instructions[progAt(c.m, JUP)[0] as number]!.accounts[10] = at;
    c.reads.writable = { [ata]: [held(W, USDC, TOKEN, 7n), held(W, USDC, TOKEN, 7n)] };
    const got = s6(run(c));
    assert.equal(got.ok, false, got.detail);
    assert.ok(got.detail.includes(`leg account ${ata} is a token account of the wallet's`), got.detail);
  }
});
// A closed account as a simulation reads it back: the system program's, 0 lamports, no data (found on a real dry buy
// from a wallet holding wSOL, 7 Nov: Jupiter's route closes the held wSOL account after the swap). The runtime removes
// it when the tx ends, so it is closed, not handed to another owner.
const CLOSED: SolanaHeldRead = { owner: SYSTEM, lamports: 0n, data: new Uint8Array(0) };
test("S11 whole base: a wSOL account or the account of the token read back closed (system's, 0 lamports) counts as closed", () => {
  const ok = buyCase();
  ok.reads.writable = { [WSOL_ATA]: [wsolHeld, wsolHeld] };
  for (const s of ok.reads.simulations) { const x = s as SolanaSimulation; x.walletAccounts = { ...x.walletAccounts, [WSOL_ATA]: CLOSED }; x.walletLamports.post += X + 2_039_280n; }
  assert.equal(s11(run(ok)).ok, true, s11(run(ok)).detail);
  // closed with its lamports sent elsewhere: the native sum refuses it
  const gone = buyCase();
  gone.reads.writable = { [WSOL_ATA]: [wsolHeld, wsolHeld] };
  for (const s of gone.reads.simulations) { const x = s as SolanaSimulation; x.walletAccounts = { ...x.walletAccounts, [WSOL_ATA]: CLOSED }; }
  assert.match(s11(run(gone)).detail, /provider A: native out \d+ > \d+/);
  const sold = sellCase();
  for (const s of sold.reads.simulations) { const x = s as SolanaSimulation; x.walletAccounts = { ...x.walletAccounts, [OWN]: CLOSED }; x.walletLamports.post += 1_513_840n; }
  assert.equal(s11(run(sold)).ok, true, s11(run(sold)).detail);
  // an account of the wallet's other than wSOL or the token's, closed: refused, as any change to it
  const before = held(W, USDC, TOKEN, 0n);
  const { ata, v } = writtenUsdc([before, before], CLOSED);
  assert.match(v.detail, new RegExp(`the wallet's account ${ata} moves: 0 -> not the wallet's, lamports 2039280 -> 0`));
});

// Card solana-written-accounts-whole, the independent review of 0d2d8dc1 (7 Nov): its probes, each now a test that kills
// the mutant it names (review-mut.mjs) or fails on the code the review read.
const setOwn = (c: ReturnType<typeof buyCase>, f: (a: SolanaHeldRead) => SolanaHeldRead | null): void => {
  for (const s of c.reads.simulations) { const x = s as SolanaSimulation; x.walletAccounts = { ...x.walletAccounts, [OWN]: f(x.walletAccounts[OWN] as SolanaHeldRead) }; }
};
// T22's SetAuthority(AccountOwner) moves the owner field; the account keeps its lamports (mutant N6 took it as closed).
test("S11 review PROBE-2: the wallet's account of the token handed to another owner, its lamports kept, is refused on a buy and a sell", () => {
  for (const make of [buyCase, sellCase]) {
    const c = make();
    setOwn(c, (a) => { const x = copyHeld(a); x.data.set(base58.decode(randomKey()), 32); return x; });
    const v = s11(run(c));
    assert.equal(v.ok, false, `${c.req.side}: ${v.detail}`);
    assert.match(v.detail, new RegExp(`provider A: the wallet's account of the token ${OWN} is left with its owner changed`));
  }
});
// Provider A reads a stranger as its delegate and close authority, provider B a clean account: no baseline is taken from
// A alone (mutant N4b), so the account after is held to a clean base and the delegate A claimed is refused.
test("S11 review PROBE-5: the providers disagree on the wallet's account of the token; a delegate only provider A read before, left after, is refused", () => {
  for (const make of [buyCase, sellCase]) {
    const c = make();
    const clean = wide(held(W, F.mint, T22, c.req.side === "buy" ? 0n : buyToken, 1_513_840n));
    const lied = hostile(clean);
    c.reads.writable = { ...c.reads.writable, [OWN]: [lied, clean] };
    setOwn(c, (a) => { const x = copyHeld(lied); x.data.set(a.data.subarray(64, 72), 64); x.data.set(a.data.subarray(64, 72), 121); return x; });
    const v = s11(run(c));
    assert.equal(v.ok, false, `${c.req.side}: ${v.detail}`);
    assert.match(v.detail, new RegExp(`the wallet's account of the token ${OWN} is left with its delegate, (delegated_amount, )?close authority changed`)); // the sold-out account delegates 0
  }
});
// A sell that closes the account of the token: its rent is the wallet's (review PROBE-1 found it could go anywhere).
test("S11 review PROBE-1: a sell that closes the account of the token counts its rent: back to the wallet passes, to anyone else is refused", () => {
  for (const gone of [null, CLOSED]) {
    const home = sellCase();
    setOwn(home, () => gone);
    for (const s of home.reads.simulations) (s as SolanaSimulation).walletLamports.post += 1_513_840n;
    assert.equal(s11(run(home)).ok, true, s11(run(home)).detail);
    const away = sellCase();
    setOwn(away, () => gone);
    const v = s11(run(away));
    assert.equal(v.ok, false, v.detail);
    assert.match(v.detail, /provider A: native in \d+ < minOut 8738870/);
  }
  // the providers disagree on it before (B has not seen it) and the tx closes it: whose rent it held is unknown, refused
  const split = sellCase();
  split.reads.writable = { ...split.reads.writable, [OWN]: [split.reads.writable[OWN]![0], null] };
  setOwn(split, () => null);
  for (const s of split.reads.simulations) (s as SolanaSimulation).walletLamports.post += 1_513_840n;
  assert.match(s11(run(split)).detail, new RegExp(`the providers disagree on the wallet's account of the token ${OWN}, which the tx closes`));
});
// Token-2022's Reallocate (owner-signed) grows an account for an extension such as a required memo or a CPI guard; S11
// held 165 bytes only (review PROBE-3). An account of the wallet's keeps its size; the one a buy creates gets the size
// the associated token program gives it; the providers agree on every byte.
test("S11 review PROBE-3: a Token-2022 account of the wallet's grown past its size (MemoTransfer after a Reallocate) is refused, the providers agree on its extensions", () => {
  const grow = (a: SolanaHeldRead): SolanaHeldRead => { const d = new Uint8Array(a.data.length + 5); d.set(a.data); setU16(d, a.data.length, 8); setU16(d, a.data.length + 2, 1); d[a.data.length + 4] = 1; return { owner: a.owner, lamports: a.lamports, data: d }; };
  for (const make of [buyCase, sellCase]) {
    const c = make();
    setOwn(c, grow);
    const v = s11(run(c));
    assert.equal(v.ok, false, `${c.req.side}: ${v.detail}`);
    assert.match(v.detail, new RegExp(`the wallet's account of the token ${OWN} is left with its size changed`));
  }
  const before = wide(held(W, USDC, T22, 7_000_000n));
  const { ata, v } = writtenUsdc([before, before], grow(before));
  assert.equal(v.ok, false, v.detail);
  assert.match(v.detail, new RegExp(`the wallet's account ${ata} moves: 7000000 -> 7000000, lamports 2039280 -> 2039280, its size changed`));
  const memo = grow(before);
  const off = copyHeld(memo);
  off.data[off.data.length - 1] = 0;
  assert.equal(writtenUsdc([memo, off], memo).v.detail, `the providers disagree on the wallet's account ${ata}`);
});
