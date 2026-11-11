// GET /v1/market/lists?chain=near: Discover's NEAR lists, in the rows and snapshot the other chains answer
// (../solana/lists.ts Row and LISTS; ../evm/lists.ts toRows is the shape copied field for field), from Rhea classic's
// own contract views (v2.ref-finance.near) on two NEAR RPCs (views.ts). No vendor list exists for NEAR here, so every
// value is the chain's: src "chain".
//
// Reads (a simple pool's price is its two amounts, the way Rhea's own `get_return` prices a small swap):
//   - every pool: `get_number_of_pools`, then `get_pools` in pages of PAGE at one final block, so one read is one state;
//   - a token's main pool: its SIMPLE_POOL with wNEAR (wrap.near) holding the most wNEAR (classic simple pools only:
//     stable, rated and degen pools price by curves, not by two amounts). Its price is the pool's own: the wNEAR side
//     over the token side, times NEAR's USD price;
//   - NEAR's USD price: the SIMPLE_POOL of wNEAR and USDC (Circle's NEAR USDC) or USDT (Tether's) holding the most wNEAR,
//     one stablecoin unit a dollar;
//   - liquidity: twice the wNEAR side in USD (a simple pool holds equal value on both sides);
//   - volume: `get_pool_volumes` (each token's cumulative in and out since the pool began) now, an hour back and a day
//     back, the wNEAR legs' difference in USD at NEAR's price now; price change: the same pool's price an hour and a
//     day back (`get_pools` at those blocks);
//   - symbol, name and decimals: the token's own `ft_metadata` (NEP-148), read once a token.
// No view gives a pool's launch time, holders, buys and sells, or a launchpad: those fields are null, as on a chain whose
// source lacks them. Lists: `new` the newest main pools by pool id (Rhea numbers pools in creation order), `trending`
// (= `trending_1h`) the most hour volume, each at most LIST_MAX; `trending_5m` and `graduating` are empty (no 5 min
// window is read, and Rhea classic has no curve).
//
// Display only: nothing here feeds a signature. Every answer is hostile: account ids checked, amounts digit strings,
// counts and pages bounded, metadata text bounded.
import { gzipSync } from "node:zlib";
import { fixed, PRICE_SCALE, VALUE_SCALE } from "../candles.ts";
import type { ListsAnswer, Row } from "../solana/lists.ts";
import { block, nearAccount, NEAR_RPCS, PAST_RPCS, pacedFetch, view, type At, type Fetch } from "./views.ts";

export const REF = "v2.ref-finance.near";
export const WNEAR = "wrap.near";
export const WNEAR_DECIMALS = 24;
/** The dollar stablecoins NEAR's price is read against, each with its decimals (their own ft_metadata: 6 and 6). */
export const USD_TOKENS: Readonly<Record<string, number>> = { "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": 6, "usdt.tether-token.near": 6 };
/** Pools a `get_pools` page holds [design: 500 answered in 0.43 s from a Mac, 2026-11-11 18:2xZ]. */
export const PAGE = 500;
/** The most pools read [design: 9,014 on 2026-11-11; past this the answer is refused, never a longer read]. */
export const POOLS_MAX = 40_000;
/** Rows a list holds. */
export const LIST_MAX = 50;
/** A main pool under this liquidity is not listed [design: a pool with a few dollars on each side has no market a
 *  person can trade; most of Rhea's 9,014 pools hold none (2026-11-11 read)]. */
export const LIQ_MIN_USD = 1_000n;
/** The price read again this often (a full pool read, 19 pages). */
export const PRICE_REFRESH_MS = 60_000;
/** The hour and day reads (volumes and changes) again this often [design: up to 3 view calls a listed pool and two
 *  page reads, ~340 calls; every 10 min that is about one call every 2 s over two providers, and FastNEAR's free RPC
 *  refused a heavier pace (views.ts HOST_GAP_MS). An hour's volume is then up to 10 min behind its row's price]. */
export const VOL_REFRESH_MS = 600_000;
const PARALLEL = 4;
const META_MAX = 4_000;
const HOUR_S = 3_600;
const DAY_S = 86_400;

export type Pool = { id: number; tokens: [string, string]; amounts: [bigint, bigint] };
/** A token's main pool: its id, the token's and wNEAR's amounts in it, and wNEAR's place in its two tokens. */
export type Main = { pool: number; amt: bigint; wnear: bigint; w: number };
export type Meta = { symbol: string; name: string; decimals: number };
export type Scan = { height: number; t_ms: number; mains: Map<string, Main>; nearUsd: bigint | null };

const DIGITS = /^\d{1,40}$/;
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const pow10 = (n: number) => 10n ** BigInt(n);

/** A `get_pools` page's SIMPLE_POOLs of two valid tokens, numbered from `from`; null when the page is not a list. */
export function parsePools(answer: unknown, from: number): Pool[] | null {
  if (!Array.isArray(answer) || answer.length > PAGE) return null;
  const out: Pool[] = [];
  answer.forEach((p, i) => {
    const o = obj(p);
    const t = o.token_account_ids;
    const a = o.amounts;
    if (o.pool_kind !== "SIMPLE_POOL" || !Array.isArray(t) || !Array.isArray(a) || t.length !== 2 || a.length !== 2) return;
    const [t0, t1] = [nearAccount(t[0]), nearAccount(t[1])];
    if (t0 === null || t1 === null || t0 === t1 || !a.every((x) => typeof x === "string" && DIGITS.test(x))) return;
    out.push({ id: from + i, tokens: [t0, t1], amounts: [BigInt(a[0] as string), BigInt(a[1] as string)] });
  });
  return out;
}

/** Each token's main pool with wNEAR, and NEAR's USD price (times 10^VALUE_SCALE) from the deepest stablecoin pool. */
export function mainsOf(pools: readonly Pool[]): { mains: Map<string, Main>; nearUsd: bigint | null } {
  const mains = new Map<string, Main>();
  let usd: { wnear: bigint; stable: bigint; decimals: number } | null = null;
  for (const p of pools) {
    const w = p.tokens.indexOf(WNEAR);
    if (w === -1) continue;
    const other = p.tokens[1 - w]!;
    const wnear = p.amounts[w]!;
    const amt = p.amounts[1 - w]!;
    if (wnear <= 0n || amt <= 0n) continue;
    const sd = USD_TOKENS[other];
    if (sd !== undefined && (usd === null || wnear > usd.wnear)) usd = { wnear, stable: amt, decimals: sd };
    const had = mains.get(other);
    if (had === undefined || wnear > had.wnear) mains.set(other, { pool: p.id, amt, wnear, w });
  }
  const nearUsd = usd === null ? null : (usd.stable * pow10(VALUE_SCALE) * pow10(WNEAR_DECIMALS)) / (usd.wnear * pow10(usd.decimals));
  return { mains, nearUsd: nearUsd === null || nearUsd <= 0n ? null : nearUsd };
}

/** The token's USD price times 10^PRICE_SCALE from its main pool's amounts, or null. */
export function priceOf(m: Main, decimals: number, nearUsd: bigint): bigint | null {
  if (m.amt <= 0n || m.wnear <= 0n) return null;
  const p = (m.wnear * nearUsd * pow10(decimals) * pow10(PRICE_SCALE - VALUE_SCALE)) / (m.amt * pow10(WNEAR_DECIMALS));
  return p > 0n ? p : null;
}
/** Twice the wNEAR side, in USD times 10^VALUE_SCALE. */
export const liqOf = (m: Main, nearUsd: bigint): bigint => (2n * m.wnear * nearUsd) / pow10(WNEAR_DECIMALS);
/** A USD value (times 10^VALUE_SCALE) as the rows' decimal string, to the cent. */
export const usdText = (v: bigint): string => fixed((v / pow10(VALUE_SCALE - 2)) * pow10(VALUE_SCALE - 2), VALUE_SCALE);
/** A price as a decimal string with at most 12 significant digits (the rows' prices are display only). */
export function priceText(p: bigint): string {
  const s = p.toString();
  const cut = s.length > 12 ? (p / pow10(s.length - 12)) * pow10(s.length - 12) : p;
  return fixed(cut, PRICE_SCALE);
}
/** Change in basis points from `then` to `now`, or null. */
export function chgBps(now: bigint | null, then: bigint | null): number | null {
  if (now === null || then === null || then <= 0n) return null;
  const bps = Number(((now - then) * 10_000n) / then);
  return Number.isSafeInteger(bps) ? bps : null;
}

/** `ft_metadata` checked: a symbol of 1-32 and a name of 1-64 printable characters, decimals 0 to 30; else null. */
export function toMeta(answer: unknown): Meta | null {
  const o = obj(answer);
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim() : "");
  const symbol = text(o.symbol, 32);
  const name = text(o.name, 64) || symbol;
  const d = o.decimals;
  if (symbol === "" || symbol.length > 32 || name.length > 64 || !Number.isInteger(d) || (d as number) < 0 || (d as number) > 30) return null;
  return { symbol, name, decimals: d as number };
}

/** The wNEAR that moved through a pool from a `get_pool_volumes` answer: Rhea's simple pool counts each swap under its
 *  input token (`volumes[in].input += amount_in; volumes[in].output += amount_out`, ref-exchange simple_pool.rs swap),
 *  so wNEAR paid in is `volumes[w].input` and wNEAR taken out is `volumes[other].output`. Null when not that shape. */
export function wnearFlow(v: unknown, w: number): bigint | null {
  if (!Array.isArray(v) || v.length !== 2 || (w !== 0 && w !== 1)) return null;
  const into = obj(v[w]).input;
  const out = obj(v[1 - w]).output;
  if (typeof into !== "string" || typeof out !== "string" || !DIGITS.test(into) || !DIGITS.test(out)) return null;
  return BigInt(into) + BigInt(out);
}

/** Runs `fn` over `items`, PARALLEL at a time. */
async function each<T, R>(items: readonly T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export type NearDeps = { fetch?: Fetch; now?: () => number; rpcs?: readonly string[]; pastRpcs?: readonly string[] };

export function createNearLists(deps: NearDeps = {}) {
  const fetchFn: Fetch = deps.fetch ?? pacedFetch();
  const now = deps.now ?? Date.now;
  const rpcs = deps.rpcs ?? NEAR_RPCS;
  const pastRpcs = deps.pastRpcs ?? PAST_RPCS;
  let scan: Scan | null = null;
  /** the hour and day reads: each pool's wNEAR volume in each window, and each main pool's price then (per pool id) */
  let windows: { at: number; vol1h: Map<number, bigint>; vol24h: Map<number, bigint>; price1h: Map<string, Main>; price24h: Map<string, Main>; near1h: bigint | null; near24h: bigint | null } | null = null;
  const metas = new Map<string, Meta | "none">();
  let last: ListsAnswer | null = null;
  let running: Promise<void> | null = null;
  let windowsAt = 0;

  async function readPools(at: At, from: readonly string[]): Promise<Pool[]> {
    const n = await view(fetchFn, REF, "get_number_of_pools", {}, at, from);
    if (!Number.isSafeInteger(n) || (n as number) < 0 || (n as number) > POOLS_MAX) throw new Error("pool count out of range");
    const starts = Array.from({ length: Math.ceil((n as number) / PAGE) }, (_, i) => i * PAGE);
    const pages = await each(starts, async (s) => {
      const p = parsePools(await view(fetchFn, REF, "get_pools", { from_index: s, limit: PAGE }, at, from), s);
      if (p === null) throw new Error("get_pools: not a list");
      return p;
    });
    return pages.flat();
  }

  async function metaOf(token: string): Promise<Meta | null> {
    const had = metas.get(token);
    if (had !== undefined) return had === "none" ? null : had;
    try {
      const m = toMeta(await view(fetchFn, token, "ft_metadata", {}, { finality: "final" }, rpcs));
      if (metas.size >= META_MAX) metas.delete(metas.keys().next().value!);
      metas.set(token, m ?? "none");
      return m;
    } catch {
      return null; // a failed read is asked again next time
    }
  }

  /** The wNEAR leg's cumulative volume of `pool` at `at`, or null. */
  async function wnearVolume(pool: number, wIndex: number, at: At, from: readonly string[]): Promise<bigint | null> {
    try {
      const v = await view(fetchFn, REF, "get_pool_volumes", { pool_id: pool }, at, from);
      if (!Array.isArray(v) || v.length !== 2) return null;
      return wnearFlow(v, wIndex);
    } catch {
      return null;
    }
  }

  /** The tokens a list may hold: main pools at or above LIQ_MIN_USD, newest and deepest. */
  function candidates(s: Scan): { newest: string[]; deepest: string[] } {
    if (s.nearUsd === null) return { newest: [], deepest: [] };
    const ok = [...s.mains].filter(([t, m]) => USD_TOKENS[t] === undefined && liqOf(m, s.nearUsd!) >= LIQ_MIN_USD * pow10(VALUE_SCALE));
    const newest = [...ok].sort((a, b) => b[1].pool - a[1].pool).slice(0, LIST_MAX).map(([t]) => t);
    const deepest = [...ok].sort((a, b) => (b[1].wnear > a[1].wnear ? 1 : b[1].wnear < a[1].wnear ? -1 : 0)).slice(0, LIST_MAX).map(([t]) => t);
    return { newest, deepest };
  }

  /** The row of `token` from the latest read, or null when it has no main pool or its metadata cannot be read. */
  function rowFrom(token: string, meta: Meta, s: Scan): Row | null {
    const m = s.mains.get(token);
    if (m === undefined || s.nearUsd === null) return null;
    const p = priceOf(m, meta.decimals, s.nearUsd);
    const w = windows;
    const usdOfNear = (wn: bigint | undefined) => (wn === undefined ? null : usdText((wn * s.nearUsd!) / pow10(WNEAR_DECIMALS)));
    const pastPrice = (mm: Main | undefined, nu: bigint | null) => (mm === undefined || nu === null || mm.pool !== m.pool ? null : priceOf(mm, meta.decimals, nu));
    return {
      chain: "near",
      token,
      symbol: meta.symbol,
      name: meta.name,
      icon: false, // GET /v1/logo/{chain}/{token} is not served yet; the app draws its own
      venue: null,
      label: null,
      created_s: null, // no view gives a pool's launch time
      price_usd: p === null ? null : priceText(p),
      mc_usd: null,
      vol_24h_usd: usdOfNear(w?.vol24h.get(m.pool)),
      chg_5m_bps: null,
      chg_1h_bps: w === null ? null : chgBps(p, pastPrice(w.price1h.get(token), w.near1h)),
      chg_24h_bps: w === null ? null : chgBps(p, pastPrice(w.price24h.get(token), w.near24h)),
      liq_usd: usdText(liqOf(m, s.nearUsd)),
      holders: null,
      top10_bps: null,
      src: "chain",
      as_of_ms: s.t_ms,
      creator: null,
      creator_sold_bps: null,
      dev_bps: null,
      snipers_bps: null,
      mint_auth: null,
      freeze_auth: null,
      vol_5m_usd: null,
      buys_5m: null,
      sells_5m: null,
      net_5m_usd: null,
      risk_src: null,
      launchpad: null,
      curve_bps: null,
      vol_1h_usd: usdOfNear(w?.vol1h.get(m.pool)),
      chg_4h_bps: null,
      buys_24h: null,
      sells_24h: null,
      buys_1h: null,
      sells_1h: null,
    };
  }

  async function readWindows(s: Scan, tokens: readonly string[]): Promise<void> {
    // blocks a second from a block HOUR_S of blocks back at 0.6 s (NEAR's block time, measured each read)
    const ref = await block(fetchFn, { block_id: s.height - 6_000 }, rpcs);
    const perS = 6_000 / Math.max(1, (s.t_ms - ref.t_ms) / 1000);
    const h1 = s.height - Math.round(HOUR_S * perS);
    const h24 = s.height - Math.round(DAY_S * perS);
    const [p1, p24] = await Promise.all([readPools({ block_id: h1 }, rpcs).catch(() => null), readPools({ block_id: h24 }, pastRpcs).catch(() => null)]);
    const m1 = p1 === null ? null : mainsOf(p1);
    const m24 = p24 === null ? null : mainsOf(p24);
    const vol1h = new Map<number, bigint>();
    const vol24h = new Map<number, bigint>();
    await each(tokens, async (t) => {
      const m = s.mains.get(t)!;
      const at = { block_id: s.height };
      const w = m.w;
      const [v0, v1, v24] = await Promise.all([wnearVolume(m.pool, w, at, rpcs), wnearVolume(m.pool, w, { block_id: h1 }, rpcs), wnearVolume(m.pool, w, { block_id: h24 }, pastRpcs)]);
      if (v0 !== null && v1 !== null && v0 >= v1) vol1h.set(m.pool, v0 - v1);
      if (v0 !== null && v24 !== null && v0 >= v24) vol24h.set(m.pool, v0 - v24);
    });
    windows = { at: now(), vol1h, vol24h, price1h: m1?.mains ?? new Map(), price24h: m24?.mains ?? new Map(), near1h: m1?.nearUsd ?? null, near24h: m24?.nearUsd ?? null };
  }

  function build(s: Scan, tokens: readonly string[], c: { newest: string[] }): void {
    const rows = new Map<string, Row>();
    for (const t of tokens) {
      const meta = metas.get(t);
      if (meta === undefined || meta === "none") continue;
      const r = rowFrom(t, meta, s);
      if (r !== null) rows.set(t, r);
    }
    const newRows = c.newest.flatMap((t) => (rows.has(t) ? [rows.get(t)!] : []));
    const volOf = (r: Row) => (typeof r.vol_1h_usd === "string" ? Number(r.vol_1h_usd) : 0);
    const trending = [...rows.values()].filter((r) => volOf(r) > 0).sort((a, b) => volOf(b) - volOf(a)).slice(0, LIST_MAX);
    const pools: Record<string, string> = {};
    for (const t of rows.keys()) pools[t] = String(s.mains.get(t)!.pool);
    const lists = { new: newRows, trending, trending_5m: [] as Row[], trending_1h: trending, graduating: [] as Row[] };
    const body = JSON.stringify({ chain: "near", lists, as_of_ms: s.t_ms, unsettled: [], pools });
    last = { status: 200, body, gzip: gzipSync(body), asOfMs: s.t_ms };
  }

  async function refresh(): Promise<void> {
    const head = await block(fetchFn, { finality: "final" }, rpcs);
    const pools = await readPools({ block_id: head.height }, rpcs);
    const { mains, nearUsd } = mainsOf(pools);
    const s: Scan = { height: head.height, t_ms: head.t_ms, mains, nearUsd };
    const c = candidates(s);
    const tokens = [...new Set([...c.newest, ...c.deepest])];
    await each(tokens, metaOf);
    scan = s;
    build(s, tokens, c);
    // the hour and day reads after the price is served: a first answer never waits on them (trending fills once read)
    if (windows === null || now() - windowsAt >= VOL_REFRESH_MS) {
      windowsAt = now();
      await readWindows(s, tokens).catch(() => undefined);
      build(s, tokens, c);
    }
  }

  /** One refresh at a time; a failure keeps the last good answer. */
  const run = (): Promise<void> => (running ??= refresh().catch(() => undefined).finally(() => (running = null)));
  /** Resolves once an answer is held or the refresh under way ends. */
  const answered = (): Promise<void> => {
    const r = run();
    return new Promise<void>((ok) => {
      const t = setInterval(() => last !== null && (clearInterval(t), ok()), 50);
      void r.finally(() => (clearInterval(t), ok()));
    });
  };

  return {
    /** The latest snapshot (200), dated by its block; 503 until a first read lands (one is started). */
    async get(): Promise<ListsAnswer> {
      if (last === null) {
        await answered();
        if (last === null) return { status: 503, body: JSON.stringify({ error: { code: "upstream" } }) };
      }
      return last;
    },
    /** Reads now, then every PRICE_REFRESH_MS. */
    warm(): () => void {
      void run();
      const t = setInterval(() => void run(), PRICE_REFRESH_MS);
      t.unref?.();
      return () => clearInterval(t);
    },
    /** The latest pool read (token.ts, trades.ts), or null before one. */
    scan(): Scan | null {
      return scan;
    },
    /** A token's row from the latest read, reading its metadata once; null for a token with no main pool. */
    async row(token: string): Promise<{ row: Row; meta: Meta; main: Main } | null> {
      if (scan === null) await answered();
      const s = scan;
      if (s === null) return null;
      const main = s.mains.get(token);
      if (main === undefined) return null;
      const meta = await metaOf(token);
      if (meta === null) return null;
      const row = rowFrom(token, meta, s);
      return row === null ? null : { row, meta, main };
    },
  };
}
export type NearLists = ReturnType<typeof createNearLists>;
