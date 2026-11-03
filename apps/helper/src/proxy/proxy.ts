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
// minute): the helper is its one client, so every caller drawing on it, the helper's own reads included, answers 429
// with the seconds left and nothing reaches the vendor. A reset of at most WAIT_MAX_MS is waited out once by the
// request that met it.
import { HELPER_FETCHED_AT_HEADER, HELPER_SOURCE_HEADER, HELPER_V1_PATHS, type HelperV1Path } from "@blindfill/kit";
import { budgetFromEnv, throttled, upstreamBudget, upstreamRetryAfterS, type BudgetLimits } from "../limits/limits.ts";
import { VENDOR_NAMES, VENDORS, type Upstream, type Vendor, type VendorName } from "./vendors.ts";

/** H7 "body 64 KB": the kit's /v1/proxy/{vendor}/{path} row of HELPER_V1_PATHS. */
export const PROXY_BODY_MAX = HELPER_V1_PATHS.find((r): r is Extract<HelperV1Path, { path: "/v1/proxy/{vendor}/{path}" }> => r.path === "/v1/proxy/{vendor}/{path}")!.limitBytes;
export const QUERY_MAX = 4_096;
export const ANSWER_MAX = 4 * 1024 * 1024; // a trending list is ~250 KB (D-S3); a build or quote a few KB
export const TIMEOUT_MS = 8_000;
export const WAIT_MAX_MS = 1_000;
/** A vendor's budget is counted over its own window: every vendor below publishes a per-minute limit. */
export const VENDOR_WINDOW_MS = 60_000;
/**
 * Each vendor's budget, unless PROXY_BUDGET_<VENDOR> ("<total>,<per client>") names its plan's: the total is the
 * vendor's published limit a minute for the key a plan starts with, counted over a sliding minute and drawn by every
 * call that reaches the vendor, the helper's own reads included, so no stretch of the vendor's window ever holds more;
 * the share is what one device asks of that vendor in a 10 s window.
 * - jupiter: "Free | 1 | 60" requests a second and a minute, on a 60-second sliding window, Swap, Price and Token
 *   requests in one bucket (developers.jup.ag/docs/api-rate-limit, read 2026-11-03 09:15Z): 60. The helper's own reads
 *   draw from it: token search at most one per JUP_GAP_MS 4 s, at most 15 a minute (data/solana/token.ts), and
 *   Discover's three lists once per 12 s refresh through a 10 s cache (data/solana/lists.ts), about 15 a minute; 30 of
 *   the 60 at most, the rest for devices. Share 4: a device's one trade asks /swap/v2/build at most four times, a capped
 *   build and its uncapped retry (packages/kit/src/trade/solana/build.ts l.243-246), twice when the route's floor needs
 *   a rebuild (packages/kit/src/trade/solana/flow.ts l.318, l.325).
 * - relay: "`/quote` | 50 requests per minute" for a self-serve key, other endpoints 200 (docs.relay.link/references/
 *   api/api-keys, read 09:15Z): 50, the quote's. Share 2: no kit call yet; a tap's hop is one quote and one status.
 * - lifi: keys "currently default to **100 requests per minute**" (docs.li.fi/api-reference/rate-limits, read 09:15Z):
 *   100. Share 2: no kit call yet; the fallback route is one quote and one status.
 * - oneclick: no limit published (docs.near-intents.org 1click-api/authentication, read 09:16Z), so the most
 *   conservative published one above, Relay's 50 a minute: 50. Share 2: a deposit asks one quote per tap
 *   (packages/signpage/src/rules/deposit-quote.ts l.119, packages/wallet/src/deposit/quote.ts l.67), and one again.
 */
export const PROXY_BUDGETS: Readonly<Record<VendorName, BudgetLimits>> = {
  jupiter: { total: 60, perClient: 4, windowMs: VENDOR_WINDOW_MS, reserve: 34 },
  relay: { total: 50, perClient: 2, windowMs: VENDOR_WINDOW_MS, reserve: 0 },
  lifi: { total: 100, perClient: 2, windowMs: VENDOR_WINDOW_MS, reserve: 0 },
  oneclick: { total: 50, perClient: 2, windowMs: VENDOR_WINDOW_MS, reserve: 0 },
};
/**
 * Requests kept in each vendor's total for the helper's own reads that serve every user, which only those reads may
 * draw, whatever PROXY_BUDGET_<VENDOR> says. Jupiter: token search at most one per JUP_GAP_MS 4 s, 15 a minute
 * (data/solana/token.ts), and Discover's three lists once per FRESH_MS 12 s, 3 x 5 = 15 a minute (data/solana/lists.ts
 * READS), 30 a minute. The budget counts a draw until the end of its second plus the minute (limits.ts upstreamBudget),
 * so a counted minute spans up to 61 whole seconds: search 16 (0, 4, .., 60) and lists 6 refreshes x 3 = 18, so 34.
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

export type ProxyAnswer = { status: number; headers: Record<string, string>; body: string };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Read = { status: number; body: string; fetchedAt: string };
type Deps = { fetch?: Fetch; now?: () => number; sleep?: (ms: number) => Promise<void> };

const error = (status: number, code: string): ProxyAnswer => ({ status, headers: {}, body: JSON.stringify({ error: { code } }) });
const UPSTREAM = () => error(503, "upstream");

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
  const limits = Object.fromEntries(VENDOR_NAMES.map((v) => [v, { ...budgetFromEnv(env, proxyBudgetEnv(v), PROXY_BUDGETS[v], { reserve: PROXY_RESERVE[v] }), windowMs: VENDOR_WINDOW_MS, reserve: PROXY_RESERVE[v] }])) as Record<VendorName, BudgetLimits>;
  const budget = upstreamBudget((v) => limits[v as VendorName], now);
  const cache = new Map<string, Read & { expires: number }>();
  let cacheBytes = 0;
  const inflight = new Map<string, Promise<Read | ProxyAnswer>>();

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

  async function call(name: VendorName, v: Vendor, up: Upstream, path: string, query: string, body: string, reserved: boolean): Promise<Read | ProxyAnswer> {
    for (let attempt = 0; ; attempt++) {
      // the vendor's reset holds every call to it
      const held = budget.heldFor(name);
      if (held > 0) return throttled(held);
      const headers: Record<string, string> = { accept: "application/json" };
      const key = keys[name];
      if (key) headers[v.header] = key;
      if (up.method === "POST") headers["content-type"] = "application/json";
      let r: Response;
      let text: string | undefined;
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
          // the vendor is held until its reset; a short one is waited out once by this request, a longer one (or a
          // second 429) is every caller's wait
          const wait = Math.max(resetMs(r.headers, now()), 0);
          budget.hold(name, now() + (wait <= WAIT_MAX_MS ? wait : upstreamRetryAfterS(r.headers, now()) * 1000));
          if (attempt === 0 && wait <= WAIT_MAX_MS) {
            await sleep(wait);
            // the retry reaches the vendor again, so it draws from the total too
            const again = budget.take(name, undefined, 1, false, reserved);
            if (again > 0) return throttled(again);
            continue;
          }
          return throttled(Math.max(budget.heldFor(name), 1));
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
      return { status: r.status, body: text, fetchedAt };
    }
  }

  /**
   * One proxied call: `vendor` and `path` as the caller wrote them, `rawQuery` the text after "?" (or ""), `body` the
   * request body, `client` the caller's address (../limits/limits.ts clientOf). The helper's own reads (Discover's
   * lists, the token page) pass none: they draw from the vendor's total, never a caller's share; `reserved` marks the
   * ones PROXY_RESERVE holds room for, which alone may draw it.
   */
  async function handle(vendor: string, path: string, rawQuery: string, body: string, client?: string, reserved = false): Promise<ProxyAnswer> {
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
    const draw = (shareOnly = false): number => budget.take(name, client, 1, shareOnly, reserved);
    const params = new URLSearchParams(rawQuery);
    if (up.cacheMs) params.sort();
    const qs = params.size ? `?${params}` : "";
    let out: Read | ProxyAnswer;
    if (up.cacheMs) {
      const id = `${name} ${path}${qs}`;
      const hit = cache.get(id);
      if (hit && hit.expires > now()) {
        const wait = draw(true);
        if (wait > 0) return source(throttled(wait));
        out = hit;
      } else {
        let p = inflight.get(id);
        const wait = draw(p !== undefined);
        if (wait > 0) return source(throttled(wait));
        if (!p) {
          p = call(name, v, up, path, qs, "", reserved).then((read) => {
            if ("fetchedAt" in read && read.status === 200) remember(id, read, up.cacheMs!);
            return read;
          });
          p.finally(() => inflight.delete(id)).catch(() => {});
          inflight.set(id, p);
        }
        out = await p;
      }
    } else {
      const wait = draw();
      if (wait > 0) return source(throttled(wait));
      out = await call(name, v, up, path, qs, up.method === "POST" ? body : "", reserved);
    }
    if (!("fetchedAt" in out)) return source(out);
    return source({ status: out.status, headers: { [HELPER_FETCHED_AT_HEADER]: out.fetchedAt }, body: out.body });
  }

  return { handle, keyCount: Object.keys(keys).length };
}
