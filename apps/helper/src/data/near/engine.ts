// chain=near's market reads from the unrealized.trade engine's public API (https://api.unrealized.trade/v1, keyless,
// CORS *, read 2026-11-14 03:50Z: /discover, /trending, /token/{id} and its /holders, /trades and /candles each 200 in
// 0.6 to 1.0 s). The engine indexes every NEAR block (Rhea classic and DCL, the launchpads' curves, the token ledgers),
// so a row carries what Rhea's contract views cannot give (lists.ts): market cap, holders, launch time, launchpad,
// buys and sells by window, the top 10, dev, snipers, insiders, bundlers and fresh shares, the token's tax and its
// full-access keys. Rhea's views stay the fallback: a read the engine does not answer (down, slow, a token it does not
// hold, a bad answer) is served from lists.ts, token.ts and trades.ts as before.
//
// Wire forms are the other chains' (../solana/lists.ts toRow): USD values decimal strings, changes and shares basis
// points, counts integers, a value no source has null; src "unrealized" on what the engine gave.
//
// Mappings that are not one field for one field:
//   - mint_auth and freeze_auth: a NEP-141 token has no mint or freeze authority; whoever holds a full-access key on
//     its account can deploy new code that mints or freezes, so both are `fullAccessKeys > 0` (0: false, unknown: null);
//   - tax: the engine's buy and sell tax where the token splits it, else its transfer tax on both sides;
//   - honeypot: false once a wallet other than the creator sold in the last 30 min (nonDevSells30m) or selling back a
//     1 NEAR buy returns at least half (sellablePct); true when neither happened and that sell-back returns nothing;
//     else unknown;
//   - lp: `curve` while the token is on its launchpad's curve (the only LP class the grid draws, safety.ts).
// Prices the engine gives in NEAR (candles) are drawn in USD at the token's own NEAR price ratio of the same read
// (priceUsd / priceNear), as trades.ts draws the Rhea tape at NEAR's price of the latest pool read.
//
// Pace: one schedule for the host (limits.ts HOST_PACE_MS), the lists every LISTS_MS (4 calls), each token's reads held
// FRESH_MS, at most one read in flight per key. The engine's own per-IP limit for a read it must fetch first is 120 a
// minute (packages/ws-protocol V1_LIMITS.coldReadsPerMin in the unrealized.trade repo); the pace keeps the helper under it.
//
// Display only: nothing here feeds a signature. Every answer is hostile input: size bounded, ids checked as NEAR
// accounts, numbers finite and in range or null, text bounded and stripped.
import { gzipSync } from "node:zlib";
import { LOGOS } from "../logo.ts";
import { LINKS, linksOf } from "../links.ts";
import { dec, text, type ListsAnswer, type Row } from "../solana/lists.ts";
import { NOT_FOUND, type DataAnswer, type Field, type Holder, type RISK_FIELDS } from "../solana/token.ts";
import { TF_SECONDS } from "../candles.ts";
import { nearAccount, pacedFetch, type Fetch } from "./views.ts";
import type { NearMarket } from "./token.ts";

export const ENGINE = "https://api.unrealized.trade/v1";
export const SRC = "unrealized";
/** The lists are read again this often [design: the other chains' Discover refresh is 12 s (../solana/lists.ts
 *  FRESH_MS); 4 calls each time is 24 a minute, a fifth of the engine's cold-read limit, and its lists are cached]. */
export const LISTS_MS = 10_000;
/** A lists answer older than this is not served: the Rhea snapshot is (lists.ts). */
export const STALE_MS = 60_000;
/** A token's page, holders, tape and bars are served as held this long. */
export const FRESH_MS = 5_000;
/** Rows a list holds (lists.ts LIST_MAX). */
export const LIST_MAX = 50;
export const TOKENS_MAX = 500;
const ANSWER_MAX = 4 * 1024 * 1024;
const TIMEOUT_MS = 6_000;

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const count = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);
/** A percent as whole basis points within [min, max], or null. */
function bps(pct: unknown, min = -Infinity, max = Infinity): number | null {
  if (!finite(pct) || pct < min || pct > max || Math.abs(pct) > 1e9) return null;
  return Math.round(pct * 100) || 0;
}
const share = (pct: unknown): number | null => bps(pct, 0, 100);
/** Whole basis points already (the engine's tax), 0 to 10,000, or null. */
const bpsInt = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 10_000 ? (v as number) : null);
const LAUNCHPAD = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
/** A time in ms as unix seconds, from 2009 to a day past `nowMs`, or null. */
const seconds = (ms: unknown, nowMs: number): number | null => (finite(ms) && ms >= Date.UTC(2009, 0, 1) && ms <= nowMs + 86_400_000 ? Math.floor(ms / 1000) : null);
const DIGITS = /^\d{1,40}$/;
const HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** Selling back a 1 NEAR buy returns at least this share: not a honeypot [design: a curve's fees and its price impact
 *  take a few percent; half lost on the round trip is no market, but it is still not a token that refuses the sell]. */
const SELLABLE_OK_PCT = 50;

/** One engine token (a list row or /token/{id}'s `token`) as a Row, or null when it has no valid id, symbol or name. */
export function engineRow(raw: unknown, asOfMs: number): Row | null {
  const j = obj(raw);
  const token = nearAccount(j.id);
  const symbol = text(j.symbol, 32);
  const name = text(j.name, 64) ?? symbol;
  if (token === null || symbol === null || name === null) return null;
  const w = obj(j.windows);
  const w5 = obj(w["5m"]);
  const w1 = obj(w["1h"]);
  const w24 = obj(w["24h"]);
  const net5 = finite(w5.buyUsd) && finite(w5.sellUsd) && w5.buyUsd >= 0 && w5.sellUsd >= 0 ? dec(w5.buyUsd - w5.sellUsd, true) : null;
  const keys = obj(j.risk).fullAccessKeys;
  const auth = count(keys) === null ? null : (keys as number) > 0;
  const stage = j.stage;
  const progress = bpsInt(j.progressBps);
  const launchpad = typeof j.launchpad === "string" && LAUNCHPAD.test(j.launchpad) ? j.launchpad : null;
  const socials = obj(j.socials);
  LINKS.remember("near", token, linksOf(socials.website, socials.twitter, socials.telegram));
  return {
    chain: "near",
    token,
    symbol,
    name,
    icon: LOGOS.remember("near", token, j.icon), // GET /v1/logo/near/{token} serves it (../logo.ts)
    venue: null,
    label: null,
    created_s: seconds(j.chainCreatedAtMs, asOfMs) ?? seconds(j.createdAtMs, asOfMs),
    price_usd: dec(j.priceUsd),
    mc_usd: dec(j.mcapUsd),
    vol_24h_usd: dec(j.vol24hUsd),
    chg_5m_bps: bps(j.change5mPct, -100),
    chg_1h_bps: bps(j.change1hPct, -100),
    chg_24h_bps: bps(j.change24hPct, -100),
    liq_usd: dec(j.liquidityUsd),
    holders: count(j.holders),
    top10_bps: share(j.top10Pct),
    src: SRC,
    as_of_ms: asOfMs,
    creator: nearAccount(j.creator),
    creator_sold_bps: share(j.creatorSoldPct),
    dev_bps: share(j.devPct),
    snipers_bps: share(j.snipersPct),
    mint_auth: auth,
    freeze_auth: auth,
    vol_5m_usd: dec(j.vol5mUsd),
    buys_5m: count(j.buys5m) ?? count(w5.buys),
    sells_5m: count(j.sells5m) ?? count(w5.sells),
    net_5m_usd: net5,
    risk_src: SRC,
    launchpad,
    // on a curve: its progress; listed (graduated or never on one): all of it; otherwise unknown
    curve_bps: stage === "listed" ? 10_000 : progress,
    vol_1h_usd: dec(j.vol1hUsd),
    chg_4h_bps: null, // the engine has no 4h window
    buys_24h: count(w24.buys),
    sells_24h: count(w24.sells),
    buys_1h: count(w1.buys),
    sells_1h: count(w1.sells),
  };
}

/** A list answer ({ upsert, order }) as rows in its order, each token once, only tokens with a price and a market
 *  cap, at most LIST_MAX; null when not one. */
export function engineRows(answer: unknown, asOfMs: number): Row[] | null {
  const a = obj(answer);
  if (!Array.isArray(a.upsert) || !Array.isArray(a.order) || a.upsert.length > 200 || a.order.length > 200) return null;
  const byId = new Map<string, Row>();
  for (const r of a.upsert) {
    const row = engineRow(r, asOfMs);
    if (row !== null && !byId.has(row.token as string)) byId.set(row.token as string, row);
  }
  const out: Row[] = [];
  for (const id of a.order) {
    const r = typeof id === "string" ? byId.get(id) : undefined;
    // a token with no price has no market to list (its MC, price and liquidity would all be blank)
    if (r !== undefined && r.mc_usd !== null && r.price_usd !== null && !out.includes(r)) out.push(r);
    if (out.length >= LIST_MAX) break;
  }
  return out;
}

/** The page's risk part from an engine token (06b `Field`s, src "unrealized" where the engine gave a value). */
export function engineRisk(raw: unknown, row: Row, asOfMs: number): Record<(typeof RISK_FIELDS)[number], Field<unknown>> {
  const j = obj(raw);
  const risk = obj(j.risk);
  const f = (v: unknown): Field<unknown> => ({ v: v ?? null, src: v === null || v === undefined ? "none" : SRC, as_of_ms: asOfMs });
  const transfer = bpsInt(risk.transferTaxBps);
  const buy = bpsInt(risk.buyTaxBps) ?? transfer;
  const sell = bpsInt(risk.sellTaxBps) ?? transfer;
  const sellable = finite(j.sellablePct) && j.sellablePct >= 0 && j.sellablePct <= 100 ? j.sellablePct : null;
  const others = count(j.nonDevSells30m);
  const honeypot = (others !== null && others > 0) || (sellable !== null && sellable >= SELLABLE_OK_PCT) ? false : sellable === 0 && others === 0 ? true : null;
  const onCurve = j.stage !== "listed" && j.stage !== "dead" && bpsInt(j.progressBps) !== null;
  const created = row.created_s as number | null;
  return {
    mint_auth: f(row.mint_auth),
    freeze_auth: f(row.freeze_auth),
    lp: f(onCurve ? { class: "curve", bps: null } : null),
    top10_bps: f(row.top10_bps),
    dev_bps: f(row.dev_bps),
    snipers_bps: f(row.snipers_bps),
    holders: f(row.holders),
    liq_usd: f(row.liq_usd),
    age_s: f(created === null ? null : Math.max(0, Math.floor(asOfMs / 1000) - created)),
    tax: f(buy === null || sell === null ? null : { buy_bps: buy, sell_bps: sell }),
    honeypot: f(honeypot),
    insiders_bps: f(share(j.insidersPct)),
    bundlers_bps: f(share(j.bundlersPct)),
    fresh_bps: f(share(j.freshPct)),
  };
}

/** The holders answer's rows: account, raw amount, share in bps; at most 100. */
export function engineHolders(answer: unknown): { holders: Holder[]; total: number | null; top_bps: number | null } | null {
  const a = obj(answer);
  if (!Array.isArray(a.holders)) return null;
  const holders: Holder[] = [];
  for (const h of a.holders.slice(0, 100)) {
    const o = obj(h);
    const addr = nearAccount(o.account);
    const amt = typeof o.balance === "string" && DIGITS.test(o.balance) ? o.balance : null;
    if (addr === null || amt === null) continue;
    holders.push({ addr, amt, bps: share(o.pct) });
  }
  const top = holders.slice(0, 10).map((h) => h.bps);
  const top_bps = top.length > 0 && top.every((b) => b !== null) ? Math.min(10_000, top.reduce((s, b) => s! + b!, 0)!) : null;
  return { holders, total: count(a.total), top_bps };
}

/** A whole-token amount (raw / 10^decimals) as a decimal string, or null. */
function whole(raw: unknown, decimals: number): string | null {
  if (typeof raw !== "string" || !DIGITS.test(raw)) return null;
  const s = raw.padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals).replace(/^0+(?=\d)/, "");
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac === "" ? int : `${int}.${frac}`;
}

/** The trades answer as the tape's rows, newest first, at most `limit`. */
export function engineTape(answer: unknown, decimals: number, limit: number): { t_ms: number; side: "b" | "s"; usd: string; amt: string; trader: string | null; tx: string }[] | null {
  const a = obj(answer);
  if (!Array.isArray(a.trades)) return null;
  const out: { t_ms: number; side: "b" | "s"; usd: string; amt: string; trader: string | null; tx: string }[] = [];
  const seen = new Set<string>();
  for (const t of a.trades) {
    const o = obj(t);
    const tx = typeof o.txHash === "string" && HASH.test(o.txHash) ? o.txHash : null;
    const side = o.side === "buy" ? "b" : o.side === "sell" ? "s" : null;
    const usd = dec(o.usd);
    const amt = whole(o.tokenAmount, decimals);
    const at = finite(o.tsMs) && o.tsMs > 0 ? Math.floor(o.tsMs) : null;
    const id = typeof o.id === "string" ? o.id : `${tx}:${at}:${side}`;
    if (tx === null || side === null || usd === null || amt === null || at === null || seen.has(id)) continue;
    seen.add(id);
    out.push({ t_ms: at, side, usd, amt, trader: nearAccount(o.trader), tx });
    if (out.length >= limit) break;
  }
  return out.sort((x, y) => y.t_ms - x.t_ms);
}

/** The candles answer (NEAR prices, ms times) as the other chains' bars: [unix s, o, h, l, c, volume] in USD at
 *  `nearUsd` (USD per NEAR), oldest first. */
export function engineBars(answer: unknown, nearUsd: number): [number, string, string, string, string, string][] | null {
  const a = obj(answer);
  if (!Array.isArray(a.candles) || !finite(nearUsd) || nearUsd <= 0) return null;
  const out: [number, string, string, string, string, string][] = [];
  for (const c of a.candles) {
    const o = obj(c);
    if (!finite(o.t) || o.t <= 0) continue;
    const px = [o.o, o.h, o.l, o.c].map((v) => (finite(v) && v > 0 ? dec(v * nearUsd) : null));
    const vol = finite(o.vNear) && o.vNear >= 0 ? dec(o.vNear * nearUsd) : "0";
    if (px.some((p) => p === null) || vol === null) continue;
    out.push([Math.floor(o.t / 1000), px[0]!, px[1]!, px[2]!, px[3]!, vol]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

export type EngineDeps = { fetch?: Fetch; now?: () => number; base?: string };

/** The engine's reads with their caches: each answers null when it has nothing good (the caller falls back). */
export function createEngineNear(deps: EngineDeps = {}) {
  const fetchFn: Fetch = deps.fetch ?? pacedFetch();
  const now = deps.now ?? Date.now;
  const base = deps.base ?? ENGINE;

  async function get(path: string): Promise<unknown> {
    const r = await fetchFn(`${base}${path}`, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status === 404) return undefined;
    if (r.status !== 200) throw new Error(`engine ${r.status}`);
    const body = await r.text();
    if (body.length > ANSWER_MAX) throw new Error("engine answer too large");
    return JSON.parse(body);
  }

  /** A per-key cache of the last good answer, read again past FRESH_MS (the held one serves meanwhile), one at a time. */
  function cached<T>(freshMs: number) {
    const held = new Map<string, { at: number; v: T | undefined }>();
    const reading = new Map<string, Promise<{ at: number; v: T | undefined } | null>>();
    return async (key: string, read: () => Promise<T | undefined>): Promise<{ at: number; v: T | undefined } | null> => {
      const had = held.get(key);
      if (had !== undefined && now() - had.at <= freshMs) return had;
      let p = reading.get(key);
      if (p === undefined) {
        p = read()
          .then((v) => {
            const h = { at: now(), v };
            if (!held.has(key) && held.size >= TOKENS_MAX) held.delete(held.keys().next().value!);
            held.set(key, h);
            return h;
          })
          .catch(() => null)
          .finally(() => reading.delete(key));
        reading.set(key, p);
      }
      if (had !== undefined) return had; // the held answer serves while the new read runs
      return p;
    };
  }

  const tokens = cached<{ raw: unknown; row: Row }>(FRESH_MS);
  const holderReads = cached<unknown>(FRESH_MS);
  const tradeReads = cached<unknown>(FRESH_MS);
  const barReads = cached<unknown>(FRESH_MS);

  let last: { body: string; gzip: Buffer; asOfMs: number } | null = null;
  let running: Promise<void> | null = null;

  async function readLists(pools: () => Record<string, string>): Promise<void> {
    const at = now();
    const [fresh, grad, t5, t1] = await Promise.all([
      get(`/discover?column=new&limit=${LIST_MAX}`),
      get(`/discover?column=graduating&limit=${LIST_MAX}`),
      get(`/trending?window=5m&limit=${LIST_MAX}`),
      get(`/trending?window=1h&limit=${LIST_MAX}`),
    ]);
    const lists = [fresh, grad, t5, t1].map((a) => engineRows(a, at));
    if (lists.some((l) => l === null)) throw new Error("engine lists: shape");
    const [n, g, tr5, tr1] = lists as Row[][];
    const body = JSON.stringify({ chain: "near", lists: { new: n, trending: tr1, trending_5m: tr5, trending_1h: tr1, graduating: g }, as_of_ms: at, unsettled: [], pools: pools() });
    last = { body, gzip: gzipSync(body), asOfMs: at };
  }

  async function token(id: string): Promise<{ raw: unknown; row: Row } | null> {
    const t = nearAccount(id);
    if (t === null) return null;
    const h = await tokens(t, async () => {
      const a = await get(`/token/${encodeURIComponent(t)}`);
      if (a === undefined) return undefined;
      const raw = obj(a).token;
      const row = engineRow(raw, now());
      if (row === null || row.token !== t) throw new Error("engine token: shape");
      return { raw, row };
    });
    return h?.v ?? null;
  }

  const decimalsOf = (raw: unknown): number | null => {
    const d = obj(raw).decimals;
    return Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 30 ? (d as number) : null;
  };

  return {
    /** Reads the lists now (one at a time); `pools` names each token's Rhea pool where the Rhea read holds one. */
    refresh(pools: () => Record<string, string> = () => ({})): Promise<void> {
      return (running ??= readLists(pools)
        .catch(() => undefined)
        .finally(() => (running = null)));
    },
    /** The lists' latest answer while it is under STALE_MS old, else null. */
    lists(): ListsAnswer | null {
      return last !== null && now() - last.asOfMs <= STALE_MS ? { status: 200, ...last } : null;
    },
    /** The token page, or null when the engine has no good answer for it. */
    async page(id: string): Promise<DataAnswer | null> {
      const t = await token(id);
      const d = t === null ? null : decimalsOf(t.raw);
      if (t === null || d === null) return null;
      const at = t.row.as_of_ms as number;
      const page = { row: t.row, decimals: d, pool: null, risk: engineRisk(t.raw, t.row, at), route: "unknown", filling: false, links: LINKS.of("near", t.row.token as string) };
      return { status: 200, body: JSON.stringify(page), src: SRC, asOfMs: at };
    },
    async holders(id: string): Promise<DataAnswer | null> {
      const t = nearAccount(id);
      if (t === null) return null;
      const h = await holderReads(t, () => get(`/token/${encodeURIComponent(t)}/holders`));
      const parsed = h === null || h.v === undefined ? null : engineHolders(h.v);
      if (h === null || parsed === null) return null;
      return { status: 200, body: JSON.stringify({ ...parsed, src: SRC, as_of_ms: h.at }), src: SRC, asOfMs: h.at };
    },
    async trades(id: string, limit: number): Promise<DataAnswer | null> {
      const t = await token(id);
      const d = t === null ? null : decimalsOf(t.raw);
      if (t === null || d === null) return null;
      const h = await tradeReads(t.row.token as string, () => get(`/token/${encodeURIComponent(t.row.token as string)}/trades`));
      const rows = h === null || h.v === undefined ? null : engineTape(h.v, d, limit);
      if (h === null || rows === null) return null;
      return { status: 200, body: JSON.stringify({ trades: rows, src: SRC, as_of_ms: h.at }), src: SRC, asOfMs: h.at };
    },
    async candles(id: string, tf: string, to: number | null, limit: number): Promise<DataAnswer | null> {
      if (!Object.hasOwn(TF_SECONDS, tf)) return NOT_FOUND;
      const t = await token(id);
      const j = t === null ? {} : obj(t.raw);
      const nearUsd = finite(j.priceUsd) && finite(j.priceNear) && j.priceNear > 0 ? j.priceUsd / j.priceNear : null;
      if (t === null || nearUsd === null) return null;
      const q = `tf=${tf}&limit=${Math.min(limit, 1000)}${to === null ? "" : `&to=${to * 1000}`}`;
      const h = await barReads(`${t.row.token}|${q}`, () => get(`/token/${encodeURIComponent(t.row.token as string)}/candles?${q}`));
      const bars = h === null || h.v === undefined ? null : engineBars(h.v, nearUsd);
      if (h === null || bars === null) return null;
      return { status: 200, body: JSON.stringify({ tf, candles: bars.slice(-limit), src: SRC, as_of_ms: h.at }), src: SRC, asOfMs: h.at };
    },
  };
}
export type EngineNear = ReturnType<typeof createEngineNear>;

/** chain=near's market: each read the engine's when it has a good answer, else Rhea's (lists.ts, token.ts, trades.ts).
 *  `warm` reads the engine's lists now and every LISTS_MS; Rhea's keep their own cadence (lists.ts warm). */
export function engineFirst(rhea: NearMarket, engine: EngineNear): NearMarket & { warm(): () => void } {
  const pools = (): Record<string, string> => {
    const s = rhea.lists.scan();
    const out: Record<string, string> = {};
    if (s !== null) for (const [t, m] of s.mains) out[t] = String(m.pool);
    return out;
  };
  return {
    lists: {
      ...rhea.lists,
      async get() {
        return engine.lists() ?? (await engine.refresh(pools), engine.lists()) ?? rhea.lists.get();
      },
    },
    token: {
      page: async (t) => (await engine.page(t)) ?? rhea.token.page(t),
      holders: async (t) => (await engine.holders(t)) ?? rhea.token.holders(t),
    },
    trades: {
      trades: async (t, limit) => (await engine.trades(t, limit)) ?? rhea.trades.trades(t, limit),
      candles: async (t, tf, to, limit) => (await engine.candles(t, tf, to, limit)) ?? rhea.trades.candles(t, tf, to, limit),
    },
    warm() {
      void engine.refresh(pools);
      const t = setInterval(() => void engine.refresh(pools), LISTS_MS);
      t.unref?.();
      return () => clearInterval(t);
    },
  };
}
