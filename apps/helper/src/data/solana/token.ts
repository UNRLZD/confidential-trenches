// GET /v1/market/token, /v1/market/holders and /v1/market/candles with chain=solana: the token page's Solana reads
// (markets paper M4.2 and D1.1 rows D-S6, D-S7, D-S11 and D-S12; the field lists frozen with the app's screens). The
// answers are 06b §6.1's `TokenPage`, `Holders` and `Candles` (docs/spec/06b-wallet-webapp.md:1729-1749), with the
// page's `row` the same `Row` Discover reads (lists.ts toRow, apps/terminal/src/screens/discover/fields.ts).
//
// Sources:
//   - page: one `getMultipleAccounts` (jsonParsed) of the mint and its pump.fun curve account through the helper's RPC
//     path (src/rpc/), and the token's row: Discover's own row when the token is on the lists (lists.ts), else Jupiter's
//     `/tokens/v2/search` through the helper's proxy (src/proxy/), batched up to 100 mints a call and at most one call
//     every JUP_GAP_MS (D-S6), at once. The mint account gives decimals, the mint and freeze authorities and the
//     Token-2022 transfer fee (Risk `tax`); the curve account gives `curve_bps` and `lp: curve` while on its curve.
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
import { geckoBudget, GT_LIMIT_PER_MIN, throttledUntil, type GeckoBudget } from "../gecko.ts";
import { retryAfterOf, secondsUntil, Throttled } from "../../limits/limits.ts";

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
/** History before a given time (a read with `to`: the bars before our own first bar, or a range scrolled back) never
 *  changes: kept an hour, as the EVM chains keep theirs (../evm/swaps.ts GT_FRESH_MS) (card app-console-429). */
export const HISTORY_FRESH_MS = 3_600_000;
export const POOL_FRESH_MS = 600_000;
/** L-05: GeckoTerminal's public API, as measured (../gecko.ts GT_LIMIT_PER_MIN); the server shares one budget with the
 *  EVM lists, which yield to the token page. */
export const GT_PER_MIN = GT_LIMIT_PER_MIN;
export const GT_BASE = "https://api.geckoterminal.com/api/v2";
/** D-S6: Jupiter's search reads up to 100 mints a call; a mint's row is read again after 12 s. One search at most every
 *  JUP_GAP_MS: with the lists' 3 calls per 12 s that is at most 30 a minute, half the keyed free bucket (L-01: 1 RPS,
 *  one bucket shared with the swap build), so a busy token page never starves a trade's build. */
export const SEARCH_MAX = 100;
export const JUP_FRESH_MS = 12_000;
export const JUP_GAP_MS = 4_000;
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
/** The last good bars handed over are at most this old [design: an hour; a helper down longer reads them again]. */
export const KEPT_HANDOVER_MS = 3_600_000;

/** A read cached per key: fresh within `freshMs` of our own read; a failed refresh serves the last good one while its
 *  data is under STALE_MS old; one read per key at a time. `client`, the caller whose request makes the read, draws
 *  its share of the provider's budget for it (card helper-abuse-limits); a hit or a call joining one in flight draws
 *  nothing. `read` answers null for "no such token" and throws for an
 *  upstream failure. `opts.revalidate`: a good answer past `freshMs` whose data is under STALE_MS old is answered at
 *  once while one refresh runs, so a caller never waits on a slow upstream for what it was just served. `opts.view`:
 *  every kept answer as served (the token page fills a launch read since). */
function cached(freshMs: number | ((key: string) => number), now: () => number, read: (key: string, client?: string) => Promise<DataAnswer>, opts: { revalidate?: boolean; view?: (key: string, a: DataAnswer) => DataAnswer } = {}) {
  const view = (key: string, a: DataAnswer) => (opts.view === undefined ? a : opts.view(key, a));
  const last = bounded<{ a: DataAnswer; at: number }>(CACHE_MAX);
  const running = new Map<string, Promise<DataAnswer>>();
  return {
    size: last.size,
    /** Its good answers whose data is under STALE_MS old, newest last: what the next process serves (card
     *  app-console-429). */
    state: (): [string, Kept][] =>
      last
        .entries()
        .filter(([, v]) => v.a.status === 200 && now() - (v.a.asOfMs ?? v.at) <= STALE_MS)
        .map(([k, v]) => [k, { at: v.at, body: v.a.body, asOfMs: v.a.asOfMs ?? v.at, ...(v.a.src === undefined ? {} : { src: v.a.src }) }]),
    /** A previous process's answers: each kept when its key passes `key` and it is newer than what this one holds. */
    restore(entries: unknown, key: (k: string) => boolean, body: (b: string) => boolean): void {
      if (!Array.isArray(entries)) return;
      const t = now();
      for (const e of entries.slice(-CACHE_MAX)) {
        if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string" || !key(e[0])) continue;
        const v = keptOf(e[1], t, STALE_MS, body);
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
        p = read(key, client)
          .then((a) => {
            if (a.status === 200 || a.status === 404) last.set(key, { a, at: started });
            return a;
          })
          .catch((e) => (hit !== undefined && hit.a.status === 200 && now() - (hit.a.asOfMs ?? hit.at) <= STALE_MS ? hit.a : e instanceof Throttled ? limited(e.retryAfterS, e.why) : UPSTREAM))
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

  // Jupiter's search, batched (D-S6): every mint asked while a search is out or within JUP_GAP_MS of the last joins
  // one call of up to SEARCH_MAX mints, so this part's Jupiter calls stay at most 60 / JUP_GAP_MS s a minute whatever
  // the number of pages open; a mint's row is kept JUP_FRESH_MS from our own read.
  type JupRow = { row: Record<string, unknown> | null; at: number };
  const jrows = bounded<JupRow & { readAt: number }>(CACHE_MAX);
  const waiting = new Map<string, { ok: (r: JupRow) => void; fail: (e: Error) => void }[]>();
  let lastSearch = -Infinity;
  let searching = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule() {
    if (searching || timer !== null || waiting.size === 0) return;
    timer = setTimeout(() => void search(), Math.max(0, lastSearch + JUP_GAP_MS - now()));
  }

  async function search() {
    timer = null;
    const batch = [...waiting.keys()].slice(0, SEARCH_MAX);
    searching = true;
    lastSearch = now();
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
    for (const mint of batch) {
      const ws = waiting.get(mint) ?? [];
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

  function jupiter(mint: string): Promise<JupRow> {
    const hit = jrows.get(mint);
    if (hit !== undefined && now() - hit.readAt < JUP_FRESH_MS) return Promise.resolve(hit);
    return new Promise((ok, fail) => {
      const ws = waiting.get(mint);
      if (ws !== undefined) ws.push({ ok, fail });
      else waiting.set(mint, [{ ok, fail }]);
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
    const j = await jupiter(mint);
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

  const page = cached(PAGE_FRESH_MS, now, async (mint, client) => {
    const listed = await listedRow(mint);
    // a Discover row's launch is the lists'; this read finds its pool (the config Jupiter names is not in a row)
    const early = listed === null ? null : launch(mint, { tag: listed.row.launchpad as string | null, config: null, graduated: null }, listed.row.created_s, client);
    const [m, j] = await Promise.all([mintAt(mint, client), listed === null ? jupiter(mint) : null]);
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
  async function gecko(path: string): Promise<unknown> {
    if (!gt.take("pages")) throw new Throttled(secondsUntil(gt.retryAt("pages"), now()), "geckoterminal budget");
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

  const pools = cached(POOL_FRESH_MS, now, async (mint) => {
    const a = await gecko(`/networks/solana/tokens/${mint}`);
    const pool = a === null ? null : topPool(a);
    return pool === null ? NOT_FOUND : { status: 200, body: pool, asOfMs: now() };
  });

  /** The last good GeckoTerminal bars per mint and tf: served when a read is throttled or fails (an empty chart is never
   *  the answer for a token with known history). */
  const kept = bounded<{ bars: Candle[]; at: number }>(CACHE_MAX);
  // the newest range (no `to`) moves with every trade: CANDLES_FRESH_MS; a range before a time is history: an hour
  const bars = cached((key) => (key.endsWith(":") ? CANDLES_FRESH_MS : HISTORY_FRESH_MS), now, async (key) => {
    const [mint, tf, to] = key.split(":") as [string, Tf, string];
    const p = await pools.get(mint);
    if (p.status !== 200) {
      if (p.status === 404) return NOT_FOUND;
      if (p.status === 429) throw new Throttled(p.retryAfterS ?? 1, p.why);
      throw new Upstream();
    }
    const { period, aggregate } = TF[tf];
    const before = to === "" ? "" : `&before_timestamp=${to}`;
    const a = await gecko(`/networks/solana/pools/${p.body}/ohlcv/${period}?aggregate=${aggregate}&limit=1000&currency=usd&token=${mint}${before}`);
    const candles = a === null ? [] : toCandles(a, tf, 1_000, now());
    if (candles === null) throw new Upstream();
    const at = now();
    return { status: 200, body: JSON.stringify(candles), src: "geckoterminal", asOfMs: at };
  });

  const mintKey = (k: string) => address(k) !== null;
  const isPool = (b: string) => address(b) !== null;

  return {
    /**
     * The answers this process holds, as the next one takes them over (card app-console-429): a deploy's new helper
     * starts with the pages, holders, top pools and last good bars the old one was serving, so the first loads after a
     * swap are answered as the old helper would have answered them, under the same freshness rules, instead of all
     * going upstream at once into a GeckoTerminal budget the old helper spent. Newest first within HANDOVER_MAX bytes.
     */
    state(): { page: [string, Kept][]; holders: [string, Kept][]; pools: [string, Kept][]; kept: [string, { bars: Candle[]; at: number }][] } {
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
      };
    },
    /** A previous process's state (data/warm.ts, hostile input): every entry checked as an answer of ours would be. */
    restore(st: unknown): void {
      const o = (typeof st === "object" && st !== null ? st : {}) as Record<string, unknown>;
      page.restore(o.page, mintKey, isObjectBody);
      holders.restore(o.holders, mintKey, isObjectBody);
      pools.restore(o.pools, mintKey, isPool);
      if (!Array.isArray(o.kept)) return;
      const t = now();
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
      let a = await bars.get(`${mint}:${tf}:${to ?? ""}`);
      const k = `${mint}:${tf}`;
      if (a.status === 200) {
        // the last good bars of this mint and tf (the newest range read), whatever range was asked
        const got = JSON.parse(a.body) as Candle[];
        const had = kept.get(k);
        if (got.length > 0 && (had === undefined || got.at(-1)![0] >= had.bars.at(-1)![0])) kept.set(k, { bars: got, at: a.asOfMs! });
      } else if (a.status === 429 || a.status === 503) {
        // GeckoTerminal throttled or down: its last good bars, cut at `to`, read time theirs; nothing kept keeps the error
        const had = kept.get(k);
        const cut = had === undefined ? [] : had.bars.filter((c) => to === null || c[0] < to);
        if (cut.length > 0) a = { status: 200, body: JSON.stringify(cut), src: "geckoterminal", asOfMs: had!.at };
      }
      if (a.status !== 200) return a;
      const body: Candles = { tf: tf as Tf, candles: (JSON.parse(a.body) as Candle[]).slice(-limit), src: "geckoterminal", as_of_ms: a.asOfMs! };
      return { status: 200, body: JSON.stringify(body), src: "geckoterminal", asOfMs: a.asOfMs };
    },
  };
}
