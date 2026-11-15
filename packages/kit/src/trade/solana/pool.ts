// The device's on-chain reference E for a Solana trade (markets paper S12 and §2.0 LD1, docs/plan1/markets.md l.92 and
// l.382; T1.3 step 1, l.227-229). Device side, keyless: it reads the token's pools on two providers, never one alone,
// and computes what an exact input pays out of them, net of every fee, as the program pays it. Nothing here comes from
// the route, the helper or market data.
//
// - Candidates, from the chain only: the pump.fun bonding curve PDA of the mint and the PumpSwap canonical pool PDA of
//   the mint (quoted in WSOL). A complete curve is not a candidate. Each venue's accounts are read in one
//   getMultipleAccounts at `confirmed` (card sol-pool-buy-tx F7), base64, on both providers: two calls per provider, one per venue, since
//   solana-rpc.publicnode.com takes at most 10 accounts in one call, so each candidate rests on one slot per provider.
// - Agree: static accounts byte-equal on both (the mint, pump's Global, both fee configs, the PumpSwap GlobalConfig,
//   the curve and the pool with their moving fields masked); each reserve (the curve's virtual token and SOL
//   reserves and its own token account's balance, the pool's two vault balances and its quote reserve, the quote vault
//   plus virtual_quote_reserves) within SOLANA_POOL_READ_TOL_BPS of
//   each other. A candidate that does not agree is read once more on both; if it still does not agree the route is
//   refused (null): it is never priced on the candidates left.
// - The set: depth = the quote-side (SOL) reserve; cutoff = (1 − 200 / 10,000) × the largest, over the candidates, of
//   min(depth on A, depth on B); every candidate whose depth on either provider is at or above the cutoff is in the
//   set. E = the largest E over the set, each candidate's from its larger-output read. So a provider that lies inside
//   the band can only raise the bar, and one that inflates a pool's depth cannot lift the cutoff over an honest pool.
// - No candidate: null ("no reference pool").
// - Per leg (S12 over a split trade): the request's optional `amounts` a_k get E(a_k) in `expectedOuts`, computed from
//   the same reads, the same chosen pool and the same provider read that gave `expectedOut` for the whole `amount`,
//   with no extra RPC. The simulated-out bar of leg k uses E(a_k) from the same read; its minOut keeps
//   E_k = floor(E(A) × a_k / A).
//
// Every RPC answer is hostile: size-bounded, shape-checked, owner and discriminator checked; an answer that fails a
// check is no answer.
//
// Sources, each read 2026-11-02 between 08:36Z and 08:45Z (date -u):
//  - Account layouts and discriminators: the programs' on-chain Anchor IDLs (account data after a 44-byte header, zlib
//    JSON), read on api.mainnet-beta.solana.com and solana-rpc.publicnode.com with the same bytes on both: pump's at
//    AYgC53tU5BbP2NAnv5nConJxAdpQZctvmZK88pu69xRs (slot 464431643, data sha256 5a8e78dd…f5a9, JSON sha256
//    ec3618ee…6b6a: BondingCurve, Global, FeeConfig) and PumpSwap's at 5fLnXNNoZcZt9Qku6HARM3un3Ttm2cGsR7gN9Zp1R7h3
//    (slot 464431641, data sha256 d7202589…b9d3, JSON sha256 e16ac800…0ff4: Pool, GlobalConfig, FeeConfig; its
//    create_pool names the pool's vaults as the pool's associated token accounts). The fields the on-chain IDLs do not
//    list yet (the curve's trailing accumulators; the pool's virtual_quote_reserves, creator_fee_bps, protocol_fees and
//    creator_fees; GlobalConfig's boost fields and creator_fee_configurable) are from the IDLs inside the published
//    SDKs below. A field past the end of a shorter (older) account reads as zero, as pump's own README says of
//    fields appended by later upgrades.
//  - Curve math: @pump-fun/pump-sdk 4.3.1 (npm tarball sha256 c8ff4e85…a4641), src/bondingCurve.ts
//    getBuyV3TokenAmountFromQuoteAmount with its crossing branch and poolToBe, v3ExactQuoteInNet, v3BuyDebit,
//    v3Rates, getBuyTokenAmountFromSolAmountQuote, getBuySolAmountFromTokenAmountQuote,
//    getSellSolAmountFromTokenAmount; src/onlineSdk.ts fetchBuyState (the curve's token account under either token
//    program); src/state.ts Global (pool_migration_fee after enable_migrate); src/fees.ts computeFeesBps, selectCurveFeeSchedule, calculateFeeTier, fee (ceil).
//  - PumpSwap math: @pump-fun/pump-swap-sdk 2.2.0 (npm, published 2026-10-19, tarball sha256
//    b3afc4bcb1cca18c4460c3f41c08be8022bf44b4d6f7de22fac28b7c3edf2a57; a source, not a dependency of the kit),
//    src/sdk/buy.ts buyQuoteInput, src/sdk/sell.ts sellBaseInput and sellAmounts, src/sdk/fees.ts computeFeesBps and
//    feesForQuoteMint, src/sdk/util.ts fee (ceil) and poolMarketCap, src/sdk/pda.ts (the PDAs below).
import { base58, base64 } from "@scure/base";
import { solanaAta, solanaProgramAddress } from "../../checks/solana/message.ts";
import {
  SOLANA_PUMP_AMM_PROGRAM,
  SOLANA_PUMP_PROGRAM,
  SOLANA_SOL_MINT,
  SOLANA_SYSTEM_PROGRAM,
  SOLANA_TOKEN_2022_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  solanaMintDisagreement,
} from "../../checks/solana/checks.ts";
import { solanaSameProvider, solanaTimedRpc, type SolanaRpc } from "./send.ts";
import {
  SOLANA_CLOCK_SYSVAR,
  SOLANA_DLMM_MAX_PAIRS,
  SOLANA_DLMM_PAIR_MOVING,
  solanaCoinTransferFee,
  solanaDecodeClock,
  solanaDecodeDlmmBinArray,
  solanaDecodeDlmmPair,
  solanaDlmmArrayIndexes,
  solanaDlmmBinArray,
  solanaDlmmModes,
  solanaDlmmSide,
  solanaDlmmSwapForY,
  solanaDlmmTokenProgram,
  solanaDlmmTradeOut,
  type SolanaDlmmBinArray,
  type SolanaDlmmPair,
  type SolanaTransferFee,
} from "./dlmm.ts";
import {
  SOLANA_CPMM_AUTHORITY,
  SOLANA_CPMM_MAX_POOLS,
  SOLANA_CPMM_POOL_MOVING,
  solanaCpmmLive,
  solanaCpmmSide,
  solanaCpmmTradeOut,
  solanaDecodeCpmmConfig,
  solanaDecodeCpmmPool,
  type SolanaCpmmPool,
} from "./cpmm.ts";
import {
  SOLANA_AMM_V4_AUTHORITY,
  SOLANA_AMM_V4_MAX_POOLS,
  SOLANA_AMM_V4_POOL_MOVING,
  solanaAmmV4Live,
  solanaAmmV4Side,
  solanaAmmV4TradeOut,
  solanaDecodeAmmV4Pool,
  type SolanaAmmV4Pool,
} from "./amm-v4.ts";

/** §2.0 LD1's band between two providers' reads of one reserve. */
export const SOLANA_POOL_READ_TOL_BPS = 200;
export const SOLANA_PUMP_FEES_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
/** The Token-2022 native mint: SOL-like for pump's fee schedule (pump-swap-sdk fees.ts SOL_LIKE_QUOTE_MINTS). */
const NATIVE_MINT_2022 = "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP";
const SOL_LIKE = new Set([SOLANA_SYSTEM_PROGRAM, SOLANA_SOL_MINT, NATIVE_MINT_2022]); // the zero key is the System id
/** pump-sdk fees.ts ONE_BILLION_SUPPLY, pump-swap-sdk util.ts PUMP_AMM_TOTAL_TOKEN_SUPPLY. */
const ONE_BILLION_SUPPLY = 1_000_000_000_000_000n;
/** One read is given up after this. */
const READ_TIMEOUT_MS = 5_000;
/** An account larger than this is refused unread (the largest read here, pump's Global, is 1,088 bytes). */
const MAX_ACCOUNT_BYTES = 16 * 1024;
const MAX_FEE_TIERS = 64;
const U64_MAX = (1n << 64n) - 1n;

const DISC = {
  bondingCurve: [23, 183, 248, 55, 96, 216, 172, 96],
  global: [167, 232, 232, 177, 200, 108, 114, 127],
  feeConfig: [143, 52, 146, 187, 219, 123, 76, 155],
  pool: [241, 154, 109, 4, 17, 177, 109, 188],
  globalConfig: [149, 8, 156, 202, 160, 252, 176, 217],
} as const;

/** A venue the pool buy trades and the reference prices: pump's curve, PumpSwap's canonical pool, a Meteora DLMM pair
 *  (dlmm.ts), a Raydium CPMM pool (cpmm.ts), a Raydium AMM v4 pool (amm-v4.ts). The pump venues are found from the
 *  mint; a DLMM pair from the request's `dlmmPairs`, a CPMM pool from its `cpmmPools`, an AMM v4 pool from its
 *  `ammV4Pools`. */
export type SolanaPoolVenue = "pump-curve" | "pumpswap" | "dlmm" | "raydium-cpmm" | "raydium-amm-v4";
export type SolanaReferenceVenue = SolanaPoolVenue;
export type SolanaReference = {
  expectedOut: bigint;
  /** E(a_k) for each of the request's `amounts`, in order, from the read that gave `expectedOut`; [] without them. */
  expectedOuts: bigint[];
  spotOut: bigint | null;
  /** `cashback`: the coin's is_cashback_coin as the venue's own account holds it (the curve's byte 82, the PumpSwap
   *  pool's byte 244, solanaPumpSwapCashback), the flag the sale's venue read takes too; absent when not read. For a
   *  preview's bound only (card app-sell-shows-what-you-receive): no check before signing reads it. */
  pools: { venue: SolanaReferenceVenue; address: string; depth: readonly [bigint, bigint]; expectedOut: bigint; cashback?: boolean }[];
  /** The oldest slot of the reads it rests on (readSolanaReference), so a check can bound its age. */
  slot?: number;
};
/** `dlmmPairs`: the coin's Meteora DLMM pairs, as readSolanaDlmmPairs lists them from the chain (at most
 *  SOLANA_DLMM_MAX_PAIRS); `cpmmPools`: its Raydium CPMM pools, as readSolanaCpmmPools lists them (at most
 *  SOLANA_CPMM_MAX_POOLS); `ammV4Pools`: its Raydium AMM v4 pools, as readSolanaAmmV4Pools lists them (at most
 *  SOLANA_AMM_V4_MAX_POOLS). Each is read and judged here on both providers like any other candidate. */
export type SolanaReferenceRequest = {
  side: "buy" | "sell"; token: string; amount: bigint; amounts?: readonly bigint[];
  dlmmPairs?: readonly string[]; cpmmPools?: readonly string[]; ammV4Pools?: readonly string[];
};
/** The most legs one request prices. */
const MAX_LEGS = 64;

// ------------------------------------------------------------------------------------------------- addresses

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const PUMP_GLOBAL = solanaProgramAddress([enc("global")], SOLANA_PUMP_PROGRAM);
const PUMP_FEE_CONFIG = solanaProgramAddress([enc("fee_config"), base58.decode(SOLANA_PUMP_PROGRAM)], SOLANA_PUMP_FEES_PROGRAM);
const AMM_GLOBAL_CONFIG = solanaProgramAddress([enc("global_config")], SOLANA_PUMP_AMM_PROGRAM);
const AMM_FEE_CONFIG = solanaProgramAddress([enc("fee_config"), base58.decode(SOLANA_PUMP_AMM_PROGRAM)], SOLANA_PUMP_FEES_PROGRAM);

/** The accounts the reference reads for a mint: `curveList` and `poolList`, each in the order of its own
 * getMultipleAccounts call (6 and 7 accounts; solana-rpc.publicnode.com takes at most 10 in one call). */
export function solanaPoolAddresses(mint: string): {
  mint: string; curve: string; pumpGlobal: string; pumpFeeConfig: string; curveBaseToken: string; curveBaseToken2022: string;
  poolAuthority: string; pool: string; ammGlobalConfig: string; ammFeeConfig: string; baseVaultToken: string;
  baseVaultToken2022: string; quoteVault: string; curveList: string[]; poolList: string[];
} {
  const m = base58.decode(mint);
  if (m.length !== 32) throw new Error("the token is not a 32-byte address");
  const curve = solanaProgramAddress([enc("bonding-curve"), m], SOLANA_PUMP_PROGRAM);
  const poolAuthority = solanaProgramAddress([enc("pool-authority"), m], SOLANA_PUMP_PROGRAM);
  // pump-swap-sdk pda.ts canonicalPumpPoolPda: poolPda(index 0 as u16 LE, the pump pool authority, mint, WSOL)
  const pool = solanaProgramAddress([enc("pool"), Uint8Array.of(0, 0), base58.decode(poolAuthority), m, base58.decode(SOLANA_SOL_MINT)], SOLANA_PUMP_AMM_PROGRAM);
  const a = {
    mint, curve, pumpGlobal: PUMP_GLOBAL, pumpFeeConfig: PUMP_FEE_CONFIG,
    // the curve's own token account for the mint, under either token program (pump-sdk fetchBuyState reads both)
    curveBaseToken: solanaAta(curve, mint, SOLANA_TOKEN_PROGRAM), curveBaseToken2022: solanaAta(curve, mint, SOLANA_TOKEN_2022_PROGRAM),
    poolAuthority, pool,
    ammGlobalConfig: AMM_GLOBAL_CONFIG, ammFeeConfig: AMM_FEE_CONFIG,
    baseVaultToken: solanaAta(pool, mint, SOLANA_TOKEN_PROGRAM),
    baseVaultToken2022: solanaAta(pool, mint, SOLANA_TOKEN_2022_PROGRAM),
    quoteVault: solanaAta(pool, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM),
  };
  return {
    ...a,
    curveList: [a.mint, a.curve, a.pumpGlobal, a.pumpFeeConfig, a.curveBaseToken, a.curveBaseToken2022],
    poolList: [a.mint, a.pool, a.ammGlobalConfig, a.ammFeeConfig, a.baseVaultToken, a.baseVaultToken2022, a.quoteVault],
  };
}

// ------------------------------------------------------------------------------------------------- decoders

/** One account as a provider answered it. */
export type SolanaPoolAccount = { owner: string; data: Uint8Array };

// A field past the end of a shorter account reads as zero; a field cut in the middle is malformed.
function need(d: Uint8Array, o: number, n: number): boolean {
  if (o + n <= d.length) return true;
  if (o < d.length) throw new Error("account cut inside a field");
  return false;
}
const u8 = (d: Uint8Array, o: number): number => (need(d, o, 1) ? d[o]! : 0);
const bool = (d: Uint8Array, o: number): boolean => {
  const v = u8(d, o);
  if (v > 1) throw new Error(`bool byte ${v}`);
  return v === 1;
};
const u64 = (d: Uint8Array, o: number): bigint => (need(d, o, 8) ? new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true) : 0n);
const u128 = (d: Uint8Array, o: number): bigint => (need(d, o, 16) ? u64(d, o) + (u64(d, o + 8) << 64n) : 0n);
const i128 = (d: Uint8Array, o: number): bigint => BigInt.asIntN(128, u128(d, o));
const key = (d: Uint8Array, o: number): string => (need(d, o, 32) ? base58.encode(d.subarray(o, o + 32)) : SOLANA_SYSTEM_PROGRAM);
function disc(d: Uint8Array, want: readonly number[], name: string, min: number): void {
  if (d.length < min) throw new Error(`${name}: ${d.length} bytes, under ${min}`);
  for (let i = 0; i < 8; i++) if (d[i] !== want[i]) throw new Error(`${name}: wrong discriminator`);
}

/** An SPL Token or Token-2022 mint's supply (the base layout both share: supply u64 at 36, initialized at 45). */
export function solanaDecodeMint(acc: SolanaPoolAccount): { supply: bigint; program: string } {
  if (acc.owner !== SOLANA_TOKEN_PROGRAM && acc.owner !== SOLANA_TOKEN_2022_PROGRAM) throw new Error(`mint owned by ${acc.owner}`);
  if (acc.data.length < 82 || acc.data[45] !== 1) throw new Error("not an initialized mint");
  return { supply: u64(acc.data, 36), program: acc.owner };
}

/** A token account: mint at 0, owner at 32, amount at 64, state at 108 (1 initialized, 2 frozen). An account longer than
 * the base 165 bytes (Token-2022 with extensions) must carry AccountType::Account (2) at byte 165, so a Token-2022
 * mint, padded to 165 and typed 1 there, is never read as a token account. */
export function solanaDecodeTokenAccount(acc: SolanaPoolAccount): { mint: string; owner: string; amount: bigint; state: number } {
  if (acc.owner !== SOLANA_TOKEN_PROGRAM && acc.owner !== SOLANA_TOKEN_2022_PROGRAM) throw new Error(`token account owned by ${acc.owner}`);
  if (acc.data.length < 165) throw new Error("token account too short");
  if (acc.data.length > 165 && acc.data[165] !== 2) throw new Error(`not a token account: account type ${acc.data[165]}`);
  const state = acc.data[108]!;
  if (state !== 1 && state !== 2) throw new Error(`token account state ${state}`);
  return { mint: key(acc.data, 0), owner: key(acc.data, 32), amount: u64(acc.data, 64), state };
}

export type SolanaBondingCurve = {
  virtualTokenReserves: bigint; virtualQuoteReserves: bigint; realTokenReserves: bigint; realQuoteReserves: bigint;
  tokenTotalSupply: bigint; complete: boolean; creator: string; isMayhemMode: boolean; isCashbackCoin: boolean; quoteMint: string; creatorFeeBps: bigint;
};
/** pump BondingCurve: reserves u64 at 8, 16, 24, 32, supply 40, complete 48, creator 49, mayhem 81, cashback 82,
 * quote_mint 83, creator_fee_bps 115 (later fields not used). */
export function solanaDecodeBondingCurve(acc: SolanaPoolAccount): SolanaBondingCurve {
  if (acc.owner !== SOLANA_PUMP_PROGRAM) throw new Error(`bonding curve owned by ${acc.owner}`);
  const d = acc.data;
  disc(d, DISC.bondingCurve, "BondingCurve", 49);
  return {
    virtualTokenReserves: u64(d, 8), virtualQuoteReserves: u64(d, 16), realTokenReserves: u64(d, 24), realQuoteReserves: u64(d, 32),
    tokenTotalSupply: u64(d, 40), complete: bool(d, 48), creator: key(d, 49), isMayhemMode: bool(d, 81), isCashbackCoin: bool(d, 82),
    quoteMint: key(d, 83), creatorFeeBps: u64(d, 115),
  };
}
/** The curve's bytes that move with each trade, masked before the providers' bytes are compared: the four reserves
 * (8..40, compared within the band instead) and the creator and protocol fee accumulators (125..141). */
const CURVE_MOVING: readonly (readonly [number, number])[] = [[8, 40], [125, 141]];

export type SolanaPumpGlobal = { feeBasisPoints: bigint; poolMigrationFee: bigint; creatorFeeBasisPoints: bigint; creatorFeeConfigurable: boolean };
/** pump Global: fee_basis_points at 105, withdraw_authority 113, enable_migrate 145, pool_migration_fee at 146,
 * creator_fee_basis_points at 154, creator_fee_configurable at 1045 (IDL order; pump-sdk state.ts Global). */
export function solanaDecodePumpGlobal(acc: SolanaPoolAccount): SolanaPumpGlobal {
  if (acc.owner !== SOLANA_PUMP_PROGRAM) throw new Error(`pump Global owned by ${acc.owner}`);
  disc(acc.data, DISC.global, "Global", 162);
  return { feeBasisPoints: u64(acc.data, 105), poolMigrationFee: u64(acc.data, 146), creatorFeeBasisPoints: u64(acc.data, 154), creatorFeeConfigurable: bool(acc.data, 1045) };
}

export type SolanaFees = { lpFeeBps: bigint; protocolFeeBps: bigint; creatorFeeBps: bigint };
export type SolanaFeeConfig = { flatFees: SolanaFees; feeTiers: { marketCapLamportsThreshold: bigint; fees: SolanaFees }[] };
/** pump-fees FeeConfig: bump 8, admin 9, flat_fees 41 (3 × u64), fee_tiers Vec at 65 (u32 count, then 40 bytes each:
 * threshold u128 and Fees). The stable and exotic schedules after it are not used: a SOL-quoted canonical curve or
 * pool pays fee_tiers (pump-swap-sdk fees.ts feesForQuoteMint). */
export function solanaDecodeFeeConfig(acc: SolanaPoolAccount): SolanaFeeConfig {
  if (acc.owner !== SOLANA_PUMP_FEES_PROGRAM) throw new Error(`fee config owned by ${acc.owner}`);
  const d = acc.data;
  disc(d, DISC.feeConfig, "FeeConfig", 69);
  const fees = (o: number): SolanaFees => ({ lpFeeBps: u64(d, o), protocolFeeBps: u64(d, o + 8), creatorFeeBps: u64(d, o + 16) });
  const n = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(65, true);
  if (n === 0 || n > MAX_FEE_TIERS || d.length < 69 + 40 * n) throw new Error(`FeeConfig: ${n} fee tiers`);
  const feeTiers = Array.from({ length: n }, (_, i) => ({ marketCapLamportsThreshold: u128(d, 69 + 40 * i), fees: fees(69 + 40 * i + 16) }));
  for (const t of [fees(41), ...feeTiers.map((t) => t.fees)]) {
    if (t.lpFeeBps + t.protocolFeeBps + t.creatorFeeBps >= 10_000n) throw new Error("FeeConfig: fees of 100% or more");
  }
  return { flatFees: fees(41), feeTiers };
}

export type SolanaPumpSwapPool = {
  index: number; creator: string; baseMint: string; quoteMint: string; baseVault: string; quoteVault: string;
  coinCreator: string; isMayhemMode: boolean; virtualQuoteReserves: bigint; creatorFeeBps: bigint; protocolFees: bigint; creatorFees: bigint;
};
/** PumpSwap Pool: bump 8, index u16 9, creator 11, base_mint 43, quote_mint 75, lp_mint 107, pool_base_token_account
 * 139, pool_quote_token_account 171, lp_supply 203, coin_creator 211, is_mayhem_mode 243, is_cashback_coin 244,
 * virtual_quote_reserves i128 245, creator_fee_bps 261, can_edit 269, is_holder_reward 270, protocol_fees 271,
 * creator_fees 279. */
/** The PumpSwap Pool's is_cashback_coin (byte 244): true or false, null when the byte is not a bool or not there. The
 *  one parse of it: the sale's venue read (pool-buy.ts readSolanaPoolBuyVenue) refuses a null, the reference names the
 *  flag (SolanaReference pools[].cashback) only when it is one. */
export function solanaPumpSwapCashback(d: Uint8Array): boolean | null {
  const v = d.length > 244 ? d[244] : undefined;
  return v === 0 ? false : v === 1 ? true : null;
}
export function solanaDecodePumpSwapPool(acc: SolanaPoolAccount): SolanaPumpSwapPool {
  if (acc.owner !== SOLANA_PUMP_AMM_PROGRAM) throw new Error(`pool owned by ${acc.owner}`);
  const d = acc.data;
  disc(d, DISC.pool, "Pool", 245);
  return {
    index: new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(9, true), creator: key(d, 11), baseMint: key(d, 43), quoteMint: key(d, 75),
    baseVault: key(d, 139), quoteVault: key(d, 171), coinCreator: key(d, 211), isMayhemMode: bool(d, 243),
    virtualQuoteReserves: i128(d, 245), creatorFeeBps: u64(d, 261), protocolFees: u64(d, 271), creatorFees: u64(d, 279),
  };
}
/** The pool's fields that move with each trade, masked before the providers' bytes are compared, each exactly one field
 * of the Pool layout in @pump-fun/pump-swap-sdk 2.2.0, the npm tarball pump-swap-sdk-2.2.0.tgz (sha256
 * b3afc4bcb1cca18c4460c3f41c08be8022bf44b4d6f7de22fac28b7c3edf2a57, read 11 Nov; the source of the layout, not a
 * dependency of the kit), dist/index.js: the Pool struct from line 10512 and POOL_SIZE 287 at line 11964.
 * virtual_quote_reserves (i128, 245..261) is held instead in the quote reserve's band; protocol_fees and creator_fees
 * (u64 each, 271..287) are each provider's own, as its read is priced on them (a sell's real quote reserve). The
 * tarball's README.md (v2 migration notes): "every v2 accrual is subtracted from" virtual_quote_reserves, which the fee
 * buckets add. The recorded pairs in scripts/live-checks/solana-mint-supply-moves.answers.json (good and slotApart, 40
 * rounds, each pool read on both providers; its test reads them all) differ only inside these two masks. The one pair
 * that moved is slotApart's round 10 (bytes 245-247 and 271-273): A at slot 467915586 and B at 467915587
 * (9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump), virtual_quote_reserves -14063185 and -14367986, protocol_fees
 * 6007858 and 6312659. A wider census read on 11 Nov 00:03-00:22Z, on three pools, was not kept. */
const POOL_MOVING: readonly (readonly [number, number])[] = [[245, 261], [271, 287]];

export type SolanaPumpSwapConfig = { lpFeeBps: bigint; protocolFeeBps: bigint; coinCreatorFeeBps: bigint; disableFlags: number; creatorFeeConfigurable: boolean };
/** PumpSwap GlobalConfig: admin 8, lp_fee_basis_points 40, protocol_fee_basis_points 48, disable_flags 56 (bit 3 buy,
 * bit 4 sell), protocol_fee_recipients 57, coin_creator_fee_basis_points 313, ..., buyback_basis_points 899,
 * boost_authority 907, boost_enabled 939, creator_fee_configurable 940. */
export function solanaDecodePumpSwapConfig(acc: SolanaPoolAccount): SolanaPumpSwapConfig {
  if (acc.owner !== SOLANA_PUMP_AMM_PROGRAM) throw new Error(`GlobalConfig owned by ${acc.owner}`);
  disc(acc.data, DISC.globalConfig, "GlobalConfig", 321);
  return {
    lpFeeBps: u64(acc.data, 40), protocolFeeBps: u64(acc.data, 48), disableFlags: acc.data[56]!,
    coinCreatorFeeBps: u64(acc.data, 313), creatorFeeConfigurable: bool(acc.data, 940),
  };
}

// ------------------------------------------------------------------------------------------------- math

const ceilFee = (amount: bigint, bps: bigint): bigint => (amount * bps + 9_999n) / 10_000n;
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** pump-fees calculate_fee_tier: the first tier below the first threshold, else the last tier whose threshold the cap reaches. */
export function solanaFeeTier(cfg: SolanaFeeConfig, marketCap: bigint): SolanaFees {
  const first = cfg.feeTiers[0]!;
  if (marketCap < first.marketCapLamportsThreshold) return first.fees;
  for (let i = cfg.feeTiers.length - 1; i >= 0; i--) if (marketCap >= cfg.feeTiers[i]!.marketCapLamportsThreshold) return cfg.feeTiers[i]!.fees;
  return first.fees;
}

export type SolanaPoolOut = { out: bigint; spotOut: bigint | null };

/** The curve's rates (pump-sdk v3Rates and computeFeesBps): the fee_config tier at the market cap vQ × supply / vT
 * (supply 1e15 unless mayhem), the curve's own creator rate when Global allows it, none without a creator. */
export function solanaCurveRates(curve: SolanaBondingCurve, global: SolanaPumpGlobal, feeConfig: SolanaFeeConfig, mintSupply: bigint): { protocolFeeBps: bigint; creatorFeeBps: bigint } {
  if (curve.virtualTokenReserves === 0n) throw new Error("curve has no virtual token reserves");
  const supply = curve.isMayhemMode ? mintSupply : ONE_BILLION_SUPPLY;
  const tier = solanaFeeTier(feeConfig, (curve.virtualQuoteReserves * supply) / curve.virtualTokenReserves);
  let creatorFeeBps = global.creatorFeeConfigurable && curve.creatorFeeBps !== 0n ? curve.creatorFeeBps : tier.creatorFeeBps;
  if (curve.creator === SOLANA_SYSTEM_PROGRAM) creatorFeeBps = 0n;
  if (tier.protocolFeeBps + creatorFeeBps >= 10_000n) throw new Error("curve fees of 100% or more");
  return { protocolFeeBps: tier.protocolFeeBps, creatorFeeBps };
}

/** pump-sdk isLegacyQuoteMint: a SOL-quoted curve stores the zero key or the WSOL mint. */
const legacyQuote = (m: string): boolean => m === SOLANA_SYSTEM_PROGRAM || m === SOLANA_SOL_MINT;

/** pump exact_quote_in_fees (pump-sdk v3ExactQuoteInNet): floor(budget × 1e4 / (1e4 + fees)), shaved until it and its
 * ceil fees fit the budget. */
function exactQuoteInNet(budget: bigint, p: bigint, c: bigint): bigint {
  const net = (budget * 10_000n) / (p + c + 10_000n);
  const cost = net + ceilFee(net, p) + ceilFee(net, c);
  return cost > budget ? net - (cost - budget) : net;
}

/**
 * Out for an exact input on a pump.fun curve, net of fees (pump-sdk getBuyV3TokenAmountFromQuoteAmount and
 * getSellSolAmountFromTokenAmount, for a SOL-quoted curve: no quote transfer fee, so the buyback slice cancels out of
 * the debit). Buy (buy_exact_quote_in_v3): net = exactQuoteInNet(in), tokens = (net − 1) × vT / (vQ + net − 1). Up
 * to the curve's real token reserves R, or on a mayhem curve (which stops at the end: at most R), that is the out.
 * Past R, the crossing branch: R costs curveNet = R × vQ / (vT − R) + 1 and its ceil fees; what is left of the budget
 * buys from the pool-to-be that migration deposits (base = the curve's token account balance − R, quote = real quote
 * reserves + curveNet, less Global.pool_migration_fee on a SOL curve) floor((leg − 1) × base / (quote + leg − 1)),
 * the leg shaved until the whole debit fits; out = R + that. Sell: gross = amount × vQ / (vT + amount), less the ceil
 * protocol and creator fees; 0 when gross is more than the curve's real quote reserves.
 */
export function solanaCurveOut(side: "buy" | "sell", amount: bigint, curve: SolanaBondingCurve, global: SolanaPumpGlobal, feeConfig: SolanaFeeConfig, mintSupply: bigint, curveBaseBalance: bigint): SolanaPoolOut {
  if (curve.complete) throw new Error("curve complete");
  const { protocolFeeBps: p, creatorFeeBps: c } = solanaCurveRates(curve, global, feeConfig, mintSupply);
  const vT = curve.virtualTokenReserves;
  const vQ = curve.virtualQuoteReserves;
  if (vQ === 0n) throw new Error("curve has no virtual quote reserves");
  const fees = (x: bigint): bigint => ceilFee(x, p) + ceilFee(x, c);
  if (side === "buy") {
    const total = p + c;
    const net = exactQuoteInNet(amount, p, c);
    const spotOut = (((amount * 10_000n) / (total + 10_000n)) * vT) / vQ;
    if (net <= 1n) return { out: 0n, spotOut };
    const tokens = ((net - 1n) * vT) / (vQ + net - 1n);
    const R = curve.realTokenReserves;
    if (tokens <= R || curve.isMayhemMode) return { out: min(tokens, R), spotOut };
    // the crossing branch
    if (vT <= R) throw new Error("curve's virtual token reserves do not exceed its real ones");
    const curveNet = (R * vQ) / (vT - R) + 1n;
    const curveCost = curveNet + fees(curveNet);
    if (curveCost > amount) throw new Error("the budget crosses the curve's end but does not cover its remainder");
    const budgetLeft = amount - curveCost;
    if (budgetLeft <= 0n || (budgetLeft * 10_000n) / (total + 10_000n) < 2n) return { out: R, spotOut };
    let legNet = exactQuoteInNet(budgetLeft, p, c);
    const raised = curve.realQuoteReserves + curveNet;
    const base = curveBaseBalance - R;
    const quote = legacyQuote(curve.quoteMint) ? raised - global.poolMigrationFee : raised;
    if (base <= 0n || quote <= 0n) throw new Error("empty pool-to-be");
    const legTokensFor = (q: bigint): bigint => ((q - 1n) * base) / (quote + q - 1n);
    let legTokens = legTokensFor(legNet);
    for (;;) {
      const excess = curveCost + legNet + fees(legNet) - amount;
      if (excess <= 0n) break;
      legNet -= excess;
      if (legNet <= 1n) return { out: R, spotOut };
      legTokens = legTokensFor(legNet);
      if (legTokens === 0n) return { out: R, spotOut };
    }
    return { out: R + legTokens, spotOut };
  }
  const gross = (amount * vQ) / (vT + amount);
  const spot = (amount * vQ) / vT;
  // a sell takes gross out of the curve's real SOL as well as its virtual SOL (pump-public-docs PUMP_PROGRAM_README:
  // "decrease with the same lamports amount"), and a sale past it fails whole (Overflow 6024): on a Mayhem curve, whose
  // agent's tokens were never bought, it can hold less than a sale's gross. Such a sale pays nothing, as a PumpSwap sale
  // past the pool's real quote does (solanaPumpSwapOut)
  if (gross > curve.realQuoteReserves) return { out: 0n, spotOut: spot - fees(spot) };
  const out = gross - fees(gross);
  return { out: out > 0n ? out : 0n, spotOut: spot - fees(spot) };
}

/** The pool's rates (pump-swap-sdk computeFeesBps, feesForQuoteMint): a canonical pump pool quoted in WSOL pays the
 * fee_config tier at the market cap (quote reserve + virtual) × supply / base reserve (supply 1e15 on a mayhem pool);
 * the pool's own creator rate when GlobalConfig allows it; no creator fee without a coin creator. */
export function solanaPumpSwapRates(pool: SolanaPumpSwapPool, cfg: SolanaPumpSwapConfig, feeConfig: SolanaFeeConfig, mintSupply: bigint, baseReserve: bigint, quoteReserve: bigint): SolanaFees {
  if (baseReserve === 0n) throw new Error("pool has no base reserve");
  const supply = pool.isMayhemMode ? ONE_BILLION_SUPPLY : mintSupply;
  const tier = solanaFeeTier(feeConfig, (quoteReserve * supply) / baseReserve);
  let creatorFeeBps = cfg.creatorFeeConfigurable && pool.creatorFeeBps > 0n ? pool.creatorFeeBps : tier.creatorFeeBps;
  if (pool.coinCreator === SOLANA_SYSTEM_PROGRAM) creatorFeeBps = 0n;
  if (tier.lpFeeBps + tier.protocolFeeBps + creatorFeeBps >= 10_000n) throw new Error("pool fees of 100% or more");
  return { lpFeeBps: tier.lpFeeBps, protocolFeeBps: tier.protocolFeeBps, creatorFeeBps };
}

/**
 * Out for an exact input on a PumpSwap pool, net of fees, with Q = the quote vault + virtual_quote_reserves and B =
 * the base vault. Buy (buyQuoteInput): eff = floor(in × 1e4 / (1e4 + fees)), the ceil fees on eff, eff shaved until
 * eff + fees fits, base out = B × (eff − 1) / (Q + eff − 1). Sell (sellBaseInput, sellAmounts): q = Q × in / (B + in);
 * the LP fee stays in the pool, which must hold q − lp in real quote (vault less the fee buckets); the seller gets
 * q − lp − protocol − creator. A side the GlobalConfig disables pays nothing.
 */
export function solanaPumpSwapOut(side: "buy" | "sell", amount: bigint, pool: SolanaPumpSwapPool, cfg: SolanaPumpSwapConfig, feeConfig: SolanaFeeConfig, mintSupply: bigint, baseVault: bigint, quoteVault: bigint): SolanaPoolOut {
  const Q = quoteVault + pool.virtualQuoteReserves;
  const B = baseVault;
  if (Q <= 0n || B <= 0n) throw new Error("pool has an empty reserve");
  const f = solanaPumpSwapRates(pool, cfg, feeConfig, mintSupply, B, Q);
  const total = f.lpFeeBps + f.protocolFeeBps + f.creatorFeeBps;
  if (side === "buy") {
    const spotOut = (((amount * 10_000n) / (10_000n + total)) * B) / Q;
    if (cfg.disableFlags & 8) return { out: 0n, spotOut: null };
    let eff = (amount * 10_000n) / (10_000n + total);
    const withFees = eff + ceilFee(eff, f.lpFeeBps) + ceilFee(eff, f.protocolFeeBps) + ceilFee(eff, f.creatorFeeBps);
    if (withFees > amount) eff -= withFees - amount;
    if (eff <= 1n) return { out: 0n, spotOut };
    return { out: (B * (eff - 1n)) / (Q + eff - 1n), spotOut };
  }
  const spot = (Q * amount) / B;
  const spotOut = spot - ceilFee(spot, f.lpFeeBps) - ceilFee(spot, f.protocolFeeBps) - ceilFee(spot, f.creatorFeeBps);
  if (cfg.disableFlags & 16) return { out: 0n, spotOut: null };
  const q = (Q * amount) / (B + amount);
  const withoutLp = q - ceilFee(q, f.lpFeeBps);
  if (quoteVault - pool.protocolFees - pool.creatorFees < withoutLp) return { out: 0n, spotOut };
  const out = withoutLp - ceilFee(q, f.protocolFeeBps) - ceilFee(q, f.creatorFeeBps);
  return { out: out > 0n ? out : 0n, spotOut };
}

// ------------------------------------------------------------------------------------------------- agreement and the set

/** Two reads of one reserve agree when |a − b| × 10,000 ≤ 200 × min(a, b). */
export function solanaReservesAgree(a: bigint, b: bigint): boolean {
  const d = a > b ? a - b : b - a;
  return d * 10_000n <= BigInt(SOLANA_POOL_READ_TOL_BPS) * min(a, b);
}

/** One provider's read of one candidate: its depth (the quote-side reserve), its E for the whole amount with that
 * read's spot out, and its E for each leg amount (`outs`, absent or [] without legs). */
export type SolanaCandidateRead = { depth: bigint; out: bigint; spotOut: bigint | null; outs?: readonly bigint[] };
/** One candidate the two providers agree on, with each provider's read. */
export type SolanaAgreedCandidate = {
  venue: SolanaReferenceVenue;
  address: string;
  reads: readonly [SolanaCandidateRead, SolanaCandidateRead];
  /** The coin's cashback flag, from the venue's static bytes (the same on both providers); absent when not read. */
  cashback?: boolean;
};

/** The reference set over the agreed candidates (§2.0 LD1): the cutoff from the smaller read of each, every
 * candidate whose depth on either provider reaches it, E the largest over the set from each one's larger-output read,
 * and the per-leg E from that same pool's same read. Null when there is no candidate or no candidate pays anything. */
export function solanaReferenceSet(candidates: readonly SolanaAgreedCandidate[]): SolanaReference | null {
  if (candidates.length === 0) return null;
  const minDepth = (c: SolanaAgreedCandidate): bigint => min(c.reads[0].depth, c.reads[1].depth);
  const maxMin = candidates.reduce((m, c) => (minDepth(c) > m ? minDepth(c) : m), 0n);
  const tol = BigInt(SOLANA_POOL_READ_TOL_BPS);
  // depth ≥ (1 − tol / 1e4) × maxMin, exactly: depth × 1e4 ≥ (1e4 − tol) × maxMin
  const inSet = candidates.filter((c) => c.reads.some((r) => r.depth * 10_000n >= (10_000n - tol) * maxMin));
  let best: SolanaCandidateRead | null = null;
  const pools: SolanaReference["pools"] = [];
  for (const c of inSet) {
    const r = c.reads[0].out >= c.reads[1].out ? c.reads[0] : c.reads[1];
    pools.push({ venue: c.venue, address: c.address, depth: [c.reads[0].depth, c.reads[1].depth], expectedOut: r.out, ...(c.cashback === undefined ? {} : { cashback: c.cashback }) });
    if (!best || r.out > best.out) best = r;
  }
  if (!best || best.out <= 0n) return null;
  return { expectedOut: best.out, expectedOuts: [...(best.outs ?? [])], spotOut: best.spotOut, pools };
}

// ------------------------------------------------------------------------------------------------- the read

type Read = { slot: number; accounts: (SolanaPoolAccount | null)[] } | null;

/** A getMultipleAccounts answer for n accounts, base64; null when it is not one. */
export function solanaParseAccountsAnswer(answer: unknown, n: number): Read {
  try {
    return parseAccounts(answer, n);
  } catch {
    return null; // a getter or a proxy trap that throws: no answer, never a throw
  }
}
function parseAccounts(answer: unknown, n: number): Read {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return null;
  const slot = (answer as { context?: { slot?: unknown } }).context?.slot;
  const value = (answer as { value?: unknown }).value;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(value) || value.length !== n) return null;
  const accounts: (SolanaPoolAccount | null)[] = [];
  for (const v of value) {
    if (v === null) { accounts.push(null); continue; }
    if (typeof v !== "object" || Array.isArray(v)) return null;
    const o = v as { owner?: unknown; data?: unknown };
    if (typeof o.owner !== "string" || o.owner.length > 44 || !Array.isArray(o.data) || o.data.length !== 2 || o.data[1] !== "base64" || typeof o.data[0] !== "string") return null;
    if (o.data[0].length > Math.ceil(MAX_ACCOUNT_BYTES / 3) * 4) return null;
    let data: Uint8Array;
    try {
      if (base58.decode(o.owner).length !== 32) return null;
      data = base64.decode(o.data[0]);
    } catch {
      return null;
    }
    accounts.push({ owner: o.owner, data });
  }
  return { slot, accounts };
}

function eqMasked(a: Uint8Array, b: Uint8Array, moving: readonly (readonly [number, number])[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && !moving.some(([s, e]) => i >= s && i < e)) return false;
  }
  return true;
}
const sameAcc = (a: SolanaPoolAccount | null, b: SolanaPoolAccount | null, moving: readonly (readonly [number, number])[] = []): boolean =>
  a === null || b === null ? a === b : a.owner === b.owner && eqMasked(a.data, b.data, moving);

// The mint on both providers, each read at its own slot: every field but the supply and a fee config's withheld fees
// the same (solanaMintDisagreement, as S6 and S10 hold it), and the supply, which burns and mints move between two
// honest reads (card solana-mint-supply-moves), within the reserves' band, since it sets the fee tier (solanaCurveRates on
// a mayhem curve, solanaPumpSwapRates). Each provider's candidate is priced on its own supply. A string: why not.
function mints(a: SolanaPoolAccount | null, b: SolanaPoolAccount | null): readonly [{ supply: bigint; program: string }, { supply: bigint; program: string }] | string {
  if (!a || !b) return "the mint is not read on both providers";
  const off = solanaMintDisagreement(a, b);
  if (off) return `the providers disagree on the mint's ${off}`;
  const m = [solanaDecodeMint(a), solanaDecodeMint(b)] as const;
  if (!solanaReservesAgree(m[0].supply, m[1].supply)) return `the mint's supply is outside the band (${m[0].supply} / ${m[1].supply})`;
  return m;
}

// What one read pair says of one candidate: not a candidate, a disagreement or a malformed account, or agreed; "replan"
// (a DLMM pair only, judgeDlmm): the read's bin arrays are not the ones the agreed pair walks, so read it again on `list`.
type Verdict = { kind: "none" } | { kind: "bad"; why: string } | { kind: "ok"; candidate: SolanaAgreedCandidate } | { kind: "replan"; list: string[]; judge: (a: Got, b: Got) => Verdict };
/** Indexes into each venue's own read (solanaPoolAddresses curveList and poolList). */
const CI = { mint: 0, curve: 1, pumpGlobal: 2, pumpFeeConfig: 3, baseT: 4, baseT22: 5 } as const;
const PI = { mint: 0, pool: 1, ammGlobalConfig: 2, ammFeeConfig: 3, baseT: 4, baseT22: 5, quote: 6 } as const;

/** A token account's balance, after checking it is the `program`'s account of mint `m` owned by `owner`. */
function heldBy(acc: SolanaPoolAccount | null, m: string, owner: string, program: string): bigint {
  if (!acc) throw new Error("no token account");
  if (acc.owner !== program) throw new Error(`token account owned by ${acc.owner}`);
  const t = solanaDecodeTokenAccount(acc);
  if (t.mint !== m || t.owner !== owner) throw new Error("token account of another mint or owner");
  return t.amount;
}

/** One provider's read of one venue: its parsed answer, or why there is none (the call's own fault, or a malformed answer). */
type Got = { read: Read; fault: string | null };
const PROVIDER = ["provider A", "provider B"] as const;
/** A failed call's fault in fixed words: its HTTP status, its JSON-RPC error code or its timeout, never the error's own
 *  text, which can carry a provider's URL and key (a reason reaches the caller and the live check's public log). */
export function solanaCallFault(e: unknown): string {
  let m: unknown;
  try {
    m = e instanceof Error ? e.message : e;
  } catch {
    return "the call failed"; // a getter or a proxy trap that throws: nothing of it is read
  }
  if (typeof m !== "string") return "the call failed";
  const http = /\bHTTP (\d{3})\b/.exec(m);
  if (http) return `HTTP ${http[1]}`;
  const rpc = /\bRPC error (-?\d{1,6})\b/.exec(m);
  if (rpc) return `RPC error ${rpc[1]}`;
  const late = /\bno answer in (\d{1,7}) ms\b/.exec(m);
  if (late) return `no answer in ${late[1]} ms`;
  return "the call failed";
}

function judge(venue: "pump-curve" | "pumpswap", req: SolanaReferenceRequest, addr: ReturnType<typeof solanaPoolAddresses>, ga: Got, gb: Got): Verdict {
  const a = ga.read;
  const b = gb.read;
  if (!a || !b) {
    const why = [ga, gb].flatMap((g, i) => (g.read ? [] : [`${PROVIDER[i]} gave no answer${g.fault ? ` (${g.fault})` : " (not an accounts read)"}`]));
    return { kind: "bad", why: why.join(", ") };
  }
  const A = a.accounts;
  const B = b.accounts;
  const at = (r: (SolanaPoolAccount | null)[], i: number): SolanaPoolAccount | null => r[i] ?? null;
  const amounts = req.amounts ?? [];
  try {
    if (venue === "pump-curve") {
      const ca = at(A, CI.curve);
      const cb = at(B, CI.curve);
      if (!ca && !cb) return { kind: "none" };
      if (!sameAcc(ca, cb, CURVE_MOVING)) return { kind: "bad", why: "the curve's static bytes differ" };
      const curves = [solanaDecodeBondingCurve(ca!), solanaDecodeBondingCurve(cb!)] as const;
      if (curves[0].complete) return { kind: "none" }; // a complete curve is no candidate
      if (!SOL_LIKE.has(curves[0].quoteMint)) return { kind: "none" }; // quoted in another token: not a SOL pool
      for (const i of [CI.pumpGlobal, CI.pumpFeeConfig]) if (!sameAcc(at(A, i), at(B, i))) return { kind: "bad", why: `account ${i} differs` };
      const ms = mints(at(A, CI.mint), at(B, CI.mint));
      if (typeof ms === "string") return { kind: "bad", why: ms };
      if (!solanaReservesAgree(curves[0].virtualTokenReserves, curves[1].virtualTokenReserves) || !solanaReservesAgree(curves[0].virtualQuoteReserves, curves[1].virtualQuoteReserves)) {
        return { kind: "bad", why: "the curve's reserves are outside the band" };
      }
      const mint = ms[0];
      // the curve's own token account, under the mint's program: it prices the pool-to-be of a buy that crosses the end
      const baseI = mint.program === SOLANA_TOKEN_PROGRAM ? CI.baseT : CI.baseT22;
      const balances = [heldBy(at(A, baseI), addr.mint, addr.curve, mint.program), heldBy(at(B, baseI), addr.mint, addr.curve, mint.program)] as const;
      if (!solanaReservesAgree(balances[0], balances[1])) return { kind: "bad", why: "the curve's token account is outside the band" };
      const global = solanaDecodePumpGlobal(at(A, CI.pumpGlobal) ?? fail("no pump Global"));
      const feeConfig = solanaDecodeFeeConfig(at(A, CI.pumpFeeConfig) ?? fail("no pump fee config"));
      const one = (c: SolanaBondingCurve, balance: bigint, supply: bigint): SolanaCandidateRead => ({
        depth: c.virtualQuoteReserves,
        ...solanaCurveOut(req.side, req.amount, c, global, feeConfig, supply, balance),
        outs: amounts.map((x) => solanaCurveOut(req.side, x, c, global, feeConfig, supply, balance).out),
      });
      return { kind: "ok", candidate: { venue, address: addr.curve, reads: [one(curves[0], balances[0], ms[0].supply), one(curves[1], balances[1], ms[1].supply)], cashback: curves[0].isCashbackCoin } };
    }
    const pa = at(A, PI.pool);
    const pb = at(B, PI.pool);
    if (!pa && !pb) return { kind: "none" };
    if (!sameAcc(pa, pb, POOL_MOVING)) return { kind: "bad", why: "the pool's static bytes differ" };
    const pool = solanaDecodePumpSwapPool(pa!);
    const poolB = solanaDecodePumpSwapPool(pb!);
    if (pool.index !== 0 || pool.creator !== addr.poolAuthority || pool.baseMint !== addr.mint || pool.quoteMint !== SOLANA_SOL_MINT) {
      return { kind: "bad", why: "the pool is not the mint's canonical pool" };
    }
    for (const i of [PI.ammGlobalConfig, PI.ammFeeConfig]) if (!sameAcc(at(A, i), at(B, i))) return { kind: "bad", why: `account ${i} differs` };
    const ms = mints(at(A, PI.mint), at(B, PI.mint));
    if (typeof ms === "string") return { kind: "bad", why: ms };
    const mint = ms[0];
    const t22 = mint.program !== SOLANA_TOKEN_PROGRAM;
    if (pool.baseVault !== (t22 ? addr.baseVaultToken2022 : addr.baseVaultToken) || pool.quoteVault !== addr.quoteVault) return { kind: "bad", why: "the pool's vaults are not its token accounts" };
    const baseI = t22 ? PI.baseT22 : PI.baseT;
    const bases = [heldBy(at(A, baseI), addr.mint, addr.pool, mint.program), heldBy(at(B, baseI), addr.mint, addr.pool, mint.program)] as const;
    const quotes = [heldBy(at(A, PI.quote), SOLANA_SOL_MINT, addr.pool, SOLANA_TOKEN_PROGRAM), heldBy(at(B, PI.quote), SOLANA_SOL_MINT, addr.pool, SOLANA_TOKEN_PROGRAM)] as const;
    if (!solanaReservesAgree(bases[0], bases[1]) || !solanaReservesAgree(quotes[0], quotes[1])) return { kind: "bad", why: "the pool's vaults are outside the band" };
    // the quote reserve the price and the depth are built from: the vault and virtual_quote_reserves, each provider's own
    const qs = [quotes[0] + pool.virtualQuoteReserves, quotes[1] + poolB.virtualQuoteReserves] as const;
    if (qs[0] <= 0n || qs[1] <= 0n) return { kind: "bad", why: "the pool's quote reserve is not positive" };
    if (!solanaReservesAgree(qs[0], qs[1])) return { kind: "bad", why: "the pool's quote reserve is outside the band" };
    const cfg = solanaDecodePumpSwapConfig(at(A, PI.ammGlobalConfig) ?? fail("no GlobalConfig"));
    const feeConfig = solanaDecodeFeeConfig(at(A, PI.ammFeeConfig) ?? fail("no PumpSwap fee config"));
    const one = (p: SolanaPumpSwapPool, base: bigint, quote: bigint, supply: bigint): SolanaCandidateRead => ({
      depth: quote + p.virtualQuoteReserves,
      ...solanaPumpSwapOut(req.side, req.amount, p, cfg, feeConfig, supply, base, quote),
      outs: amounts.map((x) => solanaPumpSwapOut(req.side, x, p, cfg, feeConfig, supply, base, quote).out),
    });
    const cashback = solanaPumpSwapCashback(pa!.data);
    return { kind: "ok", candidate: { venue, address: addr.pool, reads: [one(pool, bases[0], quotes[0], ms[0].supply), one(poolB, bases[1], quotes[1], ms[1].supply)], ...(cashback === null ? {} : { cashback }) } };
  } catch (e) {
    return { kind: "bad", why: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}
function fail(why: string): never {
  throw new Error(why);
}

/** A scanned pool's read list is planned from one provider's earlier read of the pool alone (lookScanned): the accounts it
 *  names must be the ones the agreed pool bytes name, or that one earlier read would choose the config, vaults or reserves
 *  the reference prices on (any token account of a mint can be made out to a venue's authority or to a pair, so a vault's
 *  mint and owner check alone passes another account). */
const sameNames = (a: readonly string[], b: readonly string[] | null | undefined): boolean => !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/** The accounts one DLMM pair's read names, in order (solanaDlmmReadList): the pair, the mint, the Clock, both
 *  reserves, then the SOLANA_DLMM_ARRAYS bin arrays the swap walks from the active bin. */
const DI = { pair: 0, mint: 1, clock: 2, reserveX: 3, reserveY: 4, arrays: 5 } as const;
export function solanaDlmmReadList(address: string, pair: SolanaDlmmPair, mint: string, side: "buy" | "sell"): { list: string[]; indexes: number[] } | null {
  const s = solanaDlmmSide(pair, mint);
  if (!s) return null;
  const indexes = solanaDlmmArrayIndexes(pair.activeId, solanaDlmmSwapForY(side, s.solIsX));
  return { list: [address, mint, SOLANA_CLOCK_SYSVAR, pair.reserveX, pair.reserveY, ...indexes.map((i) => solanaDlmmBinArray(address, i))], indexes };
}

/** What one DLMM pair's read pair says (the module note in dlmm.ts): not a candidate, a disagreement, or agreed; or,
 *  when the read's bin arrays miss any of the SOLANA_DLMM_ARRAYS a swap from either provider's agreed active bin names
 *  (the list was planned from one provider's earlier read, card dlmm-pair-never-priced-at-zero), "replan" with those
 *  arrays, read once more; still missing on that read (`replanned`), a disagreement. */
function judgeDlmm(address: string, list: readonly string[], indexes: readonly number[], req: SolanaReferenceRequest, ga: Got, gb: Got, replanned = false): Verdict {
  const a = ga.read;
  const b = gb.read;
  if (!a || !b) {
    const why = [ga, gb].flatMap((g, i) => (g.read ? [] : [`${PROVIDER[i]} gave no answer${g.fault ? ` (${g.fault})` : " (not an accounts read)"}`]));
    return { kind: "bad", why: why.join(", ") };
  }
  const at = (r: (SolanaPoolAccount | null)[], i: number): SolanaPoolAccount | null => r[i] ?? null;
  const A = a.accounts;
  const B = b.accounts;
  try {
    const pa = at(A, DI.pair);
    const pb = at(B, DI.pair);
    if (!pa && !pb) return { kind: "none" };
    if (!sameAcc(pa, pb, SOLANA_DLMM_PAIR_MOVING)) return { kind: "bad", why: "the DLMM pair's static bytes differ" };
    const pairs = [solanaDecodeDlmmPair(pa!), solanaDecodeDlmmPair(pb!)] as const;
    const p = pairs[0];
    // the pair, the mint, the Clock and both reserves from the agreed bytes; the bin arrays follow from the pair (their
    // addresses are its PDAs, each array's own pair and index checked below) and stay out of this check, since active_id
    // moves between two honest reads
    if (!sameNames(list.slice(0, DI.arrays), solanaDlmmReadList(address, p, req.token, req.side)?.list.slice(0, DI.arrays))) return { kind: "bad", why: "the DLMM read named accounts that are not the pair's own" };
    const side = solanaDlmmSide(p, req.token);
    if (!side || p.status !== 0 || p.bitmapExtensionNeeded || !solanaDlmmModes(p, true)) return { kind: "none" };
    // each provider's read walks the bin arrays a swap from its own active bin names (pool-buy's binArrays), all of them in
    // this read; when one is missing, the walk would find no out and the pair would be priced at 0: plan the arrays from
    // both agreed reads and read again (at most 2 × SOLANA_DLMM_ARRAYS arrays)
    const swapForY = solanaDlmmSwapForY(req.side, side.solIsX);
    const own = [solanaDlmmArrayIndexes(pairs[0].activeId, swapForY), solanaDlmmArrayIndexes(pairs[1].activeId, swapForY)] as const;
    if (!own.every((ixs) => ixs.every((ix) => indexes.includes(ix)))) {
      if (replanned) return { kind: "bad", why: "the DLMM pair's active bin left the bin arrays read" };
      const want = [...new Set([...own[0], ...own[1]])];
      const next = [...list.slice(0, DI.arrays), ...want.map((ix) => solanaDlmmBinArray(address, ix))];
      return { kind: "replan", list: next, judge: (a2, b2) => judgeDlmm(address, next, want, req, a2, b2, true) };
    }
    const ms = mints(at(A, DI.mint), at(B, DI.mint));
    if (typeof ms === "string") return { kind: "bad", why: ms };
    const coinFlag = side.solIsX ? p.tokenYFlag : p.tokenXFlag;
    if (solanaDlmmTokenProgram(coinFlag) !== ms[0].program) return { kind: "bad", why: "the pair's token program flag is not the mint's program" };
    if (solanaDlmmTokenProgram(side.solIsX ? p.tokenXFlag : p.tokenYFlag) !== SOLANA_TOKEN_PROGRAM) return { kind: "none" };
    const clocks = [solanaDecodeClock(at(A, DI.clock) ?? fail("no Clock")), solanaDecodeClock(at(B, DI.clock) ?? fail("no Clock"))] as const;
    const live = (c: { slot: bigint; unixTimestamp: bigint }) => (p.activationType === 0 ? c.slot >= p.activationPoint : p.activationType === 1 ? c.unixTimestamp >= BigInt.asIntN(64, p.activationPoint) : false);
    if (!live(clocks[0]) || !live(clocks[1])) return { kind: "none" };
    let fees: readonly [SolanaTransferFee | null, SolanaTransferFee | null];
    try {
      fees = [solanaCoinTransferFee(at(A, DI.mint)!, clocks[0].epoch), solanaCoinTransferFee(at(B, DI.mint)!, clocks[1].epoch)];
    } catch {
      return { kind: "none" }; // a Token-2022 extension the reference does not price
    }
    const progX = solanaDlmmTokenProgram(p.tokenXFlag)!;
    const progY = solanaDlmmTokenProgram(p.tokenYFlag)!;
    const xs = [heldBy(at(A, DI.reserveX), p.tokenX, address, progX), heldBy(at(B, DI.reserveX), p.tokenX, address, progX)] as const;
    const ys = [heldBy(at(A, DI.reserveY), p.tokenY, address, progY), heldBy(at(B, DI.reserveY), p.tokenY, address, progY)] as const;
    if (!solanaReservesAgree(xs[0], xs[1]) || !solanaReservesAgree(ys[0], ys[1])) return { kind: "bad", why: "the DLMM pair's reserves are outside the band" };
    const arraysOf = (r: (SolanaPoolAccount | null)[]): Map<number, SolanaDlmmBinArray | null> =>
      new Map(indexes.map((ix, k) => {
        const acc = at(r, DI.arrays + k);
        if (!acc) return [ix, null] as const;
        const arr = solanaDecodeDlmmBinArray(acc);
        if (arr.pair !== address || arr.index !== ix) throw new Error("a bin array of another pair or index");
        return [ix, arr] as const;
      }));
    const amounts = req.amounts ?? [];
    const one = (k: 0 | 1, r: (SolanaPoolAccount | null)[]): SolanaCandidateRead => {
      const read = arraysOf(r);
      const arrays = new Map(own[k].map((ix) => [ix, read.get(ix) ?? null] as const));
      // every array the walk may enter is read, so a null walk is an amount those arrays cannot fill (or one past the
      // pair's bin range): the swap would fail too, and the pair pays nothing for it
      const out = (x: bigint) => solanaDlmmTradeOut(pairs[k], arrays, req.side, x, side.solIsX, fees[k], clocks[k].unixTimestamp) ?? 0n;
      return { depth: side.solIsX ? xs[k] : ys[k], out: out(req.amount), spotOut: null, outs: amounts.map(out) };
    };
    return { kind: "ok", candidate: { venue: "dlmm", address, reads: [one(0, A), one(1, B)] } };
  } catch (e) {
    return { kind: "bad", why: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}

/** The accounts one CPMM pool's read names, in order (solanaCpmmReadList): the pool, the mint, the Clock, its
 *  AmmConfig, its token 0 and token 1 vaults. */
const MI = { pool: 0, mint: 1, clock: 2, config: 3, vault0: 4, vault1: 5 } as const;
export function solanaCpmmReadList(address: string, pool: SolanaCpmmPool, mint: string): string[] | null {
  if (!solanaCpmmSide(pool, mint)) return null;
  return [address, mint, SOLANA_CLOCK_SYSVAR, pool.ammConfig, pool.vault0, pool.vault1];
}

/** What one CPMM pool's read pair says (the module note in cpmm.ts): not a candidate, a disagreement, or agreed. */
function judgeCpmm(address: string, list: readonly string[], req: SolanaReferenceRequest, ga: Got, gb: Got): Verdict {
  const a = ga.read;
  const b = gb.read;
  if (!a || !b) {
    const why = [ga, gb].flatMap((g, i) => (g.read ? [] : [`${PROVIDER[i]} gave no answer${g.fault ? ` (${g.fault})` : " (not an accounts read)"}`]));
    return { kind: "bad", why: why.join(", ") };
  }
  const at = (r: (SolanaPoolAccount | null)[], i: number): SolanaPoolAccount | null => r[i] ?? null;
  const A = a.accounts;
  const B = b.accounts;
  try {
    const pa = at(A, MI.pool);
    const pb = at(B, MI.pool);
    if (!pa && !pb) return { kind: "none" };
    if (!sameAcc(pa, pb, SOLANA_CPMM_POOL_MOVING)) return { kind: "bad", why: "the CPMM pool's static bytes differ" };
    const pools = [solanaDecodeCpmmPool(pa!), solanaDecodeCpmmPool(pb!)] as const;
    const p = pools[0];
    if (!sameNames(list, solanaCpmmReadList(address, p, req.token))) return { kind: "bad", why: "the CPMM read named accounts that are not the pool's own" };
    const side = solanaCpmmSide(p, req.token);
    if (!side || p.creatorFeeOn > 2) return { kind: "none" };
    if ((side.solIs0 ? p.program0 : p.program1) !== SOLANA_TOKEN_PROGRAM) return { kind: "none" };
    const ms = mints(at(A, MI.mint), at(B, MI.mint));
    if (typeof ms === "string") return { kind: "bad", why: ms };
    if ((side.solIs0 ? p.program1 : p.program0) !== ms[0].program) return { kind: "bad", why: "the pool's token program is not the mint's program" };
    if (!sameAcc(at(A, MI.config), at(B, MI.config))) return { kind: "bad", why: "the CPMM AmmConfig differs" };
    const cfg = solanaDecodeCpmmConfig(at(A, MI.config) ?? fail("no CPMM AmmConfig"));
    const clocks = [solanaDecodeClock(at(A, MI.clock) ?? fail("no Clock")), solanaDecodeClock(at(B, MI.clock) ?? fail("no Clock"))] as const;
    if (!solanaCpmmLive(p, clocks[0].unixTimestamp) || !solanaCpmmLive(p, clocks[1].unixTimestamp)) return { kind: "none" };
    let fees: readonly [SolanaTransferFee | null, SolanaTransferFee | null];
    try {
      fees = [solanaCoinTransferFee(at(A, MI.mint)!, clocks[0].epoch), solanaCoinTransferFee(at(B, MI.mint)!, clocks[1].epoch)];
    } catch {
      return { kind: "none" }; // a Token-2022 extension the reference does not price
    }
    const vault = (r: (SolanaPoolAccount | null)[], i: 0 | 1): bigint => heldBy(at(r, i === 0 ? MI.vault0 : MI.vault1), i === 0 ? p.mint0 : p.mint1, SOLANA_CPMM_AUTHORITY, i === 0 ? p.program0 : p.program1);
    const v0 = [vault(A, 0), vault(B, 0)] as const;
    const v1 = [vault(A, 1), vault(B, 1)] as const;
    // the reserves the swap prices on: each vault net of the pool's fee counters, each provider's own
    const net = (k: 0 | 1) => [v0[k] - pools[k].fees0, v1[k] - pools[k].fees1] as const;
    const n = [net(0), net(1)] as const;
    // a pool whose vaults hold no more than its fees cannot swap (InsufficientVault, or nothing to pay out): no candidate
    // when both providers read it so, a disagreement when one does
    const empty = n.map(([x, y]) => x <= 0n || y <= 0n);
    if (empty[0] && empty[1]) return { kind: "none" };
    if (empty[0] || empty[1]) return { kind: "bad", why: "the CPMM pool's vaults hold less than its fees" };
    if (!solanaReservesAgree(n[0][0], n[1][0]) || !solanaReservesAgree(n[0][1], n[1][1])) return { kind: "bad", why: "the CPMM pool's reserves are outside the band" };
    const amounts = req.amounts ?? [];
    const one = (k: 0 | 1): SolanaCandidateRead => {
      const out = (x: bigint) => solanaCpmmTradeOut(pools[k], cfg, req.side, x, side.solIs0, v0[k], v1[k], fees[k]) ?? 0n;
      return { depth: side.solIs0 ? n[k][0] : n[k][1], out: out(req.amount), spotOut: null, outs: amounts.map(out) };
    };
    return { kind: "ok", candidate: { venue: "raydium-cpmm", address, reads: [one(0), one(1)] } };
  } catch (e) {
    return { kind: "bad", why: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}

/** The accounts one AMM v4 pool's read names, in order (solanaAmmV4ReadList): the pool, the mint, the Clock, its coin
 *  and pc vaults. */
const AI = { pool: 0, mint: 1, clock: 2, coinVault: 3, pcVault: 4 } as const;
export function solanaAmmV4ReadList(address: string, pool: SolanaAmmV4Pool, mint: string): string[] | null {
  if (!solanaAmmV4Side(pool, mint)) return null;
  return [address, mint, SOLANA_CLOCK_SYSVAR, pool.coinVault, pool.pcVault];
}

/** What one AMM v4 pool's read pair says (the module note in amm-v4.ts): not a candidate, a disagreement, or agreed. */
function judgeAmmV4(address: string, list: readonly string[], req: SolanaReferenceRequest, ga: Got, gb: Got): Verdict {
  const a = ga.read;
  const b = gb.read;
  if (!a || !b) {
    const why = [ga, gb].flatMap((g, i) => (g.read ? [] : [`${PROVIDER[i]} gave no answer${g.fault ? ` (${g.fault})` : " (not an accounts read)"}`]));
    return { kind: "bad", why: why.join(", ") };
  }
  const at = (r: (SolanaPoolAccount | null)[], i: number): SolanaPoolAccount | null => r[i] ?? null;
  const A = a.accounts;
  const B = b.accounts;
  try {
    const pa = at(A, AI.pool);
    const pb = at(B, AI.pool);
    if (!pa && !pb) return { kind: "none" };
    if (!sameAcc(pa, pb, SOLANA_AMM_V4_POOL_MOVING)) return { kind: "bad", why: "the AMM v4 pool's static bytes differ" };
    const pools = [solanaDecodeAmmV4Pool(pa!), solanaDecodeAmmV4Pool(pb!)] as const;
    const p = pools[0];
    if (!sameNames(list, solanaAmmV4ReadList(address, p, req.token))) return { kind: "bad", why: "the AMM v4 read named accounts that are not the pool's own" };
    const side = solanaAmmV4Side(p, req.token);
    if (!side) return { kind: "none" };
    const ms = mints(at(A, AI.mint), at(B, AI.mint));
    if (typeof ms === "string") return { kind: "bad", why: ms };
    if (ms[0].program !== SOLANA_TOKEN_PROGRAM) return { kind: "none" }; // swap_base_in_v2 moves SPL Token only
    const clocks = [solanaDecodeClock(at(A, AI.clock) ?? fail("no Clock")), solanaDecodeClock(at(B, AI.clock) ?? fail("no Clock"))] as const;
    if (!solanaAmmV4Live(pools[0], clocks[0].unixTimestamp) || !solanaAmmV4Live(pools[1], clocks[1].unixTimestamp)) return { kind: "none" };
    const vault = (r: (SolanaPoolAccount | null)[], coin: boolean): bigint => heldBy(at(r, coin ? AI.coinVault : AI.pcVault), coin ? p.coinMint : p.pcMint, SOLANA_AMM_V4_AUTHORITY, SOLANA_TOKEN_PROGRAM);
    const coins = [vault(A, true), vault(B, true)] as const;
    const pcs = [vault(A, false), vault(B, false)] as const;
    // the reserves the swap prices on: each vault less its need_take_pnl, each provider's own
    const n = [[coins[0] - pools[0].needTakePnlCoin, pcs[0] - pools[0].needTakePnlPc], [coins[1] - pools[1].needTakePnlCoin, pcs[1] - pools[1].needTakePnlPc]] as const;
    const empty = n.map(([x, y]) => x <= 0n || y <= 0n);
    if (empty[0] && empty[1]) return { kind: "none" };
    if (empty[0] || empty[1]) return { kind: "bad", why: "the AMM v4 pool's vaults hold less than its pnl" };
    if (!solanaReservesAgree(n[0][0], n[1][0]) || !solanaReservesAgree(n[0][1], n[1][1])) return { kind: "bad", why: "the AMM v4 pool's reserves are outside the band" };
    const amounts = req.amounts ?? [];
    const one = (k: 0 | 1): SolanaCandidateRead => {
      const out = (x: bigint) => solanaAmmV4TradeOut(pools[k], req.side, x, side.solIsPc, coins[k], pcs[k]) ?? 0n;
      return { depth: side.solIsPc ? n[k][1] : n[k][0], out: out(req.amount), spotOut: null, outs: amounts.map(out) };
    };
    return { kind: "ok", candidate: { venue: "raydium-amm-v4", address, reads: [one(0), one(1)] } };
  } catch (e) {
    return { kind: "bad", why: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}

/**
 * The reference E for one exact input on the token's own pools, read on both providers (provider A device-direct,
 * provider B the second, as LD1 has them). Null when there is no candidate ("no reference pool"), or when a candidate
 * still disagrees after the one re-read (the route is refused, never priced on the candidates left; markets.md l.92
 * and S12). `req.amounts` (optional, at most 64 positive u64s) get their own E in `expectedOuts`. Throws only on a
 * request or provider pair that is not one. readSolanaReferenceWhy is the same read with the reason for a null.
 */
export async function readSolanaReference(providers: readonly [SolanaRpc, SolanaRpc], req: SolanaReferenceRequest): Promise<SolanaReference | null> {
  const r = await readSolanaReferenceWhy(providers, req);
  return "reference" in r ? r.reference : null;
}

/** Why a reference read gave no reference: "no reference pool" (no candidate on the chain), "no pool pays out for this
 *  amount", or, for each venue still refused after its one re-read, the venue and its refusal (a provider gave no
 *  answer, with the call's fault such as HTTP 429 or no answer in 5000 ms; static bytes that differ; a reserve outside
 *  the band; a malformed account). */
export type SolanaReferenceRefused = { refused: string };

/** readSolanaReference, with the reason when there is no reference (card solana-reference-read-holds-a-slot-apart): the
 *  same reads, the same rules, the same refusals. */
export async function readSolanaReferenceWhy(providers: readonly [SolanaRpc, SolanaRpc], req: SolanaReferenceRequest): Promise<{ reference: SolanaReference } | SolanaReferenceRefused> {
  if (!Array.isArray(providers) || providers.length !== 2 || typeof providers[0] !== "function" || typeof providers[1] !== "function") throw new Error("two providers are needed");
  const [pa, pb] = providers;
  if (solanaSameProvider(pa, pb)) throw new Error("the two providers are the same provider: a reference must never rest on one provider's word");
  if (req?.side !== "buy" && req?.side !== "sell") throw new Error("side must be buy or sell");
  if (typeof req.amount !== "bigint" || req.amount <= 0n || req.amount > U64_MAX) throw new Error("amount must be a positive u64");
  if (req.amounts !== undefined) {
    if (!Array.isArray(req.amounts) || req.amounts.length > MAX_LEGS) throw new Error(`amounts must be a list of at most ${MAX_LEGS}`);
    for (const x of req.amounts) if (typeof x !== "bigint" || x <= 0n || x > U64_MAX) throw new Error("each leg amount must be a positive u64");
  }
  const addr = solanaPoolAddresses(req.token);
  // one venue's accounts, one call per provider: each candidate rests on one slot per provider
  const readBoth = (list: string[]): Promise<[Got, Got]> =>
    Promise.all(providers.map((rpc) =>
      Promise.resolve().then(() => solanaTimedRpc(rpc, READ_TIMEOUT_MS)("getMultipleAccounts", [list, { encoding: "base64", commitment: "confirmed" }])).then(
        (ans): Got => ({ read: solanaParseAccountsAnswer(ans, list.length), fault: null }),
        (e: unknown): Got => ({ read: null, fault: solanaCallFault(e) }),
      ),
    )) as Promise<[Got, Got]>;
  const lists: Record<"pump-curve" | "pumpswap", string[]> = { "pump-curve": addr.curveList, pumpswap: addr.poolList };
  const venues: ("pump-curve" | "pumpswap")[] = ["pump-curve", "pumpswap"];
  const slots: number[] = [];
  const look = async (v: "pump-curve" | "pumpswap"): Promise<Verdict> => {
    const [a, b] = await readBoth(lists[v]);
    const verdict = judge(v, req, addr, a, b);
    if (verdict.kind === "ok" && a.read && b.read) slots.push(a.read.slot, b.read.slot);
    return verdict;
  };
  // a pool found by a scan (a DLMM pair, a CPMM pool, an AMM v4 pool): every such pool of a kind read first (one call per
  // provider for them all), then each one's own read at one slot, its list planned from the first provider whose read of
  // the pool plans one (A's, else B's: one provider's read that names another mint never hides the pool), so both reads
  // name the same accounts; the judge holds both to the same static bytes and the list to the accounts those bytes name
  type Scanned = { name: string; plural: string; prefix: string; max: number; pools: string[]; plan: (address: string, acc: SolanaPoolAccount) => { list: string[]; judge: (a: Got, b: Got) => Verdict } | null };
  const scanned: Scanned[] = [
    {
      name: "DLMM pair", plural: "DLMM pairs", prefix: "dlmm", max: SOLANA_DLMM_MAX_PAIRS, pools: [...new Set(req.dlmmPairs ?? [])],
      plan: (address, acc) => {
        const plan = solanaDlmmReadList(address, solanaDecodeDlmmPair(acc), req.token, req.side);
        return plan && { list: plan.list, judge: (a, b) => judgeDlmm(address, plan.list, plan.indexes, req, a, b) };
      },
    },
    {
      name: "CPMM pool", plural: "CPMM pools", prefix: "raydium-cpmm", max: SOLANA_CPMM_MAX_POOLS, pools: [...new Set(req.cpmmPools ?? [])],
      plan: (address, acc) => {
        const list = solanaCpmmReadList(address, solanaDecodeCpmmPool(acc), req.token);
        return list && { list, judge: (a, b) => judgeCpmm(address, list, req, a, b) };
      },
    },
    {
      name: "AMM v4 pool", plural: "AMM v4 pools", prefix: "raydium-amm-v4", max: SOLANA_AMM_V4_MAX_POOLS, pools: [...new Set(req.ammV4Pools ?? [])],
      plan: (address, acc) => {
        const list = solanaAmmV4ReadList(address, solanaDecodeAmmV4Pool(acc), req.token);
        return list && { list, judge: (a, b) => judgeAmmV4(address, list, req, a, b) };
      },
    },
  ];
  for (const k of scanned) {
    if (k.pools.length > k.max) throw new Error(`at most ${k.max} ${k.plural}`);
    for (const p of k.pools) if (typeof p !== "string" || base58.decode(p).length !== 32) throw new Error(`a ${k.name} is not a 32-byte address`);
  }
  const heads = await Promise.all(scanned.map((k) => (k.pools.length ? readBoth(k.pools) : null)));
  const lookScanned = async (k: number, i: number): Promise<Verdict> => {
    const kind = scanned[k]!;
    const address = kind.pools[i]!;
    let plan: { list: string[]; judge: (a: Got, b: Got) => Verdict } | null = null;
    for (const h of heads[k]!) {
      const acc = h.read?.accounts[i];
      if (plan || !acc) continue;
      try {
        plan = kind.plan(address, acc);
      } catch {
        return { kind: "bad", why: `the ${kind.name} is malformed` };
      }
    }
    if (!plan) return heads[k]!.every((h) => h.read) ? { kind: "none" } : { kind: "bad", why: `a provider gave no answer for the ${kind.name}` };
    let [a, b] = await readBoth(plan.list);
    let verdict = plan.judge(a, b);
    // a list planned from one provider's earlier read that the agreed read does not walk: planned again from that read
    if (verdict.kind === "replan") {
      [a, b] = await readBoth(verdict.list);
      verdict = verdict.judge(a, b);
      if (verdict.kind === "replan") verdict = { kind: "bad", why: `the ${kind.name}'s read list moved twice` };
    }
    if (verdict.kind === "ok" && a.read && b.read) slots.push(a.read.slot, b.read.slot);
    return verdict;
  };
  const at: (readonly [number, number])[] = scanned.flatMap((k, ki) => k.pools.map((_, i) => [ki, i] as const));
  const named = [...venues, ...at.map(([k, i]) => `${scanned[k]!.prefix} ${scanned[k]!.pools[i]}`)];
  const lookAt = (i: number): Promise<Verdict> => (i < venues.length ? look(venues[i]!) : lookScanned(...at[i - venues.length]!));
  let verdicts = await Promise.all(named.map((_, i) => lookAt(i)));
  // one more read on both of a candidate that did not agree; if it still does not, the route is refused
  verdicts = await Promise.all(verdicts.map((v, i) => (v.kind === "bad" ? lookAt(i) : v)));
  const refused = verdicts.flatMap((v, i) => (v.kind === "bad" ? [`${named[i]}: ${v.why}, after a re-read`] : []));
  if (refused.length) return { refused: refused.join("; ") };
  const candidates = verdicts.flatMap((v) => (v.kind === "ok" ? [v.candidate] : []));
  const ref = solanaReferenceSet(candidates);
  if (!ref) return { refused: candidates.length ? "no pool pays out for this amount" : "no reference pool" };
  return { reference: slots.length ? { ...ref, slot: Math.min(...slots) } : ref };
}
