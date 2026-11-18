// Solana trades decoded from each venue program's own event (card index-sol-trades, slice 1: the pump.fun bonding
// curve and PumpSwap). Never from balance changes: a trade counts only when the venue program itself logged its event
// while it was the program running, which no other program can fake (a log line is the running program's own).
//
// The events (pump's public IDLs, github.com/pump-fun/pump-public-docs idl/pump.json and idl/pump_amm.json at commit
// 639b87fb, 2026-10-13; every offset below checked against the recorded transactions in fixtures/sol-trades-txs.json):
//   - pump.fun curve 6EF8rrec...: `TradeEvent` (discriminator bddb7fd34ee661ee) mint, sol_amount u64, token_amount u64,
//     is_buy bool, user, timestamp i64, ... then ix_name (string), ..., shareholders (vec of 34 bytes), quote_mint,
//     quote_amount. A coin launched against a quote coin (quote_mint not SOL) logs sol_amount 0 and its quote in
//     quote_amount; one launched against SOL names the default (all-zero) or the wrapped-SOL mint, or an event too old to
//     carry the field, and its quote is sol_amount. Amounts are the curve's, fees apart.
//   - PumpSwap pAMMBay6...: `BuyEvent` (67f4521f2cf57777) and `SellEvent` (3e2f370aa503dc2a): timestamp i64,
//     base_amount_out (buy) or base_amount_in (sell), ..., quote_amount_in (buy, before the LP fee: the next field is
//     quote_amount_in_with_lp_fee) or quote_amount_out (sell, the pool's constant-product output before fees: recomputed
//     from the event's own reserves for the recorded sell), and pool at byte 112, user at 144. The pool names its mints
//     (the `Pool` account, discriminator f19a6d0411b16dbc, base_mint at byte 43, quote_mint at 75).
// Both programs log the event as `Program data: <base64>` and also call themselves with it (Anchor's event CPI); this
// reads the log line, and the log is the one the stream sends. A log the runtime cut short ("Log truncated") is
// reported, so the caller reads that transaction's inner instructions instead (`fromInner`).
//
// The pool venues past pump.fun (card helper-listed-charts-own-reads). Of the 88 coins off pump.fun on the helper's
// lists at 2026-11-15 23:14Z, the newest two successful transactions of 72 ran Raydium CLMM in 27, Orca in 20, Meteora
// DLMM in 17, Raydium CPMM in 8, Raydium LaunchLab in 2 (and fewer the rest). Orca, Raydium CLMM and CPMM each log their
// swap event with Anchor's `emit!` only (no event CPI), so a cut log keeps the events logged before the cut
// (`cutTrades`). The event names the pool (CPMM's also its mints), never which side is the token: a trade is told as the
// pool's first mint sees it (`side` "b" when the trader got it, `amt` its leg, `quote` the other mint's), and the
// reader names the token from the pool account (`poolPair`, taken only with the venue's program as its owner) and turns
// the trade round when the token is the second mint. None of these events carries a clock (`ts` 0: the reader
// dates it by its block).
//   - Orca Whirlpool whirLbMi... (github.com/orca-so/whirlpools at commit cc683ec9, 2026-10-12,
//     programs/whirlpool/src/events.rs and state/whirlpool.rs): `Traded` (discriminator e1ca49af932ba096, sha256
//     "event:Traded") whirlpool, a_to_b bool at 32, pre/post sqrt price u128, input_amount u64 at 65, output_amount at
//     73, then the transfer and LP/protocol fees (113 bytes); the input is what the pool took (its LP and protocol fees
//     inside), the output what it paid. No trader field: `user` is "". The `Whirlpool` account (3f95d10ce1806309) holds
//     token_mint_a at byte 101 and token_mint_b at 181.
//   - Raydium CLMM CAMMCzo5... (github.com/raydium-io/raydium-clmm at commit 6d7a0f82, 2026-10-27,
//     programs/amm/src/states/pool.rs `SwapEvent`; raydium-io/raydium-idl e7e0c96f raydium_clmm.json for the
//     discriminator 40c6cde8260871e2): pool_state, sender at 32, token_account_0, token_account_1, amount_0 u64 at 128,
//     transfer_fee_0, amount_1 at 144, transfer_fee_1, zero_for_one bool at 160 (token 0 paid in), then price, liquidity,
//     tick and the fees (the IDL's fields end at 197 and are required; the mainnet event is 213 bytes). The
//     `PoolState` account (f7ede3f5d7c3de46) holds token_mint_0 at byte 73 and token_mint_1 at 105.
//   - Raydium CPMM CPMMoo8L... (github.com/raydium-io/raydium-cp-swap at commit 3d691227, 2026-11-01,
//     programs/cp-swap/src/states/events.rs `SwapEvent`, logged by instructions/swap_base_input.rs and
//     swap_base_output.rs with `emit!`; the same discriminator 40c6cde8260871e2 as CLMM's, told apart by the running
//     program): pool_id, input_vault_before, output_vault_before, input_amount u64 at 48 (what the pool's vault got,
//     an input transfer fee apart), output_amount at 56 (what the pool paid, before an output transfer fee), the two
//     transfer fees, base_input, input_mint at 81, output_mint at 113, then the fees (162 bytes). The event names its
//     own mints (`pair`: input, then output), so no pool is read; it names no trader (`user` "").
//   - Raydium LaunchLab LanMV9sA... (the launchpad of raydium-launchlab and letsbonk.fun coins; its official IDL,
//     github.com/raydium-io/raydium-idl at commit e7e0c96f, 2026-05-18, raydium_launchpad/raydium_launchpad.json):
//     `TradeEvent` (bddb7fd34ee661ee, pump.fun's discriminator too, told apart by the running program) pool_state,
//     total_base_sell, the virtual and real reserves, amount_in u64 at 88 (what the trader paid, fees inside),
//     amount_out at 96 (what the trader got, fees out), the four fees, trade_direction u8 at 136 (0 Buy: quote paid for
//     base, 1 Sell), pool_status, exact_in (139 bytes). Unlike the three above it also sends the event to itself
//     (Anchor's event CPI), so a cut log reads it from the inner instructions. No trader field. The `PoolState` account
//     (f7ede3f5d7c3de46, as Raydium CLMM's and CPMM's: the owner tells them apart) holds base_mint at byte 205 and
//     quote_mint at 237.
// Every offset checked against the recorded transactions in fixtures/sol-venue-txs.json: each event's amounts equal its
// pool's own token balance changes in the same transaction, and each pool's mints the mints of those balances.
//
// The Meteora venues (card index-sol-trades-2; Meteora DLMM ran 17 of the 72 sampled above). All three send their swap
// event to themselves only (Anchor's `emit_cpi!`, DAMM v2's pinocchio swap the same CPI by hand): the log holds no event
// of theirs, so a transaction whose log names one of them running (`eventsInInner`) is read whole and its trades taken
// from its inner instructions (`cutTrades`). A pool is told as its first mint sees it, as the venues above.
//   - DLMM LBUZKhRx... (its official IDL, github.com/MeteoraAg/dlmm-sdk at commit 1532e540, 2026-11-04, idls/dlmm.json):
//     `Swap` (discriminator 516ce3becdd00ac4) lb_pair, from at 32 (the trader), start/end bin i32, amount_in u64 at 72
//     (what the pool took, its fee inside), amount_out at 80 (what it paid), swap_for_y bool at 88 (X paid in), then
//     the fees (129 bytes). The program also sends `Swap2Evt` (2e7452d7941b544d) for the same swap: not read, so a swap
//     is one trade. No clock (`ts` 0). The `LbPair` account (210b3162b565b10d) holds token_x_mint at byte 88 and
//     token_y_mint at 120.
//   - DBC dbcij3LW... (dynamic bonding curve; its official IDL, github.com/MeteoraAg/dynamic-bonding-curve-sdk at commit
//     ad127729, 2026-11-04, packages/dynamic-bonding-curve/src/idl/dynamic-bonding-curve/idl.json): `EvtSwap2`
//     (bd4233a826507599) pool, config at 32, trade_direction u8 at 64 (0 BaseToQuote, 1 QuoteToBase), has_referral,
//     swap_parameters (17 bytes), swap_result: included_fee_input_amount u64 at 83 (what the pool took, its fee inside),
//     excluded_fee_input_amount, amount_left, output_amount at 107 (what the trader got, fees out), the price and fees,
//     then quote_reserve_amount, migration_threshold and current_timestamp u64 at 171 (179 bytes). The program sends
//     `EvtSwap` and `EvtSwap3` for the same swap too: neither read. The `VirtualPool` account (d5e005d16245775c) holds
//     config at byte 72 and base_mint at 136; the quote mint is the config's, `PoolConfig` (1a6c0e7b74e6812b) quote_mint
//     at byte 8 (`dbcPair`, both taken only with DBC as their owner and the pool naming that config).
//   - DAMM v2 cpamdpZC... (its official IDL, github.com/MeteoraAg/damm-v2-sdk at commit eab5e8aa, 2026-11-04,
//     src/idl/cp_amm.json): `EvtSwap2` (bd4233a826507599, DBC's too: the running program and the length tell them
//     apart) pool, trade_direction u8 at 32 (0 AtoB, 1 BtoA), collect_fee_mode, has_referral, params (17 bytes),
//     swap_result: included_fee_input_amount u64 at 52 (what the pool took, its fee inside), ..., output_amount at 76
//     (what the pool paid), the price and fees, the transfer-fee amounts, current_timestamp u64 at 156, the reserves
//     (180 bytes). The `Pool` account (f19a6d0411b16dbc, PumpSwap's discriminator too: the owner tells them apart) holds
//     token_a_mint at byte 168 and token_b_mint at 200.
// Every offset checked against fixtures/sol-meteora-txs.json: each event's amounts equal its pool's vault balance changes
// in the same transaction, and each pool's (and config's) mints the mints of those balances.
//
// Display only: nothing here feeds a signature. Every value is hostile input: a line counts only with the program at
// the top of the invoke stack the same logs build, an event only with its exact discriminator and a length that holds
// every field read, an amount only > 0.

export const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const ORCA = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
export const RAY_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const RAY_CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
export const RAY_LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
export const METEORA_DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const METEORA_DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const METEORA_DAMM2 = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
export const WSOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
import { b58encode } from "./lists.ts";

const DEFAULT_KEY = "11111111111111111111111111111111";

const DISC = {
  /** pump.fun's `TradeEvent`, and Raydium LaunchLab's. */
  trade: "bddb7fd34ee661ee",
  buy: "67f4521f2cf57777",
  sell: "3e2f370aa503dc2a",
  pool: "f19a6d0411b16dbc",
  orcaTraded: "e1ca49af932ba096",
  orcaPool: "3f95d10ce1806309",
  /** Raydium's `SwapEvent`, CLMM's and CPMM's alike. */
  clmmSwap: "40c6cde8260871e2",
  /** Raydium's `PoolState`, CLMM's, CPMM's and LaunchLab's alike. */
  clmmPool: "f7ede3f5d7c3de46",
  dlmmSwap: "516ce3becdd00ac4",
  dlmmPool: "210b3162b565b10d",
  /** `EvtSwap2`, DBC's and DAMM v2's alike. */
  evtSwap2: "bd4233a826507599",
  dbcPool: "d5e005d16245775c",
  dbcConfig: "1a6c0e7b74e6812b",
  /** Anchor's event-CPI tag: the first 8 bytes of an event an Anchor program sends to itself. */
  cpi: "e445a52e51cb9a1d",
} as const;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58].map((c, i) => [c, BigInt(i)]));
/** Base58 instruction data to bytes (lists.ts b58decode reads keys, 64 characters at most), or null for a string that
 *  is not base58 or longer than `max` characters. */
export function b58data(s: string, max = 2_048): Uint8Array | null {
  if (typeof s !== "string" || s.length > max) return null;
  let n = 0n;
  for (const c of s) {
    const v = B58_INDEX.get(c);
    if (v === undefined) return null;
    n = n * 58n + v;
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

/** A venue whose pool names two mints, either one the token (the trade told as the first mint sees it). */
export type PairVenue = "orca" | "raydium-clmm" | "raydium-cpmm" | "raydium-launchlab" | "meteora-dlmm" | "meteora-dbc" | "meteora-damm2";
/** One trade as the venue logged it. `mint` is the token (curve) or null until the pool is read (the pool venues). */
export type RawTrade = {
  venue: "pump" | "pumpswap" | PairVenue;
  mint: string | null;
  pool: string | null;
  side: "b" | "s";
  /** The token leg, smallest unit, > 0. */
  amt: bigint;
  /** The quote leg, smallest unit, > 0. */
  quote: bigint;
  /** The quote's mint: WSOL for SOL. For PumpSwap, null until the pool is read. */
  quoteMint: string | null;
  /** A pair venue's two mints when its event names them (Raydium CPMM: input, then output); otherwise the pool is read. */
  pair?: { a: string; b: string };
  /** Meteora DBC: the config its event names, which holds the pool's quote mint (`dbcPair`). */
  config?: string;
  /** The trader, or "" when the event names none (Orca). */
  user: string;
  /** The event's own clock, unix seconds; 0 when the event has none (the pair venues: the reader dates it by its block). */
  ts: number;
  /** false: a venue program's own swap, made while another decoded venue's instruction runs (its event logged with that
   *  venue lower in the invoke stack): no trader's trade, so off the tape and in the bars (card
   *  sol-tape-trader-is-the-events-user, as ../candles.ts Swap.tape on Base and Robinhood). */
  tape?: false;
};

const key = (b: Buffer, o: number): string => b58encode(b.subarray(o, o + 32));

/** A pump.fun `TradeEvent` body (after its discriminator), or null. */
function pumpTrade(b: Buffer): RawTrade | null {
  if (b.length < 89) return null;
  const sol = b.readBigUInt64LE(32);
  const amt = b.readBigUInt64LE(40);
  const isBuy = b[48];
  if (isBuy !== 0 && isBuy !== 1) return null;
  let quote = sol;
  let quoteMint = WSOL;
  // the quote fields, when the event is new enough to carry them: after ix_name (at 250) and the shareholders vec
  if (b.length >= 254) {
    let o = 250;
    const n = b.readUInt32LE(o);
    o += 4 + n + 1 + 32; // ix_name, mayhem_mode, cashback (bps, amount), buyback (bps, amount)
    if (n <= 64 && b.length >= o + 4) {
      const holders = b.readUInt32LE(o);
      o += 4 + holders * 34;
      if (holders <= 64 && b.length >= o + 40) {
        const qm = key(b, o);
        if (qm !== DEFAULT_KEY && qm !== WSOL) {
          quoteMint = qm;
          quote = b.readBigUInt64LE(o + 32);
        }
      }
    }
  }
  if (amt <= 0n || quote <= 0n) return null;
  const ts = Number(b.readBigInt64LE(81));
  return { venue: "pump", mint: key(b, 0), pool: null, side: isBuy === 1 ? "b" : "s", amt, quote, quoteMint, user: key(b, 49), ts };
}

/** A PumpSwap `BuyEvent` or `SellEvent` body, or null. */
function ammTrade(b: Buffer, side: "b" | "s"): RawTrade | null {
  if (b.length < 176) return null;
  const amt = b.readBigUInt64LE(8);
  const quote = b.readBigUInt64LE(56);
  if (amt <= 0n || quote <= 0n) return null;
  return { venue: "pumpswap", mint: null, pool: key(b, 112), side, amt, quote, quoteMint: null, user: key(b, 144), ts: Number(b.readBigInt64LE(0)) };
}

/** An Orca `Traded` body, told as mint A sees it, or null. */
function orcaTrade(b: Buffer): RawTrade | null {
  if (b.length < 113) return null;
  const aToB = b[32];
  if (aToB !== 0 && aToB !== 1) return null;
  const input = b.readBigUInt64LE(65);
  const output = b.readBigUInt64LE(73);
  if (input <= 0n || output <= 0n) return null;
  const [amt, quote] = aToB === 1 ? [input, output] : [output, input];
  return { venue: "orca", mint: null, pool: key(b, 0), side: aToB === 1 ? "s" : "b", amt, quote, quoteMint: null, user: "", ts: 0 };
}

/** A Raydium CLMM `SwapEvent` body, told as token 0 sees it, or null. */
function clmmTrade(b: Buffer): RawTrade | null {
  if (b.length < 197) return null; // every field of the IDL's event, through tick
  const zeroForOne = b[160];
  if (zeroForOne !== 0 && zeroForOne !== 1) return null;
  const amt = b.readBigUInt64LE(128);
  const quote = b.readBigUInt64LE(144);
  if (amt <= 0n || quote <= 0n) return null;
  return { venue: "raydium-clmm", mint: null, pool: key(b, 0), side: zeroForOne === 1 ? "s" : "b", amt, quote, quoteMint: null, user: key(b, 32), ts: 0 };
}

/** A Raydium CPMM `SwapEvent` body, told as its input mint sees it (the trader paid it), or null. */
function cpmmTrade(b: Buffer): RawTrade | null {
  if (b.length < 162) return null;
  const amt = b.readBigUInt64LE(48);
  const quote = b.readBigUInt64LE(56);
  const a = key(b, 81);
  const o = key(b, 113);
  if (amt <= 0n || quote <= 0n || a === o) return null;
  return { venue: "raydium-cpmm", mint: null, pool: key(b, 0), pair: { a, b: o }, side: "s", amt, quote, quoteMint: null, user: "", ts: 0 };
}

/** A Raydium LaunchLab `TradeEvent` body, told as the pool's base mint sees it, or null. */
function launchlabTrade(b: Buffer): RawTrade | null {
  if (b.length < 139) return null;
  const dir = b[136];
  if (dir !== 0 && dir !== 1) return null;
  const paid = b.readBigUInt64LE(88);
  const got = b.readBigUInt64LE(96);
  if (paid <= 0n || got <= 0n) return null;
  const [amt, quote] = dir === 0 ? [got, paid] : [paid, got];
  return { venue: "raydium-launchlab", mint: null, pool: key(b, 0), side: dir === 0 ? "b" : "s", amt, quote, quoteMint: null, user: "", ts: 0 };
}

/** A Meteora DLMM `Swap` body, told as the pool's token X sees it, or null. */
function dlmmTrade(b: Buffer): RawTrade | null {
  if (b.length < 129) return null;
  const forY = b[88];
  if (forY !== 0 && forY !== 1) return null;
  const took = b.readBigUInt64LE(72);
  const paid = b.readBigUInt64LE(80);
  if (took <= 0n || paid <= 0n) return null;
  const [amt, quote] = forY === 1 ? [took, paid] : [paid, took];
  return { venue: "meteora-dlmm", mint: null, pool: key(b, 0), side: forY === 1 ? "s" : "b", amt, quote, quoteMint: null, user: key(b, 32), ts: 0 };
}

/** The event's clock (u64 unix seconds), or null past a safe integer. */
const clock = (b: Buffer, o: number): number | null => {
  const t = b.readBigUInt64LE(o);
  return t > 0n && t <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(t) : null;
};

/** A Meteora DBC `EvtSwap2` body, told as the pool's base mint sees it, or null. */
function dbcTrade(b: Buffer): RawTrade | null {
  if (b.length < 179) return null;
  const dir = b[64];
  if (dir !== 0 && dir !== 1) return null;
  const took = b.readBigUInt64LE(83);
  const paid = b.readBigUInt64LE(107);
  const ts = clock(b, 171);
  if (took <= 0n || paid <= 0n || ts === null) return null;
  const [amt, quote] = dir === 1 ? [paid, took] : [took, paid];
  return { venue: "meteora-dbc", mint: null, pool: key(b, 0), config: key(b, 32), side: dir === 1 ? "b" : "s", amt, quote, quoteMint: null, user: "", ts };
}

/** A Meteora DAMM v2 `EvtSwap2` body, told as the pool's token A sees it, or null. */
function damm2Trade(b: Buffer): RawTrade | null {
  if (b.length < 180) return null;
  const dir = b[32];
  if (dir !== 0 && dir !== 1) return null;
  const took = b.readBigUInt64LE(52);
  const paid = b.readBigUInt64LE(76);
  const ts = clock(b, 156);
  if (took <= 0n || paid <= 0n || ts === null) return null;
  const [amt, quote] = dir === 0 ? [took, paid] : [paid, took];
  return { venue: "meteora-damm2", mint: null, pool: key(b, 0), side: dir === 0 ? "s" : "b", amt, quote, quoteMint: null, user: "", ts };
}

/** The trade an event of `program` holds (its bytes with the discriminator first), or null. */
export function decodeEvent(program: string, data: Buffer): RawTrade | null {
  if (data.length < 8) return null;
  const d = data.subarray(0, 8).toString("hex");
  const body = data.subarray(8);
  if (program === PUMP && d === DISC.trade) return pumpTrade(body);
  if (program === PUMP_AMM && d === DISC.buy) return ammTrade(body, "b");
  if (program === PUMP_AMM && d === DISC.sell) return ammTrade(body, "s");
  if (program === ORCA && d === DISC.orcaTraded) return orcaTrade(body);
  if (program === RAY_CLMM && d === DISC.clmmSwap) return clmmTrade(body);
  if (program === RAY_CPMM && d === DISC.clmmSwap) return cpmmTrade(body);
  if (program === RAY_LAUNCHLAB && d === DISC.trade) return launchlabTrade(body);
  if (program === METEORA_DLMM && d === DISC.dlmmSwap) return dlmmTrade(body);
  if (program === METEORA_DBC && d === DISC.evtSwap2) return dbcTrade(body);
  if (program === METEORA_DAMM2 && d === DISC.evtSwap2) return damm2Trade(body);
  return null;
}

/** The programs whose events this file decodes. A trade's event logged while one of them is lower in the invoke stack
 *  was made inside that venue's own instruction: the venue program's own swap (its fees sold in a pool, the Solana
 *  shape of a v4 hook's swap in its own pool, evm/swaps.ts apply), never a trader's. A trader's route calls each venue
 *  from the trader's own instruction or a router's (Jupiter, GMGN's, ...), never from inside another venue's: every
 *  recorded transaction in fixtures/sol-trades-txs.json, sol-venue-txs.json and sol-trades-hour.json.gz has its venue
 *  swaps side by side. A venue's event sent to itself (Anchor's event CPI) is the same venue's frame, not a swap. */
const VENUES: ReadonlySet<string> = new Set([PUMP, PUMP_AMM, ORCA, RAY_CLMM, RAY_CPMM, RAY_LAUNCHLAB, METEORA_DLMM, METEORA_DBC, METEORA_DAMM2]);
/** The venues that send their events to themselves (Anchor's event CPI), read from the inner instructions. */
const CPI_VENUES: ReadonlySet<string> = new Set([PUMP, PUMP_AMM, RAY_LAUNCHLAB, METEORA_DLMM, METEORA_DBC, METEORA_DAMM2]);
/** The venues that send them only so: their log holds none. */
const INNER_ONLY: ReadonlySet<string> = new Set([METEORA_DLMM, METEORA_DBC, METEORA_DAMM2]);
/** `t` marked the program's own (off the tape) when a decoded venue runs below its frame (`below`: the frames under
 *  the one that logged it, outermost first). */
const placed = (t: RawTrade, below: readonly (string | undefined)[]): RawTrade => (below.some((p) => p !== undefined && VENUES.has(p)) ? { ...t, tape: false } : t);

const INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const END = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed.*)$/;
const DATA = /^Program data: ([A-Za-z0-9+/=]+)$/;
/** Lines read per transaction (the runtime keeps at most 10 KB of log). */
const LINES_MAX = 2_000;
const LINE_MAX = 4_096;

/**
 * The trades in one transaction's log, in log order, with `truncated` true when the runtime cut the log short or the
 * lines do not make one well-formed invoke stack (the caller then reads the inner instructions).
 */
export function fromLogs(logs: unknown): { trades: RawTrade[]; truncated: boolean } {
  if (!Array.isArray(logs) || logs.length > LINES_MAX) return { trades: [], truncated: true };
  const stack: string[] = [];
  const trades: RawTrade[] = [];
  for (const line of logs) {
    if (typeof line !== "string" || line.length > LINE_MAX) return { trades: [], truncated: true };
    if (line === "Log truncated") return { trades, truncated: true };
    let m = INVOKE.exec(line);
    if (m !== null) {
      if (Number(m[2]) !== stack.length + 1) return { trades: [], truncated: true };
      stack.push(m[1]!);
      continue;
    }
    m = END.exec(line);
    if (m !== null) {
      if (stack[stack.length - 1] !== m[1]) return { trades: [], truncated: true };
      stack.pop();
      continue;
    }
    m = DATA.exec(line);
    if (m !== null && stack.length > 0) {
      const t = decodeEvent(stack[stack.length - 1]!, Buffer.from(m[1]!, "base64"));
      if (t !== null) trades.push(placed(t, stack.slice(0, -1)));
    }
  }
  return { trades, truncated: stack.length !== 0 };
}

type Ix = { programIdIndex?: unknown; data?: unknown; stackHeight?: unknown };
/**
 * The trades in a transaction's inner instructions (a `getTransaction` answer's `result`, json encoding): each event
 * CPI to a venue program (Anchor's event CPI requires the program's own event-authority signer, so only the program can
 * make one that succeeds; failed transactions are skipped by the caller). Used when the log was cut short.
 */
export function fromInner(result: unknown): RawTrade[] {
  const r = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
  const meta = (r.meta ?? {}) as Record<string, unknown>;
  const msg = ((r.transaction ?? {}) as Record<string, unknown>).message as Record<string, unknown> | undefined;
  const loaded = (meta.loadedAddresses ?? {}) as Record<string, unknown>;
  const keys = [msg?.accountKeys, loaded.writable, loaded.readonly].flatMap((k) => (Array.isArray(k) ? k : []));
  if (!keys.every((k) => typeof k === "string") || !Array.isArray(meta.innerInstructions)) return [];
  const top = Array.isArray(msg?.instructions) ? (msg.instructions as Ix[]) : [];
  const out: RawTrade[] = [];
  for (const group of meta.innerInstructions as { index?: unknown; instructions?: unknown }[]) {
    if (!Array.isArray(group?.instructions)) continue;
    // the invoke stack as the group runs (its top-level instruction at height 1, undefined when the answer omits it; each
    // inner one at its stackHeight); past a height that does not build one stack no trade is marked the program's own
    const first = typeof group.index === "number" ? top[group.index] : undefined;
    const frames: (string | undefined)[] = [typeof first?.programIdIndex === "number" ? keys[first.programIdIndex] : undefined];
    let whole = true;
    for (const ix of group.instructions as Ix[]) {
      const program = typeof ix.programIdIndex === "number" ? keys[ix.programIdIndex] : undefined;
      const h = ix.stackHeight;
      if (whole && Number.isSafeInteger(h) && (h as number) >= 2 && (h as number) <= frames.length + 1) {
        frames.length = (h as number) - 1;
        frames.push(program);
      } else whole = false;
      if (program === undefined || !CPI_VENUES.has(program) || typeof ix.data !== "string") continue;
      const bytes = b58data(ix.data);
      if (bytes === null || Buffer.from(bytes.subarray(0, 8)).toString("hex") !== DISC.cpi) continue;
      const t = decodeEvent(program, Buffer.from(bytes.subarray(8)));
      // the event CPI's frame is the venue's own; the one under it the swap that sent it; below that, the swap's callers
      if (t !== null) out.push(whole ? placed(t, frames.slice(0, -2)) : t);
    }
  }
  return out;
}

/**
 * Whether a log names a venue that sends its events only to itself (Meteora DLMM, DBC, DAMM v2) running: its trades are
 * then in the transaction's inner instructions alone (`cutTrades`), never in the log.
 */
export function eventsInInner(logs: unknown): boolean {
  if (!Array.isArray(logs) || logs.length > LINES_MAX) return false;
  for (const line of logs) {
    const m = typeof line === "string" && line.length <= LINE_MAX ? INVOKE.exec(line) : null;
    if (m !== null && INNER_ONLY.has(m[1]!)) return true;
  }
  return false;
}

/**
 * A cut log's trades, or the trades of a transaction `eventsInInner` names: the inner instructions' event CPIs (pump.fun,
 * PumpSwap, LaunchLab, the Meteora venues) and the log's own events of the venues that only log theirs (Orca, Raydium
 * CLMM and CPMM), which the runtime wrote before it cut the log. `f` is that log's `fromLogs`.
 */
export function cutTrades(f: { trades: RawTrade[] }, result: unknown): RawTrade[] {
  return [...fromInner(result), ...f.trades.filter((t) => t.venue === "orca" || t.venue === "raydium-clmm" || t.venue === "raydium-cpmm")];
}

/** A pair venue's pool account's two mints (first, second), or null unless `owner` is that venue's program and the data
 *  is its pool account. */
export function poolPair(venue: PairVenue, owner: unknown, data: Buffer): { a: string; b: string } | null {
  const d = data.subarray(0, 8).toString("hex");
  if (venue === "orca") return owner === ORCA && d === DISC.orcaPool && data.length >= 213 ? { a: key(data, 101), b: key(data, 181) } : null;
  if (venue === "raydium-clmm") return owner === RAY_CLMM && d === DISC.clmmPool && data.length >= 137 ? { a: key(data, 73), b: key(data, 105) } : null;
  if (venue === "raydium-launchlab") return owner === RAY_LAUNCHLAB && d === DISC.clmmPool && data.length >= 269 ? { a: key(data, 205), b: key(data, 237) } : null;
  if (venue === "meteora-dlmm") return owner === METEORA_DLMM && d === DISC.dlmmPool && data.length >= 152 ? { a: key(data, 88), b: key(data, 120) } : null;
  if (venue === "meteora-damm2") return owner === METEORA_DAMM2 && d === DISC.pool && data.length >= 232 ? { a: key(data, 168), b: key(data, 200) } : null;
  // DBC: the quote mint is its config's (dbcPair)
  return null;
}

/** A Meteora DBC pool's base mint and its config's quote mint (base, quote), or null unless DBC owns both accounts, each
 *  is the account it should be, and the pool names `config` (the event's) as its config. */
export function dbcPair(pool: { owner: unknown; data: Buffer }, cfg: { owner: unknown; data: Buffer }, config: string): { a: string; b: string } | null {
  if (pool.owner !== METEORA_DBC || cfg.owner !== METEORA_DBC) return null;
  if (pool.data.length < 168 || pool.data.subarray(0, 8).toString("hex") !== DISC.dbcPool || key(pool.data, 72) !== config) return null;
  if (cfg.data.length < 40 || cfg.data.subarray(0, 8).toString("hex") !== DISC.dbcConfig) return null;
  return { a: key(pool.data, 136), b: key(cfg.data, 8) };
}

/** A PumpSwap `Pool` account's mints (its base64 data), or null when it is not one. */
export function poolMints(data: Buffer): { base: string; quote: string } | null {
  if (data.length < 107 || data.subarray(0, 8).toString("hex") !== DISC.pool) return null;
  return { base: key(data, 43), quote: key(data, 75) };
}
