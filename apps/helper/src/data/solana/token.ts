// GET /v1/market/token, /v1/market/holders and /v1/market/candles with chain=solana: the token page's Solana reads
// (markets paper M4.2 and D1.1 rows D-S6, D-S7, D-S11 and D-S12; the field lists frozen with the app's screens). The
// answers are 06b §6.1's `TokenPage`, `Holders` and `Candles` (docs/spec/06b-wallet-webapp.md:1729-1749), with the
// page's `row` the same `Row` Discover reads (lists.ts toRow, apps/terminal/src/screens/discover/fields.ts).
//
// Sources:
//   - page: one `getMultipleAccounts` (jsonParsed) of the mint and its pump.fun curve account through the helper's RPC
//     path (src/rpc/), and the token's row: Discover's own row when the token is on the lists (lists.ts), else Jupiter's
//     `/tokens/v2/search` through the helper's proxy (src/proxy/), up to 100 mints a call, one call out at a time and at
//     most SEARCH_PER_SPAN in the proxy's counted minute (D-S6, card helper-token-page-cold): a mint a caller waits for
//     goes at once, a held mint's refresh JUP_GAP_MS after the last call; the mint and the row are read together. The
//     mint account gives decimals, the mint and freeze authorities and the Token-2022 transfer fee (Risk `tax`); the
//     curve account gives `curve_bps` and `lp: curve` while on its curve.
//   - holders: `getTokenLargestAccounts`, then one `getMultipleAccounts` (jsonParsed) of those accounts for their
//     owners, merged per owner (D-S11), on the holders provider only (SOLANA_HOLDERS_RPC_URL; the public endpoints
//     refuse the call). With none set, or when it does not answer: `holders: []`, `total` and `top_bps` from
//     Jupiter's `holderCount` and `audit.topHoldersPercentage`, `src` naming Jupiter (06b v1.36).
//   - candles: GeckoTerminal (keyless) `tokens/<mint>` for the token's top pool, then the pool's OHLCV in USD for the
//     mint (D-S7), every call through one queue of at most GT_PER_MIN a minute (L-05) and each answer shared.
//
// Display only: nothing here feeds a signature (the device reads the mint and the pools itself before it signs). Every
// vendor and RPC value is hostile input: a mint must be an account the token programs own, typed `mint`; every number
// is checked finite and in range or becomes null; the caches hold at most CACHE_MAX tokens each.
import { address, dec, toRow, type Row } from "./lists.ts";
import { createOrigins, hintsOf, rpcAccounts, type Hint, type Origin } from "./origin.ts";
import { geckoBudget, GT_LIMIT_PER_MIN, GT_SERVE_MS, refreshLane, throttledUntil, type GeckoBudget } from "../gecko.ts";
import { retryAfterOf, secondsUntil, Throttled } from "../../limits/limits.ts";
import { QUERY_MAX, VENDOR_WINDOW_MS } from "../../proxy/proxy.ts";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** Mainnet's epoch length in slots (no warm-up), for the Token-2022 fee in force at the read's slot. */
const SLOTS_PER_EPOCH = 432_000;

/** The page and the holders: the last good answer serves this long, then the read answers 503 (D1's helper rules). */
export const STALE_MS = 60_000;
/** TokenPage "cacheable 5 s" (06b); D-S6's per-token 12 s is the longer bound, and the page asks every 5 s. */
export const PAGE_FRESH_MS = 5_000;
/** The page waits at most this for the token's launch read (origin.ts) once its mint and row are in; a launch read past
 *  it lands in origin.ts's record and the next page read takes it from there; until then the launch is null, never a
 *  guess. [design: the public Solana RPC took 0.9-1.9 s a call from the helper's box (3 Nov 20:58Z), so a launch read,
 *  one or two calls after the row, cannot fit a 1 s page; 300 ms takes one that answers fast.] */
export const LAUNCH_WAIT_MS = 300;
/** D-S11: per mint 60 s. */
export const HOLDERS_FRESH_MS = 60_000;
/** 06b: the OHLCV history is cached 60 s and shared; a token's top pool is kept 10 minutes. */
export const CANDLES_FRESH_MS = 60_000;
/**
 * The longest a caller's cold GeckoTerminal read waits for the budget's next free call (card helper-crowd-429). [design:
 * 4 s: a cold chart is two calls (its top pool, then its bars), so 8 s of waits and GeckoTerminal's answers stay inside
 * the app's 10 s request (apps/terminal/src/screens/token/candles.ts TIMEOUT_MS), which then reads a 429 again after its
 * Retry-After (THROTTLE_RETRIES 2); the live checks wait on the answer with no timeout of their own.]
 */
export const GT_PAGE_WAIT_MS = 4_000;
/** History before a given time (a read with `to`: the bars before our own first bar, or a range scrolled back) never
 *  changes: kept an hour, as the EVM chains keep theirs (../evm/swaps.ts GT_FRESH_MS) (card app-console-429). */
export const HISTORY_FRESH_MS = 3_600_000;
export const POOL_FRESH_MS = 600_000;
/** L-05: GeckoTerminal's public API, as measured (../gecko.ts GT_LIMIT_PER_MIN); the server shares one budget with the
 *  EVM lists, which yield to the token page. */
export const GT_PER_MIN = GT_LIMIT_PER_MIN;
export const GT_BASE = "https://api.geckoterminal.com/api/v2";
/** D-S6: Jupiter's search reads up to 100 mints a call; a mint's row is read again after 12 s. */
export const SEARCH_MAX = 100;
export const JUP_FRESH_MS = 12_000;
/** The search's part of the helper's own Jupiter reserve (../../proxy/proxy.ts PROXY_RESERVE: 34, with the lists' 18):
 *  at most this many searches in any span the proxy's budget counts as one minute (a call counts until the end of its
 *  second plus VENDOR_WINDOW_MS, ../../limits/limits.ts upstreamBudget), so the searches never take the callers' part
 *  of Jupiter's one bucket (L-01: 60 a minute on a 60 s sliding window, Swap and Token requests together,
 *  developers.jup.ag/docs/api-rate-limit, read 2026-11-04 14:25Z) and a swap build never waits behind token pages. */
export const SEARCH_PER_SPAN = 16;
/** A held mint's refresh (its page served at once from what is held) is batched: it goes JUP_GAP_MS after the last
 *  search, and only while COLD_ROOM of the SEARCH_PER_SPAN stay free, so a mint a caller waits for always finds room at
 *  once; such a mint goes as soon as there is room, carrying every refresh due (card helper-token-page-cold). */
export const JUP_GAP_MS = 4_000;
export const COLD_ROOM = 4;
/** A search whose room is further off than this answers its waiting callers 429 with the wait instead of holding them
 *  (never longer than the old batch gap); the mint stays in the next search, so the retry finds its row. */
export const SEARCH_WAIT_MAX_MS = 4_000;
/** Tokens held per cache; the oldest goes first. */
export const CACHE_MAX = 2_000;
export const HOLDERS_MAX = 20;
export const CANDLES_MAX = 500;
const ANSWER_MAX = 2 * 1024 * 1024;
const TIMEOUT_MS = 8_000;

/** The timeframes 06b names and the GeckoTerminal OHLCV call for each; `1s` is not served on Solana (06b v1.15). */
export const TF = {
  "1m": { period: "minute", aggregate: 1, s: 60 },
  "5m": { period: "minute", aggregate: 5, s: 300 },
  "15m": { period: "minute", aggregate: 15, s: 900 },
  "1h": { period: "hour", aggregate: 1, s: 3_600 },
  "4h": { period: "hour", aggregate: 4, s: 14_400 },
  "1d": { period: "day", aggregate: 1, s: 86_400 },
} as const;
export type Tf = keyof typeof TF;

/** 06b `Field<T>`: `src` names the provider, "chain" for our own read, or "none" for a value nothing reads yet. */
export type Field<T> = { v: T | null; src: string; as_of_ms: number };
export const RISK_FIELDS = [
  "mint_auth", "freeze_auth", "lp", "top10_bps", "dev_bps", "snipers_bps", "holders", "liq_usd", "age_s", "tax", "honeypot",
  "insiders_bps", "bundlers_bps", "fresh_bps",
] as const;
export type Risk = Record<(typeof RISK_FIELDS)[number], Field<unknown>>;
export const PAGE_FIELDS = ["row", "decimals", "pool", "risk", "route"] as const;
export type TokenPage = { row: Row; decimals: number; pool: string | null; risk: Risk; route: "ok" | "none" | "unknown" };
export type Holder = { addr: string; amt: string; bps: number | null; kind?: "burn" };
export const HOLDERS_FIELDS = ["holders", "total", "top_bps", "src", "as_of_ms"] as const;
export type Holders = { holders: Holder[]; total: number | null; top_bps: number | null; src: string; as_of_ms: number };
export type Candle = [number, string, string, string, string, string];
export const CANDLES_FIELDS = ["tf", "candles", "src", "as_of_ms"] as const;
export type Candles = { tf: Tf; candles: Candle[]; src: string; as_of_ms: number };

/** The burn address SPL tokens are sent to (the incinerator). */
const INCINERATOR = "1nc1nerator11111111111111111111111111111111";

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const U64 = /^(0|[1-9]\d{0,19})$/;
const u64 = (v: unknown): bigint | null => (typeof v === "string" && U64.test(v) && BigInt(v) <= 0xffff_ffff_ffff_ffffn ? BigInt(v) : null);

// ---------------------------------------------------------------------------------------------------------------
// The mint account (D-S12)
// ---------------------------------------------------------------------------------------------------------------

export type Mint = { decimals: number; supply: bigint; mintAuth: boolean; freezeAuth: boolean; feeBps: number };

/** An authority as jsonParsed writes it: null when none, else an address; anything else is not a mint. */
const auth = (v: unknown): boolean | undefined => (v === null ? false : address(v) !== null ? true : undefined);

/** The transfer fee in force at `slot` in basis points: 0 with no TransferFeeConfig; undefined when it is malformed. */
function transferFee(extensions: unknown, slot: number): number | undefined {
  if (extensions === undefined) return 0;
  if (!Array.isArray(extensions)) return undefined;
  const cfg = extensions.find((e) => obj(e).extension === "transferFeeConfig");
  if (cfg === undefined) return 0;
  const st = obj(obj(cfg).state);
  const pick = (f: unknown) => {
    const o = obj(f);
    return Number.isSafeInteger(o.epoch) && Number.isInteger(o.transferFeeBasisPoints) && (o.transferFeeBasisPoints as number) >= 0 && (o.transferFeeBasisPoints as number) <= 10_000
      ? { epoch: o.epoch as number, bps: o.transferFeeBasisPoints as number }
      : null;
  };
  const older = pick(st.olderTransferFee);
  const newer = pick(st.newerTransferFee);
  if (older === null || newer === null) return undefined;
  return Math.floor(slot / SLOTS_PER_EPOCH) >= newer.epoch ? newer.bps : older.bps;
}

/** A jsonParsed account as a mint, or null when it is not a mint of the two token programs. */
export function toMint(account: unknown, slot: number): Mint | null {
  const a = obj(account);
  if (a.owner !== TOKEN_PROGRAM && a.owner !== TOKEN_2022_PROGRAM) return null;
  const parsed = obj(obj(a.data).parsed);
  if (parsed.type !== "mint") return null;
  const info = obj(parsed.info);
  const decimals = info.decimals;
  const supply = u64(info.supply);
  const mintAuth = auth(info.mintAuthority);
  const freezeAuth = auth(info.freezeAuthority);
  // a classic SPL mint has no extensions and no transfer fee
  const feeBps = a.owner === TOKEN_PROGRAM ? 0 : transferFee(info.extensions, slot);
  if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 255 || supply === null || mintAuth === undefined || freezeAuth === undefined || feeBps === undefined) return null;
  return { decimals: decimals as number, supply, mintAuth, freezeAuth, feeBps };
}

// ---------------------------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------------------------

/** Jupiter's search answer: the one row whose id is exactly this mint, or null. */
export function searchRow(answer: unknown, mint: string): Record<string, unknown> | null {
  if (!Array.isArray(answer)) return null;
  const hit = answer.slice(0, 100).find((r) => obj(r).id === mint);
  return hit === undefined ? null : obj(hit);
}

/** The pool Jupiter names for a token: its graduated pool, else its first pool, which Jupiter writes as the mint
 *  itself for a token on a curve (never a pool). */
export function jupiterPool(jup: Record<string, unknown>): string | null {
  const first = address(obj(jup.firstPool).id);
  return address(jup.graduatedPool) ?? (first !== jup.id ? first : null);
}

/** The TokenPage from a mint, the token's Row (Discover's, or made from Jupiter's search row), the pool Jupiter names
 *  and the token's launch as read on chain (origin.ts; null for none, undefined when not read). The launch names the
 *  row's launchpad: a Discover row keeps its own (read on chain by the lists, with Jupiter's config) when this read
 *  finds none; a row from Jupiter's search never keeps Jupiter's tag alone. */
export function toPage(mint: Mint, base: Row, jupPool: string | null, origin: Origin | null | undefined, listed: boolean, chainAtMs: number, jupAtMs: number): TokenPage {
  const row: Row = { ...base };
  row.launchpad = origin?.pad ?? (listed ? base.launchpad : null);
  const curveBps = origin?.curveBps ?? null;
  if (curveBps !== null) row.curve_bps = curveBps;
  // the chain's own reads win over Jupiter's for the authorities (D-S12)
  row.mint_auth = mint.mintAuth;
  row.freeze_auth = mint.freezeAuth;
  const chain = <T>(v: T | null): Field<T> => ({ v, src: "chain", as_of_ms: chainAtMs });
  const jupiter = <T>(v: T | null): Field<T> => ({ v, src: "jupiter", as_of_ms: jupAtMs });
  const none: Field<never> = { v: null, src: "none", as_of_ms: chainAtMs };
  const onCurve = origin != null && curveBps !== null && curveBps < 10_000;
  const created = row.created_s as number | null;
  // the pool the token trades in: its launchpad's pool while on its curve, else the pool Jupiter names, when it does
  const pool = onCurve ? origin.pool : jupPool;
  return {
    row,
    decimals: mint.decimals,
    pool,
    risk: {
      mint_auth: chain(mint.mintAuth),
      freeze_auth: chain(mint.freezeAuth),
      // a launchpad curve is `curve`; other Solana pools have no named read yet (06b `lp`), so null
      lp: onCurve ? chain({ class: "curve", bps: null }) : { ...none },
      top10_bps: jupiter(row.top10_bps),
      dev_bps: jupiter(row.dev_bps),
      snipers_bps: { ...none }, // D-S13: no free source at list scale
      holders: jupiter(row.holders),
      liq_usd: jupiter(row.liq_usd),
      age_s: jupiter(created === null ? null : Math.max(0, Math.floor(jupAtMs / 1000) - created)),
      // Token-2022 TransferFee (06c §3.6): the fee is charged on every transfer, so on a buy and on a sell alike
      tax: chain({ buy_bps: mint.feeBps, sell_bps: mint.feeBps }),
      honeypot: { ...none }, // 06c §3.8 mintRisk is not built
      insiders_bps: { ...none },
      bundlers_bps: { ...none },
      fresh_bps: { ...none },
    },
    // whether a token routes is the device's reference-pool read at the quote (S12), never the data part's call
    route: "unknown",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Holders (D-S11)
// ---------------------------------------------------------------------------------------------------------------

/** Holder rows from getTokenLargestAccounts' value and the owners read for those accounts; null when either is
 *  malformed. Accounts of one owner are merged; `bps` is of the supply. */
export function toHolders(largest: unknown, owners: readonly unknown[], supply: bigint): Holder[] | null {
  if (!Array.isArray(largest) || largest.length > HOLDERS_MAX || owners.length !== largest.length) return null;
  const by = new Map<string, bigint>();
  for (let i = 0; i < largest.length; i++) {
    const amt = u64(obj(largest[i]).amount);
    const acct = obj(owners[i]);
    const info = obj(obj(obj(acct.data).parsed).info);
    const owner = address(info.owner);
    if (amt === null || owner === null || (acct.owner !== TOKEN_PROGRAM && acct.owner !== TOKEN_2022_PROGRAM)) return null;
    by.set(owner, (by.get(owner) ?? 0n) + amt);
  }
  return [...by]
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .map(([addr, amt]) => {
      const h: Holder = { addr, amt: amt.toString(), bps: supply > 0n ? Number((amt * 10_000n) / supply) : null };
      if (addr === INCINERATOR) h.kind = "burn";
      return h;
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Candles (D-S7)
// ---------------------------------------------------------------------------------------------------------------

/** GeckoTerminal's token answer: the address of its top pool on Solana, or null. */
export function topPool(answer: unknown): string | null {
  const pools = obj(obj(obj(obj(answer).data).relationships).top_pools).data;
  if (!Array.isArray(pools) || pools.length === 0) return null;
  const id = obj(pools[0]).id;
  return typeof id === "string" && id.startsWith("solana_") ? address(id.slice("solana_".length)) : null;
}

/** GeckoTerminal's OHLCV answer as bars, oldest first, one per open time, each on its timeframe's grid; null when it
 *  is not a list. A bar with a value that is not a finite non-negative number, or with low above high, is dropped. */
export function toCandles(answer: unknown, tf: Tf, limit: number, nowMs: number): Candle[] | null {
  const list = obj(obj(obj(answer).data).attributes).ohlcv_list;
  if (!Array.isArray(list)) return null;
  const step = TF[tf].s;
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const raw of list.slice(0, 1_000)) {
    if (!Array.isArray(raw) || raw.length < 6) continue;
    const [t, o, h, l, c, v] = raw as unknown[];
    if (!Number.isSafeInteger(t) || (t as number) % step !== 0 || (t as number) * 1000 > nowMs + 60_000 || (t as number) < 1_230_768_000) continue;
    const vals = [o, h, l, c].map((x) => dec(x));
    const vol = dec(v);
    if (vals.some((x) => x === null || x === "0") || vol === null) continue;
    if ((l as number) > (h as number) || (o as number) > (h as number) || (c as number) > (h as number) || (o as number) < (l as number) || (c as number) < (l as number)) continue;
    if (seen.has(t as number)) continue;
    seen.add(t as number);
    out.push([t as number, vals[0]!, vals[1]!, vals[2]!, vals[3]!, vol]);
  }
  return out.sort((a, b) => a[0] - b[0]).slice(-limit);
}

// ---------------------------------------------------------------------------------------------------------------
// The served answers
// ---------------------------------------------------------------------------------------------------------------

type Answer = { status: number; headers: Record<string, string>; body: string };
type Proxy = { handle(vendor: string, path: string, rawQuery: string, body: string, client?: string, reserved?: boolean): Promise<Answer> };
type Rpc = { handle(chain: string, contentType: string | undefined, body: string, client?: string): Promise<{ status: number; headers?: Record<string, string>; body: string; why?: string }> };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** `retryAfterS`: a 429's wait (card helper-abuse-limits), which server.ts answers as its Retry-After. */
/** `why`: a 429's limit, for the refusal log (limits.ts throttled), never sent. */
export type DataAnswer = { status: number; body: string; src?: string; asOfMs?: number; retryAfterS?: number; why?: string };

const err = (status: number, code: string): DataAnswer => ({ status, body: JSON.stringify({ error: { code } }) });
export const NOT_FOUND = err(404, "not_found");
export const UPSTREAM = err(503, "upstream");
/** A throttled read with nothing good to serve: 429 with its wait, never 503 (a 503 never means "wait"). */
const limited = (retryAfterS: number, why?: string): DataAnswer => ({ ...err(429, "rate_limited"), retryAfterS, ...(why === undefined ? {} : { why }) });

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
    size: () => m.size,
    entries: () => [...m],
  };
}

/** A warm entry's answer, read back from the previous process's file (hostile input, as a vendor's answer): a 200 whose
 *  body passes `body`, read no later than now and, when `maxAgeMs` is set, whose data is under it old. */
type Kept = { at: number; body: string; src?: string; asOfMs: number };
function keptOf(v: unknown, nowMs: number, maxAgeMs: number, body: (b: string) => boolean): Kept | null {
  const o = v as Partial<Kept> | null;
  if (typeof o !== "object" || o === null) return null;
  if (typeof o.at !== "number" || !Number.isFinite(o.at) || o.at > nowMs || typeof o.asOfMs !== "number" || !Number.isFinite(o.asOfMs) || o.asOfMs > nowMs || nowMs - o.asOfMs > maxAgeMs) return null;
  if (typeof o.body !== "string" || o.body.length > ANSWER_MAX || !body(o.body)) return null;
  if (o.src !== undefined && (typeof o.src !== "string" || !/^[a-z,]{1,40}$/.test(o.src))) return null;
  return { at: o.at, body: o.body, asOfMs: o.asOfMs, ...(o.src === undefined ? {} : { src: o.src }) };
}
/** A body that is one JSON object (a page or holders answer as built). */
const isObjectBody = (b: string): boolean => {
  try {
    const v = JSON.parse(b);
    return typeof v === "object" && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
};
const DEC = /^\d{1,30}(\.\d{1,30})?$/;
/** Bars as kept: at most 1000 Candles, each [t_s, o, h, l, c, vol] with t a whole second and the rest decimals. */
const isBars = (v: unknown): v is Candle[] =>
  Array.isArray(v) && v.length <= 1_000 && v.every((c) => Array.isArray(c) && c.length === 6 && Number.isSafeInteger(c[0]) && c[0] > 0 && c.slice(1).every((x) => typeof x === "string" && DEC.test(x)));
/** The bytes of answers a process hands the next one (data/warm.ts holds the whole file under WARM_MAX, 16 MB, with
 *  the EVM lists' answers) [design: 4 MB, a few hundred pages and holders and two dozen charts' last bars]. */
export const HANDOVER_MAX = 4 * 1024 * 1024;
/** The last good bars handed over are at most this old: bars are history with their read time, so a swap's first loads
 *  are answered from them, dated, rather than going to a GeckoTerminal budget the old helper spent [design: a day]; the
 *  newest range only while they are under GT_SERVE_MS, history before their read at any age (card helper-restart-fresh). */
export const KEPT_HANDOVER_MS = 86_400_000;

/** Card helper-restart-fresh: the newest charts callers read lately are re-read by the helper itself, in GeckoTerminal's
 *  "ahead" lane (../gecko.ts), once their bars are AHEAD_MS old, so the bars it holds, and hands over at a swap, stay
 *  inside GT_SERVE_MS. Read 2026-11-04 (helper live runs 41899807434, 41905007564; app live run 41908369953,
 *  app-token-chart's Trending mint 429 after four reads with Retry-After): right after a swap the whole live suite opens
 *  its charts at once (two Solana tokens off our own venues at 1-2 calls each, token.ts pools and bars; Base's and
 *  Robinhood's charts, ../evm/swaps.ts; the EVM lists, ../evm/lists.ts) into a window of 5 calls the old helper's last
 *  calls already count in (server.ts seedGecko), and a chart whose handed-over bars were past GT_SERVE_MS answered 429:
 *  reUSD's 15m 0 of 25 at 19:44:47Z with Retry-After 51-53, PUMP's 1h at 20:16:58Z. [design: half of GT_SERVE_MS, so a
 *  key re-read one window late is still inside it; HOT_MAX callers' charts and the TOP_MAX Trending ones, at most 7 at one
 *  call a WINDOW_MS (75 s), come round in 525 s, inside GT_SERVE_MS; a chart in use is also re-read by its callers.] */
export const AHEAD_MS = GT_SERVE_MS / 2;
/** A chart read by a caller this recently is kept fresh [design: an hour; a deploy's live suite reads its charts at every
 *  deploy, and the chart a page opened in the last hour is the one its next visitor opens]. */
export const HOT_MS = 3_600_000;
/** The callers' charts kept fresh, the most recently read; the oldest read goes when one more is read. */
export const HOT_MAX = 3;
/** The timeframe the app's chart opens on (apps/terminal/src/screens/token/candles.ts DEFAULT_TF). */
export const AHEAD_TF: Tf = "15m";
/** The Trending rows whose AHEAD_TF chart is always kept fresh, with no caller read: the first TOP_MAX of Discover's
 *  Trending column as Discover orders it (apps/terminal/src/screens/discover/model.ts columnRows: trending_1h, one row a
 *  token, 1h volume above 0, the largest first), the rows a visitor opens first, and the list's own first row, which "/"
 *  draws (app-console-429 reads it 25 at once; app-token-chart opens the column's third row). */
export const TOP_MAX = 3;
/** How often the server asks for one re-read ahead (server.ts); each ask makes at most one GeckoTerminal call. */
export const AHEAD_TICK_MS = 5_000;

/** A read cached per key: fresh within `freshMs` of our own read; a failed refresh serves the last good one while its
 *  data is under STALE_MS old; one read per key at a time. `client`, the caller whose request makes the read, draws
 *  its share of the provider's budget for it (card helper-abuse-limits); a hit or a call joining one in flight draws
 *  nothing. `read` answers null for "no such token" and throws for an
 *  upstream failure. `opts.revalidate`: a good answer past `freshMs` whose data is under STALE_MS old is answered at
 *  once while one refresh runs, so a caller never waits on a slow upstream for what it was just served. `opts.view`:
 *  every kept answer as served (the token page fills a launch read since). `read`'s `held`: a good answer is held for
 *  the key (its re-read is a refresh, ../gecko.ts "refresh"); `opts.keepHeld`: a refresh refused by a budget serves
 *  the held answer, dated by its own read, whatever its age (card app-console-429). `read`'s `waits`: the caller waits
 *  for this read, with nothing served meanwhile (card helper-token-page-cold); a joiner that would wait on a read
 *  begun as a refresh waits on it as it is. */
function cached(freshMs: number | ((key: string) => number), now: () => number, read: (key: string, client?: string, held?: boolean, waits?: boolean) => Promise<DataAnswer>, opts: { revalidate?: boolean; view?: (key: string, a: DataAnswer) => DataAnswer; keepHeld?: boolean } = {}) {
  // what the next process takes over: answers this one would still serve. keepHeld serves a held answer at any age when
  // a refresh is refused, so it hands over for KEPT_HANDOVER_MS, the rest under STALE_MS (card helper-restart-fresh: a
  // top pool past its 60 s was dropped at a swap, and a chart's first read there cost two GeckoTerminal calls, not one)
  const handoverMs = opts.keepHeld === true ? KEPT_HANDOVER_MS : STALE_MS;
  const view = (key: string, a: DataAnswer) => (opts.view === undefined ? a : opts.view(key, a));
  const last = bounded<{ a: DataAnswer; at: number }>(CACHE_MAX);
  const running = new Map<string, Promise<DataAnswer>>();
  return {
    size: last.size,
    /** The answer held for `key` (a 404 included), at any age, or undefined (the ahead lane's top pool, card
     *  helper-restart-fresh). */
    peek: (key: string): DataAnswer | undefined => last.get(key)?.a,
    /** Holds `a` for `key` as read now (a read made outside get, the ahead lane's). */
    put: (key: string, a: DataAnswer): void => last.set(key, { a, at: now() }),
    /** Its good answers whose data is under handoverMs old, newest last: what the next process serves (card
     *  app-console-429). */
    state: (): [string, Kept][] =>
      last
        .entries()
        .filter(([, v]) => v.a.status === 200 && now() - (v.a.asOfMs ?? v.at) <= handoverMs)
        .map(([k, v]) => [k, { at: v.at, body: v.a.body, asOfMs: v.a.asOfMs ?? v.at, ...(v.a.src === undefined ? {} : { src: v.a.src }) }]),
    /** A previous process's answers: each kept when its key passes `key` and it is newer than what this one holds. */
    restore(entries: unknown, key: (k: string) => boolean, body: (b: string) => boolean): void {
      if (!Array.isArray(entries)) return;
      const t = now();
      for (const e of entries.slice(-CACHE_MAX)) {
        if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string" || !key(e[0])) continue;
        const v = keptOf(e[1], t, handoverMs, body);
        if (v === null || (last.get(e[0])?.at ?? -Infinity) >= v.at) continue;
        last.set(e[0], { a: { status: 200, body: v.body, asOfMs: v.asOfMs, ...(v.src === undefined ? {} : { src: v.src }) }, at: v.at });
      }
    },
    get(key: string, client?: string): Promise<DataAnswer> {
      const hit = last.get(key);
      if (hit !== undefined && now() - hit.at < (typeof freshMs === "number" ? freshMs : freshMs(key))) return Promise.resolve(view(key, hit.a));
      const usable = opts.revalidate === true && hit !== undefined && hit.a.status === 200 && now() - (hit.a.asOfMs ?? hit.at) <= STALE_MS;
      let p = running.get(key);
      if (p === undefined) {
        const started = now(); // fresh from when the read began, so a refresh answered in the background is never fresher than its data
        p = read(key, client, hit !== undefined && hit.a.status === 200, !usable)
          .then((a) => {
            if (a.status === 200 || a.status === 404) last.set(key, { a, at: started });
            return a;
          })
          .catch((e) => (hit !== undefined && hit.a.status === 200 && ((opts.keepHeld === true && e instanceof Throttled) || now() - (hit.a.asOfMs ?? hit.at) <= STALE_MS) ? hit.a : e instanceof Throttled ? limited(e.retryAfterS, e.why) : UPSTREAM))
          .finally(() => running.delete(key));
        running.set(key, p);
      }
      return usable ? Promise.resolve(view(key, hit.a)) : p.then((a) => view(key, a));
    },
  };
}

class Upstream extends Error {}

const rpcBody = (method: string, params: unknown[]) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

/** `listed` is Discover's lists (lists.ts get): a token on them takes its row from there, with no Jupiter call. */
/** `holdersRpc` is the provider holders' getTokenLargestAccounts goes to (D-S11: a keyed one, the only kind that
 *  answers it); with none, holders is Jupiter's fallback and the shared RPC path never sees the call, since a provider's
 *  429 on it would be the device's own reads' and sends' 429 too. */
export function createSolanaToken(proxy: Proxy, rpc: Rpc, deps: { fetch?: Fetch; now?: () => number; listed?: () => Promise<DataAnswer>; holdersRpc?: Rpc; gecko?: GeckoBudget } = {}) {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;

  async function call(method: string, params: unknown[], via: Rpc = rpc, client?: string): Promise<{ result: Record<string, unknown> }> {
    const a = await via.handle("solana", "application/json", rpcBody(method, params), client);
    if (a.status === 429) throw new Throttled(retryAfterOf(a.headers), a.why);
    if (a.status !== 200) throw new Upstream();
    const j = obj(JSON.parse(a.body));
    if (!Object.hasOwn(j, "result")) throw new Upstream();
    return { result: obj(j.result) };
  }

  // Jupiter's search (D-S6, card helper-token-page-cold): every mint asked while a search is out joins the next one, of
  // up to SEARCH_MAX mints, the mints callers wait for first. The next search goes when the last returns if a caller
  // waits for one of its mints (`cold`) and the counted minute has room; with only refreshes waiting, JUP_GAP_MS after
  // the last search and while COLD_ROOM stay free; after a search that failed, JUP_GAP_MS after it either way. A mint's
  // row is kept JUP_FRESH_MS from our own read.
  type JupRow = { row: Record<string, unknown> | null; at: number };
  const jrows = bounded<JupRow & { readAt: number }>(CACHE_MAX);
  const waiting = new Map<string, { cold: boolean; ws: { ok: (r: JupRow) => void; fail: (e: Error) => void }[] }>();
  /** When each search in the proxy's counted minute went, oldest first. */
  const sent: number[] = [];
  const SPAN_S = VENDOR_WINDOW_MS / 1000;
  let lastSearch = -Infinity;
  /** When the last search that failed (a 429, an upstream failure) went: the next waits JUP_GAP_MS from it, so callers
   *  asking again after a failure never spend the counted minute on a vendor that is refusing. */
  let lastFailed = -Infinity;
  let searching = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerAt = Infinity;

  /** When the counted minute holds fewer than `cap` searches: now, or when enough of the oldest leave it. */
  function roomAt(cap: number, t: number): number {
    while (sent.length > 0 && Math.floor(sent[0]! / 1000) < Math.floor(t / 1000) - SPAN_S) sent.shift();
    return sent.length < cap ? t : (Math.floor(sent[sent.length - cap]! / 1000) + SPAN_S + 1) * 1000;
  }

  function schedule() {
    if (searching || waiting.size === 0) return;
    const t = now();
    const cold = [...waiting.values()].some((w) => w.cold);
    const at = Math.max(lastFailed + JUP_GAP_MS, cold ? roomAt(SEARCH_PER_SPAN, t) : Math.max(lastSearch + JUP_GAP_MS, roomAt(SEARCH_PER_SPAN - COLD_ROOM, t)));
    if (at - t > SEARCH_WAIT_MAX_MS) {
      // too far off to hold a caller: each answers 429 with the wait; the mints stay for that search
      for (const w of waiting.values()) for (const f of w.ws.splice(0)) f.fail(new Throttled(secondsUntil(at, t), "jupiter search"));
    }
    if (timer !== null && timerAt <= at) return;
    if (timer !== null) clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(() => {
      timer = null;
      timerAt = Infinity;
      // the clock is read again: a timer may fire a little early, and a search sent before its room would be counted
      // by the proxy in the second before
      if (now() < at) schedule();
      else void search();
    }, Math.max(0, at - t));
    // a search waiting for its gap or room never holds the process open alone (the server's listener does)
    if (at > t) timer.unref?.();
  }

  async function search() {
    const keys = [...waiting.keys()];
    // the mints callers wait for first, up to SEARCH_MAX and within the proxy's QUERY_MAX (100 mints of 44 characters
    // are 4.5 KB, past it: the proxy would refuse the whole search 413); the rest go in the next
    const batch: string[] = [];
    let size = "query=".length - 1;
    for (const m of [...keys.filter((k) => waiting.get(k)!.cold), ...keys.filter((k) => !waiting.get(k)!.cold)]) {
      if (batch.length === SEARCH_MAX || size + 1 + m.length > QUERY_MAX) break;
      batch.push(m);
      size += 1 + m.length;
    }
    searching = true;
    lastSearch = now();
    sent.push(lastSearch);
    let rows: unknown = null;
    let at = now();
    let wait = 0;
    let why: string | undefined;
    try {
      const a = await proxy.handle("jupiter", "/tokens/v2/search", `query=${batch.join(",")}`, "", undefined, true); // proxy.ts PROXY_RESERVE
      if (a.status === 429) (wait = retryAfterOf(a.headers)), (why = (a as { why?: string }).why);
      if (a.status === 200) {
        rows = JSON.parse(a.body);
        const t = Date.parse(a.headers["X-Fetched-At"] ?? "");
        if (Number.isFinite(t)) at = t;
      }
    } catch {
      rows = null;
    }
    if (!Array.isArray(rows)) lastFailed = lastSearch;
    for (const mint of batch) {
      const ws = waiting.get(mint)?.ws ?? [];
      waiting.delete(mint);
      if (!Array.isArray(rows)) {
        for (const w of ws) w.fail(wait > 0 ? new Throttled(wait, why) : new Upstream());
        continue;
      }
      const r: JupRow = { row: searchRow(rows, mint), at };
      jrows.set(mint, { ...r, readAt: now() });
      for (const w of ws) w.ok(r);
    }
    searching = false;
    schedule();
  }

  /** `cold`: a caller waits for this row (nothing held is served meanwhile); else a held page's refresh. */
  function jupiter(mint: string, cold: boolean): Promise<JupRow> {
    const hit = jrows.get(mint);
    if (hit !== undefined && now() - hit.readAt < JUP_FRESH_MS) return Promise.resolve(hit);
    return new Promise((ok, fail) => {
      const w = waiting.get(mint);
      if (w !== undefined) (w.ws.push({ ok, fail }), (w.cold ||= cold));
      else waiting.set(mint, { cold, ws: [{ ok, fail }] });
      schedule();
    });
  }

  /** The mint account at a slot, or null when it is not a mint. */
  /** The mint's read, one at a time per mint: a page and its holders opened together (the token screen asks both at
   *  once) share it, so a page open draws one getMultipleAccounts of the public endpoint's 40 a method, not two (card
   *  helper-ready-gate). A call joining one in flight draws nothing, as a cache hit. */
  const mintReads = new Map<string, ReturnType<typeof readMint>>();
  function mintAt(mint: string, client?: string): ReturnType<typeof readMint> {
    let p = mintReads.get(mint);
    if (p === undefined) {
      p = readMint(mint, client).finally(() => mintReads.delete(mint));
      mintReads.set(mint, p);
    }
    return p;
  }
  async function readMint(mint: string, client?: string) {
    const keys = [mint];
    const { result } = await call("getMultipleAccounts", [keys, { encoding: "jsonParsed", commitment: "confirmed" }], rpc, client);
    const value = result.value;
    const slot = obj(result.context).slot;
    if (!Array.isArray(value) || value.length !== keys.length || !Number.isSafeInteger(slot)) throw new Upstream();
    return { mint: toMint(value[0], slot as number), at: now() };
  }

  // Discover's rows (D-S6 reads Jupiter only for tokens off the lists): indexed once per snapshot
  let index: { asOfMs: number; rows: Map<string, Row> } | null = null;
  async function listedRow(mint: string): Promise<{ row: Row; at: number } | null> {
    if (deps.listed === undefined) return null;
    try {
      const a = await deps.listed();
      if (a.status !== 200 || a.asOfMs === undefined) return null;
      if (index?.asOfMs !== a.asOfMs) {
        const rows = new Map<string, Row>();
        for (const list of Object.values(obj(obj(JSON.parse(a.body)).lists))) if (Array.isArray(list)) for (const r of list as Row[]) rows.set(r.token as string, r);
        index = { asOfMs: a.asOfMs, rows };
      }
      const row = index.rows.get(mint);
      return row === undefined ? null : { row, at: a.asOfMs };
    } catch {
      return null;
    }
  }

  /** The token's Row: Discover's when listed, else from Jupiter's search; null when Jupiter does not know it. */
  async function rowOf(mint: string): Promise<{ row: Row; at: number } | null> {
    const listed = await listedRow(mint);
    if (listed !== null) return listed;
    // holders are not served before their read: its caller waits
    const j = await jupiter(mint, true);
    const row = j.row === null ? null : toRow(j.row, j.at);
    return row === null ? null : { row, at: j.at };
  }

  // each token's launch (origin.ts), kept as the lists keep theirs; every read is on the asking caller's share
  const origins = createOrigins(rpcAccounts(rpc, false));

  // The launch: read once per token and its curve on each refresh, on the caller's share (origin.ts), one read per
  // token at a time and never failing the page; the page waits for it at most LAUNCH_WAIT_MS. A page built before its
  // launch was read is served with it once origin.ts holds it (`view`), with no read of its own.
  const launching = new Map<string, Promise<void>>();
  const launch = (mint: string, hint: Hint | undefined, createdS: unknown, client?: string): Promise<void> => {
    let r = launching.get(mint);
    if (r === undefined) {
      r = origins
        .refresh([{ mint, hint, createdS: Number.isSafeInteger(createdS) ? (createdS as number) : null }], now(), rpcAccounts(rpc, false, client))
        .catch(() => undefined)
        .finally(() => launching.delete(mint));
      launching.set(mint, r);
    }
    return r;
  };
  const settled = async (mint: string, r: Promise<void>): Promise<Origin | null | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([r, new Promise<void>((ok) => (timer = setTimeout(ok, LAUNCH_WAIT_MS)))]);
    clearTimeout(timer);
    return origins.get(mint);
  };
  // each token's last page as built, `answer` as the cache keeps it and `filled` once its launch came in after
  type Built = { m: Mint; base: Row; pool: string | null; listed: boolean; chainAt: number; jupAt: number; origin: Origin | null | undefined; answer?: DataAnswer; filled?: DataAnswer };
  const built = bounded<Built>(CACHE_MAX);
  const pageOf = (b: Built): DataAnswer => ({ status: 200, body: JSON.stringify(toPage(b.m, b.base, b.pool, b.origin, b.listed, b.chainAt, b.jupAt)), src: "jupiter", asOfMs: Math.min(b.chainAt, b.jupAt) });

  const page = cached(PAGE_FRESH_MS, now, async (mint, client, _held, waits) => {
    const listed = await listedRow(mint);
    // a Discover row's launch is the lists'; this read finds its pool (the config Jupiter names is not in a row)
    const early = listed === null ? null : launch(mint, { tag: listed.row.launchpad as string | null, config: null, graduated: null }, listed.row.created_s, client);
    const [m, j] = await Promise.all([mintAt(mint, client), listed === null ? jupiter(mint, waits === true) : null]);
    if (m.mint === null) return NOT_FOUND;
    let base: Row | null = listed?.row ?? null;
    let at = listed?.at ?? 0;
    let pool: string | null = null;
    if (j !== null) {
      if (j.row === null) return NOT_FOUND;
      base = toRow(j.row, j.at);
      at = j.at;
      pool = jupiterPool(j.row);
    }
    if (base === null || base.token !== mint) return NOT_FOUND;
    const origin = await settled(mint, early ?? launch(mint, hintsOf([j!.row]).get(mint), base.created_s, client));
    const b: Built = { m: m.mint, base, pool, listed: listed !== null, chainAt: m.at, jupAt: at, origin };
    b.answer = pageOf(b);
    built.set(mint, b);
    return b.answer;
  }, {
    revalidate: true,
    // a page built before its launch was read takes it from origin.ts once there
    view: (mint, a) => {
      const b = built.get(mint);
      if (b === undefined || a !== b.answer) return a;
      if (b.origin === undefined) {
        const o = origins.get(mint);
        if (o === undefined) return a;
        b.origin = o;
        b.filled = pageOf(b);
      }
      return b.filled ?? a;
    },
  });

  const holders = cached(HOLDERS_FRESH_MS, now, async (mint, client) => {
    const m = await mintAt(mint, client);
    if (m.mint === null) return NOT_FOUND;
    try {
      if (deps.holdersRpc === undefined) throw new Upstream();
      const largest = (await call("getTokenLargestAccounts", [mint, { commitment: "confirmed" }], deps.holdersRpc, client)).result.value;
      if (!Array.isArray(largest)) throw new Upstream();
      const accts = largest.slice(0, HOLDERS_MAX).map((r) => address(obj(r).address));
      if (accts.some((a) => a === null)) throw new Upstream();
      const owners = accts.length === 0 ? [] : (await call("getMultipleAccounts", [accts, { encoding: "jsonParsed", commitment: "confirmed" }], deps.holdersRpc, client)).result.value;
      const rows = toHolders(largest.slice(0, HOLDERS_MAX), Array.isArray(owners) ? owners : [], m.mint.supply);
      if (rows === null) throw new Upstream();
      const top = rows.slice(0, 10).reduce((s, h) => s + (h.bps ?? 0), 0);
      const r = await rowOf(mint).catch(() => null);
      const total = (r?.row.holders ?? null) as number | null;
      const at = now();
      const body: Holders = { holders: rows, total, top_bps: rows.length > 0 && m.mint.supply > 0n ? Math.min(10_000, top) : null, src: "chain", as_of_ms: at };
      return { status: 200, body: JSON.stringify(body), src: "chain", asOfMs: at };
    } catch {
      // the fallback (06b v1.36): no rows, Jupiter's holder count and top-holders share
      const r = await rowOf(mint);
      if (r === null) return NOT_FOUND;
      const body: Holders = { holders: [], total: r.row.holders as number | null, top_bps: r.row.top10_bps as number | null, src: "jupiter", as_of_ms: r.at };
      return { status: 200, body: JSON.stringify(body), src: "jupiter", asOfMs: r.at };
    }
  });

  // GeckoTerminal: at most GT_PER_MIN calls a minute, shared by every token, in the "pages" lane of the server's one
  // budget (../gecko.ts) when it passes one, where the lists yield to it; a 429 pauses it. A refused call is a throttle
  // naming the wait to the budget's next free call or the pause's end (card helper-abuse-limits)
  const gt = deps.gecko ?? geckoBudget(now, GT_PER_MIN);
  async function gecko(path: string, lane: "pages" | "refresh" | "ahead" = "pages"): Promise<unknown> {
    // card helper-crowd-429: a caller's cold read (the pages lane) waits for the budget's next free call when it comes
    // within GT_PAGE_WAIT_MS, instead of a 429 (market-data-solana-token at 22:12Z: PUMP 1h answered 429 "geckoterminal
    // budget"); a refresh or an ahead read never waits (the bars held are served meanwhile)
    for (let round = 0; !gt.take(lane); round++) {
      const at = gt.retryAt("pages");
      if (lane !== "pages" || round >= 3 || at - now() > GT_PAGE_WAIT_MS) throw new Throttled(secondsUntil(at, now()), lane === "pages" ? "geckoterminal budget" : `geckoterminal ${lane}`);
      await new Promise((ok) => setTimeout(ok, Math.max(at - now(), 0) + 5));
    }
    const r = await doFetch(`${GT_BASE}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    if (r.status === 429) {
      throw new Throttled(secondsUntil(throttledUntil(gt, r.headers.get("retry-after"), now()), now()), "geckoterminal 429");
    }
    if (r.status === 404) return null;
    if (r.status !== 200 || Number(r.headers.get("content-length") ?? "0") > ANSWER_MAX) throw new Upstream();
    const text = await r.text();
    if (text.length > ANSWER_MAX) throw new Upstream();
    return JSON.parse(text);
  }

  // a held pool's re-read is a refresh: refused, the pool held is served (a token's top pool rarely moves)
  const pools = cached(
    POOL_FRESH_MS,
    now,
    async (mint, _client, held) => {
      const a = await gecko(`/networks/solana/tokens/${mint}`, held === true ? "refresh" : "pages");
      const pool = a === null ? null : topPool(a);
      return pool === null ? NOT_FOUND : { status: 200, body: pool, asOfMs: now() };
    },
    { keepHeld: true },
  );

  /** The last good GeckoTerminal bars per mint and tf: served when a read is throttled or fails, while under GT_SERVE_MS
   *  or for history before their read (an empty chart is never the answer for a token with known history, and an old one
   *  never a 200: the read's 429 or 503, card helper-restart-fresh). */
  const kept = bounded<{ bars: Candle[]; at: number }>(CACHE_MAX);
  // the newest range (no `to`) moves with every trade: CANDLES_FRESH_MS; a range before a time is history: an hour
  // a re-read of bars held is a refresh: refused, candles() serves the kept bars, dated by their read. The newest range
  // is a refresh while its kept bars (a swap's handover included) are under REFRESH_URGENT_MS old, a page read past it,
  // so a chart read now and then is never served the same bars for good (../gecko.ts refreshLane, card
  // helper-chart-fresh); history before a time stays a refresh
  const bars = cached((key) => (key.endsWith(":") ? CANDLES_FRESH_MS : HISTORY_FRESH_MS), now, async (key, _client, held) => {
    const [mint, tf, to] = key.split(":") as [string, Tf, string];
    const lane = to === "" ? refreshLane(kept.get(`${mint}:${tf}`)?.at ?? null, now()) : held === true ? "refresh" : "pages";
    const p = await pools.get(mint);
    if (p.status !== 200) {
      if (p.status === 404) return NOT_FOUND;
      if (p.status === 429) throw new Throttled(p.retryAfterS ?? 1, p.why);
      throw new Upstream();
    }
    const { period, aggregate } = TF[tf];
    const before = to === "" ? "" : `&before_timestamp=${to}`;
    const a = await gecko(`/networks/solana/pools/${p.body}/ohlcv/${period}?aggregate=${aggregate}&limit=1000&currency=usd&token=${mint}${before}`, lane);
    const candles = a === null ? [] : toCandles(a, tf, 1_000, now());
    if (candles === null) throw new Upstream();
    const at = now();
    return { status: 200, body: JSON.stringify(candles), src: "geckoterminal", asOfMs: at };
  });

  const mintKey = (k: string) => address(k) !== null;
  const isPool = (b: string) => address(b) !== null;

  /** The newest charts callers read (`mint:tf` to the read's time), the most recent last (card helper-restart-fresh). */
  const hot = bounded<number>(HOT_MAX);
  /** Keeps `k`'s newest bars in `kept`, unless what is held is newer. */
  const keep = (k: string, got: Candle[], at: number) => {
    const had = kept.get(k);
    if (got.length > 0 && (had === undefined || got.at(-1)![0] >= had.bars.at(-1)![0])) kept.set(k, { bars: got, at });
  };
  /** The Trending tokens kept fresh (TOP_MAX): the list's first row, then Discover's column order's first TOP_MAX. */
  async function topTrending(): Promise<string[]> {
    if (deps.listed === undefined) return [];
    try {
      const a = await deps.listed();
      if (a.status !== 200) return [];
      const l = obj(obj(JSON.parse(a.body)).lists);
      const rows = (Array.isArray(l.trending_1h) ? l.trending_1h : Array.isArray(l.trending) ? l.trending : []).slice(0, 200).map(obj);
      const vol = (r: Record<string, unknown>) => (typeof r.vol_1h_usd === "string" && /^\d+(\.\d+)?$/.test(r.vol_1h_usd) ? Number(r.vol_1h_usd) : 0);
      const seen = new Set<string>();
      const column = rows.filter((r) => typeof r.token === "string" && !seen.has(r.token) && (seen.add(r.token), true)).filter((r) => vol(r) > 0).sort((x, y) => vol(y) - vol(x));
      const out = [rows[0], ...column.slice(0, TOP_MAX)].map((r) => address(r?.token)).filter((m): m is string => m !== null);
      return [...new Set(out)];
    } catch {
      return [];
    }
  }
  /** When the ahead lane last read a chart, whatever it got: a chart GeckoTerminal answers with no bars, or fails, waits
   *  its AHEAD_MS like the rest and never holds the others back. */
  const tried = bounded<number>(HOT_MAX * 4);
  /** The newest a chart is held or was tried ahead. */
  const lastAhead = (k: string) => Math.max(kept.get(k)?.at ?? -Infinity, tried.get(k) ?? -Infinity);
  let aheadBusy = false;

  return {
    /**
     * One re-read ahead (card helper-restart-fresh, AHEAD_MS): of the charts callers read in the last HOT_MS and the
     * Trending tokens' AHEAD_TF charts (TOP_MAX), the one whose newest bars held are oldest, once they are AHEAD_MS old (or none is
     * held), is read in GeckoTerminal's "ahead" lane: its top pool when none is held, else its bars. At most one call;
     * refused by the budget, nothing is read. Returns the key read, or null.
     */
    async ahead(): Promise<string | null> {
      if (aheadBusy) return null;
      aheadBusy = true;
      try {
        const t = now();
        // the callers' charts, and the Trending ones as the lists stand now, each once
        const asked = new Map<string, number>([...hot.entries(), ...(await topTrending()).map((m): [string, number] => [`${m}:${AHEAD_TF}`, t])]);
        const [k] = [...asked]
          // a token GeckoTerminal names no pool for is left to its callers' reads
          .filter(([key, readAt]) => t - readAt <= HOT_MS && t - lastAhead(key) >= AHEAD_MS && (pools.peek(key.split(":")[0]!)?.status ?? 200) === 200)
          .sort(([a], [b]) => lastAhead(a) - lastAhead(b))[0] ?? [];
        if (k === undefined) return null;
        const [mint, tf] = k.split(":") as [string, Tf];
        const pool = pools.peek(mint);
        try {
          if (pool === undefined) {
            const a = await gecko(`/networks/solana/tokens/${mint}`, "ahead");
            const p = a === null ? null : topPool(a);
            pools.put(mint, p === null ? NOT_FOUND : { status: 200, body: p, asOfMs: now() });
            return k;
          }
          const { period, aggregate } = TF[tf];
          const a = await gecko(`/networks/solana/pools/${pool.body}/ohlcv/${period}?aggregate=${aggregate}&limit=1000&currency=usd&token=${mint}`, "ahead");
          tried.set(k, now());
          const got = a === null ? [] : toCandles(a, tf, 1_000, now());
          if (got !== null) keep(k, got, now());
          return k;
        } catch (e) {
          // refused by the budget: no call made, the next tick asks again; a failed call waits its AHEAD_MS
          if (!(e instanceof Throttled)) tried.set(k, now());
          return null;
        }
      } finally {
        aheadBusy = false;
      }
    },
    /**
     * The answers this process holds, as the next one takes them over (card app-console-429): a deploy's new helper
     * starts with the pages, holders, top pools and last good bars the old one was serving, so the first loads after a
     * swap are answered as the old helper would have answered them, under the same freshness rules, instead of all
     * going upstream at once into a GeckoTerminal budget the old helper spent. Newest first within HANDOVER_MAX bytes.
     */
    state(): { page: [string, Kept][]; holders: [string, Kept][]; pools: [string, Kept][]; kept: [string, { bars: Candle[]; at: number }][]; hot: [string, number][] } {
      let room = HANDOVER_MAX;
      const fit = <T>(list: [string, T][]): [string, T][] => {
        const out: [string, T][] = [];
        for (let i = list.length - 1; i >= 0; i--) {
          const n = JSON.stringify(list[i]).length;
          if (n > room) break;
          room -= n;
          out.unshift(list[i]!);
        }
        return out;
      };
      const t = now();
      return {
        page: fit(page.state()),
        holders: fit(holders.state()),
        pools: fit(pools.state()),
        kept: fit(kept.entries().filter(([, v]) => t - v.at <= KEPT_HANDOVER_MS)),
        // the charts kept fresh ahead, so the next helper goes on keeping them fresh (card helper-restart-fresh)
        hot: hot.entries().filter(([, at]) => t - at <= HOT_MS),
      };
    },
    /** A previous process's state (data/warm.ts, hostile input): every entry checked as an answer of ours would be. */
    restore(st: unknown): void {
      const o = (typeof st === "object" && st !== null ? st : {}) as Record<string, unknown>;
      page.restore(o.page, mintKey, isObjectBody);
      holders.restore(o.holders, mintKey, isObjectBody);
      pools.restore(o.pools, mintKey, isPool);
      const t = now();
      // the charts kept fresh ahead: `mint:tf` and a read time within HOT_MS, never ahead of now
      if (Array.isArray(o.hot))
        for (const e of o.hot.slice(-HOT_MAX)) {
          if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string" || typeof e[1] !== "number" || !Number.isFinite(e[1]) || e[1] > t || t - e[1] > HOT_MS) continue;
          const [mint, tf, more] = e[0].split(":");
          if (more !== undefined || !mintKey(mint!) || !Object.hasOwn(TF, tf ?? "")) continue;
          if ((hot.get(e[0]) ?? -Infinity) < e[1]) hot.set(e[0], e[1]);
        }
      if (!Array.isArray(o.kept)) return;
      for (const e of o.kept.slice(-CACHE_MAX)) {
        if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string") continue;
        const [mint, tf, more] = e[0].split(":");
        const v = e[1] as { bars?: unknown; at?: unknown } | null;
        if (more !== undefined || !mintKey(mint!) || !Object.hasOwn(TF, tf ?? "") || typeof v !== "object" || v === null) continue;
        if (typeof v.at !== "number" || !Number.isFinite(v.at) || v.at > t || t - v.at > KEPT_HANDOVER_MS || !isBars(v.bars) || v.bars.length === 0) continue;
        const had = kept.get(e[0]);
        if (had === undefined || had.at < v.at) kept.set(e[0], { bars: v.bars, at: v.at });
      }
    },
    /** 06b TokenPage for a Solana mint: 404 when it is no mint or Jupiter does not list it, 503 on an upstream failure. */
    page: (mint: string, client?: string) => (address(mint) === null ? Promise.resolve(NOT_FOUND) : page.get(mint, client)),
    /** 06b Holders (20 rows, merged per owner), or Jupiter's fallback. */
    holders: (mint: string, client?: string) => (address(mint) === null ? Promise.resolve(NOT_FOUND) : holders.get(mint, client)),
    /** 06b Candles: up to `limit` bars of `tf` ending before `to` (unix seconds) when it is set. */
    async candles(mint: string, tf: string, to: number | null, limit: number): Promise<DataAnswer> {
      if (address(mint) === null || !Object.hasOwn(TF, tf)) return NOT_FOUND;
      const k = `${mint}:${tf}`;
      // a caller's read of the newest range: the chart is kept fresh ahead of its next read (ahead)
      if (to === null) hot.set(k, now());
      let a = await bars.get(`${mint}:${tf}:${to ?? ""}`);
      if (a.status === 200) {
        // the last good bars of this mint and tf (the newest range read), whatever range was asked
        keep(k, JSON.parse(a.body) as Candle[], a.asOfMs!);
      } else if (a.status === 429 || a.status === 503) {
        // GeckoTerminal throttled or down: its last good bars, cut at `to`, read time theirs, while they are within
        // GT_SERVE_MS or the range is history before their read; past it the 429 or 503, never a 200 with old bars (card
        // helper-restart-fresh); nothing kept keeps the error
        const had = kept.get(k);
        const servable = had !== undefined && ((to !== null && to * 1000 <= had.at) || now() - had.at <= GT_SERVE_MS);
        const cut = !servable ? [] : had.bars.filter((c) => to === null || c[0] < to);
        if (cut.length > 0) a = { status: 200, body: JSON.stringify(cut), src: "geckoterminal", asOfMs: had!.at };
      }
      if (a.status !== 200) return a;
      const body: Candles = { tf: tf as Tf, candles: (JSON.parse(a.body) as Candle[]).slice(-limit), src: "geckoterminal", as_of_ms: a.asOfMs! };
      return { status: 200, body: JSON.stringify(body), src: "geckoterminal", asOfMs: a.asOfMs };
    },
  };
}
