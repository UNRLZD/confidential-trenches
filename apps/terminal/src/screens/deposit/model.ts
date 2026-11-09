// The deposit sheet's states (S4; app.md 2.7.2 FR-P7 to FR-P11, 2.7.2b branch D, APU-04), as one pure function of what
// the sheet knows: the signing page's state, the asset list, the amount typed, the dry quote, the checked quote and the
// deposit's status. Every state comes from an answer or an event (a quote answered, the deposit seen, the arrival, the
// signed deadline reached); no timer ever produces a failure. APP_HOST never makes an address: the only address the
// sheet draws is the one inside the quote SIGN_HOST checked (W:667, CH-028, CH-033).
import { POOL_ASSET_DECIMALS, POOL_CHAINS } from "@blindfill/kit";
import type { Chain, DepositAsset, DepositFacts, DepositStage, Operation, PoolAsset, PoolChain, PoolDepositFacts, PoolDepositStage, SignpageResults, SignpageState } from "@blindfill/kit";

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
  | "moved" // card held-move-forgotten-tx: the held money moved out to the account the user typed (the kit's moved_out)
  | "held-halted" // CH-119: USDC halted, or our relayer down or holding
  | "held-not-caught-up" // CH-119: the relayer's status not caught up
  | "held-vault-blocked" // CH-119: the vault's account blocked on USDC
  | "S4.18" // short deposit (1Click INCOMPLETE_DEPOSIT)
  | "S4.19" // backup first: the 12 words are the only copy and not saved
  | "S4.20" // address expired before anything arrived
  | "pool-off" // card deposit-to-pool: a pool picked whose chain pool.address refuses (no quote, no address)
  | "pool-in"; // card deposit-to-pool-pools: the pool deposit's notes read on two RPCs (the kit's in_pool)

/**
 * Where the money goes (card deposit-to-pool, v2 A3): the NEAR vault, the cash home, then each chain's pool in the kit's
 * own order (POOL_CHAINS: NEAR's money is the vault's, never a pool's).
 */
export type Dest = "near" | PoolChain;
export const DESTS: readonly Dest[] = Object.freeze(["near", ...POOL_CHAINS]);

/**
 * What the signing page answered for each pool's chain (card deposit-to-pool-pools): true once pool.address with no
 * asset answered the chain's one-time address, false when it refused, absent while not asked or not back. Today the
 * page answers that ask whenever its network pins the chain's pool and the account is signed in with its words saved
 * (packages/signpage pool-deposit-address.ts): it answers before the gates only a quote meets (a follow to carry the
 * money on, the mainnet network, the device's price of the origin, the pool's floor), so a tile can read fundable while
 * every quote for it is refused, which the sheet draws as Not available at Get address.
 */
export type PoolOpen = Partial<Record<PoolChain, boolean>>;

/** How many times the sheet asks a pool's chain again after a busy or down answer while it is open. */
export const POOL_ASK_TRIES = 5;
/**
 * The wait before asking pool.address again for a chain whose answer was `code` on try `attempt` (0 first), in ms; null:
 * ask no more. Busy and down are the page or its helper not answering now, so they are asked again: 1 s, doubling, at
 * most 16 s, five times (31 s in all; the kit's refusal carries no Retry-After). Any other refusal is the page's answer
 * for the chain (not_allowed, read as not_available): Not available at once.
 */
export function poolAskAgainIn(code: QuoteRefusal, attempt: number): number | null {
  if ((code !== "busy" && code !== "down") || attempt >= POOL_ASK_TRIES) return null;
  return Math.min(1_000 * 2 ** attempt, 16_000);
}

/** Whether the sheet can put money into a destination: the NEAR vault always (deposit.quote); a pool only once
 *  pool.address answered its chain. */
export function destFundable(d: Dest, open: PoolOpen): boolean {
  return d === "near" || open[d] === true;
}

/** A pool deposit's status as the kit reports it on its pool_deposit op (kit-v1.7, card pool-deposit-stages): the pool's
 *  chain, the stage and the facts beside it. */
export interface PoolDepositStatus extends PoolDepositFacts {
  pool: PoolChain;
  stage: PoolDepositStage;
}

/** A pool_deposit op's status: its chain, stage and facts, nothing else. */
export function poolStatusOf(op: Extract<Operation, { kind: "pool_deposit" }>): PoolDepositStatus {
  const { id: _id, kind: _kind, txs: _txs, chain, ...facts } = op;
  return { pool: chain, ...facts };
}

/** The pool deposit asked under request `id` for `chain`'s pool: only a pool_deposit op naming that chain, never another
 *  chain's or a vault deposit, so the sheet never follows money into the wrong pool. */
export function poolStatusFor(ops: readonly Operation[] | undefined, id: string, chain: PoolChain): PoolDepositStatus | null {
  const op = ops?.find((o) => o.id === id);
  return op && op.kind === "pool_deposit" && op.chain === chain ? poolStatusOf(op) : null;
}

/**
 * Whether a checked quote is the one asked for (review P1, the vault's and a pool's alike): its origin asset the asset
 * asked and its amount in the amount asked, exactly. An answer for anything else draws no address, so money is never
 * sent from one asset to an address quoted for another.
 */
export function quoteFits(q: Pick<SignpageResults["deposit.quote"], "origin_asset" | "amount_in">, asked: { asset: Asset; amount: string }): boolean {
  const a = parseAmount(q.amount_in), b = parseAmount(asked.amount);
  return q.origin_asset === asked.asset.id && a !== null && b !== null && !lessThan(a, b) && !lessThan(b, a);
}

/**
 * What the form holds still (review P1): everything while the asset list loads, and the asset, chain and amount while a
 * checked quote is pending, so the answer always lands on what was asked. A dry quote pending (the vault's lines, as the
 * amount is typed) holds nothing.
 */
export function formHeld(s: SheetState, checked: Answer<unknown>): { pickers: boolean; amount: boolean } {
  const held = s === "S4.1" || checked.kind === "pending";
  return { pickers: held, amount: held };
}

/** pool.address's checked quote, only when the answer names the chain asked: an answer for another chain, or an address
 *  with no checked quote (nothing follows it), draws no address. */
export function poolQuote(chain: PoolChain, a: SignpageResults["pool.address"]): SignpageResults["deposit.quote"] | null {
  return a.chain === chain && a.quote !== undefined ? a.quote : null;
}

/** An amount of a pool asset in base units, exactly; null when it is not one. */
function poolUnits(v: string, d: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(v);
  if (!m || (m[2] ?? "").length > d) return null;
  return BigInt(m[1]! + (m[2] ?? "").padEnd(d, "0"));
}
/** Base units as a decimal with no trailing zero. */
function poolDecimal(v: bigint, d: number): string {
  const s = v.toString().padStart(d + 1, "0");
  const f = s.slice(s.length - d).replace(/0+$/, "");
  return f ? `${s.slice(0, s.length - d)}.${f}` : s.slice(0, s.length - d);
}

/** What `chain`'s pool holds ready to buy (state.pools' ready: chunks with a proof made) and what is still being proved,
 *  in its own asset, as Portfolio reads them (portfolio/model.ts pools); null when the page reports no such pool. */
export function poolReady(pools: SignpageState["pools"], chain: PoolChain): { asset: PoolAsset; ready: string | null; pending: string | null } | null {
  const p = pools?.find((x) => x.chain === chain);
  if (!p) return null;
  const d = POOL_ASSET_DECIMALS[p.asset];
  const balance = poolUnits(p.balance, d) ?? 0n;
  const r = p.ready === undefined ? null : poolUnits(p.ready, d);
  const ready = r === null ? null : r > balance ? balance : r;
  const pending = balance - (ready ?? 0n);
  return { asset: p.asset, ready: ready === null || ready === 0n ? null : poolDecimal(ready, d), pending: pending === 0n ? null : poolDecimal(pending, d) };
}

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
  /** Where the money goes (the To row). */
  dest: Dest;
  /** For a pool picked: whether pool.address answered its chain (PoolOpen's), absent while not back. */
  poolOpen?: boolean;
  signedIn: boolean;
  /** The signing page is READY with its state known. */
  moneyOn: boolean;
  /** False while the 12 words are the only copy and not saved (S4.19). */
  codeSaved: boolean;
  asset: Asset | null;
  amount: string;
  dry: Answer<DryQuote>;
  checked: Answer<SignpageResults["deposit.quote"]>;
  /** The deposit asked: the vault's deposit op, or a pool's pool_deposit op (`pool` names its chain). */
  status: DepositStatus | PoolDepositStatus | null;
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

/** The state for a pool deposit the kit is tracking (pool.address's checked quote answered; card pool-deposit-stages).
 *  Deposited (pool-in) only at in_pool: the notes read back at finalized on the chain's two RPCs. A pool deposit has no
 *  held or halted stage: a refund is carried on into the pool. */
export function poolStatusState(s: PoolDepositStatus | null, deadline: string, now: number): SheetState {
  if (!s || s.stage === "quote_checked") return Date.parse(deadline) <= now ? "S4.20" : "S4.13";
  switch (s.stage) {
    case "waiting":
      return "S4.14";
    case "in_transit":
    case "failed":
      return "S4.15";
    case "short":
      return "S4.18";
    case "refunded":
      return "S4.17";
    case "refund_move":
      return "refund-move";
    case "in_pool":
      return "pool-in";
    case "expired":
      return "S4.20";
  }
}

/** The state for a deposit the kit is tracking (the checked quote answered). APU-04's table. */
export function statusState(s: DepositStatus | PoolDepositStatus | null, deadline: string, now: number): SheetState {
  if (s && "pool" in s) return poolStatusState(s, deadline, now);
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
      return s.moved_out === true ? "moved" : "held";
    case "halted":
      return s.hold === "not_caught_up" ? "held-not-caught-up" : s.hold === "vault_blocked" ? "held-vault-blocked" : "held-halted";
  }
}

/** The sheet's state. */
export function sheetState(i: SheetInput): SheetState {
  if (i.checked.kind === "ok") return statusState(i.status, i.checked.value.deadline, i.now);
  if (i.dest !== "near") return poolFormState(i);
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

/**
 * A pool's form (card deposit-to-pool-pools): the 12 words not saved hold the address first (AE-02; the page refuses
 * pool.address then, so this never reads as Not available); signed out asks nothing and draws the form with Get address
 * off; then the pool's answer: refused is pool-off, not back is loading. No dry quote: deposit.dry quotes what lands in
 * the vault, never in a pool, so the checked quote is the pool's only quote.
 */
function poolFormState(i: SheetInput): SheetState {
  const amt = parseAmount(i.amount);
  const under = amt !== null && i.asset !== null && lessThan(amt, i.asset.min);
  if (i.signedIn && !i.codeSaved) return !i.asset ? "S4.1" : under ? "S4.4" : amt !== null ? "S4.19" : "S4.3";
  if (i.signedIn && i.poolOpen === false) return "pool-off";
  if (!i.asset || (i.signedIn && i.poolOpen === undefined)) return "S4.1";
  if (i.checked.kind === "refused") return REFUSAL[i.checked.code];
  if (under) return "S4.4";
  if (i.checked.kind === "pending") return "S4.2";
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

/** A row of the sheet's Recent block: a deposit of this account, its stage's word, and what it credited once done. */
export interface RecentRow {
  id: string;
  word: "deposited" | "waiting" | "processing" | "short" | "refunded" | "held" | "moved" | "expired";
  amount_usd?: string;
  /** A pool deposit's pool (its op's chain): the op carries no amount (PoolDepositFacts), so the row names its pool. */
  pool?: PoolChain;
}

const RECENT_WORD: Record<DepositStage, RecentRow["word"]> = {
  quote_checked: "waiting",
  waiting: "waiting",
  in_transit: "processing",
  into_vault: "processing",
  failed: "processing",
  done: "deposited",
  short: "short",
  refunded: "refunded",
  refund_move: "refunded",
  held: "held",
  halted: "held",
  expired: "expired",
};

const POOL_RECENT_WORD: Record<PoolDepositStage, RecentRow["word"]> = {
  quote_checked: "waiting",
  waiting: "waiting",
  in_transit: "processing",
  failed: "processing",
  in_pool: "deposited",
  short: "short",
  refunded: "refunded",
  refund_move: "refunded",
  expired: "expired",
};

/** The Recent rows: the deposits in state.ops (oldest first there), the vault's and the pools', newest first, three at
 *  most; a refund's later legs read Refunded until done. A pool deposit's row names its pool where a done vault row
 *  shows the USD credited: the pool_deposit op carries no amount. */
export function recentRows(ops: readonly Operation[] | undefined): RecentRow[] {
  const rows: RecentRow[] = [];
  for (const op of [...(ops ?? [])].reverse()) {
    if (op.kind === "pool_deposit") {
      rows.push({ id: op.id, word: POOL_RECENT_WORD[op.stage], pool: op.chain });
      if (rows.length === 3) break;
      continue;
    }
    if (op.kind !== "deposit") continue;
    // a held deposit moved out (the kit's moved_out, card held-move-forgotten-tx) is no longer held
    const word = op.moved_out === true && op.stage === "held" ? "moved" : op.refunded && op.stage !== "done" && RECENT_WORD[op.stage] === "processing" ? "refunded" : RECENT_WORD[op.stage];
    rows.push(op.stage === "done" && op.amount_usd !== undefined ? { id: op.id, word, amount_usd: op.amount_usd } : { id: op.id, word });
    if (rows.length === 3) break;
  }
  return rows;
}
