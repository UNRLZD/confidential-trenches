// Raydium AMM v4 as a venue (card solana-buy-reaches-raydium-and-meteora), through its orderbook-free swap
// swap_base_in_v2. Device side, keyless: the pool (AmmInfo), both vaults, the coin's mint and the Clock read on two
// providers, never one alone, and what an exact input pays out of them computed here as the program pays it. A pool
// address only names where to read (readSolanaAmmV4Pools asks two providers and keeps every pool either names).
//
// Source, read 2026-11-15 01:40Z (date -u): raydium-io/raydium-amm at 91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6 (master,
// 2026-10-20), program/src/:
//  - state.rs: AmmInfo, repr(C, packed), 752 bytes, no discriminator: status u64 0, nonce 8, then 14 u64 to 128; Fees
//    at 128 (min_separate 128/136, trade_fee 144/152, pnl 160/168, swap_fee_numerator 176, swap_fee_denominator 184);
//    StateData at 192 (need_take_pnl_coin 192, need_take_pnl_pc 200, total_pnl_pc 208, total_pnl_coin 216,
//    pool_open_time 224, padding 232, orderbook_to_init_time 248, the swap counters 256..336); coin_vault 336, pc_vault
//    368, coin_vault_mint 400, pc_vault_mint 432, lp_mint 464, open_orders 496, market 528, market_program 560,
//    target_orders 592, padding1 624, amm_owner 688, lp_amount 720, client_order_id 728, recent_epoch 736, padding2 744.
//    AmmStatus::swap_permission: Initialized (1), SwapOnly (6) and WaitingTrade (7) swap, no other.
//  - processor.rs process_swap_base_in_v2: accounts [SPL Token, amm w, authority, coin vault w, pc vault w, user
//    source w, user destination w, user owner signer]; the token program must be SPL Token (every account unpacked as an
//    SPL Token account, so a Token-2022 coin is not swapped here); WaitingTrade swaps only from pool_open_time on the
//    Clock's unix_timestamp; each vault less its need_take_pnl (math.rs calc_total_without_take_pnl_no_orderbook);
//    swap_fee = ceil(in × swap_fee_numerator / swap_fee_denominator); out = floor(y × (in − fee) / (x + in − fee))
//    (math.rs swap_token_amount_base_in); ExceededSlippage when out < minimum_amount_out; InvalidInput when out is 0;
//    InsufficientFunds when out reaches the output side's total. The authority is create_program_address(["amm
//    authority", nonce]); the vaults it owns. instruction.rs: swap_base_in_v2 is tag 16, amount_in u64,
//    minimum_amount_out u64.
//
// What is not a candidate (verdict "none", never a guess): a pool not quoted in wSOL, a status that does not swap or a
// WaitingTrade pool not open yet by the Clock, a coin that is not an SPL Token mint.
import { base58, base64 } from "@scure/base";
import { solanaProgramAddress } from "../../checks/solana/message.ts";
import { SOLANA_SOL_MINT, SOLANA_SYSTEM_PROGRAM } from "../../checks/solana/checks.ts";
import { deepFreeze } from "../../freeze.ts";
import { SOLANA_POOL_SCAN_TIMEOUT_MS, solanaScannedPools, type SolanaPoolScanKind } from "./dlmm.ts";
import { solanaConstantProductOut } from "./cpmm.ts";
import { solanaTimedRpc, type SolanaRpc } from "./send.ts";

export const SOLANA_AMM_V4_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
/** The vaults' authority: the program's address of ["amm authority"] (its canonical bump is every pool's nonce on
 *  mainnet; a pool whose vaults another key owns is refused by the reads, which hold each vault to this owner). */
export const SOLANA_AMM_V4_AUTHORITY = solanaProgramAddress([new TextEncoder().encode("amm authority")], SOLANA_AMM_V4_PROGRAM);
export const SOLANA_AMM_V4_POOL_BYTES = 752;
/** The most pools one reference read prices. */
export const SOLANA_AMM_V4_MAX_POOLS = 8;
/** swap_base_in_v2's tag. */
export const SOLANA_AMM_V4_SWAP_BASE_IN_V2 = 16;
/** The AmmInfo bytes two honest reads at two slots may differ in: status (WaitingTrade becomes SwapOnly on the first
 *  swap past open time), order_num and depth, state and reset_flag, need_take_pnl and the pnl totals (192..224), the
 *  swap counters (256..336), lp_amount, client_order_id and recent_epoch (720..744). Each read's status is judged on its
 *  own; every other byte, the fees, open time, vaults and mints among them, must be the same on both providers. */
export const SOLANA_AMM_V4_POOL_MOVING: readonly (readonly [number, number])[] = [[0, 8], [16, 32], [48, 64], [192, 224], [256, 336], [720, 744]];
deepFreeze(SOLANA_AMM_V4_POOL_MOVING);

export type SolanaAmmV4Account = { owner: string; data: Uint8Array };
export type SolanaAmmV4Pool = {
  readonly status: bigint; readonly swapFeeNumerator: bigint; readonly swapFeeDenominator: bigint;
  readonly needTakePnlCoin: bigint; readonly needTakePnlPc: bigint; readonly openTime: bigint;
  readonly coinVault: string; readonly pcVault: string; readonly coinMint: string; readonly pcMint: string;
};

const u64 = (d: Uint8Array, o: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
const key = (d: Uint8Array, o: number): string => base58.encode(d.subarray(o, o + 32));

export function solanaDecodeAmmV4Pool(acc: SolanaAmmV4Account): SolanaAmmV4Pool {
  if (acc.owner !== SOLANA_AMM_V4_PROGRAM) throw new Error(`AMM v4 pool owned by ${acc.owner}`);
  const d = acc.data;
  if (d.length !== SOLANA_AMM_V4_POOL_BYTES) throw new Error(`AMM v4 pool: ${d.length} bytes, not ${SOLANA_AMM_V4_POOL_BYTES}`);
  return {
    status: u64(d, 0), swapFeeNumerator: u64(d, 176), swapFeeDenominator: u64(d, 184),
    needTakePnlCoin: u64(d, 192), needTakePnlPc: u64(d, 200), openTime: u64(d, 224),
    coinVault: key(d, 336), pcVault: key(d, 368), coinMint: key(d, 400), pcMint: key(d, 432),
  };
}

/** A pool's side: the coin is the pool's other mint and wSOL one of the two; null when not a SOL pool of `mint`. */
export function solanaAmmV4Side(p: Pick<SolanaAmmV4Pool, "coinMint" | "pcMint">, mint: string): { solIsPc: boolean } | null {
  if (p.coinMint === mint && p.pcMint === SOLANA_SOL_MINT) return { solIsPc: true };
  if (p.pcMint === mint && p.coinMint === SOLANA_SOL_MINT) return { solIsPc: false };
  return null;
}
/** swap_permission, with WaitingTrade's open time on the Clock's unix_timestamp (as u64). */
export const solanaAmmV4Live = (p: Pick<SolanaAmmV4Pool, "status" | "openTime">, unixTimestamp: bigint): boolean =>
  p.status === 1n || p.status === 6n || (p.status === 7n && BigInt.asUintN(64, unixTimestamp) >= p.openTime);

/**
 * What a trade of exactly `amount` gives the user on an AMM v4 pool, as swap_base_in_v2 pays it (no transfer fee: SPL
 * Token only): a buy spends lamports for the coin, a sell the reverse. `coinVault`, `pcVault`: the vaults' balances as
 * read. Null where the program fails (a vault under its pnl, a zero fee denominator, an out of 0 or the whole side).
 */
export function solanaAmmV4TradeOut(p: SolanaAmmV4Pool, side: "buy" | "sell", amount: bigint, solIsPc: boolean, coinVault: bigint, pcVault: bigint): bigint | null {
  if (coinVault < p.needTakePnlCoin || pcVault < p.needTakePnlPc || p.swapFeeDenominator === 0n || amount <= 0n) return null;
  const coin = coinVault - p.needTakePnlCoin;
  const pc = pcVault - p.needTakePnlPc;
  const fee = (amount * p.swapFeeNumerator + p.swapFeeDenominator - 1n) / p.swapFeeDenominator;
  if (fee > amount) return null;
  const pcIn = side === "buy" ? solIsPc : !solIsPc;
  const [x, y] = pcIn ? [pc, coin] : [coin, pc];
  const out = solanaConstantProductOut(amount - fee, x, y);
  return out === null || out === 0n || out >= y ? null : out;
}

// ------------------------------------------------------------------------------------------------- finding a coin's pools

/** The scan of the AMM v4 pools whose coin mint is `x` and pc mint is `y`: getProgramAccounts with the pool's size and
 *  both mints, addresses only. The helper's /v1/rpc/solana carries this exact shape and no wider one. */
export const solanaAmmV4PoolScan = (x: string, y: string): readonly unknown[] => [
  SOLANA_AMM_V4_PROGRAM,
  { commitment: "confirmed", encoding: "base64", withContext: true, dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: SOLANA_AMM_V4_POOL_BYTES }, { memcmp: { offset: 400, bytes: x } }, { memcmp: { offset: 432, bytes: y } }] },
];
/** Each pool's SOL vault as `rpc` reads the pool (coin_vault 336, pc_vault 368, coin_vault_mint 400, pc_vault_mint 432;
 *  the vaults are not program addresses of the pool alone): a pool `rpc` does not answer as an AMM v4 pool of wSOL
 *  names the system program, depth 0. */
async function solVaults(rpc: SolanaRpc, pools: readonly string[]): Promise<readonly string[]> {
  const a = (await solanaTimedRpc(rpc, SOLANA_POOL_SCAN_TIMEOUT_MS)("getMultipleAccounts", [[...pools], { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 336, length: 128 } }])) as { value?: unknown } | null;
  const v = a?.value;
  if (!Array.isArray(v) || v.length !== pools.length) throw new Error("an AMM v4 pool read answered no list of the asked length");
  return v.map((e) => {
    const o = e as { owner?: unknown; data?: unknown } | null;
    let d: Uint8Array | null = null;
    try {
      d = o && o.owner === SOLANA_AMM_V4_PROGRAM && Array.isArray(o.data) && o.data[1] === "base64" && typeof o.data[0] === "string" && o.data[0].length <= 172 ? base64.decode(o.data[0]) : null;
    } catch {}
    if (!d || d.length !== 128) return SOLANA_SYSTEM_PROGRAM;
    return key(d, 96) === SOLANA_SOL_MINT ? key(d, 32) : key(d, 64) === SOLANA_SOL_MINT ? key(d, 0) : SOLANA_SYSTEM_PROGRAM;
  });
}
const AMM_V4_SCAN: SolanaPoolScanKind = { name: "AMM v4 pool", scan: (x, y) => solanaAmmV4PoolScan(x, y), solReserves: solVaults };
/**
 * A coin's Raydium AMM v4 SOL pools, for the reference's `ammV4Pools` (pool.ts readSolanaReferenceWhy, which reads and
 * judges each one on both of its providers): dlmm.ts solanaScannedPools over the pool scan, the coin as coin and as
 * pc, ranked past 8 by each pool's SOL vault as each ranking provider reads the pool.
 */
export const readSolanaAmmV4Pools = (scan: readonly [SolanaRpc, SolanaRpc], read: readonly [SolanaRpc, SolanaRpc], mint: string): Promise<string[]> => solanaScannedPools(AMM_V4_SCAN, scan, read, mint);
