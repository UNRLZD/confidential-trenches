// R5's line icons on their 12 x 12 grid (design/proto/assets/app.js:24-68 at design-lock-r5), the ones Portfolio draws.
const PATHS = {
  arrowDown: ["M6 2v8", "M2.5 6.5L6 10l3.5-3.5"],
  arrowUp: ["M6 10V2", "M2.5 5.5L6 2l3.5 3.5"],
  chevR: ["M4.5 3l3 3-3 3"],
  deposit: ["M6 1.5v6", "M3.5 5L6 7.5 8.5 5", "M2 10.5h8"],
  search: ["M8 8l2.8 2.8"],
  share: ["M6 7.5V1.5M3.5 4L6 1.5 8.5 4", "M2 7v2.5c0 .6.4 1 1 1h6c.6 0 1-.4 1-1V7"],
  key: ["M5.7 6.3L10.5 1.5", "M8.5 3.5l1.5 1.5"],
  target: [],
  more: [],
} as const;
const CIRCLES: Partial<Record<keyof typeof PATHS, [number, number, number][]>> = {
  search: [[5.2, 5.2, 3.7]],
  key: [[4, 8, 2.3]],
  target: [[6, 6, 4.5], [6, 6, 1.8]],
  more: [[2.5, 6, 0.6], [6, 6, 0.6], [9.5, 6, 0.6]],
};

export type IcName = keyof typeof PATHS;

export function Ic({ name, size = 14, stroke = 1.4 }: { name: IcName; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name].map((d) => <path key={d} d={d} />)}
      {(CIRCLES[name] ?? []).map(([cx, cy, r]) => <circle key={`${cx}-${cy}-${r}`} cx={cx} cy={cy} r={r} />)}
    </svg>
  );
}

/** R5's exit-plan tile (P.EXITIC): a 9 x 9 dot grid, the TP row green, the SL row coral, the price path in paper. */
const EXIT_PRICE = [3, 4, 3, 5, 4, 5, 6, 5, 4];
export function ExitIc({ size = 26 }: { size?: number }) {
  const dots = [];
  for (let c = 0; c < 9; c++)
    for (let y = 0; y < 9; y++) {
      const p = EXIT_PRICE[c]!;
      const row = 8 - y;
      let f: [string, number, number] | null = null;
      if (row === 7) f = c % 2 ? null : ["#50e397", 0.9, 1];
      else if (row === 1) f = c % 2 ? null : ["#ff5d4d", 0.9, 1];
      else if (row === p) f = [c === 8 ? "#f2b543" : "#f4f4f2", 1, c === 8 ? 1.35 : 1];
      else if (row < p && row > 1) f = ["#f4f4f2", 0.12, 1];
      if (f) dots.push(<circle key={`${c}-${y}`} cx={3 + c * 3} cy={3 + y * 3} r={0.9 * f[2]} fill={f[0]} fillOpacity={f[1]} />);
    }
  return (
    <span className="exitic" style={{ width: size, height: size }}>
      <svg width={size - 6} height={size - 6} viewBox="0 0 30 30" aria-hidden="true">{dots}</svg>
    </span>
  );
}
