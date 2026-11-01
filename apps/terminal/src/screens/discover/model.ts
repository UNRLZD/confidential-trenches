// Discover's columns and rows as pure functions of a 06b snapshot (fields.ts). The four columns and their order are
// the owner's (round 15, docs/owner-decisions.md:174; 09-design-brief S5 Columns v2.0.6): New, Trending (the 1h
// ranking), Hot (the 5m ranking) and Graduating (still on a launchpad curve, highest progress first). Hot and Trending
// order by the window's USD volume, ties by trade count, and list only tokens traded in the window (R5
// design/proto/assets/discover-ui.js at design-lock-r5, after 06c's own-ranking rule). Risk lines are 06b's flag rule
// (v1.20): amber at the line, coral at 1.5 x, a null field grey and never a pass.
import type { MarketRow, MarketSnapshot } from "./fields.ts";
import { age, change, count, DASH, price, usd } from "./format.ts";
import { onCurve } from "../market/curve.ts";

export type ColumnKey = "new" | "trending" | "hot" | "graduating";
export type Win = "5m" | "1h";

export const COLUMNS: readonly { key: ColumnKey; win: Win }[] = [
  { key: "new", win: "5m" },
  { key: "trending", win: "1h" },
  { key: "hot", win: "5m" },
  { key: "graduating", win: "5m" },
];

const num = (v: string | null | undefined) => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : 0);

/** One row per token, the first seen kept. */
function unique(rows: readonly MarketRow[]): MarketRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.token) ? false : (seen.add(r.token), true)));
}

/** The rows a column draws, in its order. */
export function columnRows(s: MarketSnapshot, key: ColumnKey): MarketRow[] {
  const L = s.lists;
  if (key === "new") return unique(L.new).sort((a, b) => (b.created_s ?? -Infinity) - (a.created_s ?? -Infinity));
  if (key === "graduating") return unique(L.graduating ?? []).filter(onCurve).sort((a, b) => b.curve_bps! - a.curve_bps!);
  const fiveMin = key === "hot";
  const vol = (r: MarketRow) => num(fiveMin ? r.vol_5m_usd : r.vol_1h_usd);
  const trades = (r: MarketRow) => (fiveMin ? (r.buys_5m ?? 0) + (r.sells_5m ?? 0) : 0);
  const list = fiveMin ? (L.trending_5m ?? []) : (L.trending_1h ?? L.trending);
  return unique(list).filter((r) => vol(r) > 0).sort((a, b) => vol(b) - vol(a) || trades(b) - trades(a));
}

export type Level = "none" | "warn" | "sell";
const LINE = { top10: 3000, dev: 1000, snipers: 1000 } as const;

/** 06b's flag rule for a share in basis points. */
export function level(bps: number | null | undefined, kind: keyof typeof LINE): Level {
  if (typeof bps !== "number" || !Number.isFinite(bps)) return "none";
  return bps >= LINE[kind] * 1.5 ? "sell" : bps >= LINE[kind] ? "warn" : "none";
}

const share = (bps: number | null | undefined, dp: number) => (typeof bps === "number" && Number.isFinite(bps) ? `${(bps / 100).toFixed(dp)}%` : DASH);

export interface RowView {
  token: string;
  symbol: string;
  /** Empty when it repeats the symbol. */
  name: string;
  price: string;
  mc: string;
  vol: string;
  chg: string;
  /** "up", "down" or "none", for the change's colour. */
  dir: "up" | "down" | "none";
  age: string;
  /** Launched within 30 minutes. */
  fresh: boolean;
  buys: string;
  sells: string;
  /** The window's buy share 0-1, or null with no trade known. */
  buyShare: number | null;
  holders: string;
  top10: { text: string; level: Level };
  dev: { text: string; level: Level };
  snipers: { text: string; level: Level };
  /** The ring and its pill: a curve's percent (cut down), POOL when listed, the dash when the stage is unknown. */
  stage: { pill: string; fill: number; curve: boolean };
  launchpad: string | null;
}

/** A row's drawn values for a window. Row carries buys and sells for 5m only, so the 1h window draws them as the dash. */
export function rowView(r: MarketRow, win: Win, nowMs: number): RowView {
  const c = win === "1h" ? r.chg_1h_bps : r.chg_5m_bps;
  const b = win === "5m" ? r.buys_5m : null;
  const s = win === "5m" ? r.sells_5m : null;
  const known = typeof b === "number" && typeof s === "number";
  const created = typeof r.created_s === "number" ? Math.floor(nowMs / 1000) - r.created_s : null;
  const stage = onCurve(r)
    ? { pill: `${Math.floor(r.curve_bps! / 100)}%`, fill: r.curve_bps! / 10000, curve: true }
    : typeof r.curve_bps === "number" || r.launchpad === null
      ? { pill: "POOL", fill: 1, curve: false }
      : { pill: DASH, fill: 0, curve: false };
  return {
    token: r.token,
    symbol: r.symbol,
    name: r.name && r.name !== r.symbol ? r.name : "",
    price: price(r.price_usd),
    mc: usd(r.mc_usd),
    vol: usd(win === "1h" ? r.vol_1h_usd : r.vol_5m_usd),
    chg: change(c, win),
    dir: typeof c !== "number" ? "none" : c >= 0 ? "up" : "down",
    age: age(r.created_s, nowMs),
    fresh: created !== null && created < 1800,
    buys: known ? count(b) : DASH,
    sells: known ? count(s) : DASH,
    buyShare: known && b! + s! > 0 ? b! / (b! + s!) : null,
    holders: count(r.holders),
    top10: { text: typeof r.top10_bps === "number" ? `${Math.round(r.top10_bps / 100)}%` : DASH, level: level(r.top10_bps, "top10") },
    dev: { text: share(r.dev_bps, 1), level: level(r.dev_bps, "dev") },
    snipers: { text: typeof r.snipers_bps === "number" ? `${Math.round(r.snipers_bps / 100)}%` : DASH, level: level(r.snipers_bps, "snipers") },
    stage,
    launchpad: r.launchpad,
  };
}
