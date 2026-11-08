// Portfolio (S10) and Activity (S14) as pure functions (A3.1, app.md:1459; 09-design-brief S10 and S14). Money is exact:
// every amount is a decimal string read into bigint cents, rounded down (a total never shows more than is there), and
// every percent is whole basis points from bigint division. Nothing here reads a clock or the page; the screen passes
// `now` and the time zone.
//
// What the kit gives (packages/kit/src/signpage/messages.ts SignpageState): the vault's USDC (`vault_balance`), the
// wallets with their state and size, each open position's chain, token, amount and cost, and every operation's id,
// kind, stage and txs (`ops`). What it does not give, so the screen takes it from `PortfolioData` (source.tsx), a local
// type the card's report names as missing kit calls: a token's symbol, name and price and whether a route sells it; a
// position's bought, sold and realized, its open time, its TP/SL and its held or reverted mark; the closed positions;
// the value series; the fees paid; and each operation's time, USD size, token and units.
import { moneyWallets, POOL_ASSET_DECIMALS } from "@blindfill/kit";
import { small } from "../discover/format.ts";
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

/** "$1,234.56", "-$4.08" or "+$29.63" from cents. */
export function usd(c: bigint, plus = false): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const whole = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "−" : plus ? "+" : ""}$${whole}.${(a % 100n).toString().padStart(2, "0")}`;
}

/** Basis points of part / whole, truncated toward zero; null for a zero whole. */
export function bps(part: bigint, whole: bigint): number | null {
  return whole === 0n ? null : Number((part * 10000n) / whole);
}

/** "+119.0%", "−8.2%" from basis points. */
export function pct(b: number | null): string {
  if (b === null) return "—";
  const a = Math.abs(b);
  return `${b < 0 ? "−" : b > 0 ? "+" : ""}${Math.trunc(a / 100)}.${Math.trunc((a % 100) / 10)}%`;
}

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
  /** False when no route sells it now (S10.6: valued at the last price). */
  route: boolean;
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

/** A position sold to zero. Not in the kit. */
export interface ClosedTrade {
  chain: Chain;
  token: string;
  /** USD decimal strings. */
  bought: string;
  sold: string;
  opened_at: number;
  closed_at: number;
}

/** An operation's own facts. Not in the kit (ops carry id, kind, stage and txs only). */
export interface OpDetail {
  at: number;
  /** USD decimal string. */
  usd?: string;
  units?: string;
  chain?: Chain;
  token?: string;
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
  op(id: string): OpDetail | null;
  exported: readonly ExportedKey[];
}

/** No market reads, no closed trades, no series: what the live source has until the kit carries them (dashes). */
export const NO_DATA: PortfolioData = { market: () => null, extra: () => null, closed: [], series: [], fees: null, op: () => null, exported: [] };

// --------------------------------------------------------------------------------------------------- positions S10

export type Mark = "noRoute" | "held" | "reverted" | null;

export interface Row {
  key: string;
  chain: Chain;
  token: string;
  symbol: string;
  name: string;
  units: string;
  cost: bigint;
  /** Null: no price (S10.4). */
  value: bigint | null;
  pnl: bigint | null;
  pnlBps: number | null;
  bought: bigint;
  sold: bigint;
  realized: bigint;
  mark: Mark;
  exit: PositionExtra["exit"] | null;
  wallets: number;
  /** The wallets that hold it, each with its own export (card app-export-every-wallet). */
  addresses: string[];
  openedAt: number | null;
  /** S10.12: a sell of this token on its way, from the kit's op and its detail. */
  selling: { stage: "sending" | "landing"; ms: number } | null;
}

export interface Totals {
  cash: bigint;
  onWay: bigint;
  inPos: bigint;
  total: bigint;
  unreal: bigint;
  realized30: bigint;
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
  const cost = cents(p.cost) ?? 0n;
  const value = m?.price != null ? mulCents(p.amount, m.price) : null;
  const pnl = value === null ? null : value - cost;
  let selling: Row["selling"] = null;
  for (const o of ops) {
    if (o.kind !== "sell" || (o.stage !== "signed" && o.stage !== "sent")) continue;
    const od = d.op(o.id);
    if (od?.chain === p.chain && od.token === p.token) selling = { stage: o.stage === "signed" ? "sending" : "landing", ms: Math.max(0, now - od.at) };
  }
  return {
    key: key(p.chain, p.token),
    chain: p.chain,
    token: p.token,
    symbol: m?.symbol ?? p.token.slice(0, 6),
    name: m?.name ?? "",
    units: p.amount,
    cost,
    value,
    pnl,
    pnlBps: pnl === null ? null : bps(pnl, cost),
    bought: cents(x.bought) ?? cost,
    sold: cents(x.sold) ?? 0n,
    realized: cents(x.realized) ?? 0n,
    mark: x.mark ?? (m && !m.route ? "noRoute" : null),
    exit: x.exit ?? null,
    wallets: p.wallets.length,
    addresses: [...new Set(p.wallets)],
    openedAt: x.opened_at ?? null,
    selling,
  };
}

/** Rows by value, largest first; a row with no price after the priced ones, by cost; ties by symbol. */
export function sortRows(rows: readonly Row[]): Row[] {
  return [...rows].sort((a, b) => {
    if ((a.value === null) !== (b.value === null)) return a.value === null ? 1 : -1;
    const av = a.value ?? a.cost;
    const bv = b.value ?? b.cost;
    if (av !== bv) return av > bv ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });
}

/** Realized PnL of the trades closed in the 30 days to now, plus the open positions' realized part. */
export function realized30(rows: readonly Row[], closed: readonly ClosedTrade[], now: number): bigint {
  let r = rows.reduce((a, x) => a + x.realized, 0n);
  for (const c of closed) if (c.closed_at > now - 30 * DAY && c.closed_at <= now) r += (cents(c.sold) ?? 0n) - (cents(c.bought) ?? 0n);
  return r;
}

export function totals(s: SignpageState, rows: readonly Row[], closed: readonly ClosedTrade[], now: number): Totals {
  // Cash: the vault's USDC, each pool held in USDC and the READY wallets, each source counted once. A SOL or ETH pool
  // has no dollar value until a price read exists, so it never joins Cash: no dollar figure is invented. The vault's
  // USDC is vault_balance alone: the signing page's pool table never holds the vault's scope (packages/signpage
  // test/pools.test.ts), so a USDC pool is other money and the vault's USDC never counts twice.
  let cash = cents(s.vault_balance) ?? 0n;
  for (const p of s.pools ?? []) if (p.asset === "USDC") cash += cents(p.balance) ?? 0n;
  let onWay = 0n;
  for (const w of s.wallets) {
    if (w.state === "READY") cash += cents(w.size) ?? 0n;
    else if (w.state === "ARMING" || w.state === "RETURNING") onWay += cents(w.size) ?? 0n;
  }
  let inPos = 0n;
  let unreal = 0n;
  let partial = false;
  for (const r of rows) {
    if (r.value === null) {
      partial = true;
      inPos += r.cost;
    } else {
      inPos += r.value;
      unreal += r.pnl!;
    }
  }
  return { cash, onWay, inPos, total: cash + onWay + inPos, unreal, realized30: realized30(rows, closed, now), partial };
}

/** The screen's state from the signing page's snapshot and the local data. */
export function portfolio(snap: SignpageClientSnapshot, d: PortfolioData, now: number): Portfolio {
  const offline = snap.status === "down";
  const s = snap.state;
  if (!s) return { view: offline ? "S10.2" : "S10.1", offline, rows: [], totals: null, pools: { view: offline ? "offline" : "loading", rows: [] } };
  const rows = sortRows(s.positions.map((p) => rowOf(p, d, s.ops, now)));
  return { view: rows.length ? "S10.3" : "S10.2", offline, rows, totals: totals(s, rows, d.closed, now), pools: pools(s, offline) };
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

/** The pool rows from the signing page's state, in the page's order. A ready above the balance is held to it. */
export function pools(s: SignpageState, offline = false): Pools {
  if (s.pools === undefined) return { view: offline ? "offline" : "unread", rows: [] };
  const rows = s.pools.map((p): PoolRow => {
    const decimals = POOL_ASSET_DECIMALS[p.asset];
    const balance = baseUnits(p.balance, decimals) ?? 0n;
    const r = p.ready === undefined ? null : baseUnits(p.ready, decimals) ?? 0n;
    const ready = r === null ? null : r > balance ? balance : r;
    return { chain: p.chain, asset: p.asset, decimals, balance, ready, pending: ready === null ? null : balance - ready };
  });
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
  bought: bigint;
  sold: bigint;
  realized: bigint;
  realizedBps: number | null;
  heldMs: number;
  closedAt: number;
}

/** S10.10: the closed list, newest close first. */
export function closedRows(d: PortfolioData): ClosedRow[] {
  return d.closed
    .map((c) => {
      const m = d.market(c.chain, c.token);
      const bought = cents(c.bought) ?? 0n;
      const sold = cents(c.sold) ?? 0n;
      return { key: `${key(c.chain, c.token)}:${c.closed_at}`, chain: c.chain, token: c.token, symbol: m?.symbol ?? c.token.slice(0, 6), name: m?.name ?? "", bought, sold, realized: sold - bought, realizedBps: bps(sold - bought, bought), heldMs: c.closed_at - c.opened_at, closedAt: c.closed_at };
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
  const r = closed.map((c) => c.realizedBps ?? 0);
  const buckets = EDGES.map((lo, i) => r.filter((b) => b >= lo && (i === EDGES.length - 1 || b < EDGES[i + 1]!)).length);
  const wins = r.filter((b) => b > 0);
  const losses = r.filter((b) => b <= 0);
  return {
    trades: closed.length,
    winBps: closed.length ? Math.trunc((wins.length * 10000) / closed.length) : null,
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
  future: boolean;
  today: boolean;
}

/** The PnL calendar: the month of `now` (UTC days), each day's realized PnL from the trades closed that day. */
export function calendar(closed: readonly ClosedRow[], now: number): { year: number; month: number; lead: number; days: Day[]; sum: bigint; green: number; red: number } {
  const n = new Date(now);
  const year = n.getUTCFullYear();
  const month = n.getUTCMonth();
  const len = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const per = new Map<number, bigint>();
  for (const c of closed) {
    const d = new Date(c.closedAt);
    if (d.getUTCFullYear() === year && d.getUTCMonth() === month) per.set(d.getUTCDate(), (per.get(d.getUTCDate()) ?? 0n) + c.realized);
  }
  const days: Day[] = Array.from({ length: len }, (_, i) => ({ day: i + 1, pnl: per.get(i + 1) ?? null, future: i + 1 > n.getUTCDate(), today: i + 1 === n.getUTCDate() }));
  let sum = 0n;
  let green = 0;
  let red = 0;
  for (const v of per.values()) {
    sum += v;
    if (v > 0n) green++;
    if (v < 0n) red++;
  }
  return { year, month, lead, days, sum, green, red };
}

export type Range = "1D" | "1W" | "1M" | "All";
const SPAN: Record<Range, number> = { "1D": DAY, "1W": 7 * DAY, "1M": 30 * DAY, All: Infinity };

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

/** Every row Activity lists: the kit's deposits, withdrawals, buys and sells with their local detail, and the exported keys. Newest first; rows with no time last, in the kit's order. */
export function activity(ops: readonly Operation[] | null | undefined, d: PortfolioData): ActRow[] {
  const rows: ActRow[] = [];
  for (const o of ops ?? []) {
    if (!SHOWN.has(o.kind)) continue;
    const x = d.op(o.id);
    rows.push({ id: o.id, kind: o.kind as ActKind, stage: o.stage, at: x?.at ?? null, usd: cents(x?.usd), units: x?.units ?? null, chain: x?.chain ?? null, token: x?.token ?? null, txs: o.txs, address: null });
  }
  for (const e of d.exported) rows.push({ id: e.id, kind: "export", stage: "key_exported", at: e.at, usd: null, units: null, chain: e.chain, token: e.token, txs: [], address: e.address });
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
