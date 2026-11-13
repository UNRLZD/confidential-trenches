/**
 * 12×12 stroke icons for the chart drawing toolbar (drawn like components/icons.tsx: stroke
 * currentColor 1.25, round caps / joins). Chart-local: the shared icon set is not edited.
 */
import type { DrawIconKey } from "./tools.ts";

type Extra =
  | "cross"
  | "dot"
  | "arrow"
  | "magnet"
  | "lock"
  | "unlock"
  | "eye"
  | "eyeOff"
  | "trash"
  | "pencil"
  | "lines"
  | "expand"
  | "shrink"
  | "camera"
  | "reset";

export type ToolIconName = DrawIconKey | Extra;

const P: Record<ToolIconName, string[]> = {
  trend: ["M2 10L10 2", "M2 10h0", "M10 2h0"],
  ray: ["M2 10L10.5 1.5", "M2 10h0"],
  extended: ["M1 11L11 1", "M4 8h0", "M8 4h0"],
  hline: ["M1 6h10", "M6 6h0"],
  hray: ["M4 6h7.5", "M4 6h0"],
  vline: ["M6 1v10", "M6 6h0"],
  channel: ["M1.5 7.5L8 1.5", "M4 10.5L10.5 4.5"],
  fib: ["M1.5 2h9", "M1.5 4.7h9", "M1.5 7.3h9", "M1.5 10h9"],
  rect: ["M2 3h8v6H2z"],
  measure: ["M6 1.5v9", "M4 3.5L6 1.5l2 2", "M4 8.5l2 2 2-2", "M2 1.5h8", "M2 10.5h8"],
  text: ["M2.5 2.5h7", "M6 2.5v7.5", "M4.5 10h3"],
  arrowUp: ["M6 10.5V2", "M3 5l3-3 3 3"],
  arrowDown: ["M6 1.5V10", "M3 7l3 3 3-3"],
  cross: ["M6 1v10", "M1 6h10"],
  dot: ["M6 6h0", "M6 3.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5z"],
  arrow: ["M3 1.5l6 5.5-2.8.3 1.6 3.2-1.3.6-1.6-3.2L3 10z"],
  magnet: ["M3 2v4a3 3 0 006 0V2", "M3 4h2", "M7 4h2", "M5 2v4a1 1 0 002 0V2"],
  lock: ["M3 5.5h6v5H3z", "M4.5 5.5V4a1.5 1.5 0 013 0v1.5"],
  unlock: ["M3 5.5h6v5H3z", "M4.5 5.5V4a1.5 1.5 0 013-.5"],
  eye: [
    "M1 6s1.8-3.5 5-3.5S11 6 11 6s-1.8 3.5-5 3.5S1 6 1 6z",
    "M6 7.3a1.3 1.3 0 100-2.6 1.3 1.3 0 000 2.6z",
  ],
  eyeOff: ["M1 6s1.8-3.5 5-3.5S11 6 11 6s-1.8 3.5-5 3.5S1 6 1 6z", "M1.5 1.5l9 9"],
  trash: ["M2 3h8", "M4.5 3V2h3v1", "M3 3l.6 7.5h4.8L9 3"],
  pencil: ["M2 10l.5-2.5L8 2l2 2-5.5 5.5z", "M7 3l2 2"],
  lines: ["M1.5 10.5L10.5 1.5", "M1.5 6.5L6.5 1.5", "M5.5 10.5l5-5"],
  // chart top bar (fullscreen, screenshot)
  expand: ["M1.5 4.5v-3h3", "M7.5 1.5h3v3", "M10.5 7.5v3h-3", "M4.5 10.5h-3v-3"],
  shrink: ["M4.5 1.5v3h-3", "M10.5 4.5h-3v-3", "M7.5 10.5v-3h3", "M1.5 7.5h3v3"],
  camera: ["M1.5 4h2l1-1.5h3l1 1.5h2v6h-9z", "M6 5a2 2 0 110 4 2 2 0 010-4z"],
  // reset view: a counter-clockwise arrow (TradingView's "reset chart")
  reset: ["M1.5 6a4.5 4.5 0 104.5-4.5 4.9 4.9 0 00-3.37 1.37L1.5 4", "M1.5 1.5V4H4"],
};

export function ToolIcon({ name, size = 16 }: { name: ToolIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block", flex: "none" }}
    >
      {P[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
