// GET /v1/market/token and /v1/market/holders with chain=base or chain=robinhood: the token page's EVM reads, in the
// Solana path's frozen fields (../solana/token.ts PAGE_FIELDS, RISK_FIELDS and HOLDERS_FIELDS; 06b `TokenPage` and
// `Holders`, docs/spec/06b-wallet-webapp.md:1729-1749). Card market-data-evm-token.
//
// Sources:
//   - the row: Discover's own row for the token (lists.ts), the one its lists answer held, with the launchpad its
//     maker read tagged on chain and the chain it is listed on. Only a token the chain's lists served (lists.ts listed,
//     the gate the candles and the tape share) has a page; any other address answers 404.
//   - decimals, the holder count and the top 10 share: GeckoTerminal's keyless `networks/<net>/tokens/<address>/info`
//     (api.geckoterminal.com/docs/index.html, "tokens/{address}/info", read 2026-11-09 01:50Z: `decimals`,
//     `holders.count`, `holders.distribution_percentage.top_10` and `holders.last_updated` for a Base and a Robinhood
//     token), one call a token, fresh INFO_FRESH_MS. It draws on the one GeckoTerminal budget (../gecko.ts): a first
//     read (nothing held, or held past INFO_SERVE_MS) is a page read, a held one's re-read "refresh", which leaves a cold
//     read its calls (card evm-holders-never-starve: a first read sent to "stale" or "refresh" was refused behind the
//     helper's own lists and ahead reads, live 14:46Z). A held count is served, dated by its read, while under
//     INFO_SERVE_MS (card market-data-evm-capacity: display data that moves slowly, on a budget the helper's own
//     background reads hold 2 to 3 of).
//     A first read waits for the budget's next free call up to GT_PAGE_WAIT_MS (../gecko.ts takeOrWait, the bound the
//     Solana path's cold reads wait under) instead of a 429; a held one's re-read never waits, the held count serves.
//     The page waits for a first read at most INFO_WAIT_MS and is otherwise answered with those fields null, the read
//     held for the next.
//   - pool and decimals on chain: the token's main pool and decimals the swap reads already found and checked on two
//     providers (swaps.ts mainPool), when they hold them; nothing is read for the page.
//   - holder rows: none (`holders: []`), as the Solana path answers with no holders provider. No keyless source lists
//     an EVM token's holders from the helper: Blockscout's instance API answered a Cloudflare challenge (403) and its
//     PRO API asks for a key (402), both read 2026-11-09 01:50Z.
// A field no source here reads is null with src "none" (06b `Field`): mint and freeze authority, LP, dev, snipers,
// tax, honeypot (06b:1818 names the chain round trip of 06c §4.10 for EVM, not built), insiders, bundlers, fresh.
//
// Display only: nothing here feeds a signature. GeckoTerminal's answer is hostile input: used only when it names this
// token, every number checked finite and in range or null; the caches hold at most CACHE_MAX tokens each.
import type { Row } from "../solana/lists.ts";
import type { ListsAnswer } from "../solana/lists.ts";
import { CACHE_MAX, NOT_FOUND, RISK_FIELDS, UPSTREAM, type DataAnswer, type Field } from "../solana/token.ts";
import { GT_PAGE_WAIT_MS, takeOrWait, throttledUntil, WINDOW_MS, type GeckoBudget } from "../gecko.ts";
import { evmAddress, GT_BASE, GT_NETWORK, type EvmChain } from "./lists.ts";

/** A token's GeckoTerminal info is read again once this old [design: the holder count moves slowly (GeckoTerminal's own
 *  `last_updated` was 1-3 min behind its read, 2026-11-09 01:50Z) and the keyless budget is 5 calls in 75 s for the
 *  whole helper; 5 min keeps a page's holders current to the minute at one call a token]. */
export const INFO_FRESH_MS = 300_000;
/** A held info serves, dated by its own read (`as_of_ms`, X-Fetched-At), this long; past it the token is read as one
 *  nobody holds [design (card market-data-evm-capacity): the holder count and top 10 share are display data that move
 *  slowly, and the keyless budget (5 calls in 75 s) holds the helper's own lists and ahead reads in 2 to 3 of its 5
 *  calls (helper log 21:2x-22:2xZ, 9 Nov: lists 1.42 and ahead 0.73 calls a minute, window 3 of 5 in 40 of 60 minutes),
 *  so a count dropped at GT_SERVE_MS (10 min) was read again on a full window and answered 429 (live 20:34Z). An hour
 *  keeps every token opened in the last hour answering with its count however busy the window is, and the count's age
 *  is on the answer; the live check's own runs are an hour apart]. */
export const INFO_SERVE_MS = 3_600_000;
/** The longest a page waits for a token's first info read [design: GeckoTerminal answered the info in 0.38-0.58 s from
 *  a Mac, 2026-11-09 01:52Z; 700 ms keeps the page inside its 1 s with that read, and a later answer is held for the
 *  next read]. */
export const INFO_WAIT_MS = 700;
const ANSWER_MAX = 256 * 1024;
const TIMEOUT_MS = 8_000;
const DECIMALS_MAX = 30;
const DECIMAL = /^\d{1,3}(\.\d{1,20})?$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** What GeckoTerminal's info says of one token, each value null when it names none or a bad one; `asOfMs`: its holders'
 *  `last_updated`, else our read's time. */
export type Info = { decimals: number | null; holders: number | null; top10Bps: number | null; asOfMs: number };
type Read = Info | "none" | "refused" | "failed";
export type EvmTokenPage = { row: Row; decimals: number | null; pool: string | null; risk: Record<(typeof RISK_FIELDS)[number], Field<unknown>>; route: "unknown"; filling: false };

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** GeckoTerminal's info answer for `token` (lowercase), or null when it is not one for that token. */
export function toInfo(token: string, answer: unknown, readAtMs: number): Info | null {
  const d = obj(obj(answer).data);
  const a = obj(d.attributes);
  if (d.type !== "token" || evmAddress(a.address) !== token) return null;
  const decimals = Number.isInteger(a.decimals) && (a.decimals as number) >= 0 && (a.decimals as number) <= DECIMALS_MAX ? (a.decimals as number) : null;
  const h = obj(a.holders);
  const holders = Number.isSafeInteger(h.count) && (h.count as number) >= 0 ? (h.count as number) : null;
  const top = obj(h.distribution_percentage).top_10;
  const pct = typeof top === "string" && DECIMAL.test(top) ? Number(top) : typeof top === "number" && Number.isFinite(top) ? top : null;
  const top10Bps = pct !== null && pct >= 0 && pct <= 100 ? Math.round(pct * 100) : null;
  const at = typeof h.last_updated === "string" && ISO.test(h.last_updated) ? Date.parse(h.last_updated.replace(/(\.\d{3})\d+Z$/, "$1Z")) : NaN;
  // a holders time ahead of our read, or a day behind it, is not taken: the read's own time dates the values
  const asOfMs = Number.isFinite(at) && at <= readAtMs && readAtMs - at <= 86_400_000 ? at : readAtMs;
  return { decimals, holders, top10Bps, asOfMs };
}

/** The TokenPage from the token's Discover row, its GeckoTerminal info (null when none is held) and the pool and decimals
 *  the swap reads hold. */
export function toPage(base: Row, info: Info | null, kept: { pool: string; decimals: number } | undefined): EvmTokenPage {
  const row: Row = { ...base };
  if (info !== null) {
    row.holders = info.holders;
    row.top10_bps = info.top10Bps;
  }
  const rowAt = row.as_of_ms as number;
  const none = (): Field<never> => ({ v: null, src: "none", as_of_ms: rowAt });
  const gt = <T>(v: T | null, at: number): Field<T> => ({ v, src: "geckoterminal", as_of_ms: at });
  const created = row.created_s as number | null;
  return {
    row,
    decimals: kept?.decimals ?? info?.decimals ?? null,
    pool: kept?.pool ?? null,
    risk: {
      mint_auth: none(),
      freeze_auth: none(),
      lp: none(),
      top10_bps: info === null ? none() : gt(info.top10Bps, info.asOfMs),
      dev_bps: none(),
      snipers_bps: none(),
      holders: info === null ? none() : gt(info.holders, info.asOfMs),
      liq_usd: gt(row.liq_usd, rowAt),
      // the row's time is its pool's, made with the token by every listed launchpad (lists.ts)
      age_s: gt(created === null ? null : Math.max(0, Math.floor(rowAt / 1000) - created), rowAt),
      tax: none(),
      honeypot: none(),
      insiders_bps: none(),
      bundlers_bps: none(),
      fresh_bps: none(),
    },
    // whether a token routes is the device's own read at the quote, never the data part's call
    route: "unknown",
    filling: false,
  };
}

/** A map that keeps at most `max` keys, dropping the oldest written. */
function bounded<V>(max: number) {
  const m = new Map<string, V>();
  return {
    get: (k: string) => m.get(k),
    set(k: string, v: V) {
      m.delete(k);
      m.set(k, v);
      while (m.size > max) m.delete(m.keys().next().value!);
    },
  };
}

/** One EVM chain's token page and holders. `lists`: the chain's Discover lists (lists.ts get and listed); `kept`: the
 *  swap reads' pool and decimals for a token, when held (swaps.ts kept). */
export function createEvmToken(
  chain: EvmChain,
  deps: { lists: { get(): Promise<ListsAnswer>; listed(token: string): Promise<boolean> }; gecko: GeckoBudget; kept?: (token: string) => { pool: string; decimals: number } | undefined; fetch?: Fetch; now?: () => number; sleep?: (ms: number) => Promise<unknown> },
) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((ok) => setTimeout(ok, ms)));
  const doFetch = deps.fetch ?? fetch;
  const rows = bounded<Row>(CACHE_MAX);
  let seen: string | undefined;
  const infos = bounded<{ info: Info | "none"; at: number }>(CACHE_MAX);
  const running = new Map<string, Promise<Read>>();

  /** The token's row from the lists' newest answer, else the last one an answer held, while the lists still count it
   *  served; null for a token they never served; undefined while the lists have never answered. */
  async function rowOf(token: string): Promise<Row | null | undefined> {
    const a = await deps.lists.get();
    if (a.status !== 200 || a.asOfMs === undefined) return undefined;
    // keyed on the answer itself: a tick rebuilds it with a maker newly read and the same as_of_ms (its oldest list
    // read), and the row's launchpad tag is then the new one
    if (seen !== a.body) {
      const snap = JSON.parse(a.body) as { lists: Record<string, Row[]> };
      for (const list of Object.values(snap.lists)) for (const r of list) rows.set(r.token as string, r);
      seen = a.body;
    }
    const row = rows.get(token);
    return row !== undefined && row.chain === chain && (await deps.lists.listed(token)) ? row : null;
  }

  async function readInfo(token: string, lane: "pages" | "stale" | "refresh"): Promise<Read> {
    if ((await takeOrWait(deps.gecko, lane, `${chain} info`, now() + GT_PAGE_WAIT_MS, now, sleep)) !== null) return "refused";
    try {
      const r = await doFetch(`${GT_BASE}/networks/${GT_NETWORK[chain]}/tokens/${token}/info`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
      if (r.status === 429) {
        throttledUntil(deps.gecko, r.headers.get("retry-after"), now());
        await r.body?.cancel();
        return "refused";
      }
      if (r.status === 404) {
        await r.body?.cancel();
        return "none";
      }
      if (r.status !== 200 || Number(r.headers.get("content-length") ?? "0") > ANSWER_MAX) {
        await r.body?.cancel();
        return "failed";
      }
      const body = await r.text();
      if (body.length > ANSWER_MAX) return "failed";
      return toInfo(token, JSON.parse(body), now()) ?? "failed";
    } catch {
      return "failed";
    }
  }

  /** The info held for the token while servable (under INFO_SERVE_MS) and, when it is not fresh, the read that refreshes
   *  it (one at a time): a page read when nothing servable is held, else a "refresh", which leaves COLD_RESERVE calls
   *  for a read of what nobody holds. The page and holders share it, so either one's read serves the other. */
  function infoOf(token: string): { held: Info | "none" | undefined; read: Promise<Read> | undefined } {
    const h = infos.get(token);
    if (h !== undefined && now() - h.at < INFO_FRESH_MS) return { held: h.info, read: undefined };
    const servable = h !== undefined && now() - h.at < INFO_SERVE_MS;
    let p = running.get(token);
    if (p === undefined) {
      const started = now();
      p = readInfo(token, servable ? "refresh" : "pages")
        .then((x) => {
          if (x !== "refused" && x !== "failed") infos.set(token, { info: x, at: started });
          return x;
        })
        .finally(() => running.delete(token));
      running.set(token, p);
    }
    return { held: servable && h !== undefined ? h.info : undefined, read: p };
  }

  const LATE = Symbol("late");
  const within = <T>(p: Promise<T>, ms: number): Promise<T | typeof LATE> => {
    let t: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([p, new Promise<typeof LATE>((ok) => (t = setTimeout(() => ok(LATE), ms)))]).finally(() => clearTimeout(t));
  };
  const usable = (x: unknown): Info | null => (typeof x === "object" && x !== null ? (x as Info) : null);

  return {
    /** 06b TokenPage for a token the chain's lists served; 404 for any other address, 503 while the lists never answered. */
    async page(token: string): Promise<DataAnswer> {
      const t = evmAddress(token);
      if (t === null) return NOT_FOUND;
      const row = await rowOf(t);
      if (row === undefined) return UPSTREAM;
      if (row === null) return NOT_FOUND;
      const { held, read } = infoOf(t);
      const info = held !== undefined ? usable(held) : read === undefined ? null : usable(await within(read, INFO_WAIT_MS));
      const page = toPage(row, info, deps.kept?.(t));
      return { status: 200, body: JSON.stringify(page), src: "geckoterminal", asOfMs: row.as_of_ms as number };
    },
    /** 06b Holders: no rows, GeckoTerminal's count and top 10 share; 429 when the budget refuses a token nothing is held
     *  for (or held past INFO_SERVE_MS), 503 when GeckoTerminal fails it. */
    async holders(token: string): Promise<DataAnswer> {
      const t = evmAddress(token);
      if (t === null) return NOT_FOUND;
      const row = await rowOf(t);
      if (row === undefined) return UPSTREAM;
      if (row === null) return NOT_FOUND;
      const { held, read } = infoOf(t);
      const got: Read | undefined = read === undefined ? held : await read;
      const info: Info | "none" | undefined = got === "refused" || got === "failed" ? held : got;
      if (info === undefined) {
        if (got === "refused") return { status: 429, body: JSON.stringify({ error: { code: "rate_limited" } }), retryAfterS: Math.min(Math.max(Math.ceil((deps.gecko.retryAt("pages") - now()) / 1000), 1), WINDOW_MS / 1000), why: "geckoterminal budget" };
        return UPSTREAM;
      }
      const i = info === "none" ? null : info;
      const at = i?.asOfMs ?? now();
      return { status: 200, body: JSON.stringify({ holders: [], total: i?.holders ?? null, top_bps: i?.top10Bps ?? null, src: "geckoterminal", as_of_ms: at }), src: "geckoterminal", asOfMs: at };
    },
  };
}
export type EvmToken = ReturnType<typeof createEvmToken>;
