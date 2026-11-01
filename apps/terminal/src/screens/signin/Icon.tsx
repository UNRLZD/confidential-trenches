// R5's line icons on their 12 x 12 grid (design/proto/assets/app.js:24-65 at design-lock-r5).
const PATHS = {
  user: ["M1.8 10.8c.5-2.2 2.1-3.3 4.2-3.3s3.7 1.1 4.2 3.3"],
  chevDown: ["M3 4.5l3 3 3-3"],
  plus: ["M6 2.5v7M2.5 6h7"],
  x: ["M2 2l8 8M10 2L2 10"],
  key: ["M5.7 6.3L10.5 1.5", "M8.5 3.5l1.5 1.5"],
  check: ["M2.5 6.2l2.3 2.3 4.7-5"],
} as const;
const CIRCLES: Partial<Record<keyof typeof PATHS, [number, number, number]>> = { user: [6, 4, 2.3], key: [4, 8, 2.3] };

export type IconName = keyof typeof PATHS | "wallet" | "words";

export function Icon({ name, size = 16, stroke = 1.3 }: { name: IconName; size?: number; stroke?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: stroke, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "wallet")
    return (
      <svg {...p}>
        <rect x="1.5" y="3" width="9" height="7" rx="1.4" />
        <path d="M1.5 4.5V3.6c0-.7.5-1.2 1.2-1.3L8 1.5" />
        <circle cx="8.2" cy="6.5" r=".6" />
      </svg>
    );
  if (name === "words")
    return (
      <svg {...p}>
        <path d="M2 3h3M7 3h3M2 6h3M7 6h3M2 9h3M7 9h3" />
      </svg>
    );
  const c = CIRCLES[name];
  return (
    <svg {...p}>
      {c && <circle cx={c[0]} cy={c[1]} r={c[2]} />}
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
