// The token page's price chart data (card app-token-chart; live since card app-chart-live, the section at the end). One
// read of the helper's GET /v1/market/candles for the page's chain, token and timeframe (06b `Candles`: apps/helper/src/data/solana/token.ts for Solana, GeckoTerminal's
// pool OHLCV; apps/helper/src/data/evm/swaps.ts for Base, our own swap reads with GeckoTerminal's bars before our first).
// The answer is `{ tf, candles: [[t_s, open, high, low, close, vol_usd], ...], src, own_from_s?, as_of_ms }`, oldest
// first, prices and volume as USD decimal strings. Display only: nothing here feeds a signature. An answer that is not
// that shape, bar for bar, is the chart's error state, never a partly drawn chart; no bars is the empty state.
//
// Attribution: GeckoTerminal's data carries CoinGecko's required label (API terms 4.4, 09 Data labels v2.0.5) while any
// drawn bar is theirs, which the answer's X-Helper-Source names ("geckoterminal", or "chain,geckoterminal" for a Base
// token whose older bars are theirs); "chain" alone is our own reads and draws no label.
import { HELPER_FETCH_INIT, HELPER_SOURCE_HEADER } from "@blindfill/kit";
import type { MarketChain } from "../discover/fields.ts";
import { price, usd } from "../discover/format.ts";

/** The timeframes the page draws (R5 token.js TF_LABEL) and the helper's name for each (06b `Tf`). */
export const TF_API = { "1s": "1s", "1m": "1m", "5m": "5m", "15m": "15m", "1H": "1h", "4H": "4h", "1D": "1d" } as const;
export type ChartTf = keyof typeof TF_API;
export const CHART_TFS = Object.keys(TF_API) as ChartTf[];
/** The chains whose helper serves 1s bars (card app-chart-controls): Solana's are its own chain reads, 1s included
 *  (apps/helper/src/data/solana/trades.ts candles); Base's and Robinhood's answer 1s as not found
 *  (apps/helper/src/data/evm/swaps.ts candles). R5 draws 1s only where it is served (token.js U.chartPanel). */
export const TF_1S_CHAINS: readonly MarketChain[] = ["solana"];
/** Whether the helper serves `tf` for a chain (1s only on TF_1S_CHAINS; none before the chain is known). The toolbar
 *  draws every timeframe from its first paint and turns off the ones not served, so no button moves when the token's
 *  chain lands (BAR-10 CLS). */
export const tfServed = (chain: MarketChain | null, tf: ChartTf): boolean => tf !== "1s" || (chain !== null && TF_1S_CHAINS.includes(chain));
/** 15m is the default (BRF v2.0.5, M157). */
export const DEFAULT_TF: ChartTf = "15m";
/** Seconds per bar, for the chart's period. */
export const TF_SECONDS: Record<ChartTf, number> = { "1s": 1, "1m": 60, "5m": 300, "15m": 900, "1H": 3_600, "4H": 14_400, "1D": 86_400 };
/** Bars asked for: the helper's most (CANDLES_MAX, apps/helper/src/data/solana/token.ts). */
export const CANDLES_LIMIT = 500;

/** HELPER_HOST's candle read (the CSP's connect-src names the host, public/_headers). */
export const CANDLES_URL = (chain: MarketChain, token: string, tf: ChartTf, limit = CANDLES_LIMIT) =>
  `https://ct-api.unrealized.trade/v1/market/candles?chain=${encodeURIComponent(chain)}&token=${encodeURIComponent(token)}&tf=${TF_API[tf]}&limit=${limit}`;
const TIMEOUT_MS = 10_000;

/** One bar as the chart draws it: time in ms, USD numbers. */
export interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** `own`: the answer's newest bars are the helper's own chain reads (it names `own_from_s`), so the chart follows them
 *  live (followCandles). */
export type CandleData =
  | { status: "loading" }
  | { status: "error" }
  | { status: "empty"; gecko: boolean }
  | { status: "ready"; tf: ChartTf; bars: Bar[]; gecko: boolean; precision: number; own: boolean };
export type ReadyCandles = Extract<CandleData, { status: "ready" }>;

const DECIMAL = /^\d+(\.\d+)?$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A USD decimal string as a finite number, or null. */
function num(v: unknown): number | null {
  if (typeof v !== "string" || v.length > 120 || !DECIMAL.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A price the chart library wrote as a plain decimal, drawn as Discover draws prices; any other text (a volume already
 *  drawn by `usd`, a percentage) is left as it is. */
export const priceText = (v: string | number): string => (DECIMAL.test(String(v)) ? price(String(v)) : String(v));
/** A volume as Discover draws volume. */
export const volumeText = (v: string | number): string => (DECIMAL.test(String(v)) ? usd(String(v)) : String(v));

/** Whether a source names GeckoTerminal's data (a comma list, 06b `src`). */
export const isGecko = (src: string | null): boolean => src !== null && src.split(",").some((s) => s.trim() === "geckoterminal");

/** Decimals that keep three significant digits of the smallest price drawn, at least 2 and at most 20. */
export function pricePrecision(bars: readonly Bar[]): number {
  let min = Infinity;
  for (const b of bars) if (b.low > 0 && b.low < min) min = b.low;
  if (!Number.isFinite(min) || min >= 1) return 2;
  return Math.min(20, Math.max(4, Math.ceil(-Math.log10(min)) + 3));
}

/**
 * The helper's answer as bars, or null when it is not a candle answer for `tf`: not an object, another timeframe, no
 * `candles` list, a row that is not six fields, a time that is not a whole positive second or not after the one before,
 * a price or volume that is not a USD decimal string, a zero price, or a high under the bar's open, close or low (or a
 * low over them). `src` is X-Helper-Source when the answer carries it, else the body's `src`.
 */
export function toCandleData(body: unknown, tf: ChartTf, headerSrc: string | null): Exclude<CandleData, { status: "loading" | "error" }> | null {
  if (!isObject(body) || body.tf !== TF_API[tf] || !Array.isArray(body.candles)) return null;
  const src = headerSrc ?? (typeof body.src === "string" ? body.src : null);
  if (src === null) return null;
  const bars: Bar[] = [];
  let last = 0;
  for (const row of body.candles as unknown[]) {
    if (!Array.isArray(row) || row.length !== 6) return null;
    const t = row[0];
    if (typeof t !== "number" || !Number.isSafeInteger(t) || t <= last) return null;
    const [open, high, low, close, volume] = row.slice(1).map(num);
    if (open == null || high == null || low == null || close == null || volume == null) return null;
    if (open <= 0 || low <= 0 || high < Math.max(open, close, low) || low > Math.min(open, close)) return null;
    bars.push({ timestamp: t * 1000, open, high, low, close, volume });
    last = t;
  }
  const gecko = isGecko(src);
  const own = Number.isSafeInteger(body.own_from_s) && (body.own_from_s as number) > 0;
  return bars.length === 0 ? { status: "empty", gecko } : { status: "ready", tf, bars, gecko, precision: pricePrecision(bars), own };
}

/** Reads after a 429 (the helper's GeckoTerminal budget is shared by every page: apps/helper/src/data/gecko.ts), each
 *  after the answer's Retry-After, at most THROTTLE_WAIT_MAX_S; the chart stays loading meanwhile. */
export const THROTTLE_RETRIES = 2;
export const THROTTLE_WAIT_MAX_S = 10;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One candle read: the bars, the empty state when the helper holds none (an answer of no bars, or a 404 for a token or
 *  chain it draws no candles for), else the error state. A 429 is read again after its Retry-After, THROTTLE_RETRIES
 *  times, then is the error state (Retry reads again). */
export async function loadCandles(chain: MarketChain, token: string, tf: ChartTf, fetchFn: typeof fetch = fetch, wait: (ms: number) => Promise<void> = sleep): Promise<CandleData> {
  try {
    for (let i = 0; ; i++) {
      const r = await fetchFn(CANDLES_URL(chain, token, tf), { ...HELPER_FETCH_INIT, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.status === 429 && i < THROTTLE_RETRIES) {
        const after = Number(r.headers.get("Retry-After"));
        await wait(1000 * (Number.isFinite(after) && after > 0 ? Math.min(after, THROTTLE_WAIT_MAX_S) : 1));
        continue;
      }
      if (r.status === 404) return { status: "empty", gecko: false };
      if (r.status !== 200) return { status: "error" };
      return toCandleData(await r.json(), tf, r.headers.get(HELPER_SOURCE_HEADER)) ?? { status: "error" };
    }
  } catch {
    return { status: "error" };
  }
}

// ------------------------------------------------------------------------------------------------------------- live
// The chart is live (card app-chart-live): while the page is open, the helper's newest bars are read again every
// LIVE_MS and folded into the bars drawn (foldBars, the one fold rule, the same for every chain and timeframe), so the
// last bar and the price mark move as trades land. The helper prices every swap by its one pricing rule
// (apps/helper/src/data/candles.ts) and keeps its bars in memory from its own chain reads (Solana:
// apps/helper/src/data/solana/trades.ts, folded every second; Base and Robinhood: apps/helper/src/data/evm/swaps.ts,
// read every second), so the page never prices a trade itself and a read of the newest bars costs the helper no call to
// anyone. Only a chart whose first answer names `own_from_s` (the helper's own bars) is followed: GeckoTerminal's bars
// alone are drawn once and never read again, since its 5 calls per 75 s are shared by every page; a followed chart
// whose helper loses its own bars for a while (a restart) is read once a minute until they are back.

/** The page's read interval: the helper's own tick (TICK_MS in apps/helper/src/data/evm/swaps.ts; createSolanaTrades
 *  tickMs, 1 s), so no read waits on bars the helper does not hold yet. */
export const LIVE_MS = 1_000;
/** The longest wait after failed reads (each failure doubles it from LIVE_MS), or a 429's Retry-After at most. */
export const LIVE_BACKOFF_MAX_MS = 30_000;

/** Bars a live read asks for: the newest and the one before it, whose last trades can land just after a new bar opens.
 *  A live read follows a good read by less than RESYNC_MS, under the shortest timeframe's bar (1m), so it never spans
 *  more than one new bar. */
export const LIVE_LIMIT = 2;
/** At 1s a bar opens every second a trade lands, so a live read asks for the newest LIVE_LIMIT_1S: more than the
 *  seconds one read cycle can span (a read's TIMEOUT_MS, 10 s, then LIVE_MS), so a busy token's bars are never skipped
 *  between two reads (a failed read is followed by a full one). */
export const LIVE_LIMIT_1S = 16;
/** A full read (CANDLES_LIMIT bars, the page's first read again) at least this often, and as the first read after a
 *  failed one: the helper can rebuild a token's bars (a book read again after its reads went stale, a pool found
 *  again, a restart), and its older bars then differ from the ones drawn (two of the three recorded tapes,
 *  test/chart-live/, Base and Robinhood 2026-11-05 12:00-12:02Z). The full read folds by the same rule. */
export const RESYNC_MS = 60_000;

/** Two bars alike, field for field. */
export const sameBar = (a: Bar, b: Bar): boolean => a.timestamp === b.timestamp && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;

/**
 * THE FOLD RULE: the helper's newest bars (`fresh`, oldest first, as toCandleData takes them) replace every bar drawn
 * from the first fresh bar's time on, and the bars before it stay as they are. A fresh bar's time is a bucket start of
 * `tf` (the helper buckets on that grid: apps/helper/src/data/candles.ts and its GeckoTerminal mapping both), so a new
 * bar opens on the grid; a fresh bar off the grid refuses the whole read (null, the bars drawn stay). No fresh bars, or
 * fresh bars equal to the ones drawn, return `bars` itself.
 */
export function foldBars(bars: readonly Bar[], fresh: readonly Bar[], tf: ChartTf): Bar[] | null {
  const step = TF_SECONDS[tf] * 1000;
  if (fresh.some((b) => b.timestamp % step !== 0)) return null;
  if (fresh.length === 0) return bars as Bar[];
  const from = fresh[0]!.timestamp;
  let cut = bars.length;
  while (cut > 0 && bars[cut - 1]!.timestamp >= from) cut--;
  const tail = bars.slice(cut);
  if (tail.length === fresh.length && tail.every((b, i) => sameBar(b, fresh[i]!))) return bars as Bar[];
  return bars.slice(0, cut).concat(fresh);
}

type Newest = { bars: Bar[]; gecko: boolean; own: boolean } | { failed: true; waitMs: number | null };

/** One read of the newest `limit` bars: the bars, or a failure (any status but 200, an answer toCandleData refuses, a
 *  throw) with a 429's Retry-After in ms. Never throws, never logs. */
export async function readNewest(chain: MarketChain, token: string, tf: ChartTf, limit: number, fetchFn: typeof fetch = fetch): Promise<Newest> {
  try {
    const r = await fetchFn(CANDLES_URL(chain, token, tf, limit), { ...HELPER_FETCH_INIT, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status !== 200) {
      await r.body?.cancel().catch(() => undefined);
      const after = Number(r.headers.get("Retry-After"));
      return { failed: true, waitMs: r.status === 429 && Number.isFinite(after) && after > 0 ? after * 1000 : null };
    }
    const d = toCandleData(await r.json(), tf, r.headers.get(HELPER_SOURCE_HEADER));
    if (d === null) return { failed: true, waitMs: null };
    return d.status === "ready" ? { bars: d.bars, gecko: d.gecko, own: d.own } : { bars: [], gecko: d.gecko, own: false };
  } catch {
    return { failed: true, waitMs: null };
  }
}

export interface FollowDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Runs `fn` after `ms`; returns its cancel. */
  later?: (fn: () => void, ms: number) => () => void;
  /** The page is out of sight (document.hidden): no read is made, and the first read back covers the time away. */
  hidden?: () => boolean;
}

const laterReal = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/**
 * Follows a ready chart of the helper's own bars: every LIVE_MS one read of the newest LIVE_LIMIT bars (a full read
 * once RESYNC_MS passed since the last, or after a failed read), folded (foldBars) and handed to `onBars` when they
 * changed, with the precision of the bars now drawn and CoinGecko's label kept while any drawn bar is GeckoTerminal's.
 * One read at a time; a hidden page reads nothing, and its first read back is a full one once RESYNC_MS passed. A
 * failed or refused read keeps the bars drawn and waits longer each time (doubling from LIVE_MS, a 429's Retry-After,
 * at most LIVE_BACKOFF_MAX_MS). An answer with none of the helper's own bars (a helper just restarted or deployed has
 * not read the token's book yet; its newest bars would be GeckoTerminal's) is folded like any other and the next read
 * is a full one RESYNC_MS later, so GeckoTerminal is read at most once a minute, and live reads resume once the
 * helper's own bars are back. Returns the stop.
 */
export function followCandles(chain: MarketChain, token: string, ready: ReadyCandles, onBars: (r: ReadyCandles) => void, deps: FollowDeps = {}): () => void {
  const now = deps.now ?? Date.now;
  const later = deps.later ?? laterReal;
  const hidden = deps.hidden ?? (() => typeof document !== "undefined" && document.hidden);
  let cur = ready;
  let lastFull = now();
  /** The last answer had none of the helper's own bars: the next read is a full one. */
  let away = false;
  let fails = 0;
  let stopped = false;
  let cancel: () => void = () => undefined;
  const next = (ms: number) => {
    if (!stopped) cancel = later(() => void step(), ms);
  };
  const failed = (waitMs: number | null) => {
    fails++;
    next(Math.min(LIVE_BACKOFF_MAX_MS, waitMs ?? LIVE_MS * 2 ** fails));
  };
  async function step(): Promise<void> {
    if (stopped) return;
    if (hidden()) return next(LIVE_MS);
    const sent = now();
    const full = fails > 0 || away || sent - lastFull >= RESYNC_MS;
    const got = await readNewest(chain, token, cur.tf, full ? CANDLES_LIMIT : cur.tf === "1s" ? LIVE_LIMIT_1S : LIVE_LIMIT, deps.fetchFn);
    if (stopped) return;
    if ("failed" in got) return failed(got.waitMs);
    const bars = foldBars(cur.bars, got.bars, cur.tf);
    if (bars === null) return failed(null);
    if (full) lastFull = sent;
    fails = 0;
    if (bars !== cur.bars) {
      cur = { ...cur, bars, gecko: cur.gecko || got.gecko, precision: pricePrecision(bars) };
      onBars(cur);
    }
    away = !got.own;
    next(away ? RESYNC_MS : LIVE_MS);
  }
  next(LIVE_MS);
  return () => {
    stopped = true;
    cancel();
  };
}
