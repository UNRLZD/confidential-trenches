// The chart legend's text (R5 token.js U.legend) and the room each value takes (card app-legend-holds-still). A value
// that changes length on a tick or under the crosshair moved every value after it on the row (live run 42482964400:
// span.tkp-lgkv 355 -> 349 at +1808 ms), so each value is drawn in a box as wide as the longest text it takes on any bar
// read, in the legend's monospace digits. Display only: nothing here feeds a signature.
import { useRef } from "react";
import type { Bar } from "./candles.ts";
import { valueText } from "./units.ts";
import type { ChartUnit } from "./units.ts";

const MINUS = "−";

export interface LegendText {
  o: string;
  h: string;
  l: string;
  c: string;
  /** The close against the bar before it: +$0.12 (+1.05%). */
  ch: string;
  dir: "up" | "down";
}

/** Bar `i`'s legend: its prices in `unit` at `precision`, and its colour, its close against the bar before it. */
export function legendText(bars: readonly Bar[], i: number, precision: number, unit: ChartUnit): LegendText {
  const k = bars[i]!;
  const prev = bars[i - 1] ?? k;
  const p = (x: number) => valueText(unit, x.toFixed(precision));
  const d = k.close - prev.close;
  const pc = prev.close ? (d / prev.close) * 100 : 0;
  const ch = `${d >= 0 ? "+" : MINUS}${p(Math.abs(d))} (${pc >= 0 ? "+" : MINUS}${Math.abs(pc).toFixed(2)}%)`;
  return { o: p(k.open), h: p(k.high), l: p(k.low), c: p(k.close), ch, dir: k.close >= prev.close ? "up" : "down" };
}

/** Each value's room in characters: the longest it takes on any bar of `bars`. */
export type LegendRoom = Record<"o" | "h" | "l" | "c" | "ch", number>;

const len = (s: string) => [...s].length;

export function legendRoom(bars: readonly Bar[], precision: number, unit: ChartUnit): LegendRoom {
  const r: LegendRoom = { o: 0, h: 0, l: 0, c: 0, ch: 0 };
  for (let i = 0; i < bars.length; i++) {
    const t = legendText(bars, i, precision, unit);
    for (const k of ["o", "h", "l", "c", "ch"] as const) r[k] = Math.max(r[k], len(t[k]));
  }
  return r;
}

/** The room kept: it only grows while the legend shows one token at one timeframe in one unit, so a resync that drops the
 *  oldest bars, or a tick back to a shorter price, moves nothing; another token, timeframe or unit starts again. */
export function keepRoom(kept: { key: string; room: LegendRoom } | null, key: string, room: LegendRoom): { key: string; room: LegendRoom } {
  if (kept === null || kept.key !== key) return { key, room };
  const r = { ...room };
  for (const k of Object.keys(r) as (keyof LegendRoom)[]) r[k] = Math.max(r[k], kept.room[k]);
  return { key, room: r };
}

/** The most characters Discover's `price` draws for a price the size of `text` (one it drew): below $1 it cuts the
 *  trailing zeros of its digits ($0.0012 for $0.00120, $0.0₃12 for $0.0₃120), so the room is the form with them whole
 *  (three digits; four places from $0.01); from $1 its places are fixed and the room is the text. */
export function priceRoom(text: string): number {
  const sub = /^(\$?0\.0[₀-₉]+)\d*$/.exec(text);
  if (sub) return len(sub[1]!) + 3;
  const small = /^(\$?0\.)(0*)\d*$/.exec(text);
  if (small) return small[2]!.length >= 2 ? len(small[1]!) + small[2]!.length + 3 : len(small[1]!) + 4;
  return len(text);
}

/** `n` characters, kept as the most seen while `key` stays the same (one token's page): a value that grows once holds
 *  that room from then on. */
export function useRoom(key: string | null | undefined, n: number): number {
  const kept = useRef<{ key: string | null | undefined; n: number }>({ key, n });
  kept.current = kept.current.key === key ? { key, n: Math.max(n, kept.current.n) } : { key, n };
  return kept.current.n;
}
