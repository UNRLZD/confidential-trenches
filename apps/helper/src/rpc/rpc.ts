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
// Keyed-only (card evm-pool-leaves-any-source): POST /v1/rpc/{chain}?keyed=only asks the chain's keyed URLs alone (the
// env-named ones in RPC_UPSTREAMS keyed order, each holding a key: readUpstreams' keyless ones are public endpoints set
// under a keyed name), never an EVM chain's pinned public list, the chain's public fallback or Solana's public endpoint.
// None set, or none answering, is 503 upstream (a throttle still its 429), never a public provider's answer: the device's
// EVM pool sync keeps old logs only when two operators agree, and a public provider it reads itself, relayed here, would
// count as two. Any other value of `keyed` is the route's 400 method_not_allowed (server.ts), before any call.
//
// Refusals, in the kit's error shape { error: { code } } (v1.ts HelperRpcCode and the common codes):
//   404 not_found           a chain that is not one of RPC_CHAINS;
//   413 too_large           a body over RPC_BODY_MAX bytes, or a batch of more than RPC_BATCH_MAX;
//   400 method_not_allowed  everything else that is not a JSON-RPC request whose every method is on the chain's list:
//                           a content type other than JSON, a body that is not JSON, an empty batch, a request that is
//                           not { jsonrpc: "2.0", id, method, params? } with an integer or string id and object or array
//                           params, and a method off the list in any request of a batch.
import { AsyncLocalStorage } from "node:async_hooks";
import { budgetFromEnv, EVM_RANGE_MESSAGE, evmThrottleS, KEYED_COST, KEYED_DAY, KEYED_PACE, keyedDayEnv, LIMIT_WINDOW_MS, LOGS_REFUSED, PROVIDER_PACE, providerHolds, RETRY_AFTER_MAX_S, throttled, upstreamBudget, upstreamRetryAfterS, type BudgetLimits, type KeyedProvider, type Pace, type ProviderHolds } from "../limits/limits.ts";
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
/** The longest a caller's read spends walking its providers, from the read's start (review L4 of 424dce1e): each send
 *  times out by it, and no send starts within WALK_SEND_MIN_MS of it, so a read whose providers hang one after another
 *  is answered (503: the device reads its own) inside the server's 15 s request timeout (server.ts requestTimeout), never
 *  cut off by it. [design: 12 s: the first send keeps its whole RPC_TIMEOUT_MS (NEAR's send_tx waits for execution), and
 *  3 s is left for the answer's write.] */
export const WALK_MS = 12_000;
/** The least time left for a walk's next send to start. [design: a quarter second, about one provider's answer.] */
const WALK_SEND_MIN_MS = 250;
/** A send's timeout with `left` ms of its walk's time left: RPC_TIMEOUT_MS at most, whole ms (AbortSignal.timeout refuses
 *  a fraction, and the clock is a monotonic one in fractional ms). */
const sendMs = (left: number): number => Math.max(1, Math.floor(Math.min(RPC_TIMEOUT_MS, left)));
/** A JSON-RPC answer (one, or a batch) whose error says the provider's plan is spent (slot.ts CREDITS). */
const planSpent = (answer: unknown): boolean => (Array.isArray(answer) ? answer : [answer]).some((a) => CREDITS.test(String((a as { error?: { message?: unknown } } | null)?.error?.message ?? "")));
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
 *  provider may serve the request, and this one still serves the others. Never a range cap (evmRangeCap, its own walk)
 *  or a revert (the call's own answer). */
const SHAPE_CODES: ReadonlySet<unknown> = new Set([-32701, -32601]);
/** And one that does not keep the blocks the request asks (card evm-rpc-spare-list, live run 42206377652: a restore's
 *  Robinhood read stopped on rpc-robinhood.blockmachine.io's -32002 "keyless requests are served for the most recent
 *  5000 blocks only", 2026-11-06 10:56Z): blockvectra's -32011 "block reference is outside the public history window"
 *  (2026-11-04 14:4xZ), PublicNode's "Archive requests require a personal token", "historical state <root> is not
 *  available" (daybreak, bloXroute, Globalstake) and blockmachine's state read "missing trie node" (each read again on
 *  a state read 600 s back, 2026-11-06 12:38-12:40Z). A provider that keeps them may answer it; this one still serves
 *  the newest blocks. */
const SHAPE_WORDS = /specify an address|missing required field 'address'|most recent \d+ blocks|outside the public history window|archive requests require|historical state .*not available|missing trie node/i;
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
/** The span each range cap read live names, by its words (card helper-evm-range-cap-walk; the reads in
 *  packages/wallet/src/pool/evm.ts at the caps' words, and base-pokt.nodies.app's -32001 read 2026-11-06 15:58Z): nodies'
 *  "maximum allowed is 50 blocks", 1rpc.io's "limited to 0 - 50 blocks range", sepolia.base.org's "limited to a 200
 *  range", drpc's "ranges over 10000 blocks", daybreak's "max block range 2000", PublicNode's "maximum block range:
 *  50000", Pocket's "block range exceeds maximum 500", blockmachine's "(max=10000, ...)", Tenderly's "maximum 1000
 *  blocks" (in the error's data), Robinhood's own "but only 30000 are allowed", blastapi's "up to a 10 block range",
 *  thirdweb's "requested blocks is 1000" and "max 10001 blocks". Each names the span in its own place, so each is its
 *  own form: Robinhood's names the asked span first. */
const CAP_SPANS: readonly RegExp[] = [
  /maximum allowed is (\d{1,12}) blocks/i,
  /limited to 0 ?- ?(\d{1,12}) blocks/i,
  /limited to a (\d{1,12}) range/i,
  /ranges over (\d{1,12}) blocks/i,
  /max(?:imum)? block range:? (\d{1,12})/i,
  /block range exceeds maximum (?:allowed \(max=)?(\d{1,12})/i,
  /maximum (\d{1,12}) blocks/i,
  /but only (\d{1,12}) are allowed/i,
  /up to a (\d{1,12}) block range/i,
  /requested blocks is (\d{1,12})/i,
  /\bmax (\d{1,12}) blocks/i,
];
/** What one words cap a read at most: the forms read are under 300 characters, and a hostile answer's words past it are
 *  never read. [design: 1,000.] */
const CAP_WORDS_MAX = 1_000;
/**
 * A provider's range cap in one JSON-RPC error (card helper-evm-range-cap-walk): null when it is none (a revert, a
 * throttle, a shape refusal, anything else); else the span its words name in blocks (CAP_SPANS, read in its message and
 * a string `data`), 0 when they name none (limits.ts EVM_RANGE_MESSAGE's caps on results or size). A cap is the
 * provider's alone: another may serve the span, and this one still serves smaller spans.
 */
export function evmRangeCap(error: unknown): bigint | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as { code?: unknown; message?: unknown; data?: unknown };
  if (typeof e.message !== "string" || e.code === 3 || /revert/i.test(e.message)) return null;
  const words = `${e.message.slice(0, CAP_WORDS_MAX)} ${typeof e.data === "string" ? e.data.slice(0, CAP_WORDS_MAX) : ""}`;
  for (const f of CAP_SPANS) {
    const m = f.exec(words);
    if (m !== null) return BigInt(m[1]!);
  }
  return EVM_RANGE_MESSAGE.test(words) ? 0n : null;
}
/** An EVM answer's (one or a batch) range cap: the largest span any of its errors names, or null when none is a cap. */
function evmCapSpan(chain: RpcChain, answer: unknown): bigint | null {
  if (!EVM_CHAINS.has(chain)) return null;
  let span: bigint | null = null;
  for (const a of Array.isArray(answer) ? answer : [answer]) {
    const s = evmRangeCap((a as { error?: unknown } | null)?.error);
    if (s !== null && (span === null || s > span)) span = s;
  }
  return span;
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
/**
 * `keyed` (card rpc-keyed-lists): the chain's keyed URLs, in the order a read asks them, each name optional and one
 * company each (three keys at one company fail together: on 5 Nov Base reads stopped about 10 min with two providers
 * down at once), but dRPC's three keys, three accounts the owner made because each free key has its own allowance (7 Nov
 * 09:16Z), each its own pace, hold and daily budget (keyedAccountOf). The chain's existing name first, then QuickNode, then
 * dRPC's keys 1, 2 and 3; NEAR's FastNear first (the owner's pick, 7 Nov), then its existing names. The research repo's scripts/deploy/set-rpc-keys.sh writes the new names on the host;
 * after them a read goes to the public spares (`fallback`, and an EVM chain's pinned list, server.ts SWAP_RPCS).
 */
export const RPC_UPSTREAMS: Readonly<Record<RpcChain, { env: string; fallback: string | null; keyed: readonly string[] }>> = {
  solana: { env: "SOLANA_RPC_URL", fallback: "https://api.mainnet-beta.solana.com", keyed: ["SOLANA_RPC_URL", "SOLANA_RPC_URL_QUICKNODE", "SOLANA_RPC_URL_DRPC_1", "SOLANA_RPC_URL_DRPC_2", "SOLANA_RPC_URL_DRPC_3"] },
  base: { env: "BASE_RPC_URL", fallback: "https://mainnet.base.org", keyed: ["BASE_RPC_URL", "BASE_RPC_URL_QUICKNODE", "BASE_RPC_URL_DRPC_1", "BASE_RPC_URL_DRPC_2", "BASE_RPC_URL_DRPC_3"] },
  robinhood: { env: "ROBINHOOD_RPC_URL", fallback: "https://rpc.mainnet.chain.robinhood.com", keyed: ["ROBINHOOD_RPC_URL", "ROBINHOOD_RPC_URL_QUICKNODE", "ROBINHOOD_RPC_URL_DRPC_1", "ROBINHOOD_RPC_URL_DRPC_2", "ROBINHOOD_RPC_URL_DRPC_3"] },
  near: { env: "NEAR_RPC_URL", fallback: "https://rpc.mainnet.fastnear.com", keyed: ["NEAR_RPC_URL_FASTNEAR", "NEAR_RPC_URL", "NEAR_RPC_URL_B"] },
  // the testnet build's second provider: a keyed devnet URL of another operator than api.devnet.solana.com, which the
  // page reads itself as its first (packages/signpage/src/pool-testnet.ts TESTNET_RPCS); none set: off (503), never
  // a silent fallback to that same operator, which would make the page's two reads one provider's (review L-1)
  "solana-devnet": { env: "SOLANA_DEVNET_RPC_URL", fallback: null, keyed: ["SOLANA_DEVNET_RPC_URL"] },
};
/** The company each new keyed name is (card rpc-keyed-lists), whose pace it reads under (limits.ts KEYED_PACE). The
 *  existing names keep the pace they had (the chain's budget, rpc.ts createPacer). */
export const KEYED_PROVIDER: Readonly<Record<string, KeyedProvider>> = {
  SOLANA_RPC_URL_QUICKNODE: "quicknode",
  BASE_RPC_URL_QUICKNODE: "quicknode",
  ROBINHOOD_RPC_URL_QUICKNODE: "quicknode",
  ...Object.fromEntries(["SOLANA", "BASE", "ROBINHOOD"].flatMap((c) => [1, 2, 3].map((n) => [`${c}_RPC_URL_DRPC_${n}`, "drpc" as const]))),
  NEAR_RPC_URL_FASTNEAR: "fastnear",
};
/** The account a keyed name draws its pace, hold and daily budget from (the owner, 7 Nov 09:16Z and 09:27Z): each
 *  QuickNode endpoint its own account ("quicknode-base", "quicknode-robinhood", "quicknode-solana"); each dRPC key its own
 *  ("drpc-1", "drpc-2", "drpc-3": a key is account-wide, every chain's URL of key n is that one account); FastNear one. */
export function keyedAccountOf(name: string): string | undefined {
  const co = KEYED_PROVIDER[name];
  if (co === undefined) return undefined;
  const n = /_DRPC_([1-9])$/.exec(name)?.[1];
  if (n !== undefined) return `${co}-${n}`;
  const chain = /^([A-Z]+)_RPC_URL_QUICKNODE$/.exec(name)?.[1];
  return chain === undefined ? co : `${co}-${chain.toLowerCase()}`;
}
/** A chain's new keyed URLs as set (card rpc-keyed-lists), in order, checked as readUpstreams checks them: the paths
 *  with their own lists (server.ts: the EVM swap reads, Solana's trade walks) put them after the URL they already ask. */
export function keyedSpares(env: Record<string, string | undefined>, chain: RpcChain): string[] {
  return readUpstreams(env)[chain].keyed.filter((k) => KEYED_PROVIDER[k.env] !== undefined).map((k) => k.url);
}
/** Each new keyed URL set and its company's pace, for the helper's one providerHolds (server.ts): with its company's
 *  daily budget (limits.ts KEYED_DAY, or RPC_DAY_<COMPANY>) and the units one call on its chain spends (KEYED_COST). */
export function keyedPaces(env: Record<string, string | undefined>): Record<string, Pace> {
  const out: Record<string, Pace> = {};
  for (const chain of RPC_CHAINS) {
    const family = chain === "near" ? "near" : EVM_CHAINS.has(chain) ? "evm" : "solana";
    for (const k of readUpstreams(env)[chain].keyed) {
      const co = KEYED_PROVIDER[k.env];
      if (co !== undefined) out[k.url] = { ...KEYED_PACE[co], group: keyedAccountOf(k.env), day: keyedDayOf(env, co), cost: KEYED_COST[co][family] };
    }
  }
  return out;
}
/** A company's daily budget: RPC_DAY_<COMPANY> when set (a whole number of its units, 1 to 13 digits; the start stops
 *  on any other, naming the variable), else its plan's (KEYED_DAY). */
export function keyedDayOf(env: Record<string, string | undefined>, co: KeyedProvider): number {
  const name = keyedDayEnv(co);
  const v = env[name];
  if (v === undefined || v === "") return KEYED_DAY[co];
  if (!/^[1-9][0-9]{0,12}$/.test(v)) throw new Error(`${name} must be a whole number of units a day`);
  return Number(v);
}

/** Solana's public endpoint: a keyed SOLANA_RPC_URL's fallback (card helper-solana-failover, rpc/slot.ts). */
export const SOLANA_PUBLIC = RPC_UPSTREAMS.solana.fallback as string;
/** The budget key of the public endpoint when a keyed provider is set: its own budget, the public limits (RPC_BUDGETS
 *  solana: 100 per 10 s, 40 per method), never RPC_BUDGET_SOLANA, which is the keyed plan's. */
const PUBLIC_KEY = "solana-public";
/** The budget key of Solana's keyed spares (card rpc-keyed-lists): the chain's own limits (RPC_BUDGET_SOLANA), drawn
 *  when a read goes straight to them (the first key held or fallen back), so a caller's share holds there too; never the
 *  chain's key, which the first key's 429 holds. */
const SPARES_KEY = "solana-spares";

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
 *  caller's read when the configured one is held or has no room in its pace (callList). */
/** `pacer`: another client's, when this one sends to the same keyed URL (card helper-crowd-429); else its own. */
/** `sleep`: the waits' timer (card helper-rpc-wait-timing), a test's clock beside `now`. */
type Deps = { fetch?: Fetch; now?: () => number; sleep?: (ms: number) => Promise<unknown>; log?: (line: string) => void; slot?: SlotName; publicFallback?: boolean; holds?: ProviderHolds; pinned?: Partial<Record<RpcChain, readonly string[]>>; pacer?: Pacer };
/** `why`: a 429's limit, for the refusal log (limits.ts throttled), never sent. */
/** `timing` (card helper-ready-page-warm): this read's Server-Timing entries, the wait before its send (a hold or the
 *  provider's pace) and the send, and a keyed Solana provider's time before the read fell back to the public endpoint.
 *  Every answer handle() gives has them (card solana-quote-under-1s: POST /v1/rpc sends them, 200, 429 and 503 alike). */
type Answer = RpcAnswer & { headers?: Record<string, string>; why?: string; timing?: string[] };
/** One read's waits and sends, as handle() names them in `timing` (card solana-quote-under-1s): `waitMs`, every hold's
 *  and pace's wait before a send (rpc-wait); `keyedMs`, a keyed Solana provider's time before the read fell back
 *  (rpc-keyed); `last`, the last send, the one that answered when the read did: its time and its provider's environment
 *  NAME (rpc), never its URL, host or key. */
type Trace = { waitMs: number; keyedMs?: number; last?: { name: string; ms: number } };
const traces = new AsyncLocalStorage<Trace>();
/** A trace as Server-Timing entries: rpc-keyed when the read fell back, then rpc-wait and rpc always ("none": no send). */
const timingOf = (t: Trace): string[] => [
  ...(t.keyedMs === undefined ? [] : [`rpc-keyed;dur=${Math.round(t.keyedMs)};desc="fell back"`]),
  `rpc-wait;dur=${Math.round(t.waitMs)}`,
  `rpc;dur=${Math.round(t.last?.ms ?? 0)};desc="${t.last?.name ?? "none"}"`,
];
/** `off`: no URL set for a route with no public fallback (RPC_UPSTREAMS); handle() answers 503 and sends nothing.
 *  `keyed`: every keyed URL set, in RPC_UPSTREAMS order, each with its name, its host and its secret forms; `url` and
 *  `forms` are the first of them, else the public fallback's. */
/** `keyless`: the URL holds no part where a provider puts a key (user, password, a query value, a path segment of 16
 *  characters or more): a public endpoint set under a keyed name, which /v1/health marks so it is not counted as a key. */
type KeyedUrl = { env: string; url: string; host: string; forms: Buffer[]; keyless: boolean };
type Upstream = { url: string; forms: Buffer[]; off?: true; keyed: KeyedUrl[] };

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
    const { fallback } = RPC_UPSTREAMS[chain];
    const keyed: KeyedUrl[] = [];
    for (const name of RPC_UPSTREAMS[chain].keyed) {
      const set = env[name];
      if (set === undefined || set === "") continue;
      let u: URL;
      try {
        u = new URL(set);
      } catch {
        throw new Error(`${name} must be an http(s) URL`);
      }
      if ((u.protocol !== "https:" && u.protocol !== "http:") || u.hash !== "" || /\s/.test(set)) throw new Error(`${name} must be an http(s) URL with no fragment`);
      const secrets = [set, u.href, u.username, u.password, ...u.searchParams.values(), ...u.pathname.split("/").filter((s) => s.length >= 16)];
      // the same URL under two names is one provider: asked once, at its first place
      const keyless = u.username === "" && u.password === "" && [...u.searchParams.values()].every((v) => v === "") && u.pathname.split("/").every((s) => s.length < 16);
      if (!keyed.some((k) => k.url === set)) keyed.push({ env: name, url: set, host: u.host, forms: forms(secrets.filter((s) => s.length >= 8)), keyless });
    }
    const first = keyed[0];
    out[chain] = first !== undefined ? { url: first.url, forms: first.forms, keyed } : fallback === null ? { url: "", forms: [], off: true, keyed } : { url: fallback, forms: [], keyed };
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

/** The pool programs each Solana route may scan with getProgramAccounts: the helper's own pinned pool programs for that
 *  cluster (apps/helper/src/pool/solana.ts POOL_SOLANA_ENV; devnet's a list, comma apart, solanaPoolPrograms, which
 *  refuses a bad one at start), none when unset. */
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
function scanAllowed(r: Record<string, unknown>, programs: readonly string[]): boolean {
  const p = r.params;
  if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string" || !programs.includes(p[0]) || !isPlain(p[1])) return false;
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

/** One checked request, rebuilt from its four fields only, or undefined. `scan`: the route's pinned pool programs. */
function check(chain: RpcChain, r: unknown, scan: readonly string[] = []): Record<string, unknown> | undefined {
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
  const scanPrograms: Partial<Record<RpcChain, readonly string[]>> = Object.fromEntries(Object.entries(RPC_SCAN_PROGRAM_ENV).map(([c, name]) => [c, !env[name] ? [] : c === "solana-devnet" ? env[name]!.split(",") : [env[name]!]]));
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
  const limitsOf = (k: string) => (k === PUBLIC_KEY ? publicLimits : k === SPARES_KEY ? limits.solana : limits[k as RpcChain]);
  const budget = upstreamBudget((key) => {
    const [k, method] = key.split(" ") as [string, string | undefined];
    const l = limitsOf(k);
    return method === undefined ? l : { total: l.perMethod!, perClient: Infinity, reserve: k === PUBLIC_KEY || k === SPARES_KEY ? RPC_RESERVE.solana : RPC_RESERVE[k as RpcChain], userRoom: userRoomOf(l.perMethod!) };
  }, now);
  /** The provider throttled `whose` read on `c` for `seconds`: the chain is held (every draw for a caller's, the
   *  background draws for a background read's), logged as one line with no caller in it. */
  const hold = (c: string, seconds: number, whose: "caller" | "background"): void => {
    budget.hold(c, now() + seconds * 1000, whose === "background");
    log(`rpc hold ${c} ${whose} ${budget.heldFor(c, whose === "background")} s`);
  };
  const pacer = deps.pacer ?? createPacer();
  // card rpc-keyed-lists: the one hold and pace per provider a list walk draws on (server.ts passes the helper's, with
  // every keyed URL's company pace); a client made without one (a test, the holders client) keeps its own
  const holdsAll: ProviderHolds = deps.holds ?? providerHolds(now, { ...PROVIDER_PACE, ...keyedPaces(env) });
  /** Each keyed URL's secret forms, whatever chain it serves: an answer holding any of them is never kept. */
  const formsByUrl = new Map<string, Buffer[]>(RPC_CHAINS.flatMap((ch) => upstreams[ch].keyed.map((k) => [k.url, k.forms] as const)));
  /** The new keyed names' URLs (KEYED_PROVIDER), each under its company's pace and daily budget (holdsAll), never a
   *  chain's pacer or budget key, whatever place it has in its list (review L2). */
  /** A provider's environment name, the one its URL is set under; "public" for an endpoint set under none (a chain's
   *  public fallback, an EVM chain's pinned public spares), whose URL holds no key. Never the URL or any part of it. */
  const nameByUrl = new Map<string, string>(RPC_CHAINS.flatMap((ch) => upstreams[ch].keyed.map((k) => [k.url, k.env] as const)));
  const sentTo = (url: string, from: number): void => {
    const t = traces.getStore();
    if (t !== undefined) t.last = { name: nameByUrl.get(url) ?? "public", ms: now() - from };
  };
  /** A wait before a send, counted as this read's rpc-wait. */
  const waitFor = async (ms: number): Promise<void> => {
    const t0 = now();
    await sleep(ms);
    const t = traces.getStore();
    if (t !== undefined) t.waitMs += now() - t0;
  };
  const companyUrls = new Set(RPC_CHAINS.flatMap((ch) => upstreams[ch].keyed.filter((k) => KEYED_PROVIDER[k.env] !== undefined).map((k) => k.url)));
  /** An existing name's URL on a chain whose reads were paced by its chain's pacer before the walk (NEAR_RPC_URL and
   *  NEAR_RPC_URL_B; call() paces the first): its sends a second there, else 0. An EVM chain's walk never paced them. */
  const ownPace = (c: RpcChain, url: string): number =>
    !EVM_CHAINS.has(c) && upstreams[c].keyed.some((k) => k.url === url && KEYED_PROVIDER[k.env] === undefined) ? Math.max(1, Math.ceil(limits[c].total / (LIMIT_WINDOW_MS / 1000))) : 0;
  /** Whether `c` has a new keyed name set (KEYED_PROVIDER): then every read walks its list (listOf). */
  const walks = (c: RpcChain): boolean => upstreams[c].keyed.some((k) => KEYED_PROVIDER[k.env] !== undefined);
  /** The providers a read on `c` asks, in order: its keyed URLs (else its public fallback first, as before), an EVM chain's
   *  pinned ones, then its public fallback; each once. Solana's walk is call() on the first and solanaRest after it. */
  const listOf = (c: RpcChain): string[] => {
    const fb = RPC_UPSTREAMS[c].fallback;
    const keyedUrls = upstreams[c].keyed.map((k) => k.url);
    return [...new Set([...(keyedUrls.length > 0 ? keyedUrls : fb === null ? [] : [fb]), ...(deps.pinned?.[c] ?? []), ...(fb === null ? [] : [fb])])];
  };
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
  const sleep = deps.sleep ?? ((ms: number) => new Promise((ok) => setTimeout(ok, ms)));
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
   *  at once or after the wait. A wait that wakes inside the same hold (a timer dated from the event loop's clock, read
   *  when its turn began, lib/internal/timers.js getLibuvNow, fires that much early) waits out its rest, a few rounds
   *  at most (card helper-rpc-wait-timing). */
  const holdOver = async (key: string, deadline: number, url?: string, rest: (ms: number) => Promise<unknown> = sleep): Promise<boolean> => {
    const until = heldUntilOf(key, url);
    let t = now();
    if (until <= t) return true;
    if (until > Math.min(deadline, t + HOLD_WAIT_MS)) return false;
    for (let round = 0; round < 3; round++) {
      // a timer can fire a few ms before the clock reads its end: the wait is the hold's end plus HOLD_MARGIN_MS
      await rest(until - t + HOLD_MARGIN_MS);
      if (heldOf(key, url) === 0) return true;
      // a hold set again meanwhile (a later end) is false; the same one still on woke early (an EVM provider's shared
      // hold is read as now plus its ms, so its end moves by a clock's rounding, never by a margin)
      if (heldUntilOf(key, url) > until + HOLD_MARGIN_MS) return false;
      t = now();
    }
    return false;
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
   * holds room for (Discover's), which alone may draw it. `keyedOnly`: the caller's ?keyed=only (card
   * evm-pool-leaves-any-source), the chain's keyed URLs alone.
   */
  async function handle(chain: string, contentType: string | undefined, body: string, client?: string, reserved = false, keyedOnly = false): Promise<Answer> {
    const t: Trace = { waitMs: 0 };
    const a = await traces.run(t, () => route(chain, contentType, body, client, reserved, keyedOnly));
    return { ...a, timing: timingOf(t) };
  }

  async function route(chain: string, contentType: string | undefined, body: string, client: string | undefined, reserved: boolean, keyedOnly: boolean): Promise<Answer> {
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
    // card rpc-keyed-lists: past the first (fallen back, or held by its 429), its keyed spares on their own budget, then
    // the public endpoint
    // review L2: a company's URL first (SOLANA_RPC_URL unset): the whole keyed list is walked under each company's pace
    // review L4: the read's whole walk, every path below, ends by `by`
    const by = now() + WALK_MS;
    // card evm-pool-leaves-any-source: the keyed URLs that hold a key, walked in order; past them 503, never a public one
    if (keyedOnly) {
      const own = upstreams[c].keyed.filter((k) => !k.keyless).map((k) => k.url);
      return own.length === 0 ? UPSTREAM() : callList(c, own, forward, methods, client, reserved, by);
    }
    if (c === "solana" && keyed && companyUrls.has(upstreams.solana.url)) return solanaRest(forward, methods, client, reserved, by, c, 0);
    if (c === "solana" && keyed && upstreams.solana.keyed.length > 1 && (!slot.useKeyed() || budget.heldFor("solana") > 0)) return solanaRest(forward, methods, client, reserved, by, SPARES_KEY);
    if (c === "solana" && keyed && !slot.useKeyed()) return solanaRest(forward, methods, client, reserved, by);
    if ((EVM_CHAINS.has(c) && deps.holds !== undefined && (deps.pinned?.[c]?.length ?? 0) > 0) || (c !== "solana" && walks(c))) return callList(c, listOf(c), forward, methods, client, reserved, by);
    return call(c, upstreams[c].url, upstreams[c].forms, forward, methods, client, reserved, by);
  }

  /**
   * A Solana read the first keyed provider did not serve (its slot fallen back, or it failed this read; card
   * rpc-keyed-lists): the keyed spares in order (callList, the read already drawn on the chain's budget), and only when
   * none of them answers, the public endpoint on its own budget (or 503 for a slot with no public fallback). `key`: the
   * budget the spares draw on (SPARES_KEY) when the read drew on none yet; none when it already drew on the chain's.
   * `from`: the first keyed URL asked (0 when a company's URL is first, review L2). `by`: the read's walk's end (WALK_MS).
   */
  async function solanaRest(forward: string, methods: string[], client: string | undefined, reserved: boolean, by: number, key: string | null = null, from = 1): Promise<Answer> {
    const spares = upstreams.solana.keyed.slice(from).map((k) => k.url);
    if (spares.length > 0) {
      const a = await callList("solana", spares, forward, methods, client, reserved, by, key);
      // a spare's answer; a 429 or 503 here is ours (every spare held, out of pace or down), never a provider's
      if (a.status !== 429 && a.status !== 503) return a;
    }
    return publicFallback ? call(PUBLIC_KEY, SOLANA_PUBLIC, [], forward, methods, client, reserved, by) : UPSTREAM();
  }

  /**
   * A caller's read on a list of providers (card helper-robinhood-capacity fold 2, an EVM chain's pinned ones; card
   * rpc-keyed-lists, any chain's keyed URLs and public spares, listOf): a user's call never
   * pays for the helper's background load. It draws on the chain's budget once (a caller's share, as call() does), then
   * goes to the first of the configured provider and the pinned ones that is not held and has room in its pace for a
   * caller (limits.ts take: background reads leave CALLER_ROOM of it); one that refuses it (its 429, or a throttle in its
   * answer) is held for every path of the helper, and the next is asked. When none can take it, the soonest one's hold
   * or pace wait is waited out when it ends within HOLD_WAIT_MS (card helper-crowd-429's rule), and only past that does
   * the caller get a 429, with the soonest wait any of them names. The chain itself is never held here: a provider's
   * refusal holds that provider alone. A provider's range cap (evmRangeCap) or a refusal of the request's shape
   * (evmShapeRefused) puts it out for this read alone: the next is asked, and once the wait for a held one is spent the
   * cap naming the largest span is the caller's, so the device pages at the biggest any provider serves (card
   * helper-evm-range-cap-walk); a shape refusal only when no provider is held. An answer holding the provider's key is
   * never kept.
   */
  // card rpc-keyed-lists: the walk of any chain's list (listOf: its keyed URLs, then the public spares; Solana's spares
  // after its first keyed one). `key`: the budget the read draws on, the chain's by default; null when it already drew
  // (Solana's first key failed it after its draw). `by`: the read's walk's end (WALK_MS, review L4)
  async function callList(c: RpcChain, providers: readonly string[], forward: string, methods: string[], client: string | undefined, reserved: boolean, by: number, key: string | null = c): Promise<Answer> {
    const holds = holdsAll;
    // review L4: a read that drew on the chain's budget before (Solana's first key failed it) draws its retry on the
    // spares' budget, never the chain's, which that key's 429 holds
    const bk = key ?? (c === "solana" ? SPARES_KEY : c);
    // card helper-crowd-429's rule on this path too: a hold that ends within HOLD_WAIT_MS and by `deadline` is waited out
    // (the chain's, or the soonest of its providers' when none could take the read), then the read is asked once more
    const deadline = now() + HOLD_WAIT_MS + PACE_MAX_MS;
    if (key !== null) {
      if (!(await holdOver(key, deadline, undefined, waitFor))) return throttled(budget.heldFor(key), undefined, `${key} held`);
      const wait = budget.takeEach(drawsOf(key, methods), client, false, reserved);
      if (wait > 0) return throttled(wait, undefined, budget.refusedBy());
    }
    // a log read is never sent to a provider that refuses every one (LOGS_REFUSED): its 429 would hold it for the reads
    // it does answer
    const list = providers.filter((u) => !(methods.includes("eth_getLogs") && LOGS_REFUSED.has(u)));
    for (let tries = 0; ; tries++) {
      let soonestMs = Infinity;
      let down = false;
      let sent = false;
      let shaped: { status: number; body: string } | undefined;
      let capped: { span: bigint; status: number; body: string } | undefined;
      for (const url of list) {
        // review L4: no send starts once the walk's time is nearly spent; the read is answered inside the server's timeout
        if (by - now() < WALK_SEND_MIN_MS) {
          down = true;
          break;
        }
        const secretForms = formsByUrl.get(url) ?? [];
        // review M1, L3: a URL whose plan takes fewer requests a post than this read carries (dRPC free: 3, its HTTP 400
        // code 31 past it), or whose second's bucket is smaller than the read, is out for this read: the next is asked
        const p = holds.paceOf(url);
        if (p !== undefined && (methods.length > (p.batch ?? Infinity) || (p.unit === "call" && methods.length > p.burst))) {
          down = true;
          continue;
        }
        // review M3: a URL past its day's budget is out until the next UTC day, which is no wait: down for this read
        if (holds.dayOut(url, methods.length)) {
          down = true;
          continue;
        }
        const h = holds.heldMs(url);
        if (h > 0) {
          soonestMs = Math.min(soonestMs, h);
          continue;
        }
        // review L2: NEAR's existing names keep their chain's pacer on the walk, as call() paced them
        const own = ownPace(c, url);
        const gate = own > 0 ? pacer.go(url, methods.length, own) : 0;
        if (gate > 0) {
          soonestMs = Math.min(soonestMs, gate);
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
        const from = now();
        try {
          r = await doFetch(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: forward, redirect: "error", signal: AbortSignal.timeout(sendMs(by - now())) });
          if (r.status === 429) {
            await r.body?.cancel();
            sentTo(url, from);
            const s = upstreamRetryAfterS(r.headers, now());
            holds.hold(url, s);
            log(`rpc hold ${c} ${companyOf(new URL(url).host)} caller ${s} s`);
            soonestMs = Math.min(soonestMs, holds.heldMs(url));
            continue;
          }
          text = await readAnswer(r);
          sentTo(url, from);
        } catch {
          sentTo(url, from);
          down = true;
          continue;
        }
        // review M1: a keyed URL's other 4xx (400, 402, 413: its plan refusing the read) is that URL down for this read
        if (r.status === 401 || r.status === 403 || r.status >= 500 || r.status < 200 || (r.status >= 300 && r.status < 400) || (r.status >= 400 && formsByUrl.has(url)) || text === undefined || !/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(r.headers.get("content-type") ?? "")) {
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
        // review M2: a keyed URL whose plan is spent may answer 200 with a JSON-RPC error naming it: that URL is down for
        // this read, as call() takes it for Solana's first key, and the next is asked
        if (formsByUrl.has(url) && planSpent(answer)) {
          down = true;
          continue;
        }
        const limited = evmLimited(c, answer);
        if (limited > 0) {
          holds.hold(url, limited);
          log(`rpc hold ${c} ${companyOf(new URL(url).host)} caller ${limited} s`);
          soonestMs = Math.min(soonestMs, holds.heldMs(url));
          continue;
        }
        // a provider's range cap: out for this read alone (no hold: it serves smaller spans and every other read); the
        // largest span named is kept for the caller when every provider caps (card helper-evm-range-cap-walk)
        // an answer that holds this provider's key in any form is that provider down for this read: never kept, so a
        // clean cap or refusal from another still answers (review fold 1)
        const leaks = secretForms.some((f) => Buffer.from(text, "utf8").includes(f));
        const span = evmCapSpan(c, answer);
        if (span !== null) {
          if (leaks) down = true;
          else if (capped === undefined || span > capped.span) capped = { span, status: r.status, body: text };
          continue;
        }
        // a provider that cannot serve this request's shape is out for it alone (no hold: its other requests still go to
        // it); the next is asked, and the last such answer is the caller's when every provider refuses it so
        if (evmShapeRefused(c, answer)) {
          if (leaks) down = true;
          else shaped = { status: r.status, body: text };
          continue;
        }
        // review L3: an answer echoing the key is that provider down for this read (never forwarded); the next is asked
        if (leaks) {
          down = true;
          continue;
        }
        return { status: r.status, body: text };
      }
      // none could take it: the soonest provider's short hold or pace wait is waited out, and the read asked again (a
      // read sent and refused draws on the budget once more, as any send does)
      const waitMs = soonestMs + HOLD_MARGIN_MS;
      if (tries < 2 && soonestMs <= HOLD_WAIT_MS && now() + waitMs <= deadline) {
        await waitFor(waitMs);
        if (!sent) continue;
        const again = budget.takeEach(drawsOf(bk, methods), client, false, reserved);
        if (again === 0) continue;
        return throttled(again, undefined, budget.refusedBy());
      }
      // the wait spent: the cap naming the largest span, safe to page on, even with a provider still held (review fold
      // 4: a read with no spare, the mainnet W Transfer read, would otherwise end unread under repeated holds); a shape
      // refusal only when no provider is held, else the caller's wait below (the device would take the refusal as the
      // read's answer)
      if (capped !== undefined) return { status: capped.status, body: capped.body };
      if (shaped !== undefined && soonestMs === Infinity) return { status: shaped.status, body: shaped.body };
      // every provider failed (none held or out of room; a company past its day's budget is down, review M3): upstream,
      // so the device reads its own; else the soonest wait
      return down && soonestMs === Infinity ? UPSTREAM() : throttled(soonestMs === Infinity ? RETRY_AFTER_MAX_S : Math.min(RETRY_AFTER_MAX_S, Math.max(1, Math.ceil(soonestMs / 1000))), undefined, `${c} every provider held`);
    }
  }


  /**
   * One call to one provider: `key` is its budget (a chain, or PUBLIC_KEY). The provider's reset holds every caller, the
   * helper's own reads too; then the call draws on the budget's total (a caller's share too) and each method's, a batch
   * one per request in it, all or none. A keyed Solana provider that fails the call (rpc/slot.ts) has it carried to the
   * public endpoint at once, so its fall never reaches the caller as an error.
   */
  async function call(key: string, url: string, secretForms: Buffer[], forward: string, methods: string[], client: string | undefined, reserved: boolean, by: number): Promise<Answer> {
    const c = (key === PUBLIC_KEY ? "solana" : key) as RpcChain;
    const viaSlot = c === "solana" && keyed && key !== PUBLIC_KEY;
    const begun = now();
    // card helper-rpc-wait-timing: the time this call spent in a hold's or the pace's wait, its rpc-wait; the call's
    // own work between them is not (sent - begun read a slow runner's 0.5 ms of it as rpc-wait;dur=1)
    // card solana-quote-under-1s: the waits are the read's trace's (handle), the rpc-wait of every answer
    const rest = waitFor;
    /** The key failed this call: the slot is told, and the call goes to the public endpoint (or 503 with none). Its
     *  time before the fall is the read's rpc-keyed, and the waits and send after it are the fallback's own. */
    const fellBack = (): Promise<Answer> => {
      if (!publicFallback) return Promise.resolve(UPSTREAM());
      const t = traces.getStore();
      if (t !== undefined) Object.assign(t, { keyedMs: now() - begun, waitMs: 0, last: undefined });
      return solanaRest(forward, methods, client, reserved, by);
    };
    // card helper-crowd-429: a hold that ends within HOLD_WAIT_MS is waited out and the send paced from its end, and a
    // send the provider throttles is sent once more after its short hold, all by `deadline`; a longer hold is the
    // caller's 429 with its seconds. An EVM chain's provider is held for every path of the helper that reads it (Deps
    // holds, card helper-robinhood-capacity): that hold is waited out and paced from the same way.
    const shared = EVM_CHAINS.has(c) ? url : undefined;
    const heldAt = (): number => heldOf(key, shared);
    const deadline = now() + HOLD_WAIT_MS + PACE_MAX_MS;
    if (!(await holdOver(key, deadline, shared, rest))) return throttled(heldAt(), undefined, `${key} held`);
    const wait = budget.takeEach(drawsOf(key, methods), client, false, reserved);
    if (wait > 0) return throttled(wait, undefined, budget.refusedBy());
    let r!: Response;
    let text: string | undefined;
    let sent = now();
    for (let tries = 0; ; tries++) {
      const room = Math.max(0, Math.min(PACE_MAX_MS, deadline - now()));
      const paced = pace(key, methods.length, room, shared);
      if (paced > room) return throttled(Math.max(1, Math.ceil((paced - room) / 1000)), undefined, `${key} pace`);
      if (paced > 0) await rest(paced);
      // the hold is read again right before the send: the provider may have asked us to wait while this one waited
      // for its second (card helper-rpc-hold-queued); a short one is waited out and the send paced again
      if (heldAt() > 0) {
        if (tries < 2 && (await holdOver(key, deadline, shared, rest))) continue;
        return throttled(Math.max(1, heldAt()), undefined, `${key} held`);
      }
      // the send counted where it leaves (Pacer.go), within the deadline
      const p = pacedOf(key);
      const goBy = performance.now() + Math.max(0, deadline - now());
      let gate = p === null ? 0 : pacer.go(p.url, methods.length, p.perSecond);
      for (let round = 0; gate > 0; round++) {
        // a few rounds at most: each waits for a send to leave the second, so more mean a crowd past the deadline
        if (round >= 4 || performance.now() + gate > goBy) return throttled(Math.max(1, Math.ceil(gate / 1000)), undefined, `${key} pace`);
        await rest(gate);
        gate = pacer.go(p!.url, methods.length, p!.perSecond);
      }
      if (heldAt() > 0) return throttled(Math.max(1, heldAt()), undefined, `${key} held`);
      // review L4: the public endpoint after a walk's spares is sent only inside the read's walk time
      if (by - now() < WALK_SEND_MIN_MS) return UPSTREAM();
      sent = now();
      try {
        r = await doFetch(url, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: forward,
          redirect: "error",
          signal: AbortSignal.timeout(sendMs(by - now())),
        });
        if (r.status === 429) {
          const body = viaSlot ? ((await readAnswer(r).catch(() => undefined)) ?? "") : (await r.body?.cancel(), "");
          sentTo(url, sent);
          const waitS = upstreamRetryAfterS(r.headers, now());
          if (viaSlot && (CREDITS.test(body) ? (slot.fail("credits"), true) : slot.throttled(waitS))) return fellBack();
          hold(key, waitS, "caller");
          // card rpc-keyed-lists: the first key throttled us: this read goes on to its keyed spares now, and the next
          // reads too while its hold lasts (handle)
          if (viaSlot && upstreams.solana.keyed.length > 1) return fellBack();
          if (shared !== undefined) deps.holds?.hold(url, waitS);
          // sent once more after a short hold, drawing on the budget as any send does
          if (tries < 2 && (await holdOver(key, deadline, shared, rest))) {
            const again = budget.takeEach(drawsOf(key, methods), client, false, reserved);
            if (again === 0) continue;
            return throttled(again, undefined, budget.refusedBy());
          }
          return throttled(Math.max(1, heldAt()), undefined, `${key} provider 429`);
        }
        text = await readAnswer(r);
        sentTo(url, sent);
      } catch {
        sentTo(url, sent);
        if (viaSlot) return slot.unanswered(sent), fellBack();
        return UPSTREAM();
      }
      break;
    }
    if (viaSlot && (r.status === 401 || r.status === 403)) return slot.fail(String(r.status)), fellBack();
    if (viaSlot && r.status >= 400 && CREDITS.test(text ?? "")) return slot.fail("credits"), fellBack();
    if (viaSlot && r.status >= 500) return slot.unanswered(sent), fellBack();
    if (r.status === 401 || r.status === 403 || r.status >= 500 || r.status < 200 || (r.status >= 300 && r.status < 400)) return UPSTREAM();
    // review M1: a keyed Solana URL's other 4xx (its plan refusing the read) is that URL down for this read: it goes on to
    // the keyed spares and the public endpoint (the key is not failed: it serves other reads). A chain read here has no
    // other provider to ask (its list walks in callList), so its provider's 4xx stays the caller's answer, as before
    if (viaSlot && r.status >= 400) return fellBack();
    if (text === undefined || !/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(r.headers.get("content-type") ?? "")) return viaSlot ? (slot.unanswered(sent), fellBack()) : UPSTREAM();
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      return viaSlot ? (slot.unanswered(sent), fellBack()) : UPSTREAM();
    }
    // a JSON-RPC error that says the plan is spent is the key's end, as a 401 is
    if (viaSlot && planSpent(answer)) return slot.fail("credits"), fellBack();
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
    return { status: r.status, body: text };
  }

  /**
   * The helper's own background reads that reach a chain's provider by another path (data/solana/trades.ts, with the
   * provider's URL): `url` is this chain's provider when it is the one configured here, and then each request draws
   * from the chain's budget as a background read (userRoomOf), waiting out any hold on it. A URL that is another
   * provider draws nothing here. Returns the seconds to wait, 0 to go.
   */
  function background(chain: RpcChain, url: string, method: string): number {
    const key = keyOf(chain, url);
    // card rpc-keyed-lists: a keyed spare of this chain (not its first) is read under its company's pace and hold, as a
    // background read (limits.ts take: it leaves CALLER_ROOM for callers' reads)
    if (key === null) {
      if (!isSpare(chain, url)) return 0;
      const ms = holdsAll.heldMs(url) || holdsAll.take(url, 1, true);
      return ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : 0;
    }
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
    else if (isSpare(chain, url)) {
      const s = upstreamRetryAfterS(headers, now());
      holdsAll.hold(url, s);
      log(`rpc hold ${chain} ${companyOf(new URL(url).host)} background ${s} s`);
    }
  }
  const isSpare = (chain: RpcChain, url: string): boolean => (url !== upstreams[chain].url || companyUrls.has(url)) && upstreams[chain].keyed.some((k) => k.url === url);

  /** Each keyed URL's last probe (card rpc-keyed-lists), for /v1/health: "unread" until its first; and when it was. */
  const probed = new Map<string, KeyedState>();
  const probedAt = new Map<string, number>();
  /** Every keyed URL each mainnet chain's list holds, in order, as "<company's domain> <last probe>" (companyOf), a
   *  URL with no key in it as "<company's domain> keyless <last probe>" (review M3: not a second key of its company);
   *  never a path, a query or a key. */
  function keyedHealth(): Record<KeyedChain, string[]> {
    return Object.fromEntries(KEYED_CHAINS.map((c) => [c, upstreams[c].keyed.map((k) => `${companyOf(k.host)}${keyTag(k.env)}${k.keyless ? " keyless" : ""} ${probed.get(k.url) ?? "unread"}`)])) as Record<KeyedChain, string[]>;
  }
  /**
   * One identity read of every keyed URL (KEYED_IDENTITY: the chain id or genesis it must answer), each under its
   * company's pace as a background read (one skipped while its pace, its day's budget or any hold on it says wait, its
   * last state kept: review L5, the chain's hold on its first URL included). A URL is read again once its last read is
   * KEYED_PROBE_MS old, or KEYED_RETRY_MS when it did not answer its chain (review L6: a deploy's live check sees a
   * passing 429 or timeout cleared within minutes). Nothing a provider answers leaves here but the state.
   */
  async function probe(): Promise<void> {
    await Promise.all(
      KEYED_CHAINS.flatMap((c) =>
        upstreams[c].keyed.map(async (k) => {
          const age = now() - (probedAt.get(k.url) ?? -Infinity);
          if (age < (probed.get(k.url) === "answers" ? KEYED_PROBE_MS : KEYED_RETRY_MS)) return;
          if (k.url === upstreams[c].url && budget.heldFor(c, true) > 0) return;
          if (holdsAll.heldMs(k.url) > 0 || holdsAll.take(k.url, 1, true) > 0) return;
          probedAt.set(k.url, now());
          let state: KeyedState = "down";
          try {
            const r = await doFetch(k.url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: KEYED_IDENTITY[c].body, redirect: "error", signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
            if (r.status === 429) {
              await r.body?.cancel();
              holdsAll.hold(k.url, upstreamRetryAfterS(r.headers, now()));
              state = "held";
            } else {
              const text = await readAnswer(r);
              if (r.status === 200 && text !== undefined) state = KEYED_IDENTITY[c].ok(JSON.parse(text)) ? "answers" : "wrong chain";
            }
          } catch {
            state = "down";
          }
          probed.set(k.url, state);
        }),
      ),
    );
  }
  /** The budget a background read of `url` draws: the chain's provider's, the public endpoint's own when a keyed
   *  Solana provider is set (its fallback, whose budget every reader of it shares), else none (another provider). */
  const keyOf = (chain: RpcChain, url: string): string | null => (url === upstreams[chain].url && !companyUrls.has(url) ? chain : chain === "solana" && keyed && url === SOLANA_PUBLIC ? PUBLIC_KEY : null);

  return { handle, background, backgroundThrottled, slot, pacer, keyed: keyedHealth, probe };
}

/**
 * A keyed URL's company as /v1/health names it: its host's last two labels (quiknode.pro, drpc.org, fastnear.com,
 * helius-rpc.com), an IP address or a one-label host as it is. Not the whole host: /v1/health answers 1 KB at most (the
 * kit's HELPER_V1_PATHS row), and twelve QuickNode endpoint names (about 45 characters each) would pass it; the company
 * is what one key per company needs to show.
 */
export function companyOf(host: string): string {
  const h = host.replace(/:\d+$/, "");
  if (/^[\d.]+$/.test(h) || h.startsWith("[")) return h;
  return h.split(".").slice(-2).join(".");
}
/** Each company's other domain, folded into the one companyOf names for it: dRPC's keyed endpoints are lb.drpc.live
 *  (drpc.org/docs/gettingstarted/firstrequest), its keyless ones *.drpc.org. */
const SAME_COMPANY: Readonly<Record<string, string>> = { "drpc.live": "drpc.org" };
/** The company that runs a provider URL (companyOf, its other domains folded in): two answers "agree" only from two of
 *  these (review M1 of 424dce1e: dRPC's key 1 and key 2 are one operator answering twice). */
export function operatorOf(url: string): string {
  const c = companyOf(new URL(url).host);
  return SAME_COMPANY[c] ?? c;
}
/** A keyed name's key of several at one company, as /v1/health names it (" key2" for a chain's _DRPC_2), else none: each
 *  is its own account, so the live check counts each as its own keyed provider. */
const keyTag = (name: string): string => {
  const n = /_DRPC_([1-9])$/.exec(name)?.[1];
  return n === undefined ? "" : ` key${n}`;
};
/** The chains whose keyed lists /v1/health names (card rpc-keyed-lists): mainnet's four. */
export const KEYED_CHAINS = ["solana", "base", "robinhood", "near"] as const;
export type KeyedChain = (typeof KEYED_CHAINS)[number];
/** A keyed URL's last probe: it answered its chain, answered another chain, refused us for a while (429), failed (an
 *  error, a timeout, not 200 JSON), or is not probed yet. */
export type KeyedState = "answers" | "wrong chain" | "held" | "down" | "unread";
/** How old a keyed URL's identity read may get while it answers its chain (review M2). [design: 10 min: 144 reads a
 *  day per URL, QuickNode's three 10,080 credits a day, 3% of its daily budget (limits.ts KEYED_DAY), against the 60 s
 *  probe's 100,800, 30% of the trial.] */
export const KEYED_PROBE_MS = 600_000;
/** How often the probe runs (server.ts), and so how soon a URL that did not answer its chain is read again (review L6).
 *  [design: a minute: a down URL's read a minute, and a deploy's live check, re-reading /v1/health for 3 min, sees a
 *  passing 429 or timeout cleared.] */
export const KEYED_RETRY_MS = 60_000;
/** Each chain's identity read and the answer it must give: the chain ids and Solana's genesis hash research
 *  scripts/deploy/set-rpc-keys.sh checks a URL against before it writes it (Base 0x2105 = 8453, Robinhood 0x1237 =
 *  4663, NEAR's status chain_id "mainnet"). */
const SOLANA_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const KEYED_IDENTITY: Readonly<Record<KeyedChain, { body: string; ok: (a: unknown) => boolean }>> = {
  base: { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), ok: (a) => (a as { result?: unknown } | null)?.result === "0x2105" },
  robinhood: { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), ok: (a) => (a as { result?: unknown } | null)?.result === "0x1237" },
  solana: { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }), ok: (a) => (a as { result?: unknown } | null)?.result === SOLANA_GENESIS },
  near: { body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "status", params: [] }), ok: (a) => (a as { result?: { chain_id?: unknown } } | null)?.result?.chain_id === "mainnet" },
};
