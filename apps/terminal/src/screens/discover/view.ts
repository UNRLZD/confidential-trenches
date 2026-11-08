// Discover's toolbar as pure functions (card app-discover-toolbar; 09-design-brief S5 Presets, Filter chips, Column
// search, Pause, Quick-buy amount; drawn after design-lock-r5 discover-1440.html and discover-390.html). Every control
// reads a field the helper serves on Discover's rows (fields.ts, apps/helper/src/data/solana/lists.ts) and runs on this
// device only: nothing here is sent, and nothing here feeds a signature. A field a row does not carry (null or absent) is
// never read as a flag or a fail: "an unknown is not a flag" (S5 Presets), and a row without a control's field is not
// filtered by that control (M160 N4). Not here: `No creator dumps` (creator_sold_bps is null on every served row),
// `Following` and the watchlist (no row field), the column filter panel (card app-discover-filter-panel).
import type { MarketRow, MarketSnapshot } from "./fields.ts";
import { SNAPSHOT_LISTS } from "./fields.ts";
import { columnRows, level } from "./model.ts";
import type { ColumnKey } from "./model.ts";
import { padOf } from "../market/pads.ts";

/** 6b `views.preset` (M168 (5)): `all`, or `fewer_flags`. */
export type Preset = "all" | "fewer_flags";

/** The toolbar's view: one preset, the `mc_10k` chip (6b `views.chips`), and the picked launchpads as `chain:launchpad`. */
export interface View {
  preset: Preset;
  mc10k: boolean;
  pads: readonly string[];
}

export const VIEW0: View = { preset: "all", mc10k: false, pads: [] };

/** A known flag on the row: Top 10 or dev at or over its line (06b's flag rule, the row's own pills). Snipers is not
 *  read: snipers_bps is null on every served row (lists.ts), so it joins with the markets card that serves it. */
export const flagged = (r: MarketRow): boolean => level(r.top10_bps, "top10") !== "none" || level(r.dev_bps, "dev") !== "none";

/** The `MC ≥ $10K` chip's line, in USD. */
export const MC_LINE = 10_000;

/** The row's served MC in USD, or null when it serves none (a decimal string on the wire, 06b). */
function mcOf(r: MarketRow): number | null {
  const v = r.mc_usd;
  return typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null;
}

/** A launchpad's key in the menu and the view: its chain and its served id. */
export const padKey = (r: Pick<MarketRow, "chain" | "launchpad">): string | null => (r.launchpad === null ? null : `${r.chain}:${r.launchpad}`);

/** Whether a row passes the toolbar's view. */
export function passes(r: MarketRow, v: View): boolean {
  if (v.preset === "fewer_flags" && flagged(r)) return false;
  if (v.mc10k) {
    const mc = mcOf(r);
    if (mc !== null && mc < MC_LINE) return false;
  }
  if (v.pads.length) {
    const k = padKey(r);
    if (k === null || !v.pads.includes(k)) return false;
  }
  return true;
}

/** The column search (S5.14): a symbol or a name holding the text, any case; an empty search keeps every row. */
export function matches(r: MarketRow, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return r.symbol.toLowerCase().includes(t) || r.name.toLowerCase().includes(t);
}

/** The rows a column draws under the toolbar's view and its own search, in the column's order. */
export const viewRows = (rows: readonly MarketRow[], v: View, q = ""): MarketRow[] => rows.filter((r) => passes(r, v) && matches(r, q));

/** Whether the view narrows anything. */
export const narrowed = (v: View): boolean => v.preset !== "all" || v.mc10k || v.pads.length > 0;

export interface PadEntry {
  key: string;
  chain: string;
  launchpad: string;
  count: number;
}

/**
 * The launchpad menu (R5 PadMenu, "by tokens now"): every launchpad on Discover's lists now, per chain, with its count of
 * tokens (each token once across the lists), most tokens first. A launchpad the pad table cannot name is not listed, since
 * a raw id is never drawn (market/pads.ts).
 */
export function padEntries(s: MarketSnapshot): PadEntry[] {
  const seen = new Set<string>();
  const counts = new Map<string, PadEntry>();
  for (const name of SNAPSHOT_LISTS)
    for (const r of s.lists[name] ?? []) {
      if (seen.has(r.token)) continue;
      seen.add(r.token);
      const key = padKey(r);
      if (key === null || !padOf(r.launchpad)) continue;
      const e = counts.get(key) ?? { key, chain: r.chain, launchpad: r.launchpad!, count: 0 };
      e.count++;
      counts.set(key, e);
    }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** While paused: how many tokens the live list has that the held one does not. */
export function pendingNew(live: MarketSnapshot, held: MarketSnapshot, k: ColumnKey): number {
  const had = new Set(columnRows(held, k).map((r) => r.token));
  return columnRows(live, k).filter((r) => !had.has(r.token)).length;
}

/** The Quick buy amount's default (VN-04's presets, the design's `$25`). */
export const QB_DEFAULT = "25";

/** A Quick buy amount as typed: a positive USD amount, at most 7 digits and 2 decimals; else null (the field is flagged). */
export function qbAmount(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

/** A stored view, read back: anything not a view is the default. */
export function readView(raw: unknown): View {
  if (typeof raw !== "object" || raw === null) return VIEW0;
  const o = raw as Record<string, unknown>;
  return {
    preset: o.preset === "fewer_flags" ? "fewer_flags" : "all",
    mc10k: o.mc10k === true,
    pads: Array.isArray(o.pads) ? o.pads.filter((p): p is string => typeof p === "string" && /^[a-z]+:.+/.test(p)).slice(0, 64) : [],
  };
}
