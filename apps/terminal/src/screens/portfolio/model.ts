// Portfolio (S10) and Activity (S14) as pure functions (A3.1, app.md:1459; 09-design-brief S10 and S14). Money is exact:
// every amount is a decimal string read into bigint cents, rounded down (a total never shows more than is there), and
// every percent is whole basis points from bigint division. Nothing here reads a clock or the page; the screen passes
// `now` and the time zone.
//
// What the kit gives (packages/kit/src/signpage/messages.ts SignpageState): the vault's USDC (`vault_balance`), the
// wallets with their state and size, each open position's chain, token, amount and cost, and every operation's id,
// kind, stage and txs (`ops`) with what the device knows of it beside them (kit OpDetail, card kit-portfolio-reads: its
// time, chain, token, units and USD size, each when the device holds it). What it does not give, so the screen takes it
// from `PortfolioData` (source.tsx), a local type the card's report names as missing kit calls: a token's symbol, name
// and price and whether a route sells it; a position's bought, sold and realized, its open time, its TP/SL and its held
// or reverted mark; the closed positions; the value series; and the fees paid.
import { moneyWallets, POOL_ASSET_DECIMALS, POOL_CHAINS } from "@blindfill/kit";
import { small } from "../discover/format.ts";
import { initialsBps } from "../positions/model.ts";
import { reasonOf, statePoolPrice, unitsToCents } from "../trade/model.ts";
import type { Reason } from "../trade/model.ts";
import type { Chain, Operation, PoolAsset, SignpageClientSnapshot, SignpageState, TxRef } from "@blindfill/kit";

// ---------------------------------------------------------------------------------------------------- exact decimals

/** A non-negative or negative decimal string to cents, rounded toward minus infinity. Garbage reads as null. */
export function cents(s: string | null | undefined): bigint | null {
  if (s == null) return null;
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return null;
  const neg = m[1] === "-";
  const frac = m[3] ?? "";
  let c = BigInt(m[2]!) * 100n + BigInt((frac + "00").slice(0, 2));
  const rest = frac.length > 2 && /[1-9]/.test(frac.slice(2));
  if (neg) c = -c - (rest ? 1n : 0n);
  return c;
}

/** amount x price (both decimal strings) in cents, rounded down. Null when either is not a number. */
export function mulCents(amount: string, price: string): bigint | null {
  const a = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  const p = /^(\d+)(?:\.(\d+))?$/.exec(price.trim());
  if (!a || !p) return null;
  const af = a[2] ?? "";
  const pf = p[2] ?? "";
  const n = BigInt(a[1]! + af) * BigInt(p[1]! + pf) * 100n;
  return n / 10n ** BigInt(af.length + pf.length);
}

/** A decimal string to the nearest cent, half up (a row's own figure: a $0.0099999 buy, the device's own floors of a
 *  $0.01 ask, reads $0.01, never $0.00). Garbage reads as null. Totals keep `cents`, rounded down. */
export function centsNear(s: string | null | undefined): bigint | null {
  const m = s == null ? null : /^(-)?(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return null;
  const frac = m[3] ?? "";
  const c = BigInt(m[2]! + (frac + "00").slice(0, 2)) + (Number(frac[2] ?? "0") >= 5 ? 1n : 0n);
  return m[1] === "-" ? -c : c;
}

/** "$1,234.56", "-$4.08" or "+$29.63" from cents; a zero has no sign ("$0.00"). */
export function usd(c: bigint, plus = false): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const whole = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "−" : plus && c > 0n ? "+" : ""}$${whole}.${(a % 100n).toString().padStart(2, "0")}`;
}

/** Basis points of part / whole, truncated toward zero; null for a zero whole. */
export function bps(part: bigint, whole: bigint): number | null {
  return whole === 0n ? null : Number((part * 10000n) / whole);
}

/** "+119.0%", "−8.2%" from basis points, to the nearest tenth (half away from zero), as a figure to the nearest cent;
 *  one that rounds to 0.0 draws "0.0%" with no sign. From bps(), cut toward zero: the cut never moves the tenth. */
export function pct(b: number | null): string {
  if (b === null) return "—";
  const a = Math.abs(b);
  const t = Math.trunc(a / 10) + (a % 10 >= 5 ? 1 : 0);
  return `${t === 0 ? "" : b < 0 ? "−" : "+"}${Math.trunc(t / 10)}.${t % 10}%`;
}

/** An exact figure's sign (-1n, 0n or 1n), for its tone: a figure's tone follows its exact sign, never the rounded one
 *  (a loss that draws "$0.00" is a loss); only an exact zero is neutral. */
export const signOf = (x: bigint): bigint => (x > 0n ? 1n : x < 0n ? -1n : 0n);

/** Token units, short: 891.5K, 3.77B, 96.2. Under 0.01 the price's small-number form (0.004, 0.0₅123), cut and never
 *  rounded up, so a holding is never drawn as 0. Display only; never summed. */
export function units(s: string): string {
  const v = Number(s);
  if (!Number.isFinite(v)) return "—";
  if (v > 0 && v < 0.01) return small({ n: v, s: /^\d+(\.\d+)?$/.test(s) ? s : v.toFixed(20) });
  const t = (x: number, k: string) => { const f = x < 10 ? 100 : 10; return `${(Math.floor(x * f) / f).toFixed(f === 100 ? 2 : 1).replace(/\.?0+$/, "")}${k}`; };
  if (v >= 1e9) return t(v / 1e9, "B");
  if (v >= 1e6) return t(v / 1e6, "M");
  if (v >= 1e3) return t(v / 1e3, "K");
  return t(v, "");
}

/** "6d 6h", "24h", "45m" from ms. */
export function held(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(0, Math.floor(ms / 60_000))}m`;
  if (h <= 48) return `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ------------------------------------------------------------------------------------------------- the local data

/** A token's market read (the markets lead's data API). Not in the kit. */
export interface TokenMarket {
  symbol: string;
  name: string;
  /** USD per unit, decimal string; null when no price is known (S10.4). */
  price: string | null;
  /** False when no route sells it now (S10.6: valued at the last price). Null: not read; whether a token sells is the
   *  device's own sell quote, which no read gives the app yet, never the helper's word (card market-token-reads). */
  route: boolean | null;
}

/** What a position carries beyond the kit's row. Not in the kit. */
export interface PositionExtra {
  /** USD decimal strings. */
  bought?: string;
  sold?: string;
  realized?: string;
  opened_at?: number;
  /** S10.8 held on NEAR until the claim lands; S10.7 the buy reverted. */
  mark?: "held" | "reverted";
  exit?: { tp_bps: number; sl_bps: number };
}

/** A position sold to zero (tradeBook, from the device's own trade ops). */
export interface ClosedTrade {
  chain: Chain;
  token: string;
  /** USD decimal strings; each null when a record names no USD (a dash, never a made-up figure). */
  bought: string | null;
  sold: string | null;
  opened_at: number;
  closed_at: number;
  /** The chain pool's asset and what the trade paid into the venue and got out of it, whole units of it (the ops'
   *  pool_amount); null on NEAR (USDC: the USD is it) or when a record names none. */
  asset?: PoolAsset | null;
  bought_asset?: string | null;
  sold_asset?: string | null;
}

/** A one-time wallet whose key was exported on SIGN_HOST (S14.4). Not in the kit. */
export interface ExportedKey {
  id: string;
  at: number;
  chain: Chain;
  token: string;
  address: string;
}

export interface PortfolioData {
  market(chain: Chain, token: string): TokenMarket | null;
  extra(chain: Chain, token: string): PositionExtra | null;
  closed: readonly ClosedTrade[];
  /** The value over time, oldest first: [unix ms, USD decimal string]. */
  series: readonly (readonly [number, string])[];
  /** USD decimal string: the buys' and sells' fees from this browser's receipts (CN-116). */
  fees: string | null;
  exported: readonly ExportedKey[];
}

/** No market reads, no closed trades, no series: what the live source has until the kit carries them (dashes). */
export const NO_DATA: PortfolioData = { market: () => null, extra: () => null, closed: [], series: [], fees: null, exported: [] };

// --------------------------------------------------------------------------------------------------- positions S10

export type Mark = "noRoute" | "held" | "reverted" | null;

export interface Row {
  key: string;
  chain: Chain;
  token: string;
  symbol: string;
  name: string;
  units: string;
  /** The token's own decimals as the signing page's state names them (positions[].decimals, kit 1.8; card
   *  signpage-state-holdings); null from a page that names none. Never the helper's: a sell is sized from it. */
  decimals: number | null;
  /** Null: unknown (the signing page's cost "0": a wallet's buy with no price read, src/positions.ts). Its exact figure
   *  to the nearest cent, as every row figure; a total is the exact sum rounded down once (totals), never a sum of these. */
  cost: bigint | null;
  /** Null: no price (S10.4). The exact value to the nearest cent. */
  value: bigint | null;
  /** The exact cost and value in USD at SCALE decimals (fx), for the totals, the share and Initials; null as above. */
  costX: bigint | null;
  valueX: bigint | null;
  /** The exact PnL to the nearest cent, its percent from the exact figures. */
  pnl: bigint | null;
  pnlBps: number | null;
  /** The exact PnL's sign, for the tone of the PnL and its percent; null with no PnL. */
  pnlSign: bigint | null;
  /** The share of the position whose value returns its cost, in basis points rounded up, from the exact figures: what
   *  Initials sells (the share_bps the device signs). Null when the position is not up or a figure is unknown. */
  initials: number | null;
  /** Null: no USD for the buys (and no cost). */
  bought: bigint | null;
  sold: bigint;
  realized: bigint;
  /** The open position's realized part, exact (fx). */
  realizedX: bigint;
  mark: Mark;
  exit: PositionExtra["exit"] | null;
  wallets: number;
  /** The wallets that hold it, each with its own export (card app-export-every-wallet). */
  addresses: string[];
  openedAt: number | null;
  /** S10.12: a sell of this token on its way, from the kit's op: its stage, chain, token and time. */
  selling: { stage: "sending" | "landing"; ms: number } | null;
}

/** One chain's part of Cash (card portfolio-one-balance): NEAR's is the vault's USDC, a pool chain's its pool at the
 *  signing page's price, each with the READY wallets on that chain. */
export interface CashPart {
  chain: Chain;
  /** Null: a pool that holds something the page has no fresh price for. It is left out of Cash, never priced here (the
   *  chain's other money still counts in Cash). */
  cents: bigint | null;
  /** A deposit of this chain's money is between its source and the vault or pool (CASH_MOVING): its amount is on
   *  neither side yet, and the kit carries none for it. */
  moving: boolean;
}

export interface Totals {
  /** The vault, every pool priced and the READY wallets, each once. */
  cash: bigint;
  /** Each chain's part of `cash`, NEAR first, then the pool chains in the kit's order: a chain with nothing and no
   *  deposit moving is left out, NEAR never. */
  parts: CashPart[];
  /** Cash less the SOL and ETH pools: what a chain the trade box buys on with no pool spends (the vault path). */
  offPool: bigint;
  onWay: bigint;
  /** What the open buys' one-time wallets hold beside their tokens and get back at the sell (the signing page's
   *  positions[].asset_held: the wallet's own coin and its accounts' rent), at the pool's price; part of `inPos`. */
  held: bigint;
  /** The chains whose open buys hold any of `held`, in the order the positions name them (the Reserve part's mark). */
  heldChains: Chain[];
  /** The positions' own value, the exact sum rounded down once: `inPos` less `held` (the Coins part, owner 12 Nov
   *  16:17:50Z option B). */
  coins: bigint;
  inPos: bigint;
  total: bigint;
  unreal: bigint;
  realized30: bigint;
  /** The exact sums' signs, for the tones of `unreal` and `realized30`. */
  unrealSign: bigint;
  realized30Sign: bigint;
  /** A position with no price: counted at its cost in `inPos` and `total`, left out of `unreal`. */
  partial: boolean;
}

export type View = "S10.1" | "S10.2" | "S10.3";

export interface Portfolio {
  view: View;
  offline: boolean;
  rows: Row[];
  totals: Totals | null;
  pools: Pools;
}

const key = (chain: Chain, token: string) => `${chain}:${token}`;
const DAY = 86_400_000;

function rowOf(p: SignpageState["positions"][number], d: PortfolioData, ops: readonly Operation[], now: number): Row {
  const m = d.market(p.chain, p.token);
  const x = d.extra(p.chain, p.token) ?? {};
  // the signing page's cost "0" is unknown (src/positions.ts): no cost, so no bought and no PnL, never its value as profit
  const costX = /[1-9]/.test(p.cost) ? fx(p.cost) : null;
  // a zero price is no read (no route quoted it): the value is the dash, never $0.00 (owner 10 Nov 18:12Z); every row
  // figure is its exact figure to the nearest cent (a $0.0099999 buy is $0.01), its PnL the exact difference so
  const priced = m?.price != null && /[1-9]/.test(m.price) ? m.price : null;
  const amountX = fx(p.amount);
  const priceX = priced === null ? null : fx(priced);
  const valueX = amountX === null || priceX === null ? null : (amountX * priceX) / ONE;
  const cost = costX === null ? null : nearCents(costX);
  const value = valueX === null ? null : nearCents(valueX);
  const pnlX = valueX === null || costX === null ? null : valueX - costX;
  let selling: Row["selling"] = null;
  for (const o of ops) {
    if (o.kind !== "sell" || (o.stage !== "signed" && o.stage !== "sent")) continue;
    if (o.chain === p.chain && o.token === p.token) selling = { stage: o.stage === "signed" ? "sending" : "landing", ms: o.created_ms === undefined ? 0 : Math.max(0, now - o.created_ms) };
  }
  return {
    key: key(p.chain, p.token),
    chain: p.chain,
    token: p.token,
    symbol: m?.symbol ?? p.token.slice(0, 6),
    name: m?.name ?? "",
    units: p.amount,
    decimals: p.decimals ?? null,
    cost,
    value,
    costX,
    valueX,
    pnl: pnlX === null ? null : nearCents(pnlX),
    pnlBps: pnlX === null || costX === null ? null : bps(pnlX, costX),
    pnlSign: pnlX === null ? null : signOf(pnlX),
    initials: costX === null ? null : initialsBps(costX, valueX),
    bought: centsNear(x.bought) ?? cost,
    sold: centsNear(x.sold) ?? 0n,
    realized: centsNear(x.realized) ?? 0n,
    realizedX: fxSigned(x.realized) ?? 0n,
    mark: x.mark ?? (m && m.route === false ? "noRoute" : null),
    exit: x.exit ?? null,
    wallets: p.wallets.length,
    addresses: [...new Set(p.wallets)],
    openedAt: x.opened_at ?? null,
    selling,
  };
}

/** A share of the position's value in cents (`b` basis points of the exact value, to the nearest cent, as a row figure);
 *  null with no value. */
export const shareOf = (r: Row, b: number): bigint | null => (r.valueX === null ? null : nearCents((r.valueX * BigInt(b)) / 10_000n));

/** The row a sale that sold it all leaves on the trade box (card app-holding-follows-a-fill): nothing held, so no value,
 *  no share and no Initials, every other figure as it was. */
export const soldOutRow = (r: Row): Row => ({ ...r, units: "0", value: 0n, valueX: 0n, initials: null });

/** Rows by value, largest first; a row with no price after the priced ones, by cost; ties by symbol. */
export function sortRows(rows: readonly Row[]): Row[] {
  return [...rows].sort((a, b) => {
    if ((a.value === null) !== (b.value === null)) return a.value === null ? 1 : -1;
    const av = a.value ?? a.cost ?? 0n;
    const bv = b.value ?? b.cost ?? 0n;
    if (av !== bv) return av > bv ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });
}

/** Realized PnL of the trades closed in the 30 days to now, plus the open positions' realized part. A close whose sale
 *  names no USD adds nothing. */
export function realized30(rows: readonly Row[], closed: readonly ClosedTrade[], now: number): bigint {
  // the exact sum rounded once toward zero, as every total (a total never shows more than there is)
  return downCents(realized30X(rows, closed, now));
}
/** realized30, exact (fx). */
function realized30X(rows: readonly Row[], closed: readonly ClosedTrade[], now: number): bigint {
  let r = rows.reduce((a, x) => a + x.realizedX, 0n);
  for (const c of closed) {
    const sx = fx(c.sold ?? undefined);
    const bx = fx(c.bought ?? undefined);
    // a side with no USD: the realized is unknown, not counted
    if (sx === null || bx === null || c.closed_at <= now - 30 * DAY || c.closed_at > now) continue;
    r += sx - bx;
  }
  return r;
}

// ------------------------------------------------------------------------------------------ the trade book (ops)

/** Each chain's pool asset, for a trade op's pool_amount (kit OpDetail): NEAR's money is the vault's USDC, whose USD
 *  is amount_usd itself. */
const TRADE_ASSET: Readonly<Record<Chain, PoolAsset | null>> = { solana: "SOL", base: "ETH", robinhood: "ETH", near: null };
/** Fixed scale for summing decimal strings exactly (a token's or asset's whole units, USD): every decimal the kit's
 *  state schema allows (78, schema.ts dec), so no figure it sends is refused here. */
const SCALE = 78;
const fx = (s: string | undefined): bigint | null => {
  const m = s === undefined ? null : /^(\d{1,78})(?:\.(\d{1,78}))?$/.exec(s);
  return m ? BigInt(m[1]! + (m[2] ?? "").padEnd(SCALE, "0")) : null;
};
const unfx = (n: bigint): string => {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(SCALE + 1, "0");
  const frac = s.slice(-SCALE).replace(/0+$/, "");
  return `${neg ? "-" : ""}${s.slice(0, -SCALE)}${frac ? `.${frac}` : ""}`;
};
/** One USD at SCALE decimals. */
const ONE = 10n ** BigInt(SCALE);
/** fx with a sign ("-0.05"), as the trade book writes a loss. */
const fxSigned = (s: string | undefined): bigint | null => {
  if (s === undefined) return null;
  const v = fx(s.replace(/^-/, ""));
  return v === null ? null : s.startsWith("-") ? -v : v;
};
/** An exact USD figure (fx) in cents to the nearest, half away from zero: a row's figure. */
export const nearCents = (x: bigint): bigint => {
  const a = x < 0n ? -x : x;
  const c = (a * 200n + ONE) / (2n * ONE);
  return x < 0n ? -c : c;
};
/** An exact USD figure (fx) in cents rounded down (toward minus infinity): a total, rounded once, never better than
 *  the exact figure (never more than there is, and a loss never less than it is). */
export const downCents = (x: bigint): bigint => (x >= 0n ? (x * 100n) / ONE : -((-x * 100n + ONE - 1n) / ONE));
/** A sum that stays null once any part is unknown. */
const add = (a: bigint | null, b: bigint | null): bigint | null => (a === null || b === null ? null : a + b);

interface Cycle {
  chain: Chain;
  token: string;
  opened: number;
  last: number;
  usdIn: bigint | null;
  usdOut: bigint | null;
  assetIn: bigint | null;
  assetOut: bigint | null;
  /** Token units bought and sold; null once a record names none. */
  unitsIn: bigint | null;
  unitsOut: bigint | null;
  sells: number;
}

/**
 * The device's trades by token (card portfolio-shows-pool-trades), from the signing page's ops alone: every filled or
 * part-filled buy and every filled sale, oldest first, as round trips. A round trip opens at a buy and closes once its
 * sales have sold every unit its buys got (each record's units: a buy's what W received, a sale's what it sold). A
 * record from before units were kept closes its round trip at the next buy after a sale, or at its last sale once
 * nothing of the token is held. Each trade's USD is its amount_usd and its pool asset its pool_amount: one record with
 * none makes that side unknown (a dash), never a guess. What is still open gives its row's bought, sold, realized and
 * opened time; realized there is the sales less the buys' cost of the units sold.
 */
export function tradeBook(ops: readonly Operation[], positions: readonly { chain: Chain; token: string; amount: string }[]): { closed: ClosedTrade[]; open: Map<string, PositionExtra> } {
  const trades = ops
    .filter((o) => o.chain !== undefined && o.token !== undefined && o.created_ms !== undefined && ((o.kind === "buy" && (o.stage === "filled" || o.stage === "part_filled")) || (o.kind === "sell" && o.stage === "filled")))
    .sort((a, b) => a.created_ms! - b.created_ms!);
  const closed: ClosedTrade[] = [];
  const cur = new Map<string, Cycle>();
  const close = (k: string, c: Cycle) => {
    const asset = TRADE_ASSET[c.chain];
    closed.push({
      chain: c.chain,
      token: c.token,
      bought: c.usdIn === null ? null : unfx(c.usdIn),
      sold: c.usdOut === null ? null : unfx(c.usdOut),
      opened_at: c.opened,
      closed_at: c.last,
      asset,
      bought_asset: asset && c.assetIn !== null ? unfx(c.assetIn) : null,
      sold_asset: asset && c.assetOut !== null ? unfx(c.assetOut) : null,
    });
    cur.delete(k);
  };
  for (const o of trades) {
    const k = key(o.chain!, o.token!);
    const t = o.created_ms!;
    let c = cur.get(k);
    const units = fx(o.units);
    const usdv = fx(o.amount_usd);
    const assetv = fx(o.pool_amount);
    if (o.kind === "buy") {
      // a record with no units: a buy after a sale opens the next round trip
      if (c && c.sells > 0 && (c.unitsIn === null || c.unitsOut === null)) {
        close(k, c);
        c = undefined;
      }
      if (!c) cur.set(k, (c = { chain: o.chain!, token: o.token!, opened: t, last: t, usdIn: 0n, usdOut: 0n, assetIn: 0n, assetOut: 0n, unitsIn: 0n, unitsOut: 0n, sells: 0 }));
      c.usdIn = add(c.usdIn, usdv);
      c.assetIn = add(c.assetIn, assetv);
      c.unitsIn = add(c.unitsIn, units);
      c.last = t;
      continue;
    }
    if (!c) continue; // a sale of nothing this device bought
    c.usdOut = add(c.usdOut, usdv);
    c.assetOut = add(c.assetOut, assetv);
    c.unitsOut = add(c.unitsOut, units);
    c.sells++;
    c.last = t;
    if (c.unitsIn !== null && c.unitsOut !== null && c.unitsOut >= c.unitsIn) close(k, c);
  }
  const open = new Map<string, PositionExtra>();
  const holds = new Set(positions.filter((p) => /[1-9]/.test(p.amount)).map((p) => key(p.chain, p.token)));
  for (const [k, c] of [...cur]) {
    if (c.sells > 0 && !holds.has(k) && (c.unitsIn === null || c.unitsOut === null)) {
      close(k, c);
      continue;
    }
    const x: PositionExtra = { opened_at: c.opened };
    if (c.usdIn !== null) x.bought = unfx(c.usdIn);
    if (c.usdOut !== null) x.sold = unfx(c.usdOut);
    if (c.usdIn !== null && c.usdOut !== null && c.unitsIn && c.unitsOut !== null) x.realized = unfx(c.usdOut - (c.usdIn * c.unitsOut) / c.unitsIn);
    open.set(k, x);
  }
  return { closed, open };
}

/**
 * Money between its source and a side of Cash (card portfolio-one-balance): the stages at which a deposit's money has
 * been sent and is on neither side. The rule, from the kit's stages:
 * - Cash counts the kit's two totals and nothing else: vault_balance (the vault's notes) and each pool's balance (its
 *   notes, read back at finalized). An op's own amount never joins Cash: a deposit's amount_usd is what those totals
 *   already hold once it is done, and a trade's is its ask, so adding it would count the note twice.
 * - So a note is counted on the side whose total holds it, once: a vault deposit's note from "done" (vault_balance), a
 *   pool deposit's from "in_pool" (state.pools), never before, and never on the side it left.
 * - At these stages the money has left its source and is in neither total; the kit sends no amount for it (a pool
 *   deposit never carries amount_usd, a vault deposit only on done), so it cannot be counted without making one up.
 *   Its chain's part is marked moving instead, so the breakdown shows it and the money is never silently gone.
 * - Before the send (quote_checked), after a send that never happened (expired) and once landed (done, in_pool), nothing
 *   is moving. held and halted are money waiting under an id (state.held), not moving to a side.
 */
export const CASH_MOVING: { readonly deposit: ReadonlySet<string>; readonly pool_deposit: ReadonlySet<string> } = {
  deposit: new Set(["waiting", "in_transit", "into_vault", "refunded", "refund_move", "failed", "short"]),
  pool_deposit: new Set(["waiting", "in_transit", "refunded", "refund_move", "failed", "short"]),
};

/** The chain whose part an op moves money into: a vault deposit's is NEAR (the vault's chain), a pool deposit's its
 *  pool's; null for any other op or stage. */
export function movingChain(o: Operation): Chain | null {
  if (o.kind === "deposit") return CASH_MOVING.deposit.has(o.stage) ? "near" : null;
  if (o.kind === "pool_deposit") return CASH_MOVING.pool_deposit.has(o.stage) ? o.chain : null;
  return null;
}

/** The parts of Cash per chain: the vault on NEAR, each pool in dollars at the signing page's own price while it is
 *  fresh on this device's clock (trade model statePoolPrice, the trade box's one rule), each READY wallet on its chain. */
function cashParts(s: SignpageState, now: number): { cash: bigint; parts: CashPart[]; offPool: bigint } {
  const at = new Map<Chain, CashPart>();
  const part = (chain: Chain): CashPart => at.get(chain) ?? (at.set(chain, { chain, cents: 0n, moving: false }).get(chain)!);
  let cash = 0n;
  const add = (chain: Chain, c: bigint | null) => {
    const p = part(chain);
    p.cents = p.cents === null || c === null ? null : p.cents + c;
    cash += c ?? 0n;
  };
  // The vault's USDC is vault_balance alone: the signing page's pool table never holds the vault's scope (packages/
  // signpage test/pools.test.ts), so a USDC pool is other money and the vault's USDC never counts twice.
  let offPool = cents(s.vault_balance) ?? 0n;
  add("near", offPool);
  for (const p of s.pools ?? []) {
    if (p.asset === "USDC") {
      const c = cents(p.balance) ?? 0n;
      offPool += c;
      add(p.chain, c);
      continue;
    }
    const units = baseUnits(p.balance, POOL_ASSET_DECIMALS[p.asset]) ?? 0n;
    const price = statePoolPrice(s.pools, p.chain, now);
    // a pool with nothing is $0 at any price; one with something and no fresh price has no dollar figure: none is made up
    add(p.chain, units === 0n ? 0n : price ? unitsToCents(units, price) : null);
  }
  for (const w of s.wallets) {
    if (w.state !== "READY") continue;
    const c = cents(w.size) ?? 0n;
    offPool += c;
    add(w.chain, c);
  }
  for (const o of s.ops) {
    const c = movingChain(o);
    if (c) part(c).moving = true;
  }
  const order = (c: Chain) => (c === "near" ? -1 : (POOL_CHAINS as readonly Chain[]).indexOf(c) >>> 0);
  const parts = [...at.values()].filter((p) => p.chain === "near" || p.cents !== 0n || p.moving).sort((a, b) => order(a.chain) - order(b.chain));
  return { cash, parts, offPool };
}

export function totals(s: SignpageState, rows: readonly Row[], closed: readonly ClosedTrade[], now: number): Totals {
  // Cash: the vault's USDC, each pool in dollars and the READY wallets, each source counted once (cashParts; the
  // in-flight rule is CASH_MOVING's).
  const { cash, parts, offPool } = cashParts(s, now);
  let onWay = 0n;
  for (const w of s.wallets) if (w.state === "ARMING" || w.state === "RETURNING") onWay += cents(w.size) ?? 0n;
  const held = openBuysHold(s, now);
  let partial = held.partial;
  // each total the exact sum of the rows' exact figures, rounded down once (downCents): never a sum of rounded rows, so
  // it never shows better than the account is; a row and a total may differ by a cent
  let posX = 0n;
  let unrealX = 0n;
  for (const r of rows) {
    if (r.valueX === null) {
      partial = true;
      posX += r.costX ?? 0n;
    } else {
      posX += r.valueX;
      // a row of unknown cost has no PnL: its value is in the positions, none of it in the unrealized
      if (r.costX !== null) unrealX += r.valueX - r.costX;
    }
  }
  const coins = downCents(posX);
  const inPos = held.cents + coins;
  return { cash, parts, offPool, onWay, held: held.cents, heldChains: held.chains, coins, inPos, total: cash + onWay + inPos, unreal: downCents(unrealX), realized30: realized30(rows, closed, now), unrealSign: signOf(unrealX), realized30Sign: signOf(realized30X(rows, closed, now)), partial };
}

/**
 * What the open buys hold beside their tokens (card portfolio-counts-money-an-open-buy-holds): each position's
 * asset_held (the signing page's read of its one-time wallets: their own coin and the rent of the accounts a full sell
 * closes back to them; never the fees paid), summed per chain in its pool's asset and priced once at the page's own
 * fresh price, rounded down. A position whose wallet the state already counts (an arm record in `wallets`) adds none,
 * so no money counts twice; a chain with no fresh price adds none and marks the total partial, never a made-up figure.
 */
function openBuysHold(s: SignpageState, now: number): { cents: bigint; chains: Chain[]; partial: boolean } {
  const counted = new Set(s.wallets.map((w) => `${w.chain}:${w.address}`));
  const by = new Map<Chain, bigint>();
  let partial = false;
  for (const p of s.positions) {
    if (p.asset_held === undefined || p.wallets.some((w) => counted.has(`${p.chain}:${w}`))) continue;
    const pool = s.pools?.find((x) => x.chain === p.chain);
    const units = pool ? baseUnits(p.asset_held, POOL_ASSET_DECIMALS[pool.asset]) : null;
    if (units === null) {
      partial = true;
      continue;
    }
    by.set(p.chain, (by.get(p.chain) ?? 0n) + units);
  }
  // each chain's value exact, in cents x 10^HELD_SCALE (past any pool price's own scale), summed, then rounded down once
  let x = 0n;
  const chains: Chain[] = [];
  for (const [chain, units] of by) {
    if (units === 0n) continue;
    const price = statePoolPrice(s.pools, chain, now);
    if (price) {
      x += unitsToCents(units * 10n ** HELD_SCALE, price);
      chains.push(chain);
    } else partial = true;
  }
  return { cents: x / 10n ** HELD_SCALE, chains, partial };
}

/** The scale openBuysHold sums at: a pool price's own scale is expo + 2 - decimals (SOL -15, ETH -24), so 10^36 keeps
 *  every chain's figure exact before the one rounding. */
const HELD_SCALE = 36n;

/** The screen's state from the signing page's snapshot and the local data. */
export function portfolio(snap: SignpageClientSnapshot, d: PortfolioData, now: number): Portfolio {
  const offline = snap.status === "down";
  const s = snap.state;
  if (!s) return { view: offline ? "S10.2" : "S10.1", offline, rows: [], totals: null, pools: { view: offline ? "offline" : "loading", rows: [] } };
  const rows = sortRows(s.positions.map((p) => rowOf(p, d, s.ops, now)));
  return { view: rows.length ? "S10.3" : "S10.2", offline, rows, totals: totals(s, rows, d.closed, now), pools: pools(s, offline) };
}

/** The open position the trade box's Sell side sells (card app-sell-mount): the row of `rows` on `chain` whose token is
 *  `token`, holding more than nothing; null otherwise. Never another chain's row of the same address. An EVM address
 *  matches in any case (its checksum is case alone); a Solana mint (case-sensitive base58) and a NEAR account id (lower
 *  case by rule, apps/helper/src/withdraw/checks.ts) match exactly. */
export function heldOf(rows: readonly Row[], chain: Chain, token: string): Row | null {
  if (!token) return null;
  const same = chain === "solana" || chain === "near" ? (t: string) => t === token : (t: string) => t.toLowerCase() === token.toLowerCase();
  return rows.find((r) => r.chain === chain && same(r.token) && /^[0-9.]+$/.test(r.units) && /[1-9]/.test(r.units)) ?? null;
}

/** The one balance the app draws: Portfolio's Cash (totals(); design-lock-r5 S10.3 shows Cash in the header), for the
 *  header, the deposit and withdraw screens and the restore screen alike, so no two of them ever differ; null before the
 *  first state. */
export const balanceOf = (snap: SignpageClientSnapshot, d: PortfolioData, now: number): bigint | null => portfolio(snap, d, now).totals?.cash ?? null;

// ------------------------------------------------------------------------------------- wallets with no position

/** A wallet that holds money but no open position (card app-export-every-wallet): a deposit wallet with money left, in
 *  its chain's pool asset, or a fresh or hop wallet armed, ready or returning, at its size in USD. Each has its export. */
export interface WalletRow {
  chain: Chain;
  address: string;
  role: "trade" | "deposit";
  /** A deposit wallet's balance in base units of `asset`; null for a trade wallet. */
  amount: bigint | null;
  asset: PoolAsset | null;
  /** A trade wallet's size in cents; null for a deposit wallet. */
  size: bigint | null;
}

/** Every wallet the kit's moneyWallets names that no open position holds, in its order: positions draw their own. */
export function walletRows(s: SignpageState | null): WalletRow[] {
  if (!s) return [];
  return moneyWallets(s)
    .filter((w) => w.tokens.length === 0)
    .map((w) => {
      const d = w.role === "deposit" ? (s.deposit_wallets ?? []).find((x) => x.chain === w.chain && x.address === w.address) : undefined;
      const t = w.role === "trade" ? s.wallets.find((x) => x.chain === w.chain && x.address === w.address) : undefined;
      return {
        chain: w.chain,
        address: w.address,
        role: w.role,
        amount: d ? baseUnits(d.amount, POOL_ASSET_DECIMALS[d.asset]) : null,
        asset: d?.asset ?? null,
        size: t ? cents(t.size) : null,
      };
    });
}

/** A wallet's address, short: its first and last four characters, whole when it is ten or fewer. Data, not copy. */
export const shortAddress = (a: string): string => (a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`);

// ------------------------------------------------------------------------------------------------- the pools (A1)

/** A decimal string in whole units to base units at `d` decimals, rounded down; null when it is not one. */
export function baseUnits(s: string, d: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return null;
  return BigInt(m[1]! + ((m[2] ?? "") + "0".repeat(d)).slice(0, d));
}

/** Base units at `d` decimals, short and rounded down: up to 6 decimals below 1 ("0.001", "0.000123"), up to 4 below
 *  1,000 ("12.5"), then K, M and B with up to 2 ("12.5K", "1.25M"). A nonzero amount under the smallest digit drawn
 *  reads "<0.000001" (at the asset's decimals when fewer), never "0". At most 9 characters up to 999.99B; past that
 *  the column widens, never clips. Never summed. */
export function amount(base: bigint, d: number): string {
  const one = 10n ** BigInt(d);
  const show = (v: bigint, unit: bigint, dp: number, k: string): string => {
    const w = v / unit;
    const f = ((v % unit) * 10n ** BigInt(dp)) / unit;
    const frac = dp ? f.toString().padStart(dp, "0").replace(/0+$/, "") : "";
    return `${w}${frac ? `.${frac}` : ""}${k}`;
  };
  if (base < one) {
    const dp = Math.min(6, d);
    const s = show(base, one, dp, "");
    return s === "0" && base > 0n ? (dp === 0 ? "<1" : `<0.${"0".repeat(dp - 1)}1`) : s;
  }
  if (base < 1000n * one) return show(base, one, Math.min(4, d), "");
  if (base < 1_000_000n * one) return show(base, 1000n * one, 2, "K");
  if (base < 1_000_000_000n * one) return show(base, 1_000_000n * one, 2, "M");
  return show(base, 1_000_000_000n * one, 2, "B");
}

/** One chain's pool in its own asset: the private balance from the device's own notes, the part with a proof ready
 *  (null: no proof queue runs, drawn as a dash, never 0) and the rest, still being proved. Base units of the asset,
 *  decimals from the kit's table only. */
export interface PoolRow {
  chain: Chain;
  asset: PoolAsset;
  decimals: number;
  balance: bigint;
  ready: bigint | null;
  pending: bigint | null;
}

/** loading: no state yet. offline: the signing page is down. unread: the page sent no pools (it cannot read the
 *  notes, or it is a page that does not send them): dashes. empty: no pool holds anything. rows: one per chain. */
export type PoolsView = "loading" | "offline" | "unread" | "empty" | "rows";

export interface Pools {
  view: PoolsView;
  rows: PoolRow[];
}

/** The pool rows from the signing page's state: NEAR's first, the vault's USDC (vault_balance; the page's pool table
 *  never holds the vault, as cashParts reads it), with no proof queue sent for it, so Ready and Pending are null
 *  (dashes); then the pools in the page's order. A ready above the balance is held to it. */
export function pools(s: SignpageState, offline = false): Pools {
  if (s.pools === undefined) return { view: offline ? "offline" : "unread", rows: [] };
  const vault: PoolRow = { chain: "near", asset: "USDC", decimals: POOL_ASSET_DECIMALS.USDC, balance: baseUnits(s.vault_balance, POOL_ASSET_DECIMALS.USDC) ?? 0n, ready: null, pending: null };
  const rows = [vault, ...s.pools.map((p): PoolRow => {
    const decimals = POOL_ASSET_DECIMALS[p.asset];
    const balance = baseUnits(p.balance, decimals) ?? 0n;
    const r = p.ready === undefined ? null : baseUnits(p.ready, decimals) ?? 0n;
    const ready = r === null ? null : r > balance ? balance : r;
    return { chain: p.chain, asset: p.asset, decimals, balance, ready, pending: ready === null ? null : balance - ready };
  })];
  return { view: rows.some((r) => r.balance > 0n) ? "rows" : "empty", rows };
}

export const SMALL = 100n; // VN-12 A: hide small hides positions worth under $1 (owner round 16)

/** S10.11: the typed search (symbol or name, any case) and hide small (worth under $1; a row with no price stays). */
export function filterRows(rows: readonly Row[], q: string, hideSmall: boolean): Row[] {
  const t = q.trim().toLowerCase();
  return rows.filter((r) => (!t || r.symbol.toLowerCase().includes(t) || r.name.toLowerCase().includes(t)) && !(hideSmall && r.value !== null && r.value < SMALL));
}

export interface ClosedRow {
  key: string;
  chain: Chain;
  token: string;
  symbol: string;
  name: string;
  /** Null: the record names no USD (a dash). */
  bought: bigint | null;
  sold: bigint | null;
  realized: bigint | null;
  /** The realized exact (fx), for the calendar's days; null when unknown. */
  realizedX: bigint | null;
  realizedBps: number | null;
  /** The pool asset (SOL, ETH) and the realized in it, exact ("-0.000631252"); null on NEAR or when unknown. */
  asset: PoolAsset | null;
  realizedAsset: string | null;
  heldMs: number;
  closedAt: number;
}

/** S10.10: the closed list, newest close first. */
export function closedRows(d: PortfolioData): ClosedRow[] {
  return d.closed
    .map((c) => {
      const m = d.market(c.chain, c.token);
      // each figure its exact figure to the nearest cent, as an open row's (a $0.0999999 buy is $0.10), the realized the
      // exact difference so ($0.0025 lost reads $0.00), its percent from the exact figures (−2.5%)
      const bought = centsNear(c.bought);
      const sold = centsNear(c.sold);
      const bx = fx(c.bought ?? undefined);
      const sx = fx(c.sold ?? undefined);
      const exact = bx !== null && sx !== null ? sx - bx : null;
      // a side with no USD: realized and its percent unknown (a dash), as for a sale with none
      const realized = sold === null || bought === null ? null : exact !== null ? nearCents(exact) : sold - bought;
      const realizedBps = realized === null || bought === null ? null : exact !== null && bx !== null ? (bx === 0n ? null : Number((exact * 10000n) / bx)) : bps(realized, bought);
      const ai = fx(c.bought_asset ?? undefined);
      const ao = fx(c.sold_asset ?? undefined);
      const asset = c.asset ?? null;
      return { key: `${key(c.chain, c.token)}:${c.closed_at}`, chain: c.chain, token: c.token, symbol: m?.symbol ?? c.token.slice(0, 6), name: m?.name ?? "", bought, sold, realized, realizedX: sold === null || bought === null ? null : exact, realizedBps, asset, realizedAsset: asset && ai !== null && ao !== null ? unfx(ao - ai) : null, heldMs: c.closed_at - c.opened_at, closedAt: c.closed_at };
    })
    .sort((a, b) => b.closedAt - a.closedAt);
}

// ------------------------------------------------------------------------------------------------- the PnL header

export interface Stats {
  trades: number;
  /** Null with no closed trade (S10.14: dashes). */
  winBps: number | null;
  avgWinBps: number | null;
  avgLossBps: number | null;
  avgRetBps: number | null;
  avgHoldMs: number | null;
  /** Closed trades per return bucket, R5's edges (−100, −50, −20, 0, +20, +50, +100, +300 %). */
  buckets: number[];
}

export const EDGES = [-10000, -5000, -2000, 0, 2000, 5000, 10000, 30000];

const avg = (xs: number[]) => (xs.length ? Math.trunc(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export function stats(closed: readonly ClosedRow[]): Stats {
  // a close with no known result counts as a trade, never as a win, a loss or a return
  const r = closed.flatMap((c) => (c.realizedBps === null ? [] : [c.realizedBps]));
  const buckets = EDGES.map((lo, i) => r.filter((b) => b >= lo && (i === EDGES.length - 1 || b < EDGES[i + 1]!)).length);
  const wins = r.filter((b) => b > 0);
  const losses = r.filter((b) => b <= 0);
  return {
    trades: closed.length,
    winBps: r.length ? Math.trunc((wins.length * 10000) / r.length) : null,
    avgWinBps: avg(wins),
    avgLossBps: avg(losses),
    avgRetBps: avg(r),
    avgHoldMs: avg(closed.map((c) => c.heldMs)),
    buckets,
  };
}

export interface Day {
  day: number;
  /** The day's realized PnL in cents; null: no trade closed that day. */
  pnl: bigint | null;
  /** Its exact sign, for its tone; null as pnl. */
  sign: bigint | null;
  future: boolean;
  today: boolean;
}

/** The PnL calendar: the month of `now` (UTC days), each day's realized PnL from the trades closed that day. */
export function calendar(closed: readonly ClosedRow[], now: number): { year: number; month: number; lead: number; days: Day[]; sum: bigint; sumSign: bigint; green: number; red: number } {
  const n = new Date(now);
  const year = n.getUTCFullYear();
  const month = n.getUTCMonth();
  const len = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  // each day and the month the exact sum rounded once toward zero, as every total (a row with no exact figure: its cents)
  const per = new Map<number, bigint>();
  for (const c of closed) {
    const d = new Date(c.closedAt);
    const x = c.realizedX ?? (c.realized === null ? null : (c.realized * ONE) / 100n);
    if (x !== null && d.getUTCFullYear() === year && d.getUTCMonth() === month) per.set(d.getUTCDate(), (per.get(d.getUTCDate()) ?? 0n) + x);
  }
  const days: Day[] = Array.from({ length: len }, (_, i) => ({ day: i + 1, pnl: per.has(i + 1) ? downCents(per.get(i + 1)!) : null, sign: per.has(i + 1) ? signOf(per.get(i + 1)!) : null, future: i + 1 > n.getUTCDate(), today: i + 1 === n.getUTCDate() }));
  let sumX = 0n;
  let green = 0;
  let red = 0;
  // a day is green or red by its exact sign, as its tone
  for (const x of per.values()) {
    sumX += x;
    if (x > 0n) green++;
    if (x < 0n) red++;
  }
  return { year, month, lead, days, sum: downCents(sumX), sumSign: signOf(sumX), green, red };
}

export type Range = "1D" | "1W" | "1M" | "All";
const SPAN: Record<Range, number> = { "1D": DAY, "1W": 7 * DAY, "1M": 30 * DAY, All: Infinity };

/** The value chart's `n` axis ticks between lo and hi (USD), at the grid's places, each with a label: whole dollars
 *  while they differ, else cents, else as many decimals as it takes, so no two ticks read alike at any range. */
export function axisLabels(lo: number, hi: number, n: number): { v: number; label: string }[] {
  const vs = Array.from({ length: n }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / n);
  const at = (dp: number) => vs.map((v) => `$${v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`);
  let labels = at(0);
  for (let dp = 2; new Set(labels).size < n && dp <= 8; dp++) labels = at(dp);
  return vs.map((v, i) => ({ v, label: labels[i]! }));
}

/** The value line for a range: the points in it, in cents, oldest first. */
export function line(series: PortfolioData["series"], range: Range, now: number): [number, bigint][] {
  return series.filter(([t]) => t > now - SPAN[range] && t <= now).map(([t, v]) => [t, cents(v) ?? 0n]);
}

// ------------------------------------------------------------------------------------------------------ Activity S14

export type ActKind = "buy" | "sell" | "deposit" | "withdraw" | "export";
export const ACT_KINDS: readonly ActKind[] = ["buy", "sell", "deposit", "withdraw", "export"];

export interface ActRow {
  id: string;
  kind: ActKind;
  /** The kit's stage; "key_exported" for an exported key's row. */
  stage: string;
  at: number | null;
  usd: bigint | null;
  units: string | null;
  chain: Chain | null;
  token: string | null;
  txs: readonly TxRef[];
  /** S14.4: the address whose key was exported. */
  address: string | null;
  /** A buy or sell that did not happen (refused, not landed): its row's Transaction failed tag, with the trade box's
   *  reason for the kit's code on hover when the app has words for it (notLanded for a trade that did not land); null
   *  for any other row. Never the kit's code itself. */
  failed: { reason: Reason | "notLanded" | null } | null;
}

export interface ActGroup {
  /** "today", "yesterday", a date ("Oct 30") or null for rows with no time (after a restore). */
  label: "today" | "yesterday" | string | null;
  rows: ActRow[];
}

export interface ActFilter {
  kinds: readonly ActKind[];
  /** Cents; rows under it, or with no size, are left out. 0n: off. */
  min: bigint;
  q: string;
}

export const NO_FILTER: ActFilter = { kinds: [], min: 0n, q: "" };

const SHOWN = new Set(["buy", "sell", "deposit", "withdraw"]);
/** A trade's stages where its asked amount never moved in full: its row draws no amount (the dash), since the op's
 *  amount_usd and units are the request's ask (kit OpDetail), and only a done op's amount is what moved. */
const NOT_MOVED = new Set(["refused", "not_landed", "part_filled"]);

/** A trade op's failure as its row draws it: refused (with the reason for its code) or not landed; null otherwise. */
function failedOf(o: Operation): ActRow["failed"] {
  if (o.kind !== "buy" && o.kind !== "sell") return null;
  if (o.stage === "not_landed") return { reason: "notLanded" };
  return o.stage === "refused" ? { reason: reasonOf(o.code) } : null;
}

/** Every row Activity lists: the kit's deposits, withdrawals, buys and sells, each with what its op carries (kit OpDetail:
 *  time, USD size, units, chain, token; a deposit's USD is its amount_usd), and the exported keys. Newest first; rows
 *  with no time last, in the kit's order. */
export function activity(ops: readonly Operation[] | null | undefined, d: PortfolioData): ActRow[] {
  const rows: ActRow[] = [];
  for (const o of ops ?? []) {
    if (!SHOWN.has(o.kind)) continue;
    const moved = !NOT_MOVED.has(o.stage);
    rows.push({ id: o.id, kind: o.kind as ActKind, stage: o.stage, at: o.created_ms ?? null, usd: moved ? centsNear(o.amount_usd) : null, units: moved ? (o.units ?? null) : null, chain: o.chain ?? null, token: o.token ?? null, txs: o.txs, address: null, failed: failedOf(o) });
  }
  for (const e of d.exported) rows.push({ id: e.id, kind: "export", stage: "key_exported", at: e.at, usd: null, units: null, chain: e.chain, token: e.token, txs: [], address: e.address, failed: null });
  const timed = rows.filter((r) => r.at !== null).sort((a, b) => b.at! - a.at!);
  return [...timed, ...rows.filter((r) => r.at === null)];
}

/** S14.5: type chips (none on: all), the min size and the token search (symbol, from the market read). */
export function filterActivity(rows: readonly ActRow[], f: ActFilter, d: PortfolioData): ActRow[] {
  const t = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.kinds.length && !f.kinds.includes(r.kind)) return false;
    if (f.min > 0n && (r.usd === null || r.usd < f.min)) return false;
    if (t) {
      const m = r.chain && r.token ? d.market(r.chain, r.token) : null;
      if (!m || !(m.symbol.toLowerCase().includes(t) || m.name.toLowerCase().includes(t))) return false;
    }
    return true;
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Day headers in the viewer's zone (`tzMin`: minutes east of UTC): Today, Yesterday, then dates. */
export function groupByDay(rows: readonly ActRow[], now: number, tzMin: number): ActGroup[] {
  const dayOf = (t: number) => Math.floor((t + tzMin * 60_000) / DAY);
  const today = dayOf(now);
  const out: ActGroup[] = [];
  for (const r of rows) {
    let label: ActGroup["label"] = null;
    if (r.at !== null) {
      const k = dayOf(r.at);
      if (k === today) label = "today";
      else if (k === today - 1) label = "yesterday";
      else {
        const dt = new Date(k * DAY);
        label = `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
      }
    }
    const last = out.at(-1);
    if (last && last.label === label) last.rows.push(r);
    else out.push({ label, rows: [r] });
  }
  return out;
}

/** S14.3: a restore ran on this device (the kit's restore op done); deposits and withdrawals before it are not rebuilt. */
export const restored = (ops: readonly Operation[] | null | undefined): boolean => (ops ?? []).some((o) => o.kind === "restore" && o.stage === "done");

export type ActView = "S14.1" | "S14.2";
export const actView = (rows: readonly ActRow[]): ActView => (rows.length ? "S14.2" : "S14.1");
