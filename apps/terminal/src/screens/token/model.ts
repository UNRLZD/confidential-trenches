// The token page's drawn values as pure functions of a 06b `Row` (src/screens/discover/fields.ts). Numbers are drawn
// as Discover draws them (format.ts), so one token reads the same on both screens. The curve rule is J19's (app.md:552-555
// at research 3c95759; A2.2, app.md:1435): progress shows only for a token still on a launchpad curve (markets.md at
// f4e9633 :1546, :1560, :1576); any other token has no bar and the dash in the field.
import type { MarketRow } from "../discover/fields.ts";
import { age, count, DASH, price, usd } from "../discover/format.ts";

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

export interface Curve {
  /** Still on a launchpad curve: the bar shows. */
  on: boolean;
  /** The percent, cut down (64%), or the dash. */
  text: string;
  /** 0-1, the bar's fill; 0 when off. */
  fill: number;
}

const OFF: Curve = { on: false, text: DASH, fill: 0 };

/** On a curve: a launchpad, and a progress in whole basis points from 0 up to, not including, 10,000 (listed). */
export function curve(r: Pick<MarketRow, "launchpad" | "curve_bps">): Curve {
  const b = r.curve_bps;
  if (r.launchpad === null || r.launchpad === undefined) return OFF;
  if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b >= 10000) return OFF;
  return { on: true, text: `${Math.floor(b / 100)}%`, fill: b / 10000 };
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
