// The trade box's buy side as pure functions (S8, A2.3 at research app.md:1448; APU-07 at app.md:1329). Money is exact
// bigint in USD cents, never a float: an amount is parsed from its decimal string and drawn back from cents.
//
// The ladder (wallet.md §2.5 "Standard sizes"): 1-2-5 per power of ten in USD from $2 ($2, $5, $10, $20, $50, $100,
// $200, ... with no top). The owner's presets $10, $25, $50 and $100 (VN-04 A) are sums of ladder sizes. A buy fires
// from a set of ready wallets, one ladder size each; the kit splits the amount and returns the set, and this file only
// checks that the set it returned sums to the amount to the cent. The app never changes a slice the kit returned.
//
// The main button's states (09-design-brief S8.9, S8.10, S8.12): a tap sends the kit's `buy` and shows Sending, the
// kit's `sent` turns it into Landing with a counter from the tap, and `filled` into Filled with the time from the tap
// to the fill. The kit's other trade stages (part_filled, not_landed) and a refusal end the buy as `ended`, drawn by
// `endView` as Failed (with the reason for the kit's code when the app has words for it), Not landed or part filled,
// each with Retry; a trade still Sending or Landing past 5 s is Slow (S8.11), which never ends it. The sell side
// (src/screens/positions/) runs the same machine.
import type { ErrorCode, Stage } from "@blindfill/kit";

/** USD cents. */
export type Cents = bigint;

/** The smallest ladder rung, $2 (a kit setting, wallet.md §2.5 and §8 item 11). */
export const LADDER_MIN: Cents = 200n;

/** The owner's buy presets, VN-04 A: $10, $25, $50, $100. */
export const PRESETS: readonly Cents[] = [1_000n, 2_500n, 5_000n, 10_000n];

/** A USD decimal string ("25", "25.5", "25.50", "0.07") to cents; anything else, a third decimal included, is null. */
export function parseUsd(s: string): Cents | null {
  const m = /^(\d{1,15})(?:\.(\d{0,2}))?$/.exec(s.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
}

/** Cents as the kit's decimal string: "25.00". */
export function centsToDecimal(c: Cents): string {
  return `${c / 100n}.${String(c % 100n).padStart(2, "0")}`;
}

/** Cents as drawn: "$100" for whole dollars, "$73.18" otherwise, grouped ("$1,000"). */
export function fmtUsd(c: Cents): string {
  const whole = (c / 100n).toLocaleString("en-US");
  const cents = c % 100n;
  return cents === 0n ? `$${whole}` : `$${whole}.${String(cents).padStart(2, "0")}`;
}

/** The ladder's rungs from $2 up to `top` inclusive, largest first: 1-2-5 per power of ten. */
export function rungs(top: Cents): Cents[] {
  const out: Cents[] = [];
  for (let p = 100n; p <= top; p *= 10n) for (const m of [1n, 2n, 5n]) if (p * m >= LADDER_MIN && p * m <= top) out.push(p * m);
  return out.reverse();
}

/**
 * The ladder sizes of an amount taken largest first with repeats ($137 = $100 + $20 + $10 + $5 + $2), and what is
 * left. A preset is a ladder sum when `rest` is 0. Only the presets are split here: the kit splits a typed amount.
 */
export function ladderSplit(amount: Cents): { sizes: Cents[]; rest: Cents } {
  const sizes: Cents[] = [];
  let rest = amount;
  for (const r of rungs(amount))
    while (rest >= r) {
      sizes.push(r);
      rest -= r;
    }
  return { sizes, rest };
}

/** A preset is on when nothing is running and the box can pay it: at or under the chain's max buy and the balance. */
export function presetOn(preset: Cents, max: Cents | null, balance: Cents | null, busy: boolean): boolean {
  return !busy && max !== null && balance !== null && preset <= max && preset <= balance;
}

/** The typed amount can be bought: more than zero, at or under the max buy and the balance. */
export function amountOk(amount: Cents | null, max: Cents | null, balance: Cents | null): boolean {
  return amount !== null && amount > 0n && max !== null && balance !== null && amount <= max && amount <= balance;
}

/** One slice of the kit's set: a ready wallet and the USD it spends (a decimal string, as every kit amount). */
export interface Slice {
  wallet: string;
  usd: string;
}

/** The set's slices in cents, and their sum; null when a slice is not a USD decimal string. */
export function setSum(slices: readonly Slice[]): Cents | null {
  let sum = 0n;
  for (const s of slices) {
    const c = parseUsd(s.usd);
    if (c === null || c <= 0n) return null;
    sum += c;
  }
  return sum;
}

/** The kit's set may be drawn for this amount only when it is for this amount: its slices sum to it to the cent. */
export function setMatches(slices: readonly Slice[], amount: Cents | null): boolean {
  return amount !== null && slices.length > 0 && setSum(slices) === amount;
}

// ---------------------------------------------------------------------------------------------------------- the buy

/** The main button's state. `at` is the tap's time in Unix ms. */
export type Phase =
  | { k: "ready" }
  | { k: "sending"; id: string; at: number }
  | { k: "landing"; id: string; at: number }
  | { k: "filled"; id: string; at: number; ms: number }
  /** The kit's part_filled or not_landed, or a refusal: drawn by the next card (Failed, Not landed). */
  | { k: "ended"; id: string; at: number; stage: Stage | "refused"; code?: ErrorCode };

export const READY: Phase = { k: "ready" };

/** A buy is running: the button is locked and the presets are off (one buy for a double tap). */
export const busy = (p: Phase): p is Extract<Phase, { k: "sending" | "landing" }> => p.k === "sending" || p.k === "landing";

/** A tap starts a buy only when none is running; a double tap is one buy. */
export function tap(p: Phase, id: string, now: number): Phase {
  return busy(p) ? p : { k: "sending", id, at: now };
}

/** A `progress` event of the kit: only the running buy's id moves the button, never backwards. */
export function progress(p: Phase, id: string, stage: Stage, now: number): Phase {
  if (!busy(p) || p.id !== id) return p;
  if (stage === "signed") return p;
  if (stage === "sent") return p.k === "sending" ? { k: "landing", id, at: p.at } : p;
  if (stage === "filled") return { k: "filled", id, at: p.at, ms: Math.max(0, now - p.at) };
  if (stage === "part_filled" || stage === "not_landed" || stage === "refused") return { k: "ended", id, at: p.at, stage };
  return p;
}

/** The kit's client codes for a request that ended without the page's answer (messages client.ts). */
const CLIENT_TIMEOUT = "client_timeout";

/**
 * The buy request's outcome. Its result's stage moves the button as a progress event does. A refusal ends the buy,
 * except the client's own timeout: the page may still run it, so the button waits for its progress (client.ts header).
 */
export function outcome(
  p: Phase,
  id: string,
  o: { ok: true; result: { stage: Stage } } | { ok: false; error: { code: ErrorCode } },
  now: number,
): Phase {
  if (!busy(p) || p.id !== id) return p;
  if (o.ok) return progress(p, id, o.result.stage, now);
  if (o.error.code === CLIENT_TIMEOUT) return p;
  return { k: "ended", id, at: p.at, stage: "refused", code: o.error.code };
}

/** Milliseconds as the button draws them: "0.4s", "1.1s", "12.0s" (tenths, rounded down). */
export function secs(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 100));
  return `${Math.floor(t / 10)}.${t % 10}s`;
}

/** The time on the button: Landing counts from the tap, Filled holds the tap-to-fill time. Null when none shows. */
export function buttonTime(p: Phase, now: number): string | null {
  if (p.k === "landing") return secs(now - p.at);
  if (p.k === "filled") return secs(p.ms);
  return null;
}

// ------------------------------------------------------------------------------------------------- the other states

/** Slow: a trade still Sending or Landing this long after the tap (09-design-brief S8.11: past 5 s). */
export const SLOW_MS = 5_000;

/** The trade is still running past SLOW_MS. Display only: only the kit's stage ends a trade. */
export const isSlow = (p: Phase, now: number): boolean => busy(p) && now - p.at >= SLOW_MS;

/** A reason the app has words for, by the kit's code (words.ts). */
export type Reason = "priceCheck" | "notSent";

/**
 * The kit's codes the app has a reason for: the device's quote check refused (S8.20 Price check failed), and the
 * signing page down, so the request was never posted (the kit's client code, S8.28 Not sent). Any other code draws
 * Failed alone: the app never makes up a reason.
 */
const REASONS: Record<string, Reason> = { quote_check_failed: "priceCheck", signpage_down: "notSent" };

/** How an ended trade is drawn: Failed, Not landed (CH-050: the money never left W), or part filled (CH-045). */
export interface EndView {
  k: "failed" | "notLanded" | "partial";
  reason: Reason | null;
}

export function endView(p: Phase): EndView | null {
  if (p.k !== "ended") return null;
  if (p.stage === "not_landed") return { k: "notLanded", reason: null };
  if (p.stage === "part_filled") return { k: "partial", reason: null };
  return { k: "failed", reason: (p.code && REASONS[p.code]) || null };
}
