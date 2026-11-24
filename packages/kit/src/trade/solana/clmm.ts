// Raydium CLMM as a market the device reads but does not trade (card solana-buy-never-below-a-hidden-market). Device
// side, keyless: a pool and its two vaults read on two providers, never one alone, and its spot price and SOL depth
// taken only where both agree. Nothing here builds, names or signs a route: no CLMM account is ever an account of a
// signed message, and SOLANA_POOL_BUY_VENUES (pool-buy.ts) holds no CLMM venue. A pool address only names where to
// read; the read judges it.
//
// Why: on 21 Nov 16:23Z, for 30 of the 100 coins Discover listed, the deepest pool in any quote sat on a venue the kit
// did not read (a Raydium CLMM pool for 22 of them, most quoted in USDC). A buy's bar M (pool.ts set rule) was then set
// by a thinner pool, so a thin pool priced far from the coin's real market could be bought. This read is that market's
// price and depth; the set rule's use of it comes with its exact out (the card's next round).
//
// Source, read 2026-11-21 16:38Z (date -u): raydium-io/raydium-clmm at 6d7a0f82d2f293c553c69aaf943377367c6c4cc6
// (master, 2026-10-27), programs/amm/src/states/pool.rs: PoolState, Anchor zero_copy, repr(C, packed), 1544 bytes with
// its discriminator sha256("account:PoolState")[..8] (the CPMM pool's name too: the owner tells them apart): bump 8,
// amm_config 9, owner 41, token_mint_0 73, token_mint_1 105, token_vault_0 137, token_vault_1 169, observation_key 201,
// mint_decimals_0 233, mint_decimals_1 234, tick_spacing 235 (u16), liquidity 237 (u128), sqrt_price_x64 253 (u128,
// Q64.64 of token 1 per token 0 in base units), tick_current 269 (i32), ... status 389 (PoolStatusBitIndex: bit 4 set
// = swap disabled), fee_on 390. The vaults are SPL token accounts of the pool's mints whose authority is the pool
// itself (read on mainnet 21 Nov 16:47Z for BxRhW4q1… and 9n3dSLrE…, both vaults of each).
// Checked 21 Nov 16:38Z on api.mainnet-beta.solana.com and solana-rpc.publicnode.com for four pools (SPCX, SQQQ, TSLAx,
// NVDA against USDC): sqrt_price_x64² / 2^128 × 10^(dec0 − dec1) equalled DexScreener's priceNative to 6 digits, the
// same sqrt price on both providers.
//
// Agree: the pool's identity bytes (0..237: discriminator, config, owner, mints, vaults, observation, decimals,
// spacing; 389..391: status, fee_on) byte-equal on both; the spot price (sqrt²) and the SOL vault within
// SOLANA_POOL_READ_TOL_BPS of each other; otherwise read once more on both, then refused. What is no market (verdict
// "none", never a guess): no such account, a pool not of the coin and wSOL, swaps disabled, no liquidity in range, an
// empty SOL vault.
import { base58 } from "@scure/base";
import { SOLANA_PUMP_STABLE_MINT, SOLANA_SOL_MINT, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM } from "../../checks/solana/checks.ts";
import { deepFreeze } from "../../freeze.ts";
import { SOLANA_CLOCK_SYSVAR, solanaDecodeClock, solanaDerivedReserves, solanaScannedPools, solanaTransferFeeOf, type SolanaPoolScanKind, type SolanaTransferFee } from "./dlmm.ts";
import { solanaProgramAddress } from "../../checks/solana/message.ts";
import { solanaCallFault, solanaDecodeTokenAccount, solanaParseAccountsAnswer, solanaReservesAgree, type SolanaPoolAccount } from "./pool.ts";
import { solanaSameProvider, solanaTimedRpc, type SolanaRpc } from "./send.ts";

export const SOLANA_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const SOLANA_CLMM_POOL_BYTES = 1544;
const POOL_DISC = [247, 237, 227, 245, 215, 195, 222, 70] as const; // sha256("account:PoolState")[..8]
/** USDC, the quote of most CLMM markets the census found (SPL Token, 6 decimals). */
export const SOLANA_USDC_MINT = SOLANA_PUMP_STABLE_MINT;
/** The DynamicFeeInfo's place in PoolState (80 bytes): filter_period u16, decay_period u16, reduction_factor u16,
 *  dynamic_fee_control u32 at +6, max_volatility_accumulator u32 at +10, then the moving tick_spacing_index_reference,
 *  volatility_reference, volatility_accumulator and last_update_timestamp, then padding. */
const DYN_AT = 1096;
/** The PoolState bytes that name the pool and its fee and must be the same on both providers: 0..237 (discriminator to
 *  tick spacing), status and fee_on, open_time, and the dynamic fee's settings. */
export const SOLANA_CLMM_POOL_STATIC: readonly (readonly [number, number])[] = [[0, 237], [389, 391], [1080, 1088], [DYN_AT, DYN_AT + 14]];
/** AmmConfig (config.rs, Borsh): discriminator, bump 8, index 9, owner 11, protocol_fee_rate 43, trade_fee_rate 47,
 *  tick_spacing 51, fund_fee_rate 53, padding_u32 57, fund_owner 61, padding 93: 117 bytes. */
export const SOLANA_CLMM_CONFIG_BYTES = 117;
const CONFIG_DISC = [218, 244, 33, 104, 203, 203, 43, 111] as const; // sha256("account:AmmConfig")[..8]
const FEE_DEN = 1_000_000n;
/** pool_fee.rs MAX_FEE_RATE_NUMERATOR: no swap's fee is above 10%. */
const MAX_FEE_RATE = 100_000n;
deepFreeze(SOLANA_CLMM_POOL_STATIC);
/** Swaps disabled: PoolStatusBitIndex::Swap. */
const STATUS_SWAP_OFF = 1 << 4;
const READ_TIMEOUT_MS = 5_000;

export type SolanaClmmPool = {
  readonly ammConfig: string; readonly mint0: string; readonly mint1: string; readonly vault0: string; readonly vault1: string;
  readonly decimals0: number; readonly decimals1: number; readonly tickSpacing: number;
  readonly liquidity: bigint; readonly sqrtPriceX64: bigint; readonly tickCurrent: number; readonly status: number;
  /** 0: the fee comes off the input; 1: off token 0 only; 2: off token 1 only (pool_fee.rs is_fee_on_input). */
  readonly feeOn: number;
  readonly openTime: bigint;
  /** The dynamic fee's control and its volatility accumulator's cap; null where the pool has none (all 80 bytes 0). */
  readonly dynamicFee: { readonly control: bigint; readonly maxVolatility: bigint } | null;
};

const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u128 = (d: Uint8Array, o: number): bigint => dv(d).getBigUint64(o, true) + (dv(d).getBigUint64(o + 8, true) << 64n);
const key = (d: Uint8Array, o: number): string => base58.encode(d.subarray(o, o + 32));

/** A CLMM PoolState, checked: owner, size, discriminator. Throws on any other account. */
export function solanaDecodeClmmPool(acc: SolanaPoolAccount): SolanaClmmPool {
  if (acc.owner !== SOLANA_CLMM_PROGRAM) throw new Error("the CLMM pool is not owned by the CLMM program");
  const d = acc.data;
  if (d.length !== SOLANA_CLMM_POOL_BYTES) throw new Error("the CLMM pool is not a PoolState");
  if (POOL_DISC.some((b, i) => d[i] !== b)) throw new Error("the CLMM pool is not a PoolState");
  const tickSpacing = dv(d).getUint16(235, true);
  if (tickSpacing === 0) throw new Error("the CLMM pool's tick spacing is 0");
  const dyn = d.subarray(DYN_AT, DYN_AT + 80).some((x) => x !== 0);
  return {
    ammConfig: key(d, 9), mint0: key(d, 73), mint1: key(d, 105), vault0: key(d, 137), vault1: key(d, 169),
    decimals0: d[233]!, decimals1: d[234]!, tickSpacing,
    liquidity: u128(d, 237), sqrtPriceX64: u128(d, 253), tickCurrent: dv(d).getInt32(269, true), status: d[389]!,
    feeOn: d[390]!, openTime: dv(d).getBigUint64(1080, true),
    dynamicFee: dyn ? { control: BigInt(dv(d).getUint32(DYN_AT + 6, true)), maxVolatility: BigInt(dv(d).getUint32(DYN_AT + 10, true)) } : null,
  };
}

/** An AmmConfig's trade fee rate (millionths), checked: owner, size, discriminator. */
export function solanaDecodeClmmConfig(acc: SolanaPoolAccount): { tradeFeeRate: bigint } {
  if (acc.owner !== SOLANA_CLMM_PROGRAM) throw new Error("the CLMM config is not owned by the CLMM program");
  const d = acc.data;
  if (d.length !== SOLANA_CLMM_CONFIG_BYTES || CONFIG_DISC.some((b, i) => d[i] !== b)) throw new Error("the CLMM config is not an AmmConfig");
  const tradeFeeRate = BigInt(dv(d).getUint32(47, true));
  if (tradeFeeRate >= FEE_DEN) throw new Error("the CLMM trade fee is not below 100%");
  return { tradeFeeRate };
}

/** The pool's identity bytes equal on both reads (SOLANA_CLMM_POOL_STATIC). */
export function solanaClmmSamePool(a: SolanaPoolAccount, b: SolanaPoolAccount): boolean {
  if (a.owner !== b.owner || a.data.length !== b.data.length) return false;
  return SOLANA_CLMM_POOL_STATIC.every(([s, e]) => a.data.subarray(s, e).every((x, i) => x === b.data[s + i]));
}

/** Which side the quote is on for `mint`, and which quote (wSOL or USDC): null when the pool is not the coin's. */
export function solanaClmmSide(p: Pick<SolanaClmmPool, "mint0" | "mint1">, mint: string): { quoteIs0: boolean; quote: "sol" | "usdc" } | null {
  if (mint === SOLANA_SOL_MINT || mint === SOLANA_USDC_MINT) return null;
  for (const [q, quote] of [[SOLANA_SOL_MINT, "sol"], [SOLANA_USDC_MINT, "usdc"]] as const) {
    if (p.mint0 === q && p.mint1 === mint) return { quoteIs0: true, quote };
    if (p.mint1 === q && p.mint0 === mint) return { quoteIs0: false, quote };
  }
  return null;
}

/** What `amount` in pays out at the pool's spot price, before any fee and any move of the price (base units, floor):
 *  the price's own bound on the swap's out, never what it pays. P = sqrt² / 2^128 is token 1 per token 0. */
export function solanaClmmSpotOut(sqrtPriceX64: bigint, side: "buy" | "sell", amount: bigint, solIs0: boolean): bigint {
  const p = sqrtPriceX64 * sqrtPriceX64;
  if (p === 0n) return 0n;
  // a buy puts the quote in: out is token 1 when the quote is token 0; a sell puts the coin in
  const zeroIn = side === "buy" ? solIs0 : !solIs0;
  return zeroIn ? (amount * p) >> 128n : (amount << 128n) / p;
}

// ------------------------------------------------------------------------------------------------- the swap, one cell

const Q64 = 1n << 64n;
const U64_MAX = Q64 - 1n;
const U128_MAX = (1n << 128n) - 1n;
const MIN_TICK = -443636;
const MAX_TICK = 443636;
/** tick_math.rs get_sqrt_price_at_tick's factors, bit 0 to bit 18 (U128([lo, 0]) each). */
const TICK_FACTORS = [
  0xfffcb933bd6fb800n, 0xfff97272373d4000n, 0xfff2e50f5f657000n, 0xffe5caca7e10f000n, 0xffcb9843d60f7000n,
  0xff973b41fa98e800n, 0xff2ea16466c9b000n, 0xfe5dee046a9a3800n, 0xfcbe86c7900bb000n, 0xf987a7253ac65800n,
  0xf3392b0822bb6000n, 0xe7159475a2caf000n, 0xd097f3bdfd2f2000n, 0xa9f746462d9f8000n, 0x70d869a156f31c00n,
  0x31be135f97ed3200n, 0x9aa508b5b85a500n, 0x5d6af8dedc582cn, 0x2216e584f5fan,
] as const;
/** tick_math.rs get_sqrt_price_at_tick: √1.0001^tick in Q64.64, as the program computes it. */
export function solanaClmmSqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error("tick out of range");
  const abs = Math.abs(tick);
  let ratio = abs & 1 ? TICK_FACTORS[0] : Q64;
  for (let i = 1; i < TICK_FACTORS.length; i++) if (abs & (1 << i)) ratio = (ratio * TICK_FACTORS[i]!) >> 64n;
  return tick > 0 ? U128_MAX / ratio : ratio;
}
/** pool_fee.rs tick_spacing_index_from_tick: the cell a tick sits in, rounding toward minus infinity. */
const cellOf = (tick: number, spacing: number): number => (tick % spacing === 0 || tick >= 0 ? Math.trunc(tick / spacing) : Math.trunc(tick / spacing) - 1);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
/** liquidity_math.rs get_delta_amounts_for_swap: (in, out) between two prices, null past u64 (MaxTokenOverflow). */
function deltas(x: bigint, y: bigint, liquidity: bigint, zeroForOne: boolean): readonly [bigint, bigint] | null {
  const [a, b] = x > y ? [y, x] : [x, y];
  if (a === 0n) return null;
  const amount1X64 = liquidity * (b - a);
  const product = a * b;
  const [i, o] = zeroForOne ? [ceilDiv(amount1X64 << 64n, product), amount1X64 >> 64n] : [(amount1X64 + U64_MAX) >> 64n, (amount1X64 << 64n) / product];
  return i > U64_MAX || o > U64_MAX ? null : [i, o];
}
/** sqrt_price_math.rs get_next_sqrt_price_from_input. */
function nextFromInput(sqrt: bigint, liquidity: bigint, amount: bigint, zeroForOne: boolean): bigint {
  if (amount === 0n) return sqrt;
  if (zeroForOne) {
    const n = liquidity << 64n;
    return ceilDiv(n * sqrt, n + amount * sqrt);
  }
  return sqrt + (amount << 64n) / liquidity;
}

/** The fee rate (millionths) a floor prices at: the config's trade fee, plus, on a pool with a dynamic fee, that fee at
 *  its volatility accumulator's cap (swap.rs compute_dynamic_fee_rate: ceil(control × (va × spacing)² / (1e5 × 1e8)),
 *  the total at most MAX_FEE_RATE_NUMERATOR 100,000). The swap's own accumulator is never above its cap, so its fee is
 *  never above this one. */
export function solanaClmmFloorFeeRate(tradeFeeRate: bigint, p: Pick<SolanaClmmPool, "dynamicFee" | "tickSpacing">): bigint {
  let dynamic = 0n;
  if (p.dynamicFee) {
    const crossed = p.dynamicFee.maxVolatility * BigInt(p.tickSpacing);
    dynamic = ceilDiv(p.dynamicFee.control * crossed * crossed, 100_000n * 10_000n * 10_000n);
  }
  const total = tradeFeeRate + dynamic;
  return total > MAX_FEE_RATE ? MAX_FEE_RATE : total;
}

// ------------------------------------------------------------------------------------------------- the swap, across ticks

/** TickArrayState (tick_array.rs, Anchor zero_copy, repr(C, packed)): discriminator, pool_id 8, start_tick_index 40
 *  (i32), 60 TickStates of 168 bytes from 44, initialized_tick_count, recent_epoch, padding: 10,240 bytes. A TickState:
 *  tick 0 (i32), liquidity_net 4 (i128), liquidity_gross 20 (u128), fee and reward growths, order_phase 116,
 *  orders_amount 124 (u64), part_filled_orders_remaining 132 (u64), unfilled_ratio_x64 140, padding (raydium-clmm
 *  6d7a0f8). Read on mainnet 24 Nov 09:28Z (test/vectors/mplx-clmm-sim.json): MPLX's pool BxRhW4q1…, its arrays
 *  -3000, -2400 and -1800, each 10,240 bytes with this discriminator, its pool and its start, each initialized tick at
 *  its own slot. */
export const SOLANA_CLMM_TICK_ARRAY_BYTES = 10_240;
const TICK_ARRAY_DISC = [192, 155, 85, 205, 49, 249, 129, 42] as const; // sha256("account:TickArrayState")[..8]
const TICK_ARRAY_SIZE = 60;
const TICKS_AT = 44;
const TICK_BYTES = 168;
/** The tick arrays one read takes: the one that holds the pool's tick and the next two in the swap's direction, the
 *  arrays a swap_v2 is passed (test/fixtures/solana-clmm-capture.mjs). [design: 3: 120 to 180 tick-spacing cells past
 *  the price, a move of 12% to 20% at MPLX's spacing 10, where one cell held 6.4 to 9 SOL (24 Nov 09:12Z); a fourth
 *  array adds 10,240 bytes to each provider's read of each market.] */
export const SOLANA_CLMM_TICK_ARRAYS = 3;

/** tick_array.rs get_array_start_index: the first tick of the array that holds `tick`. */
export function solanaClmmTickArrayStart(tick: number, spacing: number): number {
  const n = TICK_ARRAY_SIZE * spacing;
  return (tick < 0 && tick % n !== 0 ? Math.trunc(tick / n) - 1 : Math.trunc(tick / n)) * n;
}
/** A tick array's address: ["tick_array", pool, its start as a big-endian i32] (tick_array.rs TickArrayState::key). */
export function solanaClmmTickArray(pool: string, start: number): string {
  const be = new Uint8Array(4);
  new DataView(be.buffer).setInt32(0, start, false);
  return solanaProgramAddress([new TextEncoder().encode("tick_array"), base58.decode(pool), be], SOLANA_CLMM_PROGRAM);
}
/** The starts of the arrays a swap in `side`'s direction walks from the pool's tick, at most SOLANA_CLMM_TICK_ARRAYS and
 *  none wholly past the tick range; none for a pool that is not the coin's. */
export function solanaClmmWalkStarts(p: Pick<SolanaClmmPool, "mint0" | "mint1" | "tickCurrent" | "tickSpacing">, token: string, side: "buy" | "sell"): number[] {
  const s = solanaClmmSide(p, token);
  if (s === null) return [];
  // a buy puts the quote in; zero_for_one when the input is token 0
  const zeroForOne = side === "buy" ? s.quoteIs0 : !s.quoteIs0;
  const n = TICK_ARRAY_SIZE * p.tickSpacing;
  const first = solanaClmmTickArrayStart(p.tickCurrent, p.tickSpacing);
  const starts: number[] = [];
  for (let i = 0; i < SOLANA_CLMM_TICK_ARRAYS; i++) {
    const start = first + (zeroForOne ? -i : i) * n;
    if (start + n <= MIN_TICK || start > MAX_TICK) break;
    starts.push(start);
  }
  return starts;
}

/** The ticks a swap may walk: the price may move from the pool's to the price of any tick in [lo, hi], and `at` holds
 *  every initialized tick there (one with liquidity or a limit order) with its liquidity_net (0 for an order alone).
 *  Past lo or hi nothing is known. */
export type SolanaClmmTicks = { readonly lo: number; readonly hi: number; readonly at: ReadonlyMap<number, bigint> };

const i128 = (d: Uint8Array, o: number): bigint => dv(d).getBigUint64(o, true) + (dv(d).getBigInt64(o + 8, true) << 64n);
/** A tick array's initialized ticks with their liquidity_net, checked: owner, size, discriminator, its pool, its start,
 *  each initialized tick at its own slot (TickState::initialize); null for any other account. */
function arrayTicks(acc: SolanaPoolAccount, pool: string, start: number, spacing: number): Map<number, bigint> | null {
  const d = acc.data;
  if (acc.owner !== SOLANA_CLMM_PROGRAM || d.length !== SOLANA_CLMM_TICK_ARRAY_BYTES || TICK_ARRAY_DISC.some((b, i) => d[i] !== b)) return null;
  if (key(d, 8) !== pool || dv(d).getInt32(40, true) !== start) return null;
  const at = new Map<number, bigint>();
  for (let k = 0; k < TICK_ARRAY_SIZE; k++) {
    const o = TICKS_AT + k * TICK_BYTES;
    const liquid = u128(d, o + 20) > 0n;
    // tick_array.rs is_initialized: liquidity, or a limit order not yet filled
    if (!liquid && dv(d).getBigUint64(o + 124, true) === 0n && dv(d).getBigUint64(o + 132, true) === 0n) continue;
    const tick = dv(d).getInt32(o, true);
    if (tick !== start + k * spacing) return null;
    at.set(tick, liquid ? i128(d, o + 4) : 0n);
  }
  return at;
}
/**
 * The ticks both providers read alike, from the array that holds the pool's tick on in the walk's direction
 * (`starts`, solanaClmmWalkStarts): an array absent on both (the program makes one at its first initialized tick, so
 * none is initialized), or the same initialized ticks with the same liquidity_net on both. The walk ends before the first
 * array that is neither: never credit past what both read. Null when that is the first.
 */
export function solanaClmmAgreedTicks(a: readonly (SolanaPoolAccount | null)[], b: readonly (SolanaPoolAccount | null)[], starts: readonly number[], pool: string, spacing: number): SolanaClmmTicks | null {
  const at = new Map<number, bigint>();
  let k = 0;
  for (const [i, start] of starts.entries()) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    if (x !== null || y !== null) {
      const tx = x === null ? null : arrayTicks(x, pool, start, spacing);
      const ty = y === null ? null : arrayTicks(y, pool, start, spacing);
      if (tx === null || ty === null || tx.size !== ty.size || [...tx].some(([t, net]) => ty.get(t) !== net)) break;
      for (const [t, net] of tx) at.set(t, net);
    }
    k++;
  }
  if (k === 0) return null;
  const n = TICK_ARRAY_SIZE * spacing;
  const ends = [starts[0]!, starts[k - 1]!];
  return { lo: Math.max(MIN_TICK, Math.min(...ends)), hi: Math.min(MAX_TICK, Math.max(...ends) + n), at };
}

/** swap_math.rs compute_swap with exact input: one step's out, the input it spends (its fee too where the fee is on the
 *  input) and whether it reached its target. */
function step(sqrt: bigint, target: bigint, liquidity: bigint, remaining: bigint, feeRate: bigint, zeroForOne: boolean, feeOnInput: boolean): { out: bigint; spent: bigint; reached: boolean } {
  const forPrice = feeOnInput ? (remaining * (FEE_DEN - feeRate)) / FEE_DEN : remaining;
  const at = deltas(target, sqrt, liquidity, zeroForOne);
  let out: bigint;
  let spent: bigint;
  const reached = at !== null && forPrice >= at[0];
  if (reached) {
    out = at[1];
    spent = feeOnInput ? at[0] + ceilDiv(at[0] * feeRate, FEE_DEN - feeRate) : at[0];
  } else {
    // the price the input reaches short of the target: the whole input spent (the rest the fee, or dust to the pool)
    const d = deltas(nextFromInput(sqrt, liquidity, forPrice, zeroForOne), sqrt, liquidity, zeroForOne);
    out = d === null ? 0n : d[1];
    spent = remaining;
  }
  if (!feeOnInput) out -= ceilDiv(out * feeRate, FEE_DEN);
  return { out: out > 0n ? out : 0n, spent: spent < remaining ? spent : remaining, reached };
}

/**
 * What an exact input pays out of the pool as the program's swap computes it (swap.rs swap_internal, swap_math.rs
 * compute_swap, no price limit): from the pool's price to the next initialized tick, across it with its liquidity_net,
 * on to the next; on a pool with a dynamic fee a step ends at each tick-spacing edge too, as the program's does. Only
 * inside `ticks` (both providers' arrays agreed, solanaClmmAgreedTicks; null: the pool's current tick-spacing cell,
 * where no tick is initialized): an input that would move the price past them is priced only to their edge, the rest
 * given no out (`whole` false), a floor, never credit past what was read. A limit order is never counted: the program
 * fills one at its tick's price, the best the swap meets there, before it crosses, so wherever one rests the floor is
 * under the program's out, and elsewhere it is the program's to the unit. Every step's fee is the floor's
 * (solanaClmmFloorFeeRate), off the input or off the output by fee_on.
 */
export function solanaClmmSwapOut(p: Pick<SolanaClmmPool, "sqrtPriceX64" | "liquidity" | "tickCurrent" | "tickSpacing" | "feeOn" | "dynamicFee">, feeRate: bigint, zeroForOne: boolean, amountIn: bigint, ticks: SolanaClmmTicks | null = null): { out: bigint; whole: boolean } {
  if (amountIn <= 0n || p.sqrtPriceX64 === 0n) return { out: 0n, whole: false };
  const spacing = p.tickSpacing;
  const cell = cellOf(p.tickCurrent, spacing);
  const own: SolanaClmmTicks = { lo: Math.max(MIN_TICK, cell * spacing), hi: Math.min(MAX_TICK, (cell + 1) * spacing), at: new Map() };
  // ticks that do not hold this read's price (a read of another moment than the list's) leave it its own cell only
  const held = ticks !== null && p.tickCurrent >= ticks.lo && p.tickCurrent < ticks.hi && p.sqrtPriceX64 >= solanaClmmSqrtPriceAtTick(ticks.lo) && p.sqrtPriceX64 <= solanaClmmSqrtPriceAtTick(ticks.hi);
  const known = held ? ticks : own;
  const end = zeroForOne ? known.lo : known.hi;
  // the initialized ticks the walk meets, in its order: at or under its cell's lower edge going down, past its cell going up
  const met = [...known.at.keys()].filter((t) => (zeroForOne ? t <= cell * spacing && t > end : t > cell * spacing && t < end)).sort((x, y) => (zeroForOne ? y - x : x - y));
  const feeOnInput = p.feeOn === 1 ? zeroForOne : p.feeOn === 2 ? !zeroForOne : true;
  let sqrt = p.sqrtPriceX64;
  let liquidity = p.liquidity;
  let remaining = amountIn;
  let out = 0n;
  let i = 0;
  let edge = zeroForOne ? cell * spacing : (cell + 1) * spacing;
  for (;;) {
    let target = i < met.length ? met[i]! : end;
    if (p.dynamicFee !== null) target = zeroForOne ? Math.max(target, edge) : Math.min(target, edge);
    if (zeroForOne ? target < end : target > end) target = end;
    const price = solanaClmmSqrtPriceAtTick(target);
    // a price already past the step's target is a read no swap leaves: priced no further
    if (zeroForOne ? price > sqrt : price < sqrt) return { out, whole: false };
    const s = step(sqrt, price, liquidity, remaining, feeRate, zeroForOne, feeOnInput);
    out += s.out;
    remaining -= s.spent;
    if (!s.reached || remaining === 0n) return { out, whole: true };
    sqrt = price;
    if (target === end) return { out, whole: false };
    if (i < met.length && met[i] === target) {
      // swap.rs: liquidity_net is added crossing up and taken off crossing down
      const net = known.at.get(target)!;
      liquidity = zeroForOne ? liquidity - net : liquidity + net;
      if (liquidity < 0n) return { out, whole: false };
      i++;
    }
    edge = zeroForOne ? target - spacing : target + spacing;
  }
}

/** The account list one CLMM read asks for: the pool, its AmmConfig, its two vaults, the coin's mint, the Clock, and,
 *  given a side, the tick arrays a swap of that side walks from the pool's tick (solanaClmmWalkStarts). */
export function solanaClmmReadList(address: string, p: Pick<SolanaClmmPool, "ammConfig" | "vault0" | "vault1" | "mint0" | "mint1" | "tickCurrent" | "tickSpacing">, token: string, side?: "buy" | "sell"): string[] {
  const head = [address, p.ammConfig, p.vault0, p.vault1, token, SOLANA_CLOCK_SYSVAR];
  return side === undefined ? head : [...head, ...solanaClmmWalkStarts(p, token, side).map((s) => solanaClmmTickArray(address, s))];
}

/** A coin's transfer fee in `epoch` from its mint: the TransferFeeConfig extension's (dlmm.ts layout), and no other.
 *  For a market only read, every other Token-2022 extension leaves the base units a swap moves as they are. */
export function solanaClmmCoinTransferFee(mint: SolanaPoolAccount, epoch: bigint): SolanaTransferFee | null {
  if (mint.owner === SOLANA_TOKEN_PROGRAM) return null;
  if (mint.owner !== SOLANA_TOKEN_2022_PROGRAM) throw new Error("the coin's mint is not a token mint");
  const d = mint.data;
  if (d.length === 82) return null;
  if (d.length < 166 || d[165] !== 1) throw new Error("not a Token-2022 mint");
  for (let o = 166; o + 4 <= d.length; ) {
    const type = dv(d).getUint16(o, true);
    const len = dv(d).getUint16(o + 2, true);
    if (type === 0) break;
    if (o + 4 + len > d.length) throw new Error("mint extension cut");
    if (type === 1) {
      if (len !== 108) throw new Error("TransferFeeConfig is not 108 bytes");
      const v = o + 4 + 72;
      const at = (x: number) => ({ epoch: dv(d).getBigUint64(x, true), max: dv(d).getBigUint64(x + 8, true), bps: BigInt(dv(d).getUint16(x + 16, true)) });
      const newer = at(v + 18);
      const f = epoch >= newer.epoch ? newer : at(v);
      if (f.bps > 10_000n) throw new Error("transfer fee over 10,000 bps");
      return f.bps === 0n ? null : { bps: f.bps, max: f.max };
    }
    o += 4 + len;
  }
  return null;
}

/** SOL's USD price as the device read it on two providers (price/pool-usd.ts poolUsdPrice: Pyth's SOL/USD, agreed and
 *  fresh): USD per SOL = price × 10^expo. A USDC market is priced through it, USDC taken at one dollar. */
export type SolanaClmmSolUsd = { readonly price: bigint; readonly expo: number };
const pow10 = (n: number): bigint => 10n ** BigInt(n);
/** Lamports as USDC base units at `u`, floor: lamports × price × 10^(expo − 3). */
export function solanaLamportsAsUsdc(lamports: bigint, u: SolanaClmmSolUsd): bigint {
  const e = u.expo - 3;
  return e >= 0 ? lamports * u.price * pow10(e) : (lamports * u.price) / pow10(-e);
}
/** USDC base units as lamports at `u`, floor. */
export function solanaUsdcAsLamports(usdc: bigint, u: SolanaClmmSolUsd): bigint {
  const e = u.expo - 3;
  return e >= 0 ? usdc / (u.price * pow10(e)) : (usdc * pow10(-e)) / u.price;
}

/** One provider's read of a market: its depth in lamports (the quote vault, a USDC one through SOL/USD), and its floor
 *  out for the request's amount and each leg amount (solanaClmmSwapOut, the coin's transfer fee taken off). */
export type SolanaClmmRead = { readonly depth: bigint; readonly out: bigint; readonly whole: boolean; readonly outs: readonly bigint[]; readonly spotOut: bigint };
/** A CLMM market both providers agree on. Never a route: no CLMM account is ever signed (the module note). */
export type SolanaClmmMarket = { readonly address: string; readonly quote: "sol" | "usdc"; readonly reads: readonly [SolanaClmmRead, SolanaClmmRead]; readonly slots: readonly [number, number] };
export type SolanaClmmVerdict = { kind: "ok"; market: SolanaClmmMarket } | { kind: "none" } | { kind: "bad"; why: string };
export type SolanaClmmRequest = { token: string; pool: string; side: "buy" | "sell"; amount: bigint; amounts?: readonly bigint[] };

/** The accounts of a read before its tick arrays (solanaClmmReadList). */
const LIST_HEAD = 6;
type Read = ReturnType<typeof solanaParseAccountsAnswer>;
type Got = { read: Read; fault: string | null };
type One = { pool: SolanaClmmPool; side: { quoteIs0: boolean; quote: "sol" | "usdc" }; vaults: readonly [bigint, bigint]; fee: bigint; coinFee: SolanaTransferFee | null; open: boolean };
const fail = (why: string): never => {
  throw new Error(why);
};

/** One provider's read of a market: its accounts checked against the pool's own names. A string: why not. */
function one(acc: (SolanaPoolAccount | null)[], address: string, token: string): One | "none" | string {
  const pa = acc[0] ?? null;
  if (pa === null) return "none";
  const pool = solanaDecodeClmmPool(pa);
  const side = solanaClmmSide(pool, token);
  if (side === null) return "none";
  const config = acc[1] ?? null;
  if (config === null) return "the CLMM config is missing";
  const { tradeFeeRate } = solanaDecodeClmmConfig(config);
  const held: bigint[] = [];
  for (const [i, v] of [acc[2] ?? null, acc[3] ?? null].entries()) {
    const mint = i === 0 ? pool.mint0 : pool.mint1;
    if (v === null) return "a CLMM vault is missing";
    // wSOL and USDC are SPL Token; the coin may be either token program
    const programs = mint === token ? [SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM] : [SOLANA_TOKEN_PROGRAM];
    if (!programs.includes(v.owner)) return "a CLMM vault is not a token account";
    const t = solanaDecodeTokenAccount(v);
    if (t.mint !== mint || t.owner !== address) return "a CLMM vault of another mint or owner";
    held.push(t.amount);
  }
  const mint = acc[4] ?? null;
  if (mint === null) return "the coin's mint is missing";
  const clock = solanaDecodeClock(acc[5] ?? fail("no Clock"));
  const coinFee = solanaClmmCoinTransferFee(mint, clock.epoch);
  const swaps = (pool.status & STATUS_SWAP_OFF) === 0;
  const open = swaps && BigInt.asUintN(64, clock.unixTimestamp) >= pool.openTime && pool.liquidity > 0n && pool.sqrtPriceX64 > 0n;
  return { pool, side, vaults: [held[0]!, held[1]!], fee: solanaClmmFloorFeeRate(tradeFeeRate, pool), coinFee, open };
}

/** A provider's floor out for `amount` (lamports on a buy, the coin on a sell) on its own read, across the ticks both
 *  providers agree on. */
function priced(o: One, side: "buy" | "sell", amount: bigint, solUsd: SolanaClmmSolUsd | null, ticks: SolanaClmmTicks | null): { out: bigint; whole: boolean } {
  const usdc = o.side.quote === "usdc";
  // a buy puts the quote in; zero_for_one when the input is token 0
  const zeroForOne = side === "buy" ? o.side.quoteIs0 : !o.side.quoteIs0;
  if (side === "buy") {
    const into = usdc ? solanaLamportsAsUsdc(amount, solUsd!) : amount;
    const r = solanaClmmSwapOut(o.pool, o.fee, zeroForOne, into, ticks);
    return { out: r.out - solanaTransferFeeOf(o.coinFee, r.out), whole: r.whole };
  }
  const r = solanaClmmSwapOut(o.pool, o.fee, zeroForOne, amount - solanaTransferFeeOf(o.coinFee, amount), ticks);
  return { out: usdc ? solanaUsdcAsLamports(r.out, solUsd!) : r.out, whole: r.whole };
}

/** The verdict on both providers' reads of `list`, whose accounts past the first six are the tick arrays at `starts`. */
function judge(req: SolanaClmmRequest, solUsd: SolanaClmmSolUsd | null, ga: Got, gb: Got, starts: readonly number[]): SolanaClmmVerdict | { kind: "usd" } {
  const a = ga.read;
  const b = gb.read;
  if (!a || !b) {
    const why = [ga, gb].flatMap((g, i) => (g.read ? [] : [`provider ${"AB"[i]} gave no answer${g.fault ? ` (${g.fault})` : " (not an accounts read)"}`]));
    return { kind: "bad", why: why.join(", ") };
  }
  const address = req.pool;
  try {
    const pa = a.accounts[0] ?? null;
    const pb = b.accounts[0] ?? null;
    if (pa === null && pb === null) return { kind: "none" };
    // an address both providers hold as some other program's account is no CLMM market
    if (pa !== null && pb !== null && pa.owner !== SOLANA_CLMM_PROGRAM && pb.owner !== SOLANA_CLMM_PROGRAM) return { kind: "none" };
    if (pa === null || pb === null || !solanaClmmSamePool(pa, pb)) return { kind: "bad", why: "the CLMM pool's static bytes differ" };
    if (a.accounts.length === 1) return { kind: "bad", why: "the CLMM pool was read alone" };
    const ca = a.accounts[1] ?? null;
    const cb = b.accounts[1] ?? null;
    if (ca === null || cb === null || ca.owner !== cb.owner || ca.data.length !== cb.data.length || ca.data.some((x, i) => x !== cb.data[i])) return { kind: "bad", why: "the CLMM config differs" };
    const x = one(a.accounts, address, req.token);
    const y = one(b.accounts, address, req.token);
    if (x === "none" && y === "none") return { kind: "none" };
    if (typeof x === "string") return { kind: "bad", why: x };
    if (typeof y === "string") return { kind: "bad", why: y };
    if (!x.open && !y.open) return { kind: "none" };
    if (!x.open || !y.open) return { kind: "bad", why: "the CLMM pool is open on one provider only" };
    if ((x.coinFee?.bps ?? 0n) !== (y.coinFee?.bps ?? 0n) || (x.coinFee?.max ?? 0n) !== (y.coinFee?.max ?? 0n)) return { kind: "bad", why: "the coin's transfer fee differs" };
    const q = x.side.quoteIs0 ? 0 : 1;
    if (x.vaults[q] === 0n && y.vaults[q] === 0n) return { kind: "none" };
    if (!solanaReservesAgree(x.vaults[q]!, y.vaults[q]!)) return { kind: "bad", why: "the CLMM pool's quote vault is outside the band" };
    if (!solanaReservesAgree(x.pool.sqrtPriceX64 ** 2n, y.pool.sqrtPriceX64 ** 2n)) return { kind: "bad", why: "the CLMM pool's price is outside the band" };
    if (!solanaReservesAgree(x.pool.liquidity, y.pool.liquidity)) return { kind: "bad", why: "the CLMM pool's liquidity is outside the band" };
    if (x.side.quote === "usdc" && solUsd === null) return { kind: "usd" };
    const ticks = solanaClmmAgreedTicks(a.accounts.slice(LIST_HEAD), b.accounts.slice(LIST_HEAD), starts, address, x.pool.tickSpacing);
    const read = (o: One): SolanaClmmRead => {
      const r = priced(o, req.side, req.amount, solUsd, ticks);
      const usdc = o.side.quote === "usdc";
      const depth = usdc ? solanaUsdcAsLamports(o.vaults[q]!, solUsd!) : o.vaults[q]!;
      const spotIn = req.side === "buy" && usdc ? solanaLamportsAsUsdc(req.amount, solUsd!) : req.amount;
      const spot = solanaClmmSpotOut(o.pool.sqrtPriceX64, req.side, spotIn, o.side.quoteIs0);
      const spotOut = req.side === "sell" && usdc ? solanaUsdcAsLamports(spot, solUsd!) : spot;
      return { depth, out: r.out, whole: r.whole, outs: (req.amounts ?? []).map((k) => priced(o, req.side, k, solUsd, ticks).out), spotOut };
    };
    return { kind: "ok", market: { address, quote: x.side.quote, reads: [read(x), read(y)], slots: [a.slot, b.slot] } };
  } catch (e) {
    return { kind: "bad", why: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}

/**
 * A coin's CLMM pool `pool` (quoted in wSOL or USDC), read on both providers as a market the device does not trade: its
 * depth in lamports and its floor out for the request's amount and legs where the two agree, "none" where it is no
 * market for the coin, and why not where they still disagree after one read more. The accounts to read come from
 * provider A's read of the pool (B's when A has none); the judge holds both to the same identity bytes and the list to
 * the accounts those bytes name. A USDC market asks `solUsd` (the device's agreed SOL/USD read) once, only then; its
 * refusal is the market's. Throws only on a request or provider pair that is not one.
 */
export async function readSolanaClmmMarket(providers: readonly [SolanaRpc, SolanaRpc], req: SolanaClmmRequest, solUsd: () => Promise<SolanaClmmSolUsd> = () => Promise.reject(new Error("no SOL/USD read"))): Promise<SolanaClmmVerdict> {
  if (!Array.isArray(providers) || providers.length !== 2 || typeof providers[0] !== "function" || typeof providers[1] !== "function") throw new Error("two providers are needed");
  if (solanaSameProvider(providers[0], providers[1])) throw new Error("the two providers are the same provider: a market must never rest on one provider's word");
  if (req?.side !== "buy" && req?.side !== "sell") throw new Error("side must be buy or sell");
  const u64 = (x: unknown) => typeof x === "bigint" && x > 0n && x <= U64_MAX;
  if (!u64(req.amount)) throw new Error("amount must be a positive u64");
  if (req.amounts !== undefined && (!Array.isArray(req.amounts) || req.amounts.length > 64 || !req.amounts.every(u64))) throw new Error("each leg amount must be a positive u64, at most 64");
  for (const k of [req.token, req.pool]) if (typeof k !== "string" || base58.decode(k).length !== 32) throw new Error("not a 32-byte address");
  const readBoth = (list: string[]): Promise<[Got, Got]> =>
    Promise.all(providers.map((rpc) =>
      Promise.resolve().then(() => solanaTimedRpc(rpc, READ_TIMEOUT_MS)("getMultipleAccounts", [list, { encoding: "base64", commitment: "confirmed" }])).then(
        (ans): Got => ({ read: solanaParseAccountsAnswer(ans, list.length), fault: null }),
        (e: unknown): Got => ({ read: null, fault: solanaCallFault(e) }),
      ),
    )) as Promise<[Got, Got]>;
  let usd: SolanaClmmSolUsd | null = null;
  let last: SolanaClmmVerdict = { kind: "bad", why: "no read" };
  for (let round = 0; round < 2; round++) {
    const [ha, hb] = await readBoth([req.pool]);
    const head = [ha.read?.accounts[0], hb.read?.accounts[0]].find((x) => x != null) ?? null;
    let list: string[] | null = null;
    let starts: number[] = [];
    try {
      if (head !== null && head.owner === SOLANA_CLMM_PROGRAM) {
        const p = solanaDecodeClmmPool(head);
        starts = solanaClmmWalkStarts(p, req.token, req.side);
        list = solanaClmmReadList(req.pool, p, req.token, req.side);
      }
    } catch (e) {
      last = { kind: "bad", why: String(e instanceof Error ? e.message : e).slice(0, 200) };
      continue;
    }
    if (list === null) {
      const v = judge(req, usd, ha, hb, []);
      if (v.kind === "none") return v;
      last = v.kind === "bad" ? v : { kind: "bad", why: "no CLMM pool" };
      continue;
    }
    const [a, b] = await readBoth(list);
    let v = judge(req, usd, a, b, starts);
    if (v.kind === "usd") {
      try {
        usd = await solUsd();
        if (typeof usd?.price !== "bigint" || usd.price <= 0n || !Number.isInteger(usd.expo) || Math.abs(usd.expo) > 30) throw new Error("not a price");
      } catch (e) {
        return { kind: "bad", why: `no SOL/USD price for a USDC market (${String(e instanceof Error ? e.message : e).slice(0, 120)})` };
      }
      v = judge(req, usd, a, b, starts);
    }
    if (v.kind === "usd") return { kind: "bad", why: "no SOL/USD price for a USDC market" };
    last = v;
    if (last.kind !== "bad") return last;
  }
  return last;
}

// ------------------------------------------------------------------------------------------------- finding a coin's markets

/** The most CLMM markets one reference read takes: SOLANA_CLMM_MAX_POOLS / 2 of each quote at most past a scan's 8. */
export const SOLANA_CLMM_MAX_POOLS = 16;
/** A pool's vault of `mint`: ["pool_vault", pool, mint] (both of MPLX's BxRhW4q1… read so, 21 Nov). */
export const solanaClmmVault = (pool: string, mint: string): string => solanaProgramAddress([new TextEncoder().encode("pool_vault"), base58.decode(pool), base58.decode(mint)], SOLANA_CLMM_PROGRAM);
/** The scan of the CLMM pools whose token 0 is `x` and token 1 is `y`: getProgramAccounts with the pool's size and both
 *  mints, addresses only. The helper's /v1/rpc/solana carries this exact shape and no wider one. */
export const solanaClmmPoolScan = (x: string, y: string): readonly unknown[] => [
  SOLANA_CLMM_PROGRAM,
  { commitment: "confirmed", encoding: "base64", withContext: true, dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: SOLANA_CLMM_POOL_BYTES }, { memcmp: { offset: 73, bytes: x } }, { memcmp: { offset: 105, bytes: y } }] },
];
const scanKind = (quote: string): SolanaPoolScanKind => ({ name: "CLMM pool", scan: (x, y) => solanaClmmPoolScan(x, y), solReserves: solanaDerivedReserves((p) => solanaClmmVault(p, quote)), ordered: true });
/**
 * A coin's Raydium CLMM markets quoted in wSOL and in USDC, for the reference's `clmmPools` (pool.ts
 * readSolanaReferenceWhy, which reads and judges each one on both of its providers, as a market it never trades):
 * dlmm.ts solanaScannedPools over the CLMM pool scan for each quote, one scan each: the program makes a pool only with
 * its lower mint as token 0 (create_pool.rs, raydium-clmm 6d7a0f8), so the coin is token 0 or 1 by its bytes against
 * the quote's; ranked past 8 by each pool's vault of that quote.
 */
export async function readSolanaClmmPools(scan: readonly [SolanaRpc, SolanaRpc], read: readonly [SolanaRpc, SolanaRpc], mint: string): Promise<string[]> {
  if (mint === SOLANA_USDC_MINT) return [];
  const [sol, usdc] = await Promise.all([SOLANA_SOL_MINT, SOLANA_USDC_MINT].map((q) => solanaScannedPools(scanKind(q), scan, read, mint, q)));
  return [...new Set([...sol!, ...usdc!])].sort();
}
