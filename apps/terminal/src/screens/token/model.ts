// The token page's drawn values as pure functions of a 06b `Row` (src/screens/discover/fields.ts). Numbers are drawn
// as Discover draws them (format.ts), so one token reads the same on both screens. The curve rule, one for every screen,
// is in ../market/curve.ts.
import type { MarketRow } from "../discover/fields.ts";
import { age, count, DASH, price, usd } from "../discover/format.ts";
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

export interface TokenView {
  token: string;
  symbol: string;
  /** Empty when it repeats the symbol. */
  name: string;
  price: string;
  mc: string;
  vol: string;
  liq: string;
  holders: string;
  age: string;
  chg: { text: string; dir: Dir };
  launchpad: string | null;
  curve: Curve;
}

/** The page's values for one token. `nowMs` is the clock the age is drawn against. */
export function tokenView(r: MarketRow, nowMs: number): TokenView {
  return {
    token: r.token,
    symbol: r.symbol,
    name: r.name && r.name !== r.symbol ? r.name : "",
    price: price(r.price_usd),
    mc: usd(r.mc_usd),
    vol: usd(r.vol_24h_usd),
    liq: usd(r.liq_usd),
    holders: count(r.holders),
    age: age(r.created_s, nowMs),
    chg: change24(r.chg_24h_bps),
    launchpad: r.launchpad ?? null,
    curve: curve(r),
  };
}
