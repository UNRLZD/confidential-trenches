// The curve rule, one for every screen (J19, app.md:552-555 at research 3c95759; A2.2, app.md:1435): a token is on a
// launchpad curve only with a launchpad and a progress in whole basis points from 0 up to, not including, 10,000
// (listed). Discover's Graduating column and ring pill and the token page's curve field all read it here.
import type { MarketRow } from "../discover/fields.ts";
import { DASH } from "../discover/format.ts";

export interface Curve {
  /** Still on a launchpad curve: the bar shows. */
  on: boolean;
  /** The percent, cut down (64%), or the dash. */
  text: string;
  /** 0-1, the bar's fill; 0 when off. */
  fill: number;
}

const OFF: Curve = { on: false, text: DASH, fill: 0 };

export function curve(r: Pick<MarketRow, "launchpad" | "curve_bps">): Curve {
  const b = r.curve_bps;
  if (r.launchpad === null || r.launchpad === undefined) return OFF;
  if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b >= 10000) return OFF;
  return { on: true, text: `${Math.floor(b / 100)}%`, fill: b / 10000 };
}

export const onCurve = (r: Pick<MarketRow, "launchpad" | "curve_bps">): boolean => curve(r).on;
