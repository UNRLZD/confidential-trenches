// The token page's lower panel and About (card app-token-lower-panel), drawn after R5's U.lowerTabs, U.tradesTab,
// U.holdersTab and U.about (research repo design/proto/assets/token.js at design-lock-r5). Under the chart, who holds
// and who trades:
//   - Holders: the helper's GET /v1/market/holders (apps/helper/src/data/solana/token.ts, 06b `Holders`): up to 20 rows
//     merged per owner when the helper holds the holders key, else no rows and Jupiter's holder count and top-holders
//     share (`src: "jupiter"`). The tab's count and top share are the read's, else the token row's own Jupiter fields
//     (a chain the helper serves no holders for answers 404). A row's value is its amount at the token's price.
//   - Trades: the tape the chart's marks read (trades.ts), newest first as the helper sends it.
//   - About: the token row's four change windows, its 5m tiles and the 24h buys and sells as a flow bar.
// The answer is hostile input: a row that is not of the shape, or more rows than the helper sends, is no read at all,
// never a partly read list; a failed read is never logged. A field nothing reads is the dash, never a made-up number.
// Display only: nothing here feeds a signature.
import { HELPER_FETCH_INIT } from "@blindfill/kit";
import { useEffect, useState } from "react";
import type { MarketChain, MarketRow } from "../discover/fields.ts";
import { age, compact, count, DASH, price, usd } from "../discover/format.ts";
import { pct } from "../trade/safety.ts";
import { change24 } from "./model.ts";
import type { Trade } from "./trades.ts";

const BASE = "https://ct-api.unrealized.trade";
export const HOLDERS_URL = (chain: MarketChain, token: string): string => `${BASE}/v1/market/holders?chain=${encodeURIComponent(chain)}&token=${encodeURIComponent(token)}`;
/** The helper's own row cap (HOLDERS_MAX). */
export const HOLDERS_MAX = 20;
/** The helper serves one holders read this long (HOLDERS_FRESH_MS): an open tab reads again no sooner. */
export const HOLDERS_POLL_MS = 60_000;
const TIMEOUT_MS = 10_000;
const BODY_MAX = 200_000;
const NAME_MAX = 128;

export interface Holder {
  addr: string;
  /** The amount in the mint's base units, an integer string. */
  amt: string;
  /** The share of the supply in basis points, null when the supply was not read. */
  bps: number | null;
  kind?: "burn";
}
export interface HoldersRead {
  holders: Holder[];
  total: number | null;
  topBps: number | null;
  src: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const named = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= NAME_MAX;
const bpsOf = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000;
const countOf = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function toHolder(r: unknown): Holder | null {
  if (!isObject(r)) return null;
  const { addr, amt, bps, kind } = r;
  if (!named(addr) || typeof amt !== "string" || !/^\d{1,40}$/.test(amt)) return null;
  if (bps !== null && !bpsOf(bps)) return null;
  if (kind !== undefined && kind !== "burn") return null;
  return kind === "burn" ? { addr, amt, bps, kind } : { addr, amt, bps };
}

/** The answer as a read, or null when any part of it is not of the shape. */
export function toHolders(body: unknown): HoldersRead | null {
  if (!isObject(body) || !Array.isArray(body.holders) || body.holders.length > HOLDERS_MAX) return null;
  const { total, top_bps, src } = body;
  if ((total !== null && !countOf(total)) || (top_bps !== null && !bpsOf(top_bps)) || !named(src)) return null;
  const holders: Holder[] = [];
  for (const r of body.holders) {
    const h = toHolder(r);
    if (h === null) return null;
    holders.push(h);
  }
  return { holders, total, topBps: top_bps, src };
}

/** One read of the helper; null on a non-200 (a chain it serves no holders for answers 404), a throw or a bad answer. */
export async function readHolders(chain: MarketChain, token: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<HoldersRead | null> {
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const r = await fetchFn(HOLDERS_URL(chain, token), { ...HELPER_FETCH_INIT, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (r.status !== 200) return null;
    const text = await r.text();
    if (text.length > BODY_MAX) return null;
    return toHolders(JSON.parse(text));
  } catch {
    return null;
  }
}

export type HoldersState = { status: "loading" } | { status: "none" } | { status: "ready"; read: HoldersRead };

/** The token's holders while `on` (the Holders tab is open): read on open and every HOLDERS_POLL_MS while it stays open
 *  and in sight; a new token starts from loading. A failed read is `none`, a good one replaces it. */
export function useHolders(chain: MarketChain | null, token: string | null, on: boolean): HoldersState {
  const key = chain !== null && token !== null ? `${chain}\n${token}` : "";
  const [state, setState] = useState<{ key: string; s: HoldersState }>({ key: "", s: { status: "loading" } });
  useEffect(() => {
    if (chain === null || token === null || !on) return;
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      if (!document.hidden) {
        const read = await readHolders(chain, token, fetch, stop.signal);
        if (stop.signal.aborted) return;
        setState((s) => (read === null ? (s.key === key && s.s.status === "ready" ? s : { key, s: { status: "none" } }) : { key, s: { status: "ready", read } }));
      }
      timer = setTimeout(() => void tick(), HOLDERS_POLL_MS);
    };
    void tick();
    return () => {
      stop.abort();
      clearTimeout(timer);
    };
  }, [chain, token, key, on]);
  return state.key === key ? state.s : { status: "loading" };
}

/** The Holders tab's count and top-10 share: the read's, else the token row's own Jupiter fields. */
export function holdersSummary(read: HoldersRead | null, row: Pick<MarketRow, "holders" | "top10_bps">): { count: string; top: string } {
  const total = read?.total ?? (countOf(row.holders) ? row.holders : null);
  const top = read?.topBps ?? (bpsOf(row.top10_bps) ? row.top10_bps : null);
  return { count: count(total), top: top === null ? DASH : pct(top) };
}

/** A non-negative number as the decimal string the formats read (never an exponent form). */
const dec = (n: number): string | null => (Number.isFinite(n) && n >= 0 ? n.toFixed(18).replace(/\.?0+$/, "") : null);

export interface HolderView {
  addr: string;
  usd: string;
  amount: string;
  share: string;
  /** The share bar's width, a percent of the biggest circulating holder's. */
  width: number;
  burn: boolean;
  creator: boolean;
}

/** Holder rows as R5 draws them: the value (amount x price), the amount in whole tokens, the share of supply to one
 *  place and its bar against the biggest holder that is not burnt. No decimals or no price read: the dash there. */
export function holderViews(rows: readonly Holder[], o: { decimals: number | null; priceUsd: string | null; creator: string | null }): HolderView[] {
  const max = Math.max(...rows.filter((h) => h.kind === undefined && h.bps !== null).map((h) => h.bps!), 1);
  const p = o.priceUsd !== null && /^\d+(\.\d+)?$/.test(o.priceUsd) ? Number(o.priceUsd) : null;
  return rows.map((h) => {
    const whole = o.decimals !== null && Number.isInteger(o.decimals) && o.decimals >= 0 ? Number(h.amt) / 10 ** o.decimals : null;
    const amount = whole === null ? null : dec(whole);
    const value = whole === null || p === null ? null : dec(whole * p);
    return {
      addr: h.addr,
      usd: value === null ? DASH : usd(value),
      amount: amount === null ? DASH : compact(Number(amount)),
      share: h.bps === null ? DASH : `${(h.bps / 100).toFixed(1)}%`,
      width: h.bps === null ? 0 : Math.min(100, Number(((h.bps / max) * 100).toFixed(1))),
      burn: h.kind === "burn",
      creator: o.creator !== null && h.addr === o.creator,
    };
  });
}

export interface TapeView {
  key: string;
  age: string;
  side: Trade["side"];
  mc: string;
  amount: string;
  total: string;
  /** The total's bar, a percent of the biggest trade's. */
  width: number;
  trader: string | null;
  creator: boolean;
}

/** Trade rows as R5 draws them: the age, the side, the MC the trade filled at (its price times the supply), the amount,
 *  the total in USD and its bar against the biggest trade's, the trader. No supply read: no MC. */
export function tapeViews(trades: readonly Trade[], o: { supply: number | null; creator: string | null; nowMs: number }): TapeView[] {
  const max = Math.max(...trades.map((t) => Number(t.usd)), 0.01);
  return trades.map((t) => {
    const u = Number(t.usd);
    const mc = o.supply === null ? null : dec((u / Number(t.amt)) * o.supply);
    return {
      key: t.tx,
      age: age(Math.floor(t.t_ms / 1000), o.nowMs),
      side: t.side,
      mc: mc === null ? DASH : usd(mc),
      amount: compact(Number(t.amt)),
      total: price(t.usd),
      width: Math.min(100, Number(((u / max) * 100).toFixed(1))),
      trader: t.trader,
      creator: o.creator !== null && t.trader === o.creator,
    };
  });
}

export type Tone = "acc" | "sell" | "none";
export interface AboutView {
  windows: { id: "5M" | "1H" | "4H" | "1D"; text: string; tone: Tone }[];
  five: { vol: string; buys: string; sells: string; net: string; netTone: Tone };
  /** The 24h buys and sells; `buyPct` is the buys' share of the bar, null when neither is known. */
  flow: { buys: string; sells: string; buyPct: number | null };
}

const MINUS = "−";

/** A signed USD amount (net flow): +$27.52K, −$51.08K; anything else the dash. */
function signedUsd(v: string | null | undefined): { text: string; tone: Tone } {
  if (typeof v !== "string" || !/^-?\d+(\.\d+)?$/.test(v)) return { text: DASH, tone: "none" };
  const neg = v.startsWith("-") && Number(v) !== 0;
  return { text: `${neg ? MINUS : "+"}${usd(v.replace(/^-/, ""))}`, tone: neg ? "sell" : "acc" };
}

/** About from the token row: R5's 5M 1H 4H 1D change tiles, the 5m tiles (vol, buys, sells, net), the 24h flow. */
export function aboutView(row: MarketRow): AboutView {
  const win = (id: AboutView["windows"][number]["id"], bps: number | null | undefined) => {
    const c = change24(bps);
    return { id, text: c.text, tone: (c.dir === "up" ? "acc" : c.dir === "down" ? "sell" : "none") as Tone };
  };
  const net = signedUsd(row.net_5m_usd);
  const b = countOf(row.buys_24h) ? row.buys_24h : null;
  const s = countOf(row.sells_24h) ? row.sells_24h : null;
  return {
    windows: [win("5M", row.chg_5m_bps), win("1H", row.chg_1h_bps), win("4H", row.chg_4h_bps), win("1D", row.chg_24h_bps)],
    five: { vol: usd(row.vol_5m_usd), buys: count(row.buys_5m), sells: count(row.sells_5m), net: net.text, netTone: net.tone },
    flow: { buys: count(b), sells: count(s), buyPct: b !== null && s !== null && b + s > 0 ? Number(((b / (b + s)) * 100).toFixed(1)) : null },
  };
}
