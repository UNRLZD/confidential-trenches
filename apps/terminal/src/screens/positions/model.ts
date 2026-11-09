// Sell and positions as pure functions (A2.4, app.md:1449 at research; S8.29, S8.30 and S8.52 at 09-design-brief S8;
// AE-11's sell rows, app.md:1352). A sell is the kit's `buy` request with `side: "sell"` and `amount` in the token's
// units (packages/kit/src/signpage/messages.ts SignpageParams.buy), as the buy side sends it with `side: "buy"`.
//
// Exact, never a float: the position's amount is the kit's decimal string (SignpageState.positions[].amount), read into
// base units at the string's own decimals. A percent sell is that amount times whole basis points, rounded down to the
// base unit, so a sell never asks for more than is held. 100% sends the kit's own string unchanged, so the whole
// position sells to the last base unit. A percent that comes to zero base units (dust) sells nothing: the preset is off.
// USD is bigint cents, as the buy side (src/screens/trade/model.ts) and Portfolio (src/screens/portfolio/model.ts).
//
// The sell's button runs the buy side's own state machine (trade/model.ts tap, progress, outcome: Sending, Landing,
// Filled, one request for a double tap); nothing is forked here.

import type { Phase } from "../trade/model.ts";

/** 100% in basis points. */
export const WHOLE = 10_000;

/** The trade box's sell presets, VN-05 A `[owner: round 16]`: 25% 50% 75% 100%. */
export const BOX_PERCENTS: readonly number[] = [2_500, 5_000, 7_500, WHOLE];

/** Your position's quick sells (09-design-brief S8 "Your position": `25%` `50%` `All` `Initials`; R5 token.js U.position). */
export const QUICK: readonly (number | "initials")[] = [2_500, 5_000, WHOLE, "initials"];

/** A token amount in base units at the string's own decimals. */
export interface Units {
  n: bigint;
  scale: number;
}

/** A non-negative decimal string ("1234.5678", "42") to base units; anything else, a sign or an exponent, is null. */
export function toUnits(s: string): Units | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = m[2] ?? "";
  return { n: BigInt(m[1]! + frac), scale: frac.length };
}

/** Base units back to a decimal string, trailing zeros of the fraction dropped ("0.12", "1"). */
export function fromUnits(n: bigint, scale: number): string {
  if (scale === 0) return n.toString();
  const s = n.toString().padStart(scale + 1, "0");
  const int = s.slice(0, s.length - scale);
  const frac = s.slice(s.length - scale).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

const isBps = (b: number) => Number.isInteger(b) && b > 0 && b <= WHOLE;

/**
 * The token amount a sell of `bps` of the position asks for, as the kit's decimal string; null when there is nothing to
 * sell (a zero or unreadable position, a percent outside 0-100%, or dust: the share comes to zero base units).
 * `decimals` is the token's own (the token read's): the share floors at the token's base unit, or at the string's own
 * scale when that is finer, never at however many decimals the kit's trimmed string happens to carry ("2" at 75% is
 * "1.5", not "1"; card app-sell-mount review P1). The signing page refuses a fraction longer than the token's
 * (rules/pool.ts), so a wrong `decimals` is refused, never sold. Null or not a whole 0-36: the string's own scale.
 */
export function sellAmount(amount: string, bps: number, decimals: number | null = null): string | null {
  const u = toUnits(amount);
  if (!u || u.n === 0n || !isBps(bps)) return null;
  if (bps === WHOLE) return amount;
  const d = decimals !== null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 0;
  const scale = Math.max(u.scale, d);
  const part = (u.n * 10n ** BigInt(scale - u.scale) * BigInt(bps)) / BigInt(WHOLE);
  return part === 0n ? null : fromUnits(part, scale);
}

/** The box's typed percent ("50", "12.5", "0.01") as basis points, more than 0 and at most 100; anything else null. */
export function parsePercent(s: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const b = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return isBps(b) ? b : null;
}

/**
 * `Initials`: the share of the position whose value returns its cost, in basis points rounded up so the sale covers the
 * cost (09-design-brief S8 Sell presets: "sells the share that returns the position's cost"). Null, so the button is
 * off, when there is no price or the position is not up: at or under its cost the share would be the whole position.
 */
export function initialsBps(cost: bigint, value: bigint | null): number | null {
  if (value === null || cost <= 0n || value <= cost) return null;
  return Number((cost * BigInt(WHOLE) + value - 1n) / value);
}

/** The share's value in cents, rounded down; null with no value. */
export function shareCents(value: bigint | null, bps: number): bigint | null {
  return value === null ? null : (value * BigInt(bps)) / BigInt(WHOLE);
}

/** Basis points as the presets draw them: "25%", "12.5%". */
export function pctLabel(bps: number): string {
  const w = Math.trunc(bps / 100);
  const f = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return f ? `${w}.${f}%` : `${w}%`;
}

/** A sell's end, marked with the signing page's state that was current when it ended (card app-sell-mount). */
export interface SellEnd {
  id: string;
  state: unknown;
}

/** The mark after `phase`: a sell's new end (filled or ended) marks the state current now; otherwise the mark stays. */
export function markEnd(mark: SellEnd | null, phase: Phase, state: unknown): SellEnd | null {
  if (phase.k !== "filled" && phase.k !== "ended") return mark;
  return mark?.id === phase.id ? mark : { id: phase.id, state };
}

/** The box after a sell that may have sold (filled, part filled, not landed) is display only until a state newer than
 *  the one at its end arrives: the position it drew is what was held before the sell, so a tap on it would ask a share
 *  of an amount that is gone (review P2). A sell the signing page refused sold nothing, so its Retry stays live. */
export function staleAfterSell(mark: SellEnd | null, phase: Phase, state: unknown): boolean {
  const sold = phase.k === "filled" || (phase.k === "ended" && phase.stage !== "refused");
  return sold && mark !== null && mark.id === phase.id && mark.state === state;
}
