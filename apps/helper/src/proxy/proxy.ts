// POST /v1/proxy/{vendor}/{path} (markets paper H2.1-H2.3, H7). The device reaches the keyed vendors only through
// here, and never sees a key: the key comes from the host's environment, rides only on the request to the vendor's
// fixed base URL, and an answer that holds a key in any form is refused. Nothing the vendor answers is trusted for
// anything signed (H2.4): the body is passed as data and the device checks it against its own request and reads.
//
// What reaches the vendor: the allowlisted path, the caller's query string re-encoded, for a POST entry the caller's
// body byte for byte as JSON, and the key header. No header of the caller (no cookie, origin, user agent or address).
// What reaches the caller: the vendor's status and JSON body, with X-Helper-Source and X-Fetched-At. A vendor that is
// down, slow, refusing our key, or answering anything but JSON within the size cap answers 503 upstream, so the device
// falls back to its public path (H2.3). Throttling (card helper-abuse-limits, ../limits/limits.ts): each vendor is one
// budget every call that reaches it draws from, the helper's own reads and a retry included, PROXY_BUDGETS (or
// PROXY_BUDGET_<VENDOR>) requests in any minute, and no caller more than its share of them a 10 s window (a cache hit
// or a call joining one in flight counts in the caller's share only, as it reaches no vendor); a draw past either
// answers 429 rate_limited with the seconds until it would go ahead. A vendor's own 429 holds that vendor until the reset it named (at most a
// minute): the helper is its one client, so nothing reaches the vendor until then. Card helper-crowd-429 (fold 6): a
// vendor's hold, or its 429, is never the caller's 429 (a 429 of ours says the caller is past its own limit): a call
// waits out the hold, one shared end for every caller, when it ends inside the call's wait (QUEUE_WAIT_MS, or what the
// helper's own read names), then reads; past it the answer is 503 upstream, the not-ready form the device falls back
// on (H2.3). The calls that waited go to a PACED vendor one per its second's share, so the end of a hold is no burst. Identical GETs
// in flight share one call.
import { HELPER_FETCHED_AT_HEADER, HELPER_SOURCE_HEADER, HELPER_V1_PATHS, type HelperV1Path } from "@blindfill/kit";
import { budgetFromEnv, throttled, upstreamBudget, upstreamRetryAfterS, type BudgetLimits } from "../limits/limits.ts";
import { VENDOR_NAMES, VENDORS, type Upstream, type Vendor, type VendorName } from "./vendors.ts";

/** H7 "body 64 KB": the kit's /v1/proxy/{vendor}/{path} row of HELPER_V1_PATHS. */
export const PROXY_BODY_MAX = HELPER_V1_PATHS.find((r): r is Extract<HelperV1Path, { path: "/v1/proxy/{vendor}/{path}" }> => r.path === "/v1/proxy/{vendor}/{path}")!.limitBytes;
export const QUERY_MAX = 4_096;
export const ANSWER_MAX = 4 * 1024 * 1024; // a trending list is ~250 KB (D-S3); a build or quote a few KB
export const TIMEOUT_MS = 8_000;
export const WAIT_MAX_MS = 1_000;
/**
 * The longest a caller waits for the vendor's budget to have its room (card helper-crowd-429): a draw the share or the
 * total refuses is tried again every QUEUE_POLL_MS until then; past it a caller past its own share answers 429 with the
 * seconds to wait, and the vendor's room or hold answers 503 upstream (fold 6).
 * A vendor's own hold is waited out the same way when it ends by then (fold 6). [design: 3 s: a Jupiter build answered in 223-698 ms
 * live (solana-jupiter-build, 4 Nov), so the wait and the build stay inside the kit's 5 s SOLANA_BUILD_TIMEOUT_MS
 * (packages/kit/src/trade/solana/build.ts:52).]
 */
export const QUEUE_WAIT_MS = 3_000;
/**
 * The vendors whose plan also names a second (card helper-crowd-429, fold 6): the calls that wait out a hold go one per
 * VENDOR_WINDOW_MS / total, in turn, so its end is no burst; a call with nothing to wait for goes at once. Jupiter's Free plan is "Free | 1 | 60", one request a second and 60 a minute, on a
 * 60-second sliding window (developers.jup.ag/docs/api-rate-limit, read 2026-11-05 01:10Z): 1000 ms at the 60 of
 * PROXY_BUDGETS, and a plan's own pace when PROXY_BUDGET_JUPITER names it. Helper live run 41943005189 (5 Nov 00:40Z):
 * Jupiter answered 429 with the minute's budget not spent ("refused /v1/market/token jupiter provider 429"), then
 * "jupiter held" for /v1/proxy and /v1/market/token. The others publish a minute only.
 */
export const PACED: ReadonlySet<VendorName> = new Set(["jupiter"]);
export const QUEUE_POLL_MS = 250;
/** The most of one vendor's calls the other helpers may seed (card helper-deploy-reads-fast): a Developer key's 600 a minute
 *  and the second a counted minute spans, with room. */
export const VENDOR_SEED_MAX = 1_000;
/** A vendor's budget is counted over its own window: every vendor below publishes a per-minute limit. */
export const VENDOR_WINDOW_MS = 60_000;
/**
 * Each vendor's budget, unless PROXY_BUDGET_<VENDOR> ("<total>,<per client>") names its plan's: the total is the
 * vendor's published limit a minute for the key a plan starts with, counted over a sliding minute and drawn by every
 * call that reaches the vendor, the helper's own reads included, so no stretch of the vendor's window ever holds more;
 * the share is what one device asks of that vendor in a 10 s window.
 * - jupiter: "Free | 1 | 60" requests a second and a minute, on a 60-second sliding window, Swap, Price and Token
 *   requests in one bucket (developers.jup.ag/docs/api-rate-limit, read 2026-11-03 09:15Z): 60. The helper's own reads
 *   draw from it: token search at most SEARCH_PER_SPAN 16 a counted minute (data/solana/token.ts), and
 *   Discover's three lists once per 12 s refresh through a 10 s cache (data/solana/lists.ts), about 15 a minute; 34 of
 *   the 60 at most (PROXY_RESERVE), the rest for devices. Share 4: a device's trade asks /swap/v2/build at most
 *   four times a leg, every leg at once: the cap search's three builds (packages/kit/src/trade/solana/build.ts
 *   SOLANA_JUPITER_MAX_BUILDS) and one rebuild when the route's floor needs it (packages/kit/src/trade/solana/flow.ts
 *   prepareLeg). K legs ask K to 4K (3 legs too large at 40 and 32, fitting at 28, each with a floor rebuild: 12); a
 *   one-leg trade at most 4, the share. More draw past the share as lent (limits.ts LEND_FREE_SHARES: 8 a minute on
 *   the total alone, then while room stays for others).
 * - relay: "`/quote` | 50 requests per minute" for a self-serve key, other endpoints 200 (docs.relay.link/references/
 *   api/api-keys, read 09:15Z): 50, the quote's. Share 2: no kit call yet; a tap's hop is one quote and one status.
 * - lifi: keys "currently default to **100 requests per minute**" (docs.li.fi/api-reference/rate-limits, read 09:15Z):
 *   100. Share 2: no kit call yet; the fallback route is one quote and one status.
 * - oneclick: no limit published (docs.near-intents.org 1click-api/authentication, read 09:16Z), so the most
 *   conservative published one above, Relay's 50 a minute: 50. Share 2: a deposit asks one quote per tap
 *   (packages/signpage/src/rules/deposit-quote.ts l.119, packages/wallet/src/deposit/quote.ts l.67), and one again.
 */
export const PROXY_BUDGETS: Readonly<Record<VendorName, BudgetLimits>> = {
  jupiter: { total: 60, perClient: 4, windowMs: VENDOR_WINDOW_MS, reserve: 34, lend: true },
  relay: { total: 50, perClient: 2, windowMs: VENDOR_WINDOW_MS, reserve: 0, lend: true },
  lifi: { total: 100, perClient: 2, windowMs: VENDOR_WINDOW_MS, reserve: 0, lend: true },
  oneclick: { total: 50, perClient: 2, windowMs: VENDOR_WINDOW_MS, reserve: 0, lend: true },
};
/**
 * Requests kept in each vendor's total for the helper's own reads that serve every user, which only those reads may
 * draw, whatever PROXY_BUDGET_<VENDOR> says. Jupiter: Discover's three lists once per FRESH_MS 12 s (data/solana/
 * lists.ts READS) and the token page's search. The budget counts a draw until the end of its second plus the minute
 * (limits.ts upstreamBudget), so a counted minute spans up to 61 whole seconds: lists 6 refreshes x 3 = 18, and search
 * at most SEARCH_PER_SPAN 16 in that span, however they come (data/solana/token.ts: a cold mint's at once, a refresh
 * batched), so 34.
 * Callers get 26 of Free's 60 and 566 of a Developer key's 600. Relay, LI.FI and 1Click: the helper reads none on its
 * own, so 0.
 */
export const PROXY_RESERVE: Readonly<Record<VendorName, number>> = { jupiter: 34, relay: 0, lifi: 0, oneclick: 0 };
/** The environment variable naming a vendor's budget, "<total per minute>,<per client per 10 s>". */
export const proxyBudgetEnv = (vendor: VendorName): string => `PROXY_BUDGET_${vendor.toUpperCase()}`;
/**
 * The start's check that each vendor's budget is its key's plan: every default above is a keyed plan's figure, and a
 * vendor called with no key holds us to its keyless limit, lower (Jupiter's keyless 30 a minute, LI.FI's unauthenticated
 * /quote 75 per two hours). So a vendor with no key needs PROXY_BUDGET_<VENDOR> set to the plan it is on; the error
 * names the variables, never a value.
 */
export function checkVendorPlans(env: Record<string, string | undefined>): void {
  for (const v of VENDOR_NAMES) {
    const key = VENDORS[v].env;
    if ((env[key] ?? "") === "" && (env[proxyBudgetEnv(v)] ?? "") === "") throw new Error(`${key} is unset: set it, or ${proxyBudgetEnv(v)} to the plan without a key`);
  }
}
export const CACHE_ENTRIES = 256;
export const CACHE_BYTES = 32 * 1024 * 1024;
const KEY_SHAPE = /^[\x21-\x7e]{8,4096}$/; // printable ASCII, no space or line break, so it can never split a header

/** `why`: a 429's limit, for the refusal log (limits.ts throttled), never sent. `timing` (card helper-ready-page-warm):
 *  the call's Server-Timing entries for the helper's own reads that name them (the token page's Jupiter search): its
 *  wait for the budget's room (budget), for the vendor's hold or turn (turn), each 429 the vendor answered (429), and
 *  the send (send). */
export type ProxyAnswer = { status: number; headers: Record<string, string>; body: string; why?: string; timing?: string[] };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Read = { status: number; body: string; fetchedAt: string; timing?: string[] };
/** `peers` (card helper-deploy-reads-fast): the other helpers on the same keys (shared-calls.ts callsFiles), whose calls
 *  every draw that may reach a vendor counts first, and to which each such draw is told at once. */
export type Peers = { read(): unknown; write(calls: Record<string, number[]>): void };
type Deps = { fetch?: Fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; peers?: Peers };

const error = (status: number, code: string): ProxyAnswer => ({ status, headers: {}, body: JSON.stringify({ error: { code } }) });
const UPSTREAM = () => error(503, "upstream");
/** The not-ready form (503 upstream, the device's fallback, H2.3) for a vendor's hold or room: `why` names it for the
 *  refusal log, never sent. `retryAfterS`: the seconds until the vendor's total has the room (card solana-legs-share-wait),
 *  so a device waits it out and asks again; a hold whose end is not known names none. */
const notReady = (why: string, retryAfterS?: number): ProxyAnswer => ({ ...UPSTREAM(), ...(retryAfterS ? { headers: { "Retry-After": String(retryAfterS) } } : {}), why });

/** The keys this host holds, from its environment. A key of the wrong shape stops the start; the message names the variable, never the value. */
export function readKeys(env: Record<string, string | undefined>): Partial<Record<VendorName, string>> {
  const keys: Partial<Record<VendorName, string>> = {};
  for (const name of VENDOR_NAMES) {
    const v = env[VENDORS[name].env];
    if (v === undefined || v === "") continue;
    if (!KEY_SHAPE.test(v)) throw new Error(`${VENDORS[name].env} must be 8 to 4096 printable characters with no space`);
    keys[name] = v;
  }
  return keys;
}

/** Every form a key could leave in: as set, base64, base64url and URL-encoded. */
function keyForms(keys: Partial<Record<VendorName, string>>): Buffer[] {
  const forms = new Set<string>();
  for (const k of Object.values(keys)) {
    if (!k) continue;
    const b = Buffer.from(k, "utf8");
    for (const f of [k, b.toString("base64").replace(/=+$/, ""), b.toString("base64url"), encodeURIComponent(k)]) forms.add(f);
  }
  return [...forms].map((f) => Buffer.from(f, "utf8"));
}

/** A reset header in seconds from now, or an epoch in seconds or milliseconds; Retry-After also as an HTTP date. */
export function resetMs(h: Headers, now: number): number {
  const retry = h.get("retry-after");
  if (retry !== null) {
    const s = Number(retry);
    if (Number.isFinite(s) && s >= 0) return s * 1000;
    const at = Date.parse(retry);
    if (Number.isFinite(at)) return at - now;
  }
  for (const [name, value] of h) {
    if (!/^x-ratelimit-reset/i.test(name)) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) continue;
    if (n > 1e12) return n - now;
    if (n > 1e9) return n * 1000 - now;
    return n * 1000;
  }
  return 1000;
}

export function createProxy(env: Record<string, string | undefined>, deps: Deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const keys = readKeys(env);
  const forms = keyForms(keys);
  const limits = Object.fromEntries(VENDOR_NAMES.map((v) => [v, { ...budgetFromEnv(env, proxyBudgetEnv(v), PROXY_BUDGETS[v], { reserve: PROXY_RESERVE[v] }), windowMs: VENDOR_WINDOW_MS, reserve: PROXY_RESERVE[v], lend: true }])) as Record<VendorName, BudgetLimits>;
  const budget = upstreamBudget((v) => limits[v as VendorName], now);
  /** Each vendor's calls this helper made that its window may still count (card helper-deploy-reads-fast). */
  const calls = (): Record<string, number[]> => Object.fromEntries(VENDOR_NAMES.map((v) => [v, budget.calls(v)]));
  /** The other helpers' calls on the same keys (hostile input: whole ms numbers no later than a second from now,
   *  VENDOR_SEED_MAX a vendor at most, the newest kept), counted in each vendor's budget in place of the last seed: a
   *  vendor counts every call on its key, and while a deploy's two helpers overlapped each one counted only its own,
   *  so together they drew Jupiter past its minute (live run 42125976095 attempt 1: helper-token-page-cold, a page 503
   *  "jupiter held" after Jupiter's 429). */
  function seed(vendors: unknown): void {
    const o = typeof vendors === "object" && vendors !== null && !Array.isArray(vendors) ? (vendors as Record<string, unknown>) : {};
    for (const v of VENDOR_NAMES) {
      const t = Object.hasOwn(o, v) && Array.isArray(o[v]) ? (o[v] as unknown[]).filter((x): x is number => typeof x === "number" && Number.isSafeInteger(x) && x <= now() + 1_000).sort((x, y) => x - y).slice(-VENDOR_SEED_MAX) : [];
      budget.seed(v, t);
    }
  }
  /** A draw that may reach a vendor: the peers' calls counted first, and the draw told to them once it goes. A peer
   *  file that cannot be read or written leaves this helper counting its own, as before. */
  const drawUp = (name: VendorName, client: string | undefined, reserved: boolean): number => {
    if (deps.peers) {
      try {
        seed(deps.peers.read());
      } catch {
        // counted again at the next draw
      }
    }
    const w = budget.take(name, client, 1, false, reserved);
    if (w === 0 && deps.peers) {
      try {
        deps.peers.write(calls());
      } catch {
        // told at the next draw
      }
    }
    return w;
  };
  const cache = new Map<string, Read & { expires: number }>();
  let cacheBytes = 0;
  const inflight = new Map<string, Promise<Read | ProxyAnswer>>();
  /** Per paced vendor (PACED), the earliest a next call may go: each call takes the next turn. */
  const nextAt = new Map<VendorName, number>();
  /** Takes this call's turn at the vendor, after its hold's end and the turn before (PACED), and waits for it; false
   *  when it comes past `by` (nothing taken). Every caller waits for the one hold end and the turns go one at a time, so
   *  no burst. One reservation and one wait, then a look at a hold set meanwhile, so a clock that does not move still
   *  ends it. */
  async function turn(name: VendorName, by: number): Promise<boolean> {
    for (let round = 0; round < 3; round++) {
      const t = now();
      const at = Math.max(t, budget.heldUntil(name), nextAt.get(name) ?? 0);
      if (at > by) return false;
      // a call that waits (a hold, or the turns draining one) goes in turn, one per second's share of the plan; a call
      // with no wait goes at once, as the minute's budget allows
      if (PACED.has(name) && at > t) nextAt.set(name, at + Math.ceil(VENDOR_WINDOW_MS / limits[name].total));
      if (at > t) await sleep(at - t);
      if (budget.heldUntil(name) <= now()) return true;
    }
    return false;
  }

  const holdsKey = (text: string) => {
    const b = Buffer.from(text, "utf8");
    return forms.some((f) => b.includes(f));
  };

  function remember(id: string, read: Read, ms: number) {
    const old = cache.get(id);
    if (old) cacheBytes -= Buffer.byteLength(old.body);
    cache.delete(id);
    const size = Buffer.byteLength(read.body);
    if (size > CACHE_BYTES) return;
    while (cache.size >= CACHE_ENTRIES || cacheBytes + size > CACHE_BYTES) {
      const [oldest, entry] = cache.entries().next().value!;
      cache.delete(oldest);
      cacheBytes -= Buffer.byteLength(entry.body);
    }
    cache.set(id, { ...read, expires: now() + ms });
    cacheBytes += size;
  }

  async function readBody(r: Response): Promise<string | undefined> {
    const declared = Number(r.headers.get("content-length") ?? "0");
    if (declared > ANSWER_MAX) return undefined;
    if (!r.body) return "";
    const chunks: Uint8Array[] = [];
    let n = 0;
    for await (const c of r.body) {
      n += c.byteLength;
      if (n > ANSWER_MAX) return undefined;
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function call(name: VendorName, v: Vendor, up: Upstream, path: string, query: string, body: string, reserved: boolean, by: number): Promise<Read | ProxyAnswer> {
    // the seconds to the vendor's reset, for the not-ready answer's Retry-After
    const heldS = (): number => Math.max(1, Math.ceil((budget.heldUntil(name) - now()) / 1000));
    // the call's own waits, for its Server-Timing (ProxyAnswer.timing)
    let turnMs = 0;
    let refusals = 0;
    for (let attempt = 0; ; attempt++) {
      // the vendor's reset holds every call to it: waited out when it ends by `by`, else not ready (never our 429)
      const t0 = performance.now();
      const turned = await turn(name, by);
      turnMs += performance.now() - t0;
      if (!turned) return notReady(`${name} held`, heldS());
      if (attempt > 0) {
        // the retry reaches the vendor again, so it draws from the total too
        if (drawUp(name, undefined, reserved) > 0) return notReady(budget.refusedBy());
      }
      const headers: Record<string, string> = { accept: "application/json" };
      const key = keys[name];
      if (key) headers[v.header] = key;
      if (up.method === "POST") headers["content-type"] = "application/json";
      let r: Response;
      let text: string | undefined;
      const sentAt = performance.now();
      try {
        r = await doFetch(`${v.base}${path}${query}`, {
          method: up.method,
          headers,
          body: up.method === "POST" ? body : undefined,
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (r.status === 429) {
          await r.body?.cancel();
          refusals++;
          // the vendor is held until its reset, for every caller; this call reads again once it ends, if that is by
          // `by` (turn), once: a second 429 is not ready
          const wait = Math.max(resetMs(r.headers, now()), 0);
          budget.hold(name, now() + (wait <= WAIT_MAX_MS ? wait : upstreamRetryAfterS(r.headers, now()) * 1000));
          if (attempt === 0) continue;
          return notReady(`${name} provider 429`, heldS());
        }
        text = await readBody(r);
      } catch {
        return UPSTREAM();
      }
      const fetchedAt = new Date(now()).toISOString();
      // our key refused (401, 403), the vendor failing (5xx), or an answer we cannot pass as JSON data
      if (r.status === 401 || r.status === 403 || r.status >= 500 || r.status < 200 || (r.status >= 300 && r.status < 400)) return UPSTREAM();
      if (text === undefined || !/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(r.headers.get("content-type") ?? "")) return UPSTREAM();
      try {
        JSON.parse(text);
      } catch {
        return UPSTREAM();
      }
      if (holdsKey(text)) return UPSTREAM();
      const timing = [`turn;dur=${Math.round(turnMs)}`, ...(refusals > 0 ? [`429;desc="${refusals}"`] : []), `send;dur=${Math.round(performance.now() - sentAt)}`];
      return { status: r.status, body: text, fetchedAt, timing };
    }
  }

  /**
   * One proxied call: `vendor` and `path` as the caller wrote them, `rawQuery` the text after "?" (or ""), `body` the
   * request body, `client` the caller's address (../limits/limits.ts clientOf). The helper's own reads (Discover's
   * lists, the token page) pass none: they draw from the vendor's total, never a caller's share; `reserved` marks the
   * ones PROXY_RESERVE holds room for, which alone may draw it.
   */
  async function handle(vendor: string, path: string, rawQuery: string, body: string, client?: string, reserved = false, waitMs = QUEUE_WAIT_MS): Promise<ProxyAnswer> {
    const by = now() + waitMs;
    if (!Object.hasOwn(VENDORS, vendor)) return error(404, "not_found");
    const name = vendor as VendorName;
    const v = VENDORS[name];
    const source = (a: ProxyAnswer): ProxyAnswer => ({ ...a, headers: { [HELPER_SOURCE_HEADER]: name, ...a.headers } });
    if (!Object.hasOwn(v.paths, path)) return source(error(400, "path_not_allowed"));
    const up = v.paths[path]!;
    if (Buffer.byteLength(body) > PROXY_BODY_MAX) return source(error(413, "too_large"));
    if (rawQuery.length > QUERY_MAX) return source(error(413, "too_large"));
    // a draw on the vendor's budget for every call that may reach it, the helper's own too; a cache hit or a call joining
    // one in flight reaches nothing, so it counts in the caller's share alone
    const take = (shareOnly = false): number => (shareOnly ? budget.take(name, client, 1, true, reserved) : drawUp(name, client, reserved));
    // card helper-crowd-429: a draw the share or the total refuses waits for its room, until `by` at most, and a draw the
    // vendor's hold refuses waits for the hold's end when it comes by then; a draw that goes is taken at once, with no
    // await, so a call right behind it still finds it in flight. A cache hit (its share only, which turns with its
    // window) answers at once, as before.
    const draw = (shareOnly = false): number | Promise<number> => {
      const w = take(shareOnly);
      if (w === 0 || shareOnly) return w;
      return (async () => {
        let last = w;
        // bounded by rounds as well as by the clock, so a clock that does not move still ends it
        for (let round = 0; last > 0 && round * QUEUE_POLL_MS < waitMs; round++) {
          const held = budget.refusedBy().endsWith(" held");
          const at = held ? budget.heldUntil(name) : now() + QUEUE_POLL_MS;
          if (at > by || now() >= by) return last;
          await sleep(Math.max(at - now(), 1));
          last = take(shareOnly);
        }
        return last;
      })();
    };
    // a refusal past the wait: the caller's own share is its 429; the vendor's hold or room is not ready, never our 429,
    // both with the seconds until the draw would go (Retry-After)
    const refused = (wait: number): ProxyAnswer => {
      const why = budget.refusedBy();
      return why.endsWith(" share") ? throttled(wait, undefined, why) : notReady(why, wait);
    };
    const params = new URLSearchParams(rawQuery);
    if (up.cacheMs) params.sort();
    const qs = params.size ? `?${params}` : "";
    let out: Read | ProxyAnswer;
    let budgetMs = 0;
    if (up.method === "GET") {
      // a GET is a read: identical ones in flight share one call (card helper-crowd-429, fold 6), and a public list is
      // also kept cacheMs
      // the same read whatever its parameters' order: keyed sorted, sent as the caller wrote it (a list's sorted, as before)
      const key = new URLSearchParams(params);
      key.sort();
      const id = `${name} ${path}${key.size ? `?${key}` : ""}`;
      const hit = up.cacheMs ? cache.get(id) : undefined;
      if (hit && hit.expires > now()) {
        const wait = draw(true) as number;
        if (wait > 0) return source(throttled(wait, undefined, budget.refusedBy()));
        out = hit;
      } else {
        let p = inflight.get(id);
        const b0 = performance.now();
        const first = draw(p !== undefined);
        const wait = typeof first === "number" ? first : await first;
        budgetMs = performance.now() - b0;
        if (wait > 0) return source(refused(wait));
        // a read another call began while this one waited is joined, not sent twice
        p ??= inflight.get(id);
        if (!p) {
          p = call(name, v, up, path, qs, "", reserved, by).then((read) => {
            if (up.cacheMs && "fetchedAt" in read && read.status === 200) remember(id, read, up.cacheMs);
            return read;
          });
          p.finally(() => inflight.delete(id)).catch(() => {});
          inflight.set(id, p);
        }
        out = await p;
      }
    } else {
      const wait = await draw();
      if (wait > 0) return source(refused(wait));
      out = await call(name, v, up, path, qs, up.method === "POST" ? body : "", reserved, by);
    }
    if (!("fetchedAt" in out)) return source(out);
    return source({ status: out.status, headers: { [HELPER_FETCHED_AT_HEADER]: out.fetchedAt }, body: out.body, ...(out.timing ? { timing: [`budget;dur=${Math.round(budgetMs)}`, ...out.timing] } : {}) });
  }

  return {
    handle,
    keyCount: Object.keys(keys).length,
    /** Each vendor's calls this helper made that its window may still count (card helper-deploy-reads-fast). */
    calls,
    /** Counts the other helpers' calls on the same keys (card helper-deploy-reads-fast). */
    seed,
  };
}
