// The device's checks on a Solana swap before it signs (markets paper T2.2, S1-S13). Pure functions over: the user's
// own request, the wire bytes the device is about to sign, and the device's own reads (lookup tables and mint on two
// providers, the simulation on two providers, the reference pool's expected out). No field of the quote or the route
// JSON is read: only the signed bytes. Any refusal means nothing is signed.
//
// The two-provider reads themselves (who asks which provider, the re-read, the session cache of agreed table entries,
// the reference pool finder) are the buy flow's; these checks take their answers and refuse when the answers disagree
// or are missing.
//
// The floor rule for the buy flow: set minOut_k = floor(E × (1 − s)) from the device's own reference E, never from the
// API's otherAmountThreshold (which rounds up: on the real buy 2btTg7… it is 1 above the floor S7 decodes, so S7 would
// refuse it).
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
// S12's tolerance between the simulated out and E: the paper's band, POOL_READ_TOL_BPS = 200 (§2.0 LD1; the G1 proof saw
// about 1.1 % per reserve between a processed and a confirmed read).
export const SOLANA_SIM_TOL_BPS = 200;

// Jupiter v6 route_v2 (the on-chain IDL of JUP6…TaV4, account C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa, read
// 2026-10-25 22:06:06Z slot 461420570; research proofs/g1-phone-trade/src/checks.js:7-15): discriminator, in_amount u64,
// quoted_out_amount u64, slippage_bps u16, platform_fee_bps u16, positive_slippage_bps u16, route_plan Vec<step>;
// accounts: authority (signer), user source, user destination, source mint, destination mint, source token program,
// destination token program, destination_token_account (optional: the program id when absent), event authority, program.
const ROUTE_V2 = [187, 100, 250, 204, 49, 196, 175, 20];
// Jupiter v6 shared_accounts_route_v2, the instruction /swap/v2/build answers for many multi-hop routes (it has no
// parameter to turn shared accounts off). From the same on-chain IDL account, read again 2026-11-02 06:22Z at slot
// 464392865 on api.mainnet-beta.solana.com and 464392866 on solana-rpc.publicnode.com, the same bytes on both: account
// data sha256 f42828e0fb580cb59890c76d96c7a919d184118c61002b984f229e9df5607d2e, its inflated IDL JSON sha256
// e6c2b425ec740922ee91aa7a3278cea07f4bc00a3ed9efa4eca16facb481bfca (address JUP6…TaV4). Discriminator
// [209,152,83,147,124,254,216,233]; args id u8, then route_v2's: in_amount u64, quoted_out_amount u64, slippage_bps
// u16, platform_fee_bps u16, positive_slippage_bps u16, route_plan Vec<step>; 12 accounts: program_authority,
// user_transfer_authority (signer), source_token_account, program_source_token_account,
// program_destination_token_account, destination_token_account, source_mint, destination_mint, source_token_program,
// destination_token_program, event_authority, program. The user pays in_amount from source_token_account into
// program_source_token_account, the legs swap between the program authority's accounts, and the program pays the out
// from program_destination_token_account into destination_token_account. The IDL names no seeds for the program
// authority; on all 16 real builds read through the helper on 2026-11-02 05:05-06:34Z (ids 0 to 7, SPL Token and
// Token-2022, buys and sells) it is Jupiter's PDA of ("authority", [id]), and each of its two accounts is its ATA of
// that side's mint on every SPL Token side and the wallet's own account of that side on every Token-2022 side (Jupiter
// then swaps that leg straight from or into the wallet's account). S6 takes exactly that, and the wallet's own account
// on an SPL Token side too. The id is not bounded: the device derives the authority from it, so any id's PDA is still
// Jupiter's alone, and a bound would only refuse a future valid id.
const SHARED_ROUTE_V2 = [209, 152, 83, 147, 124, 254, 216, 233];
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
  // Every other Solana wallet of this user (all of them, not only the set's): S11 refuses a tx that names any of them or
  // its accounts for this trade, in any role, since even a read-only key links two of the user's wallets on chain.
  otherWallets: readonly string[];
  // The trade's SolanaWalletLinks, built while the build and reads are in flight; S11 uses it only when it holds every
  // wallet in otherWallets, and otherwise builds its own.
  links?: SolanaWalletLinks;
};

// The accounts of the user's wallets a tx could name, by address, built once per trade and grown with each leg's keys:
// each wallet, its pump and PumpSwap volume accounts, the PumpSwap cashback account (the WSOL account of its PumpSwap
// volume account, which PumpSwap adds on a cashback coin: pump-swap-sdk 2.2.0 offlinePumpAmm.ts, buy 797-808, sell
// 1055-1070), and its associated token account, under Token and Token-2022, for WSOL, the token, and every key any of
// the trade's txs names. Creator vaults are not in it: no wallet of the user can create a coin yet.
export class SolanaWalletLinks {
  readonly wallets: ReadonlySet<string>;
  readonly #owner = new Map<string, string>();
  readonly #added = new Set<string>();
  constructor(wallets: readonly string[]) {
    this.wallets = new Set(wallets);
    for (const w of this.wallets) {
      const sva = solanaVolumeAccumulator(w, SOLANA_PUMP_AMM_PROGRAM);
      for (const k of [w, solanaVolumeAccumulator(w, SOLANA_PUMP_PROGRAM), sva, solanaAta(sva, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM)]) this.#set(k, w);
    }
    this.add([SOLANA_SOL_MINT]);
  }
  #set(k: string, w: string): void {
    if (!this.#owner.has(k)) this.#owner.set(k, w);
  }
  /** Each wallet's associated token accounts for these keys, once per key. */
  add(keys: Iterable<string>): void {
    for (const k of keys) {
      if (this.#added.has(k)) continue;
      this.#added.add(k);
      for (const w of this.wallets) {
        this.#set(solanaAta(w, k, SOLANA_TOKEN_PROGRAM), w);
        this.#set(solanaAta(w, k, SOLANA_TOKEN_2022_PROGRAM), w);
      }
    }
  }
  /** The wallet whose account this is, if any. */
  ownerOf(key: string): string | undefined {
    return this.#owner.get(key);
  }
}
export type SolanaAccountRead = { owner: string; data: Uint8Array };
// One provider's simulation of the whole tx at `confirmed` with sigVerify off, as the device read it.
export type SolanaSimulation = {
  err: unknown; // null when the simulation ran clean
  walletLamports: { pre: bigint; post: bigint };
  tokenAccount: { pre: bigint; post: bigint }; // W_k's account of the token: the output on a buy, the input on a sell
  tokenAccountLamports: { pre: bigint; post: bigint }; // the same account's lamports: 0 before means the tx creates it
  pumpVolumeAccumulator: { pre: bigint; post: bigint }; // W_k's own pump PDA, which a pump buy may fund
  pumpSwapVolumeAccumulator: { pre: bigint; post: bigint }; // W_k's own PumpSwap PDA, which a PumpSwap buy may fund
};
export type SolanaQuoteReads = {
  tables: Readonly<Record<string, readonly [SolanaAccountRead | null, SolanaAccountRead | null]>>; // provider A, B
  mint: readonly [SolanaAccountRead | null, SolanaAccountRead | null];
  // Rent-exempt minimums for the sizes in play (the output token account, a volume account: pump's and PumpSwap's are
  // both 137 bytes), read on provider A and B. Rent is fixed cluster state, so S11 refuses unless both providers give the
  // same value.
  rent: { tokenAccount: readonly [bigint, bigint]; pumpVolumeAccumulator: readonly [bigint, bigint] };
  simulations: readonly [SolanaSimulation | null, SolanaSimulation | null];
  // S12's reference, from the device's own pool read (markets paper S12, T1.3): expectedOut = E(a_k), this wallet's exact
  // input priced on the reference pool, the bar for the simulated out; minOutBase = E_k = floor(E(A) × a_k / A), the
  // base of minOut_k's floor in a standard-size set (E(a_k) itself when absent); and the user's slippage s.
  reference: { expectedOut: bigint; minOutBase?: bigint; slippageBps: number } | null;
};
export type SolanaQuoteCheckId = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8" | "S9" | "S10" | "S11" | "S12" | "S13" | "DECODE";
export type SolanaQuoteResult = { id: SolanaQuoteCheckId; ok: boolean; detail: string };
export type SolanaQuoteVerdict = { ok: boolean; results: SolanaQuoteResult[] };

type Ix = { index: number; program: string; accounts: SolanaAccountKey[]; data: Uint8Array };
type Route = {
  kind: "route_v2" | "shared_accounts_route_v2";
  inAmount: bigint;
  quotedOut: bigint;
  slippageBps: number;
  platformFeeBps: number;
  positiveSlippageBps: number;
  steps: number;
  firstStep: number | undefined;
  authority: SolanaAccountKey; // the user's signer
  source: SolanaAccountKey; // the user's account the input leaves
  destination: SolanaAccountKey; // the account the output lands in
  sourceMint: SolanaAccountKey;
  destinationMint: SolanaAccountKey;
  sourceTokenProgram: SolanaAccountKey;
  destinationTokenProgram: SolanaAccountKey;
  // route_v2's optional destination_token_account (the program id when absent); null on the shared route, which has none
  destinationOverride: SolanaAccountKey | null;
  eventAuthority: SolanaAccountKey;
  program: SolanaAccountKey;
  // the shared route's program authority: its id, its key and its two accounts; null on route_v2
  shared: { id: number; authority: SolanaAccountKey; source: SolanaAccountKey; destination: SolanaAccountKey } | null;
};
type Ctx = {
  req: SolanaQuoteRequest;
  reads: SolanaQuoteReads;
  tx: SolanaTransaction;
  keys: readonly string[]; // every account the tx names: its static keys and its lookup tables' indexes, resolved
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

// The route from the instruction bytes and accounts, by the IDL layouts above; anything else throws.
function decodeRoute(ix: Ix): Route {
  const d = ix.data;
  const a = ix.accounts;
  const at = (i: number): SolanaAccountKey => a[i] as SolanaAccountKey;
  if (d.length >= 34 && eqBytes(d.subarray(0, 8), Uint8Array.from(ROUTE_V2))) {
    if (a.length < 10) throw new Error(`route_v2 with ${a.length} accounts`);
    return {
      kind: "route_v2",
      inAmount: u64(d, 8),
      quotedOut: u64(d, 16),
      slippageBps: u16(d, 24),
      platformFeeBps: u16(d, 26),
      positiveSlippageBps: u16(d, 28),
      steps: u32(d, 30),
      firstStep: d[34],
      authority: at(0),
      source: at(1),
      destination: at(2),
      sourceMint: at(3),
      destinationMint: at(4),
      sourceTokenProgram: at(5),
      destinationTokenProgram: at(6),
      destinationOverride: at(7),
      eventAuthority: at(8),
      program: at(9),
      shared: null,
    };
  }
  if (d.length >= 35 && eqBytes(d.subarray(0, 8), Uint8Array.from(SHARED_ROUTE_V2))) {
    if (a.length < 12) throw new Error(`shared_accounts_route_v2 with ${a.length} accounts`);
    return {
      kind: "shared_accounts_route_v2",
      inAmount: u64(d, 9),
      quotedOut: u64(d, 17),
      slippageBps: u16(d, 25),
      platformFeeBps: u16(d, 27),
      positiveSlippageBps: u16(d, 29),
      steps: u32(d, 31),
      firstStep: d[35],
      authority: at(1),
      source: at(2),
      destination: at(5),
      sourceMint: at(6),
      destinationMint: at(7),
      sourceTokenProgram: at(8),
      destinationTokenProgram: at(9),
      destinationOverride: null,
      eventAuthority: at(10),
      program: at(11),
      shared: { id: d[8] as number, authority: at(0), source: at(3), destination: at(4) },
    };
  }
  throw new Error(`Jupiter instruction ${hex(d)} is neither route_v2 nor shared_accounts_route_v2`);
}

// Jupiter's program authority for a shared route's id.
const jupiterAuthority = (id: number): string => solanaProgramAddress([new TextEncoder().encode("authority"), Uint8Array.of(id)], SOLANA_JUPITER_PROGRAM);

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
  if (r.authority.key !== req.wallet || !r.authority.signer) wrong.push(`route authority ${r.authority.key} is not the signing wallet`);
  if (r.sourceMint.key !== inMint) wrong.push(`input mint ${r.sourceMint.key} != ${inMint}`);
  if (r.destinationMint.key !== outMint) wrong.push(`output mint ${r.destinationMint.key} != ${outMint}`);
  if (r.inAmount !== req.amount) wrong.push(`in amount ${r.inAmount} != ${req.amount}`);
  if (!isToken(inTp) || r.sourceTokenProgram.key !== inTp) wrong.push(`source token program ${r.sourceTokenProgram.key} != ${inTp}`);
  else if (r.source.key !== solanaAta(req.wallet, inMint, inTp)) wrong.push(`source account ${r.source.key} is not the wallet's own`);
  if (r.eventAuthority.key !== JUP_EVENT_AUTHORITY || r.program.key !== SOLANA_JUPITER_PROGRAM) wrong.push("route event authority or program account changed");
  return wrong.length ? fail("S1", wrong.join("; ")) : pass("S1", `${r.kind}: ${req.side} ${r.inAmount} of ${inMint} for ${outMint}, authority the wallet`);
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

// S6: the swap pays only into the wallet's own account of the output mint. On a shared route the legs run between the
// program authority's accounts, so those must be Jupiter's or the wallet's own: the authority the PDA of the signed id,
// and each of its two accounts the wallet's own account of that side, or on an SPL Token side the authority's ATA too.
// A Token-2022 side never goes through the authority's ATA: a fee-charging mint moved a second time, out of that account
// after Jupiter's floor check, could leave the wallet below minOut (Jupiter builds every Token-2022 side through the
// wallet's own account on all 16 recorded builds).
function s6(c: Ctx): SolanaQuoteResult {
  const e = needRoute("S6", c);
  if (e) return e;
  const r = c.route as Route;
  const { inMint, outMint, inTp, outTp } = sides(c);
  if (!isToken(outTp)) return fail("S6", `output token program ${outTp} unknown`);
  const want = solanaAta(c.req.wallet, outMint, outTp);
  const wrong: string[] = [];
  if (r.destinationTokenProgram.key !== outTp) wrong.push(`destination token program ${r.destinationTokenProgram.key} != ${outTp}`);
  if (r.destination.key !== want) wrong.push(`destination ${r.destination.key} is not the wallet's account ${want}`);
  if (r.destinationOverride && r.destinationOverride.key !== SOLANA_JUPITER_PROGRAM && r.destinationOverride.key !== want) wrong.push(`destination_token_account ${r.destinationOverride.key}`);
  if (r.shared) {
    const pa = jupiterAuthority(r.shared.id);
    if (r.shared.authority.key !== pa) wrong.push(`program authority ${r.shared.authority.key} is not Jupiter's authority ${r.shared.id} (${pa})`);
    // Each side's account of the program: the wallet's own on a Token-2022 side, the authority's ATA or the wallet's own
    // on an SPL Token side (null: the side's token program is unknown, so nothing passes).
    const side = (what: string, key: string, mint: string, tp: string | null): void => {
      if (!isToken(tp)) { wrong.push(`program ${what} account ${key}: token program ${tp} unknown`); return; }
      const own = solanaAta(c.req.wallet, mint, tp);
      if (tp === SOLANA_TOKEN_2022_PROGRAM) { if (key !== own) wrong.push(`program ${what} account ${key} is not the wallet's own account of the Token-2022 mint ${mint}`); return; }
      if (key !== own && key !== solanaAta(pa, mint, tp)) wrong.push(`program ${what} account ${key} is neither Jupiter's authority's account of ${mint} nor the wallet's`);
    };
    side("source", r.shared.source.key, inMint, inTp);
    side("destination", r.shared.destination.key, outMint, outTp);
  }
  return wrong.length ? fail("S6", wrong.join("; ")) : pass("S6", `output to the wallet's account ${want}${r.shared ? ` through Jupiter's authority ${r.shared.id}` : ""}`);
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
  const cap = c.route ? solanaRouteCuCap((c.ixs[c.jupAt] as Ix).data) : SOLANA_CU_LIMIT.other;
  const detail = `limit ${b.limit} (cap ${cap}), price ${b.price} micro-lamports per unit (cap ${SOLANA_CU_PRICE_MAX})`;
  return b.limit <= cap && b.price <= SOLANA_CU_PRICE_MAX ? pass("S8", detail) : fail("S8", detail);
}

// S8's compute cap for a Jupiter route_v2 instruction's data, which the build (trade/solana/build.ts) also sets as the
// limit, so the two never differ: a one-step pump.fun curve route gets the pump cap of its step, every other route,
// and any data that is not route_v2, the general one.
/** The route's signed amounts (route_v2 or shared_accounts_route_v2, by the layouts above), or null for any other data. */
export function solanaRouteAmounts(routeData: Uint8Array): { inAmount: bigint; quotedOut: bigint; slippageBps: number } | null {
  const d = routeData;
  if (d.length >= 34 && eqBytes(d.subarray(0, 8), Uint8Array.from(ROUTE_V2))) return { inAmount: u64(d, 8), quotedOut: u64(d, 16), slippageBps: u16(d, 24) };
  if (d.length >= 35 && eqBytes(d.subarray(0, 8), Uint8Array.from(SHARED_ROUTE_V2))) return { inAmount: u64(d, 9), quotedOut: u64(d, 17), slippageBps: u16(d, 25) };
  return null;
}
export function solanaRouteCuCap(routeData: Uint8Array): number {
  if (routeData.length < 34 || !eqBytes(routeData.subarray(0, 8), Uint8Array.from(ROUTE_V2))) return SOLANA_CU_LIMIT.other;
  const step = u32(routeData, 30) === 1 ? routeData[34] : undefined;
  return step !== undefined && PUMP_BUY_STEPS.has(step) ? SOLANA_CU_LIMIT.pumpBuy : step !== undefined && PUMP_SELL_STEPS.has(step) ? SOLANA_CU_LIMIT.pumpSell : SOLANA_CU_LIMIT.other;
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

// S11: the simulation on both providers. A buy's native out stays within a_k + fees + tips + what the simulation shows
// W_k's output account gaining, up to its rent (anyone can create or pre-fund that address, so the rent is never assumed)
// + each of the wallet's own volume accounts (pump's and PumpSwap's), if the route funds it, each up to its rent; and its
// token in reaches minOut_k. A sell's token out is exactly a_k, its native in, before fees and tips, reaches minOut_k,
// and it funds neither volume account. No other wallet of this user is touched, read statically: the tx names none of
// the user's other wallets, nor any of their accounts in SolanaWalletLinks (the volume accounts, the PumpSwap cashback
// account, the associated token account for any mint the tx names), in any role, statically or through a lookup table.
// So no simulation ever needs another wallet in its request.
function s11(c: Ctx): SolanaQuoteResult {
  const others = c.req.otherWallets;
  if (!Array.isArray(others)) return fail("S11", "no list of the user's other wallets");
  const given = c.req.links;
  const links = given instanceof SolanaWalletLinks && others.every((o) => given.wallets.has(o)) ? given : new SolanaWalletLinks(others);
  links.add([c.req.token, ...c.keys]);
  const otherSet = new Set(others);
  const linked: string[] = [];
  for (const k of new Set(c.keys)) {
    const o = links.ownerOf(k);
    if (o !== undefined && otherSet.has(o)) linked.push(k === o ? `another wallet of this user ${o}` : `${o}'s account ${k}`);
  }
  if (linked.length) return fail("S11", `the tx names ${linked.join("; ")}`);
  const b = budget(c);
  if (typeof b === "string") return fail("S11", b);
  const fees = SOLANA_LAMPORTS_PER_SIGNATURE * BigInt(c.tx.signatures) + (b.price * BigInt(b.limit) + 999_999n) / 1_000_000n;
  const tips = SOLANA_SENDER_TIP + SOLANA_JITO_TIP;
  const wrong: string[] = [];
  const [rentTa, rentTb] = c.reads.rent.tokenAccount;
  const [rentPa, rentPb] = c.reads.rent.pumpVolumeAccumulator;
  if (rentTa !== rentTb || rentPa !== rentPb || rentTa < 0n || rentPa < 0n) return fail("S11", `the providers disagree on rent: token account ${rentTa}/${rentTb}, pump volume account ${rentPa}/${rentPb}`);
  for (const [p, sim] of c.reads.simulations.entries()) {
    const at = p === 0 ? "A" : "B";
    if (!sim) { wrong.push(`no simulation on provider ${at}`); continue; }
    if (sim.err !== null) { wrong.push(`provider ${at}: simulation error ${JSON.stringify(sim.err)}`); continue; }
    const nativeOut = sim.walletLamports.pre - sim.walletLamports.post;
    const tokenDelta = sim.tokenAccount.post - sim.tokenAccount.pre;
    const pva = sim.pumpVolumeAccumulator.post - sim.pumpVolumeAccumulator.pre;
    if (pva < 0n || pva > rentPa) wrong.push(`provider ${at}: the pump volume account moves by ${pva}`);
    const sva = sim.pumpSwapVolumeAccumulator.post - sim.pumpSwapVolumeAccumulator.pre;
    if (sva < 0n || sva > rentPa) wrong.push(`provider ${at}: the PumpSwap volume account moves by ${sva}`);
    if (c.req.side === "buy") {
      const tal = sim.tokenAccountLamports;
      // What the output account gains, clamped to [0, its rent]: a new account's rent, or the rest of it when someone
      // pre-funded the address (the ATA program then charges W_k only the shortfall); a funded existing account adds 0.
      const gain = tal.post - tal.pre;
      const newAccount = gain < 0n ? 0n : gain < rentTa ? gain : rentTa;
      const bound = c.req.amount + fees + tips + (newAccount > 0n ? newAccount : 0n) + (pva > 0n ? pva : 0n) + (sva > 0n ? sva : 0n);
      if (nativeOut > bound) wrong.push(`provider ${at}: native out ${nativeOut} > ${bound}`);
      if (tokenDelta < c.req.minOut) wrong.push(`provider ${at}: token in ${tokenDelta} < minOut ${c.req.minOut}`);
    } else {
      if (-tokenDelta !== c.req.amount) wrong.push(`provider ${at}: token out ${-tokenDelta} != ${c.req.amount}`);
      if (-nativeOut + fees + tips < c.req.minOut) wrong.push(`provider ${at}: native in ${-nativeOut + fees + tips} < minOut ${c.req.minOut}`);
      if (pva !== 0n) wrong.push(`provider ${at}: a sell funds the pump volume account`);
      if (sva !== 0n) wrong.push(`provider ${at}: a sell funds the PumpSwap volume account`);
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

// S12: against the token's reference pool on chain: simulated out ≥ E(a_k) × (1 − SOLANA_SIM_TOL_BPS / 10,000), the bar
// rounded up (toward refusal), with E(a_k) from the same read as E(A); and minOut_k ≥ floor(E_k × (1 − s)), E_k =
// floor(E(A) × a_k / A) (minOutBase), so the set's floors stay T1.3's. No reference, no signature.
function s12(c: Ctx): SolanaQuoteResult {
  const ref = c.reads.reference;
  if (!ref) return fail("S12", "no on-chain reference pool");
  const { expectedOut: e, slippageBps } = ref;
  const base = ref.minOutBase ?? e;
  const tolBps = SOLANA_SIM_TOL_BPS;
  if (e <= 0n || base <= 0n || base > e || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    return fail("S12", `reference out of range: E ${e}, E_k ${base}, s ${slippageBps}`);
  }
  const out = simulatedOut(c);
  if (out === null) return fail("S12", "no clean simulation to compare");
  const barOut = (e * BigInt(10_000 - tolBps) + 9_999n) / 10_000n;
  const barMin = (base * BigInt(10_000 - slippageBps)) / 10_000n;
  const wrong: string[] = [];
  if (out < barOut) wrong.push(`simulated out ${out} < E ${e} less ${tolBps} bps (${barOut})`);
  if (c.req.minOut < barMin) wrong.push(`minOut ${c.req.minOut} < E_k ${base} less ${slippageBps} bps (${barMin})`);
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
    c = { req, reads, tx, keys: keys.map((k) => k.key), ixs, tokenProgram, route, routeError, jupAt: jup.length === 1 ? ixs.indexOf(jup[0] as Ix) : -1 };
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

// ---------------------------------------------------------------------------------------------------------------
// The teardown after a full sell (markets paper M1.4; 06c §3.1 S-4 and S-5). A sell never closes an account (06c A9,
// MM SEL-13, SEL-14): the sell lands on its own, then the teardown frames close what the wallet still holds, so a close
// that fails can never hold back a sell. S-4 closes every token account of the wallet that holds no tokens, each
// Token-2022 account with the transfer-fee extension harvested to its mint right before its close; S-5 closes the
// wallet's own volume accounts under pump.fun's bonding curve and PumpSwap. The rent goes to the wallet, every lamport.
// ---------------------------------------------------------------------------------------------------------------

export const SOLANA_PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
// close_user_volume_accumulator, the same on both pump programs (their on-chain Anchor IDLs: pump's at
// AYgC53tU5BbP2NAnv5nConJxAdpQZctvmZK88pu69xRs, account data sha256 5a8e78dd…f5a9, and PumpSwap's at
// 5fLnXNNoZcZt9Qku6HARM3un3Ttm2cGsR7gN9Zp1R7h3, sha256 d7202589…b9d3, read 2026-11-02 07:46Z at slot 464411630 on
// api.mainnet-beta.solana.com): no args; accounts user (writable, signer), user_volume_accumulator (writable, PDA of
// "user_volume_accumulator" and the user), event_authority (PDA of "__event_authority"), program.
export const SOLANA_CLOSE_VOLUME_ACCUMULATOR: readonly number[] = [249, 69, 164, 218, 150, 103, 84, 138];
export const SOLANA_VOLUME_PROGRAMS: readonly string[] = [SOLANA_PUMP_PROGRAM, SOLANA_PUMP_AMM_PROGRAM];
/** The wallet's volume account under one pump program. */
export const solanaVolumeAccumulator = (wallet: string, program: string): string =>
  solanaProgramAddress([new TextEncoder().encode("user_volume_accumulator"), base58.decode(wallet)], program);
export const solanaEventAuthority = (program: string): string => solanaProgramAddress([new TextEncoder().encode("__event_authority")], program);
// Token-2022 ExtensionType TransferFeeAmount (interface/src/extension/mod.rs, as EXT_* above) and ConfidentialTransferAccount.
// ConfidentialTransferFeeAmount 17: CloseAccount refuses an account with a confidential withheld amount.
const EXT_TRANSFER_FEE_AMOUNT = 2;
const EXT_CONFIDENTIAL_ACCOUNT = 5;
const EXT_CONFIDENTIAL_FEE_AMOUNT = 17;
/**
 * Compute units per teardown instruction, the bound each frame's limit must stay within (2 x budget + the sum over its
 * instructions): the recorded simulations used 270 (an SPL Token close), 1,616 (a Token-2022 close) and 10,396 to
 * 13,396 per volume close.
 */
export const SOLANA_TEARDOWN_CU = { budget: 300, close: 6_000, harvest: 8_000, volume: 25_000 } as const;
const TOKEN_ACCOUNT_LEN = 165;

/** One account as a provider answered it (getMultipleAccounts, base64). */
export type SolanaHeldRead = { owner: string; lamports: bigint; data: Uint8Array };
export type SolanaHeld =
  | { kind: "token"; address: string; program: string; mint: string; native: boolean; harvest: boolean; lamports: bigint }
  | { kind: "volume"; address: string; program: string; lamports: bigint };
export type SolanaTeardownPlan = { close: SolanaHeld[]; keep: { address: string; why: string }[] };

/**
 * The addresses the wallet may hold after its trades: its account of each mint it traded (under that mint's program),
 * its wSOL account, and its volume account under each pump program. The device reads exactly these on two providers.
 */
export function solanaTeardownAddresses(wallet: string, mints: readonly { mint: string; program: string }[]): string[] {
  const out = [solanaAta(wallet, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM), ...mints.map((m) => {
    if (!isToken(m.program)) throw new Error(`mint ${m.mint}: program ${m.program} is not Token or Token-2022`);
    return solanaAta(wallet, m.mint, m.program);
  }), ...SOLANA_VOLUME_PROGRAMS.map((p) => solanaVolumeAccumulator(wallet, p))];
  return [...new Set(out)];
}

/**
 * What the teardown closes and what stays, from the device's own reads of the wallet's accounts on two providers.
 * Throws when the providers disagree on any account (the caller re-reads) or an address is not the wallet's.
 */
export function solanaTeardownPlan(wallet: string, accounts: Readonly<Record<string, readonly [SolanaHeldRead | null, SolanaHeldRead | null]>>): SolanaTeardownPlan {
  const plan: SolanaTeardownPlan = { close: [], keep: [] };
  const volumes = new Map(SOLANA_VOLUME_PROGRAMS.map((p) => [solanaVolumeAccumulator(wallet, p), p]));
  for (const [address, [a, b]] of Object.entries(accounts)) {
    if (!a !== !b || (a && b && (a.owner !== b.owner || a.lamports !== b.lamports || !eqBytes(a.data, b.data)))) throw new Error(`the providers disagree on ${address}`);
    if (!a) continue;
    if (volumes.has(address)) {
      if (a.owner !== volumes.get(address)) throw new Error(`${address} is owned by ${a.owner}, not ${volumes.get(address)}`);
      // UserVolumeAccumulator (the same IDLs, fields in order after the 8-byte discriminator): user @8, needs_claim bool
      // @40, total_unclaimed_tokens u64 @41, total_claimed_tokens @49, current_sol_volume @57, last_update_timestamp i64
      // @65, has_total_claimed_tokens bool @73, cashback_earned u64 @74, total_cashback_claimed @82; pump's alone then
      // stable_cashback_earned @90, total_stable_cashback_claimed @98. Closing it pays out only its own lamports, so it
      // stays open while anything is owed elsewhere: incentive tokens to claim, volume still to settle, PumpSwap cashback
      // (claim_cashback pays it from the account's own WSOL account) or pump's stable cashback (claim_cashback_v2 pays
      // it from the account's own quote-mint account). Pump's other cashback is paid from the account's lamports
      // (claim_cashback: user, the account, System), which the close returns to the wallet.
      const v = a.data;
      if (v.length < 90 || base58.encode(v.subarray(8, 40)) !== wallet) throw new Error(`${address} is not the wallet's volume account`);
      const owed: string[] = [];
      if (v[40] !== 0 || u64(v, 41) > 0n) owed.push(`unclaimed incentive tokens ${u64(v, 41)}`);
      if (u64(v, 57) > 0n) owed.push(`volume ${u64(v, 57)} not settled`);
      if (a.owner === SOLANA_PUMP_AMM_PROGRAM && u64(v, 74) > u64(v, 82)) owed.push(`cashback ${u64(v, 74) - u64(v, 82)} unclaimed`);
      if (a.owner === SOLANA_PUMP_PROGRAM && v.length >= 106 && u64(v, 90) > u64(v, 98)) owed.push(`stable cashback ${u64(v, 90) - u64(v, 98)} unclaimed`);
      if (owed.length) { plan.keep.push({ address, why: owed.join(", ") }); continue; }
      plan.close.push({ kind: "volume", address, program: a.owner, lamports: a.lamports });
      continue;
    }
    if (!isToken(a.owner)) throw new Error(`${address} is owned by ${a.owner}, not a token program`);
    const d = a.data;
    if (d.length < TOKEN_ACCOUNT_LEN || (a.owner === SOLANA_TOKEN_PROGRAM && d.length !== TOKEN_ACCOUNT_LEN)) throw new Error(`${address}: ${d.length} bytes is not a token account`);
    if (base58.encode(d.subarray(32, 64)) !== wallet) throw new Error(`${address} is not the wallet's`);
    const mint = base58.encode(d.subarray(0, 32));
    const amount = u64(d, 64);
    const state = d[108];
    const native = u32(d, 109) === 1;
    const closeAuth = u32(d, 129) === 1 ? base58.encode(d.subarray(133, 165)) : null;
    let harvest = false;
    let confidential = false;
    if (d.length > TOKEN_ACCOUNT_LEN) {
      if (d[TOKEN_ACCOUNT_LEN] !== 2) throw new Error(`${address}: account type ${d[TOKEN_ACCOUNT_LEN]} is not a token account`);
      for (let o = TOKEN_ACCOUNT_LEN + 1; o + 4 <= d.length; ) {
        const type = u16(d, o);
        const len = u16(d, o + 2);
        if (type === 0) break;
        if (o + 4 + len > d.length) throw new Error(`${address}: extension ${type} runs past the data`);
        // TransferFeeAmount { withheld_amount u64 }: harvest only fees there are (a harvest into a closed mint fails).
        if (type === EXT_TRANSFER_FEE_AMOUNT && len === 8 && u64(d, o + 4) > 0n) harvest = true;
        if (type === EXT_CONFIDENTIAL_ACCOUNT || type === EXT_CONFIDENTIAL_FEE_AMOUNT) confidential = true;
        o += 4 + len;
      }
    }
    // CloseAccount refuses a frozen account, a non-native account holding tokens, and any authority but the close
    // authority (or the owner when none is set); a confidential balance needs steps the device never signs.
    if (state !== 1) plan.keep.push({ address, why: state === 2 ? "frozen" : `state ${state}` });
    else if (!native && amount > 0n) plan.keep.push({ address, why: `holds ${amount} of ${mint}` });
    else if (closeAuth !== null && closeAuth !== wallet) plan.keep.push({ address, why: `close authority ${closeAuth}` });
    else if (confidential) plan.keep.push({ address, why: "confidential balance" });
    else plan.close.push({ kind: "token", address, program: a.owner, mint, native, harvest: harvest && a.owner === SOLANA_TOKEN_2022_PROGRAM, lamports: a.lamports });
  }
  return plan;
}

/** One provider's simulation of one teardown frame (simulateTransaction, sigVerify false), post-state only. */
export type SolanaTeardownSimulation = {
  err: unknown;
  /** The wallet's lamports after the frame. */
  wallet: bigint;
  /** Each account the frame closes, by address: its lamports after the frame, null when the account is gone. */
  accounts: Readonly<Record<string, bigint | null>>;
};
export type SolanaTeardownReads = {
  /** solanaTeardownAddresses' accounts, read on provider A and B (null: no account). */
  accounts: Readonly<Record<string, readonly [SolanaHeldRead | null, SolanaHeldRead | null]>>;
  /** The wallet's own lamports on A and B, read with the accounts. */
  wallet: readonly [bigint, bigint];
  /** Per frame, in order: its simulation on provider A and B. */
  simulations: readonly (readonly [SolanaTeardownSimulation | null, SolanaTeardownSimulation | null])[];
};
export type SolanaTeardownCheckId = "READ" | "DECODE" | "FRAME" | "COVER" | "SIM";
export type SolanaTeardownVerdict = { ok: boolean; plan: SolanaTeardownPlan | null; results: { id: SolanaTeardownCheckId; ok: boolean; detail: string }[] };

/**
 * The device's check on the teardown frames before it signs them: the frames close every account the plan closes,
 * exactly once, to the wallet; a Token-2022 fee account is harvested right before its close; nothing else runs; every
 * frame closes something and asks no more compute than SOLANA_TEARDOWN_CU allows its instructions; and on
 * both providers every frame simulates clean, every account it closes is gone after it, and the wallet gains exactly
 * their lamports less the frame's fee. Any account the plan closes and the frames leave open is refused.
 */
export function checkSolanaTeardown(wires: readonly Uint8Array[], wallet: string, reads: SolanaTeardownReads): SolanaTeardownVerdict {
  const r = (id: SolanaTeardownCheckId, ok: boolean, detail: string) => ({ id, ok, detail });
  let plan: SolanaTeardownPlan;
  try {
    plan = solanaTeardownPlan(wallet, reads.accounts);
    if (reads.wallet[0] !== reads.wallet[1]) throw new Error(`the providers disagree on the wallet's lamports: ${reads.wallet[0]}/${reads.wallet[1]}`);
  } catch (err) {
    return { ok: false, plan: null, results: [r("READ", false, (err as Error).message)] };
  }
  const byAddress = new Map(plan.close.map((h) => [h.address, h]));
  type Frame = { closes: string[]; fee: bigint };
  const frames: Frame[] = [];
  const wrong: string[] = [];
  const closed = new Map<string, number>();
  const harvested = new Map<string, number>();
  try {
    for (const [f, wire] of wires.entries()) {
      const tx = solanaDecodeTransaction(wire);
      const m = tx.message;
      if (m.lookups.length) throw new Error(`frame ${f}: lookup tables`);
      const keys = solanaResolveKeys(m, {});
      if (m.requiredSignatures !== 1 || m.readonlySigned !== 0 || keys[0]?.key !== wallet) wrong.push(`frame ${f}: signers ${m.staticKeys.slice(0, m.requiredSignatures).join(",")} (want only the wallet, paying)`);
      const ixs: Ix[] = m.instructions.map((x, index) => {
        const k = (i: number) => {
          const v = keys[i];
          if (!v) throw new Error(`frame ${f}: account index ${i} out of range`);
          return v;
        };
        return { index, program: k(x.programIndex).key, accounts: x.accounts.map(k), data: x.data };
      });
      let limit: number | null = null;
      let price = 0n;
      const closes: string[] = [];
      for (const [k, ix] of ixs.entries()) {
        const at = `frame ${f} ix ${k}`;
        const a = ix.accounts;
        const d = ix.data;
        if (ix.program === SOLANA_COMPUTE_BUDGET_PROGRAM) {
          if (d.length === 5 && d[0] === 2 && limit === null) limit = u32(d, 1);
          else if (d.length === 9 && d[0] === 3 && price === 0n && u64(d, 1) <= SOLANA_CU_PRICE_MAX) price = u64(d, 1);
          else wrong.push(`${at}: compute budget ${hex(d)}`);
          continue;
        }
        if (isToken(ix.program) && d.length === 1 && d[0] === 9 && a.length === 3) {
          const h = byAddress.get(a[0]?.key as string);
          if (!h || h.kind !== "token" || h.program !== ix.program || a[1]?.key !== wallet || a[2]?.key !== wallet || !a[0]?.writable || !a[1]?.writable) { wrong.push(`${at}: close of ${a[0]?.key} to ${a[1]?.key}`); continue; }
          closed.set(h.address, (closed.get(h.address) ?? 0) + 1);
          closes.push(h.address);
          continue;
        }
        if (ix.program === SOLANA_TOKEN_2022_PROGRAM && d.length === 2 && d[0] === 26 && d[1] === 4 && a.length === 2) {
          const h = byAddress.get(a[1]?.key as string);
          const next = ixs[k + 1];
          const nextCloses = next?.program === SOLANA_TOKEN_2022_PROGRAM && next.data.length === 1 && next.data[0] === 9 && next.accounts[0]?.key === h?.address;
          if (!h || h.kind !== "token" || !h.harvest || h.mint !== a[0]?.key || !nextCloses) { wrong.push(`${at}: harvest of ${a[1]?.key} not right before its close`); continue; }
          harvested.set(h.address, (harvested.get(h.address) ?? 0) + 1);
          continue;
        }
        if (SOLANA_VOLUME_PROGRAMS.includes(ix.program)) {
          const uva = solanaVolumeAccumulator(wallet, ix.program);
          const h = byAddress.get(uva);
          const want = [wallet, uva, solanaEventAuthority(ix.program), ix.program];
          const shape = a.length === 4 && a.every((x, i) => x.key === want[i]) && a[0]?.signer && a[0]?.writable && a[1]?.writable;
          if (!h || h.kind !== "volume" || !shape || !eqBytes(d, Uint8Array.from(SOLANA_CLOSE_VOLUME_ACCUMULATOR))) { wrong.push(`${at}: ${ix.program} instruction ${hex(d)}`); continue; }
          closed.set(uva, (closed.get(uva) ?? 0) + 1);
          closes.push(uva);
          continue;
        }
        wrong.push(`${at}: program ${ix.program} instruction ${hex(d)}`);
      }
      const fee = SOLANA_LAMPORTS_PER_SIGNATURE * BigInt(tx.signatures) + (price * BigInt(limit ?? 0) + 999_999n) / 1_000_000n;
      // A frame closes something, and asks no more compute than its instructions are allowed.
      const cap = 2 * SOLANA_TEARDOWN_CU.budget + ixs.reduce((n, x) => n + (x.program === SOLANA_COMPUTE_BUDGET_PROGRAM ? 0 : SOLANA_VOLUME_PROGRAMS.includes(x.program) ? SOLANA_TEARDOWN_CU.volume : x.data[0] === 26 ? SOLANA_TEARDOWN_CU.harvest : SOLANA_TEARDOWN_CU.close), 0);
      if (closes.length === 0) wrong.push(`frame ${f}: closes nothing`);
      if (limit === null || limit > cap) wrong.push(`frame ${f}: compute limit ${limit ?? "unset"} (want at most ${cap})`);
      frames.push({ closes, fee });
    }
  } catch (err) {
    return { ok: false, plan, results: [r("READ", true, `${plan.close.length} to close, ${plan.keep.length} stay`), r("DECODE", false, (err as Error).message)] };
  }
  const cover: string[] = [];
  for (const h of plan.close) {
    const n = closed.get(h.address) ?? 0;
    if (n !== 1) cover.push(`${h.address} closed ${n} times (want 1)`);
    if (h.kind === "token" && h.harvest && (harvested.get(h.address) ?? 0) !== 1) cover.push(`${h.address} harvested ${harvested.get(h.address) ?? 0} times before its close (want 1)`);
  }
  const sim: string[] = [];
  if (reads.simulations.length !== frames.length) sim.push(`${reads.simulations.length} simulations for ${frames.length} frames`);
  for (const [f, fr] of frames.entries()) {
    const gain = fr.closes.reduce((s, x) => s + (byAddress.get(x) as SolanaHeld).lamports, 0n);
    for (const [p, s] of (reads.simulations[f] ?? [null, null]).entries()) {
      const at = `frame ${f} provider ${p === 0 ? "A" : "B"}`;
      if (!s) { sim.push(`${at}: no simulation`); continue; }
      if (s.err !== null) { sim.push(`${at}: simulation error ${JSON.stringify(s.err)}`); continue; }
      for (const x of fr.closes) {
        const post = Object.hasOwn(s.accounts, x) ? s.accounts[x] : undefined;
        if (post === undefined) sim.push(`${at}: ${x} not read after`);
        else if (post !== null && post !== 0n) sim.push(`${at}: ${x} still holds ${post} lamports`);
      }
      if (s.wallet - reads.wallet[0] !== gain - fr.fee) sim.push(`${at}: the wallet gains ${s.wallet - reads.wallet[0]} (want ${gain} less the fee ${fr.fee})`);
    }
  }
  const results = [
    r("READ", true, `${plan.close.length} to close, ${plan.keep.length} stay${plan.keep.length ? ` (${plan.keep.map((k) => `${k.address}: ${k.why}`).join("; ")})` : ""}`),
    r("DECODE", true, `${frames.length} frame(s)`),
    r("FRAME", wrong.length === 0, wrong.join("; ") || "only closes to the wallet, harvests right before their close, and the compute budget"),
    r("COVER", cover.length === 0, cover.join("; ") || `every one of ${plan.close.length} closed once`),
    r("SIM", sim.length === 0, sim.join("; ") || "every frame clean on both providers, every closed account gone, every lamport back less the fee"),
  ];
  return { ok: results.every((x) => x.ok), plan, results };
}
