// The token chart's trade marks (card app-chart-controls): the helper's GET /v1/market/trades read as the trades behind
// the marks, then grouped and laid out the way UNRLZD draws its trader bubbles (research repo design/proto at 9bc315d,
// assets/app.js P.chart): one mark per trader x bar x side at the average fill clamped into the bar, placed biggest first;
// a mark that would cover a placed one slides one step up or down, else folds into the nearest, which shows "+k".
// The answer is hostile input: a row that is not of the shape, or a list over the rows asked for, is no marks at all,
// never a partly read list. A failed read is no marks and is never logged.
import { HELPER_FETCH_INIT } from "@blindfill/kit";
import { useEffect, useState } from "react";
import type { MarketChain } from "../discover/fields.ts";
import { TF_SECONDS } from "./candles.ts";
import type { Bar, ChartTf } from "./candles.ts";

const BASE = "https://ct-api.unrealized.trade";
export const TRADES_LIMIT = 50;
export const TRADES_URL = (chain: MarketChain, token: string): string =>
  `${BASE}/v1/market/trades?chain=${encodeURIComponent(chain)}&token=${encodeURIComponent(token)}&limit=${TRADES_LIMIT}`;
const TIMEOUT_MS = 10_000;
export const TRADES_POLL_MS = 3_000;
/** The longest wait after failed reads: each failure doubles it from TRADES_POLL_MS, so a helper that cannot answer is
 *  asked at most once in this long, never every 3 s. */
export const TRADES_BACKOFF_MAX_MS = 30_000;
/** The wait before the next read after `fails` failed reads in a row (0: the last read was good). */
export const nextWait = (fails: number): number => Math.min(TRADES_BACKOFF_MAX_MS, TRADES_POLL_MS * 2 ** fails);
const BODY_MAX = 1_000_000;
const NAME_MAX = 128;
const DECIMAL = /^\d{1,40}(\.\d{1,40})?$/;

export type Side = "buy" | "sell";

/** One trade as the helper sends it: `usd` and `amt` are positive decimal strings, `trader` is null when the helper
 *  could not name the wallet. */
export interface Trade {
  t_ms: number;
  side: Side;
  usd: string;
  amt: string;
  trader: string | null;
  tx: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const positive = (v: unknown): v is string => typeof v === "string" && DECIMAL.test(v) && Number(v) > 0;
const named = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= NAME_MAX;

function toTrade(r: unknown): Trade | null {
  if (!isObject(r)) return null;
  const { t_ms, side, usd, amt, trader, tx } = r;
  if (typeof t_ms !== "number" || !Number.isSafeInteger(t_ms) || t_ms < 0) return null;
  if (side !== "buy" && side !== "sell") return null;
  if (!positive(usd) || !positive(amt)) return null;
  if (trader !== null && !named(trader)) return null;
  if (!named(tx)) return null;
  return { t_ms, side, usd, amt, trader: trader as string | null, tx };
}

/** The answer as trades, or null when any part of it is not of the shape. */
export function toTrades(body: unknown): Trade[] | null {
  if (!isObject(body) || !Array.isArray(body.trades) || body.trades.length > TRADES_LIMIT) return null;
  const out: Trade[] = [];
  for (const r of body.trades) {
    const t = toTrade(r);
    if (t === null) return null;
    out.push(t);
  }
  return out;
}

/** A tape's text, a read's body or a pushed message, as trades: null when it is over BODY_MAX, not JSON or not of the shape. */
function parseTape(text: string): Trade[] | null {
  if (text.length > BODY_MAX) return null;
  try {
    return toTrades(JSON.parse(text));
  } catch {
    return null;
  }
}

/** One read of the helper; no marks (null) on a non-200, a throw or an answer not of the shape. */
export async function readTrades(chain: MarketChain, token: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<Trade[] | null> {
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const r = await fetchFn(TRADES_URL(chain, token), { ...HELPER_FETCH_INIT, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (r.status !== 200) return null;
    return parseTape(await r.text());
  } catch {
    return null;
  }
}

const same = (a: readonly Trade[], b: readonly Trade[]): boolean =>
  a.length === b.length && a.every((t, i) => t.tx === b[i]!.tx && t.t_ms === b[i]!.t_ms && t.side === b[i]!.side && t.usd === b[i]!.usd && t.amt === b[i]!.amt && t.trader === b[i]!.trader);

const NONE: readonly Trade[] = [];

/** The tape as the page draws it: `loading` until the first read ends, `none` when the last read failed (no marks, the
 *  Trades tab's empty state), `ready` with the rows of the last good read (which may be none). */
export interface Tape {
  trades: readonly Trade[];
  status: "loading" | "ready" | "none";
}
const LOADING: Tape = { trades: NONE, status: "loading" };

// ------------------------------------------------------------------------------------------------------------- push
// The tape is pushed (card market-data-push): the helper's push socket (GET /v1/market/push, a WebSocket that answers
// APP_HOST's Origin only, apps/helper/src/data/push.ts) sends the token's whole tape, the trades route's answer at its
// longest, first as it is and then each time its rows change. Each message replaces the tape drawn, as a read does, so a
// trade is never drawn twice however reads and messages cross. While the socket is down the tape is read every
// TRADES_POLL_MS as before (longer after failed reads), and the socket is opened again after the same doubling wait.

/** HELPER_HOST's push socket for a token's tape (the CSP's connect-src names wss://HELPER_HOST, public/_headers). */
export const PUSH_URL = (chain: MarketChain, token: string): string =>
  `${BASE.replace(/^https:/, "wss:")}/v1/market/push?chain=${encodeURIComponent(chain)}&token=${encodeURIComponent(token)}`;
/** While the socket sends tapes, the tape is still read this long after the last one: a socket a network change left
 *  open but dead (a phone's, which a page cannot see closing) never holds the tape longer [design: TRADES_BACKOFF_MAX_MS]. */
export const TRADES_PUSHED_POLL_MS = 30_000;

/** The part of a browser WebSocket the follow uses. */
export interface PushSocket {
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}
export interface TapeDeps {
  fetchFn?: typeof fetch;
  /** Opens the push socket; none (a runtime with no WebSocket) is the tape read every TRADES_POLL_MS. */
  socket?: ((url: string) => PushSocket) | null;
  /** Runs `fn` after `ms`; returns its cancel. */
  later?: (fn: () => void, ms: number) => () => void;
  /** The page is out of sight (document.hidden): no read is made until it is back. */
  hidden?: () => boolean;
}

const laterReal = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};
const socketReal = (): ((url: string) => PushSocket) | null =>
  typeof WebSocket === "undefined" ? null : (url) => new WebSocket(url) as unknown as PushSocket;

/**
 * Follows a token's tape: the push socket's tapes, and reads of the trades route on mount, while the socket is down
 * (every TRADES_POLL_MS, doubling after each failed read to TRADES_BACKOFF_MAX_MS) and TRADES_PUSHED_POLL_MS after the
 * last pushed tape. `onTape` gets the tape when it changes: `ready` with the rows of the last good read or message,
 * `none` when the last read failed and no socket is sending. A message is hostile input: one that is not a tape (over
 * BODY_MAX, not text, not JSON, a row not of the shape) drops the socket, as its close does; then the tape is read at
 * once and the socket opened again after nextWait of the drops in a row. A pushed tape aborts a read still out, so an
 * older answer never lands over it. Returns the stop.
 */
export function followTape(chain: MarketChain, token: string, onTape: (t: Tape) => void, deps: TapeDeps = {}): () => void {
  const fetchFn = deps.fetchFn ?? fetch;
  const later = deps.later ?? laterReal;
  const hidden = deps.hidden ?? (() => typeof document !== "undefined" && document.hidden);
  const open = deps.socket === undefined ? socketReal() : deps.socket;
  let stopped = false;
  let cur: Tape = LOADING;
  /** The socket has sent a tape and not closed since. */
  let pushed = false;
  let fails = 0;
  let drops = 0;
  let ws: PushSocket | null = null;
  let out: AbortController | null = null;
  let cancelRead: () => void = () => undefined;
  let cancelOpen: () => void = () => undefined;

  const show = (t: Tape) => {
    if (t.status === cur.status && (t.trades === cur.trades || same(t.trades, cur.trades))) return;
    cur = t;
    onTape(t);
  };
  const readIn = (ms: number) => {
    cancelRead();
    if (!stopped) cancelRead = later(() => void read(), ms);
  };
  async function read(): Promise<void> {
    if (stopped || out !== null) return;
    // a page out of sight reads nothing until it is back
    if (hidden()) return readIn(TRADES_POLL_MS);
    const mine = new AbortController();
    out = mine;
    const t = await readTrades(chain, token, fetchFn, mine.signal);
    if (stopped || mine.signal.aborted) return;
    out = null;
    // a failed read draws no marks and waits longer each time (nextWait), unless a socket sends the tape; a good read
    // goes back to TRADES_POLL_MS
    fails = t === null ? fails + 1 : 0;
    if (t !== null) show({ trades: t, status: "ready" });
    else if (!pushed) show({ trades: NONE, status: "none" });
    readIn(pushed ? TRADES_PUSHED_POLL_MS : nextWait(fails));
  }
  /** The socket closed, failed or sent what is not a tape: read now, open again after nextWait of the drops. */
  const dropped = (s: PushSocket | null) => {
    if (stopped || s !== ws) return;
    if (s !== null) {
      s.onmessage = s.onclose = s.onerror = null;
      s.close();
    }
    ws = null;
    pushed = false;
    if (out === null) {
      cancelRead();
      void read();
    }
    cancelOpen = later(connect, nextWait(drops++));
  };
  function connect(): void {
    if (stopped || open === null) return;
    let s: PushSocket;
    try {
      s = open(PUSH_URL(chain, token));
    } catch {
      return dropped(null);
    }
    ws = s;
    s.onclose = s.onerror = () => dropped(s);
    s.onmessage = (e) => {
      if (stopped || s !== ws) return;
      const t = typeof e.data === "string" ? parseTape(e.data) : null;
      if (t === null) return dropped(s);
      pushed = true;
      drops = 0;
      fails = 0;
      out?.abort();
      out = null;
      readIn(TRADES_PUSHED_POLL_MS);
      show({ trades: t, status: "ready" });
    };
  }

  void read();
  connect();
  return () => {
    stopped = true;
    out?.abort();
    cancelRead();
    cancelOpen();
    if (ws !== null) {
      ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
      ws = null;
    }
  };
}

/** The token's newest trades (followTape): pushed by the helper's socket, read on mount and every 3 s while it is down
 *  (longer after failed reads, none while hidden); stopped on unmount and when the chain or the token change (then the
 *  list starts from loading). A failed read leaves no marks. */
export function useTrades(chain: MarketChain | null, token: string | null): Tape {
  const [state, setState] = useState<{ key: string; tape: Tape }>({ key: "", tape: LOADING });
  const key = chain !== null && token !== null ? `${chain}\n${token}` : "";
  useEffect(() => {
    if (chain === null || token === null) return;
    return followTape(chain, token, (tape) => setState({ key, tape }));
  }, [chain, token, key]);
  return state.key === key ? state.tape : LOADING;
}

/** A trader's address as the card draws it: the first 4, an ellipsis, the last 4; a short one whole. */
export const shortTrader = (t: string): string => (t.length <= 9 ? t : `${t.slice(0, 4)}…${t.slice(-4)}`);

/** One mark: a trader's trades of one side in one bar. `price` is the average fill (USD per token) held inside the
 *  bar's low..high; `usd` and `amt` are the sums; `t_ms` is the newest trade's time; `n` the trades folded in. */
export interface Mark {
  id: string;
  barTs: number;
  side: Side;
  trader: string | null;
  usd: number;
  amt: number;
  price: number;
  t_ms: number;
  n: number;
}

/** The index of the bar a time falls in (the largest timestamp at or before it, within the timeframe's span), or -1. */
function barAt(bars: readonly Bar[], t: number, spanMs: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.timestamp <= t) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return at >= 0 && t < bars[at]!.timestamp + spanMs ? at : -1;
}

/** Trades as marks: grouped by trader x bar x side (a trade with no trader is its own group), the price the group's
 *  sum usd / sum amt, held inside its bar. A trade outside every bar's span is dropped. */
export function groupMarks(trades: readonly Trade[], bars: readonly Bar[], tf: ChartTf): Mark[] {
  const spanMs = TF_SECONDS[tf] * 1000;
  const groups = new Map<string, Mark>();
  for (const t of trades) {
    const i = barAt(bars, t.t_ms, spanMs);
    if (i < 0) continue;
    const usd = Number(t.usd);
    const amt = Number(t.amt);
    if (!Number.isFinite(usd) || !Number.isFinite(amt) || amt <= 0) continue;
    const barTs = bars[i]!.timestamp;
    const id = `${barTs}:${t.side}:${t.trader ?? `tx:${t.tx}`}`;
    const g = groups.get(id);
    if (g) {
      g.usd += usd;
      g.amt += amt;
      g.t_ms = Math.max(g.t_ms, t.t_ms);
      g.n++;
    } else groups.set(id, { id, barTs, side: t.side, trader: t.trader, usd, amt, price: 0, t_ms: t.t_ms, n: 1 });
  }
  const barOf = new Map(bars.map((b) => [b.timestamp, b] as const));
  for (const g of groups.values()) {
    const b = barOf.get(g.barTs)!;
    g.price = Math.min(b.high, Math.max(b.low, g.usd / g.amt));
  }
  return [...groups.values()];
}

/** A mark's wish for a place: its centre in the pane's pixels and its size. */
export interface Wish {
  id: string;
  x: number;
  y: number;
  usd: number;
}

export interface Area {
  width: number;
  height: number;
  r: number;
}

/** Where a mark is drawn; `k` is how many marks folded into it. */
export interface Placed {
  id: string;
  x: number;
  y: number;
  k: number;
}

/** The design's layout: marks outside the pane are not drawn; the rest are placed biggest USD first (ties by id), each
 *  held inside the pane by its radius. One that would cover a placed mark (centres under 1.6 r apart) slides one step
 *  (2 r + 2) up, else down, else folds into the nearest placed mark, whose `k` grows. */
export function layoutMarks(wishes: readonly Wish[], { width, height, r }: Area): Placed[] {
  const step = 2 * r + 2;
  const placed: Placed[] = [];
  const hits = (x: number, y: number): Placed[] => placed.filter((q) => Math.hypot(q.x - x, q.y - y) < 2 * r * 0.8);
  const inside = (w: Wish): boolean => Number.isFinite(w.x) && Number.isFinite(w.y) && w.x >= 0 && w.x <= width && w.y >= 0 && w.y <= height;
  const order = wishes.filter(inside).sort((a, b) => b.usd - a.usd || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const w of order) {
    const y = Math.max(r, Math.min(height - r, w.y));
    const over = hits(w.x, y);
    if (over.length === 0) {
      placed.push({ id: w.id, x: w.x, y, k: 0 });
      continue;
    }
    const slid = [-step, step].map((d) => y + d).find((y2) => y2 >= r && y2 <= height - r && hits(w.x, y2).length === 0);
    if (slid !== undefined) {
      placed.push({ id: w.id, x: w.x, y: slid, k: 0 });
      continue;
    }
    let near = over[0]!;
    for (const q of over) if (Math.hypot(q.x - w.x, q.y - y) < Math.hypot(near.x - w.x, near.y - y)) near = q;
    near.k++;
  }
  return placed;
}
