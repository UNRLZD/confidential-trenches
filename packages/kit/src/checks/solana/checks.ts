// The device's checks on a Solana swap before it signs (markets paper T2.2, S1-S13). Pure functions over: the user's
// own request, the wire bytes the device is about to sign, and the device's own reads (lookup tables and mint on two
// providers, the simulation on two providers, the reference pool's expected out). No field of the quote or the route
// JSON is read: only the signed bytes. Any refusal means nothing is signed.
//
// The two-provider reads themselves (who asks which provider, the re-read, the session cache of agreed table entries,
// the reference pool finder) are the buy flow's; these checks take their answers and refuse when the answers disagree
// or are missing.
import { base58 } from "@scure/base";
import {
  SOLANA_ALT_PROGRAM,
  SOLANA_ATA_PROGRAM,
  SOLANA_MAX_TX_BYTES,
  solanaAta,
  solanaDecodeLookupTable,
  solanaDecodeTransaction,
  solanaProgramAddress,
  solanaResolveKeys,
  solanaTableIsActive,
  type SolanaAccountKey,
  type SolanaLookupTable,
  type SolanaTransaction,
} from "./message.ts";

export const SOLANA_SOL_MINT = "So11111111111111111111111111111111111111112";
export const SOLANA_SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const SOLANA_COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const SOLANA_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOLANA_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SOLANA_JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const SOLANA_PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
// S3: the only top-level programs (06c §3.3 item 2).
export const SOLANA_ALLOWED_PROGRAMS: readonly string[] = [
  SOLANA_SYSTEM_PROGRAM,
  SOLANA_COMPUTE_BUDGET_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  SOLANA_TOKEN_2022_PROGRAM,
  SOLANA_ATA_PROGRAM,
  SOLANA_JUPITER_PROGRAM,
];
// S5: the baked tip accounts and amounts (research proofs/p4-speed/solana/run.mjs:68-84: Helius Sender's list read
// 2026-10-19 from helius.dev/docs/sending-transactions/sender; Jito's getTipAccounts list read 2026-10-19).
export const SOLANA_SENDER_TIP_ACCOUNTS: readonly string[] = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE", "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta", "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD", "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF", "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey", "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
];
export const SOLANA_JITO_TIP_ACCOUNTS: readonly string[] = [
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt", "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];
export const SOLANA_SENDER_TIP = 5_000n;
export const SOLANA_JITO_TIP = 10_000n;
// S8 (P4S "Slippage and priority"; run.mjs:85-91).
export const SOLANA_CU_PRICE_MAX = 1_000_000n;
export const SOLANA_CU_LIMIT = { pumpBuy: 200_000, pumpSell: 150_000, other: 600_000 } as const;
export const SOLANA_LAMPORTS_PER_SIGNATURE = 5_000n;

// Jupiter v6 route_v2 (the on-chain IDL of JUP6…TaV4, account C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa, read
// 2026-10-25 22:06:06Z slot 461420570; research proofs/g1-phone-trade/src/checks.js:7-15): discriminator, in_amount u64,
// quoted_out_amount u64, slippage_bps u16, platform_fee_bps u16, positive_slippage_bps u16, route_plan Vec<step>;
// accounts: authority (signer), user source, user destination, source mint, destination mint, source token program,
// destination token program, destination_token_account (optional: the program id when absent), event authority, program.
const ROUTE_V2 = [187, 100, 250, 204, 49, 196, 175, 20];
// The pump.fun bonding-curve step variants of the Swap enum (same IDL; checks.js:58-64), for S8's cap only.
const PUMP_BUY_STEPS = new Set([49, 90, 97, 112, 149, 152, 187, 191]);
const PUMP_SELL_STEPS = new Set([50, 91, 98, 113, 150, 153, 192]);
// Token-2022 ExtensionType (solana-program/token-2022 @ 3f85f9c interface/src/extension/mod.rs:1074-1139, read
// 2026-11-01 01:52Z): ConfidentialTransferMint 4, NonTransferable 9, TransferHook 14, ConfidentialTransferFeeConfig 16,
// ConfidentialMintBurn 24.
const EXT_CONFIDENTIAL = new Set([4, 16, 24]);
const EXT_NON_TRANSFERABLE = 9;
const EXT_TRANSFER_HOOK = 14;

export type SolanaQuoteRequest = {
  side: "buy" | "sell";
  wallet: string; // W_k: the fresh wallet that signs and pays
  token: string; // the token the user tapped
  amount: bigint; // a_k: lamports on a buy, the token's base units on a sell
  spendable: bigint; // W_k's spendable lamports on a buy, its token balance on a sell
  minOut: bigint; // minOut_k (§1.3): token base units on a buy, lamports on a sell
};
export type SolanaAccountRead = { owner: string; data: Uint8Array };
// One provider's simulation of the whole tx at `confirmed` with sigVerify off, as the device read it.
export type SolanaSimulation = {
  err: unknown; // null when the simulation ran clean
  walletLamports: { pre: bigint; post: bigint };
  tokenAccount: { pre: bigint; post: bigint }; // W_k's account of the token: the output on a buy, the input on a sell
  pumpVolumeAccumulator: { pre: bigint; post: bigint }; // W_k's own pump PDA, which a pump buy may fund
  otherWallets: { pre: bigint; post: bigint }[]; // every other wallet of this user, lamports
};
export type SolanaQuoteReads = {
  tables: Readonly<Record<string, readonly [SolanaAccountRead | null, SolanaAccountRead | null]>>; // provider A, B
  mint: readonly [SolanaAccountRead | null, SolanaAccountRead | null];
  // Rent-exempt minimums read from RPC for the sizes in play: the output token account and the pump volume accumulator.
  rent: { tokenAccount: bigint; pumpVolumeAccumulator: bigint };
  simulations: readonly [SolanaSimulation | null, SolanaSimulation | null];
  // E for this wallet's exact input from the reference pool (S12), its tolerance and the user's slippage s.
  reference: { expectedOut: bigint; tolBps: number; slippageBps: number } | null;
};
export type SolanaQuoteCheckId = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8" | "S9" | "S10" | "S11" | "S12" | "S13" | "DECODE";
export type SolanaQuoteResult = { id: SolanaQuoteCheckId; ok: boolean; detail: string };
export type SolanaQuoteVerdict = { ok: boolean; results: SolanaQuoteResult[] };

type Ix = { index: number; program: string; accounts: SolanaAccountKey[]; data: Uint8Array };
type Route = {
  inAmount: bigint;
  quotedOut: bigint;
  slippageBps: number;
  platformFeeBps: number;
  positiveSlippageBps: number;
  steps: number;
  firstStep: number | undefined;
  a: SolanaAccountKey[];
};
type Ctx = {
  req: SolanaQuoteRequest;
  reads: SolanaQuoteReads;
  tx: SolanaTransaction;
  ixs: Ix[];
  tokenProgram: string | null;
  route: Route | null;
  routeError: string | null;
  jupAt: number;
};

const pass = (id: SolanaQuoteCheckId, detail: string): SolanaQuoteResult => ({ id, ok: true, detail });
const fail = (id: SolanaQuoteCheckId, detail: string): SolanaQuoteResult => ({ id, ok: false, detail });
const u16 = (d: Uint8Array, o: number): number => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(o, true);
const u32 = (d: Uint8Array, o: number): number => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);
const u64 = (d: Uint8Array, o: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
const eqBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const hex = (d: Uint8Array): string => Array.from(d.subarray(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
const isToken = (p: string | null): p is string => p === SOLANA_TOKEN_PROGRAM || p === SOLANA_TOKEN_2022_PROGRAM;
const JUP_EVENT_AUTHORITY = solanaProgramAddress([new TextEncoder().encode("__event_authority")], SOLANA_JUPITER_PROGRAM);
// W_k's own pump.fun volume account (seeds "user_volume_accumulator", W_k; research proofs/g1-phone-trade/src/pool.js:24).
// A pump buy from a fresh wallet funds it with W_k's lamports (137 bytes, 1,346,200 lamports in buy 2btTg7…), so S11's
// bound counts it, up to its rent. The buy flow simulates this address to fill SolanaSimulation.pumpVolumeAccumulator.
export const solanaPumpVolumeAccumulator = (wallet: string): string =>
  solanaProgramAddress([new TextEncoder().encode("user_volume_accumulator"), base58.decode(wallet)], SOLANA_PUMP_PROGRAM);

function decodeRoute(ix: Ix): Route {
  const d = ix.data;
  if (d.length < 34 || !eqBytes(d.subarray(0, 8), Uint8Array.from(ROUTE_V2))) throw new Error(`Jupiter instruction ${hex(d)} is not route_v2`);
  if (ix.accounts.length < 10) throw new Error(`route_v2 with ${ix.accounts.length} accounts`);
  const steps = u32(d, 30);
  return {
    inAmount: u64(d, 8),
    quotedOut: u64(d, 16),
    slippageBps: u16(d, 24),
    platformFeeBps: u16(d, 26),
    positiveSlippageBps: u16(d, 28),
    steps,
    firstStep: d[34],
    a: ix.accounts,
  };
}

// The sides of the swap from the request alone: what goes in and out, under which token program.
function sides(c: Ctx): { inMint: string; outMint: string; inTp: string | null; outTp: string | null } {
  const tp = c.tokenProgram;
  return c.req.side === "buy"
    ? { inMint: SOLANA_SOL_MINT, outMint: c.req.token, inTp: SOLANA_TOKEN_PROGRAM, outTp: tp }
    : { inMint: c.req.token, outMint: SOLANA_SOL_MINT, inTp: tp, outTp: SOLANA_TOKEN_PROGRAM };
}

function needRoute(id: SolanaQuoteCheckId, c: Ctx): SolanaQuoteResult | null {
  return c.route ? null : fail(id, c.routeError ?? "no route");
}

// S1: the route instruction swaps exactly what the user asked for, from W_k.
function s1(c: Ctx): SolanaQuoteResult {
  const e = needRoute("S1", c);
  if (e) return e;
  const r = c.route as Route;
  const { req } = c;
  const { inMint, outMint, inTp } = sides(c);
  const wrong: string[] = [];
  if (req.amount <= 0n || req.amount > req.spendable) wrong.push(`amount ${req.amount} is not within the spendable ${req.spendable}`);
  if (r.a[0]?.key !== req.wallet || !r.a[0]?.signer) wrong.push(`route authority ${r.a[0]?.key} is not the signing wallet`);
  if (r.a[3]?.key !== inMint) wrong.push(`input mint ${r.a[3]?.key} != ${inMint}`);
  if (r.a[4]?.key !== outMint) wrong.push(`output mint ${r.a[4]?.key} != ${outMint}`);
  if (r.inAmount !== req.amount) wrong.push(`in amount ${r.inAmount} != ${req.amount}`);
  if (!isToken(inTp) || r.a[5]?.key !== inTp) wrong.push(`source token program ${r.a[5]?.key} != ${inTp}`);
  else if (r.a[1]?.key !== solanaAta(req.wallet, inMint, inTp)) wrong.push(`source account ${r.a[1]?.key} is not the wallet's own`);
  if (r.a[8]?.key !== JUP_EVENT_AUTHORITY || r.a[9]?.key !== SOLANA_JUPITER_PROGRAM) wrong.push("route event authority or program account changed");
  return wrong.length ? fail("S1", wrong.join("; ")) : pass("S1", `${req.side} ${r.inAmount} of ${inMint} for ${outMint}, authority the wallet`);
}

// S2: every lookup table the message uses: owned by the table program, active, and the same bytes at every used index
// on both providers. One provider's word never decides an address the device signs for.
function s2(c: Ctx): SolanaQuoteResult {
  const wrong: string[] = [];
  for (const l of c.tx.message.lookups) {
    const pair = Object.hasOwn(c.reads.tables, l.table) ? c.reads.tables[l.table] : undefined;
    const used = [...l.writable, ...l.readonly];
    const states: SolanaLookupTable[] = [];
    for (const [p, acc] of (pair ?? [null, null]).entries()) {
      if (!acc) { wrong.push(`table ${l.table} not read on provider ${p === 0 ? "A" : "B"}`); continue; }
      if (acc.owner !== SOLANA_ALT_PROGRAM) { wrong.push(`table ${l.table} owned by ${acc.owner}`); continue; }
      try {
        const t = solanaDecodeLookupTable(acc.data);
        if (!solanaTableIsActive(t)) wrong.push(`table ${l.table} is deactivated on provider ${p === 0 ? "A" : "B"}`);
        states.push(t);
      } catch (err) {
        wrong.push(`table ${l.table}: ${(err as Error).message}`);
      }
    }
    const [a, b] = states;
    if (!a || !b) continue;
    const off = used.filter((i) => a.addresses[i] === undefined || a.addresses[i] !== b.addresses[i]);
    if (off.length) wrong.push(`table ${l.table}: the providers disagree or have no entry at index ${[...new Set(off)].join(",")}`);
  }
  return wrong.length ? fail("S2", wrong.join("; ")) : pass("S2", `${c.tx.message.lookups.length} table(s), equal on both providers at every used index`);
}

// S3: every top-level program is on the allowlist.
function s3(c: Ctx): SolanaQuoteResult {
  const off = c.ixs.filter((ix) => !SOLANA_ALLOWED_PROGRAMS.includes(ix.program)).map((ix) => `ix ${ix.index}: program ${ix.program}`);
  return off.length ? fail("S3", off.join("; ")) : pass("S3", `${c.ixs.length} instructions, all on the allowlist`);
}

// S4: one signer, W_k, which is also the fee payer.
function s4(c: Ctx): SolanaQuoteResult {
  const m = c.tx.message;
  if (m.requiredSignatures !== 1 || m.staticKeys[0] !== c.req.wallet) return fail("S4", `signers ${m.staticKeys.slice(0, m.requiredSignatures).join(",")} (want only the wallet)`);
  if (m.readonlySigned !== 0) return fail("S4", "the fee payer is read-only");
  return pass("S4", "one signer: the wallet, which pays the fee");
}

type Walk = { wrong: string[]; created: Map<string, { mint: string; tp: string }>; closed: Map<string, number> };

// One walk over every instruction outside the route and the budget: S5 (System), S13 (creates and closes) and the
// token instructions. Any instruction the walk does not know is refused.
function walk(c: Ctx): Walk {
  const { req } = c;
  const w = req.wallet;
  const wsol = solanaAta(w, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM);
  const out: Walk = { wrong: [], created: new Map(), closed: new Map() };
  const seen = { wrap: 0, sender: 0, jito: 0 };
  for (const [k, ix] of c.ixs.entries()) {
    const a = ix.accounts.map((x) => x.key);
    const d = ix.data;
    const at = `ix ${ix.index}`;
    if (ix.program === SOLANA_COMPUTE_BUDGET_PROGRAM || ix.program === SOLANA_JUPITER_PROGRAM) continue;
    if (ix.program === SOLANA_SYSTEM_PROGRAM) {
      if (d.length !== 12 || u32(d, 0) !== 2 || a.length !== 2) { out.wrong.push(`S5 ${at}: a System instruction other than a transfer`); continue; }
      const lamports = u64(d, 4);
      if (a[0] !== w) { out.wrong.push(`S5 ${at}: transfer from ${a[0]}`); continue; }
      if (req.side === "buy" && a[1] === wsol && lamports === req.amount && k < c.jupAt) { seen.wrap++; continue; }
      if (SOLANA_SENDER_TIP_ACCOUNTS.includes(a[1] as string) && lamports === SOLANA_SENDER_TIP) { seen.sender++; continue; }
      if (SOLANA_JITO_TIP_ACCOUNTS.includes(a[1] as string) && lamports === SOLANA_JITO_TIP) { seen.jito++; continue; }
      out.wrong.push(`S5 ${at}: transfer of ${lamports} lamports to ${a[1]}`);
      continue;
    }
    if (ix.program === SOLANA_ATA_PROGRAM) {
      // Create (no data) or CreateIdempotent (1): payer, account, owner, mint, System, token program.
      if (!(d.length === 0 || (d.length === 1 && d[0] === 1)) || a.length !== 6) { out.wrong.push(`S13 ${at}: associated token instruction ${hex(d)}`); continue; }
      const [payer, acc, owner, mint, sys, tp] = a as [string, string, string, string, string, string];
      if (payer !== w || owner !== w || sys !== SOLANA_SYSTEM_PROGRAM || !isToken(tp) || acc !== solanaAta(w, mint, tp)) {
        out.wrong.push(`S13 ${at}: create of ${acc} for ${owner} paid by ${payer}`);
        continue;
      }
      if (k > c.jupAt) { out.wrong.push(`S13 ${at}: create after the route`); continue; }
      out.created.set(acc, { mint, tp });
      continue;
    }
    if (isToken(ix.program)) {
      if (d.length === 1 && d[0] === 17 && a.length === 1 && a[0] === wsol && ix.program === SOLANA_TOKEN_PROGRAM && req.side === "buy" && k < c.jupAt) continue; // SyncNative
      if (d.length === 1 && d[0] === 9 && a.length === 3) {
        // CloseAccount: account, destination, authority; only an account this tx created, after the route, to W_k.
        const [acc, dest, auth] = a as [string, string, string];
        const made = out.created.get(acc);
        if (!made || made.tp !== ix.program || dest !== w || auth !== w || k < c.jupAt) { out.wrong.push(`S13 ${at}: close of ${acc} to ${dest}`); continue; }
        out.closed.set(acc, (out.closed.get(acc) ?? 0) + 1);
        continue;
      }
      if (ix.program === SOLANA_TOKEN_2022_PROGRAM && d.length === 2 && d[0] === 26 && d[1] === 4 && a.length === 2) {
        // HarvestWithheldTokensToMint (mint, account): only right before that account's close.
        const [mint, acc] = a as [string, string];
        const next = c.ixs[k + 1];
        const made = out.created.get(acc);
        const nextCloses = next?.program === SOLANA_TOKEN_2022_PROGRAM && next.data.length === 1 && next.data[0] === 9 && next.accounts[0]?.key === acc;
        if (!made || made.mint !== mint || !nextCloses) { out.wrong.push(`S13 ${at}: harvest of ${acc} not right before its close`); continue; }
        continue;
      }
      out.wrong.push(`S5 ${at}: token instruction ${hex(d)} on ${a[0]}`);
      continue;
    }
    // Any other program is S3's refusal; it is never counted as allowed here.
  }
  if (req.side === "buy" && seen.wrap !== 1) out.wrong.push(`S5: ${seen.wrap} wraps of exactly ${req.amount} into the wallet's own wSOL account before the route (want 1)`);
  if (seen.sender !== 1) out.wrong.push(`S5: ${seen.sender} Sender tips of ${SOLANA_SENDER_TIP} (want 1)`);
  if (seen.jito !== 1) out.wrong.push(`S5: ${seen.jito} Jito tips of ${SOLANA_JITO_TIP} (want 1)`);
  return out;
}

function s5(wk: Walk): SolanaQuoteResult {
  const off = wk.wrong.filter((x) => x.startsWith("S5"));
  return off.length ? fail("S5", off.join("; ")) : pass("S5", "only the wrap and the two baked tips leave the wallet");
}

// S13: every account the tx creates is closed once after the route, to the wallet, except the buy's output account,
// which stays open and is never closed.
function s13(c: Ctx, wk: Walk): SolanaQuoteResult {
  const off = wk.wrong.filter((x) => x.startsWith("S13"));
  const { outMint, outTp } = sides(c);
  const keep = c.req.side === "buy" && isToken(outTp) ? solanaAta(c.req.wallet, outMint, outTp) : null;
  if (c.req.side === "buy" && (!keep || !wk.created.has(keep))) off.push(`S13: no create of the wallet's own output account ${keep}`);
  for (const acc of wk.created.keys()) {
    const n = wk.closed.get(acc) ?? 0;
    if (acc === keep ? n !== 0 : n !== 1) off.push(`S13: ${acc} closed ${n} times (want ${acc === keep ? 0 : 1})`);
  }
  return off.length ? fail("S13", off.join("; ")) : pass("S13", `${wk.created.size} created, every one but the output closed to the wallet`);
}

// S6: the swap pays only into the wallet's own account of the output mint.
function s6(c: Ctx): SolanaQuoteResult {
  const e = needRoute("S6", c);
  if (e) return e;
  const r = c.route as Route;
  const { outMint, outTp } = sides(c);
  if (!isToken(outTp)) return fail("S6", `output token program ${outTp} unknown`);
  const want = solanaAta(c.req.wallet, outMint, outTp);
  const wrong: string[] = [];
  if (r.a[6]?.key !== outTp) wrong.push(`destination token program ${r.a[6]?.key} != ${outTp}`);
  if (r.a[2]?.key !== want) wrong.push(`destination ${r.a[2]?.key} is not the wallet's account ${want}`);
  if (r.a[7]?.key !== SOLANA_JUPITER_PROGRAM && r.a[7]?.key !== want) wrong.push(`destination_token_account ${r.a[7]?.key}`);
  return wrong.length ? fail("S6", wrong.join("; ")) : pass("S6", `output to the wallet's account ${want}`);
}

// S7: the floor the Jupiter program enforces, decoded from the signed bytes, is at least minOut_k. The floor is
// quoted_out × (10,000 − slippage_bps) / 10,000 rounded down, the lower bound of what the program enforces (U-3).
function s7(c: Ctx): SolanaQuoteResult {
  const e = needRoute("S7", c);
  if (e) return e;
  const r = c.route as Route;
  if (r.platformFeeBps !== 0 || r.positiveSlippageBps !== 0) return fail("S7", `platform fee ${r.platformFeeBps} bps, positive slippage ${r.positiveSlippageBps} bps`);
  if (r.slippageBps > 10_000) return fail("S7", `slippage ${r.slippageBps} bps`);
  const floor = (r.quotedOut * BigInt(10_000 - r.slippageBps)) / 10_000n;
  const detail = `floor ${floor} (quoted ${r.quotedOut} at ${r.slippageBps} bps) vs minOut ${c.req.minOut}`;
  return floor >= c.req.minOut && c.req.minOut > 0n ? pass("S7", detail) : fail("S7", detail);
}

type Budget = { limit: number; price: bigint } | string;
function budget(c: Ctx): Budget {
  const cb = c.ixs.filter((ix) => ix.program === SOLANA_COMPUTE_BUDGET_PROGRAM);
  const lim = cb.filter((ix) => ix.data.length === 5 && ix.data[0] === 2 && ix.accounts.length === 0);
  const price = cb.filter((ix) => ix.data.length === 9 && ix.data[0] === 3 && ix.accounts.length === 0);
  if (cb.length !== 2 || lim.length !== 1 || price.length !== 1) return `${cb.length} compute budget instructions (want one limit and one price)`;
  return { limit: u32((lim[0] as Ix).data, 1), price: u64((price[0] as Ix).data, 1) };
}

// S8: one limit within the route's cap and one price within the cap. The cap comes from the signed route plan: a
// one-step pump.fun curve route gets the pump cap, every other route the general one.
function s8(c: Ctx): SolanaQuoteResult {
  const b = budget(c);
  if (typeof b === "string") return fail("S8", b);
  const r = c.route;
  const step = r && r.steps === 1 ? r.firstStep : undefined;
  const cap = step !== undefined && PUMP_BUY_STEPS.has(step) ? SOLANA_CU_LIMIT.pumpBuy : step !== undefined && PUMP_SELL_STEPS.has(step) ? SOLANA_CU_LIMIT.pumpSell : SOLANA_CU_LIMIT.other;
  const detail = `limit ${b.limit} (cap ${cap}), price ${b.price} micro-lamports per unit (cap ${SOLANA_CU_PRICE_MAX})`;
  return b.limit <= cap && b.price <= SOLANA_CU_PRICE_MAX ? pass("S8", detail) : fail("S8", detail);
}

// S9: the tx fits one packet.
function s9(c: Ctx): SolanaQuoteResult {
  return c.tx.size <= SOLANA_MAX_TX_BYTES ? pass("S9", `${c.tx.size} bytes`) : fail("S9", `${c.tx.size} bytes > ${SOLANA_MAX_TX_BYTES}`);
}

// S10: the token's mint, the same bytes on both providers. No confidential transfers, no transfer hook whose authority
// can change it, and a non-transferable mint gets no route.
function s10(c: Ctx): SolanaQuoteResult {
  const [a, b] = c.reads.mint;
  if (!a || !b) return fail("S10", "mint not read on both providers");
  if (a.owner !== b.owner || !eqBytes(a.data, b.data)) return fail("S10", "the providers disagree on the mint");
  if (a.owner === SOLANA_TOKEN_PROGRAM) return a.data.length === 82 ? pass("S10", "SPL Token mint") : fail("S10", `SPL Token mint of ${a.data.length} bytes`);
  if (a.owner !== SOLANA_TOKEN_2022_PROGRAM) return fail("S10", `mint owner ${a.owner} is not a token program`);
  const d = a.data;
  if (d.length === 82) return pass("S10", "Token-2022 mint without extensions");
  if (d.length < 166 || d[165] !== 1) return fail("S10", `Token-2022 mint of ${d.length} bytes without the mint account type`);
  const found: number[] = [];
  const refused: string[] = [];
  let o = 166;
  while (o + 4 <= d.length) {
    const type = u16(d, o);
    const len = u16(d, o + 2);
    if (type === 0) break; // Uninitialized: the rest is padding
    if (o + 4 + len > d.length) return fail("S10", `extension ${type} runs past the mint`);
    const body = d.subarray(o + 4, o + 4 + len);
    found.push(type);
    if (EXT_CONFIDENTIAL.has(type)) refused.push(`confidential transfer (${type})`);
    if (type === EXT_NON_TRANSFERABLE) refused.push("non-transferable");
    if (type === EXT_TRANSFER_HOOK && (len !== 64 || body.subarray(0, 32).some((x) => x !== 0))) refused.push("transfer hook whose authority can change it");
    o += 4 + len;
  }
  if (o !== d.length && d.subarray(o).some((x) => x !== 0)) return fail("S10", "bytes after the last extension");
  return refused.length ? fail("S10", `Token-2022 mint with ${refused.join(", ")}`) : pass("S10", `Token-2022 extensions ${found.join(",") || "none"}`);
}

// S11: the simulation on both providers. A buy's native out stays within a_k + fees + tips + the output account's rent
// (+ the wallet's own pump volume account, if the route funds it, up to its rent), and its token in reaches minOut_k.
// A sell's token out is exactly a_k and its native in, before fees and tips, reaches minOut_k. No other wallet of this
// user changes.
function s11(c: Ctx): SolanaQuoteResult {
  const b = budget(c);
  if (typeof b === "string") return fail("S11", b);
  const fees = SOLANA_LAMPORTS_PER_SIGNATURE * BigInt(c.tx.signatures) + (b.price * BigInt(b.limit) + 999_999n) / 1_000_000n;
  const tips = SOLANA_SENDER_TIP + SOLANA_JITO_TIP;
  const wrong: string[] = [];
  for (const [p, sim] of c.reads.simulations.entries()) {
    const at = p === 0 ? "A" : "B";
    if (!sim) { wrong.push(`no simulation on provider ${at}`); continue; }
    if (sim.err !== null) { wrong.push(`provider ${at}: simulation error ${JSON.stringify(sim.err)}`); continue; }
    const nativeOut = sim.walletLamports.pre - sim.walletLamports.post;
    const tokenDelta = sim.tokenAccount.post - sim.tokenAccount.pre;
    const pva = sim.pumpVolumeAccumulator.post - sim.pumpVolumeAccumulator.pre;
    if (pva < 0n || pva > c.reads.rent.pumpVolumeAccumulator) wrong.push(`provider ${at}: the pump volume account moves by ${pva}`);
    if (sim.otherWallets.some((x) => x.pre !== x.post)) wrong.push(`provider ${at}: another wallet of this user changes`);
    if (c.req.side === "buy") {
      const bound = c.req.amount + fees + tips + c.reads.rent.tokenAccount + (pva > 0n ? pva : 0n);
      if (nativeOut > bound) wrong.push(`provider ${at}: native out ${nativeOut} > ${bound}`);
      if (tokenDelta < c.req.minOut) wrong.push(`provider ${at}: token in ${tokenDelta} < minOut ${c.req.minOut}`);
    } else {
      if (-tokenDelta !== c.req.amount) wrong.push(`provider ${at}: token out ${-tokenDelta} != ${c.req.amount}`);
      if (-nativeOut + fees + tips < c.req.minOut) wrong.push(`provider ${at}: native in ${-nativeOut + fees + tips} < minOut ${c.req.minOut}`);
      if (pva !== 0n) wrong.push(`provider ${at}: a sell funds the pump volume account`);
    }
  }
  return wrong.length ? fail("S11", wrong.join("; ")) : pass("S11", `both simulations clean and within bounds (fees ${fees}, tips ${tips})`);
}

// The swap's out in the simulation, taken as the lower of the two providers (S12 compares against it).
function simulatedOut(c: Ctx): bigint | null {
  const b = budget(c);
  if (typeof b === "string") return null;
  const fees = SOLANA_LAMPORTS_PER_SIGNATURE * BigInt(c.tx.signatures) + (b.price * BigInt(b.limit) + 999_999n) / 1_000_000n;
  const outs = c.reads.simulations.map((s) =>
    !s || s.err !== null ? null : c.req.side === "buy" ? s.tokenAccount.post - s.tokenAccount.pre : s.walletLamports.post - s.walletLamports.pre + fees + SOLANA_SENDER_TIP + SOLANA_JITO_TIP,
  );
  if (outs.some((x) => x === null)) return null;
  return (outs as bigint[]).reduce((m, x) => (x < m ? x : m));
}

// S12: against the token's reference pool on chain: simulated out ≥ E × (1 − tol) and minOut_k ≥ E × (1 − s). No
// reference, no signature.
function s12(c: Ctx): SolanaQuoteResult {
  const ref = c.reads.reference;
  if (!ref) return fail("S12", "no on-chain reference pool");
  const { expectedOut: e, tolBps, slippageBps } = ref;
  if (e <= 0n || !Number.isInteger(tolBps) || tolBps < 0 || tolBps > 10_000 || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    return fail("S12", `reference out of range: E ${e}, tol ${tolBps}, s ${slippageBps}`);
  }
  const out = simulatedOut(c);
  if (out === null) return fail("S12", "no clean simulation to compare");
  const barOut = (e * BigInt(10_000 - tolBps)) / 10_000n;
  const barMin = (e * BigInt(10_000 - slippageBps)) / 10_000n;
  const wrong: string[] = [];
  if (out < barOut) wrong.push(`simulated out ${out} < E ${e} less ${tolBps} bps (${barOut})`);
  if (c.req.minOut < barMin) wrong.push(`minOut ${c.req.minOut} < E ${e} less ${slippageBps} bps (${barMin})`);
  return wrong.length ? fail("S12", wrong.join("; ")) : pass("S12", `simulated out ${out}, minOut ${c.req.minOut}, E ${e}`);
}

// Every check, on the bytes the device is about to sign. ok is true only when every check passes.
export function checkSolanaQuote(txBytes: Uint8Array, req: SolanaQuoteRequest, reads: SolanaQuoteReads): SolanaQuoteVerdict {
  let c: Ctx;
  try {
    const tx = solanaDecodeTransaction(txBytes);
    // Keys resolve from provider A's tables; S2 refuses unless provider B holds the same bytes at every used index.
    const tables: Record<string, SolanaLookupTable> = {};
    for (const l of tx.message.lookups) {
      const acc = Object.hasOwn(reads.tables, l.table) ? reads.tables[l.table]?.[0] : null;
      if (!acc || acc.owner !== SOLANA_ALT_PROGRAM) throw new Error(`lookup table ${l.table} not read`);
      tables[l.table] = solanaDecodeLookupTable(acc.data);
    }
    const keys = solanaResolveKeys(tx.message, tables);
    const key = (i: number): SolanaAccountKey => {
      const k = keys[i];
      if (!k) throw new Error(`account index ${i} out of range`);
      return k;
    };
    const ixs: Ix[] = tx.message.instructions.map((ix, index) => ({ index, program: key(ix.programIndex).key, accounts: ix.accounts.map(key), data: ix.data }));
    const mintA = reads.mint[0];
    const tokenProgram = mintA && isToken(mintA.owner) ? mintA.owner : null;
    const jup = ixs.filter((ix) => ix.program === SOLANA_JUPITER_PROGRAM);
    let route: Route | null = null;
    let routeError: string | null = null;
    if (jup.length !== 1) routeError = `${jup.length} Jupiter instructions (want exactly 1)`;
    else {
      try {
        route = decodeRoute(jup[0] as Ix);
      } catch (err) {
        routeError = (err as Error).message;
      }
    }
    c = { req, reads, tx, ixs, tokenProgram, route, routeError, jupAt: jup.length === 1 ? ixs.indexOf(jup[0] as Ix) : -1 };
  } catch (err) {
    return { ok: false, results: [fail("DECODE", `cannot decode the transaction: ${(err as Error).message}`)] };
  }
  // A check that throws on a hostile read refuses; it never throws past the device.
  const guard = (id: SolanaQuoteCheckId, f: () => SolanaQuoteResult): SolanaQuoteResult => {
    try {
      return f();
    } catch (err) {
      return fail(id, `threw: ${(err as Error).message}`);
    }
  };
  let wk: Walk;
  try {
    wk = walk(c);
  } catch (err) {
    wk = { wrong: [`S5 threw: ${(err as Error).message}`, `S13 threw: ${(err as Error).message}`], created: new Map(), closed: new Map() };
  }
  const ctx = c;
  const results = [
    guard("S1", () => s1(ctx)), guard("S2", () => s2(ctx)), guard("S3", () => s3(ctx)), guard("S4", () => s4(ctx)),
    guard("S5", () => s5(wk)), guard("S6", () => s6(ctx)), guard("S7", () => s7(ctx)), guard("S8", () => s8(ctx)),
    guard("S9", () => s9(ctx)), guard("S10", () => s10(ctx)), guard("S11", () => s11(ctx)), guard("S12", () => s12(ctx)),
    guard("S13", () => s13(ctx, wk)),
  ];
  return { ok: results.every((r) => r.ok), results };
}
