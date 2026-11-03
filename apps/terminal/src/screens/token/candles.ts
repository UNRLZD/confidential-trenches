// The token page's price chart data (card app-token-chart). One read of the helper's GET /v1/market/candles for the
// page's chain, token and timeframe (06b `Candles`: apps/helper/src/data/solana/token.ts for Solana, GeckoTerminal's
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
export const TF_API = { "1m": "1m", "5m": "5m", "15m": "15m", "1H": "1h", "4H": "4h", "1D": "1d" } as const;
export type ChartTf = keyof typeof TF_API;
export const CHART_TFS = Object.keys(TF_API) as ChartTf[];
/** 15m is the default (BRF v2.0.5, M157). */
export const DEFAULT_TF: ChartTf = "15m";
/** Seconds per bar, for the chart's period. */
export const TF_SECONDS: Record<ChartTf, number> = { "1m": 60, "5m": 300, "15m": 900, "1H": 3_600, "4H": 14_400, "1D": 86_400 };
/** Bars asked for: the helper's most (CANDLES_MAX, apps/helper/src/data/solana/token.ts). */
export const CANDLES_LIMIT = 500;

/** HELPER_HOST's candle read (the CSP's connect-src names the host, public/_headers). */
export const CANDLES_URL = (chain: MarketChain, token: string, tf: ChartTf, limit = CANDLES_LIMIT) =>
  `https://api.confidential.unrealized.trade/v1/market/candles?chain=${encodeURIComponent(chain)}&token=${encodeURIComponent(token)}&tf=${TF_API[tf]}&limit=${limit}`;
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

export type CandleData =
  | { status: "loading" }
  | { status: "error" }
  | { status: "empty"; gecko: boolean }
  | { status: "ready"; tf: ChartTf; bars: Bar[]; gecko: boolean; precision: number };

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
  return bars.length === 0 ? { status: "empty", gecko } : { status: "ready", tf, bars, gecko, precision: pricePrecision(bars) };
}

/** One candle read: the bars, the empty state when the helper holds none (an answer of no bars, or a 404 for a token or
 *  chain it draws no candles for), else the error state. */
export async function loadCandles(chain: MarketChain, token: string, tf: ChartTf, fetchFn: typeof fetch = fetch): Promise<CandleData> {
  try {
    const r = await fetchFn(CANDLES_URL(chain, token, tf), { ...HELPER_FETCH_INIT, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status === 404) return { status: "empty", gecko: false };
    if (r.status !== 200) return { status: "error" };
    return toCandleData(await r.json(), tf, r.headers.get(HELPER_SOURCE_HEADER)) ?? { status: "error" };
  } catch {
    return { status: "error" };
  }
}
