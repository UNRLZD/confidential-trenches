// The safety grid's cells as pure functions of one token read (card app-trade-box-mount), after R5's riskGrid (research
// repo design/proto at design-lock-r5: assets/token.js U.riskGrid, assets/app.js P.riskCells and P.pctS): 4 columns x 3
// rows, label over value, the value in its verdict's colour. A value the read does not hold is the dash, never a guess.
// The row's own fields come first (top 10, dev, snipers, holders, liquidity, age, the two authorities); what the row
// lacks (insiders, tax, LP, honeypot) comes from the token read's `risk` part (06b `risk`: a `Field` is `{ v, src, as_of_ms }`).
import { age, count, DASH, usd } from "../discover/format.ts";
import type { MarketRow } from "../discover/fields.ts";
import { curve } from "../market/curve.ts";
import type { WordId } from "./words.ts";

/** The token read's `risk` part as far as the grid reads it. A field the read leaves out is unknown. */
export type RiskRead = Partial<Record<"insiders_bps" | "tax" | "lp" | "honeypot", { v?: unknown } | null | undefined>>;

/** plain: no verdict; warn: amber; bad: coral; unknown: no value. The first three cells draw plain as `good` (green). */
export type Tone = "good" | "plain" | "warn" | "bad" | "unknown";
export type Icon = "check" | "x" | "dev" | "sniper";

export interface Cell {
  /** The label's word. */
  id: WordId;
  /** The value as drawn: data, or empty when it is an icon alone (the authorities and honeypot) or a word. */
  text: string;
  /** The value when it is one of the owner's words (the LP class `Curve`). */
  word?: WordId;
  icon: Icon | null;
  tone: Tone;
}

/** A share in basis points as R5's P.pctS draws a percent: 22.98% is 23%, 5.1% is 5.1%, a trace is <0.1%, all of it 100%. */
export function pct(bps: number): string {
  const v = bps / 100;
  if (v >= 99.95) return "100%";
  if (v < 0.05 && v > 0) return "<0.1%";
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)}%`;
}

const share = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : null);

/** VN-10 (R5 TH2): amber at the line, coral at one and a half times it; percents of the supply. */
const LINE = { top10: 30, dev: 10, snipers: 10, insiders: 10 } as const;
const level = (line: number, bps: number): Tone => (bps / 100 >= line * 1.5 ? "bad" : bps / 100 >= line ? "warn" : "plain");

function shareCell(id: "top10" | "dev" | "snipers" | "insiders", v: unknown, icon: (bps: number | null) => Icon | null): Cell {
  const bps = share(v);
  return { id, text: bps === null ? DASH : pct(bps), icon: icon(bps), tone: bps === null ? "unknown" : level(LINE[id], bps) };
}

/** An authority the token still has is a risk: `true` is present, `false` is gone. Drawn as a circled check or cross. */
function authCell(id: "mintAuth" | "freezeAuth", v: unknown): Cell {
  if (typeof v !== "boolean") return { id, text: DASH, icon: null, tone: "unknown" };
  return { id, text: "", icon: v ? "x" : "check", tone: v ? "bad" : "plain" };
}

const valueOf = (f: { v?: unknown } | null | undefined): unknown => (typeof f === "object" && f !== null ? f.v : undefined);

/** The twelve cells, in R5's order. `nowMs` is the clock the age is drawn against. */
export function safetyCells(row: MarketRow, risk: RiskRead | null | undefined, nowMs: number): Cell[] {
  const r = risk ?? {};
  const top10 = shareCell("top10", row.top10_bps, (b) => (b === null ? null : b / 100 >= LINE.top10 ? "x" : "check"));
  const dev = shareCell("dev", row.dev_bps, () => "dev");
  const snipers = shareCell("snipers", row.snipers_bps, () => "sniper");
  const insiders = shareCell("insiders", valueOf(r.insiders_bps), () => null);
  const plain = (id: "holders" | "liq" | "age", text: string): Cell => ({ id, text, icon: null, tone: text === DASH ? "unknown" : "plain" });
  // the transfer fee on a buy or a sell, whichever is higher; none is 0%
  const fee = valueOf(r.tax) as { buy_bps?: unknown; sell_bps?: unknown } | null | undefined;
  const buy = share(fee?.buy_bps);
  const sell = share(fee?.sell_bps);
  const taxBps = buy === null || sell === null ? null : Math.max(buy, sell);
  const tax: Cell = { id: "tax", text: taxBps === null ? DASH : taxBps === 0 ? "0%" : pct(taxBps), icon: null, tone: taxBps === null ? "unknown" : taxBps === 0 ? "plain" : "warn" };
  // the LP class: a token on its launchpad's curve is `Curve`; the other classes have no read yet
  const lpClass = (valueOf(r.lp) as { class?: unknown } | null | undefined)?.class;
  const lp: Cell = lpClass === "curve" && curve(row).on ? { id: "lp", text: "", word: "lpCurve", icon: null, tone: "plain" } : { id: "lp", text: DASH, icon: null, tone: "unknown" };
  const hp = valueOf(r.honeypot);
  const honeypot: Cell = typeof hp === "boolean" ? { id: "honeypot", text: "", icon: hp ? "x" : "check", tone: hp ? "bad" : "plain" } : { id: "honeypot", text: DASH, icon: null, tone: "unknown" };
  return [
    top10,
    dev,
    snipers,
    plain("holders", count(row.holders)),
    plain("liq", usd(row.liq_usd)),
    plain("age", age(row.created_s, nowMs)),
    insiders,
    tax,
    authCell("mintAuth", row.mint_auth),
    authCell("freezeAuth", row.freeze_auth),
    lp,
    honeypot,
  ];
}

/** The grid draws the first three cells' plain verdict green (R5 `i < 3 && tone === "" ? "good"`). */
export const toneAt = (i: number, c: Cell): Tone => (i < 3 && c.tone === "plain" ? "good" : c.tone);
