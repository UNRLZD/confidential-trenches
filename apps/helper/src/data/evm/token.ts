// GET /v1/market/token and /v1/market/holders with chain=base or chain=robinhood: the token page's EVM reads, in the
// Solana path's frozen fields (../solana/token.ts PAGE_FIELDS, RISK_FIELDS and HOLDERS_FIELDS; 06b `TokenPage` and
// `Holders`, docs/spec/06b-wallet-webapp.md:1729-1749). Card market-data-evm-token.
//
// Sources:
//   - the row: Discover's own row for the token (lists.ts), the one its lists answer held, with the launchpad its
//     maker read tagged on chain and the chain it is listed on, for a token the chain's lists served (lists.ts listed);
//     any other token's row is DexScreener's (named.ts, card evm-token-page-opens-any-coin: a coin opened from a search,
//     a shared link or a position held after it left trending), its launchpad the same maker read (lists.ts maker),
//     waited for beside the info, both within INFO_WAIT_MS of the request's start. 404 only for an address DexScreener
//     names no pool for (a typo, a wallet); 503 while it cannot be read. The candles and the tape share the gate
//     (server.ts evmKnown).
//   - decimals, the holder count, the top 10 share and the token's links: CoinGecko's keyed on-chain
//     `/onchain/networks/{network}/tokens/{address}/info` (../coingecko.ts, the key the charts read first with), the same
//     answer GeckoTerminal's keyless v2 path gives (docs.coingecko.com/reference/token-info-contract-address.md, read
//     2026-11-18 09:50Z: `holders` {count, distribution_percentage, last_updated}, Base `base` and Robinhood `robinhood`
//     among its holders networks), one call a token, fresh INFO_FRESH_MS, on the key's own pace. Never GeckoTerminal's
//     keyless window (card evm-token-page-off-the-5-call-window): 5 calls in 75 s for the whole helper (../gecko.ts),
//     the lists' and ahead reads holding 3 of them, so of 50 users opening 50 coins at once 2 had a count, first and a
//     minute later (token-load.test.ts at ff65a0403); the window is the charts'. Blockscout was read for the count
//     instead, 2026-11-18 09:45Z: base.blockscout.com and robinhoodchain.blockscout.com answered a Cloudflare challenge
//     (403) to the v2 and the /api paths, api.blockscout.com 402 "Proceed with API key", and the helper holds no
//     Blockscout key. A first read (nothing held, or held past INFO_SERVE_MS) is a caller's; a held one's re-read is
//     background (limits.ts CALLER_ROOM), the held count served, dated by its read, while under INFO_SERVE_MS (card
//     market-data-evm-capacity). A first read the key could not answer (its minute or day spent, CoinGecko down, no key
//     set) is chased in the background (CHASE_TICK_MS, CHASE_PER_TICK, CHASE_TRIES), so a holders tab's next
//     poll (a minute) has the count; one that never answers is not read again for INFO_FRESH_MS. The page waits for a
//     first read at most INFO_WAIT_MS and is otherwise answered with those fields null, the read held for the next.
//   - pool and decimals on chain: the token's main pool and decimals the swap reads already found and checked on two
//     providers (swaps.ts mainPool), when they hold them; nothing is read for the page.
//   - holder rows: none (`holders: []`), as the Solana path answers with no holders provider. No keyless source lists
//     an EVM token's holders from the helper: Blockscout's instance API answered a Cloudflare challenge (403) and its
//     PRO API asks for a key (402), both read 2026-11-09 01:50Z.
// A field no source here reads is null with src "none" (06b `Field`): mint and freeze authority, LP, dev, snipers,
// tax, honeypot (06b:1818 names the chain round trip of 06c §4.10 for EVM, not built), insiders, bundlers, fresh.
//
// Display only: nothing here feeds a signature. CoinGecko's answer is hostile input: used only when it names this
// token, every number checked finite and in range or null; the caches hold at most CACHE_MAX tokens each.
import type { Row } from "../solana/lists.ts";
import type { ListsAnswer } from "../solana/lists.ts";
import { CACHE_MAX, NOT_FOUND, RISK_FIELDS, UPSTREAM, type DataAnswer, type Field } from "../solana/token.ts";
import { CG_SRC, type Keyed } from "../coingecko.ts";
import { evmAddress, GT_NETWORK, type EvmChain } from "./lists.ts";
import { LINKS, linksOf, type Links } from "../links.ts";
import type { EvmNamed } from "./named.ts";
import type { ContractRisk, GoPlus } from "../goplus.ts";

/** A token's info is read again once this old [design: the holder count moves slowly (GeckoTerminal's own
 *  `last_updated`, which CoinGecko's on-chain info serves, was 1-3 min behind its read, 2026-11-09 01:50Z); 5 min keeps
 *  a page's holders current to the minute at one call a token, and a holders tab polling each minute
 *  (apps/terminal/src/screens/token/lower.ts HOLDERS_POLL_MS) spends a fifth of a call a minute of the key's day]. */
export const INFO_FRESH_MS = 300_000;
/** A held info serves, dated by its own read (`as_of_ms`, X-Fetched-At), this long; past it the token is read as one
 *  nobody holds [design (card market-data-evm-capacity): the holder count and top 10 share are display data that move
 *  slowly; an hour keeps every token opened in the last hour answering with its count while the key's minute or day
 *  is spent, and the count's age is on the answer; the live check's own runs are an hour apart]. */
export const INFO_SERVE_MS = 3_600_000;
/** The longest a page waits for a token's first info read [design: GeckoTerminal answered the info in 0.38-0.58 s from
 *  a Mac, 2026-11-09 01:52Z, the answer CoinGecko's on-chain path serves; 700 ms keeps the page inside its 1 s with that
 *  read, and a later answer is held for the next read]. */
export const INFO_WAIT_MS = 700;
/** A first read the key could not answer is chased in the background: each CHASE_TICK_MS the first CHASE_PER_TICK
 *  tokens waiting are read, a miss going to the back, at most CHASE_TRIES misses a token [design: the key's pace
 *  (../coingecko.ts coingeckoPace) refuses a read past its room with no call, so a tick asks for more than the least
 *  key's refill and takes what the pace gives: at 100 calls a minute, the least a CoinGecko key gets
 *  (docs.coingecko.com/docs/errors-and-rate-limits, read 2026-11-18 09:52Z: "Demo plan: 100 calls/min"), the pace's 9
 *  at once and 1.35 a second after, less the quarter background leaves callers (limits.ts CALLER_ROOM), cover 50 coins
 *  opened at once before the holders tab's next poll a minute later (token-load.test.ts: 50 of 50 at 2 a tick and 6 or
 *  8 tries, 49 at 5 tries, 44 at 3 a tick; reads at 1, 2, 4 ... 32 s left 28, a bucket refilled past its burst between
 *  them losing that refill). 8 for room; a token CoinGecko never answers costs at most CHASE_TRIES + 1 calls an
 *  INFO_FRESH_MS]. */
export const CHASE_TICK_MS = 1_000;
export const CHASE_PER_TICK = 2;
export const CHASE_TRIES = 8;
/** The most tokens chased at once [design: a chased token passed rowOf (a lists row or DexScreener's name, on
 *  DexScreener's per-caller share), so a stranger's addresses reach it only at that share; past it a read is not chased
 *  and the next request asks again]. */
export const CHASE_MAX = 256;
const DECIMALS_MAX = 30;
const DECIMAL = /^\d{1,3}(\.\d{1,20})?$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;

/** What the token's on-chain info says of it, each value null when it names none or a bad one; `asOfMs`: its holders'
 *  `last_updated`, else our read's time. */
export type Info = { decimals: number | null; holders: number | null; top10Bps: number | null; asOfMs: number };
/** An info read's end: the info, or "missed" (the key could not answer it). "none" is only a previous helper's held
 *  entry (data/warm.ts), from when GeckoTerminal's 404 named a token it did not know. */
type Read = Info | "missed";
export type EvmTokenPage = { row: Row; decimals: number | null; pool: string | null; risk: Record<(typeof RISK_FIELDS)[number], Field<unknown>>; route: "unknown"; filling: false; links: Links };

/** The token's own links in GeckoTerminal's info (card token-page-data-complete-and-fast): its first website, its X
 *  and Telegram handles as their pages, each checked (../links.ts). */
export function infoLinks(answer: unknown): Links {
  const a = obj(obj(obj(answer).data).attributes);
  const handle = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_]{1,64}$/.test(v) ? v : null);
  const x = handle(a.twitter_handle);
  const t = handle(a.telegram_handle);
  return linksOf(Array.isArray(a.websites) ? a.websites[0] : undefined, x === null ? undefined : `https://x.com/${x}`, t === null ? undefined : `https://t.me/${t}`);
}

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

/** The TokenPage from the token's Discover row, its on-chain info (null when none is held) and the pool and decimals
 *  the swap reads hold. */
export function toPage(base: Row, info: Info | null, kept: { pool: string; decimals: number } | undefined, risk: ContractRisk | null = null): EvmTokenPage {
  const row: Row = { ...base };
  if (info !== null) {
    row.holders = info.holders;
    row.top10_bps = info.top10Bps;
  }
  const rowAt = row.as_of_ms as number;
  const none = (): Field<never> => ({ v: null, src: "none", as_of_ms: rowAt });
  // the row's own values (liquidity, age) carry the row's source: the lists' GeckoTerminal read or DexScreener's
  const own = <T>(v: T | null): Field<T> => ({ v, src: typeof row.src === "string" && row.src !== "" ? row.src : "geckoterminal", as_of_ms: rowAt });
  // card every-cell-shows-a-value: the contract's own checks from GoPlus (../goplus.ts), and its holders count and top
  // 10 where the on-chain info has none
  const gp = <T>(v: T | null | undefined): Field<T> => (risk === null || v === null || v === undefined ? none() : { v, src: "goplus", as_of_ms: risk.as_of_ms });
  const cgOr = <T>(v: T | null | undefined, alt: T | null | undefined): Field<T> => (info !== null && v !== null && v !== undefined ? { v, src: CG_SRC, as_of_ms: info.asOfMs } : gp(alt));
  const created = row.created_s as number | null;
  return {
    row,
    decimals: kept?.decimals ?? info?.decimals ?? null,
    pool: kept?.pool ?? null,
    risk: {
      mint_auth: gp(risk?.mint_auth),
      freeze_auth: gp(risk?.freeze_auth),
      lp: none(),
      top10_bps: cgOr(info?.top10Bps, risk?.top10_bps),
      dev_bps: gp(risk?.dev_bps),
      snipers_bps: none(),
      holders: cgOr(info?.holders, risk?.holders),
      liq_usd: own(row.liq_usd),
      // the row's time is its pool's, made with the token by every listed launchpad (lists.ts)
      age_s: own(created === null ? null : Math.max(0, Math.floor(rowAt / 1000) - created)),
      tax: gp(risk?.tax),
      honeypot: gp(risk?.honeypot),
      insiders_bps: none(),
      bundlers_bps: none(),
      fresh_bps: none(),
    },
    // whether a token routes is the device's own read at the quote, never the data part's call
    route: "unknown",
    filling: false,
    links: LINKS.of(String(base.chain), String(base.token)),
  };
}

/** The most tokens' info a process hands the next one (data/warm.ts), newest first [design: CACHE_MAX, the map's own
 *  bound; an info is under 200 bytes]. */
export const INFO_HANDOVER_MAX = CACHE_MAX;
const isCount = (v: unknown, max: number): boolean => v === null || (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max);
/** An info as toInfo makes one for a read started at `at`: every value in its range, its time not ahead of `nowMs` (its
 *  read's end) and at most a day before the read, as toInfo takes it. */
const isInfo = (v: unknown, at: number, nowMs: number): v is Info => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const i = v as Record<string, unknown>;
  return Object.keys(i).length === 4 && isCount(i.decimals, DECIMALS_MAX) && isCount(i.holders, Number.MAX_SAFE_INTEGER) && isCount(i.top10Bps, 10_000) && typeof i.asOfMs === "number" && Number.isFinite(i.asOfMs) && i.asOfMs <= nowMs && at - i.asOfMs <= 86_400_000;
};

/** A map that keeps at most `max` keys, dropping the oldest written. */
function bounded<V>(max: number) {
  const m = new Map<string, V>();
  return {
    entries: () => [...m],
    get: (k: string) => m.get(k),
    set(k: string, v: V) {
      m.delete(k);
      m.set(k, v);
      while (m.size > max) m.delete(m.keys().next().value!);
    },
  };
}

/** One EVM chain's token page and holders. `lists`: the chain's Discover lists (lists.ts get and listed); `kept`: the
 *  swap reads' pool and decimals for a token, when held (swaps.ts kept); `keyed`: CoinGecko's keyed reads
 *  (../coingecko.ts createKeyed), null or absent when no key is set (no count, src "none"); `later`: runs a chase. */
export function createEvmToken(
  chain: EvmChain,
  deps: { lists: { get(): Promise<ListsAnswer>; listed(token: string): Promise<boolean>; maker?(token: string, createdS: number): Promise<string | null | undefined> }; named?: Pick<EvmNamed, "named">; keyed?: Pick<Keyed, "read"> | null; kept?: (token: string) => { pool: string; decimals: number } | undefined; now?: () => number; later?: (fn: () => void, ms: number) => void; goplus?: Pick<GoPlus, "risk"> },
) {
  const now = deps.now ?? Date.now;
  const later = deps.later ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms).unref());
  const rows = bounded<Row>(CACHE_MAX);
  let seen: string | undefined;
  const infos = bounded<{ info: Info | "none"; at: number }>(CACHE_MAX);
  const running = new Map<string, Promise<Read>>();
  /** The tokens being chased, and when each chase that never got an answer ended (not read again for INFO_FRESH_MS). */
  const chasing = new Set<string>();
  const queue: { token: string; tries: number }[] = [];
  let ticking = false;
  const missed = bounded<number>(CACHE_MAX);

  /** The token's row from the lists' newest answer, else the last one an answer held, while the lists still count it
   *  served; null for a token they never served; undefined while the lists have never answered. */
  async function listedRow(token: string): Promise<Row | null | undefined> {
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

  /** The token's listed row, else its DexScreener row (`named`, with the launchpad wait it needs); null for an address no
   *  source names; undefined when neither could answer. Without `named` deps (tests of the lists alone) a token the
   *  lists never served is null, as before. */
  async function rowOf(token: string, client?: string): Promise<{ row: Row; maker?: Promise<string | null | undefined> } | null | undefined> {
    const listed = await listedRow(token);
    if (listed !== null && listed !== undefined) return { row: listed };
    if (deps.named === undefined) return listed;
    const n = await deps.named.named(token, client);
    if (n === "unread") return undefined;
    if (n === null) return null;
    const created = n.row.created_s;
    return { row: n.row, maker: typeof created === "number" ? deps.lists.maker?.(token, created) : undefined };
  }
  /** The row with its launchpad, when its maker read answers within `waitMs` (lists.ts maker keeps it). */
  async function tagged(r: { row: Row; maker?: Promise<string | null | undefined> }, waitMs: number): Promise<Row> {
    if (r.maker === undefined) return r.row;
    const pad = await within(r.maker.catch(() => undefined), waitMs);
    return typeof pad === "string" ? { ...r.row, launchpad: pad } : r.row;
  }

  /** One keyed info read: "missed" when the key could not answer it (../coingecko.ts Keyed.read: its minute or day
   *  spent, held after CoinGecko refused or failed, or an answer that does not name this token). `background`: a held
   *  info's re-read or a chase, which leaves callers their room. */
  async function readInfo(token: string, background: boolean): Promise<Read> {
    const keyed = deps.keyed;
    if (keyed === undefined || keyed === null) return "missed";
    const got: { info: Info | null } = { info: null };
    const j = await keyed.read(`/networks/${GT_NETWORK[chain]}/tokens/${token}/info`, (x) => (got.info = toInfo(token, x, now())) !== null, background);
    if (j === undefined || got.info === null) return "missed";
    LINKS.remember(chain, token, infoLinks(j));
    return got.info;
  }

  /** The token's read, one at a time: the page, holders and a chase share it, so any one's read serves the others. */
  function start(token: string, background: boolean): Promise<Read> {
    let p = running.get(token);
    if (p === undefined) {
      const started = now();
      p = readInfo(token, background)
        .then((x) => {
          if (x !== "missed") infos.set(token, { info: x, at: started });
          return x;
        })
        .finally(() => running.delete(token));
      running.set(token, p);
    }
    return p;
  }

  /** A first read the key missed, queued: each CHASE_TICK_MS the first CHASE_PER_TICK are read in the background, a miss
   *  going to the back, CHASE_TRIES misses a token at most; one that never answers is marked missed, not read again for
   *  INFO_FRESH_MS. */
  function chase(token: string): void {
    if (chasing.has(token) || chasing.size >= CHASE_MAX) return;
    chasing.add(token);
    queue.push({ token, tries: 0 });
    tick();
  }
  function tick(): void {
    if (ticking || queue.length === 0) return;
    ticking = true;
    later(() => {
      ticking = false;
      for (const c of queue.splice(0, CHASE_PER_TICK)) {
        const h = infos.get(c.token);
        if (h !== undefined && now() - h.at < INFO_FRESH_MS) {
          chasing.delete(c.token);
          continue;
        }
        void start(c.token, true).then((x) => {
          if (x !== "missed") return void chasing.delete(c.token);
          if (c.tries + 1 < CHASE_TRIES) return void (queue.push({ token: c.token, tries: c.tries + 1 }), tick());
          chasing.delete(c.token);
          missed.set(c.token, now());
        });
      }
      tick();
    }, CHASE_TICK_MS);
  }

  /** The info held for the token while servable (under INFO_SERVE_MS) and, when it is not fresh, the read that refreshes
   *  it: a caller's when nothing servable is held, else background. Nothing is read while a chase runs or after one
   *  missed, for INFO_FRESH_MS, or with no key. */
  function infoOf(token: string): { held: Info | "none" | undefined; read: Promise<Read> | undefined } {
    const h = infos.get(token);
    if (h !== undefined && now() - h.at < INFO_FRESH_MS) return { held: h.info, read: undefined };
    const servable = h !== undefined && now() - h.at < INFO_SERVE_MS;
    const held = servable ? h.info : undefined;
    const m = missed.get(token);
    if (deps.keyed === undefined || deps.keyed === null || (!servable && (chasing.has(token) || (m !== undefined && now() - m < INFO_FRESH_MS)))) return { held, read: running.get(token) };
    const read = start(token, servable).then((x) => {
      if (x === "missed" && !servable) chase(token);
      return x;
    });
    return { held, read };
  }

  const LATE = Symbol("late");
  const within = <T>(p: Promise<T>, ms: number): Promise<T | typeof LATE> => {
    let t: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([p, new Promise<typeof LATE>((ok) => (t = setTimeout(() => ok(LATE), ms)))]).finally(() => clearTimeout(t));
  };
  const usable = (x: unknown): Info | null => (typeof x === "object" && x !== null ? (x as Info) : null);

  return {
    /** The info this process holds, as the next one takes it over (card market-reads-hold-under-load): each token's
     *  read under INFO_SERVE_MS, the bound it is served within, newest first, at most INFO_HANDOVER_MAX. */
    state(): [string, { info: Info | "none"; at: number }][] {
      const t = now();
      return infos.entries().filter(([, v]) => t - v.at < INFO_SERVE_MS).slice(-INFO_HANDOVER_MAX);
    },
    /** A previous process's state (data/warm.ts), hostile input: each entry a token address, its read time not ahead of
     *  now and under INFO_SERVE_MS, its info as toInfo makes one; any entry that fails, or more than INFO_HANDOVER_MAX,
     *  restores nothing. Each keeps its read time and its own as_of_ms. Returns whether it restored. */
    restore(st: unknown): boolean {
      if (!Array.isArray(st) || st.length > INFO_HANDOVER_MAX) return false;
      const t = now();
      const ok = st.every((e) => {
        if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string" || evmAddress(e[0]) !== e[0]) return false;
        const v = e[1] as { info?: unknown; at?: unknown } | null;
        if (typeof v !== "object" || v === null || Object.keys(v).length !== 2 || typeof v.at !== "number" || !Number.isFinite(v.at) || v.at > t || t - v.at >= INFO_SERVE_MS) return false;
        return v.info === "none" || isInfo(v.info, v.at, t);
      });
      if (!ok) return false;
      for (const [token, v] of st as [string, { info: Info | "none"; at: number }][]) {
        const had = infos.get(token);
        if (had === undefined || had.at < v.at) infos.set(token, { info: v.info, at: v.at });
      }
      return true;
    },
    /** 06b TokenPage for a token the chain's lists served or DexScreener names (rowOf); 404 for any other address, 503
     *  while neither can answer. */
    async page(token: string, client?: string): Promise<DataAnswer> {
      const t = evmAddress(token);
      if (t === null) return NOT_FOUND;
      const began = now();
      const found = await rowOf(t, client);
      if (found === undefined) return UPSTREAM;
      if (found === null) return NOT_FOUND;
      const { held, read } = infoOf(t);
      const risk = deps.goplus?.risk(chain, t) ?? Promise.resolve(null);
      // the first reads are waited for INFO_WAIT_MS from the request's start, so a coin DexScreener had to name first
      // (rowOf) still answers inside the page's second, its info and tag held for the next read
      // on the part's own clock (`now`), so a test's still clock holds the wait at INFO_WAIT_MS however slow the machine
      const wait = Math.max(0, INFO_WAIT_MS - (now() - began));
      const [row, info] = await Promise.all([tagged(found, wait), held !== undefined ? usable(held) : read === undefined ? null : within(read, wait).then(usable)]);
      const page = toPage(row, info, deps.kept?.(t), await risk);
      return { status: 200, body: JSON.stringify(page), src: row.src === "dexscreener" ? "dexscreener" : "geckoterminal", asOfMs: row.as_of_ms as number };
    },
    /** 06b Holders: no rows, the on-chain info's count and top 10 share (src "coingecko"); no count (src "none", the
     *  read chased) when the key cannot answer a token nothing is held for (or held past INFO_SERVE_MS), never a 429 or
     *  a 503 for it (card evm-chart-opens-without-a-vendor-call): no keyless source counts an EVM token's holders
     *  (above), so nothing of ours stands in for it. */
    async holders(token: string, client?: string): Promise<DataAnswer> {
      const t = evmAddress(token);
      if (t === null) return NOT_FOUND;
      const found = await rowOf(t, client);
      if (found === undefined) return UPSTREAM;
      if (found === null) return NOT_FOUND;
      const { held, read } = infoOf(t);
      const got = read === undefined ? held : await read;
      const info = got === "missed" ? held : got;
      const i = info === "none" ? undefined : info;
      if (i === undefined) {
        const at = now();
        return { status: 200, body: JSON.stringify({ holders: [], total: null, top_bps: null, src: "none", as_of_ms: at }), src: "none", asOfMs: at };
      }
      return { status: 200, body: JSON.stringify({ holders: [], total: i.holders, top_bps: i.top10Bps, src: CG_SRC, as_of_ms: i.asOfMs }), src: CG_SRC, asOfMs: i.asOfMs };
    },
  };
}
export type EvmToken = ReturnType<typeof createEvmToken>;
