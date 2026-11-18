// CoinGecko's paid on-chain API, read first for every chart (card helper-candles-keyed-gt): the owner's plan (API Basic,
// bought 13 Nov 10:28Z) answers the same on-chain data GeckoTerminal's keyless API does, under a key, at the key's own
// rate. Each chart read (the Solana token's top pool and its bars, data/solana/token.ts; an EVM token's GeckoTerminal
// pool and bars, data/evm/swaps.ts) asks here first; a read this cannot serve (no key set, its budget spent, CoinGecko's
// 401, 403, 429, 5xx, a timeout, an answer that is not the shape the caller reads) goes on to the keyless GeckoTerminal
// path exactly as before. With no key set nothing here exists (createKeyed answers null) and every read is main's.
//
// The paths (docs.coingecko.com, read 2026-11-13 10:35Z; the OpenAPI blocks of reference/pool-ohlcv-contract-address.md,
// reference/token-data-contract-address.md and reference/top-pools-contract-address.md): base
// https://pro-api.coingecko.com/api/v3, header x-cg-pro-api-key, and under /onchain the same paths GeckoTerminal's v2
// takes: /networks/{network}/pools/{pool_address}/ohlcv/{timeframe} (timeframe day, hour, minute, second; aggregate
// minute 1, 5, 15, hour 1, 4, 12, day 1; limit at most 1000; before_timestamp unix seconds; currency usd; token an
// address) answering data.attributes.ohlcv_list of [timestamp, open, high, low, close, volume];
// /networks/{network}/tokens/{address} answering data.relationships.top_pools.data[].id as "<network>_<pool>"; and
// /networks/{network}/tokens/{token_address}/pools answering data[].attributes.address. The network ids are
// GeckoTerminal's ("list of all supported networks on GeckoTerminal", reference/networks-list.md).
//
// The budget is the helper's paced-provider pace (limits/limits.ts providerHolds), one group "coingecko":
//   - a minute: COINGECKO_CALLS_PER_MIN (the key's own rate, as CoinGecko's /key answered the owner's script,
//     research scripts/deploy/coingecko-key.sh) less CG_MARGIN, as a bucket of a tenth of it at once and the rest spread
//     over the minute, so no 60 s holds more than the rate less the margin. CoinGecko counts every request, 4xx and 5xx
//     included ("All requests count toward your per-minute rate limit", docs/common-errors-rate-limit).
//   - a day: monthly_call_credit is "Total monthly API call credits for the plan", counted "for the account, across all
//     API keys" (reference/api-usage), one credit a call ("Calling any endpoint will only count as 1 call",
//     coingecko.com/en/api/pricing FAQ, read 10:36Z); Basic's is 100,000 a month (the same page). The day is the month's
//     credits over 31 days, the split limits.ts KEYED_DAY takes for every keyed plan, kept in the helper's shared day
//     files (limits/day-spend.ts) so a deploy's new helper resumes the day's spend; past it the charts read GeckoTerminal
//     keyless until the next UTC day, and the month never reaches overage.
//
// The key is hostile to keep: it is sent only in the request's x-cg-pro-api-key header, to this one origin, with
// redirects refused (a redirect would carry the header elsewhere). No log line, error, answer or header of ours holds
// it: the minute line counts outcomes only, and no fetch error's text is kept.
import type { Pace, ProviderHolds } from "../limits/limits.ts";

export const CG_ONCHAIN = "https://pro-api.coingecko.com/api/v3/onchain";
/** The holds' key of CoinGecko's pace (its origin). */
export const CG_URL = "https://pro-api.coingecko.com";
/** The answer's src when CoinGecko's keyed API served the bars; GeckoTerminal's keyless one is "geckoterminal". */
export const CG_SRC = "coingecko";
export type ChartSrc = typeof CG_SRC | "geckoterminal";
/** API Basic's month (coingecko.com/en/api/pricing, read 2026-11-13 10:36Z: 100k call credits). */
export const CG_MONTH_CREDITS = 100_000;
/** The month over 31 days (limits.ts KEYED_DAY's split): 3,225 calls a UTC day. */
export const CG_DAY = Math.floor(CG_MONTH_CREDITS / 31);
/** The share of the key's rate left unused. [design: a tenth: the owner's dashboard and the key script's /key reads
 *  count on the same account, and CoinGecko's minute is its clock's, not ours.] */
export const CG_MARGIN = 0.1;
/** The longest a keyed read waits for CoinGecko before the keyless path is asked. [design: 2 s: a chart's read is
 *  answered within 5 s (server.ts CANDLES_ANSWER_MS) and a cold one is two reads, its pool and its bars; the keyless
 *  path's own bound is GeckoTerminal's next free call.] */
export const CG_TIMEOUT_MS = 2_000;
/** How long a background read (the read ahead, a held tape's refresh: no caller waits on either) waits for CoinGecko.
 *  Card sol-vendor-tape-refresh-lands: CoinGecko's /trades answered a pool's trades in 1.6 to 3.1 s from a Mac in
 *  UTC+7 (12 reads 18 Nov 14:2xZ, one at 37 s) and 0.4 to 0.9 s from the helper's box (12 reads), so CG_TIMEOUT_MS cut
 *  half the Mac's refreshes as "down" and the breaker held the key. [design: 8 s, the helper's other vendor reads'
 *  TIMEOUT_MS] */
export const CG_BACKGROUND_TIMEOUT_MS = 8_000;
/** How long CoinGecko is not asked after it refused the key (401, 403): a key the plan no longer takes. */
export const CG_KEY_HOLD_S = 75;
/** How long after a 5xx, a timeout or a failed connection: one read's wait, not every chart's. */
export const CG_DOWN_HOLD_S = 30;
/** The 5xx, timeouts and failed connections in a row that hold CoinGecko for CG_DOWN_HOLD_S; an answer between them
 *  starts the count again, and one alone holds it CG_BLIP_HOLD_S (card sol-vendor-tape-refresh-lands: a single 2 s
 *  timeout held the key 30 s, and a Solana vendor tape renewed from it each TAPE_FRESH_MS went 40 s unrenewed against
 *  its 15 s bound, a local helper on mainnet reads 18 Nov 14:05:42-14:06:22Z, "coingecko calls: down 1, held 28").
 *  [design: 2, the industry's consecutive-failure breaker] */
export const CG_DOWN_TRIP = 2;
/** How long one 5xx, timeout or failed connection holds CoinGecko: the rest of the read that met it (a cold chart's
 *  bars after its top pool go keyless at once, as before), short of a tape's 15 s bound less its 10 s refresh and the
 *  2 s timeout. [design: 2 s] */
export const CG_BLIP_HOLD_S = 2;
/** CoinGecko's 429 with no Retry-After: its minute. */
export const CG_THROTTLE_HOLD_S = 60;
/** An answer's size limit (as the keyless reads'). */
const ANSWER_MAX = 2 * 1024 * 1024;
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

/** CoinGecko's pace for the helper's holds: none when no key is set. Throws, naming the variable, on a value it refuses
 *  (the start stops, card helper-ready-without-gt), and never prints the key. */
export function coingeckoPace(env: Record<string, string | undefined>): Record<string, Pace> {
  const key = env.COINGECKO_API_KEY;
  if (key === undefined || key === "") return {};
  if (!KEY.test(key)) throw new Error("COINGECKO_API_KEY is not an API key (letters, digits, - and _, 16 to 64)");
  const v = env.COINGECKO_CALLS_PER_MIN;
  if (v === undefined || !/^[1-9][0-9]{0,5}$/.test(v)) throw new Error("COINGECKO_CALLS_PER_MIN must be the key's calls a minute, a whole number");
  const usable = Math.max(1, Math.floor(Number(v) * (1 - CG_MARGIN)));
  const burst = Math.max(1, Math.floor(usable / 10));
  // at most `burst` at once and (usable - burst) more over a minute: never past `usable` in any 60 s
  return { [CG_URL]: { perS: Math.max(usable - burst, 1) / 60, burst, unit: "call", group: "coingecko", day: CG_DAY } };
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type Keyed = {
  /**
   * One keyed read of `path` (GeckoTerminal's v2 path, under /onchain): its JSON when CoinGecko answered 200 with a
   * body `ok` takes, else undefined (the caller goes on to the keyless path). `background`: the helper's own read
   * ahead, which leaves callers their room (limits.ts CALLER_ROOM).
   */
  read(path: string, ok: (json: unknown) => boolean, background?: boolean): Promise<unknown>;
  // the minute line counts each outcome and, for a call made, the kind of read (pool, bars, trades, pools), so the reads
  // that spend the key's day are named from the log (card helper-listed-charts-own-reads: the day was spent before
  // 21:20Z on 15 Nov and no line said by what)
  /** The minute's count line since the last one, or null when nothing was asked. */
  minute(): string | null;
};

/** The kind of an on-chain read, by its path's last fixed part: "ohlcv", "trades", "pools" or "token" (never an address). */
export function kindOf(path: string): string {
  const p = path.split("?")[0]!;
  if (p.includes("/ohlcv/")) return "ohlcv";
  if (p.endsWith("/trades")) return "trades";
  if (p.endsWith("/pools")) return "pools";
  return "token";
}

/** The keyed reads, or null when no key is set (every read keyless, as main). `holds` must carry coingeckoPace(env). */
export function createKeyed(env: Record<string, string | undefined>, holds: ProviderHolds, deps: { fetch?: Fetch } = {}): Keyed | null {
  const key = env.COINGECKO_API_KEY;
  if (key === undefined || key === "" || holds.paceOf(CG_URL) === undefined) return null;
  const doFetch = deps.fetch ?? fetch;
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  /** 5xx, timeouts and failed connections in a row (CG_DOWN_TRIP). */
  let downs = 0;
  const down = () => {
    if (++downs < CG_DOWN_TRIP) return holds.hold(CG_URL, CG_BLIP_HOLD_S);
    holds.hold(CG_URL, CG_DOWN_HOLD_S);
    downs = 0;
  };
  return {
    async read(path, ok, background = false) {
      if (holds.heldMs(CG_URL) > 0) return bump("held"), undefined;
      if (holds.dayOut(CG_URL, 1)) return bump("day"), undefined;
      if (holds.take(CG_URL, 1, background) > 0) return bump(background ? "minute background" : "minute"), undefined;
      let r: Response;
      try {
        r = await doFetch(`${CG_ONCHAIN}${path}`, { headers: { accept: "application/json", "x-cg-pro-api-key": key }, signal: AbortSignal.timeout(background ? CG_BACKGROUND_TIMEOUT_MS : CG_TIMEOUT_MS), redirect: "error" });
      } catch {
        // a timeout or a failed connection; its text is never kept (it may name the request)
        down();
        return bump("down"), undefined;
      }
      try {
        if (r.status !== 200) {
          await r.body?.cancel().catch(() => undefined);
          if (r.status === 429) {
            const ra = Number(r.headers.get("retry-after"));
            holds.hold(CG_URL, Number.isFinite(ra) && ra > 0 ? ra : CG_THROTTLE_HOLD_S);
          } else if (r.status === 401 || r.status === 403) holds.hold(CG_URL, CG_KEY_HOLD_S);
          if (r.status >= 500) down();
          else downs = 0;
          return bump(String(r.status)), undefined;
        }
        downs = 0;
        if (Number(r.headers.get("content-length") ?? "0") > ANSWER_MAX) return await r.body?.cancel().catch(() => undefined), bump("large"), undefined;
        const text = await r.text();
        if (text.length > ANSWER_MAX) return bump("large"), undefined;
        const json: unknown = JSON.parse(text);
        if (!ok(json)) return bump("shape"), undefined;
        bump(`served ${kindOf(path)}${background ? " background" : ""}`);
        return json;
      } catch (e) {
        // the body cut by the timeout is CoinGecko slow, a body that does not parse its answer's shape
        if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return down(), bump("down"), undefined;
        return bump("shape"), undefined;
      }
    },
    minute() {
      if (counts.size === 0) return null;
      const line = `coingecko calls: ${[...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(", ")}`;
      counts.clear();
      return line;
    },
  };
}
