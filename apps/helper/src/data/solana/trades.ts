// The Solana token page's candles and trade tape from the helper's own chain reads (card index-sol-trades, slice 1: the
// pump.fun curve and PumpSwap; markets paper 06b §6.1 `Candles` and `Trades`): GET /v1/market/candles and
// /v1/market/trades with chain=solana. Each trade is decoded from its venue's own event (decode.ts) and fed to the same
// candle builder and tape as the EVM chains (../candles.ts, the one pricing rule in its header).
//
// The source (one small interface, `Source`): a stream of each open token's transaction logs, `logsSubscribe` with
// `mentions: [mint]` at `confirmed`, on SOLANA_STREAM_WS_URL when set (a keyed provider's websocket, e.g. Helius's
// wss://mainnet.helius-rpc.com/?api-key=..., a drop-in) and the public wss://api.mainnet-beta.solana.com otherwise;
// requests (the signature walks, a transaction whose log was cut, a pool, the SOL price) go to SOLANA_TRADES_RPC_URL
// when set and then the public endpoints in TRADES_RPCS, one after another, per request. Measured from the Mac
// 2026-11-03 21:0xZ: the public websocket held four per-mint subscriptions (first answer 1.4 s after connect) and sent
// 87 trades in 20 s, arrival minus the event's own whole-second clock p50 1.19 s, p95 1.78 s (so at most that after the
// block); `processed` sent every transaction twice, `confirmed` once, and for one mint over 30 s it sent exactly the
// signatures `getSignaturesForAddress` lists for those slots (none missed, none extra); solana-rpc.publicnode.com's
// websocket answered no subscription. Polling signatures instead costs a request per token per poll and a
// `getTransaction` per trade against the public endpoint's 100 requests per 10 s, so the stream carries the live tape
// and requests only fill gaps.
//
// Gaps. A token's coverage is continuous from its first read: a cold read of its newest COLD_SIGS signatures (each
// transaction read once), then the stream. When the stream drops (a close, an error, no message for SILENT_MS), every
// token goes to `refilling` and keeps the last signature held before the drop: after the stream is back and subscribed
// again, its signatures since that one are walked (`until`, pages of SIG_PAGE, at most REFILL_MAX) and each transaction
// read. The stream's trades reach the tape at once all the while (the tape never waits on a request: the public RPC
// takes seconds a call from a data centre); the gap's trades join in chain order as they are read, and nothing settles
// until the walk is done. A transaction is held once (by signature), whichever way it came.
//
// Order and settling. A trade's place is (slot, the order it was first seen: the stream's order, or the signature
// list's within a refill), its time the event's own clock. Events are folded into the book's aggregates only
// SETTLE_SLOTS behind the newest slot held while the stream is live (confirmed slots are not rolled back in practice;
// the margin keeps a refill's late trades out of what is settled).
//
// The SOL price: Pyth's SOL/USD price account (PYTH_SOL_USD, the receiver program's sponsored feed), read every
// REF_MS and taken only with the receiver as owner, the PriceUpdateV2 discriminator, full verification, the SOL/USD
// feed id, an exponent in -12..0, a price > 0 and a publish time within REF_STALE_S of now; it enters each book as the
// `ref` at the read's slot (the candle builder's native-coin price, its `eth` quote kind). Read 2026-11-03 21:0xZ:
// owner rec5EKMG..., 134 bytes, verification level 1 (full), exponent -8, 93.42 USD.
//
// A token's trades are priced in their quote: SOL (Pyth, above), USDC (one dollar), or any other quote coin (a coin
// launched against FRONTIER, DOGE or PUMP: 2 of 3 curve coins and 1 of 3 PumpSwap coins on the lists read 11 Nov
// 15:10Z) at that coin's own USD price, `quoteUsd` (its Discover or Jupiter row, read every REF_MS while a token quoted
// in it is open) and its decimals from its mint account. The pool venues past pump.fun (card
// helper-listed-charts-own-reads: Orca Whirlpool, Raydium CLMM, CPMM and LaunchLab, where the listed coins off pump.fun
// trade most, decode.ts) are read the same way: the pool account (or CPMM's own event) names the two mints (a pool
// taken only with that venue's program as its owner), the token is either one and the other is the quote, priced as
// above; their events carry no clock, so a trade is dated by its block: a transaction read its blockTime, a stream's the
// slot's own clock, the Clock sysvar the stream sends for each confirmed slot (`SourceEvents.clock`, getBlockTime's in 18
// of 18 slots read 20 Nov 05:0xZ; the clock a pump.fun, PumpSwap, DBC or DAMM v2 event carries is a second before it in
// some slots, so those are dated by their block too: card helper-sol-tape-checks-hold, `dated`), or the slot's
// getBlockTime when the stream sent none within CLOCK_WAIT_MS
// (card sol-tape-in-order: dated by the second it arrived, 2 s after its block from the deployed helper, an Orca row sat
// above a DLMM row of its own block on TTWO's tape). Meteora DLMM, DBC and DAMM v2 (card index-sol-trades-2) send their
// events only to themselves, so a stream transaction whose log names one running is read whole (`eventsInInner`) and
// dated by its block. A venue not decoded yet keeps GeckoTerminal's bars and tape for its coins.
// Every REPORT_MS the log says how many open tokens have an empty tape and why (a quote with no price, or no trade of
// a venue we read in the transactions that named the token), never which tokens.
//
// Display only: nothing here feeds a signature. Every provider value is hostile: bounded answers, decoders that check
// every byte they read (decode.ts), PumpSwap pools taken only when the PumpSwap program owns them and their base mint
// is the token, bounded books, subscriptions and caches.
import { change4h, createBook, fixed, joinBars, TF_SECONDS, TFS, VALUE_SCALE, type Book, type BookState, type Candle, type Event, type Swap, type Tf } from "../candles.ts";
import { address, b58decode } from "./lists.ts";
import { HELD_WAIT_MS, SOL_BEHIND_MS, SOL_VENDOR_REACH_MS, TAPE_OPEN_BOUND_MS, type DataAnswer, type TapeRow } from "./token.ts";
import { cutTrades, dbcPair, eventsInInner, fromLogs, poolMints, poolPair, PUMP_AMM, USDC, WSOL, type RawTrade } from "./decode.ts";
import { CREDITS, type Slot } from "../../rpc/slot.ts";
import { pass } from "../../limits/turn.ts";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** A read's own providers (the whole reads' WHOLE_RPCS), asked in order, each held for its own 429's wait. */
type Lane = { urls: readonly string[]; held(url: string): boolean; throttled(url: string, s: number): void };

export const STREAM_WS = "wss://api.mainnet-beta.solana.com";
export const TRADES_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"] as const;
/**
 * Card sol-meteora-tape-inside-rpc-budget: the providers a Meteora stream transaction is read whole on (txTrades), one
 * the helper's caller, sell and fee routes never send to (rpc.ts: SOLANA_RPC_URL, its keyed spares, then
 * api.mainnet-beta), so no burst of Meteora trades takes their room. At c775de255 these reads went to the trades list,
 * whose first provider is the main key: 10 listed Meteora coins open on a local helper on mainnet (18 Nov 17:35-17:44Z)
 * sent 196 to 307 getTransaction a minute (Helius about 145, publicnode 38 to 105, api.mainnet-beta 25 to 50 with its
 * 429s) and logged 61 "rpc hold solana-public background" lines, the reads trades.ts's header names the stream as
 * avoiding. solana-rpc.publicnode.com names no limit (no rate header on its answers); read from the Mac 18 Nov 17:44Z,
 * getTransaction at 5, 10 and 20 a second for 10 s each answered 350 of 350, none null, p50 130-136 ms, p95 238-462 ms.
 * Card meteora-whole-reads-second-provider: then solana.api.pocket.network, asked while publicnode holds. publicnode
 * limits by address, and the market's reads ask it too (TRADES_RPCS): helper 64ecd1e35 logged about 40 of their 429s
 * in one second (24 Nov 11:04:06Z), and live run 45380527652 then read a DBC coin's trades cut "its provider held" for
 * 95 s. Pocket, read 24 Nov 11:3xZ: from the helper box one getTransaction answered 200 in 95 ms; from the Mac at 3 a
 * second it answered 20 of 20 DBC, 19 of 20 DAMM v2 and 13 of 20 DLMM transactions, declining the other 7 DLMM (400
 * "request declined"), so it serves as the second only. public.rpc.solanavibestation.com refused its port 443 from both.
 */
export const WHOLE_RPCS = ["https://solana-rpc.publicnode.com", "https://solana.api.pocket.network"] as const;
/** The whole reads sent a second, every coin together. [design: 10, half the 20 a second publicnode answered whole
 *  above, so the trade walks' own last fallback (TRADES_RPCS) keeps the other half] */
export const WHOLE_PER_S = 10;
/** The whole reads one coin may send a WHOLE_WINDOW_MS, so one busy coin never takes every coin's second. [design: 20,
 *  two a second: ten coins at it fill WHOLE_PER_S; a coin past it names the cut (CUT_KEEP_MS)] */
export const WHOLE_COIN_MAX = 20;
export const WHOLE_WINDOW_MS = 10_000;
/** How long a coin whose Meteora trade went unread (past the budget) names the cut (trades: its own rows filling, never
 *  whole; its top pool's tape only while it holds no row of its own): a minute, so a coin at the budget's edge never
 *  flips between whole and not read to read. */
export const CUT_KEEP_MS = 60_000;
/** Card helper-tape-handover-judges-handed-books: the Server-Timing part of a trades answer whose tape the previous
 *  process handed over (restore). */
export const HANDED_TIMING = 'sol-handed;desc="tape from the handover"';
/** Card helper-sol-tape-checks-hold, round 3: the places of each second (of WHOLE_PER_S) a busy coin (WHOLE_QUIET_MAX or
 *  more whole reads in its WHOLE_WINDOW_MS) may not take, kept for the quiet coins. Live run 44901581973 (helper
 *  4e03fcbac, 21 Nov 12:0xZ): a DBC coin trading 3 times in 136 s was cut "past every coin's 10 a second" each time,
 *  while 10 busy DLMM and DAMM v2 coins past their own 20 a 10 s kept every second full. [design: 3 of 10, a quiet coin's
 *  trade a second for three coins at once; the busy coins keep 7 a second, each still at most WHOLE_COIN_MAX a window,
 *  and the second's total stays WHOLE_PER_S] */
export const WHOLE_QUIET_ROOM = 3;
/** A coin with this many whole reads in its WHOLE_WINDOW_MS is busy: past one every two seconds. [design: 5, a
 *  quarter of WHOLE_COIN_MAX] */
export const WHOLE_QUIET_MAX = 5;
/** How long after a whole read publicnode answered null it is asked once more, in a place of its own (card
 *  helper-sol-tape-checks-hold, round 3). Read from the box 21 Nov 12:3xZ: a DBC or DLMM transaction asked the moment the
 *  public websocket named it (confirmed) answered null 36 times of 40, and all 36 answered a second later; the helper
 *  logged 71 of 156 whole reads unanswered in a minute. [design: 1 s, that read] */
export const WHOLE_NULL_WAIT_MS = 1_000;
/** How long after the stream names a Meteora transaction its whole read is sent (its place in the budget taken when it
 *  arrives). Read from the box 21 Nov 12:5xZ, fresh DBC and DLMM transactions asked of publicnode once each: at once 2
 *  answered of 10, at 150 ms 31 of 33, at 250 ms 42 of 42 over two runs, at 400 ms 32 of 32. A read sent at once is
 *  mostly null and spends a second place (WHOLE_NULL_WAIT_MS). [design: 250 ms, that read] */
export const WHOLE_READ_WAIT_MS = 250;
/** Card helper-sol-tape-first-answer-chain: how long a busy coin's read past its share waits for the next second's place
 *  before it is cut. Round 3 cut it at once, though no quiet coin waited for the reserved places: coin 7R4MP6VX7n3R (a pump
 *  coin routing ~70% of its transactions through Meteora DLMM, bursts of 7+ in one second) answered src vendor on its
 *  first answer in 2 of 3 local runs at 8713b1ca3. A place frees at most a second after the second's oldest, so one
 *  wait is all a read gets. [design: 1 s, the second] */
export const WHOLE_BUSY_WAIT_MS = 1_000;
/** Card helper-sol-tape-checks-hold: why a coin's trade went unread, named in its cut (Server-Timing sol-whole-cut), so a
 *  reader tells a busy coin past its own share (the design's bound past two trades a second) from every coin's second
 *  spent or its provider failing: live run 44721792317 named one DBC coin's cut 13 times as a starved budget. No comma:
 *  the entry ends at one. */
const CUT_WHY = {
  coin: `past the coin's own ${WHOLE_COIN_MAX} a ${WHOLE_WINDOW_MS / 1_000} s`,
  busy: `past the ${WHOLE_PER_S - WHOLE_QUIET_ROOM} a second busy coins share`,
  all: `past every coin's ${WHOLE_PER_S} a second`,
  held: "its provider held",
  unanswered: "its read unanswered",
} as const;
type CutWhy = keyof typeof CUT_WHY;
export const PYTH_RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
export const PYTH_SOL_USD = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
const PYTH_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const PRICE_UPDATE_DISC = "22f123639d7ef4cd";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
export const SYSVAR_CLOCK = "SysvarC1ock11111111111111111111111111111111";
const SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";
/** How long a stream trade with no clock of its own waits for its slot's clock before its block time is read (card
 *  sol-tape-in-order). [design: 1 s; measured 18 Nov 16:5xZ on one public websocket, TTWO's 36,529 notes in 40 s: the
 *  slot's clock came first for 84%, else p50 32 ms and at most 746 ms after the note, and for every one of 178 slots] */
export const CLOCK_WAIT_MS = 1_000;
/** Slots whose clock is held [design: about five minutes of slots (178 in 40 s, read above), far past any note's wait] */
const CLOCKS_MAX = 1_500;

/** A first read's successful signatures (the bars before them are the history source's), and the transactions read at once. */
export const COLD_SIGS = 30;
/** The longest wait between a failed cold walk and the next (first): 1 s, doubling. [design: 30 s, the industry's capped
 *  exponential backoff; a token's page reads a filling tape again every few seconds meanwhile] */
export const COLD_RETRY_MAX_MS = 30_000;
/** A first read's second signature page, past a first page that held fewer than COLD_SIGS successful: Solana's largest
 *  (getSignaturesForAddress `limit` at most 1000). A bot-flooded token's newest signatures are failed transactions:
 *  CjRGc8wH...pump at 2026-11-15T07:27:09Z, 0 successful in its newest 30, 29 in its newest 1000 (4,562 of 4,992 failed in
 *  the 10 minutes before). Read 08:5xZ: a 1000 page of it is 246,915 bytes, 269 ms on api.mainnet-beta, 386 ms on
 *  publicnode. */
export const COLD_PAGE = 1_000;
const TX_PARALLEL = 5;
export const SIG_PAGE = 100;
/** The page listed beside a flooded first read's COLD_PAGE when its first page held no successful signature, so some
 *  are read before the COLD_PAGE lands (card solana-flooded-coin-first-answer-holds-rows). [design: one in 34 succeeded
 *  past CjRGc8wH...pump's newest 30 (live run 43689567273), so 100 holds about 3; a page's time grows with its size
 *  (1000: 1,599 ms from the Mac)] */
export const SHORT_PAGE = 100;
export const REFILL_MAX = 1_000;
export const SETTLE_SLOTS = 150;
/** A first read answers after its walk, its first trade held, or this long after the read began, with what it holds by
 *  then (filling), whatever is still waited on, the subscription included. [design: 2 s: the deployed helper at
 *  77bfa8030 on its keyed lanes, 22 Nov 03:53Z, answered six cold coins' first tapes by a trade after one round at 124
 *  to 462 ms (sol-open), 25 reads joined on one busy coin at 308 ms; helper-answers-through-a-burst holds 3 s with the
 *  runner's round trip (lists p50 641 ms), and at 3 s from the subscription live run 44979250087 answered 12 joined
 *  tapes at 3.9 s. At 1.5 s a local helper on the public lanes answered 6 of 6 busy coins at the bound with no row
 *  (21 Nov 22:20Z): those lanes are not the deployed one's] */
export const COLD_WAIT_MS = 2_000;
/** How long into a first read that holds no row yet the vendor's tape is read, so an answer at the bound with no row of
 *  ours never waits on it [design: half the bound; the burst of live run 44979250087 read the vendor only once its
 *  joined first read reached the bound, server total 3.29 to 3.37 s for 12 tapes]. */
export const VENDOR_EARLY_MS = 1_000;
/** A first read's subscription asked again after the stream dropped before it was in force, at most this many asks in
 *  all, inside TIMEOUT_MS [design: the stream reconnects within RECONNECT_MS's first steps and subscribes every mint it
 *  watches again; a drop failed every read joined on the mint (app-console-429 on helper-20: 25 of 25 reads 503 at 3.6
 *  s on one cold coin)]. */
export const WATCH_TRIES = 3;
/** A listed coin's first read that failed (its account, its subscription): named in the refusals' count. */
export const FIRST_FAILED = "solana first read failed";
/** A listed coin whose first read failed is opened again only after this wait, doubled after each failure to
 *  COLD_RETRY_MAX_MS, its reads in between answered at once from what is held (filling), as the cold walk's own retry
 *  waits [design: the 503 a failed first read answered before made the page back off to 30 s (apps/terminal
 *  screens/token/trades.ts TRADES_BACKOFF_MAX_MS); its filling answer is polled every 3 s, so without a wait here every
 *  page's poll of a coin whose reads fail (a spent key, the public lanes) ran the whole first read and a vendor read
 *  again: live run 44989861313 on helper-21 ran with helius-rpc.com spent and its burst landed every route at ~2.4 s] */
export const FAILED_OPEN_MS = 1_000;
/** How long after a first read its answers name its phases (sol-open): the reads that joined it. */
export const OPEN_NAMED_MS = 1_000;
export const SILENT_MS = 30_000;
/** SOL_BEHIND_MS and SOL_VENDOR_REACH_MS live in token.ts, whose tapes wait past the reach (card
 *  sol-vendor-tape-waits-past-reach); token.ts cannot import this file, which imports it. */
export { SOL_BEHIND_MS, SOL_VENDOR_REACH_MS };
export const REF_MS = 5_000;
export const REF_STALE_S = 120;
export const IDLE_MS = 60_000;
export const OPEN_MAX = 40;
/** Card helper-listed-charts-own-reads round 3: a listed coin whose history answers no bars (404, an empty list) or is
 *  refused or still filling has its own signatures read back before its walk's oldest, in COLD_PAGE pages, until the
 *  bars a chart asked for, the coin's first signature, BACK_SPAN_S or BACK_TX_MAX transactions. GTA6 (2gVNeu8d...pump)
 *  on 16 Nov 00:37Z: a month old, 1,557 trades a day on PumpSwap, no top pool on GeckoTerminal and an empty OHLCV for its
 *  pool; the deployed helper answered it 1 bar, src chain, from the walk's newest COLD_SIGS. [design: a day, the
 *  handover's KEPT_HANDOVER_MS; a chart of a coin older than that opens on a day of its own bars] */
export const BACK_SPAN_S = 86_400;
/** The transactions one read back reads at most. [design: 3,000, about two of GTA6's days; at TX_PARALLEL a time on the
 *  public endpoints a few minutes of background reads, its chart filling meanwhile] */
export const BACK_TX_MAX = 3_000;
/** Read back steps at once across every token (a signature page, or a chunk of TX_PARALLEL transactions), so a burst of
 *  listed coins (a deploy's live run opens 194 at once) never takes the public endpoints from the walks' and callers'
 *  reads. Every read back asked runs, its steps taking these lanes in the order asked (backLane), so a read back of a few
 *  transactions never waits behind one of BACK_TX_MAX (card app-chart-check-inside-its-bound: live helper 207, 19 Nov
 *  17:26-17:30Z, two read backs ran to their end at once and the rest queued: ygq5gP...pump's 10 transactions said
 *  filling 3 min 18 s, EHFrCL...pump's empty page 4 min 21 s). [design: two of the walks' TX_PARALLEL] */
export const BACK_PARALLEL = 2;
/** A read back's place in a slot: below the walks' and the stream's (a counter from 1), never a clash of order. */
const BACK_INDEX = 1e12;
export const REPORT_MS = 60_000;
const QUOTES_MAX = 200;
export const TRADES_MAX = 50;
/** The longest a tape whose own walk holds no trade says filling while the vendor (deps.tape) refuses or fails: past it
 *  the tape answers what it holds, and a token with no walk of ours the vendor's own refusal (card
 *  solana-dropped-tape-settles). [design: 30 s, under the live checks' 45 s (scripts/live-checks/tape-read.mjs
 *  FILLED_MS) with room for the page's 2 s reads; a vendor's 429 waits out its minute's budget meanwhile] */
export const VENDOR_WAIT_MS = 30_000;
/** Mints poolTape waits on at once, at most [design: OPEN_MAX's walks and the page's searched tokens, a few hundred]. */
const WAITING_MAX = 1_000;
export const CANDLES_MAX = 500;
const POOLS_MAX = 5_000;
const ANSWER_MAX = 4 * 1024 * 1024;
const TIMEOUT_MS = 8_000;
/** A provider that gave no result: the next one is asked (rpc). */
const NO_ANSWER: unique symbol = Symbol("no answer");
/** How long in all a background read our own budget keeps from every provider waits its turn before it fails (rpc).
 *  [design: COLD_RETRY_MAX_MS, the longest a failed cold walk waited before it asked again] */
export const PACED_WAIT_MAX_MS = COLD_RETRY_MAX_MS;
const HELD_MAX = 20_000;
/** The bytes of tapes (each live token's book, its unsettled trades and price refs, the signature its tape is held to,
 *  its done read back and its rows' traders) handed to the next process in the warm file (../warm.ts; card
 *  helper-tape-handover), the most recently asked first; a tape past what is left is skipped (it opens cold, as every
 *  tape did before). [design: one bound with the EVM chains' books, evm/swaps.ts BOOKS_HANDOVER_MAX] */
export const TAPES_HANDOVER_MAX = 8 * 1024 * 1024;
/** How old a handed over tape's last fold may be for the next process to take it: its gap from the signature it is held
 *  to is walked as a dropped stream's is (REFILL_MAX at most, past it a hole named). [design: one with evm/swaps.ts
 *  BOOK_HANDOVER_AGE_MS] */
export const TAPE_HANDOVER_AGE_MS = 600_000;
const VENUES_READ: readonly RawTrade["venue"][] = ["pump", "pumpswap", "orca", "raydium-clmm", "raydium-cpmm", "raydium-launchlab", "meteora-dlmm", "meteora-dbc", "meteora-damm2"];
/** A transaction signature as an RPC lists it: base58, 64 bytes (87 or 88 characters; shorter only in a test's). */
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;
/** A held trade as the handover writes it: venue, side, amt, quote, quote mint, user ("" none), time, on the tape (1/0). */
type HeldRow = [RawTrade["venue"], "b" | "s", string, string, string | null, string, number, 0 | 1];
/** A tape as state() hands it over. `from`: the signature its tape is held to with no gap (a dropped stream's gap
 *  start while one was walked), where the next process walks on from. */
type HandedTape = { decimals: number; quoteMint: string; quote: { kind: "usd" | "eth"; decimals: number }; book: BookState; held: [string, number, number, HeldRow[]][]; refs: [number, string][]; from: string; covered: number; touched: number; readAt: number; whole?: number; holed?: true; oldest?: string | null; back?: { book: BookState | null; born: boolean } };
const RECONNECT_MS = [500, 1_000, 2_000, 5_000];

/** A transaction's logs as the stream sends them. */
export type Note = { sig: string; slot: number; err: boolean; logs: unknown };
/** The stream: subscribe and unsubscribe mints, and tell the reader of each note, each drop and each return. `watch`
 *  resolves once the subscription is in force (a walk of signatures after it then misses nothing); `up` comes only
 *  when every watched mint's subscription is in force again after a drop. */
export type Source = {
  watch(mint: string): Promise<void>;
  unwatch(mint: string): void;
  close(): void;
  /** The stream's last message, when (now(), ms), and the newest slot its heartbeat named; null while it is not
   *  connected. A source without it (a test's) is taken as live. */
  heard?(): { at: number; slot: number | null } | null;
};
/** `clock`: a confirmed slot's clock (the Clock sysvar's unix_timestamp, the time its block is dated by). */
export type SourceEvents = { note(mint: string, n: Note): void; down(): void; up(): void; clock(slot: number, unixS: number): void };
type WsLike = { send(s: string): void; close(): void; onopen: (() => void) | null; onmessage: ((m: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null };

/** The first 4 KB of a refusal's body (enough for its error words), the rest never read. */
async function head(r: Response, max = 4_096): Promise<string> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for await (const c of r.body ?? []) {
      chunks.push(c);
      n += c.byteLength;
      if (n >= max) break;
    }
  } catch {
    // what came is enough
  }
  await r.body?.cancel().catch(() => undefined);
  return Buffer.concat(chunks).toString("utf8").slice(0, max);
}

/** A Clock sysvar notification's slot and unix time, taken only with the sysvar program as owner, its 40 bytes, the
 *  slot it names its context's, and a time > 0; else null. */
export function clockOf(result: unknown): { slot: number; unixS: number } | null {
  const r = (result ?? {}) as Record<string, unknown>;
  const ctx = (r.context ?? {}) as Record<string, unknown>;
  const v = (r.value ?? {}) as Record<string, unknown>;
  if (v.owner !== SYSVAR_OWNER || !Array.isArray(v.data) || typeof v.data[0] !== "string" || v.data[0].length > 64) return null;
  const d = Buffer.from(v.data[0], "base64");
  if (d.length !== 40) return null;
  const slot = d.readBigUInt64LE(0);
  const t = d.readBigInt64LE(32);
  if (slot > BigInt(Number.MAX_SAFE_INTEGER) || t <= 0n || t > BigInt(Number.MAX_SAFE_INTEGER) || Number(slot) !== ctx.slot) return null;
  return { slot: Number(slot), unixS: Number(t) };
}

/** How long a probe of a fallen-back stream key waits for its first message (card helper-solana-failover). */
export const PROBE_MS = 10_000;
/**
 * The websocket stream: one connection, one `logsSubscribe` per mint, reconnected with backoff. With `fallback` (card
 * helper-solana-failover, rpc/slot.ts), `url` is a keyed provider's: a connection to it that closes before it opens (a
 * refused key: a websocket shows no status) or that goes SILENT_MS without a message falls the slot back, and the
 * stream reconnects to the public `fallback.url`; while fallen back, every SLOT_RETRY_MS a probe connection to the key
 * waits PROBE_MS for its first message, and on one the stream moves back to the key (its gap walked as after any drop).
 */
export function wsSource(url: string, on: SourceEvents, deps: { ws?: (url: string) => WsLike; now?: () => number; fallback?: { url: string; slot: Slot } } = {}): Source {
  const make = deps.ws ?? ((u: string) => new WebSocket(u) as unknown as WsLike);
  const now = deps.now ?? Date.now;
  const slot = deps.fallback?.slot;
  const keyedSlot = slot !== undefined && slot.state() !== "public";
  /** The URL the next connection takes: the key unless its slot is fallen back with no retry due. */
  const target = (): string => (keyedSlot && !slot!.useKeyed() ? deps.fallback!.url : url);
  let onKey = false; // the live connection is the key's
  let opened = false;
  let probe: WsLike | null = null;
  let probeAt = 0;
  const mints = new Set<string>();
  const subOf = new Map<number, string>(); // subscription id -> mint
  const pending = new Map<number, string>(); // request id -> mint
  const subId = new Map<string, number>();
  const waiting = new Map<string, { resolve: () => void; reject: (e: Error) => void }[]>();
  let upSent = false;
  let ws: WsLike | null = null;
  let live = false;
  let closed = false;
  let tries = 0;
  let id = 0;
  let lastMsg = now();
  /** The newest slot the slot subscription named (the heartbeat), for the answers' Server-Timing. */
  let lastSlot: number | null = null;
  /** The Clock sysvar's subscription: its request id, then its subscription id (card sol-tape-in-order). */
  let clockRid: number | null = null;
  let clockSub: number | null = null;
  let silence: ReturnType<typeof setInterval> | null = null;

  function subscribe(m: string): void {
    if (ws === null || !live) return;
    const rid = ++id;
    pending.set(rid, m);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: rid, method: "logsSubscribe", params: [{ mentions: [m] }, { commitment: "confirmed" }] }));
  }
  function drop(why?: string): void {
    if (ws === null) return;
    // the key's connection: refused before it opened, or silent, is the key's failure
    if (keyedSlot && onKey) {
      if (!opened) slot!.fail("the stream closed before it opened");
      else if (why === "silent") slot!.fail(`no message for ${SILENT_MS / 1000} s`);
    }
    const w = ws;
    ws = null;
    live = false;
    clockRid = null;
    clockSub = null;
    subOf.clear();
    subId.clear();
    pending.clear();
    for (const [m, ws_] of waiting) for (const w of ws_) w.reject(new Error(`stream dropped before ${m} was subscribed`));
    waiting.clear();
    try {
      w.close();
    } catch {
      // closed already
    }
    on.down();
    if (!closed) setTimeout(connect, RECONNECT_MS[Math.min(tries++, RECONNECT_MS.length - 1)]!).unref?.();
  }
  function connect(): void {
    if (closed || ws !== null || mints.size === 0) return;
    const u = target();
    onKey = u === url;
    opened = false;
    const w = make(u);
    ws = w;
    w.onopen = () => {
      opened = true;
      live = true;
      upSent = false;
      tries = 0;
      lastMsg = now();
      // the slot stream is the heartbeat (a slot every ~400 ms): a quiet token's subscription sends nothing, so silence
      // on this connection means the connection, not the market
      w.send(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "slotSubscribe" }));
      for (const m of mints) subscribe(m);
      // each confirmed slot's clock, so a trade whose event has no clock is dated by its block (card sol-tape-in-order)
      clockRid = ++id;
      w.send(JSON.stringify({ jsonrpc: "2.0", id: clockRid, method: "accountSubscribe", params: [SYSVAR_CLOCK, { encoding: "base64", commitment: "confirmed" }] }));
      if (pending.size === 0) {
        upSent = true;
        on.up();
      }
    };
    w.onmessage = (msg) => {
      lastMsg = now();
      if (keyedSlot && onKey) slot!.ok();
      if (typeof msg.data !== "string" || msg.data.length > ANSWER_MAX) return;
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(msg.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (j.id === clockRid && clockRid !== null) {
        if (typeof j.result === "number") clockSub = j.result;
        return;
      }
      if (j.method === "accountNotification") {
        const p = (j.params ?? {}) as Record<string, unknown>;
        if (p.subscription !== clockSub || clockSub === null) return;
        const c = clockOf(p.result);
        if (c !== null) on.clock(c.slot, c.unixS);
        return;
      }
      if (typeof j.id === "number" && pending.has(j.id)) {
        const m = pending.get(j.id)!;
        pending.delete(j.id);
        if (typeof j.result === "number" && mints.has(m)) {
          subOf.set(j.result, m);
          subId.set(m, j.result);
          for (const w of waiting.get(m) ?? []) w.resolve();
          waiting.delete(m);
        } else if (mints.has(m)) {
          drop(); // a refused subscription: reconnect and ask again, the gap walked after
          return;
        }
        if (!upSent && pending.size === 0) {
          upSent = true;
          on.up();
        }
        return;
      }
      if (j.method === "slotNotification") {
        const r = ((j.params ?? {}) as Record<string, unknown>).result as Record<string, unknown> | undefined;
        const n = r?.slot;
        if (Number.isSafeInteger(n) && (n as number) > (lastSlot ?? -1)) lastSlot = n as number;
        return;
      }
      if (j.method !== "logsNotification") return;
      const p = (j.params ?? {}) as Record<string, unknown>;
      const m = typeof p.subscription === "number" ? subOf.get(p.subscription) : undefined;
      const r = (p.result ?? {}) as Record<string, unknown>;
      const ctx = (r.context ?? {}) as Record<string, unknown>;
      const v = (r.value ?? {}) as Record<string, unknown>;
      if (m === undefined || typeof v.signature !== "string" || !Number.isSafeInteger(ctx.slot)) return;
      on.note(m, { sig: v.signature, slot: ctx.slot as number, err: v.err !== null && v.err !== undefined, logs: v.logs });
    };
    w.onclose = () => drop();
    w.onerror = () => drop();
  }
  /** Fallen back with the retry due: a probe connection to the key; its first message moves the stream back to it. */
  function tryKey(): void {
    if (!keyedSlot || slot!.state() !== "fallback" || probe !== null || (onKey && ws !== null) || !slot!.useKeyed() || closed) return;
    const p = make(url);
    probe = p;
    probeAt = now();
    const end = (back: boolean) => {
      if (probe !== p) return;
      probe = null;
      try {
        p.close();
      } catch {
        // closed already
      }
      if (!back) return slot!.fail("the stream retry got no message");
      slot!.ok();
      drop(); // reconnect: to the key now
    };
    p.onopen = () => p.send(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "slotSubscribe" }));
    p.onmessage = () => end(true);
    p.onclose = () => end(false);
    p.onerror = () => end(false);
  }
  silence = setInterval(() => {
    if (ws !== null && now() - lastMsg > SILENT_MS) drop("silent");
    if (probe !== null && now() - probeAt > PROBE_MS) probe.onclose?.();
    tryKey();
  }, 5_000);
  silence.unref?.();
  return {
    heard: () => (ws !== null && live ? { at: lastMsg, slot: lastSlot } : null),
    watch(m) {
      if (subId.has(m)) return Promise.resolve();
      const p = new Promise<void>((resolve, reject) => waiting.set(m, [...(waiting.get(m) ?? []), { resolve, reject }]));
      if (!mints.has(m)) {
        mints.add(m);
        if (ws === null) connect();
        else subscribe(m);
      }
      return p;
    },
    unwatch(m) {
      mints.delete(m);
      waiting.delete(m);
      const s = subId.get(m);
      if (s !== undefined && ws !== null && live) ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "logsUnsubscribe", params: [s] }));
      subId.delete(m);
      if (s !== undefined) subOf.delete(s);
    },
    close() {
      closed = true;
      if (silence !== null) clearInterval(silence);
      if (probe !== null) probe.close();
      probe = null;
      drop();
    },
  };
}

/** Pyth's SOL/USD account data (base64-decoded) as USD per SOL times 10^18, or null when anything is off. */
export function pythSolUsd(owner: unknown, data: Buffer, nowS: number): bigint | null {
  if (owner !== PYTH_RECEIVER || data.length < 134 || data.subarray(0, 8).toString("hex") !== PRICE_UPDATE_DISC) return null;
  if (data[40] !== 1) return null; // VerificationLevel::Full (1 byte)
  const o = 41;
  if (data.subarray(o, o + 32).toString("hex") !== PYTH_FEED) return null;
  const price = data.readBigInt64LE(o + 32);
  const expo = data.readInt32LE(o + 48);
  const pub = Number(data.readBigInt64LE(o + 52));
  if (price <= 0n || expo < -12 || expo > 0 || Math.abs(nowS - pub) > REF_STALE_S) return null;
  return price * 10n ** BigInt(18 + expo);
}

/** A USD price as decimal text ("0.8706", at most 18 places) times 10^18, or null when it is not a price > 0. */
export function usdScaled(v: unknown): bigint | null {
  if (typeof v !== "string" || v.length > 60 || !/^\d+(\.\d+)?$/.test(v)) return null;
  const [w, f = ""] = v.split(".");
  const n = BigInt(w!) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
  return n > 0n ? n : null;
}

/** Card sol-vendor-tape-refresh-from-our-reads: a tape the vendor names a pool for (poolTape) is renewed from our own
 *  reads of that pool once its rows are this old, at a page's read [design: half TAPE_FRESH_MS, so a page reading every
 *  2 s is served rows under SOL_VENDOR_REACH_MS with room for a round's calls]. */
export const FOLLOW_MS = 5_000;
/** A round's signatures, newest first: a page this full leaves a gap below it. */
export const FOLLOW_SIGS = 100;
/** A round's transactions read at most, its newest successful ones; past it the tape holds only those (a gap below).
 *  [design: 20, a pool's 4 trades a second between two rounds; the tape shows TRADES_MAX] */
export const FOLLOW_TX_MAX = 20;
/** After a failed round, the next is this much later (a page's reads in between are served what is held). */
export const FOLLOW_RETRY_MS = 2_000;
const FOLLOWS_MAX = 300;
/** A pool account's data kept at most: an AMM pool is under 2 KB (Raydium CPMM 637 bytes, Meteora DLMM 904, Raydium
 *  CLMM 1,544); a bigger account is no pool we read (unplaced). */
const POOL_DATA_MAX = 10_240;
const SIG_TEXT = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const AMOUNT = /^\d{1,30}$/;

/** One pool trade as a transaction's token balances show it: the pool's two vaults, the token accounts the pool
 *  account's own data names (`poolData`) that the transaction's balances list, one holding `mint`, one another coin.
 *  The pool gave `mint` out (its vault fell, the other rose): a buy; took it in: a sell; anything else (a deposit, a
 *  withdrawal, a transaction that moves no vault, more than one vault of a side) is no trade (null). The coin amount is
 *  what the token transfers into (a sell) or out of (a buy) its vault moved, the sum of the token programs' Transfer and
 *  TransferChecked instructions (outer and inner) naming it, so a sell of a coin with a transfer fee shows what the
 *  trader sent, not what reached the pool after the fee (card sol-vendor-tape-refresh-from-our-reads: NEARKAT's sell
 *  26FmJUjr sent 11,490.514848, its vault rose 11,145.799402, the vendor names the first); the vault's own change when
 *  no such transfer is read, or transfers ran both ways. The trader's own balance is no measure: in the recorded
 *  NEARKAT trades the coin left or reached an account the fee payer does not own (26FmJUjr, C4c5gcJq), or the payer's
 *  change held a platform fee beside the pool's transfer (My1mjXoq: 653,864.627 left, 648,306.778 to the pool). Quote
 *  amounts are the vault's change, the trader the fee payer. Every field is the RPC's, hostile: bounded and checked. */
export type PoolLeg = { side: "b" | "s"; amt: bigint; decimals: number; quote: bigint; quoteMint: string; quoteDecimals: number; trader: string | null; ts: number };
export function poolLeg(tx: unknown, mint: string, poolData: Uint8Array): PoolLeg | null {
  const r = tx as Record<string, unknown> | null;
  const meta = r?.meta as Record<string, unknown> | null | undefined;
  const msg = (r?.transaction as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined;
  if (meta == null || meta.err !== null || !Array.isArray(msg?.accountKeys) || !Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) return null;
  const loaded = (meta.loadedAddresses ?? {}) as Record<string, unknown>;
  const keys = [...(msg.accountKeys as unknown[]), ...(Array.isArray(loaded.writable) ? loaded.writable : []), ...(Array.isArray(loaded.readonly) ? loaded.readonly : [])].slice(0, 512);
  const ts = Number.isSafeInteger(r!.blockTime) && (r!.blockTime as number) > 0 ? (r!.blockTime as number) : null;
  if (ts === null) return null;
  const data = Buffer.from(poolData);
  type Bal = { i: number; mint: string; amount: bigint; decimals: number };
  const bal = (v: unknown): Bal | null => {
    const b = v as Record<string, unknown> | null;
    const u = b?.uiTokenAmount as Record<string, unknown> | undefined;
    const m = address(b?.mint);
    if (!Number.isSafeInteger(b?.accountIndex) || m === null || typeof u?.amount !== "string" || !AMOUNT.test(u.amount) || !Number.isSafeInteger(u.decimals) || (u.decimals as number) < 0 || (u.decimals as number) > 30) return null;
    return { i: b!.accountIndex as number, mint: m, amount: BigInt(u.amount), decimals: u.decimals as number };
  };
  const pre = new Map<number, Bal>();
  for (const v of (meta.preTokenBalances as unknown[]).slice(0, 512)) {
    const b = bal(v);
    if (b !== null) pre.set(b.i, b);
  }
  // the vaults: token accounts whose 32-byte address the pool's own data holds
  const vaults: (Bal & { d: bigint; key: string })[] = [];
  for (const v of (meta.postTokenBalances as unknown[]).slice(0, 512)) {
    const b = bal(v);
    const key = b === null ? null : address(keys[b.i]);
    const bytes = key === null ? null : b58decode(key);
    if (b === null || bytes === null || data.indexOf(Buffer.from(bytes)) < 0) continue;
    const p = pre.get(b.i);
    if (p !== undefined && p.mint !== b.mint) return null;
    vaults.push({ ...b, d: b.amount - (p?.amount ?? 0n), key: key! });
  }
  const mine = vaults.filter((v) => v.mint === mint);
  const other = vaults.filter((v) => v.mint !== mint);
  if (mine.length !== 1 || other.length !== 1) return null;
  const [t, q] = [mine[0]!, other[0]!];
  const side = t.d < 0n && q.d > 0n ? "b" : t.d > 0n && q.d < 0n ? "s" : null;
  if (side === null) return null;
  const moved = t.d < 0n ? -t.d : t.d;
  const x = transfersOf(r!, keys, t.key);
  const sent = side === "s" ? (x.out === 0n && x.in >= moved ? x.in : moved) : x.in === 0n && x.out >= moved ? x.out : moved;
  return { side, amt: sent, decimals: t.decimals, quote: q.d < 0n ? -q.d : q.d, quoteMint: q.mint, quoteDecimals: q.decimals, trader: address(keys[0]), ts };
}

/** The token programs' transfers into (`in`) and out of (`out`) the account `key` in a transaction's instructions,
 *  outer and inner, in base units: Transfer (3: amount; source, destination) and TransferChecked (12: amount,
 *  decimals; source, mint, destination). Any other instruction, or one out of shape, counts nothing. */
function transfersOf(r: Record<string, unknown>, keys: unknown[], key: string): { in: bigint; out: bigint } {
  const msg = (r.transaction as Record<string, unknown>).message as Record<string, unknown>;
  const meta = r.meta as Record<string, unknown>;
  const all: unknown[] = Array.isArray(msg.instructions) ? msg.instructions.slice(0, 256) : [];
  for (const g of Array.isArray(meta.innerInstructions) ? meta.innerInstructions.slice(0, 256) : []) {
    const inner = (g as Record<string, unknown> | null)?.instructions;
    if (Array.isArray(inner)) all.push(...inner.slice(0, 256));
  }
  const t = { in: 0n, out: 0n };
  for (const v of all.slice(0, 2_048)) {
    const ix = v as Record<string, unknown> | null;
    const acc = ix?.accounts;
    if (!Number.isSafeInteger(ix?.programIdIndex) || !TOKEN_PROGRAMS.includes(keys[ix!.programIdIndex as number] as string) || !Array.isArray(acc) || typeof ix!.data !== "string") continue;
    const d = b58decode(ix!.data);
    if (d === null || d.length < 9 || (d[0] !== 3 && d[0] !== 12)) continue;
    const [src, dst] = d[0] === 3 ? [acc[0], acc[1]] : [acc[0], acc[2]];
    if (!Number.isSafeInteger(src) || !Number.isSafeInteger(dst)) continue;
    const amount = Buffer.from(d).readBigUInt64LE(1);
    if (keys[dst as number] === key) t.in += amount;
    if (keys[src as number] === key) t.out += amount;
  }
  return t;
}

/** A vendor-named pool's tape renewed from our own reads (poolTape): the rows (newest first, at most TRADES_MAX) as of
 *  `at` (the vendor's read, then each round's start), the newest signature read (`lastSig`), the pool account's data
 *  (read once), whether a round ever found a trade in it (`placed`) or read trades it could not (`unplaced`: the vendor
 *  serves this coin, as before), the round in flight, and the failed round's retry time. */
/** `hole`: a round cut short (FOLLOW_SIGS listed, or more than FOLLOW_TX_MAX successful) left signatures unread between
 *  `before` (the oldest it covered) and `until` (the newest held before it); the first `above` rows are above it, the
 *  rest below, and no complete list is claimed until later rounds have read down to `until`. */
type Follow = { pool: string; rows: TapeRow[]; src: string; at: number; lastSig: string | null; data: Uint8Array | null; placed: boolean; misses: number; unplaced: boolean; reading: Promise<void> | null; retryAt: number; touched: number; hole: { before: string; until: string } | null; above: number };

/** `p`'s settling, or `ms` passing, whichever is first (`p` goes on). */
function within(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.then(() => undefined, () => undefined), new Promise<void>((go) => (timer = setTimeout(go, ms)))]).finally(() => clearTimeout(timer));
}

type Held = { slot: number; seq: number; t: RawTrade[] };
type Entry = {
  mint: string;
  /** Card helper-tape-handover-judges-handed-books: the tape came from the previous process's handover (restore),
   *  named in its trades answer (HANDED_TIMING). */
  handed?: true;
  /** The first read's phases (first()), named in a cold tape's Server-Timing (sol-open) so a slow first answer names
   *  its wait: the mint's account, the stream's subscription, and what answered it (the walk, a trade held from the
   *  walk or the stream, or the bound), each in ms from the read's start. */
  open?: { at: number; desc: string };
  /** While a first read waits (first()): told after each fold, so a trade the stream sends answers it as a walk's round
   *  that holds one does. */
  onFold?: () => void;
  /** Reads waiting on this cold tape's first row of ours (trades: rowOrBound), told after each fold that holds one. */
  rowWaits?: Set<() => void>;
  /** The vendor's tape read VENDOR_EARLY_MS into a first read that held no row (first()), and when: the vendor reads
   *  within COLD_WAIT_MS of it take it (vendorTape), so the answers at the bound with no row of ours, every read joined
   *  on the first, never wait on the vendor or ask it again. */
  early?: { p: Promise<DataAnswer | null>; at: number };
  decimals: number;
  quoteMint: string | null;
  book: Book | null;
  /** Unsettled events by signature, and the refs by slot. */
  held: Map<string, Held>;
  refs: Map<number, bigint>;
  lastSig: string | null;
  /** The newest slot held with no gap before it. */
  covered: number;
  state: "cold" | "live" | "refilling";
  /** In `refilling`: the last signature held before the stream dropped (the gap's walk starts after it). */
  gapFrom: string | null;
  /** The gap's walk in flight, one per token. */
  refilling: Promise<void> | null;
  /** Transactions being read (signature to slot). */
  inflight: Map<string, number>;
  touched: number;
  readAt: number | null;
  /** Transactions the stream or a walk gave for this token, and how many held a trade of it (the log's why). */
  seen: number;
  traded: number;
  /** The oldest signature the first walk read (the read back starts before it), null when it listed none; undefined
   *  until the first walk listed its signatures. */
  oldest?: string | null;
  /** Its own signatures read back (BACK_SPAN_S), or undefined when none was asked. */
  back?: Back;
  /** How far back the tape holds every trade of the venues it decodes, in ms (card token-stats-count-every-trade, the
   *  trades answer's `whole_ms`): 0 when the first walk listed the mint's first signature; else the second after the
   *  oldest it read, or after a transaction a walk could not read, or after the oldest a gap's walk reached at REFILL_MAX
   *  (an unread gap lies below it). Undefined until the first walk ends. */
  whole?: number;
  /** Card app-chart-check-inside-its-bound: a hole a read back to the mint's first signature does not fill (a transaction
   *  a walk could not read, or a gap's walk stopped at REFILL_MAX); without one, that read back done leaves the tape whole
   *  from the first signature, as `whole` 0 does. */
  holed?: true;
  /** Card sol-meteora-tape-inside-rpc-budget: when this coin's last WHOLE_WINDOW_MS of whole reads were sent, oldest first. */
  wholeSent?: number[];
  /** Its newest stream transaction not read whole (past the budget, or no answer): when (`at`), and the ms after which
   *  its tape holds every trade again (`to`, the second after it arrived). */
  cut?: { at: number; to: number; why: CutWhy };
};
/** `born`: it read every successful signature back to the mint's first (card app-chart-check-inside-its-bound). */
type Back = { before: string | null; events: Swap[]; book: Book | null; done: boolean; born: boolean; txs: number; n: number; want: { tf: Tf; limit: number } };

export function createSolanaTrades(deps: {
  fetch?: Fetch;
  now?: () => number;
  /** Whether Discover's lists hold the token; null while the lists have no answer (a cold start), which is no "not
   *  listed": the tape answers 503, so the page reads again, never a 404 for a listed token (card app-console-429). */
  listed: (mint: string) => Promise<boolean | null>;
  rpcs?: readonly string[];
  /** The whole reads' providers (WHOLE_RPCS), a test's own. */
  wholeRpcs?: readonly string[];
  /** The waits before a whole read (WHOLE_READ_WAIT_MS) and before a null one is asked again (WHOLE_NULL_WAIT_MS), a
   *  test's own. */
  wholeWait?: (ms: number) => Promise<void>;
  wsUrl?: string;
  source?: (on: SourceEvents) => Source;
  /** The token's top pool's newest trades (token.ts tape: a JSON array of tape rows, newest first), served while this
   *  tape holds no row: a token whose venue is not decoded here. */
  tape?: (mint: string) => Promise<DataAnswer>;
  /** The pool the vendor names for the token's tape now (token.ts tapePool, held POOL_FRESH_MS), or null: a followed
   *  tape moves to a new top pool (card sol-vendor-tape-refresh-from-our-reads). */
  pool?: (mint: string) => Promise<string | null>;
  /** Bars before our first, GeckoTerminal's (token.ts candles), or none. */
  history?: (mint: string, tf: string, to: number | null, limit: number, client?: string) => Promise<DataAnswer>;
  /** A quote coin's USD price per whole coin as decimal text (its Discover or Jupiter row), or null. */
  quoteUsd?: (mint: string) => Promise<string | null>;
  /** One line per stream drop and return (the host's log), so a deploy's tape can be read back. */
  log?: (line: string) => void;
  tickMs?: number;
  /** The first answer's bound: resolves when a first read stops waiting for a round that holds a trade (default
   *  COLD_WAIT_MS on a timer; a test gives its own). */
  coldWait?: () => Promise<unknown>;
  /** When a first read with no row yet reads the vendor's tape (default VENDOR_EARLY_MS on a timer; a test gives its own). */
  vendorWait?: () => Promise<unknown>;
  /** The shared RPC budget (../../rpc/rpc.ts background, card helper-ready-gate): before each request to `url`, the
   *  seconds to wait (0: go); a provider with a wait is skipped for the next, so callers' reads keep their room.
   *  `client`: the page a pool round is read for, which waits on it (poolTape past SOL_VENDOR_REACH_MS), so the request
   *  draws that caller's share (rpc.ts caller), never the helper's background one (card
   *  sol-follow-round-draws-the-callers-share). */
  budget?: (url: string, method: string, client?: string) => number;
  /** That provider's 429, which holds its budget for every caller. */
  throttled?: (url: string, headers: Headers) => void;
  /** The slot of `rpcs[0]` when it is a keyed provider (SOLANA_TRADES_RPC_URL, rpc/slot.ts): while it is fallen back the
   *  requests start at the next provider; its 401, 403, a spent plan, a 429 past its reset or 30 s with no answer
   *  fall it back. */
  slot?: Slot;
  /** The stream's slot (SOLANA_STREAM_WS_URL): `wsUrl` falls back to STREAM_WS as wsSource says. */
  streamSlot?: Slot;
  /** The loop's turns (limits/turn.ts pass, the default): the stream's folds give the loop back between tokens. */
  pass?: () => Promise<void> | null;
}) {
  const now = deps.now ?? Date.now;
  const slice = deps.pass ?? pass;
  const doFetch = deps.fetch ?? fetch;
  const rpcs = deps.rpcs ?? TRADES_RPCS;
  const entries = new Map<string, Entry>();
  const pools = new Map<string, Promise<{ a: string; b: string } | null | "none">>();
  /** `<mint> <signature>` -> each of the transaction's rows' traders by its place (a row's index % 8, fold), the user its
   *  own event names (null for an event that names none), kept after the trade settles: a row is named by its own event,
   *  never by the transaction's first trade (card sol-tape-trader-is-the-events-user, as evm/swaps.ts traderAt). */
  const traders = new Map<string, (string | null)[]>();
  let seq = 0;
  // card helper-tape-handover-judges-handed-books: the tapes the last warm file held and how many of them this process
  // holds after its restore (handover(), named on /v1/health)
  let handedCount = { held: 0, restored: 0 };
  let solUsd: { slot: number; v: bigint } | null = null;
  let refAt = 0;
  let reportAt = now();
  /** Each other quote coin's decimals and USD price (USD per whole coin times 10^18), read once and every REF_MS. */
  const quotes = new Map<string, { decimals: number | null; usd: bigint | null; at: number; reading: Promise<void> | null }>();

  /** One request, to each provider in turn until one answers a result. `lane`: the whole reads' own providers
   *  (WHOLE_RPCS), outside the shared budget and the keyed slot; a provider's 429 holds only it (card
   *  meteora-whole-reads-second-provider), and a held one is not asked. */
  const slot = deps.slot !== undefined && deps.slot.state() !== "public" ? deps.slot : undefined;
  async function rpc(method: string, params: unknown[], lane?: Lane, client?: string, patient = false): Promise<unknown> {
    // card helper-fresh-tapes-whole-from-the-first-minute: a walk's read (`patient`) our own budget kept from every
    // provider (none sent to) waits the shortest hold it named and asks again, up to PACED_WAIT_MAX_MS in all: no
    // provider failed it. Before, it threw, and one such read of a cold walk's COLD_SIGS failed the whole walk, begun
    // again from its first page after a wait that doubled (live run 45032297159: two listed tapes still filling at
    // 45.9 s while the public endpoint's background budget was held 10 s at a time; trades-cold-paced.test.ts). Every
    // other read is answered at once, as before: a pool round behind held rows that waited would hold the round a page
    // joins (tape-from-our-reads.test.ts).
    for (let waited = 0; ; ) {
      let held = Number.POSITIVE_INFINITY;
      for (const url of lane?.urls ?? (slot !== undefined && !slot.useKeyed() ? rpcs.slice(1) : rpcs)) {
        if (lane?.held(url) === true) continue;
        const key = lane === undefined && slot !== undefined && url === rpcs[0] ? slot : undefined;
        const w = lane === undefined ? (deps.budget?.(url, method, client) ?? 0) : 0;
        if (w > 0) {
          held = Math.min(held, w);
          continue;
        }
        held = Number.NaN;
        const r = await rpcAt(url, key, method, params, lane);
        if (r !== NO_ANSWER) return r;
      }
      if (!(held < Number.POSITIVE_INFINITY) || !patient || client !== undefined || stopped || waited >= PACED_WAIT_MAX_MS) throw new Error(`${method}: no provider answered`);
      const ms = Math.min(held * 1_000, PACED_WAIT_MAX_MS - waited);
      await new Promise((go) => setTimeout(go, ms).unref?.());
      waited += ms;
    }
  }
  /** One request to `url`: its result, or NO_ANSWER for the next provider. */
  async function rpcAt(url: string, key: Slot | undefined, method: string, params: unknown[], lane?: Lane): Promise<unknown> {
    const sent = now();
    try {
      const r = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
      if (r.status === 429) lane === undefined ? deps.throttled?.(url, r.headers) : lane.throttled(url, Math.min(60, Math.max(1, Number(r.headers.get("retry-after")) || 10)));
      if (r.status !== 200 || Number(r.headers.get("content-length") ?? "0") > ANSWER_MAX) {
        const body = key !== undefined && r.status >= 400 && r.status < 500 ? await head(r) : (await r.body?.cancel(), "");
        if (key !== undefined) {
          if (r.status === 401 || r.status === 403) key.fail(String(r.status));
          else if (CREDITS.test(body)) key.fail("credits");
          else if (r.status === 429) key.throttled(Math.max(1, Number(r.headers.get("retry-after")) || 1));
          else if (r.status >= 500) key.unanswered(sent);
        }
        return NO_ANSWER;
      }
      const text = await r.text();
      if (text.length > ANSWER_MAX) return NO_ANSWER;
      const j = JSON.parse(text) as Record<string, unknown>;
      if (j.error === undefined && "result" in j) return (key?.ok(), j.result);
      if (key !== undefined && CREDITS.test(String((j.error as { message?: unknown } | undefined)?.message ?? ""))) key.fail("credits");
    } catch {
      key?.unanswered(sent); // the next provider
    }
    return NO_ANSWER;
  }

  /** A getTransaction answer's block time, unix seconds, or null. */
  const blockTime = (r: Record<string, unknown>): number | null => (Number.isSafeInteger(r.blockTime) && (r.blockTime as number) > 0 ? (r.blockTime as number) : null);

  /** Each confirmed slot's clock the stream sent (CLOCKS_MAX newest), the newest such slot, the stream trades waiting for
   *  a slot's, and each slot's block time read (card sol-tape-in-order). */
  const clocks = new Map<number, number>();
  let clockTo = -1;
  const clockWaits = new Map<number, { p: Promise<void>; end: () => void }>();
  const blockTimes = new Map<number, Promise<number | null>>();
  function onClock(slot: number, unixS: number): void {
    if (clocks.has(slot)) return;
    clocks.set(slot, unixS);
    if (clocks.size > CLOCKS_MAX) clocks.delete(clocks.keys().next().value!);
    clockTo = Math.max(clockTo, slot);
    // a slot's clock comes before any later slot's: a wait for this one or an earlier one is over
    for (const [s, w] of clockWaits) if (s <= slot) w.end();
  }
  /** A slot's block time, unix seconds: the stream's clock for it (waited for CLOCK_WAIT_MS while no later slot's came),
   *  else its getBlockTime, read once; null when neither answers. */
  async function timeOf(slot: number): Promise<number | null> {
    if (slot > clockTo && !clocks.has(slot)) {
      let w = clockWaits.get(slot);
      if (w === undefined) {
        let end!: () => void;
        const p = new Promise<void>((ok) => (end = ok));
        const timer = setTimeout(() => w!.end(), CLOCK_WAIT_MS);
        timer.unref?.();
        w = { p, end: () => (clearTimeout(timer), clockWaits.delete(slot), end()) };
        clockWaits.set(slot, w);
      }
      await w.p;
    }
    const held = clocks.get(slot);
    if (held !== undefined) return held;
    let read = blockTimes.get(slot);
    if (read === undefined) {
      read = rpc("getBlockTime", [slot]).then((v) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null), () => null);
      if (blockTimes.size >= CLOCKS_MAX) blockTimes.delete(blockTimes.keys().next().value!);
      blockTimes.set(slot, read);
      void read.then((v) => v === null && blockTimes.get(slot) === read && blockTimes.delete(slot));
    }
    return read;
  }
  /** The trades each dated by its block (`known`, the transaction's or its signature's block time, else the slot's:
   *  timeOf), an event's own clock included: card helper-sol-tape-checks-hold, the clock a pump.fun, PumpSwap, DBC or DAMM
   *  v2 event carries is a second before its block in some slots (slot 471386582: DAMM v2 and DBC events 1795102226,
   *  block time 1795102227 on api.mainnet-beta and publicnode; slot 471614249: a PumpSwap event 1795151265, the stream's
   *  Clock sysvar and getBlockTime 1795151266), so a tape dating those by their event and the rest by their block held a
   *  later row a second below an older one (live helper f5639e5bb, 20 Nov 03:15Z: "trade 31 is newer than trade 30").
   *  With no block time answering, an event's own clock stands (within a second of it); a trade with none makes the
   *  transaction unread (null), as a transaction `forMint` could not read (null) is. */
  async function dated(trades: RawTrade[] | null, slot: number, known: number | null): Promise<RawTrade[] | null> {
    if (trades === null || trades.length === 0) return trades;
    const t = known ?? (await timeOf(slot));
    if (t === null) return trades.every((x) => x.ts > 0) ? trades : null;
    return trades.map((x) => (x.ts === t ? x : { ...x, ts: t }));
  }

  /** `client`: the caller a pool round reads it for (round), whose share it draws. */
  async function account(key: string, client?: string): Promise<{ owner: unknown; data: Buffer; slot: number } | null> {
    const r = (await rpc("getAccountInfo", [key, { encoding: "base64", commitment: "confirmed" }], undefined, client)) as Record<string, unknown>;
    const v = r?.value as Record<string, unknown> | null;
    const slot = (r?.context as Record<string, unknown> | undefined)?.slot;
    if (v === null || v === undefined || !Array.isArray(v.data) || typeof v.data[0] !== "string" || !Number.isSafeInteger(slot)) return null;
    return { owner: v.owner, data: Buffer.from(v.data[0], "base64"), slot: slot as number };
  }

  async function readRef(client?: string): Promise<void> {
    refAt = now(); // one try every REF_MS, answered or not
    const a = await account(PYTH_SOL_USD, client);
    const v = a === null ? null : pythSolUsd(a.owner, a.data, Math.floor(now() / 1000));
    if (a === null || v === null) return;
    solUsd = { slot: a.slot, v };
    for (const e of entries.values()) if (e.quoteMint === null || e.quoteMint === WSOL) e.refs.set(a.slot, v);
  }

  /** A pool's two mints (PumpSwap: base, quote), read once (a burst of trades on one pool shares the read; a failed
   *  read is not kept), taken only with the trade's own venue program as the pool account's owner. "none": answered with
   *  no account, never kept either (card sol-tape-pool-unread-never-kept: a pool a venue's own event names exists, so a
   *  node answering none of it has not read it; kept, every later trade on the pool was dropped). */
  function poolOf(t: RawTrade): Promise<{ a: string; b: string } | null | "none"> {
    const k = `${t.venue}:${t.pool!}`;
    const kept = pools.get(k);
    if (kept !== undefined) return kept;
    const venue = t.venue;
    // Meteora DBC: the quote mint is the pool's config's (card index-sol-trades-2)
    const read: Promise<{ a: string; b: string } | null | "none"> = venue === "meteora-dbc" ? Promise.all([account(t.pool!), account(t.config!)]).then(([a, c]) => (a === null || c === null ? "none" : dbcPair(a, c, t.config!))) : account(t.pool!).then((a) => {
      if (a === null) return "none";
      if (venue === "pumpswap") {
        const p = a.owner === PUMP_AMM ? poolMints(a.data) : null;
        return p === null ? null : { a: p.base, b: p.quote };
      }
      return venue === "pump" ? null : poolPair(venue, a.owner, a.data);
    });
    if (pools.size >= POOLS_MAX) pools.delete(pools.keys().next().value!);
    pools.set(k, read);
    read.then((v) => v === "none" && pools.get(k) === read && pools.delete(k), () => pools.delete(k));
    return read;
  }

  /** Reads a quote coin's decimals (once, from its mint account) and its USD price; never throws. */
  function readQuote(q: string, client?: string): Promise<void> {
    let k = quotes.get(q);
    if (k === undefined) {
      if (quotes.size >= QUOTES_MAX) quotes.delete(quotes.keys().next().value!);
      k = { decimals: null, usd: null, at: 0, reading: null };
      quotes.set(q, k);
    }
    if (k.reading !== null) return k.reading;
    const kk = k;
    kk.at = now();
    kk.reading = (async () => {
      if (kk.decimals === null) {
        const a = await account(q, client);
        if (a !== null && TOKEN_PROGRAMS.includes(a.owner as string) && a.data.length >= 82 && a.data[45] === 1) kk.decimals = a.data[44]!;
      }
      const usd = usdScaled(await deps.quoteUsd!(q));
      if (usd !== null) {
        kk.usd = usd;
        const slot = solUsd?.slot;
        for (const e of entries.values()) if (e.quoteMint === q) e.refs.set(slot ?? Math.max(e.covered, 0), usd);
      }
    })()
      .catch(() => undefined)
      .finally(() => (kk.reading = null));
    return kk.reading;
  }
  /** A quote the book can price: SOL, USDC, or another coin with its decimals and a USD price read. */
  const priced = (q: string | null): boolean => q === WSOL || q === USDC || (q !== null && quotes.get(q)?.decimals != null && quotes.get(q)?.usd != null);

  /** The trades of one transaction for `mint`, with the token named and the quote checked; pools read. A pair venue's
   *  trade (told as the pool's first mint sees it) is turned round when the token is the second; an event with no clock
   *  keeps ts 0 (`dated` gives it its block's). Null: a pool answered with no account, so whether the transaction holds a
   *  trade of `mint` is unknown (unread: the stream's transaction a cut, a walk's whole reach above it). */
  async function forMint(mint: string, trades: RawTrade[]): Promise<RawTrade[] | null> {
    const out: RawTrade[] = [];
    for (const t of trades) {
      if (t.venue === "pump") {
        if (t.mint === mint) out.push(t);
        continue;
      }
      const p = t.pair ?? (await poolOf(t));
      if (p === "none") return null;
      if (p === null || p.a === p.b) continue;
      if (p.a === mint) out.push({ ...t, mint, quoteMint: p.b });
      // PumpSwap: the base mint only, as before
      else if (p.b === mint && t.venue !== "pumpswap") out.push({ ...t, mint, quoteMint: p.a, side: t.side === "b" ? "s" : "b", amt: t.quote, quote: t.amt });
    }
    // another quote coin: its decimals and price read before the trade is held, so the first tape is priced
    for (const q of new Set(out.map((t) => t.quoteMint))) if (q !== null && q !== WSOL && q !== USDC && deps.quoteUsd !== undefined && !priced(q)) await readQuote(q);
    return out;
  }

  /** Card sol-meteora-tape-inside-rpc-budget: the whole reads sent in the last second (every coin), the time before which
   *  each of their providers is held (its 429; card meteora-whole-reads-second-provider: each its own), and the minute's
   *  counts for the log. */
  const wholeSent: number[] = [];
  const wholeHeldTo = new Map<string, number>();
  const wholeCount = { sent: 0, over: 0, unread: 0 };
  const wholeWait = deps.wholeWait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const wholeLane: Lane = {
    urls: deps.wholeRpcs ?? WHOLE_RPCS,
    held: (url) => now() < (wholeHeldTo.get(url) ?? 0),
    throttled: (url, s) => void wholeHeldTo.set(url, now() + s * 1_000),
  };
  /** Whether a stream transaction of `e` may be read whole now: a provider not held, a place in the second's WHOLE_PER_S
   *  (every coin) and in the coin's WHOLE_COIN_MAX a WHOLE_WINDOW_MS, taken when there is one (null); else what it is
   *  past (CUT_WHY). */
  function wholeTake(e: Entry): CutWhy | null {
    const t = now();
    if (wholeLane.urls.every(wholeLane.held)) return "held";
    while (wholeSent.length > 0 && wholeSent[0]! <= t - 1_000) wholeSent.shift();
    const mine = (e.wholeSent ??= []);
    while (mine.length > 0 && mine[0]! <= t - WHOLE_WINDOW_MS) mine.shift();
    if (mine.length >= WHOLE_COIN_MAX) return "coin";
    if (wholeSent.length >= WHOLE_PER_S) return "all";
    // round 3: a busy coin leaves the second's last WHOLE_QUIET_ROOM places to the quiet ones
    if (mine.length >= WHOLE_QUIET_MAX && wholeSent.length >= WHOLE_PER_S - WHOLE_QUIET_ROOM) return "busy";
    wholeSent.push(t);
    mine.push(t);
    return null;
  }

  /** wholeTake, but a read past the busy share waits (wholeWait) for the second's oldest place to free and asks again, at
   *  most WHOLE_BUSY_WAIT_MS in all; a quiet coin and every other cause answer at once. */
  async function wholePlace(e: Entry): Promise<CutWhy | null> {
    let waited = 0;
    for (;;) {
      const why = wholeTake(e);
      if (why !== "busy") return why;
      const wait = wholeSent[0]! + 1_000 - now();
      if (waited + wait > WHOLE_BUSY_WAIT_MS) return why;
      waited += wait;
      await wholeWait(wait);
    }
  }

  /** A stream transaction's trades: from its log, or its inner instructions when the log was cut; each dated by its
   *  block (the stream sends no block time: the slot's clock, card sol-tape-in-order). */
  async function txTrades(mint: string, sig: string, slot: number, logs: unknown): Promise<RawTrade[] | null> {
    const f = fromLogs(logs);
    // a Meteora venue's events are in the inner instructions only (card index-sol-trades-2): read the transaction whole
    if (!f.truncated && !eventsInInner(logs)) return dated(await forMint(mint, f.trades), slot, null);
    // card sol-meteora-tape-inside-rpc-budget: only inside the whole reads' budget, on their own providers; past it, or
    // unanswered, the log's own trades are held and the coin's tape names its reach from this transaction (cut)
    if (!f.truncated) {
      const e = entries.get(mint);
      const past = e === undefined ? "all" : await wholePlace(e);
      const ok = e !== undefined && past === null;
      const whole = async () => (wholeCount.sent++, (await rpc("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }], wholeLane).catch(() => null)) as Record<string, unknown> | null);
      let w = ok ? (await wholeWait(WHOLE_READ_WAIT_MS), await whole()) : null;
      let why: CutWhy = past ?? "unanswered";
      // round 3: a read before publicnode holds the transaction answers null; asked once more WHOLE_NULL_WAIT_MS on, in a
      // place of its own (a 429 holds the lane, so its second ask is cut as held)
      if (ok && (w === null || w === undefined)) {
        await wholeWait(WHOLE_NULL_WAIT_MS);
        const again = await wholePlace(e!);
        if (again === null) w = await whole();
        else why = again;
      }
      if (w === null || w === undefined) {
        wholeCount[why === "unanswered" ? "unread" : "over"]++;
        if (e !== undefined) e.cut = { at: now(), to: Math.max(e.cut?.to ?? 0, (Math.floor(now() / 1_000) + 1) * 1_000), why };
        return dated(await forMint(mint, f.trades), slot, null);
      }
      return dated(await forMint(mint, cutTrades(f, w)), slot, blockTime(w));
    }
    const r = (await rpc("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }])) as Record<string, unknown> | null;
    if (r === null) return null;
    return dated(await forMint(mint, cutTrades(f, r)), slot, blockTime(r));
  }

  /** Holds a transaction's trades, its place `order` (taken when it arrived, before any read it waited on). */
  function hold(e: Entry, sig: string, slot: number, order: number, trades: RawTrade[]): void {
    if (e.held.has(sig) || (e.book !== null && slot <= e.book.settledTo)) return;
    if (e.held.size >= HELD_MAX) return;
    e.held.set(sig, { slot, seq: order, t: trades });
    if (trades.length > 0) e.traded++;
    if (e.book === null) {
      const q = (trades.find((t) => t.quoteMint === WSOL || t.quoteMint === USDC) ?? trades.find((t) => priced(t.quoteMint)))?.quoteMint;
      if (q !== undefined && q !== null) {
        e.quoteMint = q;
        if (q === WSOL || q === USDC) e.book = createBook({ decimals: e.decimals, quote: q === WSOL ? { kind: "eth", decimals: 9 } : { kind: "usd", decimals: 6 } });
        else {
          // another quote coin is the book's native coin: its trades are priced at that coin's USD price in force
          const k = quotes.get(q)!;
          e.book = createBook({ decimals: e.decimals, quote: { kind: "eth", decimals: k.decimals! } });
          e.refs.clear();
          e.refs.set(0, k.usd!);
        }
      } else if (e.quoteMint === null) e.quoteMint = trades.find((t) => t.quoteMint !== null)?.quoteMint ?? null;
    }
  }

  // the folds asked by the stream's notes and the tick, at most one a token, run a turn's slice at a time (limits/turn.ts
  // pass); a read of a book folds it first (folded), so an answer never misses a note held (card
  // helper-loop-never-held-by-a-read: a busy coin's transaction reads answered together, and each note's own fold of
  // every held trade ran in that one turn, 226 to 759 ms a turn in a copy's profile under the page checks)
  const unfolded = new Set<Entry>();
  let folding = false;
  function foldSoon(e: Entry): void {
    unfolded.add(e);
    if (folding) return;
    folding = true;
    setImmediate(() => void foldAll());
  }
  async function foldAll(): Promise<void> {
    try {
      for (const e of unfolded) {
        if (unfolded.has(e)) fold(e);
        const w = slice();
        if (w !== null) await w;
      }
    } finally {
      folding = false;
    }
  }
  const folded = (e: Entry): Entry => {
    if (unfolded.has(e)) fold(e);
    return e;
  };

  /** Refolds the entry's held events into its book, settling those SETTLE_SLOTS behind its coverage. */
  function fold(e: Entry): void {
    unfolded.delete(e);
    // a token with no priced trade yet has an empty tape that is as current as the stream: its read time moves on too,
    // or a quiet token's answers stay dated by its open
    if (e.book === null) {
      e.readAt = now();
      return;
    }
    const from = e.book.settledTo + 1;
    const events: Event[] = [];
    // the ref in force before the first held slot, then each ref read since
    for (const [slot, v] of e.refs) if (slot >= from) events.push({ kind: "ref", block: slot, index: -1, ethUsd: v });
    let i = 0;
    for (const [sig, h] of e.held) {
      // each row's trader, its own event's user (an event that names no trader, Orca's, leaves the row's null)
      const users: (string | null)[] = [];
      for (const t of h.t) {
        if (t.quoteMint !== e.quoteMint) continue;
        const at = Math.min(i++ % 8, 7);
        users[at] ??= t.user === "" ? null : t.user;
        // a venue program's own swap (decode.ts placed) is in the bars and off the tape (candles.ts Swap.tape)
        const s: Swap = { kind: "swap", block: h.slot, index: h.seq * 8 + at, tx: sig, t: t.ts, side: t.side, amt: t.amt, quote: t.quote, ...(t.tape === false ? { tape: false as const } : {}) };
        events.push(s);
      }
      i = 0;
      const k = `${e.mint} ${sig}`;
      if (users.some((u) => u != null)) {
        if (!traders.has(k) && traders.size >= HELD_MAX) traders.delete(traders.keys().next().value!);
        traders.set(k, users);
      }
    }
    events.sort((a, b) => a.block - b.block || a.index - b.index);
    // a ref with no trade before the next ref is superseded: dropped, so a quiet token's refs stay one
    for (let k = events.length - 2; k >= 0; k--) {
      if (events[k]!.kind === "ref" && events[k + 1]!.kind === "ref") {
        e.refs.delete(events[k]!.block);
        events.splice(k, 1);
      }
    }
    // strictly increasing (block, index): a transaction with more than 8 trades of the token keeps its first 8
    const ordered = events.filter((ev, k) => k === 0 || ev.block !== events[k - 1]!.block || ev.index !== events[k - 1]!.index);
    const reading = Math.min(Infinity, ...e.inflight.values()) - 1;
    const settle = e.state === "live" ? Math.max(e.book.settledTo, Math.min(e.covered - SETTLE_SLOTS, reading)) : e.book.settledTo;
    try {
      e.book.ingest(from, ordered, settle); // every held trade is after the settled point (hold refuses the rest)
    } catch {
      return; // never: the book keeps what it holds, and the next fold tries again
    }
    // what is settled lives in the book now (a settled ref is the book's price in force)
    for (const [sig, h] of e.held) if (h.slot <= e.book.settledTo) e.held.delete(sig);
    for (const slot of e.refs.keys()) if (slot <= e.book.settledTo) e.refs.delete(slot);
    e.readAt = now();
    e.onFold?.();
    if (e.rowWaits !== undefined && e.book.tape(1).length > 0) for (const go of e.rowWaits) go();
  }

  /** Walks `mint`'s signatures newer than `until` (the newest COLD_SIGS successful ones when null) and holds each
   *  transaction's trades, each in its place in the list. The reads go newest first, TX_PARALLEL at a time, and the tape
   *  is folded after each round (`round`), so a first read serves the newest trades after one round, not after the whole
   *  walk (card token-page-data-complete-and-fast: 30 reads at 5 a time held a cold tape 3.8 to 7.9 s on public
   *  endpoints). */
  async function walk(e: Entry, until: string | null, round?: () => void, clientOf?: () => string | undefined): Promise<void> {
    const sigs: { signature: string; slot: number; err: unknown; t: number | null }[] = [];
    const ok = (s: { err: unknown }): boolean => s.err === null || s.err === undefined;
    let before: string | undefined;
    const cold = until === null;
    // whether the list ran out (the mint's first signature, or a gap's start, reached), and the newest second below which
    // a trade may be missing (whole)
    let listedAll = false;
    const gap: { t: number | null } = { t: null };
    const below = (t: number | null): void => void (gap.t = Math.max(gap.t ?? 0, t ?? Math.floor(now() / 1000)));
    /** One transaction read and its trades held in its place (`order`). */
    const readOne = async (s: { signature: string; slot: number; t: number | null; order: number }): Promise<void> => {
      const r = (await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }], undefined, clientOf?.(), true)) as Record<string, unknown> | null;
      if (r === null) return below(s.t);
      e.seen++;
      const meta = (r.meta ?? {}) as Record<string, unknown>;
      const f = fromLogs(meta.logMessages);
      // dated by its block: the transaction's block time, its signature's, else its slot's (never the walk's clock)
      const got = await dated(await forMint(e.mint, f.truncated || eventsInInner(meta.logMessages) ? cutTrades(f, r) : f.trades), s.slot, blockTime(r) ?? s.t);
      if (got === null) return below(s.t);
      hold(e, s.signature, s.slot, s.order, got);
    };
    /** Reads `list` (oldest first) newest first, TX_PARALLEL at a time, the tape folded after each round. */
    const readAll = async (list: readonly { signature: string; slot: number; t: number | null; order: number }[]): Promise<void> => {
      for (let k = list.length; k > 0; k -= TX_PARALLEL) {
        await Promise.all(list.slice(Math.max(0, k - TX_PARALLEL), k).map(readOne));
        if (round !== undefined) {
          fold(e);
          round();
        }
      }
    };
    // card solana-flooded-coin-first-answer-holds-rows: a first page of a flooded coin with some successful signatures
    // has them read at once, while the COLD_PAGE before them is listed, not after it (helper update 22's live run
    // 45011614034: 5o7AFuoN...pump, 1 of its newest 30 successful, answered 0 rows at its bound: the COLD_PAGE of 1000
    // signatures, 235 KB, read 1,599 ms from the Mac on api.mainnet-beta, stood before its one successful read); a first
    // page with none has a SHORT_PAGE listed beside the COLD_PAGE, from the same signature, and its successful ones read as
    // soon as it lands (live run 43689567273: CjRGc8wH...pump, 0 of its newest 30 successful, 29 of its newest 1000).
    // Each place is the list's: a signature's order is its position from the newest (`at`), counted down from `reserve`.
    let early: { sigs: Set<string>; listed: Promise<void>; read: Promise<void> } | null = null;
    let reserve = -1;
    const TOP = COLD_SIGS + COLD_PAGE + 1;
    const placeOf = new Map<string, number>();
    const at = (p: number): number => reserve + TOP - p;
    while (cold ? sigs.filter(ok).length < COLD_SIGS : sigs.length < REFILL_MAX) {
      // a first read's newest COLD_SIGS, then once, when they were not all successful, one COLD_PAGE before them: a
      // bot-flooded token's newest signatures are failed transactions, and a first read of them alone held no trade
      // (card solana-tape-rows-at-first-answer: live run 43689567273 read CjRGc8wH...pump 0 rows at +0 ms)
      const limit = cold ? (before === undefined ? COLD_SIGS : COLD_PAGE) : Math.min(SIG_PAGE, REFILL_MAX - sigs.length);
      const page = (await rpc("getSignaturesForAddress", [e.mint, { limit, commitment: "confirmed", ...(until !== null ? { until } : {}), ...(before !== undefined ? { before } : {}) }], undefined, clientOf?.(), true)) as unknown;
      if (!Array.isArray(page)) throw new Error("signatures");
      for (const s of page as Record<string, unknown>[]) {
        if (typeof s?.signature === "string" && Number.isSafeInteger(s.slot)) sigs.push({ signature: s.signature, slot: s.slot as number, err: s.err, t: Number.isSafeInteger(s.blockTime) && (s.blockTime as number) > 0 ? (s.blockTime as number) : null });
      }
      if (page.length < limit) listedAll = true;
      if (page.length < limit || sigs.length === 0 || (cold && before !== undefined)) break;
      before = sigs[sigs.length - 1]!.signature;
      // only a first page with another to come (not all of its newest COLD_SIGS successful) reads ahead of it
      if (cold && early === null && sigs.filter(ok).length < COLD_SIGS) {
        reserve = seq;
        seq += TOP + 1;
        sigs.forEach((x, i) => placeOf.set(x.signature, i));
        const first = sigs.filter((x) => ok(x) && !e.held.has(x.signature));
        const set = new Set(first.map((x) => x.signature));
        let read: Promise<void>;
        let listed: Promise<void> = Promise.resolve();
        if (first.length > 0) read = readAll(first.map((x) => ({ ...x, order: at(placeOf.get(x.signature)!) })).reverse());
        else {
          // the short page beside the COLD_PAGE (asked next, from the same `before`): its positions are the COLD_PAGE's
          const top = sigs.length;
          const mine = (rpc("getSignaturesForAddress", [e.mint, { limit: SHORT_PAGE, commitment: "confirmed", before }], undefined, clientOf?.(), true) as Promise<unknown>).then((short) =>
            !Array.isArray(short)
              ? []
              : (short as Record<string, unknown>[])
                  .map((x, j) => ({ x, j }))
                  .filter(({ x }) => typeof x?.signature === "string" && Number.isSafeInteger(x.slot) && (x.err === null || x.err === undefined) && !e.held.has(x.signature as string))
                  .slice(0, COLD_SIGS)
                  .map(({ x, j }) => ({ signature: x.signature as string, slot: x.slot as number, t: Number.isSafeInteger(x.blockTime) && (x.blockTime as number) > 0 ? (x.blockTime as number) : null, order: at(top + j) })),
          );
          // the short page is a head start only: its listing failing leaves the COLD_PAGE's walk as it was
          listed = mine.then((m) => void m.forEach((x) => set.add(x.signature)), () => undefined);
          read = mine.then((m) => readAll(m.slice().reverse()), () => undefined);
        }
        early = { sigs: set, listed, read };
        early.read.catch(() => undefined);
      }
    }
    // the short page's signatures known before the list's places are taken (its reads go on)
    if (early !== null) await early.listed;
    if (reserve >= 0) sigs.forEach((x, i) => placeOf.set(x.signature, i));
    sigs.reverse();
    // each transaction's place is the list's (oldest first), taken before the reads, which go TX_PARALLEL at a time; a
    // first read keeps the newest COLD_SIGS successful (those read early among them)
    const fresh = (x: { signature: string; err: unknown }): boolean => ok(x) && (early?.sigs.has(x.signature) === true || !e.held.has(x.signature));
    const todo = sigs
      .filter(fresh)
      .slice(cold ? -COLD_SIGS : 0)
      .map((s) => ({ ...s, order: reserve >= 0 ? at(placeOf.get(s.signature)!) : ++seq }));
    // a first walk that listed the mint's every signature and reads each successful one not held: the tape from its birth
    const everyOne = cold && listedAll && todo.length === sigs.filter(fresh).length;
    // the read back starts before the oldest the first walk reads (its older page's signatures not read included)
    if (cold) e.oldest = todo[0]?.signature ?? sigs[0]?.signature ?? null;
    // those read early first (the newest): never more than TX_PARALLEL reads at once, as before; a failed read fails the
    // walk, as any read does
    if (early !== null) await early.read;
    await readAll(early === null ? todo : todo.filter((x) => !early!.sigs.has(x.signature)));
    for (const s of sigs) e.covered = Math.max(e.covered, s.slot);
    // the reach (Entry.whole): a first walk's oldest read, 0 when it read every successful signature the mint has; a gap's
    // walk that stopped at REFILL_MAX leaves the signatures below its oldest unread
    // a transaction left unread, or a gap's walk stopped short: a hole no read back below the oldest fills (Entry.holed)
    if (gap.t !== null || (!cold && !listedAll && sigs.length > 0)) e.holed = true;
    if (cold) {
      if (!everyOne) below(todo[0]?.t ?? sigs[0]?.t ?? null);
    } else if (!listedAll && sigs.length > 0) below(sigs[0]!.t);
    if (gap.t !== null || cold) e.whole = Math.max(e.whole ?? 0, gap.t === null ? 0 : gap.t * 1_000 + 1_000);
    // a walk runs while the stream's trades already arrive: the newest signature held is then the stream's
    if (sigs.length > 0 && e.lastSig === until) e.lastSig = sigs[sigs.length - 1]!.signature;
  }

  /** The gap's walk after a drop, one at a time per token, again every 2 s until it is read. */
  function refill(e: Entry): void {
    if (e.refilling !== null) return;
    e.refilling = walk(e, e.gapFrom)
      .then(() => {
        e.state = "live";
        e.gapFrom = null;
        fold(e);
      })
      .catch(() => void setTimeout(() => entries.get(e.mint) === e && e.state === "refilling" && refill(e), 2_000).unref?.())
      .finally(() => (e.refilling = null));
  }

  async function onNote(e: Entry, n: Note): Promise<void> {
    // the stream's trades are held at once in every state: during a walk (cold or a gap's) the walk's are older, and
    // nothing settles until it is done
    e.lastSig = n.sig;
    if (n.err) {
      e.covered = Math.max(e.covered, n.slot);
      return;
    }
    const order = ++seq;
    e.seen++;
    // nothing settles at or after a transaction still being read (a PumpSwap pool, a cut log)
    e.inflight.set(n.sig, n.slot);
    const trades = await txTrades(e.mint, n.sig, n.slot, n.logs).catch(() => null);
    e.inflight.delete(n.sig);
    if (trades !== null) hold(e, n.sig, n.slot, order, trades);
    // card helper-sol-tape-checks-hold: a transaction not read on (its pool, its whole body or its block's time
    // unanswered) is a cut as one past the whole reads' budget is: the tape's reach starts after it, never every trade
    // (a local helper at f1a80d8bf on mainnet, 20 Nov 05:49Z: pumpCmXq's tape named whole_ms 1795153718000 and lacked
    // its DLMM trade at 1795153746, its pool's read held with every provider)
    else e.cut = { at: now(), to: Math.max(e.cut?.to ?? 0, (Math.floor(now() / 1_000) + 1) * 1_000), why: "unanswered" };
    e.covered = Math.max(e.covered, n.slot);
    foldSoon(e);
  }

  const source = (deps.source ?? ((on) => wsSource(deps.wsUrl ?? STREAM_WS, on, deps.wsUrl !== undefined && deps.streamSlot !== undefined ? { fallback: { url: STREAM_WS, slot: deps.streamSlot } } : {})))({
    note(mint, n) {
      const e = entries.get(mint);
      if (e !== undefined) void onNote(e, n).catch(() => undefined);
    },
    down() {
      deps.log?.(`solana stream: down, ${entries.size} tokens to walk again`);
      // a cold walk's gap is walked again from its newest held; a second drop keeps the first gap's start
      for (const e of entries.values()) {
        if (e.state !== "refilling") e.gapFrom = e.lastSig;
        e.state = "refilling";
      }
    },
    up() {
      deps.log?.(`solana stream: up, ${entries.size} tokens`);
      for (const e of entries.values()) if (e.state === "refilling") refill(e);
    },
    clock: onClock,
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  /** Set by stop(): a cold walk failing is not walked again. */
  let stopped = false;
  function tick(): void {
    const t = now();
    if (t - refAt >= REF_MS) void readRef().catch(() => undefined);
    if (deps.quoteUsd !== undefined) {
      const open = new Set([...entries.values()].map((e) => e.quoteMint).filter((q): q is string => q !== null && q !== WSOL && q !== USDC));
      for (const q of open) if (t - (quotes.get(q)?.at ?? 0) >= REF_MS) void readQuote(q);
    }
    if (t - reportAt >= REPORT_MS) {
      reportAt = t;
      const empty = [...entries.values()].filter((e) => e.book === null || e.book.tape(1).length === 0);
      const unpriced = empty.filter((e) => e.quoteMint !== null && !priced(e.quoteMint)).length;
      const unread = empty.filter((e) => e.quoteMint === null && e.seen > 0 && e.traded === 0).length;
      if (empty.length > 0) deps.log?.(`solana tape: ${entries.size} tokens open, ${empty.length} empty: quote with no price ${unpriced}, no trade of a venue read ${unread}, quiet ${empty.length - unpriced - unread}`);
      // card sol-meteora-tape-inside-rpc-budget: the minute's whole reads, so their budget can be read back
      if (wholeCount.sent + wholeCount.over > 0) deps.log?.(`solana whole reads: ${wholeCount.sent} sent, ${wholeCount.unread} unanswered, ${wholeCount.over} past the budget (${WHOLE_PER_S} a second, ${WHOLE_COIN_MAX} a coin in ${WHOLE_WINDOW_MS / 1_000} s)`);
      wholeCount.sent = wholeCount.over = wholeCount.unread = 0;
      // card sol-vendor-tape-refresh-from-our-reads: the minute's rounds of vendor-named pools, read back on the host
      if (followCount.rounds > 0) deps.log?.(`solana pool tapes: ${follows.size} held, ${followCount.rounds} rounds, ${followCount.calls} calls, ${followCount.failed} failed`);
      followCount.rounds = followCount.calls = followCount.failed = 0;
    }
    for (const e of entries.values()) {
      if (t - e.touched > IDLE_MS) {
        entries.delete(e.mint);
        source.unwatch(e.mint);
        // a tape whose walk still reads (its first, cold, or a gap's after a drop) is folded too while the stream is heard:
        // the stream holds each of its trades as they land, so its newest rows are current and dated so, its older ones
        // `filling` (card helper-sol-tape-checks-hold: a quiet coin whose walk waited on a slow read answered rows dated
        // by its last round, past 15 s); with the stream silent or down, a tape keeps the date of its last fold. Each
        // fold runs a turn's slice at a time (foldSoon, card helper-loop-never-held-by-a-read)
      } else if (e.state === "live" || heardNow()) foldSoon(e);
    }
    if (entries.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  const err = (status: number, code: string): DataAnswer => ({ status, body: JSON.stringify({ error: { code } }) });
  const NOT_FOUND = err(404, "not_found");
  const UPSTREAM = err(503, "upstream");
  /** Whether a token's tape is behind the chain (SOL_BEHIND_MS): its dropped stream's gap still walked, or the stream
   *  silent past the bound or not connected. Its tape is then no complete list and its live chart not current. */
  const behind = (e: Entry): boolean => e.state === "refilling" || !heardNow();
  /** Whether the stream is connected and heard within SOL_BEHIND_MS (a source without `heard`, a test's, is live). */
  function heardNow(): boolean {
    if (source.heard === undefined) return true;
    const h = source.heard();
    return h !== null && now() - h.at <= SOL_BEHIND_MS;
  }
  /** The slot a token is held to with no gap and the stream's newest slot, for the answer's Server-Timing. */
  const readTo = (e: Entry): string => {
    const h = source.heard?.() ?? null;
    const ago = h === null ? "never" : `${Math.max(0, Math.round((now() - h.at) / 1_000))} s ago`;
    // the first read's phases, on the answers of its first OPEN_NAMED_MS (the reads that waited on it)
    const opened = e.open !== undefined && now() - e.open.at <= OPEN_NAMED_MS ? `, sol-open;desc="${e.open.desc}"` : "";
    return `sol-read-to;desc="slot ${e.covered} of head ${h?.slot ?? "none"}, heard ${ago}${e.state === "live" ? "" : `, ${e.state}`}"${opened}`;
  };

  /** Each mint's tape the vendor has not answered (poolTape): since when, and its last such read; a read more than
   *  IDLE_MS after the last starts a new wait. At most WAITING_MAX, oldest out first. */
  const waiting = new Map<string, { since: number; last: number }>();
  /** The token's top pool's newest `limit` trades (deps.tape), src theirs, dated by their read. Refused or down, the
   *  empty tape with `filling`, so the page reads again, for VENDOR_WAIT_MS at most; then, and at once for a vendor that
   *  names no pool (404), the token's own empty tape (filling only while its walk reads), or for a token with no open
   *  walk (`e` null) the vendor's refusal, and a mint no pool names is the 404 it was. A good answer that names its pool
   *  starts that pool's follow (seed), which renews the rows from our own reads (poolTape). */
  async function vendorTape(mint: string, limit: number, e: Entry | null): Promise<DataAnswer> {
    const early = e !== null && e.early !== undefined && now() - e.early.at <= COLD_WAIT_MS ? e.early.p : undefined;
    const v = await (early ?? deps.tape!(mint).catch(() => null));
    if (v === null || v.status !== 200) {
      // card solana-dropped-tape-settles: a tape waits for the vendor VENDOR_WAIT_MS at most, filling, then answers what
      // it holds: helper 178, live run 43989230034, Cat (CoqwPnZ3...u61w) answered filling for 45.8 s, its one pool made
      // a minute before (00:50:56Z) and so named by no vendor (404), as every answer not 200 was filling for good
      const t = now();
      const w = waiting.get(mint);
      const since = w !== undefined && t - w.last <= IDLE_MS ? w.since : t;
      waiting.delete(mint);
      waiting.set(mint, { since, last: t });
      if (waiting.size > WAITING_MAX) waiting.delete(waiting.keys().next().value!);
      // a vendor that names no pool (404) has nothing to come: no wait
      if (v?.status === 404 || t - since >= VENDOR_WAIT_MS) {
        waiting.delete(mint);
        if (e === null) return v?.status === 404 ? NOT_FOUND : (v ?? UPSTREAM);
        // the token's own walk: empty, filling only while it still reads its newest signatures, never claimed whole
        const at = e.readAt ?? t;
        const fill = e.state === "cold" ? { filling: true } : {};
        return { status: 200, body: JSON.stringify({ trades: [], ...fill, src: "chain", as_of_ms: at }), src: "chain", asOfMs: at };
      }
    } else waiting.delete(mint);
    if (v !== null && v.status === 200) {
      const all = JSON.parse(v.body) as unknown[];
      const src = v.src ?? "geckoterminal";
      const at = v.asOfMs ?? now();
      seed(mint, v.pool, all, src, at);
      return rowsAnswer(all, src, at, limit);
    }
    const at = e?.readAt ?? now();
    return { status: 200, body: JSON.stringify({ trades: [], filling: true, src: "chain", as_of_ms: at }), src: "chain", asOfMs: at };
  }
  /** A pool's newest trades (newest first), read at `at`, as the trades answer: the newest `limit`, every one after the
   *  oldest (card token-stats-count-every-trade) claimed complete only while that read is within SOL_VENDOR_REACH_MS,
   *  its age always named (card vendor-tapes-name-their-reach-every-chain), the vendor's rows and ours alike. Past the
   *  reach the tape says filling, as this chain's own tape says it behind its stream (token.ts SOL_BEHIND_MS): card
   *  sol-vendor-tape-gap-served-inside-reach, live run 44938731300 served BONK's rows 33,606 and 54,172 ms old with no
   *  word of it, the refresh past the reach refused or not landed within TAPE_OPEN_BOUND_MS, and the page drew them as
   *  live (apps/terminal screens/token/trades.ts marks a tape only by `filling`). */
  function rowsAnswer(all: unknown[], src: string, at: number, limit: number, holed = false): DataAnswer {
    const age = Math.max(0, now() - at);
    const oldest = (all.at(-1) as { t_ms?: unknown } | undefined)?.t_ms;
    const whole = typeof oldest === "number" && Number.isSafeInteger(oldest) && age <= SOL_VENDOR_REACH_MS && !holed ? { whole_ms: oldest + 1_000 } : {};
    const behind = age > SOL_VENDOR_REACH_MS ? { filling: true } : {};
    const timing = `sol-vendor-read;desc="rows read ${age} ms ago"`;
    return { status: 200, body: JSON.stringify({ trades: all.slice(0, limit), ...behind, ...whole, src, as_of_ms: at }), src, asOfMs: at, timing };
  }

  // Card sol-vendor-tape-refresh-from-our-reads: the vendor names a coin's pool once (its first answer); while a page
  // holds the tape it is renewed from our own reads of that pool, on this file's RPC lane (the keyed provider first, the
  // callers' budget before each request, rpc), never the vendor's again. Each read of rows FOLLOW_MS old starts one
  // round: the pool's signatures since the newest read (getSignaturesForAddress until it), each new successful
  // transaction (getTransaction, FOLLOW_TX_MAX at most), and a row from its pool vaults' balance changes (poolLeg), any
  // venue. Before it a held tape's refresh was the vendor's, a call each TAPE_FRESH_MS per held coin (8,640 a day for one
  // page held) against CoinGecko's 3,225-call day: the helper's background share was spent at about 10:2xZ on 19 Nov
  // and every refresh since refused (keyless window full), JUP's rows served 39.8 s old (live job 135508383528). A
  // round that fails refreshes from the vendor, as before; a pool whose transactions show no trade we can read
  // (`unplaced`) stays the vendor's, its age named.
  const follows = new Map<string, Follow>();
  const followCount = { rounds: 0, calls: 0, failed: 0 };
  /** Starts (or renews from the vendor) `mint`'s follow of `pool` from the vendor's rows read at `at`. */
  function seed(mint: string, pool: string | undefined, all: unknown[], src: string, at: number): void {
    if (pool === undefined || address(pool) === null) return;
    const f = follows.get(mint);
    if (f !== undefined && f.pool === pool && (f.reading !== null || f.at >= at)) return;
    const rows = all.slice(0, TRADES_MAX) as TapeRow[];
    const lastSig = typeof rows[0]?.tx === "string" && SIG_TEXT.test(rows[0].tx) ? rows[0].tx : null;
    if (f !== undefined && f.pool === pool) return void Object.assign(f, { rows, src, at, lastSig, hole: null, above: 0 });
    follows.delete(mint);
    follows.set(mint, { pool, rows, src, at, lastSig, data: null, placed: false, misses: 0, unplaced: false, reading: null, retryAt: 0, touched: now(), hole: null, above: 0 });
    if (follows.size > FOLLOWS_MAX) follows.delete(follows.keys().next().value!);
  }
  /** A quote coin's USD price per whole coin times 10^18, or null: USDC one dollar, SOL Pyth's (readRef), another coin
   *  its own row (readQuote), each read again past REF_MS. */
  async function usdOf(q: string, client?: string): Promise<bigint | null> {
    if (q === USDC) return 10n ** 18n;
    if (q === WSOL) {
      if (solUsd === null || now() - refAt >= REF_MS) await readRef(client).catch(() => undefined);
      return solUsd?.v ?? null;
    }
    if (deps.quoteUsd === undefined) return null;
    if (!priced(q) || now() - (quotes.get(q)?.at ?? 0) >= REF_MS) await readQuote(q, client);
    return quotes.get(q)?.usd ?? null;
  }
  type Sig = { signature: string; err?: unknown; blockTime?: unknown };
  /** One page of `pool`'s signatures (`opts`: until, before) and its newest FOLLOW_TX_MAX successful transactions read:
   *  `cut` when signatures below the page's covered part are unread (a full page, or more successful than read), and
   *  `bottom` the oldest signature it covered. */
  async function page(f: Follow, opts: Record<string, string>, call: (m: string, p: unknown[]) => Promise<unknown>) {
    const got = await call("getSignaturesForAddress", [f.pool, { limit: FOLLOW_SIGS, commitment: "confirmed", ...opts }]);
    if (!Array.isArray(got)) throw new Error("signatures");
    const sigs = (got as Record<string, unknown>[]).slice(0, FOLLOW_SIGS).filter((x) => typeof x?.signature === "string" && SIG_TEXT.test(x.signature) && Number.isSafeInteger(x.slot)) as Sig[];
    const good = sigs.filter((x) => x.err === null || x.err === undefined);
    const todo = good.slice(0, FOLLOW_TX_MAX);
    const cut = got.length >= FOLLOW_SIGS || good.length > todo.length;
    const bottom = (good.length > todo.length ? todo.at(-1) : sigs.at(-1))?.signature ?? null;
    const read: { s: Sig; r: unknown }[] = [];
    for (let k = 0; k < todo.length; k += TX_PARALLEL) {
      read.push(...(await Promise.all(todo.slice(k, k + TX_PARALLEL).map(async (x) => ({ s: x, r: await call("getTransaction", [x.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]) })))));
    }
    return { sigs, cut, bottom, read };
  }
  /** The tape rows of transactions read (newest first), and how many showed a trade; throws for a trade with no price. */
  async function rowsOf(mint: string, f: Follow, read: { s: Sig; r: unknown }[], client?: string): Promise<{ rows: TapeRow[]; legs: number }> {
    const rows: TapeRow[] = [];
    let legs = 0;
    for (const { s: x, r } of read) {
      const leg = poolLeg(r, mint, f.data!);
      if (leg === null) continue;
      legs++;
      // the round's caller draws its price reads too (card sol-follow-round-draws-the-callers-share)
      const p = await usdOf(leg.quoteMint, client);
      if (p === null) throw new Error("quote unpriced");
      const usd = (leg.quote * p) / 10n ** BigInt(leg.quoteDecimals);
      if (usd > 0n) rows.push({ t_ms: leg.ts * 1_000, side: leg.side, usd: fixed(usd, VALUE_SCALE), amt: fixed(leg.amt, leg.decimals), trader: leg.trader, tx: x.signature });
    }
    return { rows, legs };
  }
  /** Rows above a hole that fill the tape alone: the hole and what is below it go, the tape whole again. */
  function capped(f: Follow): void {
    if (f.hole !== null && f.above >= TRADES_MAX) f.hole = null;
    if (f.hole === null) f.above = 0;
    f.rows = f.rows.slice(0, TRADES_MAX);
  }
  /** One round of `f`'s pool: the pool the vendor names now (deps.pool, its own freshness: a new top pool is followed
   *  from its newest trades), its account once, then a page of a hole a round before left (signatures before its
   *  `before` and after its `until`, the rows put in their place), then its signatures since the newest read, each new
   *  successful transaction, and the rows they hold put on top. Throws when a read fails or a trade has no price.
   *  `client`: the page that waits on this round (its rows past SOL_VENDOR_REACH_MS), whose share its requests draw. */
  async function round(mint: string, f: Follow, client?: string): Promise<void> {
    const started = now();
    followCount.rounds++;
    const call = (method: string, params: unknown[]) => (followCount.calls++, rpc(method, params, undefined, client));
    const named = deps.pool === undefined ? null : await deps.pool(mint).catch(() => null);
    if (named != null && address(named) !== null && named !== f.pool) Object.assign(f, { pool: named, data: null, rows: [], lastSig: null, hole: null, above: 0, placed: false, misses: 0 });
    if (f.data === null) {
      const a = (await call("getAccountInfo", [f.pool, { encoding: "base64", commitment: "confirmed" }])) as Record<string, unknown> | null;
      const v = a?.value as Record<string, unknown> | null | undefined;
      const data = v == null || !Array.isArray(v.data) || typeof v.data[0] !== "string" ? null : Buffer.from(v.data[0], "base64");
      if (data === null || data.length === 0 || data.length > POOL_DATA_MAX) return void (f.unplaced = true);
      f.data = data;
    }
    // the hole a cut round left, one page a round, while its rows still reach the tape
    if (f.hole !== null) {
      const h = f.hole;
      const g = await page(f, { before: h.before, until: h.until }, call);
      // a transaction not served yet: the hole stays as it is for the next round
      if (g.read.every((x) => x.r != null) && f.hole === h) {
        const { rows } = await rowsOf(mint, f, g.read, client);
        f.rows = [...f.rows.slice(0, f.above), ...rows, ...f.rows.slice(f.above)];
        f.above += rows.length;
        f.hole = g.cut && g.bottom !== null ? { before: g.bottom, until: h.until } : null;
        capped(f);
      }
    }
    const top = await page(f, f.lastSig === null ? {} : { until: f.lastSig }, call);
    // a transaction the provider does not serve yet (listed a moment before, by another of its nodes): the round reaches
    // only to the signature below the oldest such one, dated by that one's block, and the next round lists it again
    let newest = top.sigs[0]?.signature ?? f.lastSig;
    let at = started;
    let kept = top.read;
    const lost = top.read.findLastIndex((x) => x.r == null);
    if (lost >= 0) {
      const x = top.read[lost]!.s;
      const below = top.sigs[top.sigs.indexOf(x) + 1];
      if (below === undefined) throw new Error("transaction unread");
      kept = top.read.slice(lost + 1);
      newest = below.signature;
      at = Number.isSafeInteger(x.blockTime) ? Math.max(f.at, Math.min(started, (x.blockTime as number) * 1_000)) : f.at;
    }
    const { rows, legs } = await rowsOf(mint, f, kept, client);
    // a pool none of whose first few transactions shows a trade we can read is not ours to follow
    if (legs > 0) f.placed = true;
    else if (!f.placed && (f.misses += kept.length) >= 3) return void (f.unplaced = true);
    const fresh = new Set(rows.map((r) => r.tx));
    const held = f.rows.filter((r) => !fresh.has(r.tx));
    if (f.lastSig === null) {
      // nothing held to reach: the newest read are the tape, every trade after the oldest of them read
      f.rows = rows;
      f.hole = null;
    } else if (!top.cut || top.bottom === null) {
      f.rows = [...rows, ...held];
      if (f.hole !== null) f.above += rows.length;
    } else {
      // cut short: the rows held below an older hole go (one hole at a time); the new hole is from this page's oldest
      // covered signature to the newest held
      f.rows = [...rows, ...(f.hole === null ? held : held.slice(0, f.above))];
      f.hole = { before: top.bottom, until: f.lastSig };
      f.above = rows.length;
    }
    capped(f);
    f.lastSig = newest;
    f.at = at;
    if (!f.src.startsWith("chain,")) f.src = `chain,${f.src}`;
  }
  /** A failed round: the vendor's rows when they are newer than what is held (its age named, as before), the next round
   *  FOLLOW_RETRY_MS later. */
  async function fromVendor(mint: string, f: Follow): Promise<void> {
    followCount.failed++;
    f.retryAt = now() + FOLLOW_RETRY_MS;
    const v = await deps.tape!(mint).catch(() => null);
    if (v === null || v.status !== 200 || (v.asOfMs ?? 0) <= f.at) return;
    const all = (JSON.parse(v.body) as TapeRow[]).slice(0, TRADES_MAX);
    Object.assign(f, { rows: all, src: v.src ?? "geckoterminal", at: v.asOfMs!, lastSig: typeof all[0]?.tx === "string" && SIG_TEXT.test(all[0].tx) ? all[0].tx : f.lastSig, hole: null, above: 0 });
  }
  /** The tape of a pool the vendor names: its follow's rows, renewed by a round once FOLLOW_MS old, a caller past
   *  SOL_VENDOR_REACH_MS waiting for that round within TAPE_OPEN_BOUND_MS (card sol-vendor-tape-waits-past-reach);
   *  with no follow (none started, idle past IDLE_MS) or an unplaced one, the vendor's (vendorTape). */
  async function poolTape(mint: string, limit: number, e: Entry | null, client?: string): Promise<DataAnswer> {
    // one bound for the whole answer: the vendor's wait and the round's together (card helper-tapes-refresh-holds-live:
    // the round's own TAPE_OPEN_BOUND_MS after the vendor's page wait answered a page past its 15 s)
    const until = now() + TAPE_OPEN_BOUND_MS;
    let f = follows.get(mint);
    if (f !== undefined && now() - f.touched > IDLE_MS) {
      follows.delete(mint);
      f = undefined;
    }
    let read: DataAnswer | undefined;
    if (f === undefined || f.unplaced) {
      const v = (read = await vendorTape(mint, limit, e));
      const g = follows.get(mint);
      if (g !== undefined) g.touched = now();
      if (g === undefined || g.unplaced || now() - g.at < FOLLOW_MS) return v;
      f = g;
    }
    f.touched = now();
    // card sol-follow-round-draws-the-callers-share: a round this caller waits on (rows past the reach) is its read, in
    // the callers' share; one behind rows inside the reach is the helper's background read. Live run 45011614034 served
    // WIF's rows 23,973 ms old at once: the waited round drew the background share, full under the run's reads, and
    // failed with nothing sent
    const waits = now() - f.at > SOL_VENDOR_REACH_MS;
    if (now() - f.at >= FOLLOW_MS && f.reading === null && now() >= f.retryAt) {
      const g = f;
      g.reading = round(mint, g, waits ? client : undefined)
        .catch(() => fromVendor(mint, g))
        .catch(() => undefined)
        .finally(() => (g.reading = null));
    }
    if (waits && f.reading !== null) await within(f.reading, Math.max(0, until - now()));
    // a pool the round found no trade of is the vendor's: the answer this call read already, else the vendor's now
    if (f.unplaced) return read ?? vendorTape(mint, limit, e);
    return rowsAnswer(f.rows, f.src, f.at, limit, f.hole !== null);
  }

  /** A first read: the token's decimals, its subscription in force, then its newest COLD_SIGS signatures walked. */
  async function first(mint: string, client?: string): Promise<Entry | DataAnswer> {
    const began = now();
    // card helper-fresh-tapes-whole-from-the-first-minute: the reads the first answer waits on (the mint's account, the
    // SOL price, the cold walk until the answer) are the opening page's, drawn on its share, as a pool round a page waits
    // on is (card sol-follow-round-draws-the-callers-share); past the answer the walk is the helper's background read.
    // Drawn on the background share, a fresh helper's first answers under a held budget had no row (live run
    // 45050809291, helper-26: v4GK8f24 "listed 0, account unread" at 3191 ms; 7R4MP6VX "answer by bound after 0
    // rounds" at 2536 ms; the public endpoint's background held 169 times in its log)
    let waiter = client;
    const clientOf = (): string | undefined => waiter;
    const marks: string[] = [];
    const mark = (name: string): void => void marks.push(`${name} ${Math.round(now() - began)}`);
    // card helper-stays-fast-under-the-live-run: the first answer's bound runs from the read's start and nothing it
    // waits on holds the answer past it, the subscription included: live run 44979250087 (helper-20, the bound run from
    // the subscription, 106c0a2f4) answered a flooded coin's first tape at 5.5 s and 12 joined tapes at 3.9 s
    const bound = deps.coldWait?.() ?? new Promise<void>((r) => setTimeout(r, COLD_WAIT_MS).unref?.());
    const early = deps.vendorWait?.() ?? new Promise<void>((r) => setTimeout(r, VENDOR_EARLY_MS).unref?.());
    // a read that fails names its phases too, so a 503's wait is read as a slow answer's is; one past the lists (the coin
    // listed) is named FIRST_FAILED, which the tape answers filling, never as a 503
    const failed = (why: string, listed = true): DataAnswer => (mark(why), { ...UPSTREAM, ...(listed ? { why: FIRST_FAILED } : {}), timing: `sol-open;desc="${marks.join(", ")}"` });
    const listed = await deps.listed(mint);
    mark("listed");
    if (listed === null) return failed("lists unread", false);
    if (!listed) return NOT_FOUND;
    if (entries.size >= OPEN_MAX) return { ...err(429, "rate_limited"), retryAfterS: 5, why: "solana trades open" };
    let decimals: number;
    try {
      const a = await account(mint, client);
      if (a === null || !TOKEN_PROGRAMS.includes(a.owner as string) || a.data.length < 82 || a.data[45] !== 1) return NOT_FOUND;
      decimals = a.data[44]!;
      mark("account");
      if (solUsd === null) (await readRef(client), mark("price"));
    } catch {
      return failed("account unread");
    }
    const e: Entry = { mint, decimals, quoteMint: null, book: null, held: new Map(), refs: new Map(), lastSig: null, covered: 0, state: "cold", gapFrom: null, refilling: null, inflight: new Map(), touched: now(), readAt: null, seen: 0, traded: 0 };
    if (solUsd !== null) e.refs.set(0, solUsd.v); // the price in force for the cold read's trades
    entries.set(mint, e);
    // the vendor's tape read once the read is VENDOR_EARLY_MS in with no row of ours, so the answer at the bound has it
    void early.then(() => {
      if (deps.tape === undefined || e.open !== undefined || entries.get(mint) !== e || (e.book !== null && e.book.tape(1).length > 0)) return;
      e.early = { p: deps.tape(mint).catch(() => null), at: now() };
    });
    let firstRound: () => void = () => undefined;
    const rounded = new Promise<void>((ok) => (firstRound = ok));
    // the first answer is the first round that holds a trade: a busy token's newest transactions may hold none of a venue
    // read (failed bot buys, other venues), and its first round answered an empty tape (card
    // helper-live-run-green-after-122: ni hao cat's first reads, 0 rows at +0 and +2.4 s, 18 rows a second later)
    let rounds = 0;
    const traded = (): void => {
      if (e.book !== null && e.book.tape(1).length > 0) firstRound();
    };
    // card helper-stays-fast-under-the-live-run: a trade the stream sends answers the first read too, once folded: a
    // busy coin's stream holds trades within a second while its walk's first round waits on its reads (the live helper at
    // f28b6bd56, 21 Nov 21:04Z: three cold trending coins' tapes answered at 2.5, 3.1 and 3.6 s, past the burst check's
    // 3 s p99 with the way to it), and the tape answered then is our own rows, filling while the walk reads older ones
    e.onFold = traded;
    // the walk starts only once the stream sends this mint's trades, so nothing falls between them; a stream that drops
    // before the subscription is in force is waited again (it reconnects and subscribes every mint it watches), WATCH_TRIES
    // asks inside TIMEOUT_MS, never a failed read for every caller joined on it (app-console-429 on helper-20)
    let timedOut = false;
    const timeout = new Promise<never>((_, no) => setTimeout(() => ((timedOut = true), no(new Error("subscribe timeout"))), TIMEOUT_MS).unref?.());
    timeout.catch(() => undefined);
    const watched = (async (): Promise<string | null> => {
      for (let k = 1; ; k++) {
        try {
          await Promise.race([source.watch(mint), timeout]);
          return null;
        } catch (x) {
          const why = timedOut ? "subscribe timeout" : String((x as Error)?.message ?? x);
          if (timedOut || k >= WATCH_TRIES || stopped || entries.get(mint) !== e) return why;
          // a turn before the next ask: a source that refuses at once is asked again after the loop's other work
          await new Promise<void>((r) => setImmediate(r));
        }
      }
    })();
    // a walk that fails is walked again while the token is open, after a wait that doubles to COLD_RETRY_MAX_MS: the
    // tape stays cold (filling) until its newest COLD_SIGS are read, never settled short on a read that failed (card
    // robinhood-trades-finish-filling: three fails ended the walk and the tape said done with what the stream had sent)
    const cold = watched.then(async (why): Promise<"walk" | "failed"> => {
      if (why !== null) {
        if (entries.get(mint) === e) {
          entries.delete(mint);
          source.unwatch(mint);
        }
        mark(`watch failed: ${why}`);
        return "failed";
      }
      mark("watch");
      // the tape is served from the moment the stream holds the token; the walk's older trades join as they are read
      e.readAt ??= now();
      for (let attempt = 0; !stopped && entries.get(mint) === e; attempt++) {
        try {
          await walk(e, null, () => (rounds++, traded()), clientOf);
          if (e.state === "cold") e.state = "live";
          break;
        } catch {
          await new Promise((r) => setTimeout(r, Math.min(1_000 * 2 ** attempt, COLD_RETRY_MAX_MS)).unref?.());
        }
      }
      fold(e);
      // the walk is done: a read waiting on its first row answers now with what it holds
      for (const go of e.rowWaits ?? []) go();
      return "walk";
    });
    // the first answer waits for the walk's first round that holds a trade (its newest trades), a streamed trade, the
    // whole walk, or the bound, COLD_WAIT_MS from the read's start: at the bound the tape is served cold (filling) with
    // what it holds, the subscription still asked if it is not yet in force
    const by = await Promise.race([cold, rounded.then(() => "trade" as const), bound.then(() => "bound" as const)]);
    waiter = undefined;
    e.onFold = undefined;
    if (by === "failed") return { ...UPSTREAM, why: FIRST_FAILED, timing: `sol-open;desc="${marks.join(", ")}"` };
    if (by !== "bound") e.early = undefined;
    e.readAt ??= now();
    mark(`answer by ${by} after ${rounds} round${rounds === 1 ? "" : "s"}`);
    e.open = { at: now(), desc: marks.join(", ") };
    return e;
  }

  /** The quote a book of `q` is priced in, and its USD price in force (none for USDC), or null while it has none. */
  function quoteCfg(q: string): { quote: { kind: "usd" | "eth"; decimals: number }; ref: bigint | null } | null {
    if (q === WSOL) return solUsd === null ? null : { quote: { kind: "eth", decimals: 9 }, ref: solUsd.v };
    if (q === USDC) return { quote: { kind: "usd", decimals: 6 }, ref: null };
    const k = quotes.get(q);
    return k?.decimals == null || k.usd == null ? null : { quote: { kind: "eth", decimals: k.decimals }, ref: k.usd };
  }
  /** The read back's trades folded into a book of their own, priced at the quote's price in force now: the price of
   *  the walk's own first trades, the one a past price is not read for. */
  function backBook(e: Entry, b: Back): void {
    const cfg = e.quoteMint === null ? null : quoteCfg(e.quoteMint);
    if (cfg === null || b.events.length === 0) return;
    const sorted = b.events.slice().sort((x, y) => x.block - y.block || x.index - y.index);
    const swaps = sorted.filter((ev, k) => k === 0 || ev.block !== sorted[k - 1]!.block || ev.index !== sorted[k - 1]!.index);
    const events: Event[] = cfg.ref === null ? swaps : [{ kind: "ref", block: swaps[0]!.block, index: -1, ethUsd: cfg.ref }, ...swaps];
    const book = createBook({ decimals: e.decimals, quote: cfg.quote });
    book.ingest(events[0]!.block, events, events.at(-1)!.block);
    b.book = book;
  }
  /** One read back (BACK_SPAN_S): pages of COLD_PAGE signatures before the oldest read, each successful one's
   *  transaction read TX_PARALLEL at a time and its trades held, the book built after each page; a page that fails is
   *  asked again a second on, three times at most. */
  /** The read backs' lanes: BACK_PARALLEL steps at once, a free lane handed to the step that asked first. */
  let lanes = 0;
  const laneWaits: (() => void)[] = [];
  async function backLane<T>(step: () => Promise<T>): Promise<T> {
    if (lanes < BACK_PARALLEL) lanes++;
    else await new Promise<void>((go) => laneWaits.push(go));
    try {
      return await step();
    } finally {
      const next = laneWaits.shift();
      if (next !== undefined) next();
      else lanes--;
    }
  }
  async function readBack(e: Entry): Promise<void> {
    const b = e.back!;
    const floor = Math.floor(now() / 1000) - BACK_SPAN_S;
    const ok = (x: { err: unknown }): boolean => x.err === null || x.err === undefined;
    let fails = 0;
    while (entries.get(e.mint) === e && !b.done) {
      let page: unknown;
      try {
        page = await backLane(() => rpc("getSignaturesForAddress", [e.mint, { limit: COLD_PAGE, commitment: "confirmed", ...(b.before === null ? {} : { before: b.before }) }]));
      } catch {
        if (++fails >= 3) return;
        await new Promise((r) => setTimeout(r, 1_000).unref?.());
        continue;
      }
      if (!Array.isArray(page)) return;
      const sigs = (page as Record<string, unknown>[])
        .filter((x) => typeof x?.signature === "string" && Number.isSafeInteger(x.slot))
        .map((x) => ({ signature: x.signature as string, slot: x.slot as number, err: x.err, t: Number.isSafeInteger(x.blockTime) && (x.blockTime as number) > 0 ? (x.blockTime as number) : null }));
      if (sigs.length > 0) b.before = sigs.at(-1)!.signature;
      const todo = sigs.filter(ok).map((x) => ({ ...x, n: ++b.n }));
      // a transaction not read (every provider held or failing) is asked again a second on, three times; still unread,
      // the read back ends at the newest one, its older trades dropped, so the bars read back have no hole in them
      const one = async (x: (typeof todo)[number]): Promise<boolean> => {
        const r = (await rpc("getTransaction", [x.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]).catch(() => null)) as Record<string, unknown> | null;
        if (r === null) return false;
        const f = fromLogs(((r.meta ?? {}) as Record<string, unknown>).logMessages);
        const got = await dated(await forMint(e.mint, f.truncated || eventsInInner(((r.meta ?? {}) as Record<string, unknown>).logMessages) ? cutTrades(f, r) : f.trades), x.slot, blockTime(r) ?? x.t);
        if (got === null) return false;
        let i = 0;
        for (const t of got) {
          if (t.quoteMint !== e.quoteMint) continue;
          b.events.push({ kind: "swap", block: x.slot, index: BACK_INDEX - x.n * 8 + Math.min(i++, 7), tx: x.signature, t: t.ts, side: t.side, amt: t.amt, quote: t.quote });
        }
        return true;
      };
      let hole: number | null = null;
      for (let k = 0; k < todo.length && b.txs < BACK_TX_MAX && entries.get(e.mint) === e && hole === null; k += TX_PARALLEL) {
        let chunk = todo.slice(k, Math.min(k + TX_PARALLEL, k + BACK_TX_MAX - b.txs));
        b.txs += chunk.length;
        for (let attempt = 0; chunk.length > 0; attempt++) {
          const read = await backLane(() => Promise.all(chunk.map(one)));
          chunk = chunk.filter((_, j) => !read[j]);
          if (chunk.length === 0) break;
          if (attempt === 2) {
            hole = Math.min(...chunk.map((x) => x.n));
            break;
          }
          await new Promise((r) => setTimeout(r, 1_000).unref?.());
        }
      }
      if (hole !== null) {
        const n = hole;
        b.events = b.events.filter((ev) => Math.ceil((BACK_INDEX - ev.index) / 8) < n);
        b.done = true;
      }
      backBook(e, b);
      const oldestT = sigs.at(-1)?.t ?? null;
      const enough = b.book !== null && b.book.candles(b.want.tf, null, b.want.limit).length >= b.want.limit;
      // the list ran out with every transaction on it read: back to the mint's first signature (Back.born)
      if (sigs.length < COLD_PAGE && hole === null && b.txs < BACK_TX_MAX) b.born = true;
      if (sigs.length < COLD_PAGE || b.txs >= BACK_TX_MAX || (oldestT !== null && oldestT < floor) || enough) b.done = true;
    }
  }
  let backs = 0;
  const backQueue: Entry[] = [];
  /** Starts the queued read backs, every one asked (at most OPEN_MAX, one per open token), their steps in turn on the
   *  BACK_PARALLEL lanes (backLane). */
  function startBacks(): void {
    while (backs < OPEN_MAX && backQueue.length > 0) {
      const e = backQueue.shift()!;
      if (entries.get(e.mint) !== e || e.back === undefined) continue;
      backs++;
      void readBack(e)
        .catch(() => undefined)
        .finally(() => {
          e.back!.done = true;
          backs--;
          startBacks();
        });
    }
  }
  /** Asks `e`'s read back once (a read back done is not asked again while the token stays open); the widest chart asked
   *  for sets when it has read enough. */
  function wantBack(e: Entry, tf: Tf, limit: number): void {
    if (e.back !== undefined) {
      if (!e.back.done && TF_SECONDS[tf] * limit > TF_SECONDS[e.back.want.tf] * e.back.want.limit) e.back.want = { tf, limit };
      return;
    }
    if (e.oldest === undefined || e.book === null || e.quoteMint === null) return;
    e.back = { before: e.oldest, events: [], book: null, done: e.oldest === null, born: false, txs: 0, n: 0, want: { tf, limit } };
    if (e.back.done) return;
    if (backQueue.length < OPEN_MAX) backQueue.push(e);
    else e.back.done = true;
    startBacks();
  }
  /** Resolves once `e` holds a row of ours, its first walk ends, or `ms` pass. */
  function rowOrBound(e: Entry, ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((done) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const go = (): void => {
        clearTimeout(timer);
        e.rowWaits?.delete(go);
        done();
      };
      (e.rowWaits ??= new Set()).add(go);
      timer = setTimeout(go, ms);
      timer.unref?.();
    });
  }
  /** Whether `e`'s read back is still reading. */
  const backing = (e: Entry): boolean => e.back !== undefined && !e.back.done;

  const opening = new Map<string, Promise<Entry | DataAnswer>>();
  /** Each listed coin whose first read failed: when it may be opened again, and how many have failed in a row (at most
   *  OPEN_MAX kept, the oldest dropped). */
  const failedOpens = new Map<string, { until: number; n: number; desc: string; answer?: { a: Promise<DataAnswer>; limit: number } }>();
  async function open(mint: string, client?: string): Promise<Entry | DataAnswer> {
    // card helper-stays-fast-under-the-live-run: a coin whose first read failed waits FAILED_OPEN_MS, doubling, before
    // it is read again; the reads in between are answered as the failed one was, with no read of their own
    const held = opening.has(mint) || entries.has(mint) ? undefined : failedOpens.get(mint);
    if (held !== undefined && now() < held.until) return { ...UPSTREAM, why: FIRST_FAILED, timing: `sol-open;desc="${held.desc}, read again in ${Math.ceil(held.until - now())} ms"` };
    // a first read in flight is joined before the entry is looked at: first() holds the entry from its mint read on, but
    // it serves only once the stream holds the token (readAt), so a caller that came in between would read it as down
    // (card app-console-429: 4 of 25 reads at once answered 503 on the deployed helper, 11:19Z)
    let e = opening.has(mint) ? undefined : entries.get(mint);
    if (e === undefined) {
      let p = opening.get(mint);
      if (p === undefined) {
        p = first(mint, client)
          .then((got) => {
            if ("mint" in got) failedOpens.delete(mint);
            else if (got.why === FIRST_FAILED) {
              const n = (failedOpens.get(mint)?.n ?? 0) + 1;
              failedOpens.delete(mint);
              if (failedOpens.size >= OPEN_MAX) failedOpens.delete(failedOpens.keys().next().value!);
              failedOpens.set(mint, { until: now() + Math.min(FAILED_OPEN_MS * 2 ** (n - 1), COLD_RETRY_MAX_MS), n, desc: /desc="([^"]*)"/.exec(got.timing ?? "")?.[1] ?? "failed" });
            }
            return got;
          })
          .finally(() => opening.delete(mint));
        opening.set(mint, p);
      }
      const got = await p;
      if (!("mint" in got)) return got;
      e = got;
    }
    e.touched = now();
    if (timer === null && deps.tickMs !== 0) {
      timer = setInterval(tick, deps.tickMs ?? 1_000);
      timer.unref?.();
    }
    // a token held is served as held, dated by its last fold (readAt, the answer's as_of_ms and X-Fetched-At), however
    // long the stream or its walk is down, never a 503: the page prints a failed load for every non-2xx answer (card
    // helper-live-bars-no-503); 503 is for a token with nothing held
    if (e.readAt === null) return UPSTREAM;
    return e;
  }

  /** A handed over tape (state's `tapes` entry) as a new Entry, every part checked as hostile input: its mint an
   *  address, read within TAPE_HANDOVER_AGE_MS and not ahead of now, its quote the one its quote mint is priced in, its
   *  book and done read back whole (Book.load), each held trade a venue's with legs above zero, after the settled slot.
   *  Null when any part is off. */
  function handedTape(x: unknown, t: number): [string, Entry, number] | null {
    if (!Array.isArray(x) || x.length !== 2 || address(x[0]) !== x[0] || typeof x[1] !== "object" || x[1] === null) return null;
    const mint = x[0] as string;
    const v = x[1] as Record<string, unknown>;
    const int = (n: unknown, min = 0): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= min;
    const big = (n: unknown): bigint | null => (typeof n === "string" && /^[0-9]{1,100}$/.test(n) && BigInt(n) > 0n ? BigInt(n) : null);
    const at = (n: unknown, max: number): n is number => typeof n === "number" && Number.isFinite(n) && n <= t && t - n <= max;
    if (!int(v.decimals) || (v.decimals as number) > 77 || typeof v.quoteMint !== "string" || address(v.quoteMint) !== v.quoteMint || !at(v.readAt, TAPE_HANDOVER_AGE_MS) || !at(v.touched, Number.MAX_SAFE_INTEGER)) return null;
    if (typeof v.from !== "string" || !SIG_RE.test(v.from) || !int(v.covered)) return null;
    const q = v.quote as { kind?: unknown; decimals?: unknown } | null;
    if (typeof q !== "object" || q === null || !int(q.decimals) || (q.decimals as number) > 77) return null;
    const qm = v.quoteMint;
    if (qm === WSOL ? q.kind !== "eth" || q.decimals !== 9 : qm === USDC ? q.kind !== "usd" || q.decimals !== 6 : q.kind !== "eth") return null;
    const quote = { kind: q.kind as "usd" | "eth", decimals: q.decimals as number };
    const book = createBook({ decimals: v.decimals as number, quote });
    if (!book.load(v.book)) return null;
    if (!Array.isArray(v.held) || v.held.length > HELD_MAX || !Array.isArray(v.refs) || v.refs.length > HELD_MAX) return null;
    const held = new Map<string, Held>();
    let seqMax = 0;
    for (const h of v.held as unknown[]) {
      if (!Array.isArray(h) || h.length !== 4 || typeof h[0] !== "string" || !SIG_RE.test(h[0]) || held.has(h[0]) || !int(h[1]) || (h[1] as number) <= book.settledTo || !int(h[2], 1) || !Array.isArray(h[3]) || h[3].length > 64) return null;
      const trades: RawTrade[] = [];
      for (const r of h[3] as unknown[]) {
        if (!Array.isArray(r) || r.length !== 8 || !VENUES_READ.includes(r[0]) || (r[1] !== "b" && r[1] !== "s") || (r[4] !== null && address(r[4]) !== r[4]) || typeof r[5] !== "string" || (r[5] !== "" && address(r[5]) !== r[5]) || !int(r[6]) || (r[7] !== 0 && r[7] !== 1)) return null;
        const [amt, qt] = [big(r[2]), big(r[3])];
        if (amt === null || qt === null) return null;
        trades.push({ venue: r[0], mint, pool: null, side: r[1], amt, quote: qt, quoteMint: r[4], user: r[5], ts: r[6], ...(r[7] === 0 ? { tape: false as const } : {}) });
      }
      held.set(h[0], { slot: h[1] as number, seq: h[2] as number, t: trades });
      seqMax = Math.max(seqMax, h[2] as number);
    }
    const refs = new Map<number, bigint>();
    for (const r of v.refs as unknown[]) {
      const u = Array.isArray(r) && r.length === 2 && int(r[0]) && !refs.has(r[0]) ? big(r[1]) : null;
      if (u === null) return null;
      refs.set((r as [number, string])[0], u);
    }
    if (v.whole !== undefined && !(typeof v.whole === "number" && Number.isFinite(v.whole) && v.whole >= 0)) return null;
    if ((v.holed !== undefined && v.holed !== true) || (v.oldest !== undefined && v.oldest !== null && (typeof v.oldest !== "string" || !SIG_RE.test(v.oldest)))) return null;
    let back: Back | undefined;
    if (v.back !== undefined) {
      const b = v.back as { book?: unknown; born?: unknown } | null;
      if (typeof b !== "object" || b === null || typeof b.born !== "boolean") return null;
      let bb: Book | null = null;
      if (b.book !== null) {
        bb = createBook({ decimals: v.decimals as number, quote });
        if (!bb.load(b.book)) return null;
      }
      back = { before: null, events: [], book: bb, done: true, born: b.born, txs: 0, n: 0, want: { tf: "1d", limit: 1 } };
    }
    // a restored tape is one whose stream dropped at the handover: behind (filling) until its gap from `from` is walked
    const e: Entry = { mint, handed: true, decimals: v.decimals as number, quoteMint: qm, book, held, refs, lastSig: v.from, covered: v.covered as number, state: "refilling", gapFrom: v.from, refilling: null, inflight: new Map(), touched: v.touched as number, readAt: v.readAt as number, seen: 0, traded: 0, ...(v.whole === undefined ? {} : { whole: v.whole as number }), ...(v.holed === true ? { holed: true as const } : {}), ...(v.oldest === undefined ? {} : { oldest: v.oldest as string | null }), ...(back === undefined ? {} : { back }) };
    return [mint, e, seqMax];
  }

  return {
    tick,
    /** Each live tape for the next process (../warm.ts; card helper-tape-handover): its book whole, its unsettled trades
     *  and refs, the signature its tape is held to, its done read back, and its rows' traders, the most recently asked
     *  first, within TAPES_HANDOVER_MAX bytes. A tape still on its first walk (cold) or with no priced trade is not
     *  handed over: it opens cold, as before. */
    state(): { tapes: [string, HandedTape][]; traders: [string, (string | null)[]][] } {
      const t = now();
      let room = TAPES_HANDOVER_MAX;
      const tapes: [string, HandedTape][] = [];
      const tr: [string, (string | null)[]][] = [];
      for (const e of [...entries.values()].sort((a, b) => b.touched - a.touched)) {
        const from = e.gapFrom ?? e.lastSig;
        if (e.state === "cold" || e.book === null || e.quoteMint === null || from === null || e.readAt === null || t - e.readAt > TAPE_HANDOVER_AGE_MS) continue;
        const cfg = quoteCfg(e.quoteMint);
        const quote = e.quoteMint === WSOL ? { kind: "eth" as const, decimals: 9 } : e.quoteMint === USDC ? { kind: "usd" as const, decimals: 6 } : cfg === null ? null : cfg.quote;
        if (quote === null) continue;
        const held: [string, number, number, HeldRow[]][] = [...e.held].map(([sig, h]) => [sig, h.slot, h.seq, h.t.map((r): HeldRow => [r.venue, r.side, r.amt.toString(), r.quote.toString(), r.quoteMint, r.user, r.ts, r.tape === false ? 0 : 1])]);
        const back = e.back?.done === true ? { book: e.back.book?.state() ?? null, born: e.back.born } : undefined;
        const h: HandedTape = { decimals: e.decimals, quoteMint: e.quoteMint, quote, book: e.book.state(), held, refs: [...e.refs].map(([k, u]) => [k, u.toString()]), from, covered: e.covered, touched: Math.min(e.touched, t), readAt: e.readAt, ...(e.whole === undefined ? {} : { whole: e.whole }), ...(e.holed === true ? { holed: true as const } : {}), ...(e.oldest === undefined ? {} : { oldest: e.oldest }), ...(back === undefined ? {} : { back }) };
        const mine = e.book.tape(TRADES_MAX).concat(e.back?.book?.tape(TRADES_MAX) ?? []).flatMap((r): [string, (string | null)[]][] => {
          const u = traders.get(`${e.mint} ${r.tx}`);
          return u === undefined ? [] : [[`${e.mint} ${r.tx}`, u]];
        });
        const n = JSON.stringify([e.mint, h]).length + JSON.stringify(mine).length;
        if (n > room) continue;
        room -= n;
        tapes.push([e.mint, h]);
        for (const m of mine) if (!tr.some(([k]) => k === m[0])) tr.push(m);
      }
      return { tapes, traders: tr };
    },
    /** A previous process's tapes (state) into this one, hostile input checked whole: any tape or trader off and nothing
     *  is restored (false). A token this one already holds keeps its own. Each restored tape is watched on the stream and
     *  its gap walked from the signature it was held to, as after a dropped stream (refill); behind (filling) till then. */
    restore(st: unknown): boolean {
      // no part handed over counts nothing; a part that is no state, or `tapes` that is no list, held something and
      // restores nothing
      if (st === undefined) return false;
      const isState = typeof st === "object" && st !== null && !Array.isArray(st);
      handedCount = { held: !isState ? 1 : Array.isArray((st as Record<string, unknown>).tapes) ? ((st as Record<string, unknown>).tapes as unknown[]).length : (st as Record<string, unknown>).tapes === undefined ? 0 : 1, restored: 0 };
      if (!isState) return false;
      const o = st as Record<string, unknown>;
      if (!Array.isArray(o.tapes) || o.tapes.length > OPEN_MAX || !Array.isArray(o.traders) || o.traders.length > OPEN_MAX * TRADES_MAX * 2) return false;
      const t = now();
      const got: [string, Entry, number][] = [];
      for (const x of o.tapes as unknown[]) {
        const e = handedTape(x, t);
        if (e === null) return false;
        got.push(e);
      }
      const tr: [string, (string | null)[]][] = [];
      for (const x of o.traders as unknown[]) {
        if (!Array.isArray(x) || x.length !== 2 || typeof x[0] !== "string" || !Array.isArray(x[1]) || x[1].length > 8) return false;
        const [m, sig] = x[0].split(" ");
        if (address(m) !== m || sig === undefined || !SIG_RE.test(sig) || x[0] !== `${m} ${sig}` || !x[1].every((u: unknown) => u === null || address(u) === u)) return false;
        tr.push([x[0], x[1] as (string | null)[]]);
      }
      for (const [k, u] of tr) if (!traders.has(k)) {
        if (traders.size >= HELD_MAX) traders.delete(traders.keys().next().value!);
        traders.set(k, u);
      }
      // a tape this process already holds (its own open, or the same file's tape restored before) counts restored
      for (const [mint, e, s] of got) {
        if (entries.has(mint) || opening.has(mint)) handedCount.restored++;
        if (entries.has(mint) || opening.has(mint) || entries.size >= OPEN_MAX) continue;
        handedCount.restored++;
        seq = Math.max(seq, s);
        entries.set(mint, e);
        // watched first, so no trade falls between the stream and the gap's walk (as a first read's walk waits on it)
        void source.watch(mint).then(
          () => refill(e),
          () => {
            if (entries.get(mint) !== e) return;
            entries.delete(mint);
            source.unwatch(mint);
          },
        );
      }
      if (got.length > 0 && timer === null && deps.tickMs !== 0) {
        timer = setInterval(tick, deps.tickMs ?? 1_000);
        timer.unref?.();
      }
      return true;
    },
    /** Card helper-tape-handover-judges-handed-books: the tapes the last warm file held and how many this process holds
     *  after restoring it (0 and 0 with none read), counts only, for /v1/health. */
    handover(): { held: number; restored: number } {
      return { ...handedCount };
    },
    stop(): void {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      source.close();
    },
    /** The 4h change from our own bars of a token whose tape is open (candles.ts change4h); null otherwise, never an
     *  open of its own. */
    change4h(token: string): number | null {
      const mint = address(token);
      const e = mint === null ? undefined : entries.get(mint);
      return e === undefined || folded(e).book === null ? null : change4h(e.book!, Math.floor(now() / 1000));
    },
    /** 06b Candles for a listed Solana token: our own bars (1s included), and the history source's before our first. */
    async candles(token: string, tf: string, to: number | null, limit: number, client?: string): Promise<DataAnswer> {
      const mint = address(token);
      if (mint === null || !(TFS as readonly string[]).includes(tf) || !Number.isSafeInteger(limit) || limit < 1 || limit > CANDLES_MAX) return NOT_FOUND;
      // a mint the lists do not hold has no bars of ours: its candles are the history source's own answer, as before
      if (!entries.has(mint) && deps.history !== undefined && (await deps.listed(mint)) !== true) return deps.history(mint, tf, to, limit, client);
      const opening = open(mint);
      // card helper-listed-charts-own-reads round 3: a walk still opening (its first round waits up to COLD_WAIT_MS) and
      // the history's bars held answer now, filling, and the walk goes on; the page reads a filling chart again 2 s on
      // (warm live run of 16 Nov 00:33Z: Solana's listed charts p95 4,241 ms)
      const quick = <T,>(p: Promise<T>) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), HELD_WAIT_MS).unref?.())]);
      if (deps.history !== undefined && tf !== "1s" && (await quick(opening)) === null) {
        const h = await quick(deps.history(mint, tf, to, limit, client).catch(() => null));
        const hb = h?.status === 200 ? (JSON.parse(h.body) as { candles?: Candle[]; filling?: boolean }) : null;
        if (h != null && (hb?.candles?.length ?? 0) > 0) {
          opening.catch(() => undefined);
          const src = h.src ?? "geckoterminal";
          return { ...h, body: JSON.stringify({ tf, candles: hb!.candles!.slice(-limit), src, filling: true, as_of_ms: h.asOfMs ?? now() }), src };
        }
      }
      const e = await opening;
      // card helper-candles-never-refuse-a-listed-coin: a token whose walk cannot open (OPEN_MAX walks open, its 429; or
      // nothing held yet, 503) is served the history source's chart, held ahead for every listed coin off our venues
      // (token.ts ahead), as a token off the lists is, never a refusal while those bars answer
      if (!("mint" in e)) {
        if (deps.history === undefined) return e;
        const h = await deps.history(mint, tf, to, limit, client).catch(() => e);
        return h.status === 200 ? h : e;
      }
      const own: Candle[] = folded(e).book === null ? [] : e.book!.candles(tf as Tf, to, limit);
      const ownFrom = e.book === null ? null : e.book.ownFrom(tf as Tf);
      // our own reads: the read back's bars (wantBack) before the walk's, one bar where a bucket holds both
      const backBars = tf === "1s" || e.back?.book == null ? [] : e.back.book.candles(tf as Tf, to, limit);
      const mine = joinBars(backBars, own).slice(-limit);
      let bars = mine;
      let src = "chain";
      // the history before our first bar refused, failed or itself still filling: the answer says filling, so the page
      // reads it again while that read goes on, never a short chart drawn as the coin's whole (one rule with swaps.ts
      // candles, card helper-listed-charts-own-reads)
      let short = false;
      // card app-chart-check-inside-its-bound: a tape that holds every trade from the mint's first signature (its first
      // walk listed it, whole 0; or a read back reached it with no hole above) is the coin's whole chart: no history
      // before it to ask, nothing to read back, never filling for either (live helper 207, 19 Nov 17:26-17:30Z:
      // EHFrCL6p...pump, 7 signatures, its trades whole_ms 0, its 1m chart filling for 4 min 21 s). A walk that listed no
      // signature (an RPC not yet holding a fresh mint's) knows nothing of its first: not whole
      const born = (e.whole === 0 && typeof e.oldest === "string") || (e.back?.born === true && e.holed !== true);
      if (!born && mine.length < limit && tf !== "1s" && deps.history !== undefined) {
        const before = ownFrom === null ? (to ?? Math.floor(now() / 1000)) : Math.min(ownFrom, to ?? ownFrom);
        // with no bars of ours the history's newest range is asked as such (`to` null: one cache key, not one per second)
        const h = await deps.history(mint, tf, ownFrom === null ? to : before, limit, client).catch(() => UPSTREAM);
        // nothing of ours and no history to serve: the history's 429 or 503, so the page retries, never an empty chart
        // while its fill is owed (card evm-chart-opens-without-a-vendor-call: live run 42995547054 read an empty 200
        // for sUSDai's 1h at 09:29:51Z, 101 bars at 09:50Z; one rule with the EVM chains' candles, swaps.ts)
        const hb = h.status === 200 ? (JSON.parse(h.body) as { candles?: Candle[]; filling?: boolean }) : null;
        short = (h.status !== 200 && h.status !== 404) || hb?.filling === true;
        const old = (hb?.candles ?? []).filter((c) => c[0] < (backBars.length > 0 ? Math.min(backBars[0]![0], before) : before));
        // no bars before ours from the history (none, 404, refused or filling): our own signatures are read back
        if (old.length === 0) wantBack(e, tf as Tf, limit);
        if (mine.length === 0 && h.status !== 200 && h.status !== 404) return h;
        if (old.length > 0) {
          bars = old.concat(mine).slice(-limit);
          // the history came in and fills the chart: the read back is not needed
          if (bars.length >= limit && e.back !== undefined) e.back.done = true;
          src = `chain,${h!.src ?? "geckoterminal"}`;
        }
      }
      const at = e.readAt ?? now();
      const body: Record<string, unknown> = { tf, candles: bars, src };
      if (own.length > 0) body.own_from_s = own[0]![0];
      // a live chart (no `to`) of a token behind the chain is not current: filling, whatever its bar count (card
      // every-tape-and-chart-says-filling-behind-the-head)
      if ((!born && (short || backing(e)) && bars.length < limit) || (to === null && behind(e))) body.filling = true;
      body.as_of_ms = at;
      return { status: 200, body: JSON.stringify(body), src, asOfMs: at, timing: readTo(e) };
    },
    /** 06b Trades: the newest `limit` trades, newest first, the trader the event's user. */
    async trades(token: string, limit: number, client?: string): Promise<DataAnswer> {
      const mint = address(token);
      if (mint === null || !Number.isSafeInteger(limit) || limit < 1 || limit > TRADES_MAX) return NOT_FOUND;
      // a token Discover's lists do not hold (one the user searched, or the lists dropped) is served its top pool's
      // trades, as its chart's bars come from the history source (candles), with no walk of ours opened for it: the
      // tape a token page reads is never a 404 while its page and chart answer (card solana-trades-show-on-every-token:
      // the live helper at 837d9d810 answered NEARKAT's and BONK's trades 404, neither on the lists, their pages 200)
      if (!entries.has(mint) && deps.tape !== undefined && (await deps.listed(mint)) !== true) return poolTape(mint, limit, null, client);
      const began = performance.now();
      // a read that joins or starts a first read waits on that read's own bound (first); one on a tape already held does not
      const held = entries.has(mint) && !opening.has(mint);
      const e = await open(mint, client);
      // card solana-flooded-coin-first-answer-holds-rows: a tape still on its first walk (cold) with no row of ours waits
      // for its first row up to COLD_WAIT_MS from this read's start, as its first read does, before the vendor's rows
      // answer: a read joining a tape another read opened (its chart, an earlier caller) got the vendor's rows at once
      // while the walk read on (a coin opened before its tape was asked answered src coingecko at 145 ms)
      if (held && "mint" in e && e.state === "cold" && (folded(e).book === null || e.book!.tape(1).length === 0)) await rowOrBound(e, COLD_WAIT_MS - (performance.now() - began));
      // card helper-stays-fast-under-the-live-run: a listed coin whose first read failed (its subscription, its account)
      // answers the vendor's rows, filling, else an empty tape, filling: never a 503 (app-console-429 on helper-20, 25 of
      // 25 reads of one cold coin 503 at 3.6 s while its page, holders and bars answered); the next read opens it again
      if (!("mint" in e)) {
        if (e.why !== FIRST_FAILED) return e;
        // the answer of the failed read, kept while its coin waits (FAILED_OPEN_MS): the reads in between are answered
        // with it, so a crowd polling a failing coin asks neither the chain nor the vendor again until the wait is out
        // one answer for every read joined on the failure (one vendor read), set before it is read
        const f = failedOpens.get(mint);
        const kept = f !== undefined && f.answer !== undefined && f.answer.limit >= limit && now() < f.until ? f.answer.a : undefined;
        const answer =
          kept ??
          (async (): Promise<DataAnswer> => {
            const v = deps.tape === undefined ? null : await poolTape(mint, limit, null, client);
            if (v !== null && v.status === 200) {
              const { whole_ms: _, trades, ...b } = JSON.parse(v.body) as Record<string, unknown>;
              return { ...v, body: JSON.stringify({ trades: Array.isArray(trades) ? trades.slice(0, limit) : trades, ...b, filling: true }), timing: v.timing };
            }
            const at = now();
            return { status: 200, body: JSON.stringify({ trades: [], filling: true, src: "chain", as_of_ms: at }), src: "chain", asOfMs: at };
          })();
        if (kept === undefined && f !== undefined) f.answer = { a: answer, limit };
        const a = await answer;
        // a kept answer is the read's own: the bars a limit asks for, the timing of this read's wait, and the vendor rows'
        // age as of this read (from their read, asOfMs), never the age they had when the answer was kept
        const { trades: rows, ...rest } = JSON.parse(a.body) as Record<string, unknown>;
        const body = JSON.stringify({ trades: Array.isArray(rows) ? rows.slice(0, limit) : rows, ...rest });
        const aged = a.asOfMs === undefined ? a.timing : a.timing?.replace(/(sol-vendor-read;desc="rows read )\d+( ms ago")/, `$1${Math.max(0, now() - a.asOfMs)}$2`);
        return { ...a, body, timing: [aged, e.timing].filter((x) => x !== undefined && x !== "").join(", ") };
      }
      const rows = folded(e).book === null ? [] : e.book!.tape(limit);
      // a token with no trade of a venue this tape decodes (Raydium's other pools, Meteora's older pools, the other launchpads: a
      // token not on the pump.fun curve, PumpSwap, Orca, Raydium CLMM, CPMM, LaunchLab, Meteora DLMM, DBC or DAMM v2) is served its top pool's trades (token.ts tape),
      // never an empty tape for a token that trades (card solana-trades-show-on-every-token: NEARKAT and BONK answered 0
      // rows, src chain, while their pools traded)
      // card sol-meteora-tape-inside-rpc-budget: a coin whose Meteora trade went unread inside CUT_KEEP_MS names the cut in
      // Server-Timing, so a reader can tell its tape is past the budget. Card solana-flooded-coin-first-answer-holds-rows:
      // our own rows come first, filling and never whole while the cut lasts (our chain read is fresher than a vendor
      // tape, and filling says a trade is unread); the vendor's rows only while we hold none (every trade of a fresh coin
      // past the budget), named the same. Before it, a live tape past the cut was served the vendor's rows over its own
      // (helper-23 run 45018729954: 9WB75GUz answered 50 rows src coingecko at 145 ms).
      const cut = e.cut !== undefined && now() - e.cut.at <= CUT_KEEP_MS;
      const named = (v: DataAnswer): DataAnswer => (cut && v.status === 200 && v.src !== "chain" ? { ...v, timing: `${v.timing === undefined ? "" : `${v.timing}, `}sol-whole-cut;desc="a Meteora trade unread ${Math.round((now() - e.cut!.at) / 1_000)} s ago: ${CUT_WHY[e.cut!.why]}"` } : v);
      // card helper-stays-fast-under-the-live-run: a tape with no row of ours while its walk still reads its newest
      // signatures (a first read past its bound) says so: filling, never whole, whoever's rows it carries; the next read
      // after the walk's first round is our own rows
      const reading = (v: DataAnswer): DataAnswer => {
        if (e.state !== "cold" || v.status !== 200) return v;
        const { whole_ms: _, ...b } = JSON.parse(v.body) as Record<string, unknown>;
        // the first read's phases with the vendor's rows, as with ours (readTo), so a slow cold answer names its wait
        return { ...v, body: JSON.stringify({ ...b, filling: true }), timing: [v.timing, readTo(e)].filter((x) => x !== undefined && x !== "").join(", ") };
      };
      if (rows.length === 0 && deps.tape !== undefined) return named(reading(await poolTape(mint, limit, e, client)));
      const at = e.readAt ?? now();
      const trades = rows.map((r) => ({ t_ms: r.t_ms, side: r.side, usd: r.usd, amt: r.amt, trader: traders.get(`${mint} ${r.tx}`)?.[r.index % 8] ?? null, tx: r.tx }));
      // `filling` while the cold walk still reads the token's older trades (first() answered at COLD_WAIT_MS or its first
      // round): the rows so far, more to come; the Base and Robinhood tapes answer the same at their bound (../evm/swaps.ts)
      // and while the token is behind the chain (behind: a gap walked, the stream silent past SOL_BEHIND_MS): the rows it
      // holds, never a complete list (card every-tape-and-chart-says-filling-behind-the-head)
      const late = behind(e);
      const fill = (e.state === "cold" && rows.length < limit) || late || cut ? { filling: true } : {};
      // how far back the tape holds every trade (Entry.whole), only while no gap is being walked and the stream is heard
      // (none while a cut lasts: a Meteora trade is unread, so no span of this tape is known whole; past it, from after it)
      const whole = e.state === "live" && !late && !cut && e.whole !== undefined ? { whole_ms: Math.max(e.whole, e.cut?.to ?? 0) } : {};
      // card helper-sol-tape-checks-hold: a tape past the budget (named no reach while the cut lasts, above) names the
      // cut, as the vendor's rows do: it lacks the unread trade and nothing else in it says so (a local helper
      // at 321baac8c, 20 Nov 05:36Z: CARDSccU's tape cold, no whole_ms, its DLMM trade 4vEPr51yjSyE unread)
      const own = cut ? `${readTo(e)}, sol-whole-cut;desc="a Meteora trade unread ${Math.round((now() - e.cut!.at) / 1_000)} s ago: ${CUT_WHY[e.cut!.why]}"` : readTo(e);
      // card helper-tape-handover-judges-handed-books: a tape the handover gave names it
      const timing = e.handed === true ? `${own}, ${HANDED_TIMING}` : own;
      return { status: 200, body: JSON.stringify({ trades, ...fill, ...whole, src: "chain", as_of_ms: at }), src: "chain", asOfMs: at, timing };
    },
  };

}
export type SolanaTrades = ReturnType<typeof createSolanaTrades>;
