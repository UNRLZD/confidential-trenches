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
// above; their events carry no clock, so a trade is dated by its block (a walk's
// transaction its blockTime, a stream's the second it arrived: measured p95 1.78 s after the block, above). Meteora DLMM, DBC
// and DAMM v2 (card index-sol-trades-2) send their events only to themselves, so a stream transaction whose log names one
// running is read whole (`eventsInInner`) and dated by its block. A venue not decoded yet keeps GeckoTerminal's bars and
// tape for its coins.
// Every REPORT_MS the log says how many open tokens have an empty tape and why (a quote with no price, or no trade of
// a venue we read in the transactions that named the token), never which tokens.
//
// Display only: nothing here feeds a signature. Every provider value is hostile: bounded answers, decoders that check
// every byte they read (decode.ts), PumpSwap pools taken only when the PumpSwap program owns them and their base mint
// is the token, bounded books, subscriptions and caches.
import { change4h, createBook, joinBars, TF_SECONDS, TFS, type Book, type Candle, type Event, type Swap, type Tf } from "../candles.ts";
import { address } from "./lists.ts";
import { HELD_WAIT_MS, SOL_BEHIND_MS, SOL_VENDOR_REACH_MS, type DataAnswer } from "./token.ts";
import { cutTrades, dbcPair, eventsInInner, fromLogs, poolMints, poolPair, PUMP_AMM, USDC, WSOL, type RawTrade } from "./decode.ts";
import { CREDITS, type Slot } from "../../rpc/slot.ts";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const STREAM_WS = "wss://api.mainnet-beta.solana.com";
export const TRADES_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"] as const;
export const PYTH_RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
export const PYTH_SOL_USD = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
const PYTH_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const PRICE_UPDATE_DISC = "22f123639d7ef4cd";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

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
export const REFILL_MAX = 1_000;
export const SETTLE_SLOTS = 150;
/** A first read answers after its walk, or after this with what it holds by then. */
export const COLD_WAIT_MS = 3_000;
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
/** Read backs at once across every token, so a burst of listed coins (a deploy's live run opens 194 at once) never takes
 *  the public endpoints from the walks' and callers' reads. [design: two of the walks' TX_PARALLEL] */
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
const HELD_MAX = 20_000;
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
export type SourceEvents = { note(mint: string, n: Note): void; down(): void; up(): void };
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

type Held = { slot: number; seq: number; t: RawTrade[] };
type Entry = {
  mint: string;
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
};
type Back = { before: string | null; events: Swap[]; book: Book | null; done: boolean; txs: number; n: number; want: { tf: Tf; limit: number } };

export function createSolanaTrades(deps: {
  fetch?: Fetch;
  now?: () => number;
  /** Whether Discover's lists hold the token; null while the lists have no answer (a cold start), which is no "not
   *  listed": the tape answers 503, so the page reads again, never a 404 for a listed token (card app-console-429). */
  listed: (mint: string) => Promise<boolean | null>;
  rpcs?: readonly string[];
  wsUrl?: string;
  source?: (on: SourceEvents) => Source;
  /** The token's top pool's newest trades (token.ts tape: a JSON array of tape rows, newest first), served while this
   *  tape holds no row: a token whose venue is not decoded here. */
  tape?: (mint: string) => Promise<DataAnswer>;
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
  /** The shared RPC budget (../../rpc/rpc.ts background, card helper-ready-gate): before each request to `url`, the
   *  seconds to wait (0: go); a provider with a wait is skipped for the next, so callers' reads keep their room. */
  budget?: (url: string, method: string) => number;
  /** That provider's 429, which holds its budget for every caller. */
  throttled?: (url: string, headers: Headers) => void;
  /** The slot of `rpcs[0]` when it is a keyed provider (SOLANA_TRADES_RPC_URL, rpc/slot.ts): while it is fallen back the
   *  requests start at the next provider; its 401, 403, a spent plan, a 429 past its reset or 30 s with no answer
   *  fall it back. */
  slot?: Slot;
  /** The stream's slot (SOLANA_STREAM_WS_URL): `wsUrl` falls back to STREAM_WS as wsSource says. */
  streamSlot?: Slot;
}) {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const rpcs = deps.rpcs ?? TRADES_RPCS;
  const entries = new Map<string, Entry>();
  const pools = new Map<string, Promise<{ a: string; b: string } | null>>();
  /** `<mint> <signature>` -> each of the transaction's rows' traders by its place (a row's index % 8, fold), the user its
   *  own event names (null for an event that names none), kept after the trade settles: a row is named by its own event,
   *  never by the transaction's first trade (card sol-tape-trader-is-the-events-user, as evm/swaps.ts traderAt). */
  const traders = new Map<string, (string | null)[]>();
  let seq = 0;
  let solUsd: { slot: number; v: bigint } | null = null;
  let refAt = 0;
  let reportAt = now();
  /** Each other quote coin's decimals and USD price (USD per whole coin times 10^18), read once and every REF_MS. */
  const quotes = new Map<string, { decimals: number | null; usd: bigint | null; at: number; reading: Promise<void> | null }>();

  /** One request, to each provider in turn until one answers a result. */
  const slot = deps.slot !== undefined && deps.slot.state() !== "public" ? deps.slot : undefined;
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    for (const url of slot !== undefined && !slot.useKeyed() ? rpcs.slice(1) : rpcs) {
      const key = slot !== undefined && url === rpcs[0] ? slot : undefined;
      if ((deps.budget?.(url, method) ?? 0) > 0) continue;
      const sent = now();
      try {
        const r = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
        if (r.status === 429) deps.throttled?.(url, r.headers);
        if (r.status !== 200 || Number(r.headers.get("content-length") ?? "0") > ANSWER_MAX) {
          const body = key !== undefined && r.status >= 400 && r.status < 500 ? await head(r) : (await r.body?.cancel(), "");
          if (key !== undefined) {
            if (r.status === 401 || r.status === 403) key.fail(String(r.status));
            else if (CREDITS.test(body)) key.fail("credits");
            else if (r.status === 429) key.throttled(Math.max(1, Number(r.headers.get("retry-after")) || 1));
            else if (r.status >= 500) key.unanswered(sent);
          }
          continue;
        }
        const text = await r.text();
        if (text.length > ANSWER_MAX) continue;
        const j = JSON.parse(text) as Record<string, unknown>;
        if (j.error === undefined && "result" in j) return (key?.ok(), j.result);
        if (key !== undefined && CREDITS.test(String((j.error as { message?: unknown } | undefined)?.message ?? ""))) key.fail("credits");
      } catch {
        key?.unanswered(sent); // the next provider
      }
    }
    throw new Error(`${method}: no provider answered`);
  }

  /** A getTransaction answer's block time, unix seconds, or null. */
  const blockTime = (r: Record<string, unknown>): number | null => (Number.isSafeInteger(r.blockTime) && (r.blockTime as number) > 0 ? (r.blockTime as number) : null);

  async function account(key: string): Promise<{ owner: unknown; data: Buffer; slot: number } | null> {
    const r = (await rpc("getAccountInfo", [key, { encoding: "base64", commitment: "confirmed" }])) as Record<string, unknown>;
    const v = r?.value as Record<string, unknown> | null;
    const slot = (r?.context as Record<string, unknown> | undefined)?.slot;
    if (v === null || v === undefined || !Array.isArray(v.data) || typeof v.data[0] !== "string" || !Number.isSafeInteger(slot)) return null;
    return { owner: v.owner, data: Buffer.from(v.data[0], "base64"), slot: slot as number };
  }

  async function readRef(): Promise<void> {
    refAt = now(); // one try every REF_MS, answered or not
    const a = await account(PYTH_SOL_USD);
    const v = a === null ? null : pythSolUsd(a.owner, a.data, Math.floor(now() / 1000));
    if (a === null || v === null) return;
    solUsd = { slot: a.slot, v };
    for (const e of entries.values()) if (e.quoteMint === null || e.quoteMint === WSOL) e.refs.set(a.slot, v);
  }

  /** A pool's two mints (PumpSwap: base, quote), read once (a burst of trades on one pool shares the read; a failed
   *  read is not kept), taken only with the trade's own venue program as the pool account's owner. */
  function poolOf(t: RawTrade): Promise<{ a: string; b: string } | null> {
    const k = `${t.venue}:${t.pool!}`;
    const kept = pools.get(k);
    if (kept !== undefined) return kept;
    const venue = t.venue;
    // Meteora DBC: the quote mint is the pool's config's (card index-sol-trades-2)
    const read: Promise<{ a: string; b: string } | null> = venue === "meteora-dbc" ? Promise.all([account(t.pool!), account(t.config!)]).then(([a, c]) => (a === null || c === null ? null : dbcPair(a, c, t.config!))) : account(t.pool!).then((a) => {
      if (a === null) return null;
      if (venue === "pumpswap") {
        const p = a.owner === PUMP_AMM ? poolMints(a.data) : null;
        return p === null ? null : { a: p.base, b: p.quote };
      }
      return venue === "pump" ? null : poolPair(venue, a.owner, a.data);
    });
    if (pools.size >= POOLS_MAX) pools.delete(pools.keys().next().value!);
    pools.set(k, read);
    read.catch(() => pools.delete(k));
    return read;
  }

  /** Reads a quote coin's decimals (once, from its mint account) and its USD price; never throws. */
  function readQuote(q: string): Promise<void> {
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
        const a = await account(q);
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
   *  takes `blockS`, the transaction's block time. */
  async function forMint(mint: string, trades: RawTrade[], blockS: number): Promise<RawTrade[]> {
    const out: RawTrade[] = [];
    for (const raw of trades) {
      const t = raw.ts > 0 ? raw : { ...raw, ts: blockS };
      if (t.venue === "pump") {
        if (t.mint === mint) out.push(t);
        continue;
      }
      const p = t.pair ?? (await poolOf(t));
      if (p === null || p.a === p.b) continue;
      if (p.a === mint) out.push({ ...t, mint, quoteMint: p.b });
      // PumpSwap: the base mint only, as before
      else if (p.b === mint && t.venue !== "pumpswap") out.push({ ...t, mint, quoteMint: p.a, side: t.side === "b" ? "s" : "b", amt: t.quote, quote: t.amt });
    }
    // another quote coin: its decimals and price read before the trade is held, so the first tape is priced
    for (const q of new Set(out.map((t) => t.quoteMint))) if (q !== null && q !== WSOL && q !== USDC && deps.quoteUsd !== undefined && !priced(q)) await readQuote(q);
    return out;
  }

  /** A transaction's trades: from its log, or its inner instructions when the log was cut. */
  async function txTrades(mint: string, sig: string, logs: unknown): Promise<RawTrade[] | null> {
    const f = fromLogs(logs);
    // a stream transaction's block time is the second it arrived (the stream sends none)
    const arrived = Math.floor(now() / 1000);
    // a Meteora venue's events are in the inner instructions only (card index-sol-trades-2): read the transaction whole
    if (!f.truncated && !eventsInInner(logs)) return forMint(mint, f.trades, arrived);
    const r = (await rpc("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }])) as Record<string, unknown> | null;
    if (r === null) return null;
    return forMint(mint, cutTrades(f, r), blockTime(r) ?? arrived);
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

  /** Refolds the entry's held events into its book, settling those SETTLE_SLOTS behind its coverage. */
  function fold(e: Entry): void {
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
  }

  /** Walks `mint`'s signatures newer than `until` (the newest COLD_SIGS successful ones when null) and holds each
   *  transaction's trades, each in its place in the list. The reads go newest first, TX_PARALLEL at a time, and the tape
   *  is folded after each round (`round`), so a first read serves the newest trades after one round, not after the whole
   *  walk (card token-page-data-complete-and-fast: 30 reads at 5 a time held a cold tape 3.8 to 7.9 s on public
   *  endpoints). */
  async function walk(e: Entry, until: string | null, round?: () => void): Promise<void> {
    const sigs: { signature: string; slot: number; err: unknown; t: number | null }[] = [];
    const ok = (s: { err: unknown }): boolean => s.err === null || s.err === undefined;
    let before: string | undefined;
    const cold = until === null;
    // whether the list ran out (the mint's first signature, or a gap's start, reached), and the newest second below which
    // a trade may be missing (whole)
    let listedAll = false;
    const gap: { t: number | null } = { t: null };
    const below = (t: number | null): void => void (gap.t = Math.max(gap.t ?? 0, t ?? Math.floor(now() / 1000)));
    while (cold ? sigs.filter(ok).length < COLD_SIGS : sigs.length < REFILL_MAX) {
      // a first read's newest COLD_SIGS, then once, when they were not all successful, one COLD_PAGE before them: a
      // bot-flooded token's newest signatures are failed transactions, and a first read of them alone held no trade
      // (card solana-tape-rows-at-first-answer: live run 43689567273 read CjRGc8wH...pump 0 rows at +0 ms)
      const limit = cold ? (before === undefined ? COLD_SIGS : COLD_PAGE) : Math.min(SIG_PAGE, REFILL_MAX - sigs.length);
      const page = (await rpc("getSignaturesForAddress", [e.mint, { limit, commitment: "confirmed", ...(until !== null ? { until } : {}), ...(before !== undefined ? { before } : {}) }])) as unknown;
      if (!Array.isArray(page)) throw new Error("signatures");
      for (const s of page as Record<string, unknown>[]) {
        if (typeof s?.signature === "string" && Number.isSafeInteger(s.slot)) sigs.push({ signature: s.signature, slot: s.slot as number, err: s.err, t: Number.isSafeInteger(s.blockTime) && (s.blockTime as number) > 0 ? (s.blockTime as number) : null });
      }
      if (page.length < limit) listedAll = true;
      if (page.length < limit || sigs.length === 0 || (cold && before !== undefined)) break;
      before = sigs[sigs.length - 1]!.signature;
    }
    sigs.reverse();
    // each transaction's place is the list's (oldest first), taken before the reads, which go TX_PARALLEL at a time; a
    // first read keeps the newest COLD_SIGS successful
    const todo = sigs
      .filter((s) => ok(s) && !e.held.has(s.signature))
      .slice(cold ? -COLD_SIGS : 0)
      .map((s) => ({ ...s, order: ++seq }));
    // a first walk that listed the mint's every signature and reads each successful one not held: the tape from its birth
    const everyOne = cold && listedAll && todo.length === sigs.filter((x) => ok(x) && !e.held.has(x.signature)).length;
    // the read back starts before the oldest the first walk reads (its older page's signatures not read included)
    if (cold) e.oldest = todo[0]?.signature ?? sigs[0]?.signature ?? null;
    for (let k = todo.length; k > 0; k -= TX_PARALLEL) {
      await Promise.all(
        todo.slice(Math.max(0, k - TX_PARALLEL), k).map(async (s) => {
          const r = (await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }])) as Record<string, unknown> | null;
          if (r === null) return below(s.t);
          e.seen++;
          const meta = (r.meta ?? {}) as Record<string, unknown>;
          const f = fromLogs(meta.logMessages);
          const bt = blockTime(r) ?? Math.floor(now() / 1000);
          hold(e, s.signature, s.slot, s.order, await forMint(e.mint, f.truncated || eventsInInner(meta.logMessages) ? cutTrades(f, r) : f.trades, bt));
        }),
      );
      if (round !== undefined) {
        fold(e);
        round();
      }
    }
    for (const s of sigs) e.covered = Math.max(e.covered, s.slot);
    // the reach (Entry.whole): a first walk's oldest read, 0 when it read every successful signature the mint has; a gap's
    // walk that stopped at REFILL_MAX leaves the signatures below its oldest unread
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
    const trades = await txTrades(e.mint, n.sig, n.logs).catch(() => null);
    e.inflight.delete(n.sig);
    if (trades !== null) hold(e, n.sig, n.slot, order, trades);
    e.covered = Math.max(e.covered, n.slot);
    fold(e);
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
    }
    for (const e of entries.values()) {
      if (t - e.touched > IDLE_MS) {
        entries.delete(e.mint);
        source.unwatch(e.mint);
      } else if (e.state === "live") fold(e);
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
  const behind = (e: Entry): boolean => {
    if (e.state === "refilling") return true;
    if (source.heard === undefined) return false;
    const h = source.heard();
    return h === null || now() - h.at > SOL_BEHIND_MS;
  };
  /** The slot a token is held to with no gap and the stream's newest slot, for the answer's Server-Timing. */
  const readTo = (e: Entry): string => {
    const h = source.heard?.() ?? null;
    const ago = h === null ? "never" : `${Math.max(0, Math.round((now() - h.at) / 1_000))} s ago`;
    return `sol-read-to;desc="slot ${e.covered} of head ${h?.slot ?? "none"}, heard ${ago}${e.state === "live" ? "" : `, ${e.state}`}"`;
  };

  /** Each mint's tape the vendor has not answered (poolTape): since when, and its last such read; a read more than
   *  IDLE_MS after the last starts a new wait. At most WAITING_MAX, oldest out first. */
  const waiting = new Map<string, { since: number; last: number }>();
  /** The token's top pool's newest `limit` trades (deps.tape), src theirs, dated by their read. Refused or down, the
   *  empty tape with `filling`, so the page reads again, for VENDOR_WAIT_MS at most; then, and at once for a vendor that
   *  names no pool (404), the token's own empty tape (filling only while its walk reads), or for a token with no open
   *  walk (`e` null) the vendor's refusal, and a mint no pool names is the 404 it was. */
  async function poolTape(mint: string, limit: number, e: Entry | null): Promise<DataAnswer> {
    const v = await deps.tape!(mint).catch(() => null);
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
      const got = all.slice(0, limit);
      const src = v.src ?? "geckoterminal";
      const at = v.asOfMs ?? now();
      // the vendor's newest trades of the pool, every one after its oldest (card token-stats-count-every-trade), up to
      // their read: claimed complete only while that read is within SOL_VENDOR_REACH_MS, its age always named (card
      // vendor-tapes-name-their-reach-every-chain)
      const age = Math.max(0, now() - at);
      const oldest = (all.at(-1) as { t_ms?: unknown } | undefined)?.t_ms;
      const whole = typeof oldest === "number" && Number.isSafeInteger(oldest) && age <= SOL_VENDOR_REACH_MS ? { whole_ms: oldest + 1_000 } : {};
      const timing = `sol-vendor-read;desc="rows read ${age} ms ago"`;
      return { status: 200, body: JSON.stringify({ trades: got, ...whole, src, as_of_ms: at }), src, asOfMs: at, timing };
    }
    const at = e?.readAt ?? now();
    return { status: 200, body: JSON.stringify({ trades: [], filling: true, src: "chain", as_of_ms: at }), src: "chain", asOfMs: at };
  }

  /** A first read: the token's decimals, its subscription in force, then its newest COLD_SIGS signatures walked. */
  async function first(mint: string): Promise<Entry | DataAnswer> {
    const listed = await deps.listed(mint);
    if (listed === null) return UPSTREAM;
    if (!listed) return NOT_FOUND;
    if (entries.size >= OPEN_MAX) return { ...err(429, "rate_limited"), retryAfterS: 5, why: "solana trades open" };
    let decimals: number;
    try {
      const a = await account(mint);
      if (a === null || !TOKEN_PROGRAMS.includes(a.owner as string) || a.data.length < 82 || a.data[45] !== 1) return NOT_FOUND;
      decimals = a.data[44]!;
      if (solUsd === null) await readRef();
    } catch {
      return UPSTREAM;
    }
    const e: Entry = { mint, decimals, quoteMint: null, book: null, held: new Map(), refs: new Map(), lastSig: null, covered: 0, state: "cold", gapFrom: null, refilling: null, inflight: new Map(), touched: now(), readAt: null, seen: 0, traded: 0 };
    if (solUsd !== null) e.refs.set(0, solUsd.v); // the price in force for the cold read's trades
    entries.set(mint, e);
    try {
      // the walk starts only once the stream sends this mint's trades, so nothing falls between them
      await Promise.race([source.watch(mint), new Promise((_, no) => setTimeout(() => no(new Error("subscribe timeout")), TIMEOUT_MS).unref?.())]);
    } catch {
      entries.delete(mint);
      source.unwatch(mint);
      return UPSTREAM;
    }
    // the tape is served from the moment the stream holds the token; the walk's older trades join as they are read
    e.readAt = now();
    let firstRound: () => void = () => undefined;
    const rounded = new Promise<void>((ok) => (firstRound = ok));
    // the first answer is the first round that holds a trade: a busy token's newest transactions may hold none of a venue
    // read (failed bot buys, other venues), and its first round answered an empty tape (card
    // helper-live-run-green-after-122: ni hao cat's first reads, 0 rows at +0 and +2.4 s, 18 rows a second later)
    const traded = (): void => {
      if (e.book !== null && e.book.tape(1).length > 0) firstRound();
    };
    // a walk that fails is walked again while the token is open, after a wait that doubles to COLD_RETRY_MAX_MS: the
    // tape stays cold (filling) until its newest COLD_SIGS are read, never settled short on a read that failed (card
    // robinhood-trades-finish-filling: three fails ended the walk and the tape said done with what the stream had sent)
    const cold = (async () => {
      for (let attempt = 0; !stopped && entries.get(mint) === e; attempt++) {
        try {
          await walk(e, null, traded);
          if (e.state === "cold") e.state = "live";
          break;
        } catch {
          await new Promise((r) => setTimeout(r, Math.min(1_000 * 2 ** attempt, COLD_RETRY_MAX_MS)).unref?.());
        }
      }
      fold(e);
    })();
    // the first answer waits for the walk's first round that holds a trade (its newest trades), the whole walk, or
    // COLD_WAIT_MS
    await Promise.race([cold, rounded, deps.coldWait?.() ?? new Promise((r) => setTimeout(r, COLD_WAIT_MS).unref?.())]);
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
  async function readBack(e: Entry): Promise<void> {
    const b = e.back!;
    const floor = Math.floor(now() / 1000) - BACK_SPAN_S;
    const ok = (x: { err: unknown }): boolean => x.err === null || x.err === undefined;
    let fails = 0;
    while (entries.get(e.mint) === e && !b.done) {
      let page: unknown;
      try {
        page = await rpc("getSignaturesForAddress", [e.mint, { limit: COLD_PAGE, commitment: "confirmed", ...(b.before === null ? {} : { before: b.before }) }]);
      } catch {
        if (++fails >= 3) return;
        await new Promise((r) => setTimeout(r, 1_000).unref?.());
        continue;
      }
      if (!Array.isArray(page)) return;
      const sigs = (page as Record<string, unknown>[])
        .filter((x) => typeof x?.signature === "string" && Number.isSafeInteger(x.slot))
        .map((x) => ({ signature: x.signature as string, slot: x.slot as number, err: x.err, t: Number.isSafeInteger(x.blockTime) ? (x.blockTime as number) : null }));
      if (sigs.length > 0) b.before = sigs.at(-1)!.signature;
      const todo = sigs.filter(ok).map((x) => ({ ...x, n: ++b.n }));
      // a transaction not read (every provider held or failing) is asked again a second on, three times; still unread,
      // the read back ends at the newest one, its older trades dropped, so the bars read back have no hole in them
      const one = async (x: (typeof todo)[number]): Promise<boolean> => {
        const r = (await rpc("getTransaction", [x.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]).catch(() => null)) as Record<string, unknown> | null;
        if (r === null) return false;
        const f = fromLogs(((r.meta ?? {}) as Record<string, unknown>).logMessages);
        const got = await forMint(e.mint, f.truncated || eventsInInner(((r.meta ?? {}) as Record<string, unknown>).logMessages) ? cutTrades(f, r) : f.trades, blockTime(r) ?? x.t ?? Math.floor(now() / 1000));
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
          const read = await Promise.all(chunk.map(one));
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
      if (sigs.length < COLD_PAGE || b.txs >= BACK_TX_MAX || (oldestT !== null && oldestT < floor) || enough) b.done = true;
    }
  }
  let backs = 0;
  const backQueue: Entry[] = [];
  /** Starts the queued read backs, BACK_PARALLEL at once. */
  function startBacks(): void {
    while (backs < BACK_PARALLEL && backQueue.length > 0) {
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
    e.back = { before: e.oldest, events: [], book: null, done: e.oldest === null, txs: 0, n: 0, want: { tf, limit } };
    if (e.back.done) return;
    if (backQueue.length < OPEN_MAX) backQueue.push(e);
    else e.back.done = true;
    startBacks();
  }
  /** Whether `e`'s read back is still reading. */
  const backing = (e: Entry): boolean => e.back !== undefined && !e.back.done;

  const opening = new Map<string, Promise<Entry | DataAnswer>>();
  async function open(mint: string): Promise<Entry | DataAnswer> {
    // a first read in flight is joined before the entry is looked at: first() holds the entry from its mint read on, but
    // it serves only once the stream holds the token (readAt), so a caller that came in between would read it as down
    // (card app-console-429: 4 of 25 reads at once answered 503 on the deployed helper, 11:19Z)
    let e = opening.has(mint) ? undefined : entries.get(mint);
    if (e === undefined) {
      let p = opening.get(mint);
      if (p === undefined) {
        p = first(mint).finally(() => opening.delete(mint));
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

  return {
    tick,
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
      return e === undefined || e.book === null ? null : change4h(e.book, Math.floor(now() / 1000));
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
      const own: Candle[] = e.book === null ? [] : e.book.candles(tf as Tf, to, limit);
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
      if (mine.length < limit && tf !== "1s" && deps.history !== undefined) {
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
      if (((short || backing(e)) && bars.length < limit) || (to === null && behind(e))) body.filling = true;
      body.as_of_ms = at;
      return { status: 200, body: JSON.stringify(body), src, asOfMs: at, timing: readTo(e) };
    },
    /** 06b Trades: the newest `limit` trades, newest first, the trader the event's user. */
    async trades(token: string, limit: number): Promise<DataAnswer> {
      const mint = address(token);
      if (mint === null || !Number.isSafeInteger(limit) || limit < 1 || limit > TRADES_MAX) return NOT_FOUND;
      // a token Discover's lists do not hold (one the user searched, or the lists dropped) is served its top pool's
      // trades, as its chart's bars come from the history source (candles), with no walk of ours opened for it: the
      // tape a token page reads is never a 404 while its page and chart answer (card solana-trades-show-on-every-token:
      // the live helper at 837d9d810 answered NEARKAT's and BONK's trades 404, neither on the lists, their pages 200)
      if (!entries.has(mint) && deps.tape !== undefined && (await deps.listed(mint)) !== true) return poolTape(mint, limit, null);
      const e = await open(mint);
      if (!("mint" in e)) return e;
      const rows = e.book === null ? [] : e.book.tape(limit);
      // a token with no trade of a venue this tape decodes (Raydium's other pools, Meteora's older pools, the other launchpads: a
      // token not on the pump.fun curve, PumpSwap, Orca, Raydium CLMM, CPMM, LaunchLab, Meteora DLMM, DBC or DAMM v2) is served its top pool's trades (token.ts tape),
      // never an empty tape for a token that trades (card solana-trades-show-on-every-token: NEARKAT and BONK answered 0
      // rows, src chain, while their pools traded)
      if (rows.length === 0 && deps.tape !== undefined) return poolTape(mint, limit, e);
      const at = e.readAt ?? now();
      const trades = rows.map((r) => ({ t_ms: r.t_ms, side: r.side, usd: r.usd, amt: r.amt, trader: traders.get(`${mint} ${r.tx}`)?.[r.index % 8] ?? null, tx: r.tx }));
      // `filling` while the cold walk still reads the token's older trades (first() answered at COLD_WAIT_MS or its first
      // round): the rows so far, more to come; the Base and Robinhood tapes answer the same at their bound (../evm/swaps.ts)
      // and while the token is behind the chain (behind: a gap walked, the stream silent past SOL_BEHIND_MS): the rows it
      // holds, never a complete list (card every-tape-and-chart-says-filling-behind-the-head)
      const late = behind(e);
      const fill = (e.state === "cold" && rows.length < limit) || late ? { filling: true } : {};
      // how far back the tape holds every trade (Entry.whole), only while no gap is being walked and the stream is heard
      const whole = e.state === "live" && !late && e.whole !== undefined ? { whole_ms: e.whole } : {};
      return { status: 200, body: JSON.stringify({ trades, ...fill, ...whole, src: "chain", as_of_ms: at }), src: "chain", asOfMs: at, timing: readTo(e) };
    },
  };

}
export type SolanaTrades = ReturnType<typeof createSolanaTrades>;
