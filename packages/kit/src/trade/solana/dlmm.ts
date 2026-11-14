// Meteora DLMM as a reference venue (card solana-buy-reaches-raydium-and-meteora). Device side, keyless: the pair, its
// bin arrays, the reserves and the Clock read on two providers, never one alone, and what an exact input pays out of
// them computed here, net of the pair's base and variable fee, as the program pays it. Nothing comes from a route, the
// helper or market data: a pair address only names where to read (a hostile list can add a pair the reads then judge,
// or leave one out; solanaDlmmPairs asks two providers and keeps every pair either names).
//
// Sources, read 2026-11-14 21:30Z-21:45Z (date -u):
//  - Layouts, discriminators, constants and the swap instruction: @meteora-ag/dlmm 1.9.14 (npm tarball sha256
//    daeae44073c451398cd0264651539416b5358783f734668f9a2c830a2c1db8ca), its IDL (program
//    LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo, version 0.12.0): LbPair 904 bytes (parameters at 8, v_parameters at
//    40, active_id 76, bin_step 80, status 82, activation_type 86, token_x_mint 88, token_y_mint 120, reserve_x 152,
//    reserve_y 184, reward_infos 264 (2 x 144, mint first), oracle 552, activation_point 816, token program flags 880
//    and 881); BinArray 10,136 bytes (index i64 at 8, lb_pair at 24, 70 bins of 144 from 56); Bin: amount_x 0,
//    amount_y 8, price u128 16 (Q64.64, Y per X), open_order_amount 112, processed_order_remaining_amount 128,
//    limit_order_ask_side 140. FEE_PRECISION 1e9, MAX_FEE_RATE 1e8, BASIS_POINT_MAX 1e4, MAX_BIN_PER_ARRAY 70,
//    BIN_ARRAY_BITMAP_SIZE 512.
//  - Math: the same package's src/dlmm/index.ts swapQuote (updateReference once at the Clock's time, then per bin with
//    liquidity updateVolatilityAccumulator and swapExactInQuoteAtBin), helpers/bin.ts (swapExactInQuoteAtBin,
//    getExactInFillAmountResult, getBinMaxAmountOut, getAmountIn/Out), helpers/fee.ts (getBaseFee, getVariableFee,
//    getTotalFee, getExcludedFeeAmount, getIncludedFeeAmount), helpers/lbPair.ts (isSupportLimitOrder, getFeeMode),
//    helpers/math.ts (mulShr, shlDiv), helpers/binArray.ts (binIdToBinArrayIndex, getBinFromBinArray).
//
// What is not a candidate (verdict "none", never a guess): a pair not quoted in wSOL, a disabled pair, one not yet
// active, a Token-2022 coin with an extension not priced here (a transfer hook and the others solanaCoinTransferFee
// names; its transfer fee is priced), an active bin outside the pair's own bitmap
// (its extension account is not read), and an input the read bin arrays cannot fill.
import { base58, base64 } from "@scure/base";
import { deepFreeze } from "../../freeze.ts";
import { solanaProgramAddress } from "../../checks/solana/message.ts";
import { SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM } from "../../checks/solana/checks.ts";
import { solanaTimedRpc, type SolanaRpc } from "./send.ts";

export const SOLANA_DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const SOLANA_CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111";
const SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";
export const SOLANA_DLMM_EVENT_AUTHORITY = solanaProgramAddress([new TextEncoder().encode("__event_authority")], SOLANA_DLMM_PROGRAM);
export const SOLANA_DLMM_PAIR_BYTES = 904;
const BIN_ARRAY_BYTES = 10_136;
const BINS = 70;
/** The bin arrays a read takes: the active one and the next two the swap walks into. */
export const SOLANA_DLMM_ARRAYS = 3;
/** The most pairs one reference read prices. */
export const SOLANA_DLMM_MAX_PAIRS = 8;
const FEE_PRECISION = 1_000_000_000n;
const MAX_FEE_RATE = 100_000_000n;
const BPS = 10_000n;
const PAIR_DISC = [33, 11, 49, 98, 181, 101, 177, 13] as const;
const ARRAY_DISC = [92, 142, 92, 220, 5, 148, 70, 181] as const;
/** The LbPair bytes two honest reads at two slots may differ in: v_parameters, active_id, protocol_fee, reward_infos,
 *  bin_array_bitmap, last_updated_at. Every other byte must be the same on both providers. */
export const SOLANA_DLMM_PAIR_MOVING: readonly (readonly [number, number])[] = [[40, 72], [76, 80], [216, 232], [264, 552], [584, 720]];
deepFreeze(SOLANA_DLMM_PAIR_MOVING);

export type SolanaDlmmAccount = { owner: string; data: Uint8Array };

export type SolanaDlmmPair = {
  readonly baseFactor: bigint; readonly filterPeriod: bigint; readonly decayPeriod: bigint; readonly reductionFactor: bigint;
  readonly variableFeeControl: bigint; readonly maxVolatilityAccumulator: bigint; readonly minBinId: number; readonly maxBinId: number;
  readonly baseFeePowerFactor: bigint; readonly functionType: number; readonly collectFeeMode: number;
  readonly volatilityAccumulator: bigint; readonly volatilityReference: bigint; readonly indexReference: number; readonly lastUpdateTimestamp: bigint;
  readonly activeId: number; readonly binStep: bigint; readonly status: number; readonly activationType: number;
  readonly tokenX: string; readonly tokenY: string; readonly reserveX: string; readonly reserveY: string; readonly oracle: string;
  readonly rewardMints: readonly [string, string]; readonly bitmapExtensionNeeded: boolean; readonly activationPoint: bigint;
  readonly tokenXFlag: number; readonly tokenYFlag: number;
};
export type SolanaDlmmBin = { readonly amountX: bigint; readonly amountY: bigint; readonly price: bigint; readonly openOrder: bigint; readonly processedRemaining: bigint; readonly askSide: boolean };
export type SolanaDlmmBinArray = { readonly index: number; readonly pair: string; readonly bins: readonly SolanaDlmmBin[] };

const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u16 = (d: Uint8Array, o: number): bigint => BigInt(dv(d).getUint16(o, true));
const u32 = (d: Uint8Array, o: number): bigint => BigInt(dv(d).getUint32(o, true));
const i32 = (d: Uint8Array, o: number): number => dv(d).getInt32(o, true);
const u64 = (d: Uint8Array, o: number): bigint => dv(d).getBigUint64(o, true);
const i64 = (d: Uint8Array, o: number): bigint => dv(d).getBigInt64(o, true);
const u128 = (d: Uint8Array, o: number): bigint => u64(d, o) + (u64(d, o + 8) << 64n);
const key = (d: Uint8Array, o: number): string => base58.encode(d.subarray(o, o + 32));
function disc(d: Uint8Array, want: readonly number[], name: string, len: number): void {
  if (d.length !== len) throw new Error(`${name}: ${d.length} bytes, not ${len}`);
  for (let i = 0; i < 8; i++) if (d[i] !== want[i]) throw new Error(`${name}: wrong discriminator`);
}

/** The bin array index of a bin (binIdToBinArrayIndex: floor division by 70). */
export const solanaDlmmArrayIndex = (binId: number): number => Math.floor(binId / BINS);
/** A bin array's address: ["bin_array", pair, index as i64 LE]. */
export function solanaDlmmBinArray(pair: string, index: number): string {
  const ix = new Uint8Array(8);
  dv(ix).setBigInt64(0, BigInt(index), true);
  return solanaProgramAddress([new TextEncoder().encode("bin_array"), base58.decode(pair), ix], SOLANA_DLMM_PROGRAM);
}
/** The pair's bitmap extension: ["bitmap", pair]. Named by the swap only when the active bin array is past ±512. */
export const solanaDlmmBitmapExtension = (pair: string): string => solanaProgramAddress([new TextEncoder().encode("bitmap"), base58.decode(pair)], SOLANA_DLMM_PROGRAM);

export function solanaDecodeDlmmPair(acc: SolanaDlmmAccount): SolanaDlmmPair {
  if (acc.owner !== SOLANA_DLMM_PROGRAM) throw new Error(`DLMM pair owned by ${acc.owner}`);
  const d = acc.data;
  disc(d, PAIR_DISC, "DLMM pair", SOLANA_DLMM_PAIR_BYTES);
  const activeId = i32(d, 76);
  const arr = solanaDlmmArrayIndex(activeId);
  return {
    baseFactor: u16(d, 8), filterPeriod: u16(d, 10), decayPeriod: u16(d, 12), reductionFactor: u16(d, 14),
    variableFeeControl: u32(d, 16), maxVolatilityAccumulator: u32(d, 20), minBinId: i32(d, 24), maxBinId: i32(d, 28),
    baseFeePowerFactor: BigInt(d[34]!), functionType: d[35]!, collectFeeMode: d[36]!,
    volatilityAccumulator: u32(d, 40), volatilityReference: u32(d, 44), indexReference: i32(d, 48), lastUpdateTimestamp: i64(d, 56),
    activeId, binStep: u16(d, 80), status: d[82]!, activationType: d[86]!,
    tokenX: key(d, 88), tokenY: key(d, 120), reserveX: key(d, 152), reserveY: key(d, 184),
    rewardMints: [key(d, 264), key(d, 264 + 144)], oracle: key(d, 552), bitmapExtensionNeeded: arr < -512 || arr > 511,
    activationPoint: u64(d, 816), tokenXFlag: d[880]!, tokenYFlag: d[881]!,
  };
}

export function solanaDecodeDlmmBinArray(acc: SolanaDlmmAccount): SolanaDlmmBinArray {
  if (acc.owner !== SOLANA_DLMM_PROGRAM) throw new Error(`DLMM bin array owned by ${acc.owner}`);
  const d = acc.data;
  disc(d, ARRAY_DISC, "DLMM bin array", BIN_ARRAY_BYTES);
  const index = i64(d, 8);
  if (index < -(1n << 40n) || index > 1n << 40n) throw new Error("DLMM bin array index out of range");
  const bins: SolanaDlmmBin[] = [];
  for (let i = 0; i < BINS; i++) {
    const o = 56 + i * 144;
    const ask = d[o + 140]!;
    if (ask > 1) throw new Error(`DLMM bin side byte ${ask}`);
    bins.push({ amountX: u64(d, o), amountY: u64(d, o + 8), price: u128(d, o + 16), openOrder: u64(d, o + 112), processedRemaining: u64(d, o + 128), askSide: ask === 1 });
  }
  return { index: Number(index), pair: key(d, 24), bins };
}

/** The Clock sysvar's slot, epoch and unix_timestamp (slot u64 at 0, epoch u64 at 16, unix_timestamp i64 at 32). */
export function solanaDecodeClock(acc: SolanaDlmmAccount): { slot: bigint; epoch: bigint; unixTimestamp: bigint } {
  if (acc.owner !== SYSVAR_OWNER || acc.data.length !== 40) throw new Error("not the Clock sysvar");
  return { slot: u64(acc.data, 0), epoch: u64(acc.data, 16), unixTimestamp: i64(acc.data, 32) };
}

// ------------------------------------------------------------------------------------------------- Token-2022 coins

/** A coin's transfer fee in an epoch: basis points and the cap, in base units (spl-token-2022 TransferFee). */
export type SolanaTransferFee = { readonly bps: bigint; readonly max: bigint };
/** The Token-2022 extensions a DLMM coin may carry: TransferFeeConfig (1, priced here), MintCloseAuthority (3),
 *  MetadataPointer (18), TokenMetadata (19), GroupPointer (20), TokenGroup (21), GroupMemberPointer (22) and
 *  TokenGroupMember (23), none of which moves an amount. Any other (a transfer hook, a default frozen state, pausable,
 *  non-transferable, confidential transfers, interest or a scaled UI amount, a permanent delegate) is not priced here. */
const T22_PRICED = new Set([1, 3, 18, 19, 20, 21, 22, 23]);
/**
 * The coin's transfer fee in `epoch`, from its mint as read (spl-token-2022 layout: the 82-byte base, the account type
 * 1 at 165, then type u16 ‖ length u16 ‖ value from 166; TransferFeeConfig's value 108 bytes: two keys, withheld u64,
 * then older and newer TransferFee {epoch u64, maximum_fee u64, transfer_fee_basis_points u16}, the newer once
 * `epoch` reaches its own). An SPL Token mint: no fee. Throws for an extension not priced here or a malformed mint.
 */
export function solanaCoinTransferFee(mint: SolanaDlmmAccount, epoch: bigint): SolanaTransferFee | null {
  if (mint.owner === SOLANA_TOKEN_PROGRAM) return null;
  if (mint.owner !== SOLANA_TOKEN_2022_PROGRAM) throw new Error(`mint owned by ${mint.owner}`);
  const d = mint.data;
  if (d.length === 82) return null;
  if (d.length < 166 || d[165] !== 1) throw new Error("not a Token-2022 mint");
  let fee: SolanaTransferFee | null = null;
  for (let o = 166; o < d.length; ) {
    if (o + 4 > d.length) throw new Error("mint extension cut");
    const type = Number(u16(d, o));
    const len = Number(u16(d, o + 2));
    if (type === 0) break; // Uninitialized: the rest is padding
    if (o + 4 + len > d.length) throw new Error("mint extension cut");
    if (!T22_PRICED.has(type)) throw new Error(`the coin's Token-2022 extension ${type} is not priced`);
    if (type === 1) {
      if (len !== 108) throw new Error("TransferFeeConfig is not 108 bytes");
      const v = o + 4 + 72;
      const older = { epoch: u64(d, v), max: u64(d, v + 8), bps: u16(d, v + 16) };
      const newer = { epoch: u64(d, v + 18), max: u64(d, v + 26), bps: u16(d, v + 34) };
      const f = epoch >= newer.epoch ? newer : older;
      if (f.bps > BPS) throw new Error("transfer fee over 10,000 bps");
      fee = f.bps === 0n ? null : { bps: f.bps, max: f.max };
    }
    o += 4 + len;
  }
  return fee;
}
/** spl-token-2022 calculate_fee: ceil(amount × bps / 10,000), at most the cap. */
export const solanaTransferFeeOf = (fee: SolanaTransferFee | null, amount: bigint): bigint => {
  if (!fee || amount === 0n) return 0n;
  const raw = ceilDivPos(amount * fee.bps, BPS);
  return raw > fee.max ? fee.max : raw;
};
const ceilDivPos = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

// ------------------------------------------------------------------------------------------------- the fee

/** getTotalFee: base (base_factor × bin_step × 10 × 10^power) plus variable (ceil(vfc × (va × bin_step)² / 1e11)),
 *  capped at MAX_FEE_RATE, over FEE_PRECISION. */
export function solanaDlmmTotalFee(p: Pick<SolanaDlmmPair, "baseFactor" | "binStep" | "baseFeePowerFactor" | "variableFeeControl">, volatilityAccumulator: bigint): bigint {
  const base = p.baseFactor * p.binStep * 10n * 10n ** p.baseFeePowerFactor;
  const sq = (volatilityAccumulator * p.binStep) ** 2n;
  const variable = p.variableFeeControl > 0n ? (p.variableFeeControl * sq + 99_999_999_999n) / 100_000_000_000n : 0n;
  const total = base + variable;
  return total > MAX_FEE_RATE ? MAX_FEE_RATE : total;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
// getAmountOut (rounded down) and getAmountIn (rounded up): price is Y per X in Q64.64
const amountOut = (inAmount: bigint, price: bigint, swapForY: boolean): bigint => (swapForY ? (inAmount * price) >> 64n : (inAmount << 64n) / price);
const amountIn = (out: bigint, price: bigint, swapForY: boolean): bigint => (swapForY ? ceilDiv(out << 64n, price) : ceilDiv(out * price, 1n << 64n));

/** getExactInFillAmountResult: the market maker's amount first, then, on a pair with limit orders, the processed and
 *  then the open orders on the side the swap takes. */
function fill(bin: SolanaDlmmBin, amount: bigint, swapForY: boolean, limitOrders: boolean): { used: bigint; left: bigint; out: bigint } {
  const take = (amt: bigint, max: bigint) => {
    const maxIn = amountIn(max, bin.price, swapForY);
    return amt >= maxIn ? { used: maxIn, left: amt - maxIn, out: max } : { used: amt, left: 0n, out: amountOut(amt, bin.price, swapForY) };
  };
  const mm = take(amount, swapForY ? bin.amountY : bin.amountX);
  if (!limitOrders || mm.left === 0n) return mm;
  const onSide = swapForY !== bin.askSide; // getLimitOrderAmountsBySwapDirection
  const processed = take(mm.left, onSide ? bin.processedRemaining : 0n);
  const open = processed.left > 0n ? take(processed.left, onSide ? bin.openOrder : 0n) : { used: 0n, left: 0n, out: 0n };
  const used = mm.used + processed.used + open.used;
  return { used, left: amount - used, out: mm.out + processed.out + open.out };
}
/** getBinMaxAmountOut: getLimitOrderLiquidity counts every order amount as X on the ask side, as Y on the bid side. */
function binMaxOut(bin: SolanaDlmmBin, swapForY: boolean, limitOrders: boolean): bigint {
  const orders = limitOrders ? bin.openOrder + bin.processedRemaining : 0n;
  return swapForY ? bin.amountY + (bin.askSide ? 0n : orders) : bin.amountX + (bin.askSide ? orders : 0n);
}
/** swapExactInQuoteAtBin: what `inAmount` (fee included) takes from one bin and pays out (fee excluded). */
function atBin(bin: SolanaDlmmBin, fee: bigint, inAmount: bigint, swapForY: boolean, limitOrders: boolean, feeOnInput: boolean): { used: bigint; out: bigint } {
  let excludedIn = inAmount;
  if (feeOnInput) excludedIn = inAmount - ceilDiv(inAmount * fee, FEE_PRECISION);
  const f = fill(bin, excludedIn, swapForY, limitOrders);
  let used = inAmount;
  if (f.left > 0n) {
    excludedIn -= f.left;
    used = feeOnInput ? ceilDiv(excludedIn * FEE_PRECISION, FEE_PRECISION - fee) : excludedIn;
  }
  const out = feeOnInput ? f.out : f.out - ceilDiv(f.out * fee, FEE_PRECISION);
  return { used, out };
}

/** isSupportLimitOrder and getFeeMode; null for a function type or a fee mode the SDK does not know. */
export function solanaDlmmModes(p: SolanaDlmmPair, swapForY: boolean): { limitOrders: boolean; feeOnInput: boolean } | null {
  const limitOrders = p.functionType === 2 ? true : p.functionType === 1 ? false : p.functionType === 0 ? p.rewardMints.every((m) => m === "11111111111111111111111111111111") : null;
  const feeOnInput = p.collectFeeMode === 0 ? true : p.collectFeeMode === 1 ? !swapForY : null;
  return limitOrders === null || feeOnInput === null ? null : { limitOrders, feeOnInput };
}

/**
 * What exactly `amount` in pays out of the pair, walking from the active bin through `arrays` (by index; null: an
 * array the chain does not hold, which has no liquidity), at the Clock's `now` (swapQuote). Null when the walk leaves
 * the read arrays or the pair's bin range before the input is spent: the program would need an account the swap does
 * not name, so the amount is not filled here.
 */
export function solanaDlmmSwapOut(p: SolanaDlmmPair, arrays: ReadonlyMap<number, SolanaDlmmBinArray | null>, amount: bigint, swapForY: boolean, now: bigint): bigint | null {
  const modes = solanaDlmmModes(p, swapForY);
  if (!modes || amount <= 0n) return null;
  // updateReference at the Clock's time
  let va = p.volatilityAccumulator;
  let vr = p.volatilityReference;
  let ir = p.indexReference;
  const elapsed = now - p.lastUpdateTimestamp;
  if (elapsed >= p.filterPeriod) {
    ir = p.activeId;
    vr = elapsed < p.decayPeriod ? (va * p.reductionFactor) / BPS : 0n;
  }
  let left = amount;
  let out = 0n;
  let id = p.activeId;
  const step = swapForY ? -1 : 1;
  for (;;) {
    if (id < p.minBinId || id > p.maxBinId) return null;
    const ix = solanaDlmmArrayIndex(id);
    if (!arrays.has(ix)) return null;
    const arr = arrays.get(ix);
    if (!arr) {
      id = swapForY ? ix * BINS - 1 : (ix + 1) * BINS; // an array the chain does not hold: no bin in it has liquidity
      continue;
    }
    const bin = arr.bins[id - ix * BINS]!;
    if (binMaxOut(bin, swapForY, modes.limitOrders) > 0n) {
      // updateVolatilityAccumulator
      const delta = BigInt(Math.abs(ir - id));
      const next = vr + delta * BPS;
      va = next < p.maxVolatilityAccumulator ? next : p.maxVolatilityAccumulator;
      const fee = solanaDlmmTotalFee(p, va);
      const r = atBin(bin, fee, left, swapForY, modes.limitOrders, modes.feeOnInput);
      if (r.used > 0n) {
        left -= r.used;
        out += r.out;
      }
    }
    if (left === 0n) return out;
    id += step;
  }
}

/**
 * What a trade of exactly `amount` gives the user (swapQuote's outAmount): a buy spends lamports and receives the coin
 * net of its transfer fee; a sell spends the coin, whose transfer fee comes off before the pair sees it, and receives
 * lamports. Null when the read arrays do not fill it.
 */
export function solanaDlmmTradeOut(p: SolanaDlmmPair, arrays: ReadonlyMap<number, SolanaDlmmBinArray | null>, side: "buy" | "sell", amount: bigint, solIsX: boolean, coinFee: SolanaTransferFee | null, now: bigint): bigint | null {
  const swapForY = solanaDlmmSwapForY(side, solIsX);
  const into = side === "sell" ? amount - solanaTransferFeeOf(coinFee, amount) : amount;
  if (into <= 0n) return null;
  const out = solanaDlmmSwapOut(p, arrays, into, swapForY, now);
  if (out === null) return null;
  return side === "buy" ? out - solanaTransferFeeOf(coinFee, out) : out;
}

/** The bin arrays a swap from `activeId` reads: the active one and the next SOLANA_DLMM_ARRAYS − 1 it walks into. */
export const solanaDlmmArrayIndexes = (activeId: number, swapForY: boolean): number[] =>
  Array.from({ length: SOLANA_DLMM_ARRAYS }, (_, k) => solanaDlmmArrayIndex(activeId) + (swapForY ? -k : k));

/** A pair's side: the coin is the pair's other mint and wSOL is one of the two; null when not a SOL pair of `mint`. */
export function solanaDlmmSide(p: Pick<SolanaDlmmPair, "tokenX" | "tokenY">, mint: string): { solIsX: boolean } | null {
  if (p.tokenX === mint && p.tokenY === SOLANA_SOL_MINT) return { solIsX: false };
  if (p.tokenY === mint && p.tokenX === SOLANA_SOL_MINT) return { solIsX: true };
  return null;
}
/** A buy spends SOL: swapForY when SOL is X. A sell spends the coin. */
export const solanaDlmmSwapForY = (side: "buy" | "sell", solIsX: boolean): boolean => (side === "buy" ? solIsX : !solIsX);
/** The program of a pair's token by its flag (0 SPL Token, 1 Token-2022). */
export const solanaDlmmTokenProgram = (flag: number): string | null => (flag === 0 ? SOLANA_TOKEN_PROGRAM : flag === 1 ? SOLANA_TOKEN_2022_PROGRAM : null);

// ------------------------------------------------------------------------------------------------- finding a coin's pairs

/** The most pairs one provider's scan may name for one coin side: more is a hostile or broken answer, refused (USDC had
 *  114 DLMM SOL pairs on 14 Nov, BONK 64, NEARKAT 4). */
export const SOLANA_DLMM_SCAN_MAX = 512;
/** Accounts per getMultipleAccounts of a ranking read (solana-rpc.publicnode.com takes at most 10 in one call). */
const RANK_BATCH = 10;
/** A scan or ranking read that has not answered in this long fails. */
const SCAN_TIMEOUT_MS = 5_000;
/** A DLMM pair's reserve of `mint`: the program's address of [pair, mint] (the SDK's deriveReserve; NEARKAT's B8BH6ZKr…
 *  reserves read back equal). */
export const solanaDlmmReserve = (pair: string, mint: string): string => solanaProgramAddress([base58.decode(pair), base58.decode(mint)], SOLANA_DLMM_PROGRAM);
/** The scan of the DLMM pairs whose token X is `x` and token Y is `y`: getProgramAccounts with the pair's size and both
 *  mints, addresses only. The helper's /v1/rpc/solana carries this exact shape and no wider one. */
export const solanaDlmmPairScan = (x: string, y: string): readonly unknown[] => [
  SOLANA_DLMM_PROGRAM,
  { commitment: "confirmed", encoding: "base64", withContext: true, dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: SOLANA_DLMM_PAIR_BYTES }, { memcmp: { offset: 88, bytes: x } }, { memcmp: { offset: 120, bytes: y } }] },
];
const isKey = (s: unknown): s is string => {
  try {
    return typeof s === "string" && s.length <= 44 && base58.decode(s).length === 32;
  } catch {
    return false;
  }
};
/** One scan's addresses; throws on an answer that is not a list of at most SOLANA_DLMM_SCAN_MAX addresses. */
async function scanOn(rpc: SolanaRpc, x: string, y: string): Promise<string[]> {
  const a = (await solanaTimedRpc(rpc, SCAN_TIMEOUT_MS)("getProgramAccounts", [...solanaDlmmPairScan(x, y)])) as { value?: unknown } | unknown[] | null;
  const v = Array.isArray(a) ? a : (a as { value?: unknown } | null)?.value;
  if (!Array.isArray(v) || v.length > SOLANA_DLMM_SCAN_MAX) throw new Error("a DLMM pair scan answered no list of at most 512 accounts");
  return v.map((e) => {
    const k = (e as { pubkey?: unknown } | null)?.pubkey;
    if (!isKey(k)) throw new Error("a DLMM pair scan answered an entry that is not an address");
    return k;
  });
}
/** `rpc`'s own SOL depth of each pair (its SOL reserve's amount; 0 when it holds none or is no SPL Token account). */
async function depthsOn(rpc: SolanaRpc, pairs: readonly string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  for (let i = 0; i < pairs.length; i += RANK_BATCH) {
    const some = pairs.slice(i, i + RANK_BATCH);
    const a = (await solanaTimedRpc(rpc, SCAN_TIMEOUT_MS)("getMultipleAccounts", [some.map((p) => solanaDlmmReserve(p, SOLANA_SOL_MINT)), { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 64, length: 8 } }])) as { value?: unknown } | null;
    const v = a?.value;
    if (!Array.isArray(v) || v.length !== some.length) throw new Error("a DLMM reserve read answered no list of the asked length");
    some.forEach((p, k) => {
      const e = v[k] as { owner?: unknown; data?: unknown } | null;
      let d: Uint8Array | null = null;
      try {
        d = e && e.owner === SOLANA_TOKEN_PROGRAM && Array.isArray(e.data) && e.data[1] === "base64" && typeof e.data[0] === "string" && e.data[0].length <= 12 ? base64.decode(e.data[0]) : null;
      } catch {}
      out.set(p, d && d.length === 8 ? new DataView(d.buffer, d.byteOffset, 8).getBigUint64(0, true) : 0n);
    });
  }
  return out;
}

/**
 * A coin's Meteora DLMM SOL pairs, for the reference's `dlmmPairs` (pool.ts readSolanaReferenceWhy, which reads and
 * judges each one on both of its providers). `scan`: two providers that answer getProgramAccounts; each lists the pairs
 * of the coin and wSOL, the coin as X and as Y, and the list is the union of both, so one provider cannot hide a pair
 * the other names, and a pair one makes up is judged like any other (the program's account, the coin, wSOL, enabled).
 * Past SOLANA_DLMM_MAX_PAIRS, `read`'s two providers each keep the half they read deepest in SOL (each pair's SOL
 * reserve, the program's address of [pair, wSOL]), and the union of the two halves is the list: one provider cannot push
 * the pair the other reads deepest out. Sorted; [] for wSOL itself. Throws when a provider fails or answers out of shape.
 */
export async function readSolanaDlmmPairs(scan: readonly [SolanaRpc, SolanaRpc], read: readonly [SolanaRpc, SolanaRpc], mint: string): Promise<string[]> {
  if (!isKey(mint)) throw new Error("the coin is not a 32-byte address");
  if (mint === SOLANA_SOL_MINT) return [];
  const lists = await Promise.all(scan.map((rpc) => Promise.all([scanOn(rpc, mint, SOLANA_SOL_MINT), scanOn(rpc, SOLANA_SOL_MINT, mint)])));
  const all = [...new Set(lists.flat(2))].sort();
  if (all.length <= SOLANA_DLMM_MAX_PAIRS) return all;
  const half = SOLANA_DLMM_MAX_PAIRS / 2;
  const tops = await Promise.all(
    read.map(async (rpc) => {
      const d = await depthsOn(rpc, all);
      return [...all].sort((a, b) => (d.get(a)! === d.get(b)! ? (a < b ? -1 : 1) : d.get(a)! > d.get(b)! ? -1 : 1)).slice(0, half);
    }),
  );
  return [...new Set(tops.flat())].sort();
}
