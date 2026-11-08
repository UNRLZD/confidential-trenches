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
import { deepFreeze } from "../../freeze.ts";

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
deepFreeze(SOLANA_ALLOWED_PROGRAMS);
// S5: the baked tip accounts and amounts (research proofs/p4-speed/solana/run.mjs:68-84: Helius Sender's list read
// 2026-10-19 from helius.dev/docs/sending-transactions/sender; Jito's getTipAccounts list read 2026-10-19).
export const SOLANA_SENDER_TIP_ACCOUNTS: readonly string[] = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE", "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta", "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD", "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF", "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey", "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
];
deepFreeze(SOLANA_SENDER_TIP_ACCOUNTS);
export const SOLANA_JITO_TIP_ACCOUNTS: readonly string[] = [
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt", "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];
deepFreeze(SOLANA_JITO_TIP_ACCOUNTS);
export const SOLANA_SENDER_TIP = 5_000n;
export const SOLANA_JITO_TIP = 10_000n;
/** The least tip a Jito bundle carries: "Jito enforces a minimum tip of 1000 lamports for bundles"
 * (docs.jito.wtf/lowlatencytxnsend, read 2026-11-03 02:20Z). A mainnet pool buy goes bundle-only, so it tips at least this. */
export const SOLANA_JITO_TIP_MIN = 1_000n;
// S8 (P4S "Slippage and priority"; run.mjs:85-91).
export const SOLANA_CU_PRICE_MAX = 1_000_000n;
export const SOLANA_CU_LIMIT = { pumpBuy: 200_000, pumpSell: 150_000, other: 600_000 } as const;
deepFreeze(SOLANA_CU_LIMIT);
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
// then swaps that leg straight from or into the wallet's account). That last part does not hold: the helper live check
// run 41939321444 (5 Nov 00:10Z) read a sell of the Token-2022 mint 9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump whose
// program source account is FrhrdkCYgeaUHCih33qYhBuGrM3AKZhES45FPaW89EcC, the Token-2022 ATA of authority 0
// (GGztQqQ6pCPaJQnNpXBgELr5cs3WwDakRbh1iEMzjgSJ; read on both RPCs at slot 465502874: owner GGzt…, that mint), and
// the four builds of the Token-2022 mint BZFYNPeQAEW3HWQ4DNsTVahC1n4ZjTgn6jB2nnBbB96W read through the helper at
// 00:35Z (test/fixtures/solana-shared-routes.json) take the authority's ATA on the Token-2022 side, buys and sells. So
// S6 takes, on each side, the wallet's own account or the authority's ATA of that side's mint, with one bound on a
// Token-2022 destination (see S6). The id is not bounded: the device derives the authority from it, so any id's PDA is
// still Jupiter's alone, and a bound would only refuse a future valid id.
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
const EXT_TRANSFER_FEE_CONFIG = 1; // the same enum, TransferFeeConfig

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
  // Mints the user's wallets hold, when the caller names them: S11 also refuses the associated token account of any
  // other wallet for these, though the tx names no such mint.
  heldMints?: readonly string[];
};

// The accounts of the user's wallets a tx could name, by address, kept across trades or built for one, and grown by new
// wallets and each leg's keys:
// each wallet, its pump and PumpSwap volume accounts, the PumpSwap cashback account (the WSOL account of its PumpSwap
// volume account, which PumpSwap adds on a cashback coin: pump-swap-sdk 2.2.0 offlinePumpAmm.ts, buy 797-808, sell
// 1055-1070), and its associated token account, under Token and Token-2022, for WSOL, the token, and every key any of
// the trade's txs names. Creator vaults are not in it: no wallet of the user can create a coin yet.
export class SolanaWalletLinks {
  readonly #wallets = new Set<string>();
  readonly #owner = new Map<string, string>();
  // Keys whose associated token accounts are derived for every wallet in #wallets.
  readonly #added = new Set<string>();
  // grow() calls run one after another, so two never derive the same key, and one awaited grow means every earlier one
  // is done.
  #chain: Promise<void> = Promise.resolve();
  constructor(wallets: Iterable<string> = []) {
    this.addWallets(wallets);
    this.add([SOLANA_SOL_MINT]);
  }
  /** The wallets whose accounts are all in the map: a wallet joins only once its every account is derived. */
  get wallets(): ReadonlySet<string> {
    return this.#wallets;
  }
  /** True when every one of these wallets is in the map. */
  holds(wallets: Iterable<string>): boolean {
    for (const w of wallets) if (!this.#wallets.has(w)) return false;
    return true;
  }
  #set(k: string, w: string): void {
    if (!this.#owner.has(k)) this.#owner.set(k, w);
  }
  // Generators of the work, one derivation a step, so add() runs them whole and grow() in slices. Each marks its wallet
  // or key done only after its last pair. Sets iterate live: a key added while a wallet is derived is reached by it, and
  // a wallet that joins while a key is derived is reached by that key.
  *#walletWork(w: string): Generator<void> {
    if (this.#wallets.has(w)) return;
    const sva = solanaVolumeAccumulator(w, SOLANA_PUMP_AMM_PROGRAM);
    for (const k of [w, solanaVolumeAccumulator(w, SOLANA_PUMP_PROGRAM), sva, solanaAta(sva, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM)]) this.#set(k, w);
    yield;
    for (const k of this.#added) {
      this.#set(solanaAta(w, k, SOLANA_TOKEN_PROGRAM), w);
      this.#set(solanaAta(w, k, SOLANA_TOKEN_2022_PROGRAM), w);
      yield;
    }
    this.#wallets.add(w);
  }
  *#keyWork(k: string): Generator<void> {
    if (this.#added.has(k)) return;
    for (const w of this.#wallets) {
      this.#set(solanaAta(w, k, SOLANA_TOKEN_PROGRAM), w);
      this.#set(solanaAta(w, k, SOLANA_TOKEN_2022_PROGRAM), w);
      yield;
    }
    this.#added.add(k);
  }
  /** Each new wallet's accounts, and its associated token accounts for every key already in the map. */
  addWallets(wallets: Iterable<string>): void {
    for (const w of wallets) for (const _ of this.#walletWork(w));
  }
  /** Each wallet's associated token accounts for these keys, once per key. Every key counts, a program's too: the
   * rule is about what a tx names, and an address derived from another wallet links the two whatever it holds. */
  add(keys: Iterable<string>): void {
    for (const k of keys) for (const _ of this.#keyWork(k));
  }
  /** addWallets then add, in slices of about `sliceMs` that yield to the event loop, so the work overlaps the reads
   * and the build in flight. */
  grow(wallets: Iterable<string>, keys: Iterable<string>, sliceMs = 4): Promise<void> {
    const work = [...[...wallets].map((w) => () => this.#walletWork(w)), ...[...keys].map((k) => () => this.#keyWork(k))];
    const run = async (): Promise<void> => {
      let t = performance.now();
      for (const job of work) {
        for (const _ of job()) {
          if (performance.now() - t < sliceMs) continue;
          await new Promise<void>((r) => setTimeout(r, 0));
          t = performance.now();
        }
      }
    };
    const done = this.#chain.then(run);
    this.#chain = done.catch(() => undefined);
    return done;
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
  // After the tx, each token account of W_k's that reads.writable finds, and its account of the token when the tx writes it
  // (null: gone): S11 holds the whole 165-byte base of each, a wSOL one's lamports in the native sum. walletLamports.post
  // comes from the same simulation as these when the tx writes any of them but the account of the token.
  walletAccounts: Readonly<Record<string, SolanaHeldRead | null>>;
};
export type SolanaQuoteReads = {
  tables: Readonly<Record<string, readonly [SolanaAccountRead | null, SolanaAccountRead | null]>>; // provider A, B
  mint: readonly [SolanaAccountRead | null, SolanaAccountRead | null];
  // Rent-exempt minimums for the sizes in play (the output token account, a volume account: pump's and PumpSwap's are
  // both 137 bytes), read on provider A and B. Rent is fixed cluster state, so S11 refuses unless both providers give the
  // same value.
  rent: { tokenAccount: readonly [bigint, bigint]; pumpVolumeAccumulator: readonly [bigint, bigint] };
  simulations: readonly [SolanaSimulation | null, SolanaSimulation | null];
  // Every account the tx names writable, read on provider A and B before the simulation (null: no account; its data may
  // be cut to the token account's first 165 bytes). S6 and S11 find W_k's token accounts among them by their own bytes,
  // under either token program, an associated account or any other: an account is W_k's when either provider reads it so.
  // An account the tx names read-only cannot change, so these are every account of W_k's the tx can move.
  writable: Readonly<Record<string, readonly [SolanaHeldRead | null, SolanaHeldRead | null]>>;
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
  writable: readonly string[]; // the ones it names writable, each once
  ixs: Ix[];
  tokenProgram: string | null;
  route: Route | null;
  routeError: string | null;
  jupAt: number;
};

const isAddress = (v: unknown): v is string => {
  if (typeof v !== "string" || v.length < 32 || v.length > 44) return false;
  try {
    return base58.decode(v).length === 32;
  } catch {
    return false;
  }
};
const pass = (id: SolanaQuoteCheckId, detail: string): SolanaQuoteResult => ({ id, ok: true, detail });
const fail = (id: SolanaQuoteCheckId, detail: string): SolanaQuoteResult => ({ id, ok: false, detail });
const u16 = (d: Uint8Array, o: number): number => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(o, true);
const u32 = (d: Uint8Array, o: number): number => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);
const u64 = (d: Uint8Array, o: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
const eqBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const hex = (d: Uint8Array): string => Array.from(d.subarray(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
const isToken = (p: string | null): p is string => p === SOLANA_TOKEN_PROGRAM || p === SOLANA_TOKEN_2022_PROGRAM;
/** A token account of the wallet's, by its own bytes: owned by a token program, at least the 165-byte base, its owner
 * field (bytes 32-64, spl-token state.rs Account, the base of a Token-2022 account too) the wallet. S6, S11 and the
 * trade flow's reads all find the wallet's accounts by this one rule. */
export const solanaWalletTokenAccount = (a: SolanaHeldRead | null | undefined, wallet: string): a is SolanaHeldRead =>
  !!a && isToken(a.owner) && a.data.length >= 165 && base58.encode(a.data.subarray(32, 64)) === wallet;
const walletToken = solanaWalletTokenAccount;
// The 165-byte base of a token account (spl-token state.rs Account; a Token-2022 account's extensions follow it), by
// field: what a trade may change on the wallet's accounts is only the amount (and the lamports of a wSOL one).
const BASE_FIELDS: readonly (readonly [string, number, number])[] = [
  ["mint", 0, 32], ["owner", 32, 64], ["amount", 64, 72], ["delegate", 72, 108], ["state", 108, 109],
  ["is_native", 109, 121], ["delegated_amount", 121, 129], ["close authority", 129, 165],
];
// The base fields that differ between two token accounts' bytes, the amount left out when `amount` is false, and "size"
// when their lengths differ: a Token-2022 account's extensions follow the base, and one added after (Reallocate, then a
// required memo or a CPI guard) grows the account, so a written account of the wallet's keeps its size.
const baseChanges = (x: Uint8Array, y: Uint8Array, amount: boolean): string[] => [
  ...BASE_FIELDS.filter(([f, a, b]) => (amount || f !== "amount") && !eqBytes(x.subarray(a, b), y.subarray(a, b))).map(([f]) => f),
  ...(x.length !== y.length ? ["size"] : []),
];
// A wSOL account: SPL Token's is_native COption set (u32 tag at 109).
const nativeAccount = (a: SolanaHeldRead): boolean => a.owner === SOLANA_TOKEN_PROGRAM && u32(a.data, 109) === 1;
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

// Two providers read the mint each at its own slot, so a field that moves on every burn, mint or harvest can differ
// between two honest reads. Two of them do, and no check reads either: the supply (u64 at 36, after the 36-byte
// mint_authority COption: spl-token state.rs Mint, the base of a Token-2022 mint too), which every Burn and MintTo
// moves (run 42161763756, 6 Nov 04:20Z, refused C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump whose supply its burns
// move), and TransferFeeConfig's withheld_amount (u64 at its body + 64, after its two 32-byte authorities;
// transfer_fee/mod.rs:135-149), which every HarvestWithheldTokensToMint moves. Every other byte is compared as read: the
// owner program, the mint and freeze authorities, decimals, is_initialized, the account type, and each Token-2022
// extension whole (its type, length and body), so no field a check reads is ever left out. The walk is decided by the
// extension headers alone, which are compared, so equal masked bytes mean the same fields were masked on both.
const MINT_SUPPLY = 36;
function mintMoving(d: Uint8Array): Uint8Array {
  const m = d.slice();
  if (m.length >= MINT_SUPPLY + 8) m.fill(0, MINT_SUPPLY, MINT_SUPPLY + 8);
  if (m.length < 166 || m[165] !== 1) return m;
  for (let o = 166; o + 4 <= m.length; ) {
    const type = u16(m, o);
    const len = u16(m, o + 2);
    if (type === 0 || o + 4 + len > m.length) break;
    if (type === EXT_TRANSFER_FEE_CONFIG && len === 108) m.fill(0, o + 4 + 64, o + 4 + 72);
    o += 4 + len;
  }
  return m;
}
/** The mint's field at byte `i` of its data (spl-token state.rs Mint, then Token-2022's account type and extensions). */
function mintField(d: Uint8Array, i: number): string {
  if (i < MINT_SUPPLY) return "mint authority";
  if (i < MINT_SUPPLY + 8) return "supply";
  if (i === 44) return "decimals";
  if (i === 45) return "is_initialized";
  if (i < 82) return "freeze authority";
  if (i < 165) return "bytes before its account type";
  if (i === 165) return "account type";
  for (let o = 166; o + 4 <= d.length; ) {
    const type = u16(d, o);
    const len = u16(d, o + 2);
    if (i < o + 4) return `extension header at byte ${o}`;
    if (type === 0 || o + 4 + len > d.length) break;
    if (i < o + 4 + len) return `extension ${type}`;
    o += 4 + len;
  }
  return "bytes after its last extension";
}
/** The first field two providers' reads of one mint differ in, past the two that move (mintMoving), or null when they
 * agree: S6 and S10 refuse with it, and the reference read too. */
export function solanaMintDisagreement(a: SolanaAccountRead, b: SolanaAccountRead): string | null {
  if (a.owner !== b.owner) return `owner program (${a.owner} / ${b.owner})`;
  if (a.data.length !== b.data.length) return `length (${a.data.length} / ${b.data.length} bytes)`;
  const x = mintMoving(a.data);
  const y = mintMoving(b.data);
  const i = x.findIndex((v, k) => v !== y[k]);
  return i < 0 ? null : mintField(a.data, i);
}
/** True when two providers' reads of one mint agree on every field but its supply and its withheld transfer fees. */
export function solanaMintAgreed(a: SolanaAccountRead, b: SolanaAccountRead): boolean {
  return solanaMintDisagreement(a, b) === null;
}

// Why a second move of the token, out of Jupiter's authority's account into the wallet's, could change the amount, or
// null when it cannot: the token's mint, read equal on both providers, whose extensions (walked as S10 walks them)
// charge no fee and run no hook. Called only on a Token-2022 side: that is the token (the output of a buy, the input of
// a sell), and its token program is the mint's owner on provider A (checkSolanaQuote), so the read is a Token-2022 mint.
// From solana-program/token-2022 @ a2ef578 (read 2026-11-05 01:05Z): TransferFeeConfig is two 32-byte authorities, a
// u64 withheld amount, then older_transfer_fee and newer_transfer_fee, each TransferFee { epoch u64, maximum_fee u64,
// transfer_fee_basis_points u16 } (interface/src/extension/transfer_fee/mod.rs:34-42, 135-149: 108 bytes); a transfer
// charges the fee of one of those two slots, by the epoch (get_epoch_fee, :152-158; process_transfer,
// program/src/processor.rs:416-422), which is 0 when its basis points are 0 and never above its maximum_fee
// (calculate_fee, :58-70). So a mint whose slots each have 0 bps or a 0 maximum charges nothing in any epoch. TransferHook
// is authority then program_id, 32 bytes each (transfer_hook/mod.rs:30-37), and a transfer runs a hook only when the
// program id is set (get_program_id, :60-67; processor.rs:432, 611): an all-zero program id runs none.
const feeCharged = (d: Uint8Array, slot: number): boolean => u16(d, slot + 16) !== 0 && u64(d, slot + 8) !== 0n;
function secondMove(c: Ctx): string | null {
  const [a, b] = c.reads.mint;
  if (!a || !b) return "the mint is not read on both providers";
  const off = solanaMintDisagreement(a, b);
  if (off) return `the providers disagree on the mint's ${off}`;
  const d = a.data;
  if (d.length === 82) return null;
  if (d.length < 166 || d[165] !== 1) return `the mint of ${d.length} bytes has no mint account type`;
  let o = 166;
  while (o + 4 <= d.length) {
    const type = u16(d, o);
    const len = u16(d, o + 2);
    if (type === 0) break;
    if (o + 4 + len > d.length) return `the mint's extension ${type} runs past it`;
    const body = o + 4;
    if (type === EXT_TRANSFER_FEE_CONFIG) {
      if (len !== 108) return `the mint's transfer fee config is ${len} bytes`;
      if (feeCharged(d, body + 72) || feeCharged(d, body + 90)) return "the mint charges a transfer fee (TransferFeeConfig)";
    }
    if (type === EXT_TRANSFER_HOOK) {
      if (len !== 64) return `the mint's transfer hook is ${len} bytes`;
      if (d.subarray(body + 32, body + 64).some((x) => x !== 0)) return "the mint runs a transfer hook (TransferHook)";
    }
    o += 4 + len;
  }
  if (o !== d.length && d.subarray(o).some((x) => x !== 0)) return "the mint has bytes after its last extension";
  return null;
}

// S6: the swap pays only into the wallet's own account of the output mint. On a shared route the legs run between the
// program authority's accounts, so those must be Jupiter's or the wallet's own: the authority the PDA of the signed id,
// and each of its two accounts the wallet's own account of that side or the authority's ATA of that side's mint.
// Either side through the authority's ATA moves the token one more time than through the wallet's own account: on the
// destination the output, after the legs, into the wallet (a fee there could leave the wallet below minOut); on the
// source the input, from the wallet before the legs (a fee there is charged twice, the second taken inside the
// slippage, for the mint's withdraw authority). So on a Token-2022 side that account passes only when the token's mint,
// read equal on both providers, charges no transfer fee in either of its fee slots and names no transfer hook program
// (a hook program runs on that move); see secondMove. Every other extension S10 lets through changes no amount moved
// inside one transaction. The old rule, every Token-2022 side through the wallet's own account, was disproved by real
// builds (see SHARED_ROUTE_V2 above).
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
    // Each side's account of the program: the wallet's own or the authority's ATA, and on a Token-2022 side the
    // authority's ATA only for a mint that charges no fee and runs no hook (null: the side's token program is unknown, so
    // nothing passes).
    const side = (what: string, key: string, mint: string, tp: string | null): void => {
      if (!isToken(tp)) { wrong.push(`program ${what} account ${key}: token program ${tp} unknown`); return; }
      if (key === solanaAta(c.req.wallet, mint, tp)) return;
      if (key !== solanaAta(pa, mint, tp)) { wrong.push(`program ${what} account ${key} is neither Jupiter's authority's account of ${mint} nor the wallet's`); return; }
      if (tp !== SOLANA_TOKEN_2022_PROGRAM) return;
      const why = secondMove(c);
      if (why) wrong.push(`program ${what} account ${key} is Jupiter's authority's account of the Token-2022 mint ${mint}: ${why}`);
    };
    side("source", r.shared.source.key, inMint, inTp);
    side("destination", r.shared.destination.key, outMint, outTp);
  }
  // The legs: every account the route instruction names goes into Jupiter's program with the wallet's signature, and that
  // program is closed, so its own checks cannot be read. None of them the tx names writable may be a token account of the
  // wallet's but the pinned source and destination. All are scanned, the route's own accounts too: those are the pinned
  // two, Jupiter's or the wallet itself, so none passes by its place in the list.
  const wr = c.reads.writable;
  const legs = new Set<string>();
  for (const a of (c.ixs[c.jupAt] as Ix).accounts) {
    if (!a.writable || a.key === r.source.key || a.key === r.destination.key || legs.has(a.key)) continue;
    legs.add(a.key);
    const pair = wr && typeof wr === "object" && Object.hasOwn(wr, a.key) ? wr[a.key] : undefined;
    if (!pair) wrong.push(`leg account ${a.key} is not read`);
    else if (pair.some((x) => walletToken(x, c.req.wallet))) wrong.push(`leg account ${a.key} is a token account of the wallet's`);
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

// S10: the token's mint, the same on both providers but for its supply and withheld fees (solanaMintAgreed). No confidential transfers, no transfer hook whose authority
// can change it, and a non-transferable mint gets no route.
function s10(c: Ctx): SolanaQuoteResult {
  const [a, b] = c.reads.mint;
  if (!a || !b) return fail("S10", "mint not read on both providers");
  const off = solanaMintDisagreement(a, b);
  if (off) return fail("S10", `the providers disagree on the mint's ${off}`);
  if (a.owner === SOLANA_TOKEN_PROGRAM) return a.data.length === 82 ? pass("S10", "SPL Token mint") : fail("S10", `SPL Token mint of ${a.data.length} bytes`);
  if (a.owner !== SOLANA_TOKEN_2022_PROGRAM) return fail("S10", `mint owner ${a.owner} is not a token program`);
  const d = a.data;
  if (d.length === 82) return pass("S10", "Token-2022 mint without extensions");
  if (d.length < 166 || d[165] !== 1) return fail("S10", `Token-2022 mint of ${d.length} bytes without the mint account type`);
  const ext = t22MintExtensions(d);
  if (typeof ext === "string") return fail("S10", ext);
  const refused: string[] = [];
  for (const { type, body } of ext) {
    if (EXT_CONFIDENTIAL.has(type)) refused.push(`confidential transfer (${type})`);
    if (type === EXT_NON_TRANSFERABLE) refused.push("non-transferable");
    if (type === EXT_TRANSFER_HOOK && (body.length !== 64 || body.subarray(0, 32).some((x) => x !== 0))) refused.push("transfer hook whose authority can change it");
  }
  return refused.length ? fail("S10", `Token-2022 mint with ${refused.join(", ")}`) : pass("S10", `Token-2022 extensions ${ext.map((e) => e.type).join(",") || "none"}`);
}

/** Token-2022's mint extensions by number, each with the account extension it asks of a new token account: the bytes of
 * its value, or null for none. From solana-program/token-2022 at program@v11.1.0 (read 2026-11-07 12:55Z),
 * interface/src/extension/mod.rs: ExtensionType :1076-1141 gives the numbers, get_account_type :1254-1292 which are a
 * mint's, required_init_account_extensions :1296-1309 what each asks of an account: TransferFeeConfig 1 ->
 * TransferFeeAmount (a u64, transfer_fee/mod.rs:178-181), NonTransferable 9 -> NonTransferableAccount (empty) and
 * ImmutableOwner (which every associated account has already), TransferHook 14 -> TransferHookAccount (a bool,
 * transfer_hook/mod.rs:45-48), Pausable 26 (PausableConfig, 33 bytes, pausable/mod.rs:22-28) -> PausableAccount 27
 * (empty, :35); PermissionedBurn 28 (one 32-byte authority, permissioned_burn/mod.rs:21-25) asks none, nor does any
 * other here. Any other number, an account's extension among them, no mint holds or this kit does not know: S10
 * refuses it by its number and the size rule with it, both from one walk (t22MintExtensions), so they never disagree. */
const T22_MINT_EXT: ReadonlyMap<number, number | null> = new Map([
  [1, 8], [3, null], [4, null], [6, null], [9, 0], [10, null], [12, null], [14, 1], [16, null], [18, null], [19, null],
  [20, null], [21, null], [22, null], [23, null], [24, null], [25, null], [26, 0], [28, null],
]);
/** A Token-2022 mint's extensions (`d` past 82 bytes, its account type byte read), walked as Token-2022 walks them
 * (try_for_each_tlv_extension_type, mod.rs:205-240): the walk ends where fewer than 2 bytes remain or at an
 * Uninitialized type (0), so a mint Token-2022 stored 2 bytes longer to keep it off a multisig's 355 bytes
 * (adjust_len_for_multisig, :128-134) walks clean, and a nonzero type with no room for its length, or a value past the
 * end, is malformed. Each type once and in T22_MINT_EXT, and only zero bytes after the walk's end; or why not. S10 and
 * the size rule (solanaTokenAccountSize) both read a mint through this walk alone. */
function t22MintExtensions(d: Uint8Array): { type: number; body: Uint8Array }[] | string {
  const out: { type: number; body: Uint8Array }[] = [];
  const seen = new Set<number>(); // Token-2022 holds at most one extension of each type: a mint listing one twice is forged
  let at = 166;
  while (d.length - at >= 2) {
    const type = u16(d, at);
    if (type === 0) break; // Uninitialized: the rest is padding
    if (d.length - at < 4) return `extension ${type} has no room for its length`;
    const len = u16(d, at + 2);
    if (at + 4 + len > d.length) return `extension ${type} runs past the mint`;
    if (seen.has(type)) return `the mint lists extension ${type} twice`;
    seen.add(type);
    if (!T22_MINT_EXT.has(type)) return `Token-2022 extension ${type} not known`;
    out.push({ type, body: d.subarray(at + 4, at + 4 + len) });
    at += 4 + len;
  }
  return d.subarray(at).some((x) => x !== 0) ? "bytes after the last extension" : out;
}

/** The largest new token account W can get for a mint the venue reader admits (solanaTokenAccountSize): a Token-2022
 * account with its type byte, ImmutableOwner, and each account extension a mint can ask of it once (Token-2022 holds
 * one extension of each type): 195 bytes. */
export const SOLANA_TOKEN_ACCOUNT_MAX_SIZE = 165 + 1 + 4 + [...T22_MINT_EXT.values()].reduce((s: number, x) => s + (x === null ? 0 : 4 + x), 0);
/** The size of W's new associated token account for `mint` (S11 holds the wallet's account of the token the tx creates
 * to it, the flow reads its rent for it, the pool buy prices its rent by it): 165 for Token; for Token-2022 165, the
 * account type byte and a 4-byte TLV head per extension: ImmutableOwner (the associated token program always adds it)
 * and the one each mint extension asks (T22_MINT_EXT). A mint S10 refuses for its walk is refused here with S10's
 * reason. */
export function solanaTokenAccountSize(mint: { owner: string; data: Uint8Array }): number {
  if (mint.owner === SOLANA_TOKEN_PROGRAM) {
    if (mint.data.length !== 82) throw new Error("not a Token mint");
    return 165;
  }
  if (mint.owner !== SOLANA_TOKEN_2022_PROGRAM) throw new Error(`mint owned by ${mint.owner}`);
  const d = mint.data;
  let size = 165 + 1 + 4; // account type, ImmutableOwner
  if (d.length === 82) return size;
  if (d.length < 166 || d[165] !== 1) throw new Error("not a Token-2022 mint");
  const ext = t22MintExtensions(d);
  if (typeof ext === "string") throw new Error(ext);
  for (const { type } of ext) {
    const extra = T22_MINT_EXT.get(type);
    if (extra !== null && extra !== undefined) size += 4 + extra;
  }
  return size;
}

// The wallet's token accounts the tx names writable, each with its read before. Its account of the token (S11's
// tokenAccount) is `own`, its read before kept only when both providers read it as the wallet's, the same (else null: the
// tx creates it, or a provider has not seen it yet), and `disputed` when one provider reads it as the wallet's and the
// other not, or both but not the same. Every other one both providers must read as the wallet's, the same in every byte
// (its base and its extensions) and its lamports and program; or why not.
type WalletAccount = { key: string; pre: SolanaHeldRead | null; own: boolean; disputed: boolean };
const sameHeld = (a: SolanaHeldRead, b: SolanaHeldRead): boolean => a.owner === b.owner && a.lamports === b.lamports && eqBytes(a.data, b.data);
function walletAccountsOf(c: Ctx): WalletAccount[] | string {
  const w = c.req.wallet;
  if (!isToken(c.tokenProgram)) return `token program ${c.tokenProgram} unknown`;
  const own = solanaAta(w, c.req.token, c.tokenProgram);
  const wr = c.reads.writable;
  if (!wr || typeof wr !== "object") return "the accounts the tx writes are not read";
  const out: WalletAccount[] = [];
  const wrong: string[] = [];
  for (const k of c.writable) {
    const pair = Object.hasOwn(wr, k) ? wr[k] : undefined;
    if (!pair) { wrong.push(`${k}, which the tx writes, is not read`); continue; }
    const [a, b] = pair;
    if (k === own) {
      const agreed = walletToken(a, w) && walletToken(b, w) && sameHeld(a, b);
      out.push({ key: k, pre: agreed ? a : null, own: true, disputed: !agreed && (walletToken(a, w) || walletToken(b, w)) });
      continue;
    }
    if (!walletToken(a, w) && !walletToken(b, w)) continue;
    if (!walletToken(a, w) || !walletToken(b, w) || !sameHeld(a, b)) { wrong.push(`the providers disagree on the wallet's account ${k}`); continue; }
    out.push({ key: k, pre: a, own: false, disputed: false });
  }
  return wrong.length ? wrong.join("; ") : out;
}
// The base a token account of the wallet's of `mint` is created with: initialized, no delegate, not native, no close
// authority (the amount aside).
function cleanBase(mint: string, wallet: string): Uint8Array {
  const d = new Uint8Array(165);
  d.set(base58.decode(mint), 0);
  d.set(base58.decode(wallet), 32);
  d[108] = 1;
  return d;
}
// One simulation's native out: the wallet's lamports and those of each wSOL account of its in `mine`, before less after
// (one closed counts 0 after), and those of the account of the token when the tx closes it (its rent is the wallet's: a
// route that sends it elsewhere takes it from the native sum, as a closed wSOL account's); and each account in `mine` the
// simulation changes beyond what a trade may. A wSOL account may change only its amount and lamports, or close; any
// other account of the wallet's nothing, not its lamports; the account of the token only its amount and lamports (S11
// bounds both), or close, and its base and size after are the ones before or, when the tx creates it, a clean base of
// the token at the size the associated token program gives it (solanaTokenAccountSize). So no route leaves a delegate, a
// close authority, another owner, a frozen state or an added extension on any account of the wallet's.
// The size of the wallet's account of the token when the tx creates it, from provider A's mint (S10 holds B's to it), or
// why it has none: the mint is not read, or S10 refuses its walk (S11 then refuses with the same reason).
const newSize = (c: Ctx): number | string => {
  const m = c.reads.mint[0];
  if (!m) return "the mint is not read";
  try {
    return solanaTokenAccountSize(m);
  } catch (e) {
    return (e as Error).message;
  }
};
function nativeOutOf(sim: SolanaSimulation, mine: readonly WalletAccount[], c: Ctx, size: number): { out: bigint; wrong: string[] } {
  const wallet = c.req.wallet;
  let pre = sim.walletLamports.pre;
  let post = sim.walletLamports.post;
  const wrong: string[] = [];
  const back = sim.walletAccounts;
  for (const m of mine) {
    const after = back && typeof back === "object" && Object.hasOwn(back, m.key) ? back[m.key] : undefined;
    if (after === undefined) { wrong.push(`the wallet's account ${m.key} is not read back`); continue; }
    const still = walletToken(after, wallet) ? after : null;
    // Closed: no account, or one left with 0 lamports, which the runtime removes when the tx ends (a simulation reads it
    // back as the system program's, 0 lamports, no data), so nothing on it outlives the tx.
    const closed = after === null || after.lamports === 0n;
    if (m.own) {
      if (closed) {
        if (m.pre) pre += m.pre.lamports;
        else if (m.disputed) wrong.push(`the providers disagree on the wallet's account of the token ${m.key}, which the tx closes`);
        continue;
      }
      const left = !still ? ["owner"] : still.owner !== c.tokenProgram ? ["program"] : m.pre && m.pre.owner === still.owner && !baseChanges(m.pre.data, still.data, false).length ? [] : [...baseChanges(cleanBase(c.req.token, wallet), still.data.subarray(0, 165), false), ...(still.data.length !== size ? ["size"] : [])];
      if (left.length) wrong.push(`the wallet's account of the token ${m.key} is left with its ${left.join(", ")} changed`);
      continue;
    }
    const p = m.pre as SolanaHeldRead;
    if (nativeAccount(p)) {
      pre += p.lamports;
      if (closed) continue;
      const left = !still ? ["owner"] : still.owner !== p.owner ? ["program"] : baseChanges(p.data, still.data, false);
      if (!still || left.length) wrong.push(`the wallet's wSOL account ${m.key} is left with its ${left.join(", ")} changed`);
      else post += still.lamports;
      continue;
    }
    const was = u64(p.data, 64);
    const left = !still ? ["owner"] : still.owner !== p.owner ? ["program"] : baseChanges(p.data, still.data, false);
    if (left.length || !still || u64(still.data, 64) !== was || still.lamports !== p.lamports) wrong.push(`the wallet's account ${m.key} moves: ${was} -> ${still ? u64(still.data, 64) : "not the wallet's"}, lamports ${p.lamports} -> ${still?.lamports ?? after?.lamports ?? 0n}${left.length ? `, its ${left.join(", ")} changed` : ""}`);
  }
  return { out: pre - post, wrong };
}

// S11: the simulation on both providers. A buy's native out stays within a_k + fees + tips + what the simulation shows
// W_k's output account gaining, up to its rent (anyone can create or pre-fund that address, so the rent is never assumed)
// + each of the wallet's own volume accounts (pump's and PumpSwap's), if the route funds it, each up to its rent; and its
// token in reaches minOut_k. Native out counts the wallet's lamports and every wSOL account of its the tx writes; every
// token account of the wallet's the tx writes keeps its whole base but the amount, and any but a wSOL one or the account
// of the token its lamports too (nativeOutOf). A sell's token out
// is exactly a_k, its native in, before fees and tips, reaches minOut_k, and it funds neither volume account. No other wallet of this user is touched, read statically: the tx names none of
// the user's other wallets, nor any of their accounts in SolanaWalletLinks (the volume accounts, the PumpSwap cashback
// account, the associated token account for any mint the tx names), in any role, statically or through a lookup table.
// So no simulation ever needs another wallet in its request.
function s11(c: Ctx): SolanaQuoteResult {
  const others = c.req.otherWallets;
  if (!Array.isArray(others)) return fail("S11", "no list of the user's other wallets");
  const given = c.req.links;
  const held = c.req.heldMints ?? [];
  if (!Array.isArray(held) || !held.every(isAddress)) return fail("S11", "the held mints must be addresses");
  const links = given instanceof SolanaWalletLinks && given.holds(others) ? given : new SolanaWalletLinks(others);
  links.add([c.req.token, ...held, ...c.keys]);
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
  const mine = walletAccountsOf(c);
  if (typeof mine === "string") return fail("S11", mine);
  const size = newSize(c);
  if (typeof size === "string") return fail("S11", `no size for the wallet's account of the token: ${size}`);
  for (const [p, sim] of c.reads.simulations.entries()) {
    const at = p === 0 ? "A" : "B";
    if (!sim) { wrong.push(`no simulation on provider ${at}`); continue; }
    if (sim.err !== null) { wrong.push(`provider ${at}: simulation error ${JSON.stringify(sim.err)}`); continue; }
    const moved = nativeOutOf(sim, mine, c, size);
    for (const x of moved.wrong) wrong.push(`provider ${at}: ${x}`);
    const nativeOut = moved.out;
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
  const mine = walletAccountsOf(c);
  if (typeof mine === "string") return null;
  // the out alone (the size decides only what nativeOutOf finds wrong, which S11 reads)
  const outs = c.reads.simulations.map((s) =>
    !s || s.err !== null ? null : c.req.side === "buy" ? s.tokenAccount.post - s.tokenAccount.pre : -nativeOutOf(s, mine, c, -1).out + fees + SOLANA_SENDER_TIP + SOLANA_JITO_TIP,
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
    c = { req, reads, tx, keys: keys.map((k) => k.key), writable: [...new Set(keys.filter((k) => k.writable).map((k) => k.key))], ixs, tokenProgram, route, routeError, jupAt: jup.length === 1 ? ixs.indexOf(jup[0] as Ix) : -1 };
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
deepFreeze(SOLANA_CLOSE_VOLUME_ACCUMULATOR);
// The cashback claims, from the same IDLs (re-read 2026-11-08 04:27Z at slots 466780585 and 466780591 on
// api.mainnet-beta.solana.com, account data sha256 unchanged), no args each:
// - PumpSwap claim_cashback: user (writable), user_volume_accumulator (writable), quote_mint, quote_token_program,
//   user_volume_accumulator_wsol_token_account (writable, ATA(the volume account, quote_mint)), user_wsol_token_account
//   (writable, ATA(user, quote_mint), which must already exist: AccountNotInitialized 3012 otherwise, simulated on
//   GATRKVEP… 2026-11-08 04:29Z), system_program, event_authority, program.
// - pump claim_cashback_v2: user (writable), user_volume_accumulator (writable), quote_mint, quote_token_program,
//   associated_token_program, associated_user_volume_accumulator (writable, ATA(the volume account, quote_mint)),
//   associated_quote_user (writable; the IDL: "any token account of quote_mint owned by user"; the device takes only
//   ATA(user, quote_mint)), system_program, event_authority, program.
// close_user_volume_accumulator does not check for owed cashback: simulated on 12FzhSyn… (owed 12,742,862) it closes
// the account and leaves the WSOL in an account whose owner is gone. So a claim rides in the same frame as its close,
// right before it.
export const SOLANA_CLAIM_CASHBACK: readonly number[] = [37, 58, 35, 126, 190, 53, 228, 197];
deepFreeze(SOLANA_CLAIM_CASHBACK);
export const SOLANA_CLAIM_CASHBACK_V2: readonly number[] = [122, 243, 204, 65, 94, 116, 29, 55];
deepFreeze(SOLANA_CLAIM_CASHBACK_V2);
/** Pump's stable quote mint (its Global's whitelisted_quote_mints, one entry: USDC, read at slot 466781223), SPL Token. */
export const SOLANA_PUMP_STABLE_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOLANA_VOLUME_PROGRAMS: readonly string[] = [SOLANA_PUMP_PROGRAM, SOLANA_PUMP_AMM_PROGRAM];
deepFreeze(SOLANA_VOLUME_PROGRAMS);
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
 * 13,396 per volume close; 13,413 to open a WSOL account and 19,851 for PumpSwap's claim_cashback (12FzhSyn…).
 */
export const SOLANA_TEARDOWN_CU = { budget: 300, close: 6_000, harvest: 8_000, volume: 25_000, open: 25_000, claim: 40_000 } as const;
deepFreeze(SOLANA_TEARDOWN_CU);
const TOKEN_ACCOUNT_LEN = 165;
/** The most lamports an account a claim opens may hold after its frame: 2,039,280, a 165-byte account's rent at the older
 *  rate ((128 + 165) x 3,480 x 2). A cap, not the rate: mainnet's rent for 165 bytes reads 1,488,440 ((128 + 165) x
 *  5,080, packages/wallet/src/pool/balances.ts, 5 Nov), and whatever an open takes over real rent stays in the wallet's
 *  own account, which only the wallet can close. */
const SOLANA_TOKEN_ACCOUNT_RENT_MAX = 2_039_280n;

/** One account as a provider answered it (getMultipleAccounts, base64). */
export type SolanaHeldRead = { owner: string; lamports: bigint; data: Uint8Array };
export type SolanaHeld =
  | { kind: "token"; address: string; program: string; mint: string; native: boolean; harvest: boolean; lamports: bigint }
  | { kind: "volume"; address: string; program: string; lamports: bigint };
/**
 * One cashback claim: `amount` of `mint` from the volume account's own account `from` to the wallet's `to`, opened
 * first when `open` (it does not exist), closed to the wallet right after when `unwrap` (WSOL: the claim comes back as
 * lamports). `fromAmount` and `toAmount` are the two accounts' token amounts as read.
 */
export type SolanaClaim = { program: string; uva: string; mint: string; from: string; to: string; amount: bigint; open: boolean; unwrap: boolean; fromAmount: bigint; toAmount: bigint };
/** `keep[].cashback`: the account stays open only for cashback a claim could not take this time (card sol-w-sweep: the
 *  wallet then keeps what that claim needs later, and nothing more). */
export type SolanaTeardownPlan = { close: SolanaHeld[]; claim: SolanaClaim[]; keep: { address: string; why: string; cashback?: true }[] };
/** The accounts a claim under `program` moves between: the volume account's and the wallet's, of the claim's mint. */
export function solanaCashbackAccounts(wallet: string, program: string): { uva: string; mint: string; from: string; to: string } {
  const mint = program === SOLANA_PUMP_AMM_PROGRAM ? SOLANA_SOL_MINT : SOLANA_PUMP_STABLE_MINT;
  const uva = solanaVolumeAccumulator(wallet, program);
  return { uva, mint, from: solanaAta(uva, mint, SOLANA_TOKEN_PROGRAM), to: solanaAta(wallet, mint, SOLANA_TOKEN_PROGRAM) };
}

/**
 * The addresses the wallet may hold after its trades: its account of each mint it traded (under that mint's program),
 * its wSOL account, its volume account under each pump program, then each claim's two accounts (the volume account's
 * WSOL or USDC account and the wallet's). The device reads exactly these on two providers.
 */
export function solanaTeardownAddresses(wallet: string, mints: readonly { mint: string; program: string }[]): string[] {
  const out = [solanaAta(wallet, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM), ...mints.map((m) => {
    if (!isToken(m.program)) throw new Error(`mint ${m.mint}: program ${m.program} is not Token or Token-2022`);
    return solanaAta(wallet, m.mint, m.program);
  }), ...SOLANA_VOLUME_PROGRAMS.map((p) => solanaVolumeAccumulator(wallet, p)), ...SOLANA_VOLUME_PROGRAMS.flatMap((p) => {
    const c = solanaCashbackAccounts(wallet, p);
    return [c.from, c.to];
  })];
  return [...new Set(out)];
}

/** What a claim of a wallet's volume account (its UserVolumeAccumulator data, owned by `owner`) pays out: PumpSwap's
 *  cashback (cashback_earned @74 over total_cashback_claimed @82, paid in WSOL) or pump's stable cashback
 *  (stable_cashback_earned @90 over total_stable_cashback_claimed @98, paid in USDC); 0n for any other owner or a
 *  shorter account. Pump's other cashback is paid from the account's own lamports, which its close returns. */
export function solanaVolumeClaimable(owner: string, v: Uint8Array): bigint {
  if (owner === SOLANA_PUMP_AMM_PROGRAM && v.length >= 90 && u64(v, 74) > u64(v, 82)) return u64(v, 74) - u64(v, 82);
  if (owner === SOLANA_PUMP_PROGRAM && v.length >= 106 && u64(v, 90) > u64(v, 98)) return u64(v, 90) - u64(v, 98);
  return 0n;
}
/**
 * What the teardown closes and what stays, from the device's own reads of the wallet's accounts on two providers.
 * Throws when the providers disagree on any account (the caller re-reads) or an address is not the wallet's.
 * `unclaimed`: claims off by pump program (solanaTeardownUnclaimed: the frame carrying the claims failed its simulation on
 * both providers); each volume account owed under a program named stays open with that program's reason, and every
 * other account, the other program's claim included, is planned as before.
 * A System-owned account with no data at one of the wallet's addresses (lamports anyone may send to an address not yet
 * made) is no account here: the wallet can neither close nor spend it, and the program that makes the account there
 * takes it as it is (review 5 of 38e59182, M1: such lamports at an unused volume address refused every plan).
 */
export function solanaTeardownPlan(wallet: string, given: Readonly<Record<string, readonly [SolanaHeldRead | null, SolanaHeldRead | null]>>, unclaimed?: SolanaTeardownUnclaimed): SolanaTeardownPlan {
  const none = (x: SolanaHeldRead | null): SolanaHeldRead | null => (x !== null && x.owner === SOLANA_SYSTEM_PROGRAM && x.data.length === 0 ? null : x);
  const accounts = Object.fromEntries(Object.entries(given).map(([k, [a, b]]) => [k, [none(a), none(b)] as const]));
  const plan: SolanaTeardownPlan = { close: [], claim: [], keep: [] };
  const volumes = new Map(SOLANA_VOLUME_PROGRAMS.map((p) => [solanaVolumeAccumulator(wallet, p), p]));
  const cash = new Map(SOLANA_VOLUME_PROGRAMS.map((p) => [p, solanaCashbackAccounts(wallet, p)]));
  // A volume account's own claim account: read, never closed (its owner is the volume account). Its token amount.
  const sources = new Map([...cash.values()].map((c) => [c.from, c]));
  const sourceAmount = new Map<string, bigint>();
  // What each volume account owes through a claim, and what else keeps it open.
  const owes = new Map<string, { program: string; amount: bigint; why: string; other: string[]; lamports: bigint }>();
  for (const [address, [a, b]] of Object.entries(accounts)) {
    if (!a !== !b || (a && b && (a.owner !== b.owner || a.lamports !== b.lamports || !eqBytes(a.data, b.data)))) throw new Error(`the providers disagree on ${address}`);
    if (!a) continue;
    const src = sources.get(address);
    if (src) {
      const d = a.data;
      if (a.owner !== SOLANA_TOKEN_PROGRAM || d.length !== TOKEN_ACCOUNT_LEN || base58.encode(d.subarray(0, 32)) !== src.mint || base58.encode(d.subarray(32, 64)) !== src.uva) throw new Error(`${address} is not the volume account's ${src.mint} account`);
      sourceAmount.set(address, d[108] === 1 ? u64(d, 64) : 0n);
      continue;
    }
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
      const other: string[] = [];
      if (v[40] !== 0 || u64(v, 41) > 0n) other.push(`unclaimed incentive tokens ${u64(v, 41)}`);
      if (u64(v, 57) > 0n) other.push(`volume ${u64(v, 57)} not settled`);
      // What a claim pays: PumpSwap's cashback (WSOL), pump's stable cashback (USDC); resolved after every read.
      const amount = solanaVolumeClaimable(a.owner, v);
      const amm = a.owner === SOLANA_PUMP_AMM_PROGRAM && amount > 0n;
      owes.set(address, { program: a.owner, amount, why: amm ? `cashback ${amount} unclaimed` : `stable cashback ${amount} unclaimed`, other, lamports: a.lamports });
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
  // Each volume account: its claim when it owes one and both of the claim's accounts can take it, then its close when
  // nothing else is owed. A claim that cannot run keeps the account open, so nothing owed is ever closed away.
  for (const [address, o] of owes) {
    const why = [...o.other];
    if (o.amount > 0n) {
      const c = cash.get(o.program) as ReturnType<typeof solanaCashbackAccounts>;
      const has = sourceAmount.get(c.from);
      const toRead = Object.hasOwn(accounts, c.to) ? (accounts[c.to] as readonly [SolanaHeldRead | null, SolanaHeldRead | null])[0] : undefined;
      const toClose = plan.close.find((h) => h.address === c.to);
      const toKept = plan.keep.find((k) => k.address === c.to);
      let stop: string | null = null;
      const off = unclaimed !== undefined && Object.hasOwn(unclaimed, o.program) ? unclaimed[o.program] : undefined;
      if (off !== undefined) stop = off;
      else if (has === undefined || has < o.amount) stop = `the volume account's ${c.mint} account holds ${has ?? "nothing read"}`;
      else if (toRead === undefined) stop = `${c.to} not read`;
      else if (toRead !== null && (toRead.owner !== SOLANA_TOKEN_PROGRAM || (o.program === SOLANA_PUMP_AMM_PROGRAM ? !toClose : toRead.data[108] !== 1))) stop = `${c.to} cannot take it${toKept ? ` (${toKept.why})` : ""}`;
      if (stop) why.push(`${o.why} (${stop})`);
      else {
        const toAmount = toRead ? u64(toRead.data, 64) : 0n;
        plan.claim.push({ program: o.program, uva: address, mint: c.mint, from: c.from, to: c.to, amount: o.amount, open: toRead === null, unwrap: o.program === SOLANA_PUMP_AMM_PROGRAM, fromAmount: has as bigint, toAmount });
        // The wallet's USDC account takes the stable cashback and keeps it: never closed in this teardown.
        if (o.program === SOLANA_PUMP_PROGRAM) {
          plan.close = plan.close.filter((h) => h.address !== c.to);
          if (!toKept) plan.keep.push({ address: c.to, why: `takes stable cashback ${o.amount} of ${c.mint}` });
        }
      }
    }
    if (why.length) plan.keep.push({ address, why: why.join(", "), ...(o.other.length === 0 && o.amount > 0n ? { cashback: true as const } : {}) });
    else plan.close.push({ kind: "volume", address, program: o.program, lamports: o.lamports });
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
  /** Each token account read after the frame, by address: its token amount, null when gone or not a token account. */
  amounts?: Readonly<Record<string, bigint | null>>;
};
export type SolanaTeardownReads = {
  /** solanaTeardownAddresses' accounts, read on provider A and B (null: no account). */
  accounts: Readonly<Record<string, readonly [SolanaHeldRead | null, SolanaHeldRead | null]>>;
  /** The wallet's own lamports on A and B, read with the accounts. */
  wallet: readonly [bigint, bigint];
  /** Per frame, in order: its simulation on provider A and B. */
  simulations: readonly (readonly [SolanaTeardownSimulation | null, SolanaTeardownSimulation | null])[];
  /** Claims off by program, with the reason each owed volume account stays open (solanaTeardownPlan's `unclaimed`). */
  unclaimed?: SolanaTeardownUnclaimed;
};
/** Claims off, by pump program: the reason each owed volume account under it stays open. */
export type SolanaTeardownUnclaimed = Readonly<Record<string, string>>;
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
    plan = solanaTeardownPlan(wallet, reads.accounts, reads.unclaimed);
    if (reads.wallet[0] !== reads.wallet[1]) throw new Error(`the providers disagree on the wallet's lamports: ${reads.wallet[0]}/${reads.wallet[1]}`);
  } catch (err) {
    return { ok: false, plan: null, results: [r("READ", false, (err as Error).message)] };
  }
  const byAddress = new Map(plan.close.map((h) => [h.address, h]));
  const claimOf = new Map(plan.claim.map((c) => [c.uva, c]));
  const unwrapOf = new Map(plan.claim.filter((c) => c.unwrap).map((c) => [c.to, c]));
  type Frame = { closes: string[]; claims: SolanaClaim[]; fee: bigint };
  const frames: Frame[] = [];
  const wrong: string[] = [];
  const closed = new Map<string, number>();
  const harvested = new Map<string, number>();
  const claimed = new Map<string, number>();
  const opened = new Map<string, number>();
  const unwrapped = new Map<string, number>();
  const isClose = (x: Ix) => isToken(x.program) && x.data.length === 1 && x.data[0] === 9;
  const isClaim = (x: Ix | undefined, c: SolanaClaim) => x?.program === c.program && eqBytes(x.data, Uint8Array.from(c.program === SOLANA_PUMP_AMM_PROGRAM ? SOLANA_CLAIM_CASHBACK : SOLANA_CLAIM_CASHBACK_V2));
  // A claim's accounts in the IDL's order (SOLANA_CLAIM_CASHBACK, SOLANA_CLAIM_CASHBACK_V2): the wallet's own only.
  const claimKeys = (c: SolanaClaim) => [wallet, c.uva, c.mint, SOLANA_TOKEN_PROGRAM, ...(c.program === SOLANA_PUMP_AMM_PROGRAM ? [] : [SOLANA_ATA_PROGRAM]), c.from, c.to, SOLANA_SYSTEM_PROGRAM, solanaEventAuthority(c.program), c.program];
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
      const claims: SolanaClaim[] = [];
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
        // The close of the wallet's WSOL account a claim pays into: right after that claim, to the wallet.
        const uw = unwrapOf.get(a[0]?.key as string);
        if (isClose(ix) && uw) {
          if (ix.program !== SOLANA_TOKEN_PROGRAM || a.length !== 3 || a[1]?.key !== wallet || a[2]?.key !== wallet || !a[0]?.writable || !a[1]?.writable || !isClaim(ixs[k - 1], uw)) { wrong.push(`${at}: close of ${uw.to} not right after its claim`); continue; }
          if (byAddress.has(uw.to)) { closed.set(uw.to, (closed.get(uw.to) ?? 0) + 1); closes.push(uw.to); }
          else unwrapped.set(uw.to, (unwrapped.get(uw.to) ?? 0) + 1);
          continue;
        }
        // CreateIdempotent of the wallet's own account a claim pays into, when it has none, right before that claim.
        if (ix.program === SOLANA_ATA_PROGRAM) {
          const c = plan.claim.find((x) => x.to === a[1]?.key);
          const want = c && [wallet, c.to, wallet, c.mint, SOLANA_SYSTEM_PROGRAM, SOLANA_TOKEN_PROGRAM];
          if (!c || !want || d.length !== 1 || d[0] !== 1 || a.length !== 6 || !a.every((x, i) => x.key === want[i]) || !a[0]?.signer || !a[1]?.writable || !isClaim(ixs[k + 1], c)) { wrong.push(`${at}: open of ${a[1]?.key} (want only the wallet's own claim account, right before its claim)`); continue; }
          opened.set(c.to, (opened.get(c.to) ?? 0) + 1);
          continue;
        }
        if (SOLANA_VOLUME_PROGRAMS.includes(ix.program) && !eqBytes(d, Uint8Array.from(SOLANA_CLOSE_VOLUME_ACCUMULATOR))) {
          const c = claimOf.get(solanaVolumeAccumulator(wallet, ix.program));
          const want = c && claimKeys(c);
          const shape = !!want && a.length === want.length && a.every((x, i) => x.key === want[i]) && a[0]?.writable && a[1]?.writable && a[want.length - 5]?.writable && a[want.length - 4]?.writable;
          if (!c || !isClaim(ix, c) || !shape) { wrong.push(`${at}: ${ix.program} instruction ${hex(d)} (no claim of the plan's, to ${a.map((x) => x.key).join(",")})`); continue; }
          claimed.set(c.uva, (claimed.get(c.uva) ?? 0) + 1);
          claims.push(c);
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
          const owed = claimOf.get(uva);
          if (owed && !claims.includes(owed)) { wrong.push(`${at}: close of ${uva} before its claim in this frame`); continue; }
          closed.set(uva, (closed.get(uva) ?? 0) + 1);
          closes.push(uva);
          continue;
        }
        wrong.push(`${at}: program ${ix.program} instruction ${hex(d)}`);
      }
      const fee = SOLANA_LAMPORTS_PER_SIGNATURE * BigInt(tx.signatures) + (price * BigInt(limit ?? 0) + 999_999n) / 1_000_000n;
      // A frame closes something, and asks no more compute than its instructions are allowed.
      const cuOf = (x: Ix) => (x.program === SOLANA_COMPUTE_BUDGET_PROGRAM ? 0 : x.program === SOLANA_ATA_PROGRAM ? SOLANA_TEARDOWN_CU.open : SOLANA_VOLUME_PROGRAMS.includes(x.program) ? (eqBytes(x.data, Uint8Array.from(SOLANA_CLOSE_VOLUME_ACCUMULATOR)) ? SOLANA_TEARDOWN_CU.volume : SOLANA_TEARDOWN_CU.claim) : x.data[0] === 26 ? SOLANA_TEARDOWN_CU.harvest : SOLANA_TEARDOWN_CU.close);
      const cap = 2 * SOLANA_TEARDOWN_CU.budget + ixs.reduce((n, x) => n + cuOf(x), 0);
      if (closes.length === 0 && claims.length === 0) wrong.push(`frame ${f}: closes nothing`);
      if (limit === null || limit > cap) wrong.push(`frame ${f}: compute limit ${limit ?? "unset"} (want at most ${cap})`);
      frames.push({ closes, claims, fee });
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
  for (const c of plan.claim) {
    if ((claimed.get(c.uva) ?? 0) !== 1) cover.push(`${c.uva}'s cashback claimed ${claimed.get(c.uva) ?? 0} times (want 1)`);
    if ((opened.get(c.to) ?? 0) !== (c.open ? 1 : 0)) cover.push(`${c.to} opened ${opened.get(c.to) ?? 0} times (want ${c.open ? 1 : 0})`);
    if (c.unwrap && c.open && (unwrapped.get(c.to) ?? 0) !== 1) cover.push(`${c.to} closed ${unwrapped.get(c.to) ?? 0} times after its claim (want 1)`);
  }
  const sim: string[] = [];
  if (reads.simulations.length !== frames.length) sim.push(`${reads.simulations.length} simulations for ${frames.length} frames`);
  for (const [f, fr] of frames.entries()) {
    // The wallet gains the lamports of what the frame closes and every WSOL claim, less the fee and the rent of a
    // USDC account the frame opens for a claim (that account the wallet's own, holding the claim).
    const gain = fr.closes.reduce((s, x) => s + (byAddress.get(x) as SolanaHeld).lamports, 0n) + fr.claims.reduce((s, c) => s + (c.unwrap ? c.amount : 0n), 0n);
    for (const [p, s] of (reads.simulations[f] ?? [null, null]).entries()) {
      const at = `frame ${f} provider ${p === 0 ? "A" : "B"}`;
      if (!s) { sim.push(`${at}: no simulation`); continue; }
      if (s.err !== null) { sim.push(`${at}: simulation error ${JSON.stringify(s.err)}`); continue; }
      const gone = [...fr.closes, ...fr.claims.filter((c) => c.unwrap && c.open).map((c) => c.to)];
      for (const x of gone) {
        const post = Object.hasOwn(s.accounts, x) ? s.accounts[x] : undefined;
        if (post === undefined) sim.push(`${at}: ${x} not read after`);
        else if (post !== null && post !== 0n) sim.push(`${at}: ${x} still holds ${post} lamports`);
      }
      let rent = 0n;
      for (const c of fr.claims) {
        const from = s.amounts && Object.hasOwn(s.amounts, c.from) ? s.amounts[c.from] : undefined;
        if (from !== c.fromAmount - c.amount) sim.push(`${at}: ${c.from} holds ${from ?? "nothing read"} after the claim (want ${c.fromAmount - c.amount})`);
        if (c.unwrap) continue;
        const to = s.amounts && Object.hasOwn(s.amounts, c.to) ? s.amounts[c.to] : undefined;
        if (to !== c.toAmount + c.amount) sim.push(`${at}: ${c.to} holds ${to ?? "nothing read"} after the claim (want ${c.toAmount + c.amount})`);
        const lam = Object.hasOwn(s.accounts, c.to) ? s.accounts[c.to] : undefined;
        if (c.open) {
          if (typeof lam !== "bigint" || lam > SOLANA_TOKEN_ACCOUNT_RENT_MAX) sim.push(`${at}: ${c.to} opened with ${lam ?? "nothing read"} lamports (want at most ${SOLANA_TOKEN_ACCOUNT_RENT_MAX})`);
          else rent += lam;
        }
      }
      if (s.wallet - reads.wallet[0] !== gain - fr.fee - rent) sim.push(`${at}: the wallet gains ${s.wallet - reads.wallet[0]} (want ${gain} less the fee ${fr.fee}${rent ? ` and the rent ${rent}` : ""})`);
    }
  }
  const results = [
    r("READ", true, `${plan.close.length} to close, ${plan.keep.length} stay${plan.keep.length ? ` (${plan.keep.map((k) => `${k.address}: ${k.why}`).join("; ")})` : ""}`),
    r("DECODE", true, `${frames.length} frame(s)`),
    r("FRAME", wrong.length === 0, wrong.join("; ") || "only closes to the wallet, harvests right before their close, claims to the wallet right before their close, and the compute budget"),
    r("COVER", cover.length === 0, cover.join("; ") || `every one of ${plan.close.length} closed once, every one of ${plan.claim.length} claims once`),
    r("SIM", sim.length === 0, sim.join("; ") || "every frame clean on both providers, every closed account gone, every claim paid in full to the wallet, every lamport back less the fee"),
  ];
  return { ok: results.every((x) => x.ok), plan, results };
}

/**
 * Whether a refused teardown goes again with claims off, and for which pump programs, with the reason each owed volume
 * account then stays open (review M1 of 11c963f9). Only when every check passed but SIM, the plan claims something, every
 * frame before the last simulates clean on both providers and the last, which carries the claims, errs on both: a
 * program's refusal (a layout it no longer takes, cashback switched off, more compute than its budget) shows on both,
 * a provider's lag or a hostile provider on one, and that stays a refusal the caller reads again. The program off is
 * the one whose instruction both providers name as failing, when that is a claim's (review L1: a failing claim keeps
 * only its own account open); otherwise every claim's. `already`: the programs a previous try turned off, kept. With
 * claims off nothing owed is closed away; the caller keeps the wallet owed, so a later pass claims it. Null otherwise.
 */
export function solanaTeardownUnclaimed(v: SolanaTeardownVerdict, wires: readonly Uint8Array[], simulations: SolanaTeardownReads["simulations"], already: SolanaTeardownUnclaimed = {}): SolanaTeardownUnclaimed | null {
  if (v.ok || !v.plan || v.plan.claim.length === 0 || v.results.some((x) => !x.ok && x.id !== "SIM")) return null;
  if (wires.length === 0 || simulations.length !== wires.length) return null;
  const clean = (s: SolanaTeardownSimulation | null): boolean => s !== null && s.err === null;
  const errs = (s: SolanaTeardownSimulation | null): boolean => s !== null && s.err !== null && s.err !== undefined;
  if (!simulations.slice(0, -1).every(([a, b]) => clean(a) && clean(b))) return null;
  const [a, b] = simulations.at(-1)!;
  if (!errs(a) || !errs(b)) return null;
  const err = (s: SolanaTeardownSimulation): string => {
    try {
      return JSON.stringify(s.err).slice(0, 120);
    } catch {
      return "an error";
    }
  };
  // the instruction each provider names as failing, by its program
  let failing: readonly [string | null, string | null];
  try {
    const m = solanaDecodeTransaction(wires.at(-1)!).message;
    const at = (s: SolanaTeardownSimulation): string | null => {
      const e = (s.err as { InstructionError?: unknown } | null)?.InstructionError;
      const i = Array.isArray(e) ? e[0] : undefined;
      const x = typeof i === "number" && Number.isSafeInteger(i) ? m.instructions[i] : undefined;
      return x ? (m.staticKeys[x.programIndex] ?? null) : null;
    };
    failing = [at(a!), at(b!)];
  } catch {
    failing = [null, null];
  }
  const claimed = [...new Set(v.plan.claim.map((c) => c.program))];
  const [fa, fb] = failing;
  const one = typeof fa === "string" && fa === fb && claimed.includes(fa) ? fa : null;
  const why = `its claim did not simulate on either provider: A ${err(a!)}, B ${err(b!)}`;
  const off: Record<string, string> = { ...already };
  for (const p of one === null ? claimed : [one]) off[p] = why;
  return off;
}
