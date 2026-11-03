// The token page's drawn values as pure functions of a 06b `Row` (src/screens/discover/fields.ts). Numbers are drawn
// as Discover draws them (format.ts), so one token reads the same on both screens. The curve rule, one for every screen,
// is in ../market/curve.ts.
import type { MarketRow } from "../discover/fields.ts";
import { age, compact, count, DASH, price, priceTile, usdTile } from "../discover/format.ts";
import { curve } from "../market/curve.ts";
import type { Curve } from "../market/curve.ts";

export { curve };
export type { Curve };

const MINUS = "−";

export type Dir = "up" | "down" | "none";

/** The 24h change in basis points: two places, signed, grouped (+8.02%, −5.17%, +51,404.00%); a value that is not a
 *  whole number of basis points is the dash. */
export function change24(bps: number | null | undefined): { text: string; dir: Dir } {
  if (typeof bps !== "number" || !Number.isInteger(bps)) return { text: DASH, dir: "none" };
  const a = Math.abs(bps);
  const body = `${Math.floor(a / 100).toLocaleString("en-US")}.${String(a % 100).padStart(2, "0")}`;
  return bps >= 0 ? { text: `+${body}%`, dir: "up" } : { text: `${MINUS}${body}%`, dir: "down" };
}

/** The 24h change in the strip's tile, at most 8 characters, the width the tile is drawn for: under 1,000% as
 *  `change24`; from 1,000% without decimals (+51,404%); from 100,000% compact as the other tiles are (+514.0K%). */
export function changeTile(bps: number | null | undefined): string {
  const c = change24(bps);
  if (c.dir === "none" || Math.abs(bps!) < 100_000) return c.text;
  const pct = Math.floor(Math.abs(bps!) / 100);
  const sign = bps! >= 0 ? "+" : MINUS;
  if (pct < 100_000) return `${sign}${pct.toLocaleString("en-US")}%`;
  const body = compact(pct);
  return `${sign}${(sign + body).length + 1 > 8 ? body.replace(/(\.\d)\d(?=[KMBT])/, "$1") : body}%`;
}

export interface TokenView {
  token: string;
  symbol: string;
  /** Empty when it repeats the symbol. */
  name: string;
  price: string;
  /** `price` cut to the strip tile's width. */
  priceTile: string;
  mc: string;
  vol: string;
  liq: string;
  holders: string;
  age: string;
  chg: { text: string; dir: Dir };
  /** `chg.text` cut to the strip tile's width. */
  chgTile: string;
  launchpad: string | null;
  chain: string;
  curve: Curve;
}

/** The page's values for one token. `nowMs` is the clock the age is drawn against. */
export function tokenView(r: MarketRow, nowMs: number): TokenView {
  return {
    token: r.token,
    symbol: r.symbol,
    name: r.name && r.name !== r.symbol ? r.name : "",
    price: price(r.price_usd),
    priceTile: priceTile(r.price_usd),
    mc: usdTile(r.mc_usd),
    vol: usdTile(r.vol_24h_usd),
    liq: usdTile(r.liq_usd),
    holders: count(r.holders),
    age: age(r.created_s, nowMs),
    chg: change24(r.chg_24h_bps),
    chgTile: changeTile(r.chg_24h_bps),
    launchpad: r.launchpad ?? null,
    chain: r.chain,
    curve: curve(r),
  };
}
