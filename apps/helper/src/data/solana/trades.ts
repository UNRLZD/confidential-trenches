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
// A token is served when its trades' quote is SOL or USDC; a coin launched against another quote coin (PUMP, read in
// the recorded curve buy) and every other venue (Raydium LaunchLab and CPMM, Meteora DBC, the lists' other launchpads)
// are card index-sol-trades-2: their trades are dropped and the token's candles keep GeckoTerminal's bars.
//
// Display only: nothing here feeds a signature. Every provider value is hostile: bounded answers, decoders that check
// every byte they read (decode.ts), PumpSwap pools taken only when the PumpSwap program owns them and their base mint
// is the token, bounded books, subscriptions and caches.
import { createBook, TFS, type Book, type Candle, type Event, type Swap, type Tf } from "../candles.ts";
import { address } from "./lists.ts";
import { type DataAnswer } from "./token.ts";
import { fromInner, fromLogs, poolMints, PUMP_AMM, USDC, WSOL, type RawTrade } from "./decode.ts";
import { CREDITS, type Slot } from "../../rpc/slot.ts";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const STREAM_WS = "wss://api.mainnet-beta.solana.com";
export const TRADES_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"] as const;
export const PYTH_RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
export const PYTH_SOL_USD = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
const PYTH_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const PRICE_UPDATE_DISC = "22f123639d7ef4cd";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

/** A first read's signatures (the bars before them are the history source's), and the transactions read at once. */
export const COLD_SIGS = 30;
const TX_PARALLEL = 5;
export const SIG_PAGE = 100;
export const REFILL_MAX = 1_000;
export const SETTLE_SLOTS = 150;
/** A first read answers after its walk, or after this with what it holds by then. */
export const COLD_WAIT_MS = 3_000;
export const SILENT_MS = 30_000;
export const REF_MS = 5_000;
export const REF_STALE_S = 120;
export const IDLE_MS = 60_000;
export const OPEN_MAX = 40;
export const TRADES_MAX = 50;
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
};

export function createSolanaTrades(deps: {
  fetch?: Fetch;
  now?: () => number;
  /** Whether Discover's lists hold the token; null while the lists have no answer (a cold start), which is no "not
   *  listed": the tape answers 503, so the page reads again, never a 404 for a listed token (card app-console-429). */
  listed: (mint: string) => Promise<boolean | null>;
  rpcs?: readonly string[];
  wsUrl?: string;
  source?: (on: SourceEvents) => Source;
  /** Bars before our first, GeckoTerminal's (token.ts candles), or none. */
  history?: (mint: string, tf: string, to: number | null, limit: number) => Promise<DataAnswer>;
  /** One line per stream drop and return (the host's log), so a deploy's tape can be read back. */
  log?: (line: string) => void;
  tickMs?: number;
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
  const pools = new Map<string, Promise<{ base: string; quote: string } | null>>();
  const traders = new Map<string, string>(); // signature -> the trade's user, kept after the trade settles
  let seq = 0;
  let solUsd: { slot: number; v: bigint } | null = null;
  let refAt = 0;

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
    for (const e of entries.values()) e.refs.set(a.slot, v);
  }

  /** A PumpSwap pool's mints, read once (a burst of trades on one pool shares the read; a failed read is not kept). */
  function poolOf(pool: string): Promise<{ base: string; quote: string } | null> {
    const kept = pools.get(pool);
    if (kept !== undefined) return kept;
    const read = account(pool).then((a) => (a !== null && a.owner === PUMP_AMM ? poolMints(a.data) : null));
    if (pools.size >= POOLS_MAX) pools.delete(pools.keys().next().value!);
    pools.set(pool, read);
    read.catch(() => pools.delete(pool));
    return read;
  }

  /** The trades of one transaction for `mint`, with the token named and the quote checked; PumpSwap pools read. */
  async function forMint(mint: string, trades: RawTrade[]): Promise<RawTrade[]> {
    const out: RawTrade[] = [];
    for (const t of trades) {
      if (t.venue === "pump") {
        if (t.mint === mint) out.push(t);
        continue;
      }
      const p = await poolOf(t.pool!);
      if (p !== null && p.base === mint) out.push({ ...t, mint, quoteMint: p.quote });
    }
    return out;
  }

  /** A transaction's trades: from its log, or its inner instructions when the log was cut. */
  async function txTrades(mint: string, sig: string, logs: unknown): Promise<RawTrade[] | null> {
    const f = fromLogs(logs);
    if (!f.truncated) return forMint(mint, f.trades);
    const r = (await rpc("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }])) as Record<string, unknown> | null;
    if (r === null) return null;
    return forMint(mint, fromInner(r));
  }

  /** Holds a transaction's trades, its place `order` (taken when it arrived, before any read it waited on). */
  function hold(e: Entry, sig: string, slot: number, order: number, trades: RawTrade[]): void {
    if (e.held.has(sig) || (e.book !== null && slot <= e.book.settledTo)) return;
    if (e.held.size >= HELD_MAX) return;
    e.held.set(sig, { slot, seq: order, t: trades });
    if (trades[0] !== undefined) {
      if (traders.size >= HELD_MAX) traders.delete(traders.keys().next().value!);
      traders.set(sig, trades[0].user);
    }
    if (e.book === null) {
      const q = trades.find((t) => t.quoteMint === WSOL || t.quoteMint === USDC)?.quoteMint;
      if (q !== undefined) {
        e.quoteMint = q;
        e.book = createBook({ decimals: e.decimals, quote: q === WSOL ? { kind: "eth", decimals: 9 } : { kind: "usd", decimals: 6 } });
      }
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
      for (const t of h.t) {
        if (t.quoteMint !== e.quoteMint) continue;
        const s: Swap = { kind: "swap", block: h.slot, index: h.seq * 8 + Math.min(i++ % 8, 7), tx: sig, t: t.ts, side: t.side, amt: t.amt, quote: t.quote };
        events.push(s);
      }
      i = 0;
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

  /** Walks `mint`'s signatures newer than `until` (all of the newest COLD_SIGS when null), oldest first, and holds each
   *  transaction's trades. */
  async function walk(e: Entry, until: string | null): Promise<void> {
    const sigs: { signature: string; slot: number; err: unknown }[] = [];
    let before: string | undefined;
    const max = until === null ? COLD_SIGS : REFILL_MAX;
    while (sigs.length < max) {
      const page = (await rpc("getSignaturesForAddress", [e.mint, { limit: Math.min(SIG_PAGE, max - sigs.length), commitment: "confirmed", ...(until !== null ? { until } : {}), ...(before !== undefined ? { before } : {}) }])) as unknown;
      if (!Array.isArray(page)) throw new Error("signatures");
      for (const s of page as Record<string, unknown>[]) {
        if (typeof s?.signature === "string" && Number.isSafeInteger(s.slot)) sigs.push({ signature: s.signature, slot: s.slot as number, err: s.err });
      }
      if (page.length < SIG_PAGE || until === null) break;
      before = sigs[sigs.length - 1]!.signature;
    }
    sigs.reverse();
    // each transaction's place is the list's (oldest first), taken before the reads, which go TX_PARALLEL at a time
    const todo = sigs.filter((s) => (s.err === null || s.err === undefined) && !e.held.has(s.signature)).map((s) => ({ ...s, order: ++seq }));
    for (let k = 0; k < todo.length; k += TX_PARALLEL) {
      await Promise.all(
        todo.slice(k, k + TX_PARALLEL).map(async (s) => {
          const r = (await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }])) as Record<string, unknown> | null;
          if (r === null) return;
          const meta = (r.meta ?? {}) as Record<string, unknown>;
          const f = fromLogs(meta.logMessages);
          hold(e, s.signature, s.slot, s.order, await forMint(e.mint, f.truncated ? fromInner(r) : f.trades));
        }),
      );
    }
    for (const s of sigs) e.covered = Math.max(e.covered, s.slot);
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
  function tick(): void {
    const t = now();
    if (t - refAt >= REF_MS) void readRef().catch(() => undefined);
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
    const e: Entry = { mint, decimals, quoteMint: null, book: null, held: new Map(), refs: new Map(), lastSig: null, covered: 0, state: "cold", gapFrom: null, refilling: null, inflight: new Map(), touched: now(), readAt: null };
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
    const cold = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await walk(e, null);
          break;
        } catch {
          if (attempt === 2 || !entries.has(mint)) break; // the stream's trades still serve; the cold window stays short
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
      if (e.state === "cold") e.state = "live";
      fold(e);
    })();
    await Promise.race([cold, new Promise((r) => setTimeout(r, COLD_WAIT_MS).unref?.())]);
    return e;
  }

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
      if (timer !== null) clearInterval(timer);
      timer = null;
      source.close();
    },
    /** 06b Candles for a listed Solana token: our own bars (1s included), and the history source's before our first. */
    async candles(token: string, tf: string, to: number | null, limit: number): Promise<DataAnswer> {
      const mint = address(token);
      if (mint === null || !(TFS as readonly string[]).includes(tf) || !Number.isSafeInteger(limit) || limit < 1 || limit > CANDLES_MAX) return NOT_FOUND;
      // a mint the lists do not hold has no bars of ours: its candles are the history source's own answer, as before
      if (!entries.has(mint) && deps.history !== undefined && (await deps.listed(mint)) !== true) return deps.history(mint, tf, to, limit);
      const e = await open(mint);
      if (!("mint" in e)) return e;
      const own: Candle[] = e.book === null ? [] : e.book.candles(tf as Tf, to, limit);
      const ownFrom = e.book === null ? null : e.book.ownFrom(tf as Tf);
      let bars = own;
      let src = "chain";
      if (own.length < limit && tf !== "1s" && deps.history !== undefined) {
        const before = ownFrom === null ? (to ?? Math.floor(now() / 1000)) : Math.min(ownFrom, to ?? ownFrom);
        // with no bars of ours the history's newest range is asked as such (`to` null: one cache key, not one per second)
        const h = await deps.history(mint, tf, ownFrom === null ? to : before, limit).catch(() => UPSTREAM);
        // nothing of ours and no history to serve: the history's 429 or 503, so the page retries, never an empty chart
        if (own.length === 0 && h.status !== 200 && h.status !== 404) return h;
        const old = h.status === 200 ? ((JSON.parse(h.body) as { candles?: Candle[] }).candles ?? []).filter((c) => c[0] < before) : [];
        if (old.length > 0) {
          bars = old.concat(own).slice(-limit);
          src = `chain,${h!.src ?? "geckoterminal"}`;
        }
      }
      const at = e.readAt ?? now();
      const body: Record<string, unknown> = { tf, candles: bars, src };
      if (own.length > 0) body.own_from_s = own[0]![0];
      body.as_of_ms = at;
      return { status: 200, body: JSON.stringify(body), src, asOfMs: at };
    },
    /** 06b Trades: the newest `limit` trades, newest first, the trader the event's user. */
    async trades(token: string, limit: number): Promise<DataAnswer> {
      const mint = address(token);
      if (mint === null || !Number.isSafeInteger(limit) || limit < 1 || limit > TRADES_MAX) return NOT_FOUND;
      const e = await open(mint);
      if (!("mint" in e)) return e;
      const rows = e.book === null ? [] : e.book.tape(limit);
      const at = e.readAt ?? now();
      const trades = rows.map((r) => ({ t_ms: r.t_ms, side: r.side, usd: r.usd, amt: r.amt, trader: traders.get(r.tx) ?? null, tx: r.tx }));
      return { status: 200, body: JSON.stringify({ trades, src: "chain", as_of_ms: at }), src: "chain", asOfMs: at };
    },
  };

}
export type SolanaTrades = ReturnType<typeof createSolanaTrades>;
