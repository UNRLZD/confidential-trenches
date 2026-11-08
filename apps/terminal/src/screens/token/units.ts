// The chart's units (card app-chart-controls), R5's toolbar toggles (token.js U.chartPanel): Price / MCap and USD / the
// chain's own coin. The helper's bars are USD prices; MCap draws each price times the token's supply (its market cap
// over its price, both from the token read), and the coin draws USD over the coin's USD price, the device's own read
// (the kit's poolUsdPrice through the signing page's state, trade/TradeBox.tsx `price`). A toggle whose number is not
// there (no supply, no coin price) stays on Price or USD: the chart never draws a value it has no read for.
// Display only: nothing here feeds a signature.
import type { MarketChain, MarketRow } from "../discover/fields.ts";
import { price, usd } from "../discover/format.ts";
import type { PoolPrice } from "../trade/model.ts";
import type { Bar } from "./candles.ts";

/** The coin each chain's tokens trade against (R5 `o.native`): the chart's other unit. A symbol, not a word. */
export const QUOTE: Record<MarketChain, string> = { solana: "SOL", base: "ETH", robinhood: "ETH", near: "NEAR" };

/** What the toolbar asks for: MCap over Price, the coin over USD. */
export interface ChartUnit {
  mc: boolean;
  quote: boolean;
}

/** The token's supply as its market cap over its price, or null when either is missing or not above zero. */
export function supplyOf(row: Pick<MarketRow, "mc_usd" | "price_usd"> | null): number | null {
  if (!row) return null;
  const mc = Number(row.mc_usd ?? NaN);
  const p = Number(row.price_usd ?? NaN);
  return Number.isFinite(mc) && Number.isFinite(p) && mc > 0 && p > 0 ? mc / p : null;
}

/** The coin's USD price from the device's read, or null. */
export function coinUsd(p: PoolPrice | null | undefined): number | null {
  if (!p) return null;
  const v = Number(p.price) * 10 ** p.expo;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** The unit drawn: each toggle on only when its number is there. */
export const unitDrawn = (asked: ChartUnit, supply: number | null, coin: number | null): ChartUnit => ({ mc: asked.mc && supply !== null, quote: asked.quote && coin !== null });

/** What each bar's prices and volume are multiplied by for `unit`. */
export function factors(unit: ChartUnit, supply: number | null, coin: number | null): { price: number; volume: number } {
  const perCoin = unit.quote && coin !== null ? 1 / coin : 1;
  return { price: (unit.mc && supply !== null ? supply : 1) * perCoin, volume: perCoin };
}

/** The bars in `unit`: the same bars when nothing changes (factors of 1). */
export function scaleBars(bars: readonly Bar[], f: { price: number; volume: number }): readonly Bar[] {
  if (f.price === 1 && f.volume === 1) return bars;
  return bars.map((b) => ({ timestamp: b.timestamp, open: b.open * f.price, high: b.high * f.price, low: b.low * f.price, close: b.close * f.price, volume: b.volume * f.volume }));
}

const DECIMAL = /^\d+(\.\d+)?$/;
const noDollar = (s: string) => s.replace("$", "");

/** A price as the chart draws it in `unit`: Discover's price; MCap as Discover's market cap ($2.57M); in the coin
 *  without the dollar sign. Text that is not a plain decimal is left as it is. */
export function valueText(unit: ChartUnit, v: string | number): string {
  const s = String(v);
  if (!DECIMAL.test(s)) return s;
  const t = unit.mc ? usd(s) : price(s);
  return unit.quote ? noDollar(t) : t;
}

/** A volume as the chart draws it in `unit`: Discover's volume, without the dollar sign in the coin. */
export function volumeIn(unit: ChartUnit, v: string | number): string {
  const s = String(v);
  if (!DECIMAL.test(s)) return s;
  return unit.quote ? noDollar(usd(s)) : usd(s);
}
