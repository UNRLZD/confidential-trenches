// Discover's numbers, as R5 draws them (design/proto/assets/app.js at design-lock-r5: P.fmtUsd, P.small, P.age,
// P.cnt), with two fixes R5 lacked: a value that rounds up into the next unit moves to it ($1.00M, never $1000.0K),
// and caps past $1,000B read in T. Values come as 06b's decimal strings; anything else is the dash.

export const DASH = "—";
const MINUS = "−";
const SUB = "₀₁₂₃₄₅₆₇₈₉";
const DECIMAL = /^\d+(\.\d+)?$/;

const sub = (n: number) => String(n).replace(/\d/g, (d) => SUB[Number(d)]!);

/** A non-negative decimal string, or null when it is anything else. */
function parse(v: string | null | undefined): { n: number; s: string } | null {
  if (typeof v !== "string" || !DECIMAL.test(v)) return null;
  return { n: Number(v), s: v };
}

/** Below 1: four places from 0.01; under that the zero count, as UNRLZD: 0.00123, then 0.0₅123. Read from the
 *  string, so a tiny price keeps its digits (cut, never rounded up). */
function small(p: { n: number; s: string }): string {
  if (p.n >= 0.01) return p.n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");
  const frac = p.s.split(".")[1] ?? "";
  const zeros = frac.length - frac.replace(/^0+/, "").length;
  const digits = frac.slice(zeros, zeros + 3).replace(/0+$/, "");
  return zeros < 3 ? `0.${"0".repeat(zeros)}${digits}` : `0.0${sub(zeros)}${digits}`;
}

/** A token price: whole dollars with cents, grouped from $1,000; below $1 as `small`. */
export function price(v: string | null | undefined): string {
  const p = parse(v);
  if (!p) return DASH;
  if (p.n === 0) return "$0";
  if (p.n < 1) return `$${small(p)}`;
  return `$${p.n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A small-number form ($0.0₁₀123, 9 characters) cut to the 8 a tile holds; the other forms are 8 or fewer. */
const fit = (s: string): string => (s.startsWith("$0.") && s.length > 8 ? s.slice(0, 8) : s);

/** The price in the token page's strip tile, at most 8 characters, the width the tile is drawn for (like $1.25M and 71.3K
 *  in its neighbours): from $100,000 it is compact ($184.2K); below, a full form longer than 8 characters drops its
 *  decimals, cut and never rounded up, until it fits; $1 and under are `price`'s own small-number form. The header and
 *  Discover draw `price`. */
export function priceTile(v: string | null | undefined): string {
  const p = parse(v);
  if (!p) return DASH;
  if (p.n >= 1e5) return `$${compact(p.n)}`;
  const full = price(v);
  if (p.n < 1) return fit(full);
  if (full.length <= 8) return full;
  const [int = "0", frac = ""] = p.s.split(".");
  const whole = Number(int).toLocaleString("en-US");
  const one = `$${whole}.${frac.padEnd(1, "0").slice(0, 1)}`;
  return one.length <= 8 ? one : `$${whole}`;
}

const BANDS = [
  { min: 1e3, div: 1e3, unit: "K", dp: 2 },
  { min: 1e4, div: 1e3, unit: "K", dp: 1 },
  { min: 1e6, div: 1e6, unit: "M", dp: 2 },
  { min: 1e9, div: 1e9, unit: "B", dp: 2 },
  { min: 1e12, div: 1e12, unit: "T", dp: 2 },
] as const;

/** A compact number: K from 1,000, M, B, T; a value that rounds into the next band is drawn in it. */
export function compact(n: number): string {
  let i = -1;
  for (let j = 0; j < BANDS.length; j++) if (n >= BANDS[j]!.min) i = j;
  for (;;) {
    if (i < 0) {
      const t = n.toFixed(2);
      if (Number(t) < BANDS[0].min) return t;
      i = 0;
    }
    const b = BANDS[i]!;
    const t = (n / b.div).toFixed(b.dp);
    const next = BANDS[i + 1];
    if (next && Number(t) * b.div >= next.min) {
      i++;
      continue;
    }
    return `${t}${b.unit}`;
  }
}

/** Market cap, volume, liquidity: $4.15K, $17.6K, $2.21B; below $1 as `small`. */
export function usd(v: string | null | undefined): string {
  const p = parse(v);
  if (!p) return DASH;
  if (p.n === 0) return "$0";
  if (p.n < 1) return `$${small(p)}`;
  return `$${compact(p.n)}`;
}

/** `usd` in the token page's tiles: at most 8 characters, the width a tile is drawn for ($123.46T, $297.4K). */
export function usdTile(v: string | null | undefined): string {
  return fit(usd(v));
}

/** Time since launch in whole units, rounded down: 59s, 1m, 23h, 1d. A launch time ahead of the clock is 1s. */
export function age(createdS: number | null | undefined, nowMs: number): string {
  if (typeof createdS !== "number" || !Number.isFinite(createdS)) return DASH;
  const s = Math.max(1, Math.floor(nowMs / 1000) - createdS);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Holders and trade counts: 9,534; 67.6K; 12.35M. */
export function count(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return DASH;
  if (n < 1e4) return n.toLocaleString("en-US");
  return compact(n);
}

/** A price change in basis points for a window: +12% · 5m, −33% · 1h; cut toward zero, never overstated. */
export function change(bps: number | null | undefined, win: string): string {
  if (typeof bps !== "number" || !Number.isFinite(bps)) return DASH;
  const a = Math.abs(bps) / 100;
  const body = a >= 9999.5 ? compact(a) : String(Math.trunc(a));
  return `${bps >= 0 ? "+" : MINUS}${body}% · ${win}`;
}
