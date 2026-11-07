// The deposit sheet's states (S4; app.md 2.7.2 FR-P7 to FR-P11, 2.7.2b branch D, APU-04), as one pure function of what
// the sheet knows: the signing page's state, the asset list, the amount typed, the dry quote, the checked quote and the
// deposit's status. Every state comes from an answer or an event (a quote answered, the deposit seen, the arrival, the
// signed deadline reached); no timer ever produces a failure. APP_HOST never makes an address: the only address the
// sheet draws is the one inside the quote SIGN_HOST checked (W:667, CH-028, CH-033).
import type { Chain, DepositAsset, DepositFacts, DepositStage, Operation, SignpageResults } from "@blindfill/kit";

/**
 * Every state the sheet draws. S4.x ids are BRF's (09-design-brief S4) and R5's; the rest are app.md's NEW frames, named
 * here: `quote-refused` (FR-P8 fails, no address), `refund-move` (FR-D2), `held` (FR-D3), and the three CH-119 holds.
 */
export type SheetState =
  | "S4.1" // assets loading
  | "S4.2" // quoting
  | "S4.3" // the quote, Get address on
  | "S4.4" // below the minimum
  | "S4.5" // above the max
  | "S4.6" // not available
  | "S4.7" // busy (1Click 429)
  | "S4.8" // deposits paused (1Click down)
  | "quote-refused"
  | "S4.13" // the address, nothing seen yet
  | "S4.14" // waiting: the send is known
  | "S4.15" // processing, one counter for both legs
  | "S4.16" // deposited: the note read on two agreeing RPCs
  | "S4.17" // refunded to the one-time id (FR-D1)
  | "refund-move" // the kit's refund move in flight (FR-D2)
  | "held" // the money under its id, the vault keeps refusing or 1Click cannot route (FR-D3)
  | "held-halted" // CH-119: USDC halted, or our relayer down or holding
  | "held-not-caught-up" // CH-119: the relayer's status not caught up
  | "held-vault-blocked" // CH-119: the vault's account blocked on USDC
  | "S4.18" // short deposit (1Click INCOMPLETE_DEPOSIT)
  | "S4.19" // backup first: the 12 words are the only copy and not saved
  | "S4.20"; // address expired before anything arrived

/** A dry quote: the quote lines of S4.3, no address (the kit's deposit.dry answer, DepositDry). */
export interface DryQuote {
  /** USD, decimal strings. */
  amount_out_usd: string;
  min_amount_out_usd: string;
  fee_usd: string;
  time_estimate_s: number;
}

/** Why a quote (dry or checked) did not come back. `quote_check_failed` is the kit's own code (messages.ts). */
export type QuoteRefusal = "below_min" | "above_max" | "not_available" | "busy" | "down" | "quote_check_failed";

export type Answer<T> = { kind: "idle" } | { kind: "pending" } | { kind: "ok"; value: T } | { kind: "refused"; code: QuoteRefusal };

/**
 * The deposit's status as the kit reports it on the deposit's op in state.ops (kit-deposit-calls): its stage and the
 * facts beside it (DepositFacts). `refunded` marks a deposit 1Click refunded to U, so the legs after it are the refund
 * move's; `hold` says why a `halted` deposit waits (CH-119); `held_id` is the id the money waits under, for
 * withdraw.open's `from_id`; `since_ms` is the counter's zero; `amount_usd` the USDC credited, once done.
 */
export interface DepositStatus extends DepositFacts {
  stage: DepositStage;
}

/** A deposit op's status: its stage and the facts the kit sent with it, nothing else. */
export function statusOf(op: Extract<Operation, { kind: "deposit" }>): DepositStatus {
  const { id: _id, kind: _kind, txs: _txs, ...status } = op;
  return status;
}

/** The chain names the sheet draws for the kit's chain ids (data, as Portfolio draws them). */
const CHAIN_NAME: Record<Chain, string> = { solana: "Solana", base: "Base", robinhood: "Robinhood", near: "NEAR" };

/** One row of the kit's deposit.assets as the sheet's asset. */
export function assetOf(a: DepositAsset): Asset {
  return { id: a.origin_asset, chain: CHAIN_NAME[a.chain] ?? a.chain, symbol: a.symbol, min: a.min, max_usd: a.max_usd };
}

/** The address box's heading: the asset, then its chain when the chain's name is not the asset's (never "NEAR NEAR"). */
export function addressHeading(a: Pick<Asset, "symbol" | "chain">): string[] {
  return a.symbol.toLowerCase() === a.chain.toLowerCase() ? [a.symbol] : [a.symbol, a.chain];
}

export interface Asset {
  /** 1Click asset id, sent as deposit.quote's origin_asset. */
  id: string;
  /** The chain's name as drawn (data, from the asset list). */
  chain: string;
  symbol: string;
  /** The smallest amount 1Click takes, in the asset's units (decimal string). */
  min: string;
  /** The kit's beta cap per deposit in USD, when a value is set (CH-022, CH-023); null: no max. */
  max_usd: string | null;
}

export interface SheetInput {
  signedIn: boolean;
  /** The signing page is READY with its state known. */
  moneyOn: boolean;
  /** False while the 12 words are the only copy and not saved (S4.19). */
  codeSaved: boolean;
  asset: Asset | null;
  amount: string;
  dry: Answer<DryQuote>;
  checked: Answer<SignpageResults["deposit.quote"]>;
  status: DepositStatus | null;
  now: number;
}

/** A typed amount as a positive decimal, or null. */
export function parseAmount(s: string): string | null {
  const t = s.trim();
  return /^(\d+)(\.\d+)?$/.test(t) && /[1-9]/.test(t) ? t : null;
}

/** a < b for two non-negative decimal strings, exactly (no float). */
export function lessThan(a: string, b: string): boolean {
  const [ai = "0", af = ""] = a.split(".");
  const [bi = "0", bf = ""] = b.split(".");
  const n = Math.max(af.length, bf.length);
  return BigInt(ai + af.padEnd(n, "0")) < BigInt(bi + bf.padEnd(n, "0"));
}

const REFUSAL: Record<QuoteRefusal, SheetState> = {
  below_min: "S4.4",
  above_max: "S4.5",
  not_available: "S4.6",
  busy: "S4.7",
  down: "S4.8",
  quote_check_failed: "quote-refused",
};

/** The state for a deposit the kit is tracking (the checked quote answered). APU-04's table. */
export function statusState(s: DepositStatus | null, deadline: string, now: number): SheetState {
  if (!s || s.stage === "quote_checked") return Date.parse(deadline) <= now ? "S4.20" : "S4.13";
  switch (s.stage) {
    case "expired":
      return "S4.20";
    case "waiting":
      return "S4.14";
    case "failed":
      return "S4.15";
    case "short":
      return "S4.18";
    case "refunded":
      return "S4.17";
    case "refund_move":
      return "refund-move";
    case "in_transit":
    case "into_vault":
      return s.refunded ? "refund-move" : "S4.15";
    case "done":
      return "S4.16";
    case "held":
      return "held";
    case "halted":
      return s.hold === "not_caught_up" ? "held-not-caught-up" : s.hold === "vault_blocked" ? "held-vault-blocked" : "held-halted";
  }
}

/** The sheet's state. */
export function sheetState(i: SheetInput): SheetState {
  if (i.checked.kind === "ok") return statusState(i.status, i.checked.value.deadline, i.now);
  if (!i.asset) return i.dry.kind === "refused" ? REFUSAL[i.dry.code] : "S4.1";
  if (i.checked.kind === "refused") return REFUSAL[i.checked.code];
  const amt = parseAmount(i.amount);
  if (amt && lessThan(amt, i.asset.min)) return "S4.4";
  if (i.dry.kind === "refused") return REFUSAL[i.dry.code];
  if (i.dry.kind === "ok" && i.asset.max_usd !== null && lessThan(i.asset.max_usd, i.dry.value.amount_out_usd)) return "S4.5";
  if (i.dry.kind === "pending" || i.checked.kind === "pending") return "S4.2";
  if (i.signedIn && !i.codeSaved && i.dry.kind === "ok") return "S4.19";
  return "S4.3";
}

/** States with the address block (the address, its amount, chain, asset and Expires in, the copy action). */
export const ADDRESS_STATES: ReadonlySet<SheetState> = new Set(["S4.13", "S4.14", "S4.15", "S4.18"]);
/** States whose one action is withdraw.open with the id the money waits under (FR-D3, CH-119). */
export const HELD_STATES: ReadonlySet<SheetState> = new Set(["held", "held-halted", "held-not-caught-up", "held-vault-blocked"]);

/** Get address is on: the dry quote answered, the amount inside the limits, signed in, the page READY. */
export function getAddressOn(state: SheetState, i: Pick<SheetInput, "signedIn" | "moneyOn">): boolean {
  return state === "S4.3" && i.signedIn && i.moneyOn;
}

/** The counter: whole seconds since the kit first saw the send, never negative. */
export function elapsed(since: number | undefined, now: number): number {
  return since === undefined ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

/** "71:59:12" to a deadline, or "00:00:00". */
export function countdown(deadline: string, now: number): string {
  const s = Math.max(0, Math.floor((Date.parse(deadline) - now) / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** "$73.18" from a USD decimal string, rounded down to the cent. */
export function usd(s: string): string {
  const [i = "0", f = ""] = s.split(".");
  return `$${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${(f + "00").slice(0, 2)}`;
}

/** The asset picker's rows: each symbol once, in the list's order. */
export function symbolsOf(assets: readonly Asset[]): string[] {
  return [...new Set(assets.map((a) => a.symbol))];
}

/** The chain picker's rows: the chains the asset is on, in the list's order. */
export function chainsOf(assets: readonly Asset[], symbol: string): string[] {
  return assets.filter((a) => a.symbol === symbol).map((a) => a.chain);
}

/** The asset picked: the symbol on its chain, else the symbol on its first chain, else the list's first; null with none. */
export function pickAsset(assets: readonly Asset[] | null, picked: { symbol: string; chain: string } | null): Asset | null {
  if (!assets?.length) return null;
  if (!picked) return assets[0]!;
  return assets.find((a) => a.symbol === picked.symbol && a.chain === picked.chain) ?? assets.find((a) => a.symbol === picked.symbol) ?? assets[0]!;
}
