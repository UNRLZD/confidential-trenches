// The tokens a device holds, as an app draws them (card market-token-reads): each token's symbol, name and USD price in
// one request a chain over the helper's GET /v1/market/held (apps/helper/src/data/held.ts), its price history over
// GET /v1/market/candles, and the value line the device computes from its own records (the signing page's positions and
// ops) with them.
//
// What the helper learns: the list of tokens on each chain, sorted and without repeats, so the order and the count of
// buys are not in it; never an amount, a cost, a wallet or a note. It still sees which tokens the caller's address holds
// and how many, as it does for any token page read. The list is not padded with tokens the device does not hold: each
// would spend the helper's upstream reads (GeckoTerminal's keyless budget is 5 calls in 75 s for every user).
//
// Display only: nothing here feeds a signature. Every answer is hostile input: an entry is used only when it names the
// asked token in the asked place, text is bounded, a price is a plain decimal, a bar's time is a whole second after the
// one before it; anything else names nothing, never a guess.
import type { Chain } from "../orders/record.ts";
import type { Operation } from "../signpage/messages.ts";

/** The chains the helper reads market data for. NEAR holds no traded token (its money is the vault's USDC). */
export const HELD_MARKET_CHAINS = ["solana", "base", "robinhood"] as const satisfies readonly Chain[];
/** The most tokens one request names (the helper's HELD_MAX). */
export const HELD_MARKET_MAX = 30;
/** The history read: hourly bars, 500 of them (the helper's CANDLES_MAX), about 20 days; one shape for every token and
 *  every range, so the helper does not learn which range the user looks at. */
export const HELD_HISTORY_TF = "1h";
export const HELD_HISTORY_BARS = 500;
const TIMEOUT_MS = 10_000;
const PRICE = /^\d{1,30}(\.\d{1,40})?$/;

export interface HeldRef {
  readonly chain: Chain;
  readonly token: string;
}
/** One held token's market read; null where the helper named nothing usable. */
export interface HeldMarket {
  readonly chain: Chain;
  readonly token: string;
  readonly symbol: string | null;
  readonly name: string | null;
  /** USD per whole unit, a plain decimal string. */
  readonly price_usd: string | null;
}
/** [unix ms, USD close], oldest first. */
export type HeldBar = readonly [number, string];

export const heldKey = (chain: Chain, token: string): string => `${chain}:${token}`;
const served = (c: Chain): boolean => (HELD_MARKET_CHAINS as readonly Chain[]).includes(c);
const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const price = (v: unknown): string | null => (typeof v === "string" && PRICE.test(v) ? v : null);
const INIT = { credentials: "omit", referrerPolicy: "no-referrer" } as const;

async function getJson(url: string, fetchFn: typeof fetch): Promise<unknown> {
  try {
    const r = await fetchFn(url, { ...INIT, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status !== 200) {
      await r.body?.cancel();
      return null;
    }
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Each distinct held token's symbol, name and USD price: one GET /v1/market/held a chain (more than HELD_MARKET_MAX
 * tokens split into several), all at once. A token on a chain the helper does not read (NEAR), or one its answer does
 * not name, is an entry of nulls. Never throws. `base` is the helper's origin.
 */
export async function readHeldMarket(base: string, refs: readonly HeldRef[], fetchFn: typeof fetch = fetch): Promise<HeldMarket[]> {
  const byChain = new Map<Chain, string[]>();
  for (const r of refs) {
    const list = byChain.get(r.chain) ?? [];
    if (!list.includes(r.token)) list.push(r.token);
    byChain.set(r.chain, list);
  }
  const reads: Promise<HeldMarket[]>[] = [];
  for (const [chain, list] of byChain) {
    const sorted = [...list].sort();
    for (let i = 0; i < sorted.length; i += HELD_MARKET_MAX) {
      const part = sorted.slice(i, i + HELD_MARKET_MAX);
      reads.push(served(chain) ? readPart(base, chain, part, fetchFn) : Promise.resolve(part.map((token) => none(chain, token))));
    }
  }
  return (await Promise.all(reads)).flat();
}

const none = (chain: Chain, token: string): HeldMarket => ({ chain, token, symbol: null, name: null, price_usd: null });

async function readPart(base: string, chain: Chain, tokens: readonly string[], fetchFn: typeof fetch): Promise<HeldMarket[]> {
  const q = new URLSearchParams({ chain });
  for (const t of tokens) q.append("token", t);
  const body = obj(await getJson(`${base}/v1/market/held?${q}`, fetchFn));
  const list = body?.tokens;
  // one entry per asked token, in the asked order, or the answer names nothing
  if (!Array.isArray(list) || list.length !== tokens.length || list.some((e, i) => obj(e)?.token !== tokens[i])) return tokens.map((t) => none(chain, t));
  return tokens.map((token, i) => {
    const e = obj(list[i])!;
    return { chain, token, symbol: text(e.symbol, 32), name: text(e.name, 64), price_usd: price(e.price_usd) };
  });
}

/**
 * A held token's hourly closes: one GET /v1/market/candles of a fixed shape (HELD_HISTORY_TF, HELD_HISTORY_BARS).
 * Empty for a chain the helper does not read, a failed read or any malformed bar. Never throws.
 */
export async function readHeldHistory(base: string, ref: HeldRef, fetchFn: typeof fetch = fetch): Promise<HeldBar[]> {
  if (!served(ref.chain)) return [];
  const q = new URLSearchParams({ chain: ref.chain, token: ref.token, tf: HELD_HISTORY_TF, limit: String(HELD_HISTORY_BARS) });
  const body = obj(await getJson(`${base}/v1/market/candles?${q}`, fetchFn));
  const bars = body?.candles;
  if (body?.tf !== HELD_HISTORY_TF || !Array.isArray(bars) || bars.length > HELD_HISTORY_BARS) return [];
  const out: HeldBar[] = [];
  let last = 0;
  for (const b of bars) {
    if (!Array.isArray(b) || b.length < 5) return [];
    const t = b[0];
    const close = price(b[4]);
    if (typeof t !== "number" || !Number.isSafeInteger(t) || t <= last || close === null) return [];
    last = t;
    out.push([t * 1000, close]);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- the value line

/** A plain decimal string as an integer and its scale; null for anything else. */
function dec(s: string): { n: bigint; scale: number } | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const f = m[2] ?? "";
  return { n: BigInt(m[1]! + f), scale: f.length };
}
/** USD cents of a decimal string, rounded down. */
function centsOf(s: string): bigint | null {
  const d = dec(s);
  return d === null ? null : (d.n * 100n) / 10n ** BigInt(d.scale);
}
/** amount x price in USD cents, rounded down. */
function mulCents(amount: string, usd: string): bigint | null {
  const a = dec(amount);
  const p = dec(usd);
  return a === null || p === null ? null : (a.n * p.n * 100n) / 10n ** BigInt(a.scale + p.scale);
}
const usd = (c: bigint): string => `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;

export interface HeldValueInput {
  /** The signing page's positions (SignpageState.positions): what is held now and what it cost. */
  readonly positions: readonly { readonly chain: Chain; readonly token: string; readonly amount: string; readonly cost: string }[];
  readonly markets: readonly HeldMarket[];
  /** readHeldHistory's bars by heldKey. */
  readonly history: ReadonlyMap<string, readonly HeldBar[]>;
  /** The signing page's ops (SignpageState.ops): a position counts at its price from its first filled buy. */
  readonly ops: readonly Operation[];
  /** The money not in a position (cash and money on its way), a USD decimal string. */
  readonly base_usd: string;
  /** Unix ms. */
  readonly now: number;
}

/**
 * The value line, oldest first, as [unix ms, USD decimal string] with cents rounded down: at each hourly bar any held
 * token has up to `now`, and at `now`, the money not in a position plus each position's amount at that time's close.
 * A position counts at its cost before its first filled buy (the money was cash then), at its cost throughout when no
 * price is known (as Portfolio's totals count it), and at its present price when it has no bar at or before that time.
 * The last point uses each token's present price, so it equals Portfolio's total. What it does not know: amounts sold
 * or bought after a point other than the first buy, and deposits and withdrawals, whose USD the device does not hold
 * for every kind; before them the line holds today's amounts and cash.
 */
export function heldValueSeries(input: HeldValueInput): [number, string][] {
  const baseC = centsOf(input.base_usd) ?? 0n;
  const price = new Map(input.markets.map((m) => [heldKey(m.chain, m.token), m.price_usd]));
  const opened = new Map<string, number>();
  for (const o of input.ops) {
    if (o.kind !== "buy" || (o.stage !== "filled" && o.stage !== "part_filled") || o.chain === undefined || o.token === undefined || o.created_ms === undefined) continue;
    const k = heldKey(o.chain, o.token);
    opened.set(k, Math.min(opened.get(k) ?? Infinity, o.created_ms));
  }
  const times = new Set<number>();
  for (const p of input.positions) for (const [t] of input.history.get(heldKey(p.chain, p.token)) ?? []) if (t < input.now) times.add(t);
  const at = (t: number, last: boolean): bigint => {
    let c = baseC;
    for (const p of input.positions) {
      const k = heldKey(p.chain, p.token);
      const cost = centsOf(p.cost) ?? 0n;
      const now = price.get(k) ?? null;
      if (now === null || (!last && t < (opened.get(k) ?? -Infinity))) {
        c += cost;
        continue;
      }
      let close: string = now;
      if (!last) for (const [bt, bc] of input.history.get(k) ?? []) if (bt <= t) close = bc;
      c += mulCents(p.amount, close) ?? cost;
    }
    return c;
  };
  return [...[...times].sort((a, b) => a - b).map((t): [number, string] => [t, usd(at(t, false))]), [input.now, usd(at(input.now, true))]];
}
