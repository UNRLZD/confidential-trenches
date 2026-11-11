import type { SignpageClientSnapshot } from "@blindfill/kit";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { fromUnits, toUnits } from "../positions/model.ts";

// What the user holds the moment a trade fills (card app-holding-follows-a-fill). The signing page's positions
// (state.positions, src/positions.ts there) come from a holdings read at finalized, run again when a trade's run ends:
// a buy's Final comes seconds after its Filled, and a full sell's token stays listed until the sale is final. So a
// trade's own answer (a buy's amount W received and W, read at confirmed on both RPCs; a sell's units, sold whole at
// its Filled) is the shown holding from its Filled until a read shows it: one rule for buy and sell on every chain,
// applied to the one snapshot the trade box, the positions and the portfolio draw (useFilled). Display only: no request
// takes these amounts (a sale reads its own Ws before it signs).
// - A fill is shown until a read shows it (a buy's: the read at its amount or more; a sell's: at its amount or less) or
//   the read moves its way from what it was when the fill was first drawn (a buy's up, a sell's down: the trade's own
//   read, at whatever amount it landed), and a read that shows a later fill of the token shows the earlier ones too.
//   Past FILL_KEEP_MS the read stands.
// - A trade that ends with no fill (part filled, not landed, refused) takes its fill back: the old amount shows again.
// - Sign out (no state) drops them all.

/** How long a trade's own amount stands with no read showing it: the holdings read lags a fill by finality (Solana's
 *  finalized, about 13 s after confirmed) and the signing page's tries of a lagging read (positions.ts
 *  POSITIONS_RETRY_MS, 5 s, a few times); past it the read stands, whatever it says. */
export const FILL_KEEP_MS = 60_000;

type Position = NonNullable<SignpageClientSnapshot["state"]>["positions"][number];

export interface Fill {
  /** The trade's request id. */
  id: string;
  chain: string;
  token: string;
  side: "buy" | "sell";
  /** The holding after this fill, a decimal of the token's whole units ("0": none left). */
  after: string;
  /** The position's cost after it, a USD decimal ("0": unknown, as the signing page's). */
  cost: string;
  /** The buy's wallet, when the page named it. */
  wallet: string | null;
  /** When it filled, the app's clock (ms). */
  at: number;
  /** The read's amount when the fill was first drawn (fillStore.sync; null: no position), unset before. */
  was?: string | null;
}

/** a - b and a vs b on decimal strings at one scale. */
function scaled(a: string, b: string): { a: bigint; b: bigint; scale: number } | null {
  const x = toUnits(a);
  const y = toUnits(b);
  if (!x || !y) return null;
  const scale = Math.max(x.scale, y.scale);
  return { a: x.n * 10n ** BigInt(scale - x.scale), b: y.n * 10n ** BigInt(scale - y.scale), scale };
}
const trim = (s: string): string => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

/** The fill of a trade on a holding shown as `held` (null: none) at `cost`: a buy adds `amount` (and its spend `spend`,
 *  a USD decimal, to a known cost), a sell takes `amount` off (and its share of the cost). Null when an amount is not a
 *  decimal. */
export function fillOf(t: { id: string; chain: string; token: string; side: "buy" | "sell"; amount: string; wallet?: string | null; spend?: string | null; at: number }, held: { amount: string; cost: string } | null): Fill | null {
  const was = held?.amount ?? "0";
  const m = scaled(was, t.amount);
  if (!m) return null;
  const n = t.side === "buy" ? m.a + m.b : m.a > m.b ? m.a - m.b : 0n;
  let cost = "0";
  const c = held ? toUnits(held.cost) : null;
  if (t.side === "buy") {
    const s = t.spend ? toUnits(t.spend) : null;
    // a holding with an unknown cost stays unknown (the page's rule: never a cost made of part of it)
    if (s && (held === null || (c !== null && c.n > 0n))) {
      const sum = scaled(held?.cost ?? "0", t.spend!);
      if (sum) cost = trim(fromUnits(sum.a + sum.b, sum.scale));
    }
  } else if (c !== null && c.n > 0n && m.a > 0n) cost = trim(fromUnits((c.n * n) / m.a, c.scale));
  return { id: t.id, chain: t.chain, token: t.token, side: t.side, after: trim(fromUnits(n, m.scale)), cost, wallet: t.wallet ?? null, at: t.at };
}

/** Whether the read `amount` (null: no position) shows the fill: at its amount or past it, or moved its way since. */
function shows(f: Fill, amount: string | null): boolean {
  const m = scaled(amount ?? "0", f.after);
  if (!m) return true;
  if (f.side === "buy" ? m.a >= m.b : m.a <= m.b) return true;
  if (f.was === undefined) return false;
  const w = scaled(amount ?? "0", f.was ?? "0");
  return w !== null && (f.side === "buy" ? w.a > w.b : w.a < w.b);
}

const same = (p: { chain: string; token: string }, f: { chain: string; token: string }) => p.chain === f.chain && p.token === f.token;

/** The fills no read shows yet, at `now`: per token, those after the last one a read shows, each younger than
 *  FILL_KEEP_MS. */
export function pendingFills(positions: readonly Position[] | null, fills: readonly Fill[], now: number): Fill[] {
  if (positions === null) return [];
  const out: Fill[] = [];
  const keys = [...new Set(fills.map((f) => `${f.chain} ${f.token}`))];
  for (const k of keys) {
    const mine = fills.filter((f) => `${f.chain} ${f.token}` === k);
    const read = positions.find((p) => same(p, mine[0]!))?.amount ?? null;
    let from = 0;
    mine.forEach((f, i) => void (shows(f, read) && (from = i + 1)));
    out.push(...mine.slice(from).filter((f) => now - f.at < FILL_KEEP_MS));
  }
  return out;
}

/** The positions with each token's last pending fill as its holding. */
export function withFills(positions: readonly Position[], fills: readonly Fill[], now: number): readonly Position[] {
  const pending = pendingFills(positions, fills, now);
  if (pending.length === 0) return positions;
  const last = new Map<string, Fill>();
  for (const f of pending) last.set(`${f.chain} ${f.token}`, f);
  const out: Position[] = [];
  for (const p of positions) {
    const f = last.get(`${p.chain} ${p.token}`);
    if (!f) out.push(p);
    else if (toUnits(f.after)?.n !== 0n) out.push({ ...p, amount: f.after, cost: f.cost, wallets: f.wallet && !p.wallets.includes(f.wallet) ? [...p.wallets, f.wallet] : p.wallets });
    last.delete(`${p.chain} ${p.token}`);
  }
  for (const f of last.values()) if (toUnits(f.after)?.n !== 0n) out.push({ chain: f.chain as Position["chain"], token: f.token, amount: f.after, cost: f.cost, wallets: f.wallet ? [f.wallet] : [] });
  return out;
}

// The page's fills, kept for the page (as the sells' TAPPED, positions/source.tsx): a box mounted again draws them.
let fills: Fill[] = [];
const subs = new Set<() => void>();
const changed = (next: Fill[]): void => {
  fills = next;
  for (const s of subs) s();
};
export const fillStore = {
  get: (): readonly Fill[] => fills,
  /** A trade's fill (once per id). */
  note(f: Fill | null): void {
    if (f && !fills.some((x) => x.id === f.id)) changed([...fills, f]);
  },
  /** A trade that ended with no fill: its fill back. */
  drop(id: string): void {
    if (fills.some((x) => x.id === id)) changed(fills.filter((x) => x.id !== id));
  },
  /** Only the fills no read shows yet (none when signed out). */
  sync(positions: readonly Position[] | null, now: number): void {
    const pending = pendingFills(positions, fills, now);
    // each fill keeps the read it was first drawn on, so the read moving its way stands it down
    const next = pending.map((f) => (f.was !== undefined ? f : { ...f, was: positions?.find((p) => same(p, f))?.amount ?? null }));
    if (next.length !== fills.length || next.some((f, i) => f !== pending[i])) changed(next);
  },
  subscribe(fn: () => void): () => void {
    subs.add(fn);
    return () => void subs.delete(fn);
  },
};

/** `snapshot` with the trades' fills no read shows yet as its positions (withFills); drawn again when the next one ages
 *  out. */
export function useFilled(snapshot: SignpageClientSnapshot, now: () => number = Date.now): SignpageClientSnapshot {
  const all = useSyncExternalStore(fillStore.subscribe, fillStore.get, fillStore.get);
  const [tick, setTick] = useState(0);
  const positions = snapshot.state?.positions ?? null;
  useEffect(() => fillStore.sync(positions, now()), [positions, all, tick]);
  // the next fill to age out draws the read again
  useEffect(() => {
    if (all.length === 0) return;
    const next = Math.min(...all.map((f) => f.at + FILL_KEEP_MS)) - now();
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, next));
    return () => clearTimeout(t);
  }, [all, tick]);
  return useMemo(() => {
    if (!snapshot.state || all.length === 0) return snapshot;
    const p = withFills(snapshot.state.positions, all, now());
    return p === snapshot.state.positions ? snapshot : { ...snapshot, state: { ...snapshot.state, positions: p } };
  }, [snapshot, all, tick]);
}
