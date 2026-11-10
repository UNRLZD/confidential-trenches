// Discover's column filter panel as pure functions (card app-discover-filter-panel; 09-design-brief CN-137, drawn after
// design-lock-r5 discover-ui.js P.FILTERS, P.d7filter and P.filterPanel). One panel per column, kept on this device with
// the toolbar's view; it narrows the rows the helper already served (GET /v1/market/lists takes only `chain`, so no
// filter is sent and no new request is made). Display only: nothing here feeds a signature.
//
// Every control reads a field the helper serves on Discover's rows (fields.ts; apps/helper/src/data/solana/lists.ts and
// evm/lists.ts). R5's Snipers % (snipers_bps) and Dev sold (creator_sold_bps) are left out: no chain serves either yet
// (card discover-rows-creator-snipers), and R5 draws no unavailable control. A row that does not carry a control's field
// (null, absent, or not a number) is never hidden by that control (M160 N4; R5 P.d7filter): Base and Robinhood serve no
// holders, Top 10 or dev, so those controls narrow Solana's rows only.
import type { MarketRow, MarketSnapshot } from "./fields.ts";
import { SNAPSHOT_LISTS } from "./fields.ts";
import { COLUMNS, columnRows } from "./model.ts";
import type { ColumnKey } from "./model.ts";
import { padKey } from "./view.ts";
import type { WordId } from "./words.ts";
import { compact } from "./format.ts";
import { onCurve } from "../market/curve.ts";
import { padOf, PADS } from "../market/pads.ts";

export type FilterKey = "curve" | "age" | "mc" | "liq" | "vol5" | "vol1" | "tx5" | "b5" | "s5" | "hold" | "top10" | "dev";
/** R5's units: `$` before, `%` and `m` (minutes) after, none for a count. */
export type Unit = "$" | "%" | "m" | "";

export interface Range {
  min?: number;
  max?: number;
}

export interface ColFilter {
  /** Picked launchpads as `chain:launchpad` (view.ts padKey). */
  pads: readonly string[];
  ranges: Partial<Record<FilterKey, Range>>;
}

export type Filters = Record<ColumnKey, ColFilter>;

export interface Control {
  k: FilterKey;
  label: WordId;
  unit: Unit;
  /** The served Row fields it reads. */
  fields: readonly (keyof MarketRow)[];
  section: "curve" | "metrics" | "audit";
  /** The row's value in the control's unit, or null when the row does not carry it. */
  value: (r: MarketRow, nowMs: number) => number | null;
}

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const dec = (v: unknown): number | null => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null);
const pct = (v: unknown): number | null => (n(v) === null ? null : (v as number) / 100);

/** R5 P.FILTERS, its order, without the two unserved controls. */
export const CONTROLS: readonly Control[] = [
  { k: "curve", label: "fCurve", unit: "%", fields: ["curve_bps"], section: "curve", value: (r) => (onCurve(r) ? r.curve_bps! / 100 : null) },
  { k: "age", label: "fAge", unit: "m", fields: ["created_s"], section: "metrics", value: (r, now) => (n(r.created_s) === null ? null : (Math.floor(now / 1000) - r.created_s!) / 60) },
  { k: "mc", label: "mc", unit: "$", fields: ["mc_usd"], section: "metrics", value: (r) => dec(r.mc_usd) },
  { k: "liq", label: "fLiq", unit: "$", fields: ["liq_usd"], section: "metrics", value: (r) => dec(r.liq_usd) },
  { k: "vol5", label: "fVol5", unit: "$", fields: ["vol_5m_usd"], section: "metrics", value: (r) => dec(r.vol_5m_usd) },
  { k: "vol1", label: "fVol1", unit: "$", fields: ["vol_1h_usd"], section: "metrics", value: (r) => dec(r.vol_1h_usd) },
  { k: "tx5", label: "fTx5", unit: "", fields: ["buys_5m", "sells_5m"], section: "metrics", value: (r) => (n(r.buys_5m) === null || n(r.sells_5m) === null ? null : r.buys_5m! + r.sells_5m!) },
  { k: "b5", label: "fB5", unit: "", fields: ["buys_5m"], section: "metrics", value: (r) => n(r.buys_5m) },
  { k: "s5", label: "fS5", unit: "", fields: ["sells_5m"], section: "metrics", value: (r) => n(r.sells_5m) },
  { k: "hold", label: "holders", unit: "", fields: ["holders"], section: "metrics", value: (r) => n(r.holders) },
  { k: "top10", label: "fTop10", unit: "%", fields: ["top10_bps"], section: "audit", value: (r) => pct(r.top10_bps) },
  { k: "dev", label: "fDev", unit: "%", fields: ["dev_bps"], section: "audit", value: (r) => pct(r.dev_bps) },
];

/** The controls a column's panel draws: Curve progress on Graduating only (R5 `grad`). */
export const controlsFor = (col: ColumnKey): Control[] => CONTROLS.filter((c) => c.section !== "curve" || col === "graduating");

export const COL_FILTER0: ColFilter = { pads: [], ranges: {} };
export const FILTERS0: Filters = Object.fromEntries(COLUMNS.map((c) => [c.key, COL_FILTER0])) as Filters;

const setRange = (r: Range | undefined): r is Range => !!r && (r.min !== undefined || r.max !== undefined);

/** Whether the panel narrows anything (R5's dot on the funnel). */
export const filterOn = (f: ColFilter): boolean => f.pads.length > 0 || Object.values(f.ranges).some(setRange);

/** Whether a row passes a column's panel. */
export function keeps(r: MarketRow, f: ColFilter, nowMs: number): boolean {
  if (f.pads.length) {
    const k = padKey(r);
    if (k === null || !f.pads.includes(k)) return false;
  }
  for (const c of CONTROLS) {
    const v = f.ranges[c.k];
    if (!setRange(v)) continue;
    const x = c.value(r, nowMs);
    if (x === null) continue;
    if (v.min !== undefined && x < v.min) return false;
    if (v.max !== undefined && x > v.max) return false;
  }
  return true;
}

export const filterRows = (rows: readonly MarketRow[], f: ColFilter, nowMs: number): MarketRow[] => rows.filter((r) => keeps(r, f, nowMs));

const MULT: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/** A bound as typed: null when empty (unset), undefined when it is not an amount (the box is flagged and nothing is kept). */
export function parseBound(text: string, unit: Unit): number | null | undefined {
  let t = text.trim().replace(/[$,%\s]/g, "").toLowerCase();
  if (!text.trim()) return null;
  if (unit === "m") t = t.replace(/m$/, "");
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/.exec(t);
  if (!m || (unit === "m" && m[2])) return undefined;
  const v = Number(m[1]) * (m[2] ? MULT[m[2]]! : 1);
  return Number.isFinite(v) ? v : undefined;
}

/** A set bound as R5 draws it in its box: $10K, 25%, 5m, 800. */
export function boundText(v: number, unit: Unit): string {
  const num = v >= 1000 ? compact(v).replace(/\.?0+(?=[KMBT]$)/, "") : String(Math.round(v * 100) / 100);
  return unit === "$" ? `$${num}` : unit === "%" || unit === "m" ? `${num}${unit}` : num;
}

const KEYS = new Set<string>(CONTROLS.map((c) => c.k));
const bound = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

function readCol(raw: unknown, col: ColumnKey): ColFilter {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return COL_FILTER0;
  const o = raw as Record<string, unknown>;
  const pads = Array.isArray(o.pads) ? o.pads.filter((p): p is string => typeof p === "string" && /^[a-z]+:.+/.test(p)).slice(0, 64) : [];
  const ranges: ColFilter["ranges"] = {};
  const rs = typeof o.ranges === "object" && o.ranges !== null ? (o.ranges as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(rs)) {
    if (!KEYS.has(k) || (k === "curve" && col !== "graduating") || typeof v !== "object" || v === null) continue;
    const r: Range = {};
    const min = bound((v as Range).min), max = bound((v as Range).max);
    if (min !== undefined) r.min = min;
    if (max !== undefined) r.max = max;
    if (setRange(r)) ranges[k as FilterKey] = r;
  }
  return pads.length || Object.keys(ranges).length ? { pads, ranges } : COL_FILTER0;
}

/** Stored filters, read back: anything not a panel is the unset panel. */
export function readFilters(raw: unknown): Filters {
  const o = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(COLUMNS.map((c) => [c.key, readCol(o[c.key], c.key)])) as Filters;
}

/** R5's chain order in the panel. */
const CHAIN_ORDER = ["solana", "near", "base", "robinhood"] as const;
const PAD_ORDER = Object.keys(PADS);

export interface PanelPad {
  key: string;
  launchpad: string;
  /** Its tokens in this column. */
  count: number;
}

/**
 * The panel's Launchpad section (R5 chainBlock and padRows): every launchpad the pad table names on Discover's lists now,
 * under each chain it is on, in the table's order, with its count in this column (0 drawn); on Graduating only the
 * launchpads with a token on a curve. A picked launchpad no list holds now stays listed, so it can be cleared.
 */
export function panelPads(s: MarketSnapshot, col: ColumnKey, picked: readonly string[] = []): { chain: string; entries: PanelPad[] }[] {
  const keys = new Set<string>();
  for (const name of SNAPSHOT_LISTS)
    for (const r of s.lists[name] ?? []) {
      const k = padKey(r);
      if (k !== null && padOf(r.launchpad) && (col !== "graduating" || onCurve(r))) keys.add(k);
    }
  for (const p of picked) keys.add(p);
  const counts = new Map<string, number>();
  for (const r of columnRows(s, col)) {
    const k = padKey(r);
    if (k !== null) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const split = (k: string) => [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)] as const;
  return CHAIN_ORDER.map((chain) => ({
    chain,
    entries: [...keys]
      .filter((k) => split(k)[0] === chain && padOf(split(k)[1]))
      .sort((a, b) => PAD_ORDER.indexOf(split(a)[1]) - PAD_ORDER.indexOf(split(b)[1]))
      .map((k) => ({ key: k, launchpad: split(k)[1], count: counts.get(k) ?? 0 })),
  })).filter((g) => g.entries.length > 0);
}

/** The chains whose rows on the lists now carry a control's field (R5 `serves`: named in the control's hover where not all). */
export function servedOn(s: MarketSnapshot, c: Control): { all: boolean; chains: string[] } {
  const on = new Set<string>(), seen = new Set<string>();
  for (const name of SNAPSHOT_LISTS)
    for (const r of s.lists[name] ?? []) {
      seen.add(r.chain);
      if (c.fields.every((f) => r[f] !== null && r[f] !== undefined)) on.add(r.chain);
    }
  const chains = [...seen].filter((x) => on.has(x));
  return { all: chains.length === seen.size, chains };
}
