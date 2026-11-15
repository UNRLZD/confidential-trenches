// Raydium CPMM (CP-Swap) as a venue (card solana-buy-reaches-raydium-and-meteora). Device side, keyless: the pool, its
// AmmConfig, both vaults, the coin's mint and the Clock read on two providers, never one alone, and what an exact input
// pays out of them computed here as the program pays it. Nothing comes from a route, the helper or market data: a pool
// address only names where to read (a hostile list can add a pool the reads then judge, or leave one out;
// readSolanaCpmmPools asks two providers and keeps every pool either names).
//
// Source, read 2026-11-15 01:28Z (date -u): raydium-io/raydium-cp-swap at 3d69122790e97cd6aff24e8ba95940793773f58c
// (master, 2026-11-01), programs/cp-swap/src/:
//  - states/pool.rs: PoolState, Anchor zero_copy packed, 637 bytes with its discriminator (LEN): amm_config 8,
//    pool_creator 40, token_0_vault 72, token_1_vault 104, lp_mint 136, token_0_mint 168, token_1_mint 200,
//    token_0_program 232, token_1_program 264, observation_key 296, auth_bump 328, status 329 (bit 2 set: swap
//    disabled), lp_mint_decimals 330, mint_0_decimals 331, mint_1_decimals 332, lp_supply 333, protocol_fees_token_0 341,
//    protocol_fees_token_1 349, fund_fees_token_0 357, fund_fees_token_1 365, open_time 373, recent_epoch 381,
//    creator_fee_on 389 (0 both, 1 only token 0, 2 only token 1), enable_creator_fee 390, creator_fees_token_0 397,
//    creator_fees_token_1 405, padding to 637. vault_amount_without_fee: each vault less its protocol, fund and creator
//    fees. is_creator_fee_on_input by creator_fee_on and the direction; adjust_creator_fee_rate: 0 unless enabled.
//  - states/config.rs: AmmConfig, 236 bytes: bump 8, disable_create_pool 9, index 10, trade_fee_rate 12,
//    protocol_fee_rate 20, fund_fee_rate 28, create_pool_fee 36, protocol_owner 44, fund_owner 76, creator_fee_rate 108,
//    creator_fee_share_rate 116 (rates in millionths, FEE_RATE_DENOMINATOR_VALUE 1e6 in curve/fees.rs).
//  - instructions/swap_base_input.rs: the 13 accounts in order (payer signer; authority; amm_config; pool_state w;
//    input_token_account w; output_token_account w; input_vault w; output_vault w; input_token_program;
//    output_token_program; input_token_mint; output_token_mint; observation_state w); NotApproved unless the swap bit is
//    clear and the Clock's unix_timestamp has reached open_time; the input mint's Token-2022 transfer fee comes off
//    amount_in first, the output mint's off amount_out, and minimum_amount_out holds what the user receives.
//  - curve/calculator.rs swap_base_input and curve/fees.rs: with the creator fee on the input, total = ceil(in × (trade +
//    creator) / 1e6), creator = floor(total × creator / (trade + creator)), the rest of the input swaps; else trade =
//    ceil(in × trade / 1e6) and the creator fee is ceil(out × creator / 1e6) off the swapped out.
//    curve/constant_product.rs: out = floor(in × y / (x + in)).
//  - lib.rs: AUTH_SEED "vault_and_lp_mint_auth_seed"; instructions/initialize.rs: token_0_mint < token_1_mint, vaults
//    ["pool_vault", pool, mint]. The swap_base_input discriminator is sha256("global:swap_base_input")[..8].
//
// What is not a candidate (verdict "none", never a guess): a pool not quoted in wSOL, wSOL not on SPL Token, swap
// disabled, not open yet by the Clock, a creator fee mode the program does not know, a Token-2022 coin with an extension
// not priced here (dlmm.ts solanaCoinTransferFee; its transfer fee is priced).
import { base58 } from "@scure/base";
import { solanaProgramAddress } from "../../checks/solana/message.ts";
import { SOLANA_SOL_MINT } from "../../checks/solana/checks.ts";
import { deepFreeze } from "../../freeze.ts";
import { solanaDerivedReserves, solanaScannedPools, solanaTransferFeeOf, type SolanaPoolScanKind, type SolanaTransferFee } from "./dlmm.ts";
import type { SolanaRpc } from "./send.ts";

export const SOLANA_CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
/** The vaults' and LP mint's authority: [AUTH_SEED] (lib.rs). */
export const SOLANA_CPMM_AUTHORITY = solanaProgramAddress([new TextEncoder().encode("vault_and_lp_mint_auth_seed")], SOLANA_CPMM_PROGRAM);
export const SOLANA_CPMM_POOL_BYTES = 637;
export const SOLANA_CPMM_CONFIG_BYTES = 236;
/** The most pools one reference read prices. */
export const SOLANA_CPMM_MAX_POOLS = 8;
const POOL_DISC = [247, 237, 227, 245, 215, 195, 222, 70] as const; // sha256("account:PoolState")[..8]
const CONFIG_DISC = [218, 244, 33, 104, 203, 203, 43, 111] as const; // sha256("account:AmmConfig")[..8]
/** swap_base_input: sha256("global:swap_base_input")[..8], then amount_in u64, minimum_amount_out u64. */
export const SOLANA_CPMM_SWAP_BASE_INPUT = Object.freeze([143, 190, 90, 218, 196, 30, 51, 222] as const);
const FEE_DEN = 1_000_000n;
/** The PoolState bytes two honest reads at two slots may differ in: lp_supply and the four protocol and fund fee
 *  counters (333..373), recent_epoch (381..389), the two creator fee counters (397..413). Every other byte must be the
 *  same on both providers. */
export const SOLANA_CPMM_POOL_MOVING: readonly (readonly [number, number])[] = [[333, 373], [381, 389], [397, 413]];
deepFreeze(SOLANA_CPMM_POOL_MOVING);

export type SolanaCpmmAccount = { owner: string; data: Uint8Array };
export type SolanaCpmmPool = {
  readonly ammConfig: string; readonly vault0: string; readonly vault1: string; readonly mint0: string; readonly mint1: string;
  readonly program0: string; readonly program1: string; readonly observation: string; readonly status: number;
  readonly fees0: bigint; readonly fees1: bigint; readonly openTime: bigint; readonly creatorFeeOn: number; readonly creatorFeeEnabled: boolean;
};
export type SolanaCpmmConfig = { readonly tradeFeeRate: bigint; readonly protocolFeeRate: bigint; readonly fundFeeRate: bigint; readonly creatorFeeRate: bigint };

const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u64 = (d: Uint8Array, o: number): bigint => dv(d).getBigUint64(o, true);
const key = (d: Uint8Array, o: number): string => base58.encode(d.subarray(o, o + 32));
function disc(d: Uint8Array, want: readonly number[], name: string, len: number): void {
  if (d.length !== len) throw new Error(`${name}: ${d.length} bytes, not ${len}`);
  for (let i = 0; i < 8; i++) if (d[i] !== want[i]) throw new Error(`${name}: wrong discriminator`);
}

export function solanaDecodeCpmmPool(acc: SolanaCpmmAccount): SolanaCpmmPool {
  if (acc.owner !== SOLANA_CPMM_PROGRAM) throw new Error(`CPMM pool owned by ${acc.owner}`);
  const d = acc.data;
  disc(d, POOL_DISC, "CPMM pool", SOLANA_CPMM_POOL_BYTES);
  if (d[390]! > 1) throw new Error(`CPMM pool enable_creator_fee byte ${d[390]}`);
  // vault_amount_without_fee: protocol + fund + creator fees of each token (checked adds: past u64 the swap fails)
  const fees = (o: number[]): bigint => o.reduce((s, x) => s + u64(d, x), 0n);
  return {
    ammConfig: key(d, 8), vault0: key(d, 72), vault1: key(d, 104), mint0: key(d, 168), mint1: key(d, 200),
    program0: key(d, 232), program1: key(d, 264), observation: key(d, 296), status: d[329]!,
    fees0: fees([341, 357, 397]), fees1: fees([349, 365, 405]), openTime: u64(d, 373), creatorFeeOn: d[389]!, creatorFeeEnabled: d[390] === 1,
  };
}

export function solanaDecodeCpmmConfig(acc: SolanaCpmmAccount): SolanaCpmmConfig {
  if (acc.owner !== SOLANA_CPMM_PROGRAM) throw new Error(`CPMM AmmConfig owned by ${acc.owner}`);
  const d = acc.data;
  disc(d, CONFIG_DISC, "CPMM AmmConfig", SOLANA_CPMM_CONFIG_BYTES);
  return { tradeFeeRate: u64(d, 12), protocolFeeRate: u64(d, 20), fundFeeRate: u64(d, 28), creatorFeeRate: u64(d, 108) };
}

/** A pool's side: the coin is the pool's other mint and wSOL one of the two; null when not a SOL pool of `mint`. */
export function solanaCpmmSide(p: Pick<SolanaCpmmPool, "mint0" | "mint1">, mint: string): { solIs0: boolean } | null {
  if (p.mint0 === mint && p.mint1 === SOLANA_SOL_MINT) return { solIs0: false };
  if (p.mint1 === mint && p.mint0 === SOLANA_SOL_MINT) return { solIs0: true };
  return null;
}
/** The pool can swap now: bit 2 of status clear, and the Clock's unix_timestamp (as u64) at or past open_time. */
export const solanaCpmmLive = (p: Pick<SolanaCpmmPool, "status" | "openTime">, unixTimestamp: bigint): boolean => (p.status & 4) === 0 && BigInt.asUintN(64, unixTimestamp) >= p.openTime;
/** is_creator_fee_on_input for a swap that spends token 0 (`zeroForOne`) or token 1; null for a mode the program refuses. */
export function solanaCpmmCreatorOnInput(p: Pick<SolanaCpmmPool, "creatorFeeOn">, zeroForOne: boolean): boolean | null {
  if (p.creatorFeeOn === 0) return true;
  if (p.creatorFeeOn === 1) return zeroForOne;
  if (p.creatorFeeOn === 2) return !zeroForOne;
  return null;
}

/** The constant product both Raydium venues share: floor(in × y / (x + in)) (cpmm curve/constant_product.rs
 *  swap_base_input_without_fees; amm-v4 math.rs swap_token_amount_base_in). Null when x + in is 0. */
export const solanaConstantProductOut = (amountIn: bigint, x: bigint, y: bigint): bigint | null => (x + amountIn === 0n ? null : (amountIn * y) / (x + amountIn));

/**
 * CurveCalculator::swap_base_input: what exactly `amountIn` (net of its transfer fee) takes out of the output vault
 * (both vaults net of the pool's fees), creator fee included where the pool takes it. Null where the program fails (a
 * rate at or over 100%, a zero fee split denominator).
 */
export function solanaCpmmSwapOut(amountIn: bigint, inVault: bigint, outVault: bigint, cfg: SolanaCpmmConfig, creatorRate: bigint, creatorOnInput: boolean): bigint | null {
  const ceil = (a: bigint, r: bigint): bigint => (a * r + FEE_DEN - 1n) / FEE_DEN;
  let less: bigint;
  if (creatorOnInput) {
    const rate = cfg.tradeFeeRate + creatorRate;
    if (rate === 0n) return null; // split_creator_fee divides by trade + creator: None
    const total = ceil(amountIn, rate);
    if (total > amountIn) return null;
    less = amountIn - total;
  } else {
    const trade = ceil(amountIn, cfg.tradeFeeRate);
    if (trade > amountIn) return null;
    less = amountIn - trade;
  }
  const swapped = solanaConstantProductOut(less, inVault, outVault);
  if (swapped === null) return null;
  if (creatorOnInput) return swapped;
  const creator = ceil(swapped, creatorRate);
  return creator > swapped ? null : swapped - creator;
}

/**
 * What a trade of exactly `amount` gives the user on a CPMM pool, as swap_base_input pays it: a buy spends lamports and
 * receives the coin net of its transfer fee; a sell spends the coin, whose transfer fee comes off before the pool sees it,
 * and receives lamports. `vault0`, `vault1`: the vaults' balances as read. Null where the program fails.
 */
export function solanaCpmmTradeOut(p: SolanaCpmmPool, cfg: SolanaCpmmConfig, side: "buy" | "sell", amount: bigint, solIs0: boolean, vault0: bigint, vault1: bigint, coinFee: SolanaTransferFee | null): bigint | null {
  if (vault0 < p.fees0 || vault1 < p.fees1) return null; // InsufficientVault
  const x0 = vault0 - p.fees0;
  const x1 = vault1 - p.fees1;
  const zeroForOne = side === "buy" ? solIs0 : !solIs0;
  const onInput = solanaCpmmCreatorOnInput(p, zeroForOne);
  if (onInput === null) return null;
  const into = side === "sell" ? amount - solanaTransferFeeOf(coinFee, amount) : amount;
  if (into <= 0n) return null;
  const out = solanaCpmmSwapOut(into, zeroForOne ? x0 : x1, zeroForOne ? x1 : x0, cfg, p.creatorFeeEnabled ? cfg.creatorFeeRate : 0n, onInput);
  if (out === null) return null;
  return side === "buy" ? out - solanaTransferFeeOf(coinFee, out) : out;
}

// ------------------------------------------------------------------------------------------------- finding a coin's pools

/** A pool's vault of `mint`: ["pool_vault", pool, mint] (instructions/initialize.rs). */
export const solanaCpmmVault = (pool: string, mint: string): string => solanaProgramAddress([new TextEncoder().encode("pool_vault"), base58.decode(pool), base58.decode(mint)], SOLANA_CPMM_PROGRAM);
/** The scan of the CPMM pools whose token 0 is `x` and token 1 is `y`: getProgramAccounts with the pool's size and both
 *  mints, addresses only. The helper's /v1/rpc/solana carries this exact shape and no wider one. */
export const solanaCpmmPoolScan = (x: string, y: string): readonly unknown[] => [
  SOLANA_CPMM_PROGRAM,
  { commitment: "confirmed", encoding: "base64", withContext: true, dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: SOLANA_CPMM_POOL_BYTES }, { memcmp: { offset: 168, bytes: x } }, { memcmp: { offset: 200, bytes: y } }] },
];
const CPMM_SCAN: SolanaPoolScanKind = { name: "CPMM pool", scan: (x, y) => solanaCpmmPoolScan(x, y), solReserves: solanaDerivedReserves((p) => solanaCpmmVault(p, SOLANA_SOL_MINT)) };
/**
 * A coin's Raydium CPMM SOL pools, for the reference's `cpmmPools` (pool.ts readSolanaReferenceWhy, which reads and
 * judges each one on both of its providers): dlmm.ts solanaScannedPools over the CPMM pool scan, the coin as token 0
 * and as token 1, ranked past 8 by each pool's SOL vault.
 */
export const readSolanaCpmmPools = (scan: readonly [SolanaRpc, SolanaRpc], read: readonly [SolanaRpc, SolanaRpc], mint: string): Promise<string[]> => solanaScannedPools(CPMM_SCAN, scan, read, mint);
