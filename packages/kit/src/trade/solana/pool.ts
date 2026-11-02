// The device's on-chain reference E for a Solana trade (markets paper S12 and §2.0 LD1, docs/plan1/markets.md l.92 and
// l.382; T1.3 step 1, l.227-229). Device side, keyless: it reads the token's pools on two providers, never one alone,
// and computes what an exact input pays out of them, net of every fee, as the program pays it. Nothing here comes from
// the route, the helper or market data.
//
// - Candidates, from the chain only: the pump.fun bonding curve PDA of the mint and the PumpSwap canonical pool PDA of
//   the mint (quoted in WSOL). A complete curve is not a candidate. Every account is read in one getMultipleAccounts at
//   `processed`, base64, on both providers.
// - Agree: static accounts byte-equal on both (the mint, pump's Global, both fee configs, the PumpSwap GlobalConfig,
//   the curve and the pool with their moving fields masked); each reserve (the curve's virtual token and SOL
//   reserves, the pool's two vault balances) within SOLANA_POOL_READ_TOL_BPS of each other. A candidate that does not
//   agree is read once more on both; if it still does not agree it is refused.
// - The set: depth = the quote-side (SOL) reserve; cutoff = (1 − 200 / 10,000) × the largest, over the candidates, of
//   min(depth on A, depth on B); every candidate whose depth on either provider is at or above the cutoff is in the
//   set. E = the largest E over the set, each candidate's from its larger-output read. So a provider that lies inside
//   the band can only raise the bar, and one that inflates a pool's depth cannot lift the cutoff over an honest pool.
// - No candidate: null ("no reference pool").
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
//    getBuyV3TokenAmountFromQuoteAmount, v3ExactQuoteInNet, v3Rates, getBuyTokenAmountFromSolAmountQuote,
//    getSellSolAmountFromTokenAmount; src/fees.ts computeFeesBps, selectCurveFeeSchedule, calculateFeeTier, fee (ceil).
//  - PumpSwap math: @pump-fun/pump-swap-sdk 2.2.0 (npm, published 2026-10-19, tarball sha256 b3afc4bc…2a57),
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
} from "../../checks/solana/checks.ts";
import type { SolanaRpc } from "./send.ts";

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

export type SolanaPoolVenue = "pump-curve" | "pumpswap";
export type SolanaReference = {
  expectedOut: bigint;
  spotOut: bigint | null;
  pools: { venue: SolanaPoolVenue; address: string; depth: readonly [bigint, bigint]; expectedOut: bigint }[];
};
export type SolanaReferenceRequest = { side: "buy" | "sell"; token: string; amount: bigint };

// ------------------------------------------------------------------------------------------------- addresses

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const PUMP_GLOBAL = solanaProgramAddress([enc("global")], SOLANA_PUMP_PROGRAM);
const PUMP_FEE_CONFIG = solanaProgramAddress([enc("fee_config"), base58.decode(SOLANA_PUMP_PROGRAM)], SOLANA_PUMP_FEES_PROGRAM);
const AMM_GLOBAL_CONFIG = solanaProgramAddress([enc("global_config")], SOLANA_PUMP_AMM_PROGRAM);
const AMM_FEE_CONFIG = solanaProgramAddress([enc("fee_config"), base58.decode(SOLANA_PUMP_AMM_PROGRAM)], SOLANA_PUMP_FEES_PROGRAM);

/** The accounts the reference reads for a mint, in the order of the one getMultipleAccounts call (10 accounts, the
 * most solana-rpc.publicnode.com takes in one call). */
export function solanaPoolAddresses(mint: string): {
  mint: string; curve: string; pumpGlobal: string; pumpFeeConfig: string; poolAuthority: string; pool: string;
  ammGlobalConfig: string; ammFeeConfig: string; baseVaultToken: string; baseVaultToken2022: string; quoteVault: string;
  list: string[];
} {
  const m = base58.decode(mint);
  if (m.length !== 32) throw new Error("the token is not a 32-byte address");
  const curve = solanaProgramAddress([enc("bonding-curve"), m], SOLANA_PUMP_PROGRAM);
  const poolAuthority = solanaProgramAddress([enc("pool-authority"), m], SOLANA_PUMP_PROGRAM);
  // pump-swap-sdk pda.ts canonicalPumpPoolPda: poolPda(index 0 as u16 LE, the pump pool authority, mint, WSOL)
  const pool = solanaProgramAddress([enc("pool"), Uint8Array.of(0, 0), base58.decode(poolAuthority), m, base58.decode(SOLANA_SOL_MINT)], SOLANA_PUMP_AMM_PROGRAM);
  const a = {
    mint, curve, pumpGlobal: PUMP_GLOBAL, pumpFeeConfig: PUMP_FEE_CONFIG, poolAuthority, pool,
    ammGlobalConfig: AMM_GLOBAL_CONFIG, ammFeeConfig: AMM_FEE_CONFIG,
    baseVaultToken: solanaAta(pool, mint, SOLANA_TOKEN_PROGRAM),
    baseVaultToken2022: solanaAta(pool, mint, SOLANA_TOKEN_2022_PROGRAM),
    quoteVault: solanaAta(pool, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM),
  };
  return { ...a, list: [a.mint, a.curve, a.pumpGlobal, a.pumpFeeConfig, a.pool, a.ammGlobalConfig, a.ammFeeConfig, a.baseVaultToken, a.baseVaultToken2022, a.quoteVault] };
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

/** A token account: mint at 0, owner at 32, amount at 64, state at 108 (1 initialized, 2 frozen). */
export function solanaDecodeTokenAccount(acc: SolanaPoolAccount): { mint: string; owner: string; amount: bigint; state: number } {
  if (acc.owner !== SOLANA_TOKEN_PROGRAM && acc.owner !== SOLANA_TOKEN_2022_PROGRAM) throw new Error(`token account owned by ${acc.owner}`);
  if (acc.data.length < 165) throw new Error("token account too short");
  const state = acc.data[108]!;
  if (state !== 1 && state !== 2) throw new Error(`token account state ${state}`);
  return { mint: key(acc.data, 0), owner: key(acc.data, 32), amount: u64(acc.data, 64), state };
}

export type SolanaBondingCurve = {
  virtualTokenReserves: bigint; virtualQuoteReserves: bigint; realTokenReserves: bigint; realQuoteReserves: bigint;
  tokenTotalSupply: bigint; complete: boolean; creator: string; isMayhemMode: boolean; quoteMint: string; creatorFeeBps: bigint;
};
/** pump BondingCurve: reserves u64 at 8, 16, 24, 32, supply 40, complete 48, creator 49, mayhem 81, cashback 82,
 * quote_mint 83, creator_fee_bps 115 (later fields not used). */
export function solanaDecodeBondingCurve(acc: SolanaPoolAccount): SolanaBondingCurve {
  if (acc.owner !== SOLANA_PUMP_PROGRAM) throw new Error(`bonding curve owned by ${acc.owner}`);
  const d = acc.data;
  disc(d, DISC.bondingCurve, "BondingCurve", 49);
  return {
    virtualTokenReserves: u64(d, 8), virtualQuoteReserves: u64(d, 16), realTokenReserves: u64(d, 24), realQuoteReserves: u64(d, 32),
    tokenTotalSupply: u64(d, 40), complete: bool(d, 48), creator: key(d, 49), isMayhemMode: bool(d, 81),
    quoteMint: key(d, 83), creatorFeeBps: u64(d, 115),
  };
}
/** The curve's bytes that move with each trade, masked before the providers' bytes are compared: the four reserves
 * (8..40, compared within the band instead) and the creator and protocol fee accumulators (125..141). */
const CURVE_MOVING: readonly (readonly [number, number])[] = [[8, 40], [125, 141]];

export type SolanaPumpGlobal = { feeBasisPoints: bigint; creatorFeeBasisPoints: bigint; creatorFeeConfigurable: boolean };
/** pump Global: fee_basis_points at 105, creator_fee_basis_points at 154, creator_fee_configurable at 1045 (IDL order). */
export function solanaDecodePumpGlobal(acc: SolanaPoolAccount): SolanaPumpGlobal {
  if (acc.owner !== SOLANA_PUMP_PROGRAM) throw new Error(`pump Global owned by ${acc.owner}`);
  disc(acc.data, DISC.global, "Global", 162);
  return { feeBasisPoints: u64(acc.data, 105), creatorFeeBasisPoints: u64(acc.data, 154), creatorFeeConfigurable: bool(acc.data, 1045) };
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
/** The pool's fee buckets (271..287) move with each v2 trade; they are masked before the bytes are compared. */
const POOL_MOVING: readonly (readonly [number, number])[] = [[271, 287]];

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

/**
 * Out for an exact input on a pump.fun curve, net of fees. Buy (buy_exact_quote_in_v3): lamports in, the net
 * floor(budget × 1e4 / (1e4 + fees)) shaved until net + ceil fees fits, tokens = (net − 1) × vT / (vQ + net − 1), at
 * most the curve's real token reserves (a buy that crosses the end gets at least that; the post-completion leg is not
 * counted, so E is a lower bound there). Sell: gross = amount × vQ / (vT + amount), less the ceil protocol and
 * creator fees.
 */
export function solanaCurveOut(side: "buy" | "sell", amount: bigint, curve: SolanaBondingCurve, global: SolanaPumpGlobal, feeConfig: SolanaFeeConfig, mintSupply: bigint): SolanaPoolOut {
  if (curve.complete) throw new Error("curve complete");
  const { protocolFeeBps: p, creatorFeeBps: c } = solanaCurveRates(curve, global, feeConfig, mintSupply);
  const vT = curve.virtualTokenReserves;
  const vQ = curve.virtualQuoteReserves;
  if (vQ === 0n) throw new Error("curve has no virtual quote reserves");
  if (side === "buy") {
    const total = p + c;
    let net = (amount * 10_000n) / (total + 10_000n);
    const cost = net + ceilFee(net, p) + ceilFee(net, c);
    if (cost > amount) net -= cost - amount;
    const spotOut = (((amount * 10_000n) / (total + 10_000n)) * vT) / vQ;
    if (net <= 1n) return { out: 0n, spotOut };
    return { out: min(((net - 1n) * vT) / (vQ + net - 1n), curve.realTokenReserves), spotOut };
  }
  const gross = (amount * vQ) / (vT + amount);
  const out = gross - ceilFee(gross, p) - ceilFee(gross, c);
  const spot = (amount * vQ) / vT;
  return { out: out > 0n ? out : 0n, spotOut: spot - ceilFee(spot, p) - ceilFee(spot, c) };
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

/** One candidate the two providers agree on: per provider, its depth (the quote-side reserve) and its E with that
 * read's spot out. */
export type SolanaAgreedCandidate = {
  venue: SolanaPoolVenue;
  address: string;
  reads: readonly [{ depth: bigint; out: bigint; spotOut: bigint | null }, { depth: bigint; out: bigint; spotOut: bigint | null }];
};

/** The reference set over the agreed candidates (§2.0 LD1): the cutoff from the smaller read of each, every
 * candidate whose depth on either provider reaches it, E the largest over the set from each one's larger-output read.
 * Null when there is no candidate or no candidate pays anything. */
export function solanaReferenceSet(candidates: readonly SolanaAgreedCandidate[]): SolanaReference | null {
  if (candidates.length === 0) return null;
  const minDepth = (c: SolanaAgreedCandidate): bigint => min(c.reads[0].depth, c.reads[1].depth);
  const maxMin = candidates.reduce((m, c) => (minDepth(c) > m ? minDepth(c) : m), 0n);
  const tol = BigInt(SOLANA_POOL_READ_TOL_BPS);
  // depth ≥ (1 − tol / 1e4) × maxMin, exactly: depth × 1e4 ≥ (1e4 − tol) × maxMin
  const inSet = candidates.filter((c) => c.reads.some((r) => r.depth * 10_000n >= (10_000n - tol) * maxMin));
  let best: { out: bigint; spotOut: bigint | null } | null = null;
  const pools: SolanaReference["pools"] = [];
  for (const c of inSet) {
    const r = c.reads[0].out >= c.reads[1].out ? c.reads[0] : c.reads[1];
    pools.push({ venue: c.venue, address: c.address, depth: [c.reads[0].depth, c.reads[1].depth], expectedOut: r.out });
    if (!best || r.out > best.out) best = r;
  }
  if (!best || best.out <= 0n) return null;
  return { expectedOut: best.out, spotOut: best.spotOut, pools };
}

// ------------------------------------------------------------------------------------------------- the read

type Read = { slot: number; accounts: (SolanaPoolAccount | null)[] } | null;

/** A getMultipleAccounts answer for n accounts, base64; null when it is not one. */
export function solanaParseAccountsAnswer(answer: unknown, n: number): Read {
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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`no answer in ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
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

// What one read pair says of one candidate: not a candidate, a disagreement or a malformed account, or agreed.
type Verdict = { kind: "none" } | { kind: "bad"; why: string } | { kind: "ok"; candidate: SolanaAgreedCandidate };
const I = { mint: 0, curve: 1, pumpGlobal: 2, pumpFeeConfig: 3, pool: 4, ammGlobalConfig: 5, ammFeeConfig: 6, baseT: 7, baseT22: 8, quote: 9 } as const;

function judge(venue: SolanaPoolVenue, req: SolanaReferenceRequest, addr: ReturnType<typeof solanaPoolAddresses>, a: Read, b: Read): Verdict {
  if (!a || !b) return { kind: "bad", why: "a provider gave no answer" };
  const A = a.accounts;
  const B = b.accounts;
  const at = (r: (SolanaPoolAccount | null)[], i: number): SolanaPoolAccount | null => r[i] ?? null;
  try {
    if (venue === "pump-curve") {
      const ca = at(A, I.curve);
      const cb = at(B, I.curve);
      if (!ca && !cb) return { kind: "none" };
      if (!sameAcc(ca, cb, CURVE_MOVING)) return { kind: "bad", why: "the curve's static bytes differ" };
      const curves = [solanaDecodeBondingCurve(ca!), solanaDecodeBondingCurve(cb!)] as const;
      if (curves[0].complete) return { kind: "none" }; // a complete curve is no candidate
      if (!SOL_LIKE.has(curves[0].quoteMint)) return { kind: "none" }; // quoted in another token: not a SOL pool
      for (const i of [I.mint, I.pumpGlobal, I.pumpFeeConfig]) if (!sameAcc(at(A, i), at(B, i))) return { kind: "bad", why: `account ${i} differs` };
      if (!solanaReservesAgree(curves[0].virtualTokenReserves, curves[1].virtualTokenReserves) || !solanaReservesAgree(curves[0].virtualQuoteReserves, curves[1].virtualQuoteReserves)) {
        return { kind: "bad", why: "the curve's reserves are outside the band" };
      }
      const mint = solanaDecodeMint(at(A, I.mint) ?? fail("no mint"));
      const global = solanaDecodePumpGlobal(at(A, I.pumpGlobal) ?? fail("no pump Global"));
      const feeConfig = solanaDecodeFeeConfig(at(A, I.pumpFeeConfig) ?? fail("no pump fee config"));
      const one = (c: SolanaBondingCurve) => ({ depth: c.virtualQuoteReserves, ...solanaCurveOut(req.side, req.amount, c, global, feeConfig, mint.supply) });
      return { kind: "ok", candidate: { venue, address: addr.curve, reads: [one(curves[0]), one(curves[1])] } };
    }
    const pa = at(A, I.pool);
    const pb = at(B, I.pool);
    if (!pa && !pb) return { kind: "none" };
    if (!sameAcc(pa, pb, POOL_MOVING)) return { kind: "bad", why: "the pool's static bytes differ" };
    const pool = solanaDecodePumpSwapPool(pa!);
    const poolB = solanaDecodePumpSwapPool(pb!);
    if (pool.index !== 0 || pool.creator !== addr.poolAuthority || pool.baseMint !== addr.mint || pool.quoteMint !== SOLANA_SOL_MINT) {
      return { kind: "bad", why: "the pool is not the mint's canonical pool" };
    }
    for (const i of [I.mint, I.ammGlobalConfig, I.ammFeeConfig]) if (!sameAcc(at(A, i), at(B, i))) return { kind: "bad", why: `account ${i} differs` };
    const mint = solanaDecodeMint(at(A, I.mint) ?? fail("no mint"));
    const baseI = mint.program === SOLANA_TOKEN_PROGRAM ? I.baseT : I.baseT22;
    if (pool.baseVault !== addr.list[baseI] || pool.quoteVault !== addr.quoteVault) return { kind: "bad", why: "the pool's vaults are not its token accounts" };
    const vault = (r: (SolanaPoolAccount | null)[], i: number, m: string, program: string) => {
      const acc = at(r, i) ?? fail("no vault");
      if (acc.owner !== program) throw new Error(`vault owned by ${acc.owner}`);
      const t = solanaDecodeTokenAccount(acc);
      if (t.mint !== m || t.owner !== addr.pool) throw new Error("vault of another mint or owner");
      return t.amount;
    };
    const bases = [vault(A, baseI, addr.mint, mint.program), vault(B, baseI, addr.mint, mint.program)] as const;
    const quotes = [vault(A, I.quote, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM), vault(B, I.quote, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM)] as const;
    if (!solanaReservesAgree(bases[0], bases[1]) || !solanaReservesAgree(quotes[0], quotes[1])) return { kind: "bad", why: "the pool's vaults are outside the band" };
    const cfg = solanaDecodePumpSwapConfig(at(A, I.ammGlobalConfig) ?? fail("no GlobalConfig"));
    const feeConfig = solanaDecodeFeeConfig(at(A, I.ammFeeConfig) ?? fail("no PumpSwap fee config"));
    const one = (p: SolanaPumpSwapPool, base: bigint, quote: bigint) => ({ depth: quote + p.virtualQuoteReserves, ...solanaPumpSwapOut(req.side, req.amount, p, cfg, feeConfig, mint.supply, base, quote) });
    return { kind: "ok", candidate: { venue, address: addr.pool, reads: [one(pool, bases[0], quotes[0]), one(poolB, bases[1], quotes[1])] } };
  } catch (e) {
    return { kind: "bad", why: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}
function fail(why: string): never {
  throw new Error(why);
}

/**
 * The reference E for one exact input on the token's own pools, read on both providers (provider A device-direct,
 * provider B the second, as LD1 has them). Null when no candidate agrees on both: "no reference pool", no route.
 * Throws only on a request or provider pair that is not one.
 */
export async function readSolanaReference(providers: readonly [SolanaRpc, SolanaRpc], req: SolanaReferenceRequest): Promise<SolanaReference | null> {
  if (!Array.isArray(providers) || providers.length !== 2 || typeof providers[0] !== "function" || typeof providers[1] !== "function") throw new Error("two providers are needed");
  const [pa, pb] = providers;
  if (pa === pb || (pa.url !== undefined && pa.url === pb.url)) throw new Error("the two providers are the same provider: a reference must never rest on one provider's word");
  if (req?.side !== "buy" && req?.side !== "sell") throw new Error("side must be buy or sell");
  if (typeof req.amount !== "bigint" || req.amount <= 0n || req.amount > U64_MAX) throw new Error("amount must be a positive u64");
  const addr = solanaPoolAddresses(req.token);
  const n = addr.list.length;
  const readBoth = (): Promise<[Read, Read]> =>
    Promise.all(providers.map((rpc) =>
      withTimeout(Promise.resolve().then(() => rpc("getMultipleAccounts", [addr.list, { encoding: "base64", commitment: "processed" }])), READ_TIMEOUT_MS).then(
        (ans) => solanaParseAccountsAnswer(ans, n),
        () => null,
      ),
    )) as Promise<[Read, Read]>;

  const venues: SolanaPoolVenue[] = ["pump-curve", "pumpswap"];
  let [a, b] = await readBoth();
  let verdicts = venues.map((v) => judge(v, req, addr, a, b));
  if (verdicts.some((v) => v.kind === "bad")) {
    // one more read on both, for the candidates that did not agree; then they are refused
    [a, b] = await readBoth();
    verdicts = verdicts.map((v, i) => (v.kind === "bad" ? judge(venues[i]!, req, addr, a, b) : v));
  }
  return solanaReferenceSet(verdicts.flatMap((v) => (v.kind === "ok" ? [v.candidate] : [])));
}
