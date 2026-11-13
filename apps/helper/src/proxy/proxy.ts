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
import { HELPER_FETCHED_AT_HEADER, HELPER_SOURCE_HEADER, HELPER_V1_PATHS, ONECLICK_USDC_ASSETS, type HelperV1Path } from "@blindfill/kit";
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
 * The vendors whose plan also names a second (card helper-crowd-429, fold 6): their sends are counted over BURST_MS
 * too, in turn, callers first. Jupiter's Free plan is "Free | 1 | 60", one request a second and 60 a minute
 * (developers.jup.ag/docs/api-rate-limit, read 2026-11-05 01:10Z), and its limiter counts a short window that takes a
 * burst: keyless (its "0.5 | 30") took 5 searches sent at once with 200, x-ratelimit-current 1 to 5, and its
 * x-ratelimit-reset 10 s after them; 7 at once 10 s later drew two 429s (read from the Mac 2026-11-06 03:30Z). Helper live
 * run 41943005189 (5 Nov 00:40Z): Jupiter answered 429 with the minute's budget not spent, its resets 1 and 4 s ahead, as
 * a window of 10 s fills. So a burst goes at once while the window has room, at the plan's second times BURST_MS (Free:
 * 10 in any 10 s, never more than its 60 in any minute); card helper-page-jup-429: one a second, every send, queued a
 * crowd's burst for seconds (live run 42155164828: a cold page's jup-turn 1915 ms behind six legs' builds). The others
 * publish a minute only.
 */
export const PACED: ReadonlySet<VendorName> = new Set(["jupiter"]);
/** The short window a PACED vendor's limiter counts (see PACED). */
export const BURST_MS = 10_000;
/** Of a PACED vendor's window, the sends the devices' calls leave to a page a caller waits for (a cold page's search)
 *  until a page has had them in the window: however many builds wait, a page's search still goes once a window. */
export const OWN_ROOM = 1;
/** Card jupiter-build-budget-503: of a PACED vendor's window, the sends the helper's own reads (pages, searches, fills,
 *  the lists) leave free for the devices' calls (a buy's or sell's build): they go only while BUILD_ROOM stay free (a
 *  page also on the OWN_ROOM the devices leave it), so a build that arrives after a crowd of them still goes at once.
 *  [design: 4, a device's share (PROXY_BUDGETS.jupiter.perClient): a one-leg trade's cap search and its floor rebuild;
 *  the own reads keep 6 of Free's 10 a window, 36 a minute, above their PROXY_RESERVE 34. Live run 42178532918
 *  attempt 1 (job 127762604763): S-1's build refused before its draw, its turn 5 s off, the window spent by reads.] */
export const BUILD_ROOM = 4;
/** Of a PACED vendor's window, the sends one device leaves to the other devices: Free's window of 10, less a page's 1
 *  (OWN_ROOM) and these 2, lets one device's trade send 7 builds at once; another device arriving after them still
 *  sends its first leg's build and its quote at once. A trade of more legs (up to 64, each up to 4 builds at once,
 *  packages/kit/src/trade/solana/flow.ts:99 and :434) waits for the window past its 7, as the kit's legs wait for room. */
export const OTHER_DEVICES_ROOM = 2;
export const QUEUE_POLL_MS = 250;
/** Past a hold's end, a wait's margin (card helper-rpc-wait-timing), as rpc.ts HOLD_MARGIN_MS: a timer can fire a few
 *  ms before the clock reads its end. */
const HOLD_MARGIN_MS = 5;
/** The most of one vendor's calls the other helpers may seed, for the vendors' `totals` (card helper-deploy-reads-fast):
 *  the largest total a minute, overrides included, and the second a counted minute spans (61 of 60). Card
 *  deposit-sheet-oneclick-budget review MEDIUM 1: a fixed 1,000 under 1Click's then 1,200 let a deploy's new helper count
 *  1,000 of the old one's calls and send 200 more, and 1Click's 429 held every call for its 60 s reset. */
export const vendorSeedMax = (totals: readonly number[]): number => Math.ceil((Math.max(0, ...totals) * 61) / 60);
/** The 1Click calls one deposit sheet open sends within a second (card deposit-sheet-oneclick-budget): deposit.assets
 *  reads the token list, then one dry quote per release asset at once (packages/signpage/src/rules/deposit-dry.ts
 *  depositAssetsKind over DEPOSIT_ASSET_CHAINS, the kit's ONECLICK_USDC_ASSETS in order), and deposit.dry one dry quote:
 *  5 for the 3 assets, one client's share of 1Click, so no other client's load can refuse it. That is while 1Click
 *  quotes: in a spell of its 400s not about the request, each dry quote is asked up to 3 times inside its 10 s
 *  (packages/wallet/src/deposit/quote.ts askDepositQuoteAgain), so one open sends up to 13 (1 + 3 x 3 + 3), past the
 *  share from its sixth (packages/signpage/test/deposit-dry-count.test.ts holds 13). */
export const DEPOSIT_SHEET_CALLS = ONECLICK_USDC_ASSETS.length + 2;
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
 * - oneclick: no limit in the docs (docs.near-intents.org 1click-api/authentication.md and the quote reference, read
 *   2026-11-08 02:39Z), but 1Click answers its own on every call: x-ratelimit-limit-unauth 1200 and
 *   x-ratelimit-reset-unauth 60 on /v0/quote and /v0/tokens, keyless and with our JWT alike, one counter for both
 *   (remaining 1197 then 1196, read from the Mac 02:40Z): 1200 less 200, so 1,000 (card deposit-sheet-oneclick-budget
 *   review MEDIUM 2): a handover's seed gap (the peers' files are read at a draw, not as each call is sent) and the send
 *   latency (a draw is counted by its whole second, and reaches 1Click up to a timeout later) can only make our count
 *   short of 1Click's, and one 429 holds every call for its 60 s reset. Share DEPOSIT_SHEET_CALLS 5: one deposit sheet
 *   open, within a second, and no override may name less (PROXY_MIN_SHARE). At 50 and 2 the sheet's third call went
 *   only as lent, and from the eighth sheet in a minute it answered 429 busy or 503 with 1Click idle. The share fits a
 *   sheet while 1Click quotes; in a spell of its 400s one open sends up to 13 (DEPOSIT_SHEET_CALLS), each past the
 *   fifth only as lent.
 */
export const PROXY_BUDGETS: Readonly<Record<VendorName, BudgetLimits>> = {
  jupiter: { total: 60, perClient: 4, windowMs: VENDOR_WINDOW_MS, reserve: 34, lend: true },
  relay: { total: 50, perClient: 2, windowMs: VENDOR_WINDOW_MS, reserve: 0, lend: true },
  lifi: { total: 100, perClient: 2, windowMs: VENDOR_WINDOW_MS, reserve: 0, lend: true },
  oneclick: { total: 1_000, perClient: DEPOSIT_SHEET_CALLS, windowMs: VENDOR_WINDOW_MS, reserve: 0, lend: true },
};
/** The least share PROXY_BUDGET_<VENDOR> may name (limits.ts budgetFromEnv minShare; deploy/redeploy.sh budget_ok holds
 *  the same): 1Click's is one deposit sheet open (card deposit-sheet-oneclick-budget review LOW 3: "50,2" brought the
 *  bug back), every other vendor's 1. */
export const PROXY_MIN_SHARE: Readonly<Record<VendorName, number>> = { jupiter: 1, relay: 1, lifi: 1, oneclick: DEPOSIT_SHEET_CALLS };
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
export type ProxyAnswer = { status: number; headers: Record<string, string>; body: string; why?: string; timing?: string[]; said?: Said };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Read = { status: number; body: string; fetchedAt: string; timing?: string[]; said?: Said };
/** What the vendor itself answered a call the proxy refused or passed on as not 2xx, for its log line (card
 *  helper-says-why-a-vendor-refused), never sent: its status, and its message as read (VENDOR_MESSAGE_MAX at most, made
 *  safe by safeMessage), null when the vendor's body held none; `message` left out when no body was read. */
type Said = { status?: number; message?: string | null };
/** The most of a vendor's message one log line keeps. */
export const VENDOR_MESSAGE_MAX = 200;
/** The window over which identical lines are folded into one with a count (card helper-says-why-a-vendor-refused): the
 *  helper's log keeps 2 MB in all (deploy/compose.yaml: json-file max-size 1m, max-file 2), so a crowd's identical
 *  refusals, one a request, would push the lines that name a cause out of it. [design: the refusal log's 10 s,
 *  limits.ts LIMIT_WINDOW_MS] */
export const SAID_FOLD_MS = 10_000;
/** The most distinct lines one fold window holds; past it, lines are counted, not kept. */
export const SAID_FOLD_KEYS = 256;
/** The vendor's message from its JSON body: `message` (a string, or strings joined), else `error` as a string or its
 *  `message`; null when it holds none. Hostile input: only strings are read. */
export function messageOf(text: string): string | null {
  let b: unknown;
  try {
    b = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof b !== "object" || b === null) return null;
  const o = b as Record<string, unknown>;
  const m = o.message;
  if (typeof m === "string") return m;
  if (Array.isArray(m) && m.length > 0 && m.every((x) => typeof x === "string")) return m.slice(0, 8).join("; ");
  const e = o.error;
  if (typeof e === "string") return e;
  const em = typeof e === "object" && e !== null ? (e as Record<string, unknown>).message : undefined;
  if (typeof em === "string") return em;
  return null;
}
/** The most of a vendor's message safeMessage reads (card helper-says-why-a-vendor-refused, review P1): a longer one is
 *  cut to it at its last whole word before any pass over it, so no pass costs more than it does whatever the vendor sent
 *  (ANSWER_MAX is 4 MB). The VENDOR_MESSAGE_MAX a line keeps come from it. */
export const VENDOR_MESSAGE_READ = 2_048;
/** The most values of the caller's request a message is made safe against; past it the vendor's message is withheld
 *  from the line. With VENDOR_MESSAGE_READ and VALUE_HEAD it bounds the work: at most 256 searches of at most 64
 *  characters over at most 2,048. */
export const REQUEST_VALUES_MAX = 256;
/** A request value longer than this is found by its first VALUE_HEAD characters, and the message ends where they stand
 *  (what follows may be the rest of the value). */
export const VALUE_HEAD = 64;
/** Every value of the caller's request of 3 characters or more, longest first: its JSON body's leaves and its query's
 *  values. No log line may carry one, since a vendor's message can echo what it was sent. Left out (re-review P2): the
 *  body's keys and its all-caps enum leaves (EXACT_INPUT, ORIGIN_CHAIN), the request's own schema, which is what a
 *  refusal names to say why ("recipient is not valid", "supports only ORIGIN_CHAIN refundType"); an address used as a
 *  key is still caught as an address (addressWord). null past REQUEST_VALUES_MAX. */
export function requestValues(body: string, rawQuery: string): string[] | null {
  const out = new Set<string>();
  const add = (v: string): boolean => {
    if (v.length >= 3 && !ENUM.test(v)) out.add(v);
    return out.size <= REQUEST_VALUES_MAX;
  };
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > 32) return true;
    if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") return add(String(v));
    if (Array.isArray(v)) return v.every((x) => walk(x, depth + 1));
    if (typeof v === "object" && v !== null) return Object.values(v).every((x) => walk(x, depth + 1));
    return true;
  };
  if (body !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // a body that is not JSON is never echoed into a line: the vendor's message is kept only through the words below
    }
    if (parsed !== undefined && !walk(parsed, 0)) return null;
  }
  for (const v of new URLSearchParams(rawQuery).values()) if (!add(v)) return null;
  return [...out].sort((a, b) => b.length - a.length);
}
/** An enum leaf of a request: the vendor's own words, never the user's. */
const ENUM = /^[A-Z][A-Z_]+$/;
/** The last label a NEAR named account may end in (near, tg, sweat, testnet), or the 64-hex implicit account a
 *  sub-account sits under. */
const NEAR_TOP = /^(near|tg|sweat|testnet|[0-9a-f]{64})$/;
/** A word of a message: a run of letters, digits, "_", ".", "-" and "…". Matched once over the message, never backed
 *  into (one character class), so the pass is linear in it. */
const WORD = /[0-9A-Za-z_.\-…]+/g;
const EDGE = new Set([".", "-", "…"]);
/**
 * True when a word is an address or a part of one, whatever the request held: an EVM address or hash (0x and 6 hex
 * digits or more), a hex id of 32 or more (a NEAR implicit account), a base58 run of 32 or more (a Solana key or
 * address, glued to others by "_", "." or "-" too), a shortened one ("9ddc51…", "0x8335...2913"), or a NEAR named
 * account in any case (a dotted name whose last label is in NEAR_TOP). A shortened one is 3 letters or digits and two
 * dots or more, or the ellipsis. What no pattern catches: a bare top-level name
 * ("alice") or a name under a top-level name not in NEAR_TOP, which reads as any other word; a value of the request is
 * caught however it reads (requestValues).
 */
function addressWord(w: string): boolean {
  if (/[0-9A-Za-z]{3}(\.{2,}|…)/.test(w)) return true;
  let a = 0;
  let b = w.length;
  while (a < b && EDGE.has(w[a]!)) a++;
  while (b > a && EDGE.has(w[b - 1]!)) b--;
  const t = w.slice(a, b);
  const lower = t.toLowerCase();
  if (/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(lower) && NEAR_TOP.test(lower.slice(lower.lastIndexOf(".") + 1))) return true;
  return t.split(/[_.\-…]+/).some((p) => /^0x[0-9a-f]{6,}$/i.test(p) || /^[0-9a-f]{32,}$/i.test(p) || /^[1-9A-HJ-NP-Za-km-z]{32,}$/.test(p));
}
const ALNUM = /[0-9A-Za-z]/;
const alnumAt = (s: string, i: number): boolean => ALNUM.test(s.charAt(i)); // "" past either end
/** `s` with `v` replaced where it stands alone, not inside a longer run of letters or digits (re-review P2: the 100 of
 *  a slippage inside "1000000" is the vendor's number, not the request's). A value longer than VALUE_HEAD is found by its
 *  first VALUE_HEAD characters, and the message ends there. */
function valueReplaced(s: string, v: string): string {
  const head = v.length > VALUE_HEAD ? v.slice(0, VALUE_HEAD) : v;
  let out = "";
  let from = 0;
  for (let at = s.indexOf(head); at >= 0; at = s.indexOf(head, at + 1)) {
    if (at < from || alnumAt(s, at - 1)) continue;
    if (head !== v) return `${out}${s.slice(from, at)}<request field>`;
    if (alnumAt(s, at + v.length)) continue;
    out += `${s.slice(from, at)}<request field>`;
    from = at + v.length;
  }
  return out + s.slice(from);
}
/**
 * A vendor's message made safe for one log line, every step linear in VENDOR_MESSAGE_READ: cut to it at its last whole
 * word (a word cut in two is one no pattern knows); zero-width and direction marks stripped and %XX decoded once;
 * every request value replaced where it stands alone, and a value's start where the cut message ends; every control and line-separator character a space; every address word replaced (addressWord); cut to
 * VENDOR_MESSAGE_MAX characters. `values` null (past REQUEST_VALUES_MAX): the message is withheld.
 */
export function safeMessage(m: string, values: readonly string[] | null): string {
  if (values === null) return "(withheld: the request held too many values)";
  let s = m;
  const cut = s.length > VENDOR_MESSAGE_READ;
  if (cut) {
    let i = VENDOR_MESSAGE_READ;
    while (i > 0 && !/\s/.test(s[i - 1]!)) i--;
    s = s.slice(0, i);
  }
  // marks that hide a word from a search, stripped (never a space, which would split it), then one %XX decode
  s = s.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "");
  s = s.replace(/%([0-9A-Fa-f]{2})/g, (x, h: string) => (parseInt(h, 16) < 0x80 ? String.fromCharCode(parseInt(h, 16)) : x));
  for (const v of values) s = valueReplaced(s, v);
  // a value whose start ends the cut message: its first characters, cut from the rest
  if (cut)
    for (const v of values)
      for (let p = Math.max(0, s.length - VALUE_HEAD); p <= s.length - 3; p++)
        if (!alnumAt(s, p - 1) && v.startsWith(s.slice(p))) {
          s = `${s.slice(0, p)}<request field>`;
          break;
        }
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  s = s.replace(WORD, (w) => (addressWord(w) ? "<address>" : w));
  return [...s].slice(0, VENDOR_MESSAGE_MAX).join("");
}
/** `peers` (card helper-deploy-reads-fast): the other helpers on the same keys (shared-calls.ts callsFiles), whose calls
 *  every draw that may reach a vendor counts first, and to which each such draw is told at once. */
export type Peers = { read(): unknown; write(calls: Record<string, number[]>): void };
/** `now` is the wall clock in ms (dates and the vendors' resets); `mono` is the monotonic clock in ms the elapsed times read
 *  (a turn's wait, a send's duration: the turn log line and Server-Timing), performance.now by default. A test injects both
 *  so an elapsed time is a value it sets, never the machine's speed (card helper-jup-log-clock: "answered 200 in 1 ms" on a
 *  busy CI runner where 0 was expected). */
type Deps = { fetch?: Fetch; now?: () => number; mono?: () => number; sleep?: (ms: number) => Promise<void>; peers?: Peers; log?: (line: string) => void; burstMs?: number; foldWait?: (ms: number) => Promise<void> };

const error = (status: number, code: string): ProxyAnswer => ({ status, headers: {}, body: JSON.stringify({ error: { code } }) });
/**
 * What a 503 upstream answered for (card helper-page-jup-429), its Server-Timing entry `cause;desc="<cause>"`, so a red
 * live run reads its cause off the answer (live run 42143211092: a Jupiter build's bare 503 named none):
 * - 429: the vendor answered this call 429 and its reset, or a third 429, came past the call's wait;
 * - held: an earlier call's 429 holds the vendor past this call's wait;
 * - budget: the vendor's total (our count of its plan) has no room by the call's wait;
 * - 5xx: the vendor failed, and again on the retry;
 * - timeout: the vendor sent nothing within TIMEOUT_MS;
 * - send: the call never reached the vendor (a network failure), and again on the retry;
 * - key: the vendor refused our key (401, 403);
 * - answer: an answer we cannot pass as JSON data (a redirect, another type, past ANSWER_MAX, holding a key).
 */
export type Cause = "429" | "held" | "budget" | "5xx" | "timeout" | "send" | "key" | "answer";
/** Sends one call makes when the vendor answers 429, each after the reset it names and only while that ends inside the
 *  call's wait [design: the industry's bounded retry; three, as Jupiter's resets read 1 and 4 s (live run 41943005189) and a
 *  build's wait is QUEUE_WAIT_MS]. */
export const SENDS_429 = 3;
/** The wait before the one retry of a GET the vendor failed (5xx) or that never reached it [design: a quarter second,
 *  a common opening backoff step; a GET is a read, so its retry is safe; a POST is never sent twice]. */
export const RETRY_FAILED_MS = 250;
/** The 503 upstream with its cause, the call's own waits before it (`timing`) and, for the refusal log, `why`. */
const UPSTREAM = (cause: Cause, why?: string, timing: string[] = []): ProxyAnswer => ({ ...error(503, "upstream"), timing: [...timing, `cause;desc="${cause}"`], ...(why === undefined ? {} : { why }) });
/** The not-ready form (503 upstream, the device's fallback, H2.3) for a vendor's hold or room: `why` names it for the
 *  refusal log, never sent. `retryAfterS`: the seconds until the vendor's total has the room (card solana-legs-share-wait),
 *  so a device waits it out and asks again; a hold whose end is not known names none. */
const notReady = (cause: Cause, why: string, retryAfterS?: number, timing: string[] = []): ProxyAnswer => ({ ...UPSTREAM(cause, why, timing), ...(retryAfterS ? { headers: { "Retry-After": String(retryAfterS) } } : {}) });

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

/** Every string of a parsed JSON value, its keys included, one a line (no key form holds a line break, KEY_SHAPE), so a
 *  key the JSON spelt escaped is read as it is. Walked without recursion: a 4 MB answer may nest deep. */
function decodedStrings(v: unknown): string {
  const out: string[] = [];
  const todo: unknown[] = [v];
  while (todo.length > 0) {
    const x = todo.pop();
    if (typeof x === "string") out.push(x);
    else if (Array.isArray(x)) for (const y of x) todo.push(y);
    else if (typeof x === "object" && x !== null) for (const [k, y] of Object.entries(x)) out.push(k), todo.push(y);
  }
  return out.join("\n");
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
  const mono = deps.mono ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const log = deps.log ?? ((line: string) => console.log(`helper: ${line}`));
  /** The short window PACED vendors count (BURST_MS); 0 counts the minute alone, as a vendor that publishes no second. */
  const burstMs = deps.burstMs ?? BURST_MS;
  const keys = readKeys(env);
  const forms = keyForms(keys);
  const limits = Object.fromEntries(VENDOR_NAMES.map((v) => [v, { ...budgetFromEnv(env, proxyBudgetEnv(v), PROXY_BUDGETS[v], { reserve: PROXY_RESERVE[v], minShare: PROXY_MIN_SHARE[v] }), windowMs: VENDOR_WINDOW_MS, reserve: PROXY_RESERVE[v], lend: true }])) as Record<VendorName, BudgetLimits>;
  const budget = upstreamBudget((v) => limits[v as VendorName], now);
  /** The most of a vendor's calls the other helpers' files may seed: the largest total this helper runs (vendorSeedMax). */
  const seedMax = vendorSeedMax(VENDOR_NAMES.map((v) => limits[v].total));
  /** Each vendor's calls this helper made that its window may still count (card helper-deploy-reads-fast). */
  const calls = (): Record<string, number[]> => Object.fromEntries(VENDOR_NAMES.map((v) => [v, budget.calls(v)]));
  /** The other helpers' calls on the same keys (hostile input: whole ms numbers no later than a second from now,
   *  seedMax a vendor at most, the newest kept), counted in each vendor's budget in place of the last seed: a
   *  vendor counts every call on its key, and while a deploy's two helpers overlapped each one counted only its own,
   *  so together they drew Jupiter past its minute (live run 42125976095 attempt 1: helper-token-page-cold, a page 503
   *  "jupiter held" after Jupiter's 429). */
  function seed(vendors: unknown): void {
    const o = typeof vendors === "object" && vendors !== null && !Array.isArray(vendors) ? (vendors as Record<string, unknown>) : {};
    for (const v of VENDOR_NAMES) {
      const t = Object.hasOwn(o, v) && Array.isArray(o[v]) ? (o[v] as unknown[]).filter((x): x is number => typeof x === "number" && Number.isSafeInteger(x) && x <= now() + 1_000).sort((x, y) => x - y).slice(-seedMax) : [];
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
  /** Waits for the vendor's hold to end (a vendor not PACED); false when it ends past `by`. One look again after the
   *  wait, at a hold set meanwhile, so a clock that does not move still ends it. */
  async function turn(name: VendorName, by: number): Promise<boolean> {
    for (let round = 0; round < 3; round++) {
      const t = now();
      const at = Math.max(t, budget.heldUntil(name));
      if (at > by) return false;
      if (at > t) await sleep(at - t);
      if (budget.heldUntil(name) <= now()) return true;
    }
    return false;
  }

  /**
   * Card helper-page-jup-429: a PACED vendor's sends are counted over BURST_MS, at most burstOf(vendor) in any window
   * (Free: 10), every send counted. Card jupiter-build-budget-503: the calls waiting for a turn go in three lanes, in
   * order (laneOf): a device's call (a build), then a page a caller waits for (a cold page's search), then the helper's
   * background reads (the lists, a held page's refresh, each waiting up to a window); a lane goes only when no lane
   * before it has a call with room. Each lane has its room (freeAt): the devices leave a page OWN_ROOM of the window
   * until a page has had it, and one device leaves the other devices OTHER_DEVICES_ROOM, so no crowd of builds holds a
   * page past a window or another device's first leg (fold 4); the own reads go only while they leave BUILD_ROOM free
   * for builds (a page also on its OWN_ROOM), so no crowd of pages, searches, fills or lists holds a build, and the
   * lists still have the own reads' part of each window (fold 5). Among the devices, the one with the fewest sends in the window goes first, so one device's legs never hold
   * another device's first build. A background read whose wait would end before a page's next turn takes that page's
   * turn, never two turns running. A call whose turn would come past its `by` goes not ready, nothing sent. Each send
   * logs one line (logTurn).
   */
  /** `go(waitS)`: 0 when the turn is this call's, else the seconds until a turn would come (the queue ahead of it). */
  type Waiter = { caller: boolean; own: boolean; client?: string; by: number; go: (waitS: number) => void };
  const queues = new Map<VendorName, Waiter[]>();
  /** Each paced vendor's newest sends, burstOf(vendor) at most, dated by the clock as read when each turn was given. */
  const sent = new Map<VendorName, number[]>();
  /** Of them, the pages' (a search a caller waits for), so a page takes the window's last send only once a window. */
  const sentPage = new Map<VendorName, number[]>();
  /** Each device's sends in the window, so one device leaves the others OTHER_DEVICES_ROOM (fold 4). */
  const sentByClient = new Map<VendorName, Map<string, number[]>>();
  /** When each paced vendor's pending wake (pump's sleep) ends: a call that arrives meanwhile still gets its turn at once
   *  when its room has one (a page past a queue of builds), and a sooner wake is set when one is needed. */
  const wakeAt = new Map<VendorName, number>();
  /** Until when each paced vendor's sends go one a turn after its 429 (see the 429 below). */
  const recoverUntil = new Map<VendorName, number>();
  /** Whether each paced vendor's last turn went to a caller. */
  const lastWasCaller = new Map<VendorName, boolean>();
  const burstOf = (name: VendorName): number => Math.max(1, Math.floor((limits[name].total * burstMs) / VENDOR_WINDOW_MS));
  type Lane = { caller: boolean; own: boolean; client?: string };
  /** The lane a call waits in, served in this order: 0 a device's call, 1 a page a caller waits for, 2 a background read. */
  const laneOf = (w: Lane): 0 | 1 | 2 => (w.caller && !w.own ? 0 : w.caller ? 1 : 2);
  /** A device's sends in the BURST_MS to `t`. */
  const sendsOf = (name: VendorName, client: string | undefined, t: number): number => (client === undefined ? 0 : (sentByClient.get(name)?.get(client) ?? []).filter((x) => x > t - burstMs).length);
  /** The turns that go before `q[i]`'s, [all of them, of them its own device's]: in an own read's lane the ones queued
   *  ahead of it in its lane (a device's call takes no turn an own read has room for); among the devices pump's fair
   *  order: its device's calls queued ahead of it, and each other device's while that device has fewer sends in the
   *  window (one more on a tie, when it queued first). */
  function aheadOf(name: VendorName, q: readonly Lane[], i: number, t: number): [number, number] {
    const w = q[i]!;
    const lane = laneOf(w);
    if (lane !== 0) return [q.slice(0, i).filter((x) => laneOf(x) === lane).length, 0];
    const j = q.slice(0, i).filter((x) => laneOf(x) === 0 && x.client === w.client).length;
    const mine = sendsOf(name, w.client, t) + j;
    const others = new Map<string | undefined, { n: number; first: boolean }>();
    for (let k = 0; k < q.length; k++) {
      const x = q[k]!;
      if (k === i || laneOf(x) !== 0 || x.client === w.client) continue;
      const o = others.get(x.client) ?? { n: 0, first: k < i };
      o.n++;
      others.set(x.client, o);
    }
    let n = j;
    for (const [c, o] of others) n += Math.min(o.n, Math.max(0, mine - sendsOf(name, c, t) + (o.first ? 1 : 0)));
    return [n, j];
  }
  /** When the turn `k` turns from now (0: the next) is free for a lane at a PACED vendor: the first moment at or after
   *  `t`, after the vendor's hold, with room for the lane in the BURST_MS before it, the turns before it counted as sent
   *  (`kMine` of them its own device's). The window, Free's 10: the devices' calls may take all but its last OWN_ROOM
   *  until a page has had it in the window, then all, one device's leaving the other devices OTHER_DEVICES_ROOM; the
   *  own reads go only while BUILD_ROOM stay free; and a page with no page sent in the window also takes the last
   *  OWN_ROOM the devices leave. So the builds always keep BUILD_ROOM less a page's OWN_ROOM (3 of Free's 10), and take
   *  what the own reads leave. */
  function freeAt(name: VendorName, t: number, w: Lane, k = 0, kMine = k): number {
    const burst = burstOf(name);
    const times = [...(sent.get(name) ?? [])];
    const pages = (sentPage.get(name) ?? []).filter((x) => x > t - burstMs);
    const lane = laneOf(w);
    // the first moment `list` holds fewer than `room` sends in the window (Infinity: no room ever); a vendor counted
    // over its minute alone (burstMs 0) has room at once
    const roomIn = (list: readonly number[], room: number): number => (burstMs === 0 ? t : room <= 0 ? Infinity : list.length < room ? t : list[list.length - room]! + burstMs);
    // one device's sends keep OTHER_DEVICES_ROOM of the window for the other devices (fold 4)
    const mine = lane !== 0 || w.client === undefined ? null : [...(sentByClient.get(name)?.get(w.client) ?? [])];
    const cap = Math.max(1, burst - OWN_ROOM - OTHER_DEVICES_ROOM);
    // the most sends any other device has in the window
    let mostOthers = 0;
    if (mine !== null) for (const [c, v] of sentByClient.get(name) ?? []) if (c !== w.client) mostOthers = Math.max(mostOthers, v.filter((x) => x > t - burstMs).length);
    let f = t;
    for (let i = 0; i <= k; i++) {
      // the devices leave a page OWN_ROOM until a page has had it in the window; an own read has the room BUILD_ROOM
      // leaves, and a page also the last OWN_ROOM
      const shared = roomIn(times, burst - BUILD_ROOM);
      const devices = Math.max(1, burst - Math.max(0, OWN_ROOM - pages.length));
      const room = lane === 0 ? roomIn(times, devices) : lane === 1 ? Math.min(shared, Math.max(roomIn(pages, OWN_ROOM), roomIn(times, burst))) : shared;
      f = Math.max(t, budget.heldUntil(name), room);
      if (mine !== null && mine.length >= cap) f = Math.max(f, mine[mine.length - cap]! + burstMs);
      // card jupiter-build-budget-503: the device with the most sends in the window, past its first OTHER_DEVICES_ROOM,
      // sends only while it leaves OTHER_DEVICES_ROOM of what the window still holds for the other devices (with the own
      // reads holding their part, one device's legs took the builds' whole room: live runs 42207995804 and 42210110244,
      // S-1 refused before its send, its turn 4 s off); a lighter device is never held for the heavy one's room
      const mineIn = mine === null ? 0 : mine.filter((x) => x > f - burstMs).length;
      if (mine !== null && mineIn >= OTHER_DEVICES_ROOM && mineIn >= mostOthers) f = Math.max(f, roomIn(times, devices - OTHER_DEVICES_ROOM));
      if (f < (recoverUntil.get(name) ?? -Infinity) && times.length > 0) f = Math.max(f, times.at(-1)! + burstMs / burst);
      times.push(f);
      if (lane === 1) pages.push(f);
      if (i < kMine) mine?.push(f);
    }
    return f;
  }
  /** Gives each free turn by lane (laneOf): a device's call with room, the device with the fewest sends in the window
   *  first; else the first page with room; else the first background read; `reached`: the time a wait was for, so a
   *  clock that does not move still reaches it. */
  function pump(name: VendorName, reached = -Infinity): void {
    const q = queues.get(name);
    if (q === undefined) return;
    for (;;) {
      if (q.length === 0) return;
      // the turn is dated by the clock as read, so a clock that does not move never runs ahead of itself
      const read = now();
      const t = Math.max(read, reached);
      // a call whose turn would come past its wait goes not ready, told the seconds until it would come
      const ahead = q.map((_, i) => aheadOf(name, q, i, t));
      for (let i = q.length - 1; i >= 0; i--) {
        const at = freeAt(name, t, q[i]!, ...ahead[i]!);
        if (q[i]!.by < at) q.splice(i, 1)[0]!.go(Math.max(1, Math.ceil((at - t) / 1000)));
      }
      if (q.length === 0) return;
      // a device's call whose room has a turn now, of the device with the fewest sends in the window (the first queued
      // on a tie); else the first page with room; else the first background read. A background read whose wait would end
      // before a page's next turn takes the page's, unless the last turn was a background read's too
      let d = -1;
      for (let k = 0; k < q.length; k++) {
        const w = q[k]!;
        if (laneOf(w) !== 0 || freeAt(name, t, w) > t) continue;
        if (d === -1 || sendsOf(name, w.client, t) < sendsOf(name, q[d]!.client, t)) d = k;
      }
      const c = q.findIndex((w) => laneOf(w) === 1 && freeAt(name, t, w) <= t);
      const b = q.findIndex((w) => laneOf(w) === 2);
      const backFree = b === -1 ? Infinity : freeAt(name, t, q[b]!);
      const starving = b !== -1 && c !== -1 && q[b]!.by < freeAt(name, t, q[c]!, 1) && lastWasCaller.get(name) !== false;
      const i = d !== -1 ? d : c !== -1 ? (starving ? b : c) : backFree <= t ? b : -1;
      if (i !== -1) {
        lastWasCaller.set(name, q[i]!.caller);
        sent.set(name, [...(sent.get(name) ?? []), read].slice(-burstOf(name)));
        if (laneOf(q[i]!) === 1) sentPage.set(name, [...(sentPage.get(name) ?? []), read].slice(-burstOf(name)));
        const who = q[i]!.client;
        if (who !== undefined && !q[i]!.own) {
          const byClient = sentByClient.get(name) ?? new Map<string, number[]>();
          for (const [k, v] of byClient) if (v.every((x) => x <= read - burstMs)) byClient.delete(k);
          byClient.set(who, [...(byClient.get(who) ?? []), read].slice(-burstOf(name)));
          sentByClient.set(name, byClient);
        }
        q.splice(i, 1)[0]!.go(0);
        reached = -Infinity;
        continue;
      }
      const until = Math.min(backFree, ...q.filter((w) => w.caller).map((w) => freeAt(name, t, w)));
      if ((wakeAt.get(name) ?? Infinity) <= until) return;
      wakeAt.set(name, until);
      void sleep(until - t).then(() => {
        if (wakeAt.get(name) === until) wakeAt.delete(name);
        pump(name, until);
      });
      return;
    }
  }
  /** When a call asking now would have its turn at a PACED vendor: after the calls queued that go before it (aheadOf),
   *  so a call whose turn would come past its wait is refused before it draws the budget, never drawing for a send it
   *  will not make (a drawn call counts in the vendor's minute whether it goes or not). */
  function turnAt(name: VendorName, caller: boolean, own: boolean, client?: string): number {
    const w = { caller, own, client };
    const q = [...(queues.get(name) ?? []), w];
    return freeAt(name, now(), w, ...aheadOf(name, q, q.length - 1, now()));
  }
  /** The PACED vendor's sends in the BURST_MS to now, for the turn's log line. */
  const inWindow = (name: VendorName): number => (sent.get(name) ?? []).filter((x) => x > now() - burstMs).length;
  /**
   * One line a PACED vendor's send (card helper-page-jup-429: the live run that held a cold page 1915 ms had no read of
   * what took the turns ahead of it): the lane, the call's wait for its turn, the window's sends, what the vendor
   * answered and in how long, and its own count when it names one (x-ratelimit-remaining and the reset's seconds ahead,
   * whole numbers only: hostile input). No path, query, body, key or client.
   */
  function logTurn(name: VendorName, caller: boolean, waitMs: number, answer: string, sendMs: number, h?: Headers): void {
    const n = (v: string | null): number | null => (v !== null && /^\d{1,12}$/.test(v) ? Number(v) : null);
    const left = n(h?.get("x-ratelimit-remaining") ?? null);
    const reset = n(h?.get("x-ratelimit-reset") ?? null);
    const ahead = reset === null ? null : Math.round(reset - now() / 1000);
    log(`${name} turn: ${caller ? "caller" : "background"}, waited ${Math.round(waitMs)} ms, ${inWindow(name)} of ${burstOf(name)} sent in ${burstMs / 1000} s, answered ${answer} in ${Math.round(sendMs)} ms${left === null ? "" : `, vendor remaining ${left}`}${ahead === null ? "" : `, reset in ${ahead} s`}`);
  }
  /** This call's turn at a PACED vendor (pump): 0 when it is this call's, else the seconds until one would come. */
  function paced(name: VendorName, by: number, caller: boolean, own: boolean, client?: string): Promise<number> {
    return new Promise((go) => {
      let q = queues.get(name);
      if (q === undefined) queues.set(name, (q = []));
      q.push({ caller, own, client, by, go });
      pump(name);
    });
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

  async function call(name: VendorName, v: Vendor, up: Upstream, path: string, query: string, body: string, reserved: boolean, by: number, caller: boolean, client?: string): Promise<Read | ProxyAnswer> {
    // the seconds to the vendor's reset, for the not-ready answer's Retry-After
    const heldS = (): number => Math.max(1, Math.ceil((budget.heldUntil(name) - now()) / 1000));
    // the call's own waits, for its Server-Timing (ProxyAnswer.timing), on a 200 and on a 503 alike
    let turnMs = 0;
    let refusals = 0;
    let failures = 0;
    const waits = (): string[] => [`turn;dur=${Math.round(turnMs)}`, ...(refusals > 0 ? [`429;desc="${refusals}"`] : []), ...(failures > 0 ? [`retry;desc="${failures}"`] : [])];
    // card helper-page-jup-429: a GET the vendor failed or never got is read once more after RETRY_FAILED_MS, while that
    // is inside the call's wait; else the 503 names the cause
    const again = (): boolean => up.method === "GET" && failures === 0 && now() + RETRY_FAILED_MS <= by && (failures++, true);
    for (let attempt = 0; ; attempt++) {
      // the vendor's reset holds every call to it: waited out when it ends by `by`, else not ready (never our 429)
      const t0 = mono();
      const late = PACED.has(name) ? await paced(name, by, caller, reserved, client) : (await turn(name, by)) ? 0 : heldS();
      // card helper-rpc-wait-timing: a turn given at the hold's end (pump's wake) can find the clock a few ms inside it,
      // as Node dates a timer from the event loop's clock read when its turn began (lib/internal/timers.js getLibuvNow);
      // the rest is waited out while it ends by `by`, a few rounds at most so a clock that does not move still ends it,
      // and the send is drawn after it (PR #342 test-packages job 127786967728: the retry's draw refused as held, a 503)
      for (let round = 0; late === 0 && round < 3 && budget.heldUntil(name) > now() && budget.heldUntil(name) <= by; round++) await sleep(budget.heldUntil(name) - now() + HOLD_MARGIN_MS);
      const thisTurnMs = mono() - t0;
      turnMs += thisTurnMs;
      // past the wait: Jupiter's hold (a 429's reset) when it is held, else the turns ahead (our pace of its plan)
      if (late > 0) return budget.heldUntil(name) > now() || !PACED.has(name) ? notReady(refusals > 0 ? "429" : "held", `${name} held`, Math.max(late, heldS()), waits()) : notReady("budget", `${name} turn`, late, waits());
      if (attempt > 0) {
        // the retry reaches the vendor again, so it draws from the total too
        if (drawUp(name, undefined, reserved) > 0) {
          const why = budget.refusedBy();
          return notReady(why.endsWith(" held") ? (refusals > 0 ? "429" : "held") : "budget", why, undefined, waits());
        }
      }
      const headers: Record<string, string> = { accept: "application/json" };
      const key = keys[name];
      if (key) headers[v.header] = key;
      if (up.method === "POST") headers["content-type"] = "application/json";
      let r: Response;
      let text: string | undefined;
      let logged = false;
      const sentAt = mono();
      try {
        r = await doFetch(`${v.base}${path}${query}`, {
          method: up.method,
          headers,
          body: up.method === "POST" ? body : undefined,
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (PACED.has(name)) logTurn(name, caller, thisTurnMs, String(r.status), mono() - sentAt, r.headers), (logged = true);
        if (r.status === 429) {
          await r.body?.cancel();
          refusals++;
          // the vendor is held until its reset, for every caller; this call reads again once it ends, if that is by
          // `by` (turn), up to SENDS_429 sends in all (card helper-page-jup-429: one retry left a second 429 a 503)
          const wait = Math.max(resetMs(r.headers, now()), 0);
          budget.hold(name, now() + (wait <= WAIT_MAX_MS ? wait : upstreamRetryAfterS(r.headers, now()) * 1000));
          // a PACED vendor's 429 means its window is full whatever we counted: for a window past the reset its sends go
          // one a turn (BURST_MS / burst), so the hold's end is no burst (fold 6)
          if (PACED.has(name)) recoverUntil.set(name, budget.heldUntil(name) + burstMs);
          if (refusals < SENDS_429) continue;
          return { ...notReady("429", `${name} provider 429`, heldS(), waits()), said: { status: 429 } };
        }
        if (r.status >= 500 && r.status < 600) {
          await r.body?.cancel();
          if (again()) {
            await sleep(RETRY_FAILED_MS);
            continue;
          }
          return { ...UPSTREAM("5xx", `${name} 5xx`, waits()), said: { status: r.status } };
        }
        text = await readBody(r);
      } catch (e) {
        const timeout = (e as Error | null)?.name === "TimeoutError";
        if (PACED.has(name) && !logged) logTurn(name, caller, thisTurnMs, timeout ? "timeout" : "send", mono() - sentAt);
        if (!timeout && again()) {
          await sleep(RETRY_FAILED_MS);
          continue;
        }
        return UPSTREAM(timeout ? "timeout" : "send", `${name} ${timeout ? "timeout" : "send"}`, waits());
      }
      const fetchedAt = new Date(now()).toISOString();
      // card helper-says-why-a-vendor-refused: what the vendor answered, for the log line of an answer that is not 2xx
      const said: Said = { status: r.status, ...(text === undefined ? {} : { message: messageOf(text) }) };
      // our key refused (401, 403), or an answer we cannot pass as JSON data
      if (r.status === 401 || r.status === 403) return { ...UPSTREAM("key", `${name} key`, waits()), said };
      if (r.status < 200 || (r.status >= 300 && r.status < 400)) return { ...UPSTREAM("answer", `${name} answer`, waits()), said };
      if (text === undefined || !/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(r.headers.get("content-type") ?? "")) return { ...UPSTREAM("answer", `${name} answer`, waits()), said: { status: r.status } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ...UPSTREAM("answer", `${name} answer`, waits()), said: { status: r.status } };
      }
      // card helper-says-why-a-vendor-refused, review P3: a key holding ", \ or / is spelt escaped in JSON; its decoded
      // strings are read too, only when the text holds an escape (re-review P3: every answer's walk cost 4 times its parse)
      if (holdsKey(text) || (text.includes("\\") && holdsKey(decodedStrings(parsed)))) return { ...UPSTREAM("answer", `${name} answer`, waits()), said: { status: r.status } };
      const timing = [...waits(), `send;dur=${Math.round(mono() - sentAt)}`];
      return { status: r.status, body: text, fetchedAt, timing, ...(r.status >= 200 && r.status < 300 ? {} : { said }) };
    }
  }

  /**
   * One proxied call: `vendor` and `path` as the caller wrote them, `rawQuery` the text after "?" (or ""), `body` the
   * request body, `client` the caller's address (../limits/limits.ts clientOf). The helper's own reads (Discover's
   * lists, the token page) pass none: they draw from the vendor's total, never a caller's share; `reserved` marks the
   * ones PROXY_RESERVE holds room for, which alone may draw it. `caller` (card helper-page-jup-429): the call is a
   * caller's, which goes ahead of the helper's background reads for a PACED vendor's turn: every call with a client, and
   * an own read a caller waits for (the token page's cold search).
   */
  async function answer(vendor: string, path: string, rawQuery: string, body: string, client?: string, reserved = false, waitMs?: number, caller = client !== undefined): Promise<ProxyAnswer> {
    // card helper-page-jup-429: an own read nobody waits for (the lists, a held page's refresh) waits up to a window
    // (BURST_MS) for its turn, so a burst that filled the window delays it, never drops it
    const wait = waitMs ?? (reserved && !caller ? BURST_MS : QUEUE_WAIT_MS);
    const by = now() + wait;
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
        for (let round = 0; last > 0 && round * QUEUE_POLL_MS < wait; round++) {
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
      return why.endsWith(" share") ? throttled(wait, undefined, why) : notReady(why.endsWith(" held") ? "held" : "budget", why, wait, [`budget;dur=${Math.round(mono() - b0)}`]);
    };
    // when the draw began, for the budget's wait in Server-Timing
    const b0 = mono();
    // card helper-page-jup-429: a PACED vendor's turn that would come past the wait is refused before any draw
    const lateTurn = (): ProxyAnswer | null => {
      if (!PACED.has(name)) return null;
      const at = turnAt(name, caller, reserved, client);
      if (at <= by) return null;
      const s = Math.max(1, Math.ceil((at - now()) / 1000));
      return budget.heldUntil(name) > now() ? notReady("held", `${name} held`, s) : notReady("budget", `${name} turn`, s);
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
        const late = p === undefined ? lateTurn() : null;
        if (late !== null) return source(late);
        const first = draw(p !== undefined);
        const wait = typeof first === "number" ? first : await first;
        budgetMs = mono() - b0;
        if (wait > 0) return source(refused(wait));
        // a read another call began while this one waited is joined, not sent twice
        p ??= inflight.get(id);
        if (!p) {
          p = call(name, v, up, path, qs, "", reserved, by, caller, client).then((read) => {
            if (up.cacheMs && "fetchedAt" in read && read.status === 200) remember(id, read, up.cacheMs);
            return read;
          });
          p.finally(() => inflight.delete(id)).catch(() => {});
          inflight.set(id, p);
        }
        out = await p;
      }
    } else {
      const late = lateTurn();
      if (late !== null) return source(late);
      const wait = await draw();
      if (wait > 0) return source(refused(wait));
      out = await call(name, v, up, path, qs, up.method === "POST" ? body : "", reserved, by, caller, client);
    }
    if (!("fetchedAt" in out)) return source(out.timing ? { ...out, timing: [`budget;dur=${Math.round(budgetMs)}`, ...out.timing] } : out);
    return source({ status: out.status, headers: { [HELPER_FETCHED_AT_HEADER]: out.fetchedAt }, body: out.body, ...(out.timing ? { timing: [`budget;dur=${Math.round(budgetMs)}`, ...out.timing] } : {}), ...(out.said ? { said: out.said } : {}) });
  }

  /** Identical lines in the fold window (SAID_FOLD_MS): the first is written at once, the rest counted and written as one
   *  line when the window ends. */
  const folded = new Map<string, number>();
  let foldedOver = 0;
  let folding = false;
  function sayOnce(line: string): void {
    const n = folded.get(line);
    if (n !== undefined) folded.set(line, n + 1);
    else if (folded.size >= SAID_FOLD_KEYS) foldedOver++;
    else {
      folded.set(line, 0);
      log(line);
    }
    if (folding) return;
    folding = true;
    // its own timer, never the proxy's `sleep` (a test's virtual clock would move for it), and one that never holds the
    // process open (a test's end, the helper's stop)
    const windowEnd = deps.foldWait ? deps.foldWait(SAID_FOLD_MS) : new Promise<void>((ok) => setTimeout(ok, SAID_FOLD_MS).unref());
    void windowEnd.then(() => {
      for (const [l, more] of folded) if (more > 0) log(`${l} (and ${more} more in ${SAID_FOLD_MS / 1000} s)`);
      if (foldedOver > 0) log(`proxy: ${foldedOver} more answers not 2xx in ${SAID_FOLD_MS / 1000} s, past ${SAID_FOLD_KEYS} distinct lines`);
      folded.clear();
      foldedOver = 0;
      folding = false;
    });
  }
  /** Causes of a 503 that are the vendor's own (Cause): its 429, its failure, its silence, never reached, its refusal of
   *  our key, an answer we could not pass. "held" and "budget" are ours. */
  const VENDOR_CAUSES: ReadonlySet<string> = new Set(["429", "5xx", "timeout", "send", "key", "answer"]);
  /**
   * One proxied call (answer), and card helper-says-why-a-vendor-refused: an answer that is not 2xx is logged in one line,
   * "proxy <vendor> <path> answered <status>, <ours|the vendor's>: <what>", folded with the same line in SAID_FOLD_MS.
   * The vendor's: its status (and the 503's cause), and its message made safe (safeMessage); ours: the refusal's name.
   * The answer's Server-Timing gains refusal;desc="vendor" or refusal;desc="ours", for our Node live check: a browser on
   * SIGN_HOST cannot read the header (it is not exposed and names no Timing-Allow-Origin), and the device tells a refusal
   * by its status and body (packages/wallet/src/deposit/quote.ts refusalOf).
   * A vendor or path not on the list is never written as the caller wrote it; no query, body field, key or client.
   */
  async function handle(vendor: string, path: string, rawQuery: string, body: string, client?: string, reserved = false, waitMs?: number, caller = client !== undefined): Promise<ProxyAnswer> {
    const a = await answer(vendor, path, rawQuery, body, client, reserved, waitMs, caller);
    const { said, ...out } = a;
    if (a.status >= 200 && a.status < 300) return out;
    const known = Object.hasOwn(VENDORS, vendor);
    const where = !known ? "(a vendor not on the list)" : Object.hasOwn(VENDORS[vendor as VendorName].paths, path) ? `${vendor} ${path}` : `${vendor} (a path not on the list)`;
    const cause = /cause;desc="([a-z0-9]+)"/.exec((a.timing ?? []).join(","))?.[1];
    const theirs = said !== undefined || (cause !== undefined && VENDOR_CAUSES.has(cause));
    let what: string;
    if (theirs) {
      const status = said?.status;
      what = status === undefined ? (cause ?? "unnamed") : cause === undefined || cause === "429" ? String(status) : `${status} (${cause})`;
      if (said && "message" in said) what += said.message === null || said.message === undefined ? " (no message)" : ` ${JSON.stringify(holdsKey(said.message) ? "(withheld: it held a key)" : safeMessage(said.message, requestValues(body, rawQuery)))}`;
    } else {
      let code: unknown;
      try {
        code = (JSON.parse(a.body) as { error?: { code?: unknown } })?.error?.code;
      } catch {
        // our own bodies are JSON
      }
      what = a.why ?? (typeof code === "string" ? code : "unnamed");
    }
    sayOnce(`proxy ${where} answered ${a.status}, ${theirs ? "the vendor's" : "ours"}: ${what}`);
    // and on the answer, in its Server-Timing, so our live check tells a vendor's refusal from ours (never a browser: not exposed)
    return { ...out, timing: [...(out.timing ?? []), `refusal;desc="${theirs ? "vendor" : "ours"}"`] };
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
