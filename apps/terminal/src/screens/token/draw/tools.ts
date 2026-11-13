/**
 * Chart drawing tools, the live UNRLZD terminal's (apps/terminal/src/screens/trenches/center/chart/draw/tools.ts there;
 * owner 12 Nov: chart drawing tools on par). There: GMGN / TradingView parity, user request 2026-09-30:
 * the catalogue the left toolbar shows, and the pure maths the custom overlays label with.
 * Built-in KLineChart overlays where one exists; ours (overlays.ts) for rectangle, measure, text
 * note, arrow marks and a unit-free fib retracement (the built-in one prints 12-decimal NEAR
 * prices, which read wrong while the axis shows market cap).
 */
import { WORDS } from "../words.ts";

const MINUS = "\u2212";

export type CrossMode = "cross" | "dot" | "arrow";
export const CROSS_MODES: readonly { id: CrossMode; label: string }[] = [
  { id: "cross", label: WORDS.dCross.text },
  { id: "dot", label: WORDS.dDot.text },
  { id: "arrow", label: WORDS.dArrow.text },
];

/** KLineChart overlay modes; the magnet button cycles through them */
export type MagnetMode = "normal" | "weak_magnet" | "strong_magnet";
export const MAGNET_CYCLE: readonly MagnetMode[] = ["normal", "weak_magnet", "strong_magnet"];
export function nextMagnet(m: MagnetMode): MagnetMode {
  const i = MAGNET_CYCLE.indexOf(m);
  return MAGNET_CYCLE[(i + 1) % MAGNET_CYCLE.length] as MagnetMode;
}
export const MAGNET_LABEL: Record<MagnetMode, string> = {
  normal: WORDS.dMagnetOff.text,
  weak_magnet: WORDS.dMagnetWeak.text,
  strong_magnet: WORDS.dMagnetStrong.text,
};

export type ToolGroup = "lines" | "shapes" | "marks";

export type DrawIconKey =
  | "trend"
  | "ray"
  | "extended"
  | "hline"
  | "hray"
  | "vline"
  | "channel"
  | "fib"
  | "rect"
  | "measure"
  | "text"
  | "arrowUp"
  | "arrowDown";

export interface DrawTool {
  id: string;
  /** KLineChart overlay name (built-in or registered in overlays.ts) */
  overlay: string;
  label: string;
  icon: DrawIconKey;
  group: ToolGroup;
}

export const DRAW_GROUP = "nt-draw";

export const CUSTOM_OVERLAYS = [
  "ntRect",
  "ntMeasure",
  "ntText",
  "ntArrowUp",
  "ntArrowDown",
  "ntFib",
] as const;
export const BUILTIN_OVERLAYS = [
  "segment",
  "rayLine",
  "straightLine",
  "horizontalStraightLine",
  "horizontalRayLine",
  "verticalStraightLine",
  "parallelStraightLine",
] as const;

export const DRAW_TOOLS: readonly DrawTool[] = [
  { id: "trend", overlay: "segment", label: WORDS.dTrend.text, icon: "trend", group: "lines" },
  { id: "ray", overlay: "rayLine", label: WORDS.dRay.text, icon: "ray", group: "lines" },
  {
    id: "extended",
    overlay: "straightLine",
    label: WORDS.dExtended.text,
    icon: "extended",
    group: "lines",
  },
  {
    id: "hline",
    overlay: "horizontalStraightLine",
    label: WORDS.dHline.text,
    icon: "hline",
    group: "lines",
  },
  {
    id: "hray",
    overlay: "horizontalRayLine",
    label: WORDS.dHray.text,
    icon: "hray",
    group: "lines",
  },
  {
    id: "vline",
    overlay: "verticalStraightLine",
    label: WORDS.dVline.text,
    icon: "vline",
    group: "lines",
  },
  {
    id: "channel",
    overlay: "parallelStraightLine",
    label: WORDS.dChannel.text,
    icon: "channel",
    group: "lines",
  },
  { id: "fib", overlay: "ntFib", label: WORDS.dFib.text, icon: "fib", group: "shapes" },
  { id: "rect", overlay: "ntRect", label: WORDS.dRect.text, icon: "rect", group: "shapes" },
  { id: "measure", overlay: "ntMeasure", label: WORDS.dMeasure.text, icon: "measure", group: "shapes" },
  { id: "text", overlay: "ntText", label: WORDS.dText.text, icon: "text", group: "marks" },
  { id: "arrowUp", overlay: "ntArrowUp", label: WORDS.dArrowUp.text, icon: "arrowUp", group: "marks" },
  {
    id: "arrowDown",
    overlay: "ntArrowDown",
    label: WORDS.dArrowDown.text,
    icon: "arrowDown",
    group: "marks",
  },
];

export const toolById = (id: string | null): DrawTool | null =>
  DRAW_TOOLS.find((t) => t.id === id) ?? null;

/** every overlay name a saved drawing may carry */
export const KNOWN_OVERLAYS: ReadonlySet<string> = new Set([
  ...CUSTOM_OVERLAYS,
  ...BUILTIN_OVERLAYS,
]);

/** fib retracement levels (TV defaults, without the extensions) */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

/** "45s" · "14m" · "2h" · "2h 5m" · "3d" · "3d 4h" */
export function fmtDuration(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export interface MeasurePoint {
  value?: number | undefined;
  dataIndex?: number | undefined;
  timestamp?: number | undefined;
}

/** "+12.34% · 14 bars · 14m" between two points (from → to); parts that can't be known drop out */
export function measureLabel(a: MeasurePoint, b: MeasurePoint): string {
  const parts: string[] = [];
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (ok(a.value) && ok(b.value) && a.value !== 0) {
    const pct = ((b.value - a.value) / Math.abs(a.value)) * 100;
    parts.push(`${pct >= 0 ? "+" : MINUS}${Math.abs(pct).toFixed(2)}%`);
  }
  if (ok(a.dataIndex) && ok(b.dataIndex)) {
    const n = Math.abs(Math.round(b.dataIndex - a.dataIndex));
    parts.push(`${n} ${n === 1 ? "bar" : "bars"}`);
  }
  if (ok(a.timestamp) && ok(b.timestamp)) parts.push(fmtDuration(b.timestamp - a.timestamp));
  return parts.join(" · ");
}

/** the measure box is "up" (gain tint) when the second point is at or above the first */
export function measureUp(a: MeasurePoint, b: MeasurePoint): boolean {
  return (b.value ?? 0) >= (a.value ?? 0);
}

/** toolbar groups that can fold into one flyout button (in folding order) */
export type FoldGroup = "lines" | "marks" | "shapes";
const FOLD_ORDER: readonly FoldGroup[] = ["lines", "marks", "shapes"];
/** always-visible buttons: the cursor (crosshair modes) + magnet, lock, hide, delete all */
const FIXED_BUTTONS = 5;
/** px (DrawToolbar.module.css): gap between buttons, rule between groups (1px + margins), and
 * the column's vertical padding */
export const GAP_PX = 2;
export const SEP_PX = 7;
export const PAD_PX = 8;

/** column height for `n` buttons every `step` px (button + gap) with `seps` rules */
export const columnHeight = (n: number, step: number, seps: number) =>
  n * step - GAP_PX + seps * SEP_PX + PAD_PX;

/**
 * Which groups fold into a flyout so the column fits `height` px with buttons every `step` px
 * (TV groups its line tools the same way). Folds lines first, then marks, then shapes; if even
 * that doesn't fit, everything folds and the column scrolls.
 */
export function foldedGroups(height: number, step: number): Set<FoldGroup> {
  const size: Record<FoldGroup, number> = { lines: 0, marks: 0, shapes: 0 };
  for (const t of DRAW_TOOLS) size[t.group]++;
  const folded = new Set<FoldGroup>();
  const need = () =>
    columnHeight(
      FIXED_BUTTONS + FOLD_ORDER.reduce((n, g) => n + (folded.has(g) ? 1 : size[g]), 0),
      step,
      4,
    );
  for (const g of FOLD_ORDER) {
    if (need() <= height) return folded;
    folded.add(g);
  }
  return folded;
}
