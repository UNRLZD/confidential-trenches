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
// Display only: nothing here feeds a signature. Every value is hostile input: a line counts only with the program at
// the top of the invoke stack the same logs build, an event only with its exact discriminator and a length that holds
// every field read, an amount only > 0.

export const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const WSOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
import { b58encode } from "./lists.ts";

const DEFAULT_KEY = "11111111111111111111111111111111";

const DISC = {
  trade: "bddb7fd34ee661ee",
  buy: "67f4521f2cf57777",
  sell: "3e2f370aa503dc2a",
  pool: "f19a6d0411b16dbc",
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

/** One trade as the venue logged it. `mint` is the token (curve) or null until the pool is read (PumpSwap). */
export type RawTrade = {
  venue: "pump" | "pumpswap";
  mint: string | null;
  pool: string | null;
  side: "b" | "s";
  /** The token leg, smallest unit, > 0. */
  amt: bigint;
  /** The quote leg, smallest unit, > 0. */
  quote: bigint;
  /** The quote's mint: WSOL for SOL. For PumpSwap, null until the pool is read. */
  quoteMint: string | null;
  user: string;
  /** The event's own clock, unix seconds. */
  ts: number;
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

/** The trade an event of `program` holds (its bytes with the discriminator first), or null. */
export function decodeEvent(program: string, data: Buffer): RawTrade | null {
  if (data.length < 8) return null;
  const d = data.subarray(0, 8).toString("hex");
  const body = data.subarray(8);
  if (program === PUMP && d === DISC.trade) return pumpTrade(body);
  if (program === PUMP_AMM && d === DISC.buy) return ammTrade(body, "b");
  if (program === PUMP_AMM && d === DISC.sell) return ammTrade(body, "s");
  return null;
}

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
      if (t !== null) trades.push(t);
    }
  }
  return { trades, truncated: stack.length !== 0 };
}

type Ix = { programIdIndex?: unknown; data?: unknown };
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
  const out: RawTrade[] = [];
  for (const group of meta.innerInstructions as { instructions?: unknown }[]) {
    if (!Array.isArray(group?.instructions)) continue;
    for (const ix of group.instructions as Ix[]) {
      const program = typeof ix.programIdIndex === "number" ? keys[ix.programIdIndex] : undefined;
      if ((program !== PUMP && program !== PUMP_AMM) || typeof ix.data !== "string") continue;
      const bytes = b58data(ix.data);
      if (bytes === null || Buffer.from(bytes.subarray(0, 8)).toString("hex") !== DISC.cpi) continue;
      const t = decodeEvent(program, Buffer.from(bytes.subarray(8)));
      if (t !== null) out.push(t);
    }
  }
  return out;
}

/** A PumpSwap `Pool` account's mints (its base64 data), or null when it is not one. */
export function poolMints(data: Buffer): { base: string; quote: string } | null {
  if (data.length < 107 || data.subarray(0, 8).toString("hex") !== DISC.pool) return null;
  return { base: key(data, 43), quote: key(data, 75) };
}
