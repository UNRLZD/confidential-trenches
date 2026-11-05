// POST /v1/rpc/{chain} (markets paper H7 row, M:3335, with 7.1's LD1 reads, M:3275): a JSON-RPC request, or a batch of
// 1 to RPC_BATCH_MAX, forwarded to the chain's one configured provider only when every method in it is on the chain's
// allowlist (methods.ts, the kit's list). The helper is never an open RPC: anything else is refused before any call.
// Nothing the provider answers is trusted for anything signed (H2.4, LD1): the device takes every gating read on two
// providers, at least one reached device-direct, so this path can only make it refuse.
//
// What reaches the provider: the request re-written from what was checked (jsonrpc, id, method, params; numbers kept
// digit for digit), never the caller's bytes, so a key the checker and the provider read differently (a repeated
// "method", say) cannot carry an unlisted method; and content-type: application/json. No header of the caller.
// What reaches the caller: the provider's status and JSON body. A provider that is down, slow, refusing our key (401,
// 403), failing (5xx), answering anything but JSON within the size cap, or whose answer holds its own URL's key in any
// form answers 503 upstream, so the device falls back to its own providers (H2.3). So does a route with no provider
// set and no public fallback (RPC_UPSTREAMS: solana-devnet without SOLANA_DEVNET_RPC_URL), before anything is sent.
// Throttling (card helper-abuse-limits, ../limits/limits.ts): each chain's provider is one budget every call draws
// from, the helper's own reads included (RPC_BUDGET_<CHAIN>, default RPC_CHAIN_MAX requests in any 10 s, no caller
// more than RPC_CLIENT_MAX of them a window, a batch drawing one per request in it), and where the provider also limits
// one method (Solana's public endpoint, RPC_METHOD_MAX), each method a budget of its own drawn in the same step. The
// totals sit at the provider's own limits, so no set of callers can make the provider throttle us; a draw past a share
// or a total answers 429 rate_limited with the seconds until it would go ahead. If the provider throttles a caller's
// read anyway (its 429), the helper, its one client, holds the chain until the reset it named (at most RETRY_AFTER_MAX_S):
// every draw on that chain, the helper's own reads included, answers 429 with the seconds left and nothing reaches the
// provider. If it throttles a background read (the trade walks), only the background reads wait out the reset: they go
// behind callers, so a caller is not refused for their 429 (4 Nov 09:15-09:19Z, after a restart's cold walks); a
// caller's read it throttles in turn holds the chain. Each hold is one log line: the chain, whose read (caller or
// background) and the seconds. A 503 is never a wait.
//
// A keyed provider limits per second, not per 10 s (Helius free: 10 requests a second, its plan's 100 per 10 s in
// RPC_BUDGET_SOLANA; research scripts/deploy/helius-key.sh:7), so a burst inside the 10 s budget would still make it
// throttle and hold the chain for every caller (4 Nov: holders 429 within 0.08 s of a crowd, card app-console-429).
// Its sends are paced to a tenth of the budget's total in any 1 s: a send over the second's room waits for the next
// room, up to PACE_MAX_MS; past that only that caller gets a 429, never a hold. The public endpoint, whose published
// limit is per 10 s, is not paced. Every send to a keyed URL is in its one pacer (card helper-crowd-429, createPacer):
// the trade walks' too, behind callers, and a second client's on the same URL. A hold the provider named that ends
// within HOLD_WAIT_MS is waited out by the callers inside it, the throttled send sent once more, and their sends paced
// from its end, instead of a 429 to each.
//
// Refusals, in the kit's error shape { error: { code } } (v1.ts HelperRpcCode and the common codes):
//   404 not_found           a chain that is not one of RPC_CHAINS;
//   413 too_large           a body over RPC_BODY_MAX bytes, or a batch of more than RPC_BATCH_MAX;
//   400 method_not_allowed  everything else that is not a JSON-RPC request whose every method is on the chain's list:
//                           a content type other than JSON, a body that is not JSON, an empty batch, a request that is
//                           not { jsonrpc: "2.0", id, method, params? } with an integer or string id and object or array
//                           params, and a method off the list in any request of a batch.
import { budgetFromEnv, EVM_RANGE_MESSAGE, evmThrottleS, LIMIT_WINDOW_MS, LOGS_REFUSED, RETRY_AFTER_MAX_S, throttled, upstreamBudget, upstreamRetryAfterS, type BudgetLimits, type ProviderHolds } from "../limits/limits.ts";
import { RPC_BATCH_MAX, RPC_BODY_MAX, RPC_CHAINS, RPC_METHODS, type RpcChain } from "./methods.ts";
import { createSlot, CREDITS, type Slot, type SlotName } from "./slot.ts";

export const RPC_ANSWER_MAX = 4 * 1024 * 1024; // a getMultipleAccounts of 100 accounts or an eth_getLogs page fits
export const RPC_TIMEOUT_MS = 10_000; // NEAR send_tx waits for execution; the server's request timeout is 15 s
/**
 * Requests one chain's provider takes from every caller together per 10 s window, unless RPC_BUDGET_<CHAIN> names its
 * plan's: the public Solana endpoint's published limit, "Maximum number of requests per 10 seconds per IP: 100"
 * (solana-foundation/solana-com apps/docs/content/docs/en/references/clusters.mdx:153 at dd6c46a, "Mainnet rate
 * limits", read 2026-11-03 08:31Z). The other chains' public endpoints publish no number (docs.base.org's connecting
 * and faucet pages, docs.fastnear.com, read 08:33Z), so they default to the same, the most conservative known.
 */
export const RPC_CHAIN_MAX = 100;
/**
 * Requests one caller draws per chain per window, unless RPC_BUDGET_<CHAIN> says: what a device's one-transaction
 * trade asks of one provider when it fills within its read burst, from the kit's own pattern
 * (packages/kit/src/trade/solana/send.ts): the send (l.6-8), the burst of C = B/5 = 8 status reads over the keyless
 * B = 40 (l.190-193), and a blockhash read, about 11, rounded up to 16. Six callers at their full share fill the public
 * 100; a trade left undecided past its burst reads up to B - C = 32 statuses in a window (l.197-198), which only a
 * keyed provider's larger RPC_BUDGET_<CHAIN> serves.
 */
export const RPC_CLIENT_MAX = 16;
/**
 * Requests of one method the public Solana endpoint takes in 10 s from every caller together: "Maximum number of
 * requests per 10 seconds per IP for a single RPC: 40" (clusters.mdx:154, the same "Mainnet rate limits" list as
 * RPC_CHAIN_MAX). Without it three callers at their share of one method (3 x 16 getSignatureStatuses) make the
 * endpoint throttle, and its reset holds the chain for every caller. A keyed provider names its own as the third
 * number of RPC_BUDGET_SOLANA, or none (two numbers: no limit per method).
 */
export const RPC_METHOD_MAX = 40;
/** The longest a send waits for a keyed provider's second to have room. [design: 2 s: one caller's whole share at
 *  Helius free (RPC_CLIENT_MAX 16 at 10 a second) is two seconds' room, so a caller behind a full share still goes.] */
export const PACE_MAX_MS = 2_000;
/** A keyed provider's second as paced: a provider counts sends as they arrive, and our timers and the network move
 *  them by a few ms to tens of ms, so two seconds' sends must leave more than 1 s apart. [design: 100 ms margin.] */
export const PACE_SECOND_MS = 1_100;
/**
 * The longest a caller waits out a provider's hold before its send is paced (card helper-crowd-429): a hold ending
 * within it is waited, then the send booked from its end, instead of a 429 to every caller inside it; a longer one is
 * still the caller's 429 with the seconds left. [design: 1.5 s: Helius's 429 names no reset, so its hold is 1 s
 * (limits.ts upstreamRetryAfterS); this wait, PACE_MAX_MS after it and the send stay inside the kit's 5 s
 * SOLANA_CALL_TIMEOUT_MS (packages/kit/src/trade/solana/send.ts:61).]
 */
export const HOLD_WAIT_MS = 1_500;
/** Past a hold's end, the wait's margin: Node's timers and Date.now() round to whole ms, so a wait of exactly the
 *  hold's length can wake 1 ms inside it (seen on the box: every caller of a crowd woke inside a 1 s hold). */
const HOLD_MARGIN_MS = 5;

/**
 * Each keyed provider URL's sends, booked for the last second and ahead, oldest first (card helper-crowd-429): one per
 * helper, shared by every RPC client on that URL (Deps.pacer: the holders client when its key is the main one) and by
 * the helper's own background reads of it (rpc.background), so every send the provider counts is in one second's room.
 * At b07b71a the trade walks sent to the main key unpaced (SOLANA_TRADES_RPC_URL is SOLANA_RPC_URL's URL on the host):
 * 12 walks and 10 callers in one second, the provider's 429, and the chain held for every caller (live run 41911437956).
 */
export function createPacer() {
  const booked = new Map<string, number[]>();
  /** Per URL: when each send left, oldest first. */
  const left = new Map<string, number[]>();
  return {
    /**
     * When `n` sends to `url` may go so that no PACE_SECOND_MS holds more than `perSecond` of them, `fromMs` from now
     * on (a hold's end) and after every send booked before (first come, first sent), `share` the most of a second's
     * room these may fill (a background read: half, so a caller always finds the rest). Booked when within `maxWaitMs`
     * (and `book`), else only named: the ms to wait. Every time here is the process's monotonic clock
     * (performance.now), never the wall clock: on the box Date.now() stepped back 0.5 s and 8 s inside a test (traced
     * 4 Nov 22:14Z), and bookings on it let 11 sends into one real second, then refused callers for the step's length.
     */
    at(url: string, n: number, perSecond: number, opts: { fromMs?: number; maxWaitMs: number; share?: number; book?: boolean }): number {
      const t = performance.now();
      const cap = Math.max(1, opts.share ?? perSecond);
      const s = (booked.get(url) ?? []).filter((x) => x > t - PACE_SECOND_MS);
      booked.set(url, s);
      const i = s.length + n - cap - 1;
      let at = Math.max(t + (opts.fromMs ?? 0), s[s.length - 1] ?? t);
      if (i >= 0) at = Math.max(at, s[Math.min(i, s.length - 1)]! + PACE_SECOND_MS);
      if (at - t <= opts.maxWaitMs && opts.book !== false) for (let k = 0; k < n; k++) s.push(at);
      return at - t;
    },
    /**
     * The send itself, now: 0 when fewer than `perSecond` - `n` + 1 sends left in the last PACE_SECOND_MS, and then it is
     * counted; else the ms until one leaves. A booking names the earliest a send may go, and a lagging event loop
     * starts some later than booked, which would put them under a second from the next second's on-time sends: this
     * counts each send where it leaves.
     */
    go(url: string, n: number, perSecond: number): number {
      const t = performance.now();
      const q = (left.get(url) ?? []).filter((x) => x > t - PACE_SECOND_MS);
      left.set(url, q);
      const i = q.length + n - Math.max(perSecond, n) - 1;
      if (i >= 0) return q[i]! + PACE_SECOND_MS - t;
      for (let k = 0; k < n; k++) q.push(t);
      return 0;
    },
  };
}
export type Pacer = ReturnType<typeof createPacer>;
/**
 * Requests per 10 s kept on each chain (its total and each method's) for the helper's own reads that serve every
 * user, which only those reads may draw, whatever RPC_BUDGET_<CHAIN> says. Solana: Discover's curve reads, one
 * getMultipleAccounts per 100 pump.fun mints (data/solana/lists.ts l.338), of at most 300 rows (three Jupiter lists of
 * limit=100, READS), once per FRESH_MS 12 s refresh: 3 in any 10 s. The other chains: no own reads through here (the
 * token watches and the pool senders read their own providers), so 0. The token page's reads are not in it: they are
 * one per token a caller opens, so they draw that caller's share and stop at the total less this, as callers do.
 */
export const RPC_RESERVE: Readonly<Record<RpcChain, number>> = { solana: 3, base: 0, robinhood: 0, near: 0, "solana-devnet": 0 };
/**
 * The part of each chain's total, and of each method's, the helper's own background reads never draw (card
 * helper-ready-gate): the trade walks and the SOL price reads (data/solana/trades.ts) go only while half stays free,
 * whatever callers drew, so a walk that would take the whole budget leaves a caller's read its room (4 Nov 06:24-06:30Z:
 * the walks, outside this budget, drew the public endpoint's 100 and every token read answered 429 for six minutes).
 * [design: half: the public 100 keeps 50 for callers, three at their full RPC_CLIENT_MAX share; the walks keep 47, a cold
 * read of COLD_SIGS transactions a few seconds, and move to their next provider when it is spent.]
 */
export const userRoomOf = (limit: number): number => Math.ceil(limit / 2);
/** Each chain's budget unless RPC_BUDGET_<CHAIN> says; only Solana's public endpoint publishes a limit per method. */
export const RPC_BUDGETS: Readonly<Record<RpcChain, BudgetLimits & { perMethod?: number }>> = {
  solana: { total: RPC_CHAIN_MAX, perClient: RPC_CLIENT_MAX, perMethod: RPC_METHOD_MAX },
  base: { total: RPC_CHAIN_MAX, perClient: RPC_CLIENT_MAX },
  robinhood: { total: RPC_CHAIN_MAX, perClient: RPC_CLIENT_MAX },
  near: { total: RPC_CHAIN_MAX, perClient: RPC_CLIENT_MAX },
  // mainnet's public numbers: under what api.devnet.solana.com's headers named (x-ratelimit-rps-limit 250,
  // x-ratelimit-method-limit 150, read 5 Nov 15:03Z); a keyed SOLANA_DEVNET_RPC_URL names its plan's in RPC_BUDGET_SOLANA_DEVNET
  "solana-devnet": { total: RPC_CHAIN_MAX, perClient: RPC_CLIENT_MAX, perMethod: RPC_METHOD_MAX },
};
/** The chains whose providers speak EVM JSON-RPC, where -32005 is a throttle (limits.ts EVM_LIMIT_CODE). */
const EVM_CHAINS: ReadonlySet<string> = new Set(["base", "robinhood"]);
/** The whole seconds an EVM provider's throttle in `answer` (one answer or a batch) asks to wait, by the helper's one
 * rule (limits.ts evmThrottleS: -32005 or a rate or request limit message, never a limit on the read's size), 1 to
 * RETRY_AFTER_MAX_S; 0 when there is none or the chain is not EVM. */
function evmLimited(chain: RpcChain, answer: unknown): number {
  if (!EVM_CHAINS.has(chain)) return 0;
  let wait = 0;
  for (const a of Array.isArray(answer) ? answer : [answer]) {
    const e = (a as { error?: unknown } | null)?.error;
    if (e !== undefined) wait = Math.max(wait, evmThrottleS(e));
  }
  return wait;
}
/** An EVM provider's error saying it cannot serve this request's shape (card evm-rpc-spare-list; the words the wallet's
 *  pool reader holds, packages/wallet/src/pool/evm.ts OUT_WORDS): PublicNode's -32701 "Please specify an address" for a
 *  topics-only eth_getLogs, Pocket's "missing required field 'address'", and -32601 "method not available". Another
 *  provider may serve the request, and this one still serves the others. Never a range cap (the device pages on those)
 *  or a revert (the call's own answer). */
const SHAPE_CODES: ReadonlySet<unknown> = new Set([-32701, -32601]);
const SHAPE_WORDS = /specify an address|missing required field 'address'/i;
function evmShapeRefused(chain: RpcChain, answer: unknown): boolean {
  if (!EVM_CHAINS.has(chain)) return false;
  return (Array.isArray(answer) ? answer : [answer]).some((a) => {
    const e = (a as { error?: unknown } | null)?.error as { code?: unknown; message?: unknown } | null | undefined;
    if (e === undefined || e === null || typeof e !== "object") return false;
    const m = String(e.message ?? "");
    if (EVM_RANGE_MESSAGE.test(m) || e.code === 3 || /revert/i.test(m)) return false;
    return SHAPE_CODES.has(e.code) || SHAPE_WORDS.test(m);
  });
}
/** The environment variable naming a chain's budget, "<total>,<per client>[,<per method>]" per 10 s; the share at
 * least RPC_BATCH_MAX, so a full batch can be served, and a method's at least that and at most the total. */
export const rpcBudgetEnv = (chain: RpcChain): string => `RPC_BUDGET_${chain.toUpperCase().replace(/-/g, "_")}`;
const ID_MAX = 128;

/**
 * Each chain's provider: the URL in the host's environment (a keyed provider puts its key in the URL, markets paper
 * H2.1), else a public endpoint, so a helper anyone runs works with no key. Each default answered a read from the
 * Mac on 2026-11-01 06:24Z (getBlockHeight, eth_blockNumber, block). A null fallback: the route is off with no URL set
 * (every call 503 upstream, nothing sent).
 */
export const RPC_UPSTREAMS: Readonly<Record<RpcChain, { env: string; fallback: string | null }>> = {
  solana: { env: "SOLANA_RPC_URL", fallback: "https://api.mainnet-beta.solana.com" },
  base: { env: "BASE_RPC_URL", fallback: "https://mainnet.base.org" },
  robinhood: { env: "ROBINHOOD_RPC_URL", fallback: "https://rpc.mainnet.chain.robinhood.com" },
  near: { env: "NEAR_RPC_URL", fallback: "https://rpc.mainnet.fastnear.com" },
  // the testnet build's second provider: a keyed devnet URL of another operator than api.devnet.solana.com, which the
  // page reads itself as its first (packages/signpage/src/pool-testnet.ts TESTNET_RPCS); none set: off (503), never
  // a silent fallback to that same operator, which would make the page's two reads one provider's (review L-1)
  "solana-devnet": { env: "SOLANA_DEVNET_RPC_URL", fallback: null },
};

/** Solana's public endpoint: a keyed SOLANA_RPC_URL's fallback (card helper-solana-failover, rpc/slot.ts). */
export const SOLANA_PUBLIC = RPC_UPSTREAMS.solana.fallback as string;
/** The budget key of the public endpoint when a keyed provider is set: its own budget, the public limits (RPC_BUDGETS
 *  solana: 100 per 10 s, 40 per method), never RPC_BUDGET_SOLANA, which is the keyed plan's. */
const PUBLIC_KEY = "solana-public";

export type RpcAnswer = { status: number; body: string };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** `slot`: the Solana slot's name for its log lines and health (rpc/slot.ts); `publicFallback: false` for a slot whose
 *  calls the public endpoint refuses (holders' getTokenLargestAccounts: HTTP 429 "Too many requests for a specific RPC
 *  call" on every try, read 2026-11-04 10:04Z), which answers 503 while fallen back and its caller serves its own. */
/** `holds`: the helper's one hold per provider (limits.ts providerHolds, card helper-robinhood-capacity): an EVM chain's
 *  provider held by any path of the helper (the swap and maker reads use the same public Robinhood RPC) is sent no
 *  caller's read inside that hold either (a short one is waited out, holdOver; a longer one answers 429 with the seconds
 *  left); its throttle here holds it for those paths too. */
/** `pinned`: an EVM chain's other providers, in order (server.ts: swaps.ts SWAP_RPCS), each of which may answer a
 *  caller's read when the configured one is held or has no room in its pace (callEvm). */
/** `pacer`: another client's, when this one sends to the same keyed URL (card helper-crowd-429); else its own. */
type Deps = { fetch?: Fetch; now?: () => number; log?: (line: string) => void; slot?: SlotName; publicFallback?: boolean; holds?: ProviderHolds; pinned?: Partial<Record<RpcChain, readonly string[]>>; pacer?: Pacer };
/** `why`: a 429's limit, for the refusal log (limits.ts throttled), never sent. */
/** `timing` (card helper-ready-page-warm): this read's Server-Timing entries, the wait before its send (a hold or the
 *  provider's pace) and the send, and a keyed Solana provider's time before the read fell back to the public endpoint. */
type Answer = RpcAnswer & { headers?: Record<string, string>; why?: string; timing?: string[] };
/** `off`: no URL set for a route with no public fallback (RPC_UPSTREAMS); handle() answers 503 and sends nothing. */
type Upstream = { url: string; forms: Buffer[]; off?: true };

const error = (status: number, code: string): RpcAnswer => ({ status, body: JSON.stringify({ error: { code } }) });
const REFUSED = () => error(400, "method_not_allowed");
const UPSTREAM = () => error(503, "upstream");

/** Every form a secret could leave in: as set, base64, base64url and URL-encoded. */
function forms(secrets: string[]): Buffer[] {
  const out = new Set<string>();
  for (const s of secrets) {
    const b = Buffer.from(s, "utf8");
    for (const f of [s, b.toString("base64").replace(/=+$/, ""), b.toString("base64url"), encodeURIComponent(s)]) out.add(f);
  }
  return [...out].map((f) => Buffer.from(f, "utf8"));
}

/**
 * The providers this host uses. A URL set in the environment must be http(s) with no fragment; the start stops on any
 * other, naming the variable, never the value. Its secret parts (the URL itself, user and password, every query value
 * and every path segment of 16 characters or more, where providers put keys) are what an answer must never hold.
 */
export function readUpstreams(env: Record<string, string | undefined>): Record<RpcChain, Upstream> {
  const out = {} as Record<RpcChain, Upstream>;
  for (const chain of RPC_CHAINS) {
    const { env: name, fallback } = RPC_UPSTREAMS[chain];
    const set = env[name];
    if (set === undefined || set === "") {
      out[chain] = fallback === null ? { url: "", forms: [], off: true } : { url: fallback, forms: [] };
      continue;
    }
    let u: URL;
    try {
      u = new URL(set);
    } catch {
      throw new Error(`${name} must be an http(s) URL`);
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.hash !== "" || /\s/.test(set)) throw new Error(`${name} must be an http(s) URL with no fragment`);
    const secrets = [set, u.href, u.username, u.password, ...u.searchParams.values(), ...u.pathname.split("/").filter((s) => s.length >= 16)];
    out[chain] = { url: set, forms: forms(secrets.filter((s) => s.length >= 8)) };
  }
  return out;
}

/** The caller's body parsed with every number kept as written (a u64 slot or lamports past 2^53 included). */
function parse(text: string): unknown {
  const keep = (_k: string, v: unknown, ctx?: { source?: string }) =>
    typeof v === "number" && ctx?.source !== undefined && !(Number.isSafeInteger(v) && String(v) === ctx.source)
      ? (JSON as unknown as { rawJSON(s: string): unknown }).rawJSON(ctx.source)
      : v;
  return JSON.parse(text, keep as (k: string, v: unknown) => unknown);
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** The pool program each Solana route may scan with getProgramAccounts: the helper's own pinned pool program for that
 *  cluster (apps/helper/src/pool/solana.ts POOL_SOLANA_ENV), none when unset. */
export const RPC_SCAN_PROGRAM_ENV: Readonly<Partial<Record<RpcChain, string>>> = { solana: "POOL_SOLANA_PROGRAM_MAINNET", "solana-devnet": "POOL_SOLANA_PROGRAM_DEVNET" };
/** The note restore's scan (packages/wallet/src/pool/solana-restore.ts solanaMarks, the bucket read; the settle's
 *  solanaSettleSpent reads through the same call): each mark size (13 a spent mark, 17 a pre-mark) and the memcmp at 9,
 *  past the counter's low byte, of size - 9 bytes whose last is the program's mark tag (SOL_MARK_TAG 1). */
const SCAN_SIZES: ReadonlySet<unknown> = new Set([13, 17]);
const SCAN_AT = 9;
const SCAN_TAG = 1;
const SCAN_CONFIG: ReadonlySet<string> = new Set(["commitment", "encoding", "withContext", "minContextSlot", "filters"]);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 to bytes (each leading "1" a zero byte), or null for a character off the alphabet. */
function base58Bytes(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const out: number[] = [];
  for (; n > 0n; n >>= 8n) out.unshift(Number(n & 0xffn));
  for (let i = 0; i < s.length && s[i] === "1"; i++) out.unshift(0);
  return Uint8Array.from(out);
}
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
/**
 * getProgramAccounts only in the note restore's exact shape (review L-2 and its re-review): on the route's own pinned
 * pool program; config { commitment: "finalized", encoding: "base64", withContext: true, minContextSlot? (a positive
 * whole number), filters } and no other key; filters exactly [{ dataSize: 13 | 17 }, { memcmp: { offset: 9, bytes } }],
 * the bytes base58 of exactly size - 9 bytes ending in the mark tag: one bucket of one mark size. An open scan of any
 * program, or a wider one of the pool's (the tag alone, a large size, a compressed encoding, a slice, a sort, a
 * changed-since read), would spend the keyed provider's quota for every caller. Anything else is refused before any call.
 */
function scanAllowed(r: Record<string, unknown>, program: string | undefined): boolean {
  if (program === undefined || program === "") return false;
  const p = r.params;
  if (!Array.isArray(p) || p.length !== 2 || p[0] !== program || !isPlain(p[1])) return false;
  const c = p[1];
  if (Object.keys(c).some((k) => !SCAN_CONFIG.has(k))) return false;
  if (c.commitment !== "finalized" || c.encoding !== "base64" || c.withContext !== true) return false;
  if (Object.hasOwn(c, "minContextSlot") && !(Number.isSafeInteger(c.minContextSlot) && (c.minContextSlot as number) > 0)) return false;
  const f = c.filters;
  if (!Array.isArray(f) || f.length !== 2) return false;
  const [size, cmp] = f as unknown[];
  if (!isPlain(size) || !exactKeys(size, ["dataSize"]) || !SCAN_SIZES.has(size.dataSize)) return false;
  if (!isPlain(cmp) || !exactKeys(cmp, ["memcmp"]) || !isPlain(cmp.memcmp)) return false;
  const m = cmp.memcmp;
  if (!exactKeys(m, ["offset", "bytes"]) || m.offset !== SCAN_AT || typeof m.bytes !== "string" || m.bytes.length > 24) return false;
  const bytes = base58Bytes(m.bytes);
  return bytes !== null && bytes.length === (size.dataSize as number) - SCAN_AT && bytes[bytes.length - 1] === SCAN_TAG;
}

/** One checked request, rebuilt from its four fields only, or undefined. `scan`: the route's pinned pool program. */
function check(chain: RpcChain, r: unknown, scan?: string): Record<string, unknown> | undefined {
  if (!isPlain(r)) return undefined;
  for (const k of Object.keys(r)) if (k !== "jsonrpc" && k !== "id" && k !== "method" && k !== "params") return undefined;
  if (r.jsonrpc !== "2.0") return undefined;
  const id = r.id;
  if (!((typeof id === "number" && Number.isSafeInteger(id)) || (typeof id === "string" && id.length <= ID_MAX))) return undefined;
  if (typeof r.method !== "string" || !RPC_METHODS[chain].includes(r.method)) return undefined;
  if (Object.hasOwn(r, "params") && !isPlain(r.params) && !Array.isArray(r.params)) return undefined;
  if (r.method === "getProgramAccounts" && !scanAllowed(r, scan)) return undefined;
  const out: Record<string, unknown> = { jsonrpc: "2.0", id, method: r.method };
  if (Object.hasOwn(r, "params")) out.params = r.params;
  return out;
}

export function createRpc(env: Record<string, string | undefined>, deps: Deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  // the budgets', holds' and paces' clock: monotonic, in epoch ms (a wall clock that steps back would hold callers
  // for the step's length; card helper-crowd-429)
  const now = deps.now ?? (() => performance.timeOrigin + performance.now());
  const log = deps.log ?? ((line: string) => console.log(`helper: ${line}`));
  const upstreams = readUpstreams(env);
  const scanPrograms: Partial<Record<RpcChain, string>> = Object.fromEntries(Object.entries(RPC_SCAN_PROGRAM_ENV).map(([c, name]) => [c, env[name]]));
  // a keyed Solana provider's slot: its fallback is the public endpoint, on a budget of its own
  const keyed = upstreams.solana.url !== SOLANA_PUBLIC;
  const slot: Slot = createSlot(deps.slot ?? "rpc", keyed, { now, log });
  const publicFallback = deps.publicFallback ?? true;
  const publicLimits = { ...RPC_BUDGETS.solana, reserve: RPC_RESERVE.solana, userRoom: userRoomOf(RPC_BUDGETS.solana.total) };
  const limits = Object.fromEntries(
    RPC_CHAINS.map((ch) => {
      const b = budgetFromEnv(env, rpcBudgetEnv(ch), RPC_BUDGETS[ch], { minShare: RPC_BATCH_MAX, perMethod: true, reserve: RPC_RESERVE[ch] });
      return [ch, { ...b, reserve: RPC_RESERVE[ch], userRoom: userRoomOf(b.total) }];
    }),
  ) as Record<RpcChain, BudgetLimits & { perMethod?: number }>;
  // a key is a chain, or "<chain> <method>" for one method's budget on it (no share: the chain's share bounds a caller)
  const limitsOf = (k: string) => (k === PUBLIC_KEY ? publicLimits : limits[k as RpcChain]);
  const budget = upstreamBudget((key) => {
    const [k, method] = key.split(" ") as [string, string | undefined];
    const l = limitsOf(k);
    return method === undefined ? l : { total: l.perMethod!, perClient: Infinity, reserve: k === PUBLIC_KEY ? RPC_RESERVE.solana : RPC_RESERVE[k as RpcChain], userRoom: userRoomOf(l.perMethod!) };
  }, now);
  /** The provider throttled `whose` read on `c` for `seconds`: the chain is held (every draw for a caller's, the
   *  background draws for a background read's), logged as one line with no caller in it. */
  const hold = (c: string, seconds: number, whose: "caller" | "background"): void => {
    budget.hold(c, now() + seconds * 1000, whose === "background");
    log(`rpc hold ${c} ${whose} ${budget.heldFor(c, whose === "background")} s`);
  };
  const pacer = deps.pacer ?? createPacer();
  /** A keyed provider's URL and its sends a second, or null for the public endpoint and a chain on its default
   *  provider, which are not paced (their published limits are per 10 s). */
  const pacedOf = (key: string): { url: string; perSecond: number } | null =>
    key === PUBLIC_KEY || upstreams[key as RpcChain].forms.length === 0 ? null : { url: upstreams[key as RpcChain].url, perSecond: Math.max(1, Math.ceil(limitsOf(key).total / (LIMIT_WINDOW_MS / 1000))) };
  /** How long `n` sends to `key` wait for their second's room, from a hold's end on, booked when within `maxWaitMs`;
   *  0 when not paced. A batch larger than a second's room goes alone in its own second. */
  const pace = (key: string, n: number, maxWaitMs: number, url?: string): number => {
    const p = pacedOf(key);
    return p === null ? 0 : pacer.at(p.url, n, p.perSecond, { fromMs: Math.max(0, heldUntilOf(key, url) - now()), maxWaitMs });
  };
  const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  /** When `key`'s hold ends (epoch ms, 0 when free), and with `url`, an EVM provider's hold for every path of the helper
   *  (Deps holds, card helper-robinhood-capacity) beside it. */
  const heldUntilOf = (key: string, url?: string): number => {
    const ms = url === undefined ? 0 : (deps.holds?.heldMs(url) ?? 0);
    return Math.max(budget.heldUntil(key), ms > 0 ? now() + ms : 0);
  };
  /** The seconds left on `key`'s hold, and with `url` on the provider's shared one. */
  const heldOf = (key: string, url?: string): number => Math.max(budget.heldFor(key), url === undefined ? 0 : (deps.holds?.heldFor(url) ?? 0));
  /** A hold on `key` (with `url`, the provider's shared one too) that ends within HOLD_WAIT_MS and by `deadline` is
   *  waited out: true once nothing holds it (card helper-crowd-429); a longer one, or one set again meanwhile, is false
   *  at once or after the one wait. */
  const holdOver = async (key: string, deadline: number, url?: string): Promise<boolean> => {
    const until = heldUntilOf(key, url);
    const t = now();
    if (until <= t) return true;
    if (until > Math.min(deadline, t + HOLD_WAIT_MS)) return false;
    // a timer can fire a few ms before the clock reads its end: the wait is the hold's end plus HOLD_MARGIN_MS
    await sleep(until - t + HOLD_MARGIN_MS);
    return heldOf(key, url) === 0;
  };
  const drawsOf = (c: string, methods: readonly string[]): [string, number][] => {
    const draws: [string, number][] = [[c, methods.length]];
    if (limitsOf(c).perMethod !== undefined) for (const m of methods) draws.push([`${c} ${m}`, 1]);
    return draws;
  };

  async function readAnswer(r: Response): Promise<string | undefined> {
    if (Number(r.headers.get("content-length") ?? "0") > RPC_ANSWER_MAX) return undefined;
    if (!r.body) return "";
    const chunks: Uint8Array[] = [];
    let n = 0;
    for await (const c of r.body) {
      n += c.byteLength;
      if (n > RPC_ANSWER_MAX) return undefined;
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /**
   * One call: `chain` as the caller wrote it, `contentType` its Content-Type header, `body` the request body, `client`
   * the caller's address (../limits/limits.ts clientOf). The helper's own cached reads (Discover's lists, the token
   * page) pass none: they draw from the provider's total, never a caller's share; `reserved` marks the ones RPC_RESERVE
   * holds room for (Discover's), which alone may draw it.
   */
  async function handle(chain: string, contentType: string | undefined, body: string, client?: string, reserved = false): Promise<Answer> {
    if (!(RPC_CHAINS as readonly string[]).includes(chain)) return error(404, "not_found");
    const c = chain as RpcChain;
    if (upstreams[c].off) return UPSTREAM();
    if (Buffer.byteLength(body) > RPC_BODY_MAX) return error(413, "too_large");
    if (!/^application\/json\s*(;|$)/i.test(contentType ?? "")) return REFUSED();
    let parsed: unknown;
    try {
      parsed = parse(body);
    } catch {
      return REFUSED();
    }
    let out: unknown;
    if (Array.isArray(parsed)) {
      if (parsed.length > RPC_BATCH_MAX) return error(413, "too_large");
      if (parsed.length === 0) return REFUSED();
      const checked = parsed.map((r) => check(c, r, scanPrograms[c]));
      if (checked.some((r) => r === undefined)) return REFUSED();
      out = checked;
    } else {
      out = check(c, parsed, scanPrograms[c]);
      if (out === undefined) return REFUSED();
    }
    let forward: string;
    try {
      forward = JSON.stringify(out);
    } catch {
      return REFUSED(); // nesting too deep to write back
    }

    const methods = ((Array.isArray(out) ? out : [out]) as { method: string }[]).map((r) => r.method);
    // a keyed Solana provider fallen back (rpc/slot.ts): the public endpoint, on its own budget; the key while it serves
    if (c === "solana" && keyed && !slot.useKeyed()) return publicFallback ? call(PUBLIC_KEY, SOLANA_PUBLIC, [], forward, methods, client, reserved) : UPSTREAM();
    if (EVM_CHAINS.has(c) && deps.holds !== undefined && (deps.pinned?.[c]?.length ?? 0) > 0) return callEvm(c, forward, methods, client, reserved, deps.holds);
    return call(c, upstreams[c].url, upstreams[c].forms, forward, methods, client, reserved);
  }

  /**
   * A caller's read on an EVM chain with pinned providers (card helper-robinhood-capacity fold 2): a user's call never
   * pays for the helper's background load. It draws on the chain's budget once (a caller's share, as call() does), then
   * goes to the first of the configured provider and the pinned ones that is not held and has room in its pace for a
   * caller (limits.ts take: background reads leave CALLER_ROOM of it); one that refuses it (its 429, or a throttle in its
   * answer) is held for every path of the helper, and the next is asked. When none can take it, the soonest one's hold
   * or pace wait is waited out when it ends within HOLD_WAIT_MS (card helper-crowd-429's rule), and only past that does
   * the caller get a 429, with the soonest wait any of them names. The chain itself is never held here: a provider's
   * refusal holds that provider alone.
   */
  async function callEvm(c: RpcChain, forward: string, methods: string[], client: string | undefined, reserved: boolean, holds: ProviderHolds): Promise<Answer> {
    // card helper-crowd-429's rule on this path too: a hold that ends within HOLD_WAIT_MS and by `deadline` is waited out
    // (the chain's, or the soonest of its providers' when none could take the read), then the read is asked once more
    const deadline = now() + HOLD_WAIT_MS + PACE_MAX_MS;
    if (!(await holdOver(c, deadline))) return throttled(budget.heldFor(c), undefined, `${c} held`);
    const wait = budget.takeEach(drawsOf(c, methods), client, false, reserved);
    if (wait > 0) return throttled(wait, undefined, budget.refusedBy());
    // a log read is never sent to a provider that refuses every one (LOGS_REFUSED): its 429 would hold it for the reads
    // it does answer
    const list = [...new Set([upstreams[c].url, ...(deps.pinned?.[c] ?? [])])].filter((u) => !(methods.includes("eth_getLogs") && LOGS_REFUSED.has(u)));
    for (let tries = 0; ; tries++) {
      let soonestMs = Infinity;
      let down = false;
      let sent = false;
      let shaped: { status: number; body: string; secretForms: Buffer[] } | undefined;
      for (const url of list) {
        const secretForms = url === upstreams[c].url ? upstreams[c].forms : [];
        const h = holds.heldMs(url);
        if (h > 0) {
          soonestMs = Math.min(soonestMs, h);
          continue;
        }
        const room = holds.take(url, methods.length, false);
        if (room > 0) {
          soonestMs = Math.min(soonestMs, room);
          continue;
        }
        let r: Response;
        let text: string | undefined;
        sent = true;
        try {
          r = await doFetch(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: forward, redirect: "error", signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
          if (r.status === 429) {
            await r.body?.cancel();
            const s = upstreamRetryAfterS(r.headers, now());
            holds.hold(url, s);
            log(`rpc hold ${c} ${new URL(url).host} caller ${s} s`);
            soonestMs = Math.min(soonestMs, holds.heldMs(url));
            continue;
          }
          text = await readAnswer(r);
        } catch {
          down = true;
          continue;
        }
        if (r.status === 401 || r.status === 403 || r.status >= 500 || r.status < 200 || (r.status >= 300 && r.status < 400) || text === undefined || !/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(r.headers.get("content-type") ?? "")) {
          down = true;
          continue;
        }
        let answer: unknown;
        try {
          answer = JSON.parse(text);
        } catch {
          down = true;
          continue;
        }
        const limited = evmLimited(c, answer);
        if (limited > 0) {
          holds.hold(url, limited);
          log(`rpc hold ${c} ${new URL(url).host} caller ${limited} s`);
          soonestMs = Math.min(soonestMs, holds.heldMs(url));
          continue;
        }
        // a provider that cannot serve this request's shape is out for it alone (no hold: its other requests still go to
        // it); the next is asked, and the last such answer is the caller's when every provider refuses it so
        if (evmShapeRefused(c, answer)) {
          shaped = { status: r.status, body: text, secretForms };
          continue;
        }
        if (secretForms.some((f) => Buffer.from(text, "utf8").includes(f))) return UPSTREAM();
        return { status: r.status, body: text };
      }
      // none could take it: the soonest provider's short hold or pace wait is waited out, and the read asked again (a
      // read sent and refused draws on the budget once more, as any send does)
      const waitMs = soonestMs + HOLD_MARGIN_MS;
      if (tries < 2 && soonestMs <= HOLD_WAIT_MS && now() + waitMs <= deadline) {
        await sleep(waitMs);
        if (!sent) continue;
        const again = budget.takeEach(drawsOf(c, methods), client, false, reserved);
        if (again === 0) continue;
        return throttled(again, undefined, budget.refusedBy());
      }
      // a provider still held may serve it: the caller's wait below, never the refusal (the device would take it as
      // the read's answer)
      if (shaped !== undefined && soonestMs === Infinity) return shaped.secretForms.some((f) => Buffer.from(shaped!.body, "utf8").includes(f)) ? UPSTREAM() : { status: shaped.status, body: shaped.body };
      // every provider failed (none held or out of room): upstream, so the device reads its own; else the soonest wait
      return down && soonestMs === Infinity ? UPSTREAM() : throttled(soonestMs === Infinity ? RETRY_AFTER_MAX_S : Math.max(1, Math.ceil(soonestMs / 1000)), undefined, `${c} every provider held`);
    }
  }


  /**
   * One call to one provider: `key` is its budget (a chain, or PUBLIC_KEY). The provider's reset holds every caller, the
   * helper's own reads too; then the call draws on the budget's total (a caller's share too) and each method's, a batch
   * one per request in it, all or none. A keyed Solana provider that fails the call (rpc/slot.ts) has it carried to the
   * public endpoint at once, so its fall never reaches the caller as an error.
   */
  async function call(key: string, url: string, secretForms: Buffer[], forward: string, methods: string[], client: string | undefined, reserved: boolean): Promise<Answer> {
    const c = (key === PUBLIC_KEY ? "solana" : key) as RpcChain;
    const viaSlot = c === "solana" && keyed && key !== PUBLIC_KEY;
    const begun = now();
    /** The key failed this call: the slot is told, and the call goes to the public endpoint (or 503 with none). */
    const fellBack = (): Promise<Answer> =>
      publicFallback
        ? call(PUBLIC_KEY, SOLANA_PUBLIC, [], forward, methods, client, reserved).then((a) => ({ ...a, timing: [`rpc-keyed;dur=${Math.round(now() - begun)};desc="fell back"`, ...(a.timing ?? [])] }))
        : Promise.resolve(UPSTREAM());
    // card helper-crowd-429: a hold that ends within HOLD_WAIT_MS is waited out and the send paced from its end, and a
    // send the provider throttles is sent once more after its short hold, all by `deadline`; a longer hold is the
    // caller's 429 with its seconds. An EVM chain's provider is held for every path of the helper that reads it (Deps
    // holds, card helper-robinhood-capacity): that hold is waited out and paced from the same way.
    const shared = EVM_CHAINS.has(c) ? url : undefined;
    const heldAt = (): number => heldOf(key, shared);
    const deadline = now() + HOLD_WAIT_MS + PACE_MAX_MS;
    if (!(await holdOver(key, deadline, shared))) return throttled(heldAt(), undefined, `${key} held`);
    const wait = budget.takeEach(drawsOf(key, methods), client, false, reserved);
    if (wait > 0) return throttled(wait, undefined, budget.refusedBy());
    let r!: Response;
    let text: string | undefined;
    let sent = now();
    for (let tries = 0; ; tries++) {
      const room = Math.max(0, Math.min(PACE_MAX_MS, deadline - now()));
      const paced = pace(key, methods.length, room, shared);
      if (paced > room) return throttled(Math.max(1, Math.ceil((paced - room) / 1000)), undefined, `${key} pace`);
      if (paced > 0) await sleep(paced);
      // the hold is read again right before the send: the provider may have asked us to wait while this one waited
      // for its second (card helper-rpc-hold-queued); a short one is waited out and the send paced again
      if (heldAt() > 0) {
        if (tries < 2 && (await holdOver(key, deadline, shared))) continue;
        return throttled(Math.max(1, heldAt()), undefined, `${key} held`);
      }
      // the send counted where it leaves (Pacer.go), within the deadline
      const p = pacedOf(key);
      const goBy = performance.now() + Math.max(0, deadline - now());
      let gate = p === null ? 0 : pacer.go(p.url, methods.length, p.perSecond);
      for (let round = 0; gate > 0; round++) {
        // a few rounds at most: each waits for a send to leave the second, so more mean a crowd past the deadline
        if (round >= 4 || performance.now() + gate > goBy) return throttled(Math.max(1, Math.ceil(gate / 1000)), undefined, `${key} pace`);
        await sleep(gate);
        gate = pacer.go(p!.url, methods.length, p!.perSecond);
      }
      if (heldAt() > 0) return throttled(Math.max(1, heldAt()), undefined, `${key} held`);
      sent = now();
      try {
        r = await doFetch(url, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: forward,
          redirect: "error",
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
        if (r.status === 429) {
          const body = viaSlot ? ((await readAnswer(r).catch(() => undefined)) ?? "") : (await r.body?.cancel(), "");
          const waitS = upstreamRetryAfterS(r.headers, now());
          if (viaSlot && (CREDITS.test(body) ? (slot.fail("credits"), true) : slot.throttled(waitS))) return fellBack();
          hold(key, waitS, "caller");
          if (shared !== undefined) deps.holds?.hold(url, waitS);
          // sent once more after a short hold, drawing on the budget as any send does
          if (tries < 2 && (await holdOver(key, deadline, shared))) {
            const again = budget.takeEach(drawsOf(key, methods), client, false, reserved);
            if (again === 0) continue;
            return throttled(again, undefined, budget.refusedBy());
          }
          return throttled(Math.max(1, heldAt()), undefined, `${key} provider 429`);
        }
        text = await readAnswer(r);
      } catch {
        if (viaSlot) return slot.unanswered(sent), fellBack();
        return UPSTREAM();
      }
      break;
    }
    if (viaSlot && (r.status === 401 || r.status === 403)) return slot.fail(String(r.status)), fellBack();
    if (viaSlot && r.status >= 400 && CREDITS.test(text ?? "")) return slot.fail("credits"), fellBack();
    if (viaSlot && r.status >= 500) return slot.unanswered(sent), fellBack();
    if (r.status === 401 || r.status === 403 || r.status >= 500 || r.status < 200 || (r.status >= 300 && r.status < 400)) return UPSTREAM();
    if (text === undefined || !/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(r.headers.get("content-type") ?? "")) return viaSlot ? (slot.unanswered(sent), fellBack()) : UPSTREAM();
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      return viaSlot ? (slot.unanswered(sent), fellBack()) : UPSTREAM();
    }
    // a JSON-RPC error that says the plan is spent is the key's end, as a 401 is
    if (viaSlot && (Array.isArray(answer) ? answer : [answer]).some((a) => CREDITS.test(String((a as { error?: { message?: unknown } } | null)?.error?.message ?? "")))) return slot.fail("credits"), fellBack();
    // an EVM provider's throttle in any answer (evmLimited: -32005 or a rate or request limit message) is its throttle, as
    // its 429 is: the chain is held for the backoff it names (Infura's error.data.backoff_seconds), else 1 s
    const limited = evmLimited(c, answer);
    if (limited > 0) {
      hold(key, limited, "caller");
      if (shared !== undefined) deps.holds?.hold(url, limited);
      return throttled(budget.heldFor(key), undefined, `${key} provider limit`);
    }
    const b = Buffer.from(text, "utf8");
    if (secretForms.some((f) => b.includes(f))) return UPSTREAM();
    if (viaSlot) slot.ok();
    const waited = Math.round(sent - begun);
    return { status: r.status, body: text, timing: [...(waited > 0 ? [`rpc-wait;dur=${waited}`] : []), `rpc;dur=${Math.round(now() - sent)};desc="${key === PUBLIC_KEY ? "public" : key}"`] };
  }

  /**
   * The helper's own background reads that reach a chain's provider by another path (data/solana/trades.ts, with the
   * provider's URL): `url` is this chain's provider when it is the one configured here, and then each request draws
   * from the chain's budget as a background read (userRoomOf), waiting out any hold on it. A URL that is another
   * provider draws nothing here. Returns the seconds to wait, 0 to go.
   */
  function background(chain: RpcChain, url: string, method: string): number {
    const key = keyOf(chain, url);
    if (key === null) return 0;
    // card helper-crowd-429: on a paced provider the read also takes a place in its second, now or never (a wait skips
    // it to the next provider), behind every send booked before and in at most half the second's room, so callers
    // always find the rest
    const p = pacedOf(key);
    const room = { maxWaitMs: 0, share: p === null ? 0 : p.perSecond - userRoomOf(p.perSecond) };
    // the walk sends at once (data/solana/trades.ts): counted as it leaves, within the same half of the sends that left
    if (p !== null && (pacer.at(p.url, 1, p.perSecond, { ...room, book: false }) > 0 || pacer.go(p.url, 1, room.share) > 0)) return 1;
    const wait = budget.takeEach(drawsOf(key, [method]), undefined, false, false);
    if (wait === 0 && p !== null) pacer.at(p.url, 1, p.perSecond, room);
    return wait;
  }
  /** That provider answered 429 to a background read: the background reads wait out its reset; callers go on. */
  function backgroundThrottled(chain: RpcChain, url: string, headers: Headers): void {
    const key = keyOf(chain, url);
    if (key !== null) hold(key, upstreamRetryAfterS(headers, now()), "background");
  }
  /** The budget a background read of `url` draws: the chain's provider's, the public endpoint's own when a keyed
   *  Solana provider is set (its fallback, whose budget every reader of it shares), else none (another provider). */
  const keyOf = (chain: RpcChain, url: string): string | null => (url === upstreams[chain].url ? chain : chain === "solana" && keyed && url === SOLANA_PUBLIC ? PUBLIC_KEY : null);

  return { handle, background, backgroundThrottled, slot, pacer };
}
