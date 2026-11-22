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
// count as two. NEAR's keyed URLs here are FastNEAR's alone (NEAR_SEAT: the page's other NEAR seat is dRPC). Any other
// value of `keyed` is the route's 400 method_not_allowed (server.ts), before any call.
//
// Refusals, in the kit's error shape { error: { code } } (v1.ts HelperRpcCode and the common codes):
//   404 not_found           a chain that is not one of RPC_CHAINS;
//   413 too_large           a body over RPC_BODY_MAX bytes, or a batch of more than RPC_BATCH_MAX;
//   400 method_not_allowed  everything else that is not a JSON-RPC request whose every method is on the chain's list:
//                           a content type other than JSON, a body that is not JSON, an empty batch, a request that is
//                           not { jsonrpc: "2.0", id, method, params? } with an integer or string id and object or array
//                           params, and a method off the list in any request of a batch.
import { AsyncLocalStorage } from "node:async_hooks";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  evmPoolVenues,
  HELPER_SOLANA_BLOCK_HEADER,
  POOL_USD_FEEDS,
  secretScrubber,
  SOLANA_AMM_V4_PROGRAM,
  SOLANA_CLMM_PROGRAM,
  SOLANA_CPMM_PROGRAM,
  SOLANA_USDC_MINT,
  SOLANA_DLMM_PROGRAM,
  SOLANA_SOL_MINT,
  solanaAmmV4PoolScan,
  solanaClmmPoolScan,
  solanaCpmmPoolScan,
  solanaDlmmPairScan,
} from "@blindfill/kit";
import { budgetFromEnv, EVM_RANGE_MESSAGE, evmThrottleS, KEYED_COST, KEYED_DAY, KEYED_PACE, keyedDayEnv, LIMIT_CLIENTS, LIMIT_WINDOW_MS, LOGS_REFUSED, PROVIDER_PACE, providerHolds, RETRY_AFTER_MAX_S, throttled, upstreamBudget, upstreamRetryAfterS, type BudgetLimits, type KeyedProvider, type Pace, type ProviderHolds } from "../limits/limits.ts";
import { RPC_BATCH_MAX, RPC_BODY_MAX, RPC_CHAINS, RPC_METHODS, type RpcChain } from "./methods.ts";
import { createSlot, CREDITS, SLOT_RETRY_MS, type Slot, type SlotName } from "./slot.ts";
import { companyOf, isKeyless, keyTag, operatorOf, providerName } from "./operator.ts";
import { BATCH_SIZES, batchRefusal, type BatchSizes } from "./batch-sizes.ts";
import { emptyStore, POOL_LOGS_FROM, poolFile, poolPage, type PoolLog, type PoolStore, storeAppend, storeLogs, topicsOf } from "./pool-logs.ts";
// re-exported: the names other modules import from here (operator.ts is the leaf the token watch imports alone)
export { companyOf, operatorOf, providerName };

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
 * Requests one caller draws per chain per window on a public endpoint (on our keyed providers each route's share is
 * RPC_PAGE_NEED's): what a device's
 * one-transaction trade asks of one provider when it fills within its read burst, from the kit's own pattern
 * (packages/kit/src/trade/solana/send.ts): the send (l.6-8), the burst of C = B/5 = 8 status reads over the keyless
 * B = 40 (l.190-193), and a blockhash read, about 11, rounded up to 16.
 */
export const RPC_CLIENT_MAX = 16;
/**
 * The most one signing page draws from a route in its busiest 10 s, each route's share at least this, whatever
 * RPC_BUDGET_<CHAIN> says (card helper-gives-a-trade-its-reads: on 11 Nov 05:09Z /v1/rpc/solana answered 16 getSlot of
 * one address and refused the 17th, 429 retry-after 6, while a page reads it as its seat B):
 *   - solana (the page's seat B, packages/signpage/src/trade.ts) and solana-devnet (the testnet build's, so a devnet
 *     run meets the mainnet share): 42. The app's recorded devnet runs (apps/terminal/test/e2e/buy/run.answers.json on
 *     card app-sell-e2e-in-the-app) drew the route 33 in their busiest 10 s (run 8, 04:37Z, the buy) and 42 (run 9,
 *     05:03Z, the buy, its seat A throttled); the page's budget per host (packages/wallet/src/throttle.ts PASS_BUDGET
 *     30, PASS_BUDGET_TRADING 20 beside a trade's own reads, card signpage-passes-yield-to-a-trade) is 30 with no trade
 *     and 20 plus a trade's 22 helper reads with one: 42.
 *   - solana-marks (the mark lister) and base, robinhood (the EVM pools' holdings and history reads): 30. Only the
 *     page's background passes read them, never a trade's reads, and the page's budget per host holds those to 30.
 *   - near (the page's FastNEAR seat, ?keyed=only, beside dRPC read device-direct; card near-quote-under-the-pace): 90.
 *     The most the page's own pace of the seat lets out in any 10 s (packages/wallet/src/pace.ts PACE.seat: 30 at once,
 *     then 5 a second, 80; card near-seat-pace-fits-one-quote), so one page is never refused here: one quote is about
 *     29 seat reads at its block (DCL 19, Rhea 4, the final block, decimals, the fee cap about 4; app lead, 18 Nov
 *     02:39Z), sent in the pace's one burst, and a buy's busiest 10 s was 52 (packages/signpage/test/near-seat-down.test.ts).
 *     The 10 over 80 for sends the network moves closer together than the page let them out. At 30 a session's first
 *     buy met this share's 429 once and waited out its seconds.
 * The share of a chain on our keyed providers (keyedBudget) and the least RPC_BUDGET_<CHAIN> may name. Callers at their
 * full share at once: (the total less RPC_RESERVE) / this; on the deployed lists (summedTotal: Helius free's 100 and
 * QuickNode's half, 135) three on Solana.
 */
export const RPC_PAGE_NEED: Readonly<Partial<Record<RpcChain, number>>> = { solana: 42, "solana-devnet": 42, "solana-marks": 30, base: 30, robinhood: 30, near: 90 };
/**
 * A route's 10 s total on its keyed providers when its first key is this company's (keyedBudget), where that company's
 * published rate sets it, else RPC_BUDGETS':
 *   - near, FastNEAR's key first (NEAR_RPC_URL_FASTNEAR): 600, the key at its pace (limits.ts KEYED_PACE fastnear: 60 a second, read from Dev's published "up
 *     to 10,000" requests a minute per key, docs.fastnear.com/pricing, 2026-11-18 02:50Z), so the route's own pacer
 *     (pacedOf: the total over 10 s, 60 in any PACE_SECOND_MS) sends two callers' quotes of 29 reads in one second, and
 *     six callers find their full share (RPC_PAGE_NEED near, 90) at once. Before it, the default 100 paced the seat at 10
 *     a second, so one quote's 29 reads took three seconds of turns (card near-seat-pace-fits-one-quote).
 * The public fallback keeps RPC_BUDGETS' (a route with no key draws it), and so does another keyed URL first or after it
 * (NEAR_RPC_URL, NEAR_RPC_URL_B: ownPace), whose operator published no rate here.
 */
export const RPC_KEYED_TOTAL: Readonly<Partial<Record<RpcChain, Partial<Record<KeyedProvider, number>>>>> = { near: { fastnear: 600 } };
/**
 * Requests of one method the public Solana endpoint takes in 10 s from every caller together: "Maximum number of
 * requests per 10 seconds per IP for a single RPC: 40" (clusters.mdx:154, the same "Mainnet rate limits" list as
 * RPC_CHAIN_MAX). Without it three callers at their share of one method (3 x 16 getSignatureStatuses) make the
 * endpoint throttle, and its reset holds the chain for every caller. A keyed provider names its own as the third
 * number of RPC_BUDGET_SOLANA, or none (two numbers: no limit per method).
 */
export const RPC_METHOD_MAX = 40;
/** The longest a send waits for a keyed provider's second to have room. [design: 2 s: at Helius free's 10 a second a
 *  burst sent at once gets 20 in, and a page's reads, spread over its window (RPC_PAGE_NEED), never wait that long.] */
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
/**
 * Finalized logs outside the caller's share (card helper-pool-logs-outside-the-caller-budget). A fresh sign-in reads each
 * EVM pool's whole deposit history on the keyed-only route, its second seat, page by page from the pool's deploy block:
 * the same pages for every device (packages/wallet/src/pool/evm.ts, EVM_POOL_LOG_PAGE_BLOCKS doubling to
 * EVM_POOL_LOG_PAGE_MAX_BLOCKS). Those logs never change once their blocks are finalized, so on that route an eth_getLogs
 * alone in its request, its fromBlock and toBlock block numbers and toBlock at or below the chain's finalized head as the
 * helper reads it (never as the caller says), is kept by its exact params and answered again from here with the caller's
 * id, drawing nothing of the caller's share (RPC_PAGE_NEED) or the chain's total: on the vault lead's run (af4fc86da, 14
 * Nov) the pool's 8 pages took 1.3 s alone and 16-31 s inside a sign-in's other reads on the same share. A first ask
 * draws as every read does; a tag ("latest", "finalized") or a range past the head is never kept. Every answer kept is a
 * provider's well-formed 200 with a result list and no key in it (callList); the page still takes a log only on both of
 * its seats' same logs, so a kept answer can stall a sign-in, never steer one.
 * The bound: LOG_CACHE_ENTRIES answers and LOG_CACHE_BYTES of params and answers together, the least recently used out
 * first, each kept LOG_CACHE_MS at most (a provider's wrong answer would otherwise stall every sign-in that reads that
 * page until the helper restarts). [design: 1,024 entries: a pool's life is 8 pages at 800,000 blocks; 32 MiB: an
 * RPC_ANSWER_MAX page is 4 MiB, so eight of the largest fit; 1 h: sign-ins an hour apart share the walk.]
 */
export const LOG_CACHE_ENTRIES = 1_024;
export const LOG_CACHE_BYTES = 32 * 1024 * 1024;
export const LOG_CACHE_MS = 60 * 60 * 1000;
/** The helper reads a chain's finalized head (eth_getBlockByNumber "finalized" on the keyed list, on the chain's total,
 *  no caller's share) at most once this often, and only for a page that ends past the head it holds. [design: 10 s: the
 *  page's tail reads past the head on every round; Robinhood's finalized block lags its head 155 s or more.] */
export const FINAL_HEAD_MS = 10_000;
/**
 * The widest eth_getLogs range, in blocks (toBlock - fromBlock + 1), each keyed company's plan serves (card
 * helper-base-logs-page), at its plan today: a plan change is a change here. A name of no company here (an existing name
 * such as ROBINHOOD_RPC_URL, Alchemy's Pay As You Go, "unlimited" per robinhood-alchemy-key.sh) has no known span: it
 * is asked any range, as before.
 *   - QuickNode: "the block range limit for this RPC method is 5 blocks for users on the Free Trial plan", paid plans
 *     10,000 (quicknode.com/docs/base/eth_getLogs, read 2026-11-15 02:4xZ); the owner's endpoints are on the trial
 *     (KEYED_DAY's note, limits.ts).
 *   - dRPC, the free keys: the helper's keyed Base route, read live 2026-11-15 02:37Z, answered the pool's eth_getLogs
 *     over 5, 10, 11, 50 and 100 blocks on BASE_RPC_URL_DRPC_1 (98-108 ms, Server-Timing), and 101 blocks a 429 after
 *     its keys refused it (rpc;desc="BASE_RPC_URL_DRPC_2", 8 ms), 102, 120 and 200 blocks 503 (code 35 "ranges over
 *     10000 blocks are not supported on freetier", HTTP 400: data/evm/index.ts, packages/wallet/src/pool/evm.ts). 100.
 * A log read on the keyed-only route goes only to the providers whose span covers it (a QuickNode trial asked 100 blocks
 * spends 20 credits on a refusal); one no provider covers is paged (LOGS_PAGES_MAX).
 */
export const KEYED_LOGS_SPAN: Readonly<Partial<Record<KeyedProvider, number>>> = { quicknode: 5, drpc: 100 };
/**
 * The most pages one eth_getLogs on the keyed-only route is split into (card helper-base-logs-page): a range wider than
 * every keyed provider's span (KEYED_LOGS_SPAN) is read in pages of the widest one's span, sent to the providers of that
 * span, and joined in order as one answer. Past this many pages (or the chain's 10 s total, or the pages the providers'
 * pace serves inside a send's wait, pagesServed, when smaller: 13 on dRPC's free plan) the read is
 * refused before any send with a JSON-RPC range cap naming the span served (LOGS_CAP_CODE: "maximum block range: N", a
 * form the page's pager reads, packages/wallet/src/pool/evm.ts CAP_SPANS), so the page asks narrower ranges. Each
 * caller's paged reads draw on their own allowance, this many pages a 10 s window (logsKey), never the caller's share.
 * [design: 100: on Base's dRPC keys 10,000 blocks, the card's end state, about 5.5 h of chain at 200 ms blocks; 100 calls
 * are 2,000 CU of a dRPC key's 7,000,000 a day (limits.ts KEYED_DAY, KEYED_COST), and 100 pages at the three keys' 24
 * a second take about 4 s of the read's WALK_MS.]
 */
export const LOGS_PAGES_MAX = 100;
/** The JSON-RPC code of the helper's own range cap: invalid params, as Pocket's and PublicNode's caps. */
const LOGS_CAP_CODE = -32602;
/** The asks one page gets (pagedLogs): its worker's provider, then the page's whole list for each ask after. */
const LOGS_PAGE_TRIES = 3;
/** The budget key callers' paged eth_getLogs draw on (LOGS_PAGES_MAX), one per chain; no space, so never a method's. */
const logsKey = (c: RpcChain): string => `${c}:logs`;
/** Card helper-base-trade-reads-429: the budget a walk's send to one of `c`'s keyed URLs draws (createRpc keysGated). */
const keysKey = (c: RpcChain): string => `${c}:keys`;
/** A block number as an EVM node writes it: 0x, lowercase or uppercase hex, no leading zero, at most 64 bits. */
const BLOCK_NUMBER = /^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/;
/**
 * A cold walk too (the first sign-in after a helper restart, the cache empty): a first ask of a finalized page of the
 * chain's own pool's logs (its address alone, the kit's pin, evmPoolVenues) draws on the chain's total under its own
 * name for the caller, POOL_LOGS_CLIENT and the caller's address, so it never spends the caller's share (RPC_PAGE_NEED)
 * and the caller's other reads never spend it. That allowance is the chain's page share again, 30 per 10 s on Base and
 * Robinhood: one cold walk of Robinhood's pool is 10 pages on 14 Nov 17:08Z (100,000, 200,000, 400,000 blocks, then
 * 800,000, from block 108,420,674 to the finalized head 114,302,775, the last clipped), about one page more for each day
 * of the pool's life (a block every 100 ms), so it fits three times over and stays inside one window until the pool is
 * about 20 days old, past which a walk goes on in the next window after the 429's wait. Base's is 3 pages. The risk it
 * opens, bounded: one caller can spend 30 paid-key calls per 10 s more than before, only on finalized pages of the
 * pool's own logs, each one filling the cache so asking it again costs nothing; every one still draws on the chain's
 * total, so callers together never pass the providers' plan.
 */
export const POOL_LOGS_CLIENT = "pool-logs";
/**
 * A device's pool index sync (card helper-robinhood-route-serves-a-device-sync; the kit's checks/evm/pool-index.ts, whose
 * second Robinhood reader is this route, buy-unpinned.ts `index`): a read on the keyed-only route whose every request is
 * an eth_getLogs of the chain's PoolManager (as the kit pins it, evmPoolVenues) for its Initialize event, a coin's read
 * included (more topics after it), or an eth_getBlockByNumber, the span's last block the kit asks beside each, draws
 * under its own name for the caller, INDEX_CLIENT and the caller's address: never the caller's share (RPC_PAGE_NEED),
 * which the page's background passes draw on the same address (packages/wallet/src/pool/buy-wallets.ts, 18 in 10 s).
 * On 21 Nov a fresh device's first Robinhood quote at a 6-day snapshot age met one 429 from this route on each of three
 * runs, 34-35 s each: the sync alone is 12 posts and 23 calls in 12.5 s (read from macOS through the deployed route,
 * 21 Nov 17:02Z, commit 19a264d25, no 429), under the share of 30 in 10 s, but with the passes beside it past it, and
 * the kit holds a reader 30 s on any 429 (quote.ts EVM_PROVIDER_HOLD_MS). The allowance is the chain's page share again,
 * 30 per 10 s: an index is read one span at a time (parallel 1, perBatch 1, two calls a post), so a sync of up to 14
 * spans, 7,000,000 blocks, about 8.5 days of Robinhood, fits one window whatever its speed, and a longer one goes on in
 * the next after the 429's Retry-After. Every call still draws on the chain's total (139 in 10 s on the deployed
 * Robinhood list, RateLimit-Policy), so callers together never pass it: at Alchemy's 60 compute units an eth_getLogs
 * (alchemy.com/docs/reference/compute-unit-costs, read 21 Nov 17:0xZ) the whole total is 834 a second, under Pay As You
 * Go's 10,000 (alchemy.com/docs/reference/pricing-plans, read the same minute). The risk it opens, bounded: one caller
 * can spend 30 paid-key calls per 10 s more, only on the PoolManager's Initialize logs and block reads.
 */
export const INDEX_CLIENT = "pool-index";
/** The PoolManager's Initialize event, topic 0 (the kit's pool-index.ts INITIALIZE). */
export const INITIALIZE_TOPIC = `0x${Buffer.from(keccak_256(Buffer.from("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"))).toString("hex")}`;
/** Whether `out`, one checked request or a batch, is a pool index read of `poolManager` (INDEX_CLIENT): every request an
 *  eth_getLogs of that address with Initialize as topic 0, or an eth_getBlockByNumber, and at least one eth_getLogs. */
function indexReadOf(chain: RpcChain, out: unknown, poolManager: string | undefined): boolean {
  if (!EVM_CHAINS.has(chain) || poolManager === undefined) return false;
  const reqs = (Array.isArray(out) ? out : [out]) as Record<string, unknown>[];
  const logs = (r: Record<string, unknown>): boolean => {
    if (r.method !== "eth_getLogs" || !Array.isArray(r.params) || r.params.length !== 1) return false;
    const f = r.params[0];
    return isPlain(f) && typeof f.address === "string" && f.address.toLowerCase() === poolManager && Array.isArray(f.topics) && typeof f.topics[0] === "string" && f.topics[0].toLowerCase() === INITIALIZE_TOPIC;
  };
  return reqs.some(logs) && reqs.every((r) => logs(r) || r.method === "eth_getBlockByNumber");
}
/**
 * The pool store's fill (card helper-keyed-logs-serve-a-whole-pool-range, pool-logs.ts): the pages it sends a second,
 * every chain's fill and all their providers together, one at a time. A page draws nothing of the route's total (the chain's /v1/rpc
 * budget, keyedBudget and summedTotal: KEYED_ROUTE_SHARE of each key's pace, which is the callers'), so a fill never
 * costs a caller a 429: on 16 Nov 01:14-01:53Z (release with PR 865) its 6 a second were 60 of Base's 155 a 10 s, and
 * callers had 95 left. It draws only its provider's pace and day as a background read (limits.ts take): under
 * CALLER_ROOM of the bucket, and none for CALLER_HOLD_MS after a caller's draw there, so it takes only the room callers
 * leave, from the keys' other half (KEYED_ROUTE_SHARE); a provider's 429 or throttle holds that provider for every path,
 * as any read's does. The bucket it draws is dRPC's one for the helper's IP (limits.ts DRPC_IP_PACE, 20 a second), so a
 * caller's draw on any key stops the fill on every key for CALLER_HOLD_MS (card helper-base-keyed-holds-under-load).
 * [design: 10: half of that bucket, sent one page at a time (about 100 ms an answer on dRPC's Base keys), so callers
 * and the market-data reads keep the other half whenever they want it. Base's pool from its deploy block (54,325,671)
 * to the finalized head of 16 Nov (about 57,973,600) is 36,480 pages of dRPC's 100 blocks: about 61 min and 729,600 CU
 * (20 a call, KEYED_COST) once, of the three keys' 21,000,000 a day; then 4,320 pages a day as the chain grows (a block
 * every 200 ms, read 16 Nov 00:1xZ on base-rpc.publicnode.com: 100,000 blocks in 20,000 s), 7 min of fill and 86,400
 * CU. Live at 6 a second it moved 0.62 pages a second (223,000 blocks in about an hour, 16 Nov 03:2x-04:3xZ), each
 * key backed off up to 256 s on dRPC's 429s (POOL_BACK_MAX). With HELPER_STORE_DIR set the
 * store is kept there, so a restart starts warm. Robinhood's first keyed URL (ROBINHOOD_RPC_URL, Alchemy, no span named)
 * takes the whole range in one page.]
 */
export const POOL_FILL_PER_S = 10;
/** The fill stops after this many pages in a row no provider served (down, refused, out of its day); the next pool read
 *  past what is kept starts it again. [design: 20, about 3 s of pages at POOL_FILL_PER_S.] */
export const POOL_FILL_FAILS = 20;
/** How often a running fill writes its store to HELPER_STORE_DIR (and once when it ends). [design: a minute: 360 pages
 *  at most are read again after a crash.] */
export const POOL_WRITE_MS = 60_000;
/** At the head the fill follows it, reading the finalized head again this often (card base-reads-never-throttled): a
 *  fill that ended at the head left the store behind by Base's 5 blocks a second, so after about 15 min a device's
 *  whole-range read had a tail past the store (that lag plus the 5,362 unfinalized blocks read 16 Nov 12:55Z on
 *  mainnet.base.org) wider than the route's 10,000 and was answered "maximum block range: 10000", paging 10,000 at a
 *  time to the head (the wallet's restore, 16 Nov 11:59-12:06Z). [design: a minute: 300 of Base's blocks behind at
 *  most, so a tail stays near 5,700; 1,440 head reads and as many pages a day, a chain.] */
export const POOL_FOLLOW_EVERY_MS = 60_000;
/** The follow ends after this long with no pool read through the route, and the next read starts the fill again.
 *  [design: 6 h: a quiet night costs no reads past it; the read that ends one is answered the route's cap once.] */
export const POOL_FOLLOW_IDLE_MS = 6 * 60 * 60_000;
/** A provider's refusal of a fill page (its 429 or rate error) holds that provider for the fill alone, never for a
 *  caller: the wait it names or 2^k s, whichever is longer, k its refusals of the fill in a row less its pages served
 *  since, at most this many. [design: live 16 Nov 02:50-03:17Z the fill's 429s held dRPC's keys for every caller, about
 *  80 times a minute, and callers were refused "every provider held"; 4: at most 16 s between asks. At 8 (256 s) the
 *  three keys sat out 256 s 14 times and 128 s 9 times in 16 Nov 03:59-04:33Z, and the fill moved 0.62 pages a second;
 *  under dRPC's IP bucket (DRPC_IP_PACE) a refusal is a passing one, so the fill is back within seconds.] */
export const POOL_BACK_MAX = 4;
/** A request the finalized-logs cache may keep (LOG_CACHE_ENTRIES): one eth_getLogs, one filter with numbers for both ends
 *  and no blockHash; its key (the chain and the exact params as sent), its toBlock, and whether its address is the
 *  chain's pool (`pool`, the kit's pin, lowercase), alone. Anything else: null. */
function finalLogsOf(chain: RpcChain, r: Record<string, unknown>, pool: string | undefined): { key: string; from: bigint; to: bigint; pool: boolean } | null {
  if (!EVM_CHAINS.has(chain) || r.method !== "eth_getLogs" || !Array.isArray(r.params) || r.params.length !== 1) return null;
  const f = r.params[0];
  if (!isPlain(f) || Object.hasOwn(f, "blockHash") || typeof f.fromBlock !== "string" || typeof f.toBlock !== "string") return null;
  if (!BLOCK_NUMBER.test(f.fromBlock) || !BLOCK_NUMBER.test(f.toBlock)) return null;
  const from = BigInt(f.fromBlock);
  const to = BigInt(f.toBlock);
  return from > to ? null : { key: `${chain} ${JSON.stringify(r.params)}`, from, to, pool: pool !== undefined && typeof f.address === "string" && f.address.toLowerCase() === pool };
}
/** A send's timeout with `left` ms of its walk's time left: RPC_TIMEOUT_MS at most, whole ms (AbortSignal.timeout refuses
 *  a fraction, and the clock is a monotonic one in fractional ms). */
const sendMs = (left: number): number => Math.max(1, Math.floor(Math.min(RPC_TIMEOUT_MS, left)));
/** dRPC's codes for a spent plan (card drpc-over-quota-falls-over), from its own error table
 *  (github.com/drpcorg/drpc-agent-skills skills/drpc-rpc/errors.md, commit ccb130ef 2026-04-06, read 2026-11-16 07:05Z):
 *  "10 | 403 | User balance exceeded", "24 | 403 | Daily key limit exceeded", "52 | 403 | Subscription limit exceeded",
 *  "53 | 403 | Free monthly limit reached". As a 403 the walk already takes a keyed URL as down; dRPC also answers its
 *  own codes inside a 200 (its NEAR throttle, code 15: card restore-waits-out-a-near-throttle), where none of CREDITS'
 *  words is in them, so the code alone marks it. A keyed provider of another company with one of these codes is only
 *  asked past for that read. */
export const DRPC_PLAN_CODES: ReadonlySet<number> = new Set([10, 24, 52, 53]);
/** A JSON-RPC answer (one, or a batch) whose error says the provider's plan is spent (slot.ts CREDITS, DRPC_PLAN_CODES). */
export const planSpent = (answer: unknown): boolean =>
  (Array.isArray(answer) ? answer : [answer]).some((a) => {
    const e = (a as { error?: { message?: unknown; code?: unknown } } | null)?.error;
    return CREDITS.test(String(e?.message ?? "")) || (typeof e?.code === "number" && DRPC_PLAN_CODES.has(e.code));
  });
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
export function createPacer(clock: () => number = () => performance.now()) {
  const booked = new Map<string, number[]>();
  /** Per URL: when each send left, oldest first. */
  const left = new Map<string, number[]>();
  return {
    /**
     * When `n` sends to `url` may go so that no PACE_SECOND_MS holds more than `perSecond` of them, `fromMs` from now
     * on (a hold's end) and after every send booked before (first come, first sent), `share` the most of a second's
     * room these may fill (a background read: half, so a caller always finds the rest). Booked when within `maxWaitMs`
     * (and `book`), else only named: the ms to wait. Every time here is `clock`: createRpc's `now`, by default the
     * process's monotonic clock (performance.now), never the wall clock: on the box Date.now() stepped back 0.5 s and 8 s inside a test (traced
     * 4 Nov 22:14Z), and bookings on it let 11 sends into one real second, then refused callers for the step's length.
     */
    at(url: string, n: number, perSecond: number, opts: { fromMs?: number; maxWaitMs: number; share?: number; book?: boolean }): number {
      const t = clock();
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
      const t = clock();
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
export const RPC_RESERVE: Readonly<Record<RpcChain, number>> = { solana: 3, base: 0, robinhood: 0, near: 0, "solana-devnet": 0, "solana-marks": 0 };
/**
 * The part of each chain's total, and of each method's, the helper's own background reads never draw (card
 * helper-ready-gate): the trade walks and the SOL price reads (data/solana/trades.ts) go only while half stays free,
 * whatever callers drew, so a walk that would take the whole budget leaves a caller's read its room (4 Nov 06:24-06:30Z:
 * the walks, outside this budget, drew the public endpoint's 100 and every token read answered 429 for six minutes).
 * [design: half: the public 100 keeps 50 for callers, three at their full RPC_CLIENT_MAX share (on Solana's summed 135,
 * one page at its RPC_PAGE_NEED share while the walks hold their half, three once they do not); the walks keep 47, a cold
 * read of COLD_SIGS transactions a few seconds, and move to their next provider when it is spent.]
 */
export const userRoomOf = (limit: number): number => Math.ceil(limit / 2);
/** Each chain's budget on its public endpoint unless RPC_BUDGET_<CHAIN> says; only Solana's public endpoint publishes a
 *  limit per method. A chain on our keyed providers draws keyedBudget instead. */
export const RPC_BUDGETS: Readonly<Record<RpcChain, BudgetLimits & { perMethod?: number }>> = {
  solana: { total: RPC_CHAIN_MAX, perClient: RPC_CLIENT_MAX, perMethod: RPC_METHOD_MAX },
  base: { total: RPC_CHAIN_MAX, perClient: RPC_CLIENT_MAX },
  robinhood: { total: RPC_CHAIN_MAX, perClient: RPC_CLIENT_MAX },
  near: { total: RPC_CHAIN_MAX, perClient: RPC_CLIENT_MAX },
  // mainnet's public numbers: under what api.devnet.solana.com's headers named (x-ratelimit-rps-limit 250,
  // x-ratelimit-method-limit 150, read 5 Nov 15:03Z); a keyed SOLANA_DEVNET_RPC_URL names its plan's in RPC_BUDGET_SOLANA_DEVNET
  "solana-devnet": { total: RPC_CHAIN_MAX, perClient: RPC_CLIENT_MAX, perMethod: RPC_METHOD_MAX },
  // the mark scan's second route: its providers' own paces and daily budgets (keyedPaces) bound it as they bound Solana's
  "solana-marks": { total: RPC_CHAIN_MAX, perClient: RPC_CLIENT_MAX, perMethod: RPC_METHOD_MAX },
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
/** A chain's budget on our keyed providers unless RPC_BUDGET_<CHAIN> names the plan's: the chain's total (Helius free's
 *  100 per 10 s on Solana, the rpc.ts header) and one page's share (RPC_PAGE_NEED), no limit per method (a keyed plan
 *  names its own as a third number). Not the public endpoint's share: there 42 of one method would leave others none. */
export const keyedBudget = (chain: RpcChain, first?: KeyedProvider): BudgetLimits => ({ total: (first === undefined ? undefined : RPC_KEYED_TOTAL[chain]?.[first]) ?? RPC_BUDGETS[chain].total, perClient: RPC_PAGE_NEED[chain] ?? RPC_CLIENT_MAX });
/**
 * The part of each company key's 10 s pace (limits.ts KEYED_PACE: QuickNode 7 a second, dRPC's three keys 20 together,
 * one bucket, counted once) a route's total counts (card helper-serves-many-users-at-once). [design: half: the same keys serve the market-data reads (the
 * EVM swap and maker reads, server.ts evmSwapRpcs; Solana's trade walks, solanaTradesRpcs) and Solana's mark list
 * (solana-marks), which draw their buckets first come (limits.ts take), so /v1/rpc's callers may take at most half and
 * the token page always finds the other half.]
 */
export const KEYED_ROUTE_SHARE = 0.5;
/** Card helper-solana-slots-off-a-spent-key: the sends a second the rpc slot may take on another slot's key (the
 *  holders key while SOLANA_RPC_URL's plan is spent): KEYED_ROUTE_SHARE of the plan's second (`plan` per 10 s), at least
 *  1, so that slot's own reads always find the other half on the helper's one pacer (server.ts gives the holders client
 *  the rpc client's). */
export const slotShareOf = (plan: number): number => Math.max(1, Math.floor(Math.ceil(plan / 10) * KEYED_ROUTE_SHARE));
/** The routes whose total sums their keyed providers: the ones the signing page reads beside a trade (RPC_PAGE_NEED).
 *  NEAR keeps its total, which the helper's own reads draw on; solana-marks walks its keys (all company keys, each
 *  paced on its own) under its total as before. */
const SUMMED: ReadonlySet<RpcChain> = new Set(["solana", "base", "robinhood"]);
/** A route's 10 s total on its keyed providers: its first key's plan (`own`: RPC_BUDGET_<CHAIN>'s total, else the
 *  default, when an existing name such as SOLANA_RPC_URL is set; none when only company keys are) plus
 *  KEYED_ROUTE_SHARE of each company key's 10 s pace; never under the share and the reserve (a one-key route whose
 *  key's pace is smaller still sends no more than that pace: callList takes each send from its bucket).
 *  `spares` (card helper-base-trade-reads-429): the other providers the route's walk sends to (listOf: an EVM chain's
 *  pinned public list and its fallback) with their paces, each counted as a company key is, at KEYED_ROUTE_SHARE (the
 *  same lists serve the market-data reads, swaps.ts SWAP_RPCS), one bucket once; one with no pace counts none. Live run
 *  44930704040 (21 Nov 17:34Z): Base's total was the keys' 39 alone (QuickNode 35, dRPC 4 at base-reads-never-throttled's
 *  pace), one page's share of 30 left 9 for every other caller, and two checks' draws in the same seconds refused a
 *  page's 12th read, while the walk's public providers had room. */
export function summedTotal(chain: RpcChain, keyed: readonly { env: string }[], own: number, share: number, env: Record<string, string | undefined> = {}, spares: readonly (readonly [string, Pace | undefined])[] = []): number {
  const companies = keyed.filter((k) => KEYED_PROVIDER[k.env] !== undefined);
  if (!SUMMED.has(chain) || companies.length === 0) return own;
  const plan = keyed.some((k) => KEYED_PROVIDER[k.env] === undefined) ? own : 0;
  // each bucket once: keys on one rate (dRPC's three on its per-IP bucket, limits.ts DRPC_IP_PACE) are one pace
  const buckets = new Map<string, number>();
  for (const k of companies) {
    const p: Pace = keyedPaceOf(env, KEYED_PROVIDER[k.env]!);
    buckets.set(p.rate ?? keyedAccountOf(k.env)!, p.perS);
  }
  for (const [url, p] of spares) if (p !== undefined) buckets.set(p.rate ?? url, p.perS);
  const room = [...buckets.values()].reduce((n, perS) => n + Math.floor(perS * (LIMIT_WINDOW_MS / 1000) * KEYED_ROUTE_SHARE), 0);
  return Math.max(plan + room, share + RPC_RESERVE[chain] + 1);
}
/** The least share RPC_BUDGET_<CHAIN> (a keyed plan's) may name: a full batch, and what one page draws (RPC_PAGE_NEED). */
export const rpcLeastShare = (chain: RpcChain): number => Math.max(RPC_BATCH_MAX, RPC_PAGE_NEED[chain] ?? 0);
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
  // card sol-pools-mainnet-pin: the mainnet mark scan's second route (methods.ts SOLANA_MARKS), Solana's keyed names
  // past SOLANA_RPC_URL, then the keyless ones that serve the scan (MARKS_KEYLESS); a provider on the company of the
  // first route's provider in use (marksRoutes) is never asked
  "solana-marks": { env: "SOLANA_RPC_URL_QUICKNODE", fallback: null, keyed: ["SOLANA_RPC_URL_QUICKNODE", "SOLANA_RPC_URL_DRPC_1", "SOLANA_RPC_URL_DRPC_2", "SOLANA_RPC_URL_DRPC_3"] },
};
/** The first route's first provider for the mark scan (getProgramAccounts on /v1/rpc/solana; card
 *  sol-pools-mainnet-pin): never the public endpoint, and, card helper-solana-off-a-spent-key, passed for the next
 *  keyed Solana URL while its plan is spent (marksRoutes), always on another company than route B's. */
export const MARKS_A_ENV = "SOLANA_RPC_URL";
/**
 * Route B's keyless providers, asked after its keyed names (marksRoutes), each by the name its answer's Server-Timing
 * gives (card solana-marks-route-answers, reopened). Live 20 Nov 18:45Z route B answered every scan 503 at 0 ms: its one
 * keyed provider, QuickNode, was past the day this helper allows it (the box's day files: 321,150 of quicknode-solana's
 * 322,580, 232,410 of it by plain reads that fell onto QuickNode while SOLANA_RPC_URL's plan was spent), and every
 * user's sign-in restore stalled. Read from the box then, the restore's exact scan (bucket 0 of sizes 13 and 17):
 * api.mainnet-beta.solana.com and public.rpc.solanavibestation.com answered HTTP 200 with the same 14 and 26 accounts as
 * QuickNode and Helius; solana-rpc.publicnode.com 403 ("Indexed requests require a personal token"), solana.drpc.org
 * 400 ("chain is not available on free plan"), Ankr 403, OnFinality 429, Tatum "available for paid plans only". A list
 * only names addresses (marksRoutes' note below), so a keyless lister decides nothing a keyed one would not.
 */
export const MARKS_KEYLESS: readonly { name: string; url: string }[] = Object.freeze([
  { name: "SOLANA_MARKS_FOUNDATION", url: "https://api.mainnet-beta.solana.com" },
  { name: "SOLANA_MARKS_SVS", url: "https://public.rpc.solanavibestation.com" },
]);
/** The one operator POST /v1/rpc/near?keyed=only sends to (operatorOf; card near-quote-under-the-pace): the signing
 *  page's other NEAR seat is dRPC, read device-direct, so this one is FastNEAR's key. */
export const NEAR_SEAT = "fastnear.com";
/**
 * The most reads one caller's ?keyed=only NEAR seat takes in a UTC day (review P3-2 of e6c66cce3). Without it one
 * caller at its share (30 a 10 s window) is 259,200 a day against FastNEAR's key's 322,580 (limits.ts KEYED_DAY), so
 * two callers end the seat for every page until midnight. Past it the caller's 429 names RETRY_AFTER_MAX_S, which the
 * page takes for the seat down and reads its keyless spare (packages/wallet/src/pace.ts nearSeatRpc). [design: 15,000:
 * 300 trades a day of about 50 seat reads each (a buy 47, a session's first 53 with Rhea's pool pages:
 * packages/signpage/test/near-seat-down.test.ts); 21 callers at it fill the key's day.]
 */
export const NEAR_SEAT_DAY = 15_000;
const SEAT_DAY_MS = 86_400_000;
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
      if (co !== undefined) out[k.url] = { ...keyedPaceOf(env, co), group: keyedAccountOf(k.env), day: keyedDayOf(env, co), cost: KEYED_COST[co][family] };
    }
  }
  return out;
}
/** A company's pace (card base-reads-never-throttled): RPC_PACE_<COMPANY> when set, "<calls a second>,<at once>" (a
 *  paid plan's rate: dRPC's free plan answers about a call a second from the helper's IP, its paid plans far more,
 *  limits.ts DRPC_IP_PACE; the start stops on any other value, naming the variable), else its plan's (KEYED_PACE). */
export function keyedPaceOf(env: Record<string, string | undefined>, co: KeyedProvider): Pace {
  const name = `RPC_PACE_${co.toUpperCase()}`;
  const v = env[name];
  if (v === undefined || v === "") return KEYED_PACE[co];
  const m = /^([0-9]{1,4}(?:\.[0-9]{1,3})?),([1-9][0-9]{0,3})$/.exec(v);
  if (m === null || Number(m[1]) <= 0) throw new Error(`${name} must be "<calls a second>,<at once>", such as 20,4`);
  return { ...KEYED_PACE[co], perS: Number(m[1]), burst: Number(m[2]) };
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
/** `seatClients`: how many callers the NEAR seat's day map holds (LIMIT_CLIENTS); smaller only in a test. */
type Deps = { seatClients?: number; fetch?: Fetch; now?: () => number; sleep?: (ms: number) => Promise<unknown>; log?: (line: string) => void; slot?: SlotName; publicFallback?: boolean; holds?: ProviderHolds; pinned?: Partial<Record<RpcChain, readonly string[]>>; pacer?: Pacer; batch?: BatchSizes };
/** `why`: a 429's limit, for the refusal log (limits.ts throttled), never sent. */
/** `timing` (card helper-ready-page-warm): this read's Server-Timing entries, the wait before its send (a hold or the
 *  provider's pace) and the send, and a keyed Solana provider's time before the read fell back to the public endpoint.
 *  Every answer handle() gives has them (card solana-quote-under-1s: POST /v1/rpc sends them, 200, 429 and 503 alike). */
type Answer = RpcAnswer & { headers?: Record<string, string>; why?: string; timing?: string[] };
/** One upstream's answer to one read as fitPost reads it: its status and headers, and its body (undefined: past
 *  RPC_ANSWER_MAX). */
type Sent = { status: number; headers: Headers; text: string | undefined };
/** One read's waits and sends, as handle() names them in `timing` (card solana-quote-under-1s): `waitMs`, every hold's
 *  and pace's wait before a send (rpc-wait); `keyedMs`, a keyed Solana provider's time before the read fell back
 *  (rpc-keyed); `last`, the last send, the one that answered when the read did: its time and its provider's environment
 *  NAME (rpc), never its URL, host or key. */
/** `shape`: an EVM read's rpcShape, which its hold and refusal log lines carry (card base-reads-never-starve-max). */
type Trace = { waitMs: number; keyedMs?: number; last?: { name: string; ms: number }; cached?: true; pages?: { n: number; ms: number }; shape?: string };
const traces = new AsyncLocalStorage<Trace>();
/** The longest rpcShape: one log line per hold, so a hostile body never grows the log past it. */
export const RPC_SHAPE_MAX = 200;
/**
 * A checked JSON-RPC request (or batch) as a log line names it (card base-reads-never-starve-max): its method (one of
 * the chain's allowed, RPC_METHODS) and its params with every value as its kind and length alone: a string "s<length>",
 * a number "n", true or false "b", null "null", a list its first four members and "+<n>" more, an object its first six
 * keys (a key that is no plain name: "?"), three levels deep ("…" past them); a batch "batch<n>" and its first three.
 * So a held or refused read names the function that sent it (eth_getLogs over a filter, a balanceOf eth_call, a block
 * read), never an address, a block number, a key or the caller. At most RPC_SHAPE_MAX characters.
 */
export function rpcShape(req: unknown): string {
  const val = (v: unknown, depth: number): string => {
    if (typeof v === "string") return `s${v.length}`;
    if (typeof v === "number") return "n";
    if (typeof v === "boolean") return "b";
    if (v === null) return "null";
    if (depth >= 4) return "…";
    if (Array.isArray(v)) return `[${v.slice(0, 4).map((x) => val(x, depth + 1)).join(",")}${v.length > 4 ? `,+${v.length - 4}` : ""}]`;
    if (typeof v === "object") {
      const keys = Object.keys(v as object);
      const named = keys.slice(0, 6).map((k) => `${/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k) ? k : "?"}:${val((v as Record<string, unknown>)[k], depth + 1)}`);
      return `{${named.join(",")}${keys.length > 6 ? `,+${keys.length - 6}` : ""}}`;
    }
    return "?";
  };
  const one = (r: unknown): string => {
    const m = (r as { method?: unknown } | null)?.method;
    const method = typeof m === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(m) ? m : "?";
    return Object.hasOwn(r as object, "params") ? `${method}${val((r as { params: unknown }).params, 0)}` : method;
  };
  const s = Array.isArray(req) ? `batch${req.length} ${req.slice(0, 3).map(one).join(" ")}` : one(req);
  return s.length > RPC_SHAPE_MAX ? `${s.slice(0, RPC_SHAPE_MAX - 1)}…` : s;
}
/** The current EVM read's shape as a log line's tail (" <shape>"), "" for any other read. */
const shapeTail = (): string => {
  const s = traces.getStore()?.shape;
  return s === undefined ? "" : ` ${s}`;
};
/** A trace as Server-Timing entries: rpc-keyed when the read fell back, rpc-cache when the finalized-logs cache answered
 *  it (LOG_CACHE_ENTRIES), rpc-pages when it was paged (pagedLogs: its pages' time and count; their waits and sends ran
 *  side by side, so they are not summed into rpc-wait), then rpc-wait and rpc always ("none": no send). */
const timingOf = (t: Trace): string[] => [
  ...(t.keyedMs === undefined ? [] : [`rpc-keyed;dur=${Math.round(t.keyedMs)};desc="fell back"`]),
  ...(t.cached === undefined ? [] : ['rpc-cache;desc="hit"']),
  ...(t.pages === undefined ? [] : [`rpc-pages;dur=${Math.round(t.pages.ms)};desc="${t.pages.n}"`]),
  `rpc-wait;dur=${Math.round(t.waitMs)}`,
  `rpc;dur=${Math.round(t.last?.ms ?? 0)};desc="${t.last?.name ?? "none"}"`,
];
/** `off`: no URL set for a route with no public fallback (RPC_UPSTREAMS); handle() answers 503 and sends nothing.
 *  `keyed`: every keyed URL set, in RPC_UPSTREAMS order, each with its name, its host and its secret forms; `url` and
 *  `forms` are the first of them, else the public fallback's. */
/** `keyless`: the URL holds no part where a provider puts a key (user, password, a query value, a path segment of 16
 *  characters or more): a public endpoint set under a keyed name, which /v1/health marks so it is not counted as a key. */
export type KeyedUrl = { env: string; url: string; host: string; forms: Buffer[]; keyless: boolean };
export type Upstream = { url: string; forms: Buffer[]; off?: true; keyed: KeyedUrl[] };

const error = (status: number, code: string): RpcAnswer => ({ status, body: JSON.stringify({ error: { code } }) });
const REFUSED = () => error(400, "method_not_allowed");
const UPSTREAM = () => error(503, "upstream");

/** The kit's one rule (secretScrubber) for each keyed URL, built once. */
const ruleOf = new Map<string, (text: string) => string>();
const keysIn = (s: string): number => s.split("<key>").length - 1;
/**
 * Does `url`'s answer hold its key (card helper-scrubber-takes-the-kits-rule)? One of its secret forms exactly, anywhere
 * in the text; or, in the words of its JSON-RPC errors (`answer` parsed), any secret part of the URL as the kit's one
 * rule finds it: in another case, cut short, a path key under 16 characters. A result is chain data, never read so (an
 * 8-character start of a hex key may stand in any long hex). A URL with no secret forms (a public endpoint) holds none.
 */
export function answerHoldsKey(url: string, forms: readonly Buffer[], text: string, answer: unknown): boolean {
  if (forms.length === 0) return false;
  const b = Buffer.from(text, "utf8");
  if (forms.some((f) => b.includes(f))) return true;
  const words = (Array.isArray(answer) ? answer : [answer]).flatMap((a) => (typeof a === "object" && a !== null && "error" in a ? [JSON.stringify((a as { error: unknown }).error) ?? ""] : [])).join(" ");
  if (words === "") return false;
  let rule = ruleOf.get(url);
  if (rule === undefined) ruleOf.set(url, (rule = secretScrubber([url])));
  return keysIn(rule(words)) > keysIn(words);
}

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
/** `names`' URLs set in `env`, in order, each checked as readUpstreams checks a keyed URL; the same URL under two names
 *  is one provider: asked once, at its first place. */
function keyedUrlsOf(env: Record<string, string | undefined>, names: readonly string[]): KeyedUrl[] {
  const keyed: KeyedUrl[] = [];
  for (const name of names) {
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
    const keyless = isKeyless(u);
    if (!keyed.some((k) => k.url === set)) keyed.push({ env: name, url: set, host: u.host, forms: forms(secrets.filter((s) => s.length >= 8)), keyless });
  }
  return keyed;
}

export function readUpstreams(env: Record<string, string | undefined>): Record<RpcChain, Upstream> {
  const out = {} as Record<RpcChain, Upstream>;
  for (const chain of RPC_CHAINS) {
    const { fallback } = RPC_UPSTREAMS[chain];
    const keyed = keyedUrlsOf(env, RPC_UPSTREAMS[chain].keyed);
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

/**
 * Past records an upstream may have dropped (card helper-receipts-past-retention): a receipt or a transaction by its hash,
 * a block by its number. An upstream that no longer keeps one answers it null, as one behind /v1/rpc/robinhood?keyed=only
 * did on 19 Nov 02:20Z for 10 of 10 Initialize receipts of blocks 116376549 on (a run of evm-pool-index.mjs at
 * f1bb364ad), while rpc.mainnet.chain.robinhood.com and alchemy.com's answered every one. Such a null is no answer
 * while another upstream keeps the record: callList asks the next, at most PAST_NULL_TRIES more upstreams, and passes
 * the answer with the fewest nulls when none keeps it (a transaction still pending, a block not made yet). A transaction
 * the same client sent through the route within SENT_KEEP_MS is pending, not past: its null is passed on at once, so a
 * page's poll of its own buy (signpage pool-withdraw-evm.ts onwardReceipt, which waits for every reader) costs one send,
 * as before (measured on Base's public upstreams, 19 Nov 02:52Z: a pending poll p50 278 ms with one send, 1029 ms with three).
 * [design: 2, so a receipt polled while pending costs at most 3 sends; the route's next two upstreams, the read of 02:20Z
 * had alchemy.com's and four more keyed behind the one that forgot.]
 */
export const PAST_NULL_TRIES = 2;
/** How long a transaction sent through the route stays pending for its sender's reads, and how many are kept (the
 *  oldest dropped first). [design: 10 min, past a Base or Robinhood buy's whole wait; 10,000 sends of 32 bytes.] */
export const SENT_KEEP_MS = 10 * 60 * 1000;
export const SENT_KEEP_MAX = 10_000;
/** A signed transaction's hash: keccak-256 of its raw bytes (a typed one's whole envelope), or null for no raw hex. */
export function sentHash(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(raw)) return null;
  return `0x${Buffer.from(keccak_256(Buffer.from(raw.slice(2), "hex"))).toString("hex")}`;
}
const PAST_METHODS: ReadonlySet<string> = new Set(["eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber"]);
/** The ids of a read's calls that ask a past record (a block asked by a number, never by a tag; a transaction `pending`
 *  does not name), or null when none does. */
export function pastAsks(req: unknown, pending: (hash: string) => boolean = () => false): ReadonlySet<unknown> | null {
  const ids = new Set<unknown>();
  for (const r of Array.isArray(req) ? req : [req]) {
    if (!isPlain(r) || typeof r.method !== "string" || !PAST_METHODS.has(r.method)) continue;
    const p0 = Array.isArray(r.params) ? r.params[0] : undefined;
    if (r.method === "eth_getBlockByNumber" && !(typeof p0 === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(p0))) continue;
    if (r.method !== "eth_getBlockByNumber" && typeof p0 === "string" && pending(p0.toLowerCase())) continue;
    ids.add(r.id);
  }
  return ids.size === 0 ? null : ids;
}
/** How many of the calls `asked` names an answer (one, or a batch) answers null. */
export function pastNullsIn(asked: ReadonlySet<unknown>, answer: unknown): number {
  let n = 0;
  for (const a of Array.isArray(answer) ? answer : [answer]) if (isPlain(a) && asked.has(a.id) && Object.hasOwn(a, "result") && a.result === null) n++;
  return n;
}

/** The pool programs each Solana route may scan with getProgramAccounts: the helper's own pinned pool programs for that
 *  cluster (mainnet's: apps/helper/src/pool/solana.ts POOL_SOLANA_ENV, which refuses a bad one at start; devnet's a list,
 *  comma apart, read here alone, since the helper serves no devnet pool, card helper-mainnet-pools-only), none when
 *  unset. */
export const RPC_SCAN_PROGRAM_ENV: Readonly<Partial<Record<RpcChain, string>>> = { solana: "POOL_SOLANA_PROGRAM_MAINNET", "solana-devnet": "POOL_SOLANA_PROGRAM_DEVNET", "solana-marks": "POOL_SOLANA_PROGRAM_MAINNET" };
/** The note restore's mark list (packages/wallet/src/pool/solana-restore.ts solanaMarksListed, the lister's bucket
 *  read; the settle's solanaSettleSpent lists through the same call): each mark size (13 a spent mark, 17 a pre-mark) and the memcmp at 9,
 *  past the counter's low byte, of size - 9 bytes whose last is the program's mark tag (SOL_MARK_TAG 1). */
const SCAN_SIZES: ReadonlySet<unknown> = new Set([13, 17]);
const SCAN_AT = 9;
const SCAN_TAG = 1;
const SCAN_CONFIG: ReadonlySet<string> = new Set(["commitment", "encoding", "withContext", "minContextSlot", "dataSlice", "filters"]);
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
 * whole number), dataSlice? (exactly { offset: 0, length: 0 }: the wallet's lister asks for the addresses alone, card
 * sol-pools-mainnet-pin), filters } and no other key; filters exactly [{ dataSize: 13 | 17 }, { memcmp: { offset: 9, bytes } }],
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
  if (Object.hasOwn(c, "dataSlice") && !(isPlain(c.dataSlice) && exactKeys(c.dataSlice, ["offset", "length"]) && c.dataSlice.offset === 0 && c.dataSlice.length === 0)) return false;
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

/**
 * getProgramAccounts of a coin's SOL pools only as the kit's pool scans (card solana-buy-reaches-raydium-and-meteora):
 * Meteora DLMM (solanaDlmmPairScan, readSolanaDlmmPairs), Raydium CPMM (solanaCpmmPoolScan, readSolanaCpmmPools) and
 * Raydium AMM v4 (solanaAmmV4PoolScan, readSolanaAmmV4Pools), which the signing page sends: the pools of one coin and
 * wSOL, by the pool's size and both mints, addresses only, the coin on either side. The request must equal that
 * program's scan for its two mints, key for key, one of them wSOL and the other another 32-byte address; one mint alone,
 * no size, any bytes of the pools or any other filter would sweep the program on the keyed provider's quota. Anything
 * else is refused before any call. Route A only (the solana route), as every scan there.
 * Raydium CLMM (solanaClmmPoolScan, readSolanaClmmPools; card solana-buy-never-below-a-hidden-market) the same way, a
 * coin's markets the page reads but never trades, whose other mint is wSOL or USDC (QUOTES): a coin's USDC markets are
 * read as its wSOL ones, priced through SOL/USD on the device.
 */
const QUOTES: Readonly<Record<string, readonly string[]>> = Object.freeze({ [SOLANA_CLMM_PROGRAM]: [SOLANA_SOL_MINT, SOLANA_USDC_MINT] });
const POOL_SCANS: Readonly<Record<string, (x: string, y: string) => readonly unknown[]>> = Object.freeze({
  [SOLANA_DLMM_PROGRAM]: solanaDlmmPairScan,
  [SOLANA_CPMM_PROGRAM]: solanaCpmmPoolScan,
  [SOLANA_AMM_V4_PROGRAM]: solanaAmmV4PoolScan,
  [SOLANA_CLMM_PROGRAM]: solanaClmmPoolScan,
});
function poolScanAllowed(r: Record<string, unknown>): boolean {
  const p = r.params;
  if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string" || !Object.hasOwn(POOL_SCANS, p[0]) || !isPlain(p[1])) return false;
  const f = p[1].filters;
  if (!Array.isArray(f) || f.length !== 3) return false;
  const mint = (x: unknown): string | null => (isPlain(x) && isPlain(x.memcmp) && typeof x.memcmp.bytes === "string" && x.memcmp.bytes.length <= 44 && base58Bytes(x.memcmp.bytes)?.length === 32 ? x.memcmp.bytes : null);
  const x = mint(f[1]);
  const y = mint(f[2]);
  const quotes = QUOTES[p[0]] ?? [SOLANA_SOL_MINT];
  if (x === null || y === null || x === y || (!quotes.includes(x) && !quotes.includes(y))) return false;
  return JSON.stringify(p) === JSON.stringify(POOL_SCANS[p[0]]!(x, y));
}

/**
 * getBlock only as a header read (card buy-spends-several-pieces): the signing page reads the finalized height of one
 * block, the one a found W's latest transaction is in (packages/signpage/src/pool-sell.ts foundQuiet), as params exactly
 * [slot, the kit's HELPER_SOLANA_BLOCK_HEADER] (finalized, json, transactionDetails none, rewards false,
 * maxSupportedTransactionVersion 0: the page reads with the same object), the slot a whole number. A block's transactions, signatures or rewards (megabytes
 * an answer) would spend the keyed provider's quota for every caller. Anything else is refused before any call.
 */
export const BLOCK_HEADER: Readonly<Record<string, unknown>> = HELPER_SOLANA_BLOCK_HEADER;
function blockHeaderAllowed(r: Record<string, unknown>): boolean {
  const p = r.params;
  if (!Array.isArray(p) || p.length !== 2 || !Number.isSafeInteger(p[0]) || (p[0] as number) < 0 || !isPlain(p[1])) return false;
  const c = p[1];
  return exactKeys(c, Object.keys(BLOCK_HEADER)) && Object.entries(BLOCK_HEADER).every(([k, v]) => c[k] === v);
}

/**
 * The mark scan's two providers (card sol-pools-mainnet-pin): `a`, route A's provider in use (below), and `b`, the
 * solana-marks route's keyed URLs, in order, whose company (operatorOf) is not a's. The signing page lists the mainnet
 * pool's marks on route b alone (packages/signpage/src/pool-testnet.ts pageSolanaLister) and reads each listed address on
 * its pair, provider A directly, never through this helper (packages/wallet/src/pool/solana-restore.ts
 * solanaMarksListed).
 *
 * Why a list from this helper can only stop a restore or a settle, never decide one: a mark is the pool's record that a
 * note was deposited (pre-mark) or spent (spent mark), and the list only names addresses. A listed mark counts only when
 * both of the page's RPCs hold that account with the same bytes, so an address made up is no account on provider A and
 * is refused; and each RPC's own pool count (deposits and releases, numbered with no hole) must equal the listed marks
 * (solanaMarkCounts), so a mark left out is refused. A refused list stops the restore or leaves the settle held: a spent
 * note is never shown unspent nor freed. The recipient, the amount, the fee and the fee payer of every release come from
 * the user's request and the page's pins, and every proof is checked on chain.
 */
/**
 * Card helper-solana-off-a-spent-key: route A is not one pinned key. Live 20 Nov 08:5xZ SOLANA_RPC_URL's plan was spent
 * (HTTP 429 "max usage reached") and every route A read and every deploy's start check failed on it, while
 * SOLANA_HOLDERS_RPC_URL, another key of the same company with its own credits, and QuickNode answered. Route A's
 * providers are now `aCandidates`: the host's Solana slots (SOLANA_RPC_URL, SOLANA_TRADES_RPC_URL,
 * SOLANA_HOLDERS_RPC_URL; rpc/slot.ts), then Solana's keyed spares, each URL once. `a` is the first that is not `spent`
 * (its plan answered spent within SLOT_RETRY_MS) and has a route B provider off its company; `b` is solana-marks' keyed
 * URLs off a's company, then its keyless providers off it (MARKS_KEYLESS; card solana-marks-route-answers), so the two
 * are never one company whichever A is in use, and B has a provider whatever keyed one is spent or past its day. With no such A, `a` is the first slot
 * (its reads fail while it is spent, never moved onto B's company). `scan`, the pool scans' provider (poolScanAllowed),
 * is the first candidate not spent: their pair's other seat is the page's own (SOLANA_TOKEN_SEAT), so they need no B.
 * No slot set: route A is off, as before.
 */
export const MARKS_A_SLOTS: readonly string[] = Object.freeze([MARKS_A_ENV, "SOLANA_TRADES_RPC_URL", "SOLANA_HOLDERS_RPC_URL"]);
export function aCandidates(env: Record<string, string | undefined>): KeyedUrl[] {
  const slots = keyedUrlsOf(env, MARKS_A_SLOTS);
  if (slots.length === 0) return [];
  return keyedUrlsOf(env, [...MARKS_A_SLOTS, ...RPC_UPSTREAMS.solana.keyed]);
}
export function marksRoutes(upstreams: Record<RpcChain, Upstream>, candidates: readonly KeyedUrl[] = upstreams.solana.keyed.filter((k) => k.env === MARKS_A_ENV), spent: (url: string) => boolean = () => false): { a: () => string | undefined; b: () => string[]; scan: () => string | undefined; bOf: (a: string) => string[] } {
  const cands = candidates.map((k) => k.url);
  const marks = [...upstreams["solana-marks"].keyed.map((k) => k.url), ...MARKS_KEYLESS.map((k) => k.url)];
  const bOf = (a: string): string[] => marks.filter((u) => operatorOf(u) !== operatorOf(a));
  const a = (): string | undefined => cands.find((u) => !spent(u) && bOf(u).length > 0) ?? cands[0];
  const b = (): string[] => {
    const x = a();
    const all = x === undefined ? marks : bOf(x);
    const live = all.filter((u) => !spent(u));
    return live.length > 0 ? live : all;
  };
  const scan = (): string | undefined => cands.find((u) => !spent(u)) ?? cands[0];
  return { a, b, scan, bOf };
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
  if (r.method === "getProgramAccounts" && !scanAllowed(r, scan) && !(chain === "solana" && poolScanAllowed(r))) return undefined;
  if (r.method === "getBlock" && !blockHeaderAllowed(r)) return undefined;
  const out: Record<string, unknown> = { jsonrpc: "2.0", id, method: r.method };
  if (Object.hasOwn(r, "params")) out.params = r.params;
  return out;
}

/**
 * The public accounts whose reads the keyed Solana route holds and shares between callers (card
 * helper-rpc-one-read-many-pages): a named list, never a rule. Every shown page reads the SOL price in the same seconds
 * (the signing page's pool-price.ts, every 3 s near the feed's write), and the price fix's review counted 2.5 429s a
 * minute for 3 pages behind one address. A named list, not a rule such as "not a wallet": a user's one-time account
 * and a public account look alike in a request (32 bytes either way), and telling them apart by owner is a read of its
 * own; a list names what is shared and refuses the rest, so a request naming any other account (a wallet's) is never
 * held or joined. The two: the kit's Pyth SOL/USD account (POOL_USD_FEEDS.solana), and the mainnet pool its deploy
 * record names (contracts/pool-solana/deployments/mainnet.json `pool`, one-read.test.ts holds the two to them).
 */
export const SHARED_ACCOUNTS: ReadonlySet<string> = new Set([POOL_USD_FEEDS.solana.account, "7ijWvp3xEk5yUfGYQJfgoabReCTpSyZhiWjmCt3TQDz8"]);
/** How long a shared read's answer serves the next callers: one Solana slot, 400 ms by its design, so an answer is
 *  never older than the slot after the one it was read at. */
export const SHARED_HOLD_MS = 400;
/** What a caller served a shared answer draws of its own share (none of the provider's total): a quarter of a read
 *  [design: small, so 3 pages behind one address reading the price every 3 s draw under one read's share between them,
 *  and never nothing, so one address asking in a loop is still held to its share]. */
export const SHARED_HIT_DRAW = 0.25;
/** Shared reads held at once [design: the two accounts' reads in the few configs the pages send, with room]. */
const SHARED_MAX = 64;
/**
 * A coin's Raydium CLMM market scan (poolScanAllowed on the CLMM program; card solana-buy-never-below-a-hidden-market),
 * shared between every caller per scan for MARKET_SCAN_HOLD_MS: the signing page asks it for each buy of a coin it has
 * not read within its own keep, and a CLMM pool for a mint is made rarely, so one read serves every device opening that
 * coin. The list only names pools: each device reads each pool's state fresh on two providers, and its other provider
 * (the page's seat) scans fresh, so a pool made since is still found by the union. [design: 10 min floor]
 */
export const MARKET_SCAN_HOLD_MS = 10 * 60_000;
/** Market scans held at once [design: two a coin, for 4,096 coins; each a few addresses, under 2 MB in all]. */
const MARKET_SCAN_MAX = 8_192;
/** A checked request's key as a market scan to share, or null: one getProgramAccounts on mainnet Solana in the CLMM
 *  scan's exact shape. */
export function marketScanKeyOf(chain: RpcChain, req: unknown, keyedOnly: boolean): string | null {
  if (chain !== "solana" || !isPlain(req) || req.method !== "getProgramAccounts" || !Array.isArray(req.params) || req.params[0] !== SOLANA_CLMM_PROGRAM || !poolScanAllowed(req)) return null;
  return `${chain}${keyedOnly ? " keyed" : ""} ${JSON.stringify(req.params)}`;
}
const SHARED_METHODS: ReadonlySet<string> = new Set(["getMultipleAccounts", "getAccountInfo"]);
const SHARED_COMMITMENTS: ReadonlySet<unknown> = new Set(["confirmed", "finalized"]);
/** A checked request's key for sharing (SHARED_ACCOUNTS), or null when it is not one to share: one request (not a
 *  batch) on mainnet Solana, getMultipleAccounts or getAccountInfo of the named accounts alone, its options base64 at
 *  confirmed or finalized and a minContextSlot at most. */
export function sharedKeyOf(chain: RpcChain, req: unknown, keyedOnly: boolean): string | null {
  if (chain !== "solana" || !isPlain(req) || typeof req.method !== "string" || !SHARED_METHODS.has(req.method)) return null;
  const p = req.params;
  if (!Array.isArray(p) || p.length < 1 || p.length > 2) return null;
  const accounts = req.method === "getMultipleAccounts" ? p[0] : [p[0]];
  if (!Array.isArray(accounts) || accounts.length === 0 || accounts.length > SHARED_ACCOUNTS.size || !accounts.every((a) => typeof a === "string" && SHARED_ACCOUNTS.has(a))) return null;
  const o = p[1];
  if (o !== undefined) {
    if (!isPlain(o) || !Object.keys(o).every((k) => k === "encoding" || k === "commitment" || k === "minContextSlot")) return null;
    if (o.encoding !== "base64" || !SHARED_COMMITMENTS.has(o.commitment)) return null;
    if (Object.hasOwn(o, "minContextSlot") && !(typeof o.minContextSlot === "number" && Number.isSafeInteger(o.minContextSlot) && o.minContextSlot >= 0)) return null;
  }
  return `${chain}${keyedOnly ? " keyed" : ""} ${JSON.stringify([req.method, p])}`;
}

export function createRpc(env: Record<string, string | undefined>, deps: Deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  // the budgets', holds' and paces' clock: monotonic, in epoch ms (a wall clock that steps back would hold callers
  // for the step's length; card helper-crowd-429)
  const now = deps.now ?? (() => performance.timeOrigin + performance.now());
  const log = deps.log ?? ((line: string) => console.log(`helper: ${line}`));
  const upstreams = readUpstreams(env);
  // each caller's ?keyed=only NEAR reads this UTC day (NEAR_SEAT_DAY), in memory as the shares are; a new day clears it.
  // At most seatClients callers a day (LIMIT_CLIENTS, as the shares): a new one past that is refused, so its page reads
  // its spare (review P3-2 of 997ce7a7f). `take`: false only looks
  const seatClients = deps.seatClients ?? LIMIT_CLIENTS;
  const seatDay = { day: -1, used: new Map<string, number>() };
  const seatDayTake = (client: string, n: number, take: boolean): boolean => {
    const d = Math.floor(now() / SEAT_DAY_MS);
    if (d !== seatDay.day) (seatDay.day = d), seatDay.used.clear();
    const u = seatDay.used.get(client);
    if (u === undefined && seatDay.used.size >= seatClients) return false;
    if ((u ?? 0) + n > NEAR_SEAT_DAY) return false;
    if (take) seatDay.used.set(client, (u ?? 0) + n);
    return true;
  };
  // a read no provider answered (callList's own 429 or 503) gives its day back; a new day since has nothing to give back
  const seatDayRefund = (client: string, n: number, day: number): void => {
    const u = seatDay.used.get(client);
    if (day !== seatDay.day || u === undefined) return;
    if (u <= n) seatDay.used.delete(client);
    else seatDay.used.set(client, u - n);
  };
  const scanPrograms: Partial<Record<RpcChain, readonly string[]>> = Object.fromEntries(Object.entries(RPC_SCAN_PROGRAM_ENV).map(([c, name]) => [c, !env[name] ? [] : c === "solana-devnet" ? env[name]!.split(",") : [env[name]!]]));
  // a keyed Solana provider's slot: its fallback is the public endpoint, on a budget of its own
  const keyed = upstreams.solana.url !== SOLANA_PUBLIC;
  const slot: Slot = createSlot(deps.slot ?? "rpc", keyed, { now, log });
  const publicFallback = deps.publicFallback ?? true;
  const publicLimits = { ...RPC_BUDGETS.solana, reserve: RPC_RESERVE.solana, userRoom: userRoomOf(RPC_BUDGETS.solana.total) };
  // each chain's first key's plan: RPC_BUDGET_<CHAIN>'s total, else the default; its pace (pacedOf, ownPace) is this
  // plan's second, never the chain's summed total (card helper-serves-many-users-at-once)
  const plans = {} as Record<RpcChain, number>;
  // card near-seat-pace-fits-one-quote: an existing name's keyed URL (ownPace) keeps the plan with no company's
  // published rate in it (RPC_KEYED_TOTAL), RPC_BUDGET_<CHAIN>'s total else the default
  const ownPlans = {} as Record<RpcChain, number>;
  // card helper-base-trade-reads-429: each EVM chain's keyed URLs' part of its total (summedTotal without the spares),
  // which every send of a walk to one of them draws too (keysKey), when the total counts spares past it
  const keysTotals = {} as Record<RpcChain, number>;
  // card rpc-keyed-lists: the one hold and pace per provider a list walk draws on (server.ts passes the helper's, with
  // every keyed URL's company pace); a client made without one (a test, the holders client) keeps its own
  const holdsAll: ProviderHolds = deps.holds ?? providerHolds(now, { ...PROVIDER_PACE, ...keyedPaces(env) });
  // card helper-base-trade-reads-429: the providers an EVM chain's walk sends to past its keyed URLs (listOf's pinned list
  // and fallback), with their paces, which its total counts (summedTotal)
  const sparesOf = (ch: RpcChain): [string, Pace | undefined][] => {
    if (!EVM_CHAINS.has(ch)) return [];
    const fb = RPC_UPSTREAMS[ch].fallback;
    const keyedUrls = new Set(upstreams[ch].keyed.map((k) => k.url));
    return [...new Set([...(deps.pinned?.[ch] ?? []), ...(fb === null ? [] : [fb])])].filter((u) => !keyedUrls.has(u)).map((u) => [u, holdsAll.paceOf(u)]);
  };
  const limits = Object.fromEntries(
    RPC_CHAINS.map((ch) => {
      // a share under what one page draws is refused (RPC_PAGE_NEED), as deploy/redeploy.sh budget_ok refuses it first
      const ks = upstreams[ch].keyed;
      const opts = { minShare: rpcLeastShare(ch), perMethod: true, reserve: RPC_RESERVE[ch] };
      const b = budgetFromEnv(env, rpcBudgetEnv(ch), ks.length > 0 ? keyedBudget(ch, KEYED_PROVIDER[ks[0]!.env]) : RPC_BUDGETS[ch], opts);
      plans[ch] = b.total;
      ownPlans[ch] = ks.length > 0 ? budgetFromEnv(env, rpcBudgetEnv(ch), keyedBudget(ch), opts).total : b.total;
      // the route's total: the first key's plan and its share of each company key it holds and of each paced provider
      // its walk sends to past them (summedTotal)
      const total = summedTotal(ch, upstreams[ch].keyed, b.total, b.perClient, env, sparesOf(ch));
      keysTotals[ch] = summedTotal(ch, upstreams[ch].keyed, b.total, b.perClient, env);
      return [ch, { ...b, total, reserve: RPC_RESERVE[ch], userRoom: userRoomOf(total) }];
    }),
  ) as Record<RpcChain, BudgetLimits & { perMethod?: number }>;
  // the keyed URLs' budget (keysKey): their part of the total, no share of its own (the chain's bounds a caller)
  const keysLimits: Record<string, BudgetLimits & { perMethod?: number }> = Object.fromEntries(RPC_CHAINS.map((ch) => [keysKey(ch), { total: keysTotals[ch], perClient: Infinity, reserve: RPC_RESERVE[ch], userRoom: userRoomOf(keysTotals[ch]) }]));
  /** Whether a walk's send to `url` on `c` draws the keyed URLs' budget too: an EVM chain's keyed URL, when the chain's
   *  total counts spares past its keys (summedTotal `spares`). The keys are then sent no more of the callers' reads than
   *  before the spares counted, and the market-data reads keep their other half (KEYED_ROUTE_SHARE); the rest of the
   *  total is the public spares', each held to its own pace. */
  const keysGated = (c: RpcChain, url: string): boolean => EVM_CHAINS.has(c) && limits[c].total > keysTotals[c] && upstreams[c].keyed.some((k) => k.url === url);
  // card helper-base-logs-page: the most pages one paged eth_getLogs may take on `c` (LOGS_PAGES_MAX, never past the
  // chain's 10 s total, so a read at the cap always fits a window), and the allowance callers' paged reads draw on
  // (logsKey): the chain's total, each caller this many pages a window, never the caller's own share. Card
  // helper-base-trade-reads-429: the keyed URLs' part of it (keysTotals), the only URLs a page goes to (logsSpanByUrl)
  const pagesMaxOf = (c: RpcChain): number => Math.min(LOGS_PAGES_MAX, keysTotals[c]);
  const logsLimits: Record<string, BudgetLimits & { perMethod?: number }> = Object.fromEntries(RPC_CHAINS.map((ch) => [logsKey(ch), { total: keysTotals[ch], perClient: pagesMaxOf(ch), reserve: 0, userRoom: userRoomOf(keysTotals[ch]) }]));
  // each keyed URL's eth_getLogs span (KEYED_LOGS_SPAN); none: no known span, asked any range
  const logsSpanByUrl = new Map<string, bigint>();
  for (const ch of RPC_CHAINS) for (const k of upstreams[ch].keyed) {
    const co = KEYED_PROVIDER[k.env];
    const s = co === undefined ? undefined : KEYED_LOGS_SPAN[co];
    if (s !== undefined) logsSpanByUrl.set(k.url, BigInt(s));
  }
  /** Whether `url` serves an eth_getLogs of `span` blocks: no known span, or one at least that. */
  const covers = (url: string, span: bigint): boolean => (logsSpanByUrl.get(url) ?? span) >= span;
  // a key is a chain, or "<chain> <method>" for one method's budget on it (no share: the chain's share bounds a caller)
  const limitsOf = (k: string) => (k === PUBLIC_KEY ? publicLimits : k === SPARES_KEY ? limits.solana : (logsLimits[k] ?? keysLimits[k] ?? limits[k as RpcChain]));
  const budget = upstreamBudget((key) => {
    const [k, method] = key.split(" ") as [string, string | undefined];
    const l = limitsOf(k);
    return method === undefined ? l : { total: l.perMethod!, perClient: Infinity, reserve: k === PUBLIC_KEY || k === SPARES_KEY ? RPC_RESERVE.solana : RPC_RESERVE[k as RpcChain], userRoom: userRoomOf(l.perMethod!) };
  }, now);
  /** The provider throttled `whose` read on `c` for `seconds`: the chain is held (every draw for a caller's, the
   *  background draws for a background read's), logged as one line with no caller in it. */
  const hold = (c: string, seconds: number, whose: "caller" | "background"): void => {
    budget.hold(c, now() + seconds * 1000, whose === "background");
    log(`rpc hold ${c} ${whose} ${budget.heldFor(c, whose === "background")} s${shapeTail()}`);
  };
  // the pacer on the client's own clock, as its holds and budgets (card helper-pacer-on-the-clients-clock): on the machine's
  // monotonic clock beside a test's `now`, a paced burst slept on the test's clock and asked its wait again until the
  // machine's second passed (test pacer-clock.test.ts: the sixth send 5.4 s of the test's clock on, where 1 s)
  const pacer = deps.pacer ?? createPacer(now);
  /** Each keyed URL's secret forms, whatever chain it serves: an answer holding any of them is never kept. */
  // card helper-solana-off-a-spent-key: route A's candidates (aCandidates: the Solana slots, then the keyed spares)
  const aKeyed = aCandidates(env);
  const formsByUrl = new Map<string, Buffer[]>([...aKeyed.map((k) => [k.url, k.forms] as const), ...RPC_CHAINS.flatMap((ch) => upstreams[ch].keyed.map((k) => [k.url, k.forms] as const))]);
  /** The new keyed names' URLs (KEYED_PROVIDER), each under its company's pace and daily budget (holdsAll), never a
   *  chain's pacer or budget key, whatever place it has in its list (review L2). */
  /** A provider's environment name, the one its URL is set under; "public" for an endpoint set under none (a chain's
   *  public fallback, an EVM chain's pinned public spares), whose URL holds no key. Never the URL or any part of it. */
  const nameByUrl = new Map<string, string>([...aKeyed.map((k) => [k.url, k.env] as const), ...RPC_CHAINS.flatMap((ch) => upstreams[ch].keyed.map((k) => [k.url, k.env] as const))]);
  /** Route B's keyless providers by name (MARKS_KEYLESS): one of them is also Solana's public fallback, "public" there. */
  const marksKeyless = new Map(MARKS_KEYLESS.map((k) => [k.url, k.name] as const));
  const sentTo = (url: string, from: number, c?: RpcChain): void => {
    const t = traces.getStore();
    if (t !== undefined) t.last = { name: (c === "solana-marks" ? marksKeyless.get(url) : undefined) ?? nameByUrl.get(url) ?? "public", ms: now() - from };
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
    c === "solana" && borrowed(url) ? slotShareOf(ownPlans.solana) : !EVM_CHAINS.has(c) && upstreams[c].keyed.some((k) => k.url === url && KEYED_PROVIDER[k.env] === undefined) ? Math.max(1, Math.ceil(ownPlans[c] / (LIMIT_WINDOW_MS / 1000))) : 0;
  /** Whether `c` has a new keyed name set (KEYED_PROVIDER): then every read walks its list (listOf). */
  const walks = (c: RpcChain): boolean => upstreams[c].keyed.some((k) => KEYED_PROVIDER[k.env] !== undefined);
  /** The providers a read on `c` asks, in order: its keyed URLs (else its public fallback first, as before), an EVM chain's
   *  pinned ones, then its public fallback; each once. Solana's walk is call() on the first and solanaRest after it. */
  const listOf = (c: RpcChain): string[] => {
    const fb = RPC_UPSTREAMS[c].fallback;
    const keyedUrls = upstreams[c].keyed.map((k) => k.url);
    return [...new Set([...(keyedUrls.length > 0 ? keyedUrls : fb === null ? [] : [fb]), ...(deps.pinned?.[c] ?? []), ...(fb === null ? [] : [fb])])];
  };
  // card helper-solana-off-a-spent-key: each keyed URL whose plan answered spent (CREDITS on a refusal, planSpent in an
  // answer) and until when: out of route A and route B (marksRoutes) for SLOT_RETRY_MS, as the slot retries its key; a
  // short throttle (any other 429) is never this, and is waited out where it was
  const spentUntil = new Map<string, number>();
  const spent = (url: string): boolean => (spentUntil.get(url) ?? 0) > now();
  const markSpent = (url: string): void => {
    // its variable alone, never its URL, host or key
    if (!spent(url)) log(`rpc spent ${nameByUrl.get(url) ?? "public"}, out of the mark routes for ${SLOT_RETRY_MS / 1000} s`);
    spentUntil.set(url, now() + SLOT_RETRY_MS);
    // card helper-solana-slots-off-a-spent-key: the rpc slot falls back once every one of its keys is spent
    if (slotKeys.includes(url) && slotKeys.every(spent)) slot.fail("credits");
  };
  const { a: marksA, b: marksB, scan: scanA } = marksRoutes(upstreams, aKeyed, spent);
  // card helper-solana-slots-off-a-spent-key: the rpc slot's key is the first of the host's Solana slot keys
  // (MARKS_A_SLOTS: SOLANA_RPC_URL, SOLANA_TRADES_RPC_URL, SOLANA_HOLDERS_RPC_URL, each URL once) not spent, on the
  // chain's plan, before QuickNode, dRPC and the public endpoint. Live 20 Nov 11:2xZ SOLANA_RPC_URL's plan was spent and
  // the slot fell back: every plain read went to QuickNode, whose day ran out, then the public endpoint at its 16 a
  // caller (RPC_CLIENT_MAX), and a trade's 42 reads were served 16. None when SOLANA_RPC_URL is not the first keyed name
  // (a company's URL first: its walk as before).
  const slotKeys: readonly string[] = upstreams.solana.keyed[0]?.env === MARKS_A_ENV ? aKeyed.filter((k) => MARKS_A_SLOTS.includes(k.env)).map((k) => k.url) : [];
  const slotKey = (): string => slotKeys.find((u) => !spent(u)) ?? upstreams.solana.url;
  /** Another slot's key, read here past this client's own (SOLANA_RPC_URL's): the holders key, say. */
  const borrowed = (url: string): boolean => url !== upstreams.solana.url && slotKeys.includes(url);
  /** Whether a checked read (one or a batch) holds a mark scan (scanAllowed), which route A sends only where route B is
   *  off its company; else its getProgramAccounts are pool scans (poolScanAllowed). */
  const holdsMarkScan = (out: unknown): boolean => (Array.isArray(out) ? out : [out]).some((r) => isPlain(r) && r.method === "getProgramAccounts" && scanAllowed(r, scanPrograms.solana ?? []));
  /** A keyed provider's URL and its sends a second, or null for the public endpoint and a chain on its default
   *  provider, which are not paced (their published limits are per 10 s). */
  const pacedOf = (key: string): { url: string; perSecond: number } | null => {
    if (key === PUBLIC_KEY || upstreams[key as RpcChain].forms.length === 0) return null;
    // the Solana slot's key in use (slotKey); a borrowed one at its share of the second (slotShareOf)
    const url = key === "solana" ? slotKey() : upstreams[key as RpcChain].url;
    return { url, perSecond: key === "solana" && borrowed(url) ? slotShareOf(plans.solana) : Math.max(1, Math.ceil(plans[key as RpcChain] / (LIMIT_WINDOW_MS / 1000))) };
  };
  /** How long `n` sends to `key` wait for their second's room, from a hold's end on, booked when within `maxWaitMs`
   *  (and `book`); 0 when not paced. A batch larger than a second's room goes alone in its own second. */
  const pace = (key: string, n: number, maxWaitMs: number, url?: string, book = true): number => {
    const p = pacedOf(key);
    return p === null ? 0 : pacer.at(p.url, n, p.perSecond, { fromMs: Math.max(0, heldUntilOf(key, url) - now()), maxWaitMs, book });
  };
  /** Whether a Solana keyed spare can take `n` sends now: not held, inside its day, its bucket holding them (card
   *  helper-serves-many-users-at-once: a read the first key has no room for goes there at once). */
  const spareHasRoom = (n: number): boolean =>
    upstreams.solana.keyed.slice(1).some((k) => {
      if (holdsAll.heldMs(k.url) > 0 || holdsAll.dayOut(k.url, n)) return false;
      const p = holdsAll.paceOf(k.url);
      return p === undefined || holdsAll.room(k.url) * p.burst >= n;
    });
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
  // card helper-pool-logs-outside-the-caller-budget: the finalized-logs cache (LOG_CACHE_ENTRIES), least recently used
  // first in the Map's order, each entry its result as JSON text, its size and when it was kept
  const logCache = new Map<string, { result: string; bytes: number; at: number }>();
  let logCacheBytes = 0;
  const logCacheDrop = (k: string): void => {
    const e = logCache.get(k);
    if (e === undefined) return;
    logCache.delete(k);
    logCacheBytes -= e.bytes;
  };
  const logCacheGet = (k: string): string | undefined => {
    const e = logCache.get(k);
    if (e === undefined) return undefined;
    if (now() - e.at >= LOG_CACHE_MS) {
      logCacheDrop(k);
      return undefined;
    }
    logCache.delete(k);
    logCache.set(k, e);
    return e.result;
  };
  /** Keeps a provider's answer to `k` when it is a 200 holding a result list (never an error, a cap or a refusal). */
  const logCachePut = (k: string, a: Answer): void => {
    if (a.status !== 200) return;
    let answer: unknown;
    try {
      answer = parse(a.body);
    } catch {
      return;
    }
    if (!isPlain(answer) || Object.hasOwn(answer, "error") || !Array.isArray(answer.result)) return;
    const result = JSON.stringify(answer.result);
    const bytes = Buffer.byteLength(k) + Buffer.byteLength(result);
    if (bytes > LOG_CACHE_BYTES) return;
    logCacheDrop(k);
    while (logCache.size >= LOG_CACHE_ENTRIES || logCacheBytes + bytes > LOG_CACHE_BYTES) logCacheDrop(logCache.keys().next().value as string);
    logCache.set(k, { result, bytes, at: now() });
    logCacheBytes += bytes;
  };
  /** The chain's own pool, as the kit pins it (lowercase), for POOL_LOGS_CLIENT; undefined off the EVM chains. */
  const poolOf = (c: RpcChain): string | undefined => (EVM_CHAINS.has(c) ? (evmPoolVenues() as Readonly<Record<string, { pool?: string } | undefined>>)[c]?.pool?.toLowerCase() : undefined);
  /** The chain's PoolManager, as the kit pins it (lowercase), for INDEX_CLIENT; undefined off the EVM chains. */
  const poolManagerOf = (c: RpcChain): string | undefined => (EVM_CHAINS.has(c) ? (evmPoolVenues() as Readonly<Record<string, { poolManager?: string } | undefined>>)[c]?.poolManager?.toLowerCase() : undefined);
  // each EVM chain's finalized head as the helper last read it (0n: none yet), when, the read in flight, and whether
  // the last read failed (no head named), which the fill waits out instead of ending (card base-reads-never-throttled)
  const finalHeads = new Map<RpcChain, { n: bigint; at: number; reading?: Promise<void>; failed?: boolean }>();
  /** Whether block `to` is finalized on `c`, by the helper's own read of the head on `providers` (the chain's keyed
   *  URLs): read again only when `to` is past the head held and FINAL_HEAD_MS has passed since the last read, one read at
   *  a time, outside the caller's trace and share (the chain's total, as the helper's own reads). A head only rises. */
  const finalized = async (c: RpcChain, to: bigint, providers: readonly string[]): Promise<boolean> => {
    let h = finalHeads.get(c);
    if (h === undefined) finalHeads.set(c, (h = { n: 0n, at: -Infinity }));
    if (to <= h.n) return true;
    if (h.reading === undefined && now() - h.at >= FINAL_HEAD_MS) {
      const head = h;
      head.at = now();
      // the helper's own head read, no caller's: its hold lines name it so (card base-reads-never-starve-max)
      const forward = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["finalized", false] });
      head.failed = true;
      head.reading = traces.run({ waitMs: 0, shape: `helper ${rpcShape(JSON.parse(forward))}` }, async () => {
        const a = await callList(c, providers, forward, ["eth_getBlockByNumber"], undefined, false, now() + WALK_MS);
        if (a.status !== 200) return;
        const n = (JSON.parse(a.body) as { result?: { number?: unknown } | null }).result?.number;
        if (typeof n !== "string" || !BLOCK_NUMBER.test(n)) return;
        head.failed = false;
        if (BigInt(n) > head.n) head.n = BigInt(n);
      })
        .catch(() => undefined)
        .finally(() => (head.reading = undefined));
    }
    await h.reading;
    return to <= h.n;
  };

  // card helper-keyed-logs-serve-a-whole-pool-range: each pinned pool's store (pool-logs.ts), read from HELPER_STORE_DIR
  // at its first use; `started` once a fill ran or a file held it, so only then a read past it starts the fill again
  const storeDir = env.HELPER_STORE_DIR ?? "";
  const stores = new Map<RpcChain, PoolStore & { started: boolean }>();
  const fills = new Map<RpcChain, Promise<void>>();
  // when a pool read last came through the keyed route on each chain: the fill follows the head while they come
  const poolReadAt = new Map<RpcChain, number>();
  /** The chain's pool store: only the kit's pinned pool with a deploy block named (POOL_LOGS_FROM); else undefined. */
  const storeOf = (c: RpcChain): (PoolStore & { started: boolean }) | undefined => {
    const pool = poolOf(c);
    const from = POOL_LOGS_FROM[c];
    if (pool === undefined || from === undefined) return undefined;
    let s = stores.get(c);
    if (s === undefined) {
      const kept = poolFile(storeDir, c)?.read(pool, from) ?? null;
      if (kept === null && storeDir !== "") log(`rpc pool-logs ${c} no store kept`);
      stores.set(c, (s = { ...(kept ?? emptyStore(pool, from)), started: kept !== null && kept.covered >= from }));
    }
    return s;
  };
  // the fill's waits: the test's clock, else a timer that never keeps the process up
  const fillSleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms).unref()));
  const hexOf = (n: bigint): string => `0x${n.toString(16)}`;
  /** One page of the pool's logs, `a` to `b`, from `url` as a background read: its checked logs (poolPage); a wait in
   *  ms (the provider held, out of room, or the chain's total spent); null when it did not serve the page. */
  const fillBacks = new Map<string, { until: number; k: number }>();
  /** A provider's refusal of a fill page (POOL_BACK_MAX): the fill's own wait on it, in ms, and its hold line. */
  const fillBack = (c: RpcChain, url: string, s: number): number => {
    const b = fillBacks.get(url) ?? { until: 0, k: 0 };
    b.k = Math.min(b.k + 1, POOL_BACK_MAX);
    const wait = Math.max(s, 2 ** b.k);
    b.until = now() + wait * 1000;
    fillBacks.set(url, b);
    log(`rpc hold ${c} ${companyOf(new URL(url).host)} background ${wait} s pool-logs`);
    return wait * 1000;
  };
  const fillSend = async (c: RpcChain, url: string, pool: string, a: bigint, b: bigint): Promise<PoolLog[] | number | null> => {
    if (holdsAll.dayOut(url, 1, true)) return null;
    const back = (fillBacks.get(url)?.until ?? 0) - now();
    if (back > 0) return back;
    const held = holdsAll.heldMs(url);
    if (held > 0) return held;
    // the provider's pace only, as a background read: never the route's total (/v1/rpc's callers'), see POOL_FILL_PER_S
    // a background page: behind any caller's read waiting for the bucket, else on what callers leave (limits.ts take)
    const room = holdsAll.take(url, 1, true, false, false, true);
    if (room > 0) return room;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: pool, fromBlock: hexOf(a), toBlock: hexOf(b) }] });
    let r: Response;
    let text: string | undefined;
    try {
      r = await doFetch(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
      if (r.status === 429) {
        await r.body?.cancel();
        return fillBack(c, url, upstreamRetryAfterS(r.headers, now()));
      }
      text = await readAnswer(r);
    } catch {
      return null;
    }
    if (r.status !== 200 || text === undefined || !/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(r.headers.get("content-type") ?? "")) return null;
    if ((formsByUrl.get(url) ?? []).some((f) => Buffer.from(text, "utf8").includes(f))) return null;
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      return null;
    }
    if (planSpent(answer)) return null;
    const limited = evmLimited(c, answer);
    if (limited > 0) return fillBack(c, url, limited);
    const page = isPlain(answer) && !Object.hasOwn(answer, "error") ? poolPage(answer.result, pool, a, b) : null;
    const fb = fillBacks.get(url);
    if (page !== null && fb !== undefined && fb.k > 0) fb.k--;
    return page;
  };
  /**
   * The pool's fill (POOL_FILL_PER_S): from what the store covers to the chain's finalized head as the helper reads it,
   * page by page in block order, each page kept only when it follows what is covered. A provider of no known span
   * (KEYED_LOGS_SPAN: Robinhood's Alchemy) is asked the whole rest in one page first; else, or once it fails, pages of
   * the widest known span to the providers of that span in turn. One fill a chain at a time; it ends at the head, past
   * POOL_FILL_FAILS pages in a row unserved, or at the store's bound (POOL_LOGS_BYTES), and a pool read past what is
   * kept starts it again.
   */
  // when the last fill page of any chain went (POOL_FILL_PER_S is the fills' together)
  const fillLast = { at: -Infinity };
  const fillPool = (c: RpcChain, own: readonly string[]): void => {
    const s = storeOf(c);
    if (s === undefined) return;
    poolReadAt.set(c, now());
    if (fills.has(c)) return;
    s.started = true;
    const file = poolFile(storeDir, c);
    const save = (): void => {
      try {
        file?.write(s);
      } catch {
        log(`rpc pool-logs ${c} store not written`);
      }
    };
    const whole = own.filter((u) => !logsSpanByUrl.has(u));
    const w = own.reduce((m, u) => ((logsSpanByUrl.get(u) ?? 0n) > m ? logsSpanByUrl.get(u)! : m), 0n);
    const paged = w > 0n ? own.filter((u) => logsSpanByUrl.get(u) === w) : [];
    const run = (async () => {
      let wide = whole.length > 0;
      let fails = 0;
      let turn = 0;
      let waits = 0;
      let soonest = Infinity;
      let wrote = now();
      let saved = s.covered;
      let named = -1n;
      for (;;) {
        await finalized(c, s.covered + 1n, own);
        const h = finalHeads.get(c);
        const head = h?.n ?? 0n;
        if (s.covered >= head) {
          // card base-reads-never-throttled: at the head the store stays there. The fill names it once, writes it, and
          // follows the head (POOL_FOLLOW_EVERY_MS) while pool reads come (POOL_FOLLOW_IDLE_MS). A head read that
          // failed (every provider held or refusing, as dRPC's code 15 on 16 Nov) is read again at its next turn
          // (FINAL_HEAD_MS), so the store never stands still waiting for a device's read past it
          if (now() - (poolReadAt.get(c) ?? -Infinity) >= POOL_FOLLOW_IDLE_MS) break;
          if (h?.failed !== true && named !== s.covered) {
            if (s.covered > saved) (save(), (saved = s.covered), (wrote = now()));
            log(`rpc pool-logs ${c} covered to ${(named = s.covered)}`);
          }
          await fillSleep(h?.failed === true ? FINAL_HEAD_MS : POOL_FOLLOW_EVERY_MS);
          continue;
        }
        const list = wide ? whole : paged;
        if (list.length === 0) break;
        const a = s.covered + 1n;
        const b = wide || a + w - 1n > head ? head : a + w - 1n;
        // POOL_FILL_PER_S for every chain's fill together: Base's and Robinhood's run on the same dRPC bucket
        // (each page's turn booked before its wait, so two fills never wake into one turn)
        fillLast.at = Math.max(now(), fillLast.at + 1000 / POOL_FILL_PER_S);
        const gap = fillLast.at - now();
        if (gap > 0) await fillSleep(gap);
        const got = await fillSend(c, list[turn++ % list.length]!, s.pool, a, b);
        // a provider held or out of room: the next one is asked; every one of them waiting, the soonest wait is slept
        if (typeof got === "number") {
          soonest = Math.min(soonest, got);
          if (++waits >= list.length) {
            await fillSleep(Math.max(soonest, 1000 / POOL_FILL_PER_S));
            (waits = 0), (soonest = Infinity);
          }
          continue;
        }
        (waits = 0), (soonest = Infinity);
        if (got === null) {
          if (wide) wide = false;
          else if (++fails >= POOL_FILL_FAILS) break;
          continue;
        }
        fails = 0;
        if (!storeAppend(s, a, b, got)) {
          log(`rpc pool-logs ${c} store full at block ${a}`);
          break;
        }
        if (now() - wrote >= POOL_WRITE_MS) (save(), (saved = s.covered), (wrote = now()));
      }
      if (s.covered > saved) save();
      if (named !== s.covered) log(`rpc pool-logs ${c} covered to ${s.covered}`);
    })()
      .catch(() => undefined)
      .finally(() => fills.delete(c));
    fills.set(c, run);
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

  /** Each upstream URL's most calls a batch, set once it refused one for its size and kept for the process's life
   *  (card helper-rpc-batch-learns-reader-size): the helper's one map (batch-sizes.ts BATCH_SIZES), which the maker
   *  reads and the tapes keep too; Infinity until then. */
  const sizes = deps.batch ?? BATCH_SIZES;
  const mostOf = (url: string): number => sizes.most(url);
  /** The most calls the walk puts in one post to `url` (card helper-receipts-past-retention): its kept size (mostOf),
   *  its plan's batch (Pace batch: dRPC free's 3) and, for a pace counted in calls, its bucket (Pace burst: QuickNode's
   *  7), the swap reads' rule (data/evm/swaps.ts). Live 19 Nov 06:5xZ the walk put a URL out for a batch past either
   *  instead, and Base's keyed route answered a batch of 8 receipts 503 with nothing sent (rpc;desc="none"). */
  const partOf = (url: string): number => {
    const p = holdsAll.paceOf(url);
    return Math.max(1, Math.min(mostOf(url), p?.batch ?? Infinity, p?.unit === "call" ? Math.floor(p.burst) : Infinity));
  };
  /** A caller's read of `n` calls: its first post (partOf) taken from `url`'s pace (limits.ts take), 0 when it has room,
   *  else its wait, nothing drawn. fitPost draws each later post as it leaves (drawOf). A post refused for its size and
   *  sent again as parts draws nothing more: once per URL and size, for the process's life. */
  const takeParts = (url: string, n: number, page: boolean): number => holdsAll.take(url, Math.min(partOf(url), n), false, false, false, page);
  const drawOf = (url: string, page: boolean) => (calls: number): number => holdsAll.take(url, calls, false, false, false, page);
  /** Whether a later part's post of `calls` gets its pace's room (`draw`, 0 when drawn) by the walk's end `by`, its
   *  waits the read's rpc-wait; false once the next wait would pass it (a crowd took every refill first). */
  const roomBy = async (draw: (calls: number) => number, calls: number, by: number): Promise<boolean> => {
    for (;;) {
      const w = draw(calls);
      if (w === 0) return true;
      if (now() + w > by - WALK_SEND_MIN_MS) return false;
      await waitFor(w);
    }
  };
  /** A later part that found no room by the walk's end: this upstream down for the read (callList's 5xx). */
  const NO_ROOM = (): Sent => ({ status: 503, headers: new Headers(), text: undefined });
  /**
   * One read sent to one upstream, fitted to its batch size (card helper-rpc-batch-learns-reader-size), its body read
   * (readAnswer: undefined past RPC_ANSWER_MAX). A batch past the most the upstream takes (mostOf) leaves as its parts, all
   * at once, and their answers are joined as one batch in the parts' order, each part's calls as the upstream answered
   * them. A batch it refuses for its size (batch-sizes.ts batchRefusal, the kit's rule: an HTTP 413 whatever its body; a
   * 4xx, a 429 or a 200 whose error names a batch maximum, never a rate limit's words) sets its most (the kit's
   * evmBatchFit: half, or the maximum named where smaller) and is sent again as parts. A post of one call is never a size refusal. Any other
   * answer of a part (a throttle's 429, a 5xx, a body that is no batch) is this upstream's answer to the read, as one
   * post's would be. Mainnet's refusals, read 2026-11-18 20:41Z: Pocket's 413 past 5, daybreak's 413 "max 20 calls",
   * robinhood.drpc.org's 400 code 31 past 3, Sentio's 429 code 8 past 5 (batch-fit.test.ts).
   * The walk (callList) passes its part size (partOf) as `most` and its pace's `draw`: the first part was drawn before
   * the call (takeParts), and each later one leaves once its pace has room for it (roomBy), so a batch past a bucket
   * goes as the bucket refills, never past it; a part with no room by `by` ends the read on this upstream (NO_ROOM).
   */
  async function fitPost(c: RpcChain, url: string, forward: string, n: number, by: number, most = mostOf(url), draw?: (calls: number) => number): Promise<Sent> {
    if (n > most) {
      const reqs = JSON.parse(forward) as unknown[];
      const parts: unknown[][] = [];
      for (let i = 0; i < reqs.length; i += most) parts.push(reqs.slice(i, i + most));
      const sent: Promise<Sent>[] = [];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]!;
        if (i > 0 && draw !== undefined && !(await roomBy(draw, p.length, by))) {
          sent.push(Promise.resolve(NO_ROOM()));
          break;
        }
        const s = fitPost(c, url, JSON.stringify(p), p.length, by);
        // a part that fails while a later one waits for room is read by Promise.all below, never left unhandled
        s.catch(() => undefined);
        sent.push(s);
      }
      return joinParts(await Promise.all(sent), parts);
    }
    const r = await doFetch(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: forward, redirect: "error", signal: AbortSignal.timeout(sendMs(by - now())) });
    const text = await readAnswer(r);
    const said = batchRefusal(r.status, text, n);
    if (said !== undefined) {
      const fit = sizes.refused(url, n, said);
      log(`rpc batch ${c} ${companyOf(new URL(url).host)} most ${fit}${shapeTail()}`);
      return fitPost(c, url, forward, n, by);
    }
    return { status: r.status, headers: r.headers, text };
  }
  /** The parts' answers as one batch (fitPost): every part a 200 JSON batch (a part of one call may answer that call
   *  alone, Pocket's way), joined in the parts' order; else the first part that is not, as the read's answer. */
  function joinParts(sent: Sent[], parts: unknown[][]): Sent {
    const inner: string[] = [];
    for (let i = 0; i < sent.length; i++) {
      const s = sent[i]!;
      if (s.status !== 200 || s.text === undefined || !/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(s.headers.get("content-type") ?? "")) return s;
      let a: unknown;
      try {
        a = JSON.parse(s.text);
      } catch {
        return s;
      }
      if (Array.isArray(a)) {
        if (a.length > 0) inner.push(s.text.trim().slice(1, -1));
      } else if (parts[i]!.length === 1 && isPlain(a)) inner.push(s.text.trim());
      else return s;
    }
    const text = `[${inner.join(",")}]`;
    return { status: 200, headers: sent[0]!.headers, text: Buffer.byteLength(text) > RPC_ANSWER_MAX ? undefined : text };
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
    // card base-reads-never-starve-max: an EVM read's refusal names its shape in the refusal log (server.ts reply)
    return { ...a, ...(a.why !== undefined && t.shape !== undefined ? { why: `${a.why} ${t.shape}` } : {}), timing: timingOf(t) };
  }

  async function route(chain: string, contentType: string | undefined, body: string, client: string | undefined, reserved: boolean, keyedOnly: boolean): Promise<Answer> {
    if (!(RPC_CHAINS as readonly string[]).includes(chain)) return error(404, "not_found");
    const c = chain as RpcChain;
    // card solana-marks-route-answers: route B is never off, its keyless providers (MARKS_KEYLESS) serve with no keyed name set
    if (upstreams[c].off && c !== "solana-marks") return UPSTREAM();
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
    // card base-reads-never-throttled: a keyed read of the chain's id alone is answered from its constant (the one the
    // keyed URLs are checked against, KEYED_ID), never sent: dRPC's free plan refused Base's keyed eth_chainId 22 times
    // in 9 min on 16 Nov 15:1xZ, each read a call of the one dRPC bucket the pool reads need
    const chainId = KEYED_ID[c];
    if (keyedOnly && chainId !== undefined && methods.every((m) => m === "eth_chainId")) {
      const one = (r: unknown) => `{"jsonrpc":"2.0","id":${JSON.stringify((r as { id: unknown }).id)},"result":"${chainId}"}`;
      return { status: 200, body: Array.isArray(out) ? `[${out.map(one).join(",")}]` : one(out) };
    }
    // card base-reads-never-starve-max: an EVM read's shape (rpcShape) and its mode, for its hold and refusal log lines
    const trace = traces.getStore();
    if (trace !== undefined && EVM_CHAINS.has(c)) trace.shape = `${keyedOnly ? "keyed " : ""}${rpcShape(out)}`;
    // card helper-receipts-past-retention: a transaction sent here is pending for its sender's reads (sentLately)
    if (EVM_CHAINS.has(c) && methods.includes("eth_sendRawTransaction")) noteSent(c, client, out);
    // card helper-rpc-one-read-many-pages: a read of the named public accounts (SHARED_ACCOUNTS) joins the same read in
    // flight, or is answered from it for SHARED_HOLD_MS after
    const sk = sharedKeyOf(c, out, keyedOnly);
    if (sk !== null) return sharedRead(sharedReads, SHARED_HOLD_MS, SHARED_MAX, sk, (out as { id: unknown }).id, c, client, () => send(c, out, forward, methods, client, reserved, keyedOnly));
    // a coin's CLMM market scan joins the same scan in flight, or is answered from it for MARKET_SCAN_HOLD_MS after
    const mk = marketScanKeyOf(c, out, keyedOnly);
    if (mk !== null) return sharedRead(marketScans, MARKET_SCAN_HOLD_MS, MARKET_SCAN_MAX, mk, (out as { id: unknown }).id, c, client, () => send(c, out, forward, methods, client, reserved, keyedOnly));
    return send(c, out, forward, methods, client, reserved, keyedOnly);
  }

  // the shared reads (sharedKeyOf): each one's result as JSON text, null when it gave none to share, and when its answer
  // stops serving (Infinity while it is in flight)
  type Shared = Map<string, { result: Promise<string | null>; until: number }>;
  const sharedReads: Shared = new Map();
  const marketScans: Shared = new Map();
  /** A shared read: the one in flight or held joined, drawing SHARED_HIT_DRAW of the caller's share and nothing of the
   *  provider's total, answered with the caller's own id; else the caller's own read, held for the next. A held read
   *  that gave no result (a refusal, an error) serves no one: each caller then makes its own. */
  async function sharedRead(reads: Shared, hold: number, max: number, key: string, id: unknown, c: RpcChain, client: string | undefined, go: () => Promise<Answer>): Promise<Answer> {
    const t = now();
    for (const [k, e] of reads) if (e.until <= t) reads.delete(k);
    const e = reads.get(key);
    if (e !== undefined) {
      // drawn once the answer is in, so callers joining a read in flight never spend its caller's share before it is sent
      const result = await e.result;
      if (result === null) return go();
      const wait = budget.takeEach([[c, SHARED_HIT_DRAW]], client, true);
      if (wait > 0) return throttled(wait, undefined, budget.refusedBy());
      const tr = traces.getStore();
      if (tr !== undefined) tr.cached = true;
      return { status: 200, body: `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${result}}` };
    }
    if (reads.size >= max) return go();
    let done!: (r: string | null) => void;
    const entry = { result: new Promise<string | null>((ok) => (done = ok)), until: Infinity };
    reads.set(key, entry);
    let a: Answer | undefined;
    try {
      a = await go();
    } finally {
      const result = a === undefined ? null : resultOf(a);
      done(result);
      if (result === null) {
        if (reads.get(key) === entry) reads.delete(key);
      } else entry.until = now() + hold;
    }
    return a;
  }
  /** An answer's result as JSON text, when it is a 200 JSON-RPC result. */
  const resultOf = (a: Answer): string | null => {
    if (a.status !== 200) return null;
    try {
      const j = JSON.parse(a.body) as unknown;
      return isPlain(j) && !Object.hasOwn(j, "error") && Object.hasOwn(j, "result") ? JSON.stringify(j.result) : null;
    } catch {
      return null;
    }
  };

  // card helper-receipts-past-retention: each client's transactions sent through the route lately, by chain and hash,
  // the time of the send; a past null for one is its pending answer (SENT_KEEP_MS), never asked again
  const sentAt = new Map<string, number>();
  const sentKey = (c: RpcChain, client: string | undefined, hash: string) => `${c} ${client ?? ""} ${hash}`;
  const noteSent = (c: RpcChain, client: string | undefined, out: unknown): void => {
    for (const r of Array.isArray(out) ? out : [out]) {
      if (!isPlain(r) || r.method !== "eth_sendRawTransaction" || !Array.isArray(r.params)) continue;
      const h = sentHash(r.params[0]);
      if (h === null) continue;
      const k = sentKey(c, client, h);
      sentAt.delete(k);
      sentAt.set(k, now());
      while (sentAt.size > SENT_KEEP_MAX) sentAt.delete(sentAt.keys().next().value!);
    }
  };
  const sentLately = (c: RpcChain, client: string | undefined, hash: string): boolean => {
    const at = sentAt.get(sentKey(c, client, hash));
    return at !== undefined && now() - at < SENT_KEEP_MS;
  };

  /** A checked read sent on its route (route). */
  async function send(c: RpcChain, out: unknown, forward: string, methods: string[], client: string | undefined, reserved: boolean, keyedOnly: boolean): Promise<Answer> {
    // a keyed Solana provider fallen back (rpc/slot.ts): the public endpoint, on its own budget; the key while it serves
    // card rpc-keyed-lists: past the first (fallen back, or held by its 429), its keyed spares on their own budget, then
    // the public endpoint
    // review L2: a company's URL first (SOLANA_RPC_URL unset): the whole keyed list is walked under each company's pace
    // review L4: the read's whole walk, every path below, ends by `by`
    const by = now() + WALK_MS;
    // card sol-pools-mainnet-pin: the mark scan's two routes, each one company's. A: one provider (marksRoutes), never
    // the public endpoint. B: its keyed names off A's company, in order. Either only lists: the page reads each listed
    // mark by address on its pair (marksRoutes below)
    // card helper-solana-off-a-spent-key: A is the first candidate not spent with a B off its company (a pool scan: the
    // first not spent); a read whose A answered its plan spent is asked once more of the A now in use, drawing nothing again
    if (c === "solana" && methods.includes("getProgramAccounts")) {
      const pick = holdsMarkScan(out) ? marksA : scanA;
      const a = pick();
      if (a === undefined) return UPSTREAM();
      const r = await callList(c, [a], forward, methods, client, reserved, by);
      const next = pick();
      return r.status !== 200 && spent(a) && next !== undefined && next !== a ? callList(c, [next], forward, methods, client, reserved, by, null) : r;
    }
    if (c === "solana-marks") {
      const b = marksB();
      return b.length === 0 ? UPSTREAM() : callList(c, b, forward, methods, client, reserved, by);
    }
    // card evm-pool-leaves-any-source: the keyed URLs that hold a key, walked in order; past them 503, never a public
    // one. After the mark routes, which ?keyed=only never widens (review P3-1)
    // card near-quote-under-the-pace: NEAR's keyed seat is FastNEAR's alone (NEAR_SEAT). The page trusts a NEAR read
    // only when this seat and its other, dRPC read device-direct, agree byte for byte, so this seat must be another
    // operator: never dRPC's URL or any other company's, and none of FastNEAR's set is 503
    if (keyedOnly) {
      const own = upstreams[c].keyed.filter((k) => !k.keyless && (c !== "near" || operatorOf(k.url) === NEAR_SEAT)).map((k) => k.url);
      if (own.length === 0) return UPSTREAM();
      // card helper-robinhood-route-serves-a-device-sync: a pool index read draws its own allowance (INDEX_CLIENT)
      const mine = client !== undefined && indexReadOf(c, out, poolManagerOf(c)) ? `${INDEX_CLIENT} ${client}` : client;
      // card helper-pool-logs-outside-the-caller-budget: a finalized page of logs kept before is answered here, drawing
      // nothing; a first ask draws as any read, and is kept once its toBlock reads finalized (LOG_CACHE_ENTRIES)
      const logs = Array.isArray(out) ? null : finalLogsOf(c, out as Record<string, unknown>, poolOf(c));
      if (logs !== null) {
        const id = (out as { id: unknown }).id;
        const kept = logCacheGet(logs.key);
        if (kept !== undefined) {
          const t = traces.getStore();
          if (t !== undefined) t.cached = true;
          return { status: 200, body: `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${kept}}` };
        }
        // finalized by the head held, else by a read of it (one at a time, FINAL_HEAD_MS apart): a pool page's first
        // ask then draws on its own allowance (POOL_LOGS_CLIENT), any other on the caller's share as before
        const final = await finalized(c, logs.to, own);
        const who = final && logs.pool && client !== undefined ? `${POOL_LOGS_CLIENT} ${client}` : mine;
        // card helper-keyed-logs-serve-a-whole-pool-range: the pinned pool's finalized range, from its deploy block on, in
        // the caller's address and topics alone: the part the store covers from the store, the rest past it as before.
        // The store holds finalized blocks alone, so its part needs no head read: live 16 Nov the head read was held
        // with dRPC's keys and the store was skipped (run 43794383970). Any range cap on such a read is the route's, in
        // the filling shape (poolCap), and starts the fill
        const req = out as Record<string, unknown>;
        const filter = (req.params as unknown[])[0] as Record<string, unknown>;
        const topics = logs.pool && Object.keys(filter).every((k) => k === "address" || k === "topics" || k === "fromBlock" || k === "toBlock") ? topicsOf(filter.topics) : null;
        const s = topics === null ? undefined : storeOf(c);
        if (s !== undefined && topics !== null && logs.from >= s.from) {
          poolReadAt.set(c, now());
          if (s.started && logs.to > s.covered) fillPool(c, own);
          if (logs.from <= s.covered) {
            const kept = storeLogs(s, logs.from, logs.to < s.covered ? logs.to : s.covered, topics);
            let rest: string[] = [];
            if (logs.to > s.covered) {
              const tf = s.covered + 1n;
              const tail = { ...req, params: [{ ...filter, fromBlock: hexOf(tf) }] };
              const ta = await logsRead(c, own, tail, JSON.stringify(tail), methods, tf, logs.to, who, reserved, by);
              const cap = poolCap(id, ta, s.covered);
              if (cap !== undefined) return (fillPool(c, own), cap);
              let answer: unknown;
              try {
                answer = parse(ta.body);
              } catch {
                return ta;
              }
              if (ta.status !== 200 || !isPlain(answer) || Object.hasOwn(answer, "error") || !Array.isArray(answer.result)) return ta;
              if (final) logCachePut(`${c} ${JSON.stringify(tail.params)}`, ta);
              rest = answer.result.map((x) => JSON.stringify(x));
            } else {
              const t = traces.getStore();
              if (t !== undefined) t.cached = true;
            }
            const body = `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":[${[...kept, ...rest].join(",")}]}`;
            if (Buffer.byteLength(body) <= RPC_ANSWER_MAX) return { status: 200, body };
          }
        }
        const a = await logsRead(c, own, req, forward, methods, logs.from, logs.to, who, reserved, by);
        // a range wider than the route's pages reach, or a provider's: the store starts filling, for the next read
        const cap = s !== undefined && topics !== null && logs.from >= s.from ? poolCap(id, a, s.covered) : undefined;
        if (cap !== undefined) return (fillPool(c, own), cap);
        if (final) logCachePut(logs.key, a);
        return a;
      }
      if (c !== "near" || client === undefined) return callList(c, own, forward, methods, mine, reserved, by);
      // the seat's day (review P3-3 of 997ce7a7f): looked at first, so a read past it costs no share; taken only once the
      // share admits the read (a share refusal spends none of it); given back when the walk answers its own 429 or 503 (no
      // provider answered: every one held past the wait, down or out)
      const seat = client;
      if (!seatDayTake(seat, methods.length, false)) return throttled(RETRY_AFTER_MAX_S, undefined, "near seat day");
      let takenOn = -1;
      const a = await callList(c, own, forward, methods, client, reserved, by, c, () => {
        if (!seatDayTake(seat, methods.length, true)) return false;
        takenOn = seatDay.day;
        return true;
      });
      if ((a.status === 429 || a.status === 503) && takenOn >= 0) seatDayRefund(seat, methods.length, takenOn);
      return a;
    }
    if (c === "solana" && keyed && companyUrls.has(upstreams.solana.url)) return solanaRest(forward, methods, client, reserved, by, c, 0);
    if (c === "solana" && keyed && upstreams.solana.keyed.length > 1 && (!slot.useKeyed() || budget.heldFor("solana") > 0)) return solanaRest(forward, methods, client, reserved, by, SPARES_KEY, 1, slotKey());
    if (c === "solana" && keyed && !slot.useKeyed()) return solanaRest(forward, methods, client, reserved, by);
    if ((EVM_CHAINS.has(c) && deps.holds !== undefined && (deps.pinned?.[c]?.length ?? 0) > 0) || (c !== "solana" && walks(c))) return callList(c, listOf(c), forward, methods, client, reserved, by);
    if (c === "solana" && keyed) {
      const u = slotKey();
      return call(c, u, formsByUrl.get(u) ?? upstreams.solana.forms, forward, methods, client, reserved, by);
    }
    return call(c, upstreams[c].url, upstreams[c].forms, forward, methods, client, reserved, by);
  }

  /** The route's range cap on a pool read, saying how far the pool store is (`data`: "pool logs kept to block N"), so its
   *  live check reads a store still filling apart from a route that has none; the cap's words stay the wallet's. */
  /** A pool read's answer when it is a range cap (evmRangeCap), the route's own (pagedLogs) or a provider's: the route's
   *  cap in the filling shape, how far the store is in `data`. A cap naming a span names it in the route's words (the
   *  wallet's), never a provider's; one naming none (on results or size) keeps its code and words. Else undefined. */
  const poolCap = (id: unknown, a: Answer, covered: bigint): Answer | undefined => {
    let answer: unknown;
    try {
      answer = parse(a.body);
    } catch {
      return undefined;
    }
    const e = isPlain(answer) ? answer.error : undefined;
    const named = evmRangeCap(e);
    if (named === null) return undefined;
    const { code, message } = named > 0n ? { code: LOGS_CAP_CODE, message: `eth_getLogs range too wide, maximum block range: ${named}` } : (e as { code: unknown; message: string });
    return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data: `pool logs kept to block ${covered}` } }) };
  };

  /**
   * A finalized-or-not eth_getLogs on the keyed-only route (card helper-base-logs-page): sent whole only to the providers
   * whose span covers it; when none does, or those that do all failed it (503), the narrower ones read it in pages
   * (pagedLogs).
   */
  async function logsRead(c: RpcChain, own: readonly string[], req: Record<string, unknown>, forward: string, methods: string[], from: bigint, to: bigint, who: string | undefined, reserved: boolean, by: number): Promise<Answer> {
    const span = to - from + 1n;
    const whole = own.filter((u) => covers(u, span));
    const narrow = own.filter((u) => !covers(u, span));
    const a = whole.length > 0 ? await callList(c, whole, forward, methods, who, reserved, by) : UPSTREAM();
    if (narrow.length === 0 || a.status !== 503) return a;
    return pagedLogs(c, narrow, req, from, to, who, reserved, by);
  }

  /**
   * One eth_getLogs (`req`, checked, numbers for both ends) of `from` to `to` on `providers`, none of whose span covers
   * it, read in pages (card helper-base-logs-page, LOGS_PAGES_MAX): pages of the widest span among them, back to back
   * from `from`, each the caller's filter with its own fromBlock and toBlock and the caller's id, sent to the providers
   * of that span alone through callList (each provider's pace, hold and day as any read), one in flight per provider,
   * a page its provider fails asked of the others (LOGS_PAGE_TRIES asks, within the walk's time). Answered as
   * one eth_getLogs: every page's result list joined in block order under the caller's id; else the first page's own
   * failure in block order (its JSON-RPC error with the caller's id, or the helper's 429 or 503). Past the page cap, or once the pages' logs pass RPC_ANSWER_MAX, a JSON-RPC range cap naming the
   * span that is served (LOGS_CAP_CODE), the first before any send. The pages draw the caller's paged allowance
   * (logsKey), all at once; refused, the caller's 429.
   */
  /** The pages `list` serves with no send waiting past PACE_MAX_MS (card base-reads-never-throttled): each pace's bucket
   *  once (dRPC's keys share one, DRPC_IP_PACE) and what refills it in that wait; a provider of no pace bounds nothing.
   *  Live 16 Nov 17:33Z, on dRPC's free pace (12 at once, 0.8 a second: 13 pages), a pool read 16 min of Base past the
   *  store was paged under the chain's total, spent the keys' bucket and still answered 503: past this many pages the
   *  read is the range cap before any send, and the bucket stays the callers'. */
  const pagesServed = (list: readonly string[]): number => {
    const buckets = new Map<string, number>();
    for (const u of list) {
      const p = holdsAll.paceOf(u);
      if (p === undefined) return Infinity;
      buckets.set(p.rate ?? u, Math.floor(p.burst + (p.perS * PACE_MAX_MS) / 1000));
    }
    return [...buckets.values()].reduce((n, k) => n + k, 0);
  };
  async function pagedLogs(c: RpcChain, providers: readonly string[], req: Record<string, unknown>, from: bigint, to: bigint, client: string | undefined, reserved: boolean, by: number): Promise<Answer> {
    const id = JSON.stringify(req.id);
    const capAnswer = (blocks: bigint, why: string): Answer => ({ status: 200, body: `{"jsonrpc":"2.0","id":${id},"error":{"code":${LOGS_CAP_CODE},"message":"${why}, maximum block range: ${blocks}"}}` });
    const w = providers.reduce((m, u) => (logsSpanByUrl.get(u)! > m ? logsSpanByUrl.get(u)! : m), 0n);
    const list = providers.filter((u) => logsSpanByUrl.get(u) === w);
    if (w <= 0n || list.length === 0) return UPSTREAM();
    const n = Number((to - from + w) / w);
    const max = Math.min(pagesMaxOf(c), pagesServed(list));
    if (n > max) return capAnswer(BigInt(max) * w, "eth_getLogs range too wide");
    const wait = budget.takeEach([[logsKey(c), n]], client, false, reserved);
    if (wait > 0) return throttled(wait, undefined, budget.refusedBy());
    const filter = (req.params as unknown[])[0] as Record<string, unknown>;
    const pageBody = (i: number): string => {
      const a = from + BigInt(i) * w;
      const b = a + w - 1n < to ? a + w - 1n : to;
      return JSON.stringify({ jsonrpc: "2.0", id: req.id, method: "eth_getLogs", params: [{ ...filter, fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` }] });
    };
    /** Each page's outcome: its result list as JSON text without the brackets, or the answer the read fails with. */
    const done: ({ part: string } | { fail: Answer } | undefined)[] = new Array(n);
    let bytes = 0;
    let stop = false;
    let next = 0;
    // one worker per provider, each sending its pages to its own provider first, so the workers never race for one
    // provider's second (racing ones lost every wake to the one already waiting: a page refused three times in a row)
    const one = async (i: number, mine: string): Promise<void> => {
      let a: Answer = UPSTREAM();
      // a page its provider did not serve (down, held, its second taken by other reads) is asked of the whole list
      for (let t = 0; t < LOGS_PAGE_TRIES && !stop && by - now() > WALK_SEND_MIN_MS; t++) {
        a = await callList(c, t === 0 ? [mine] : list, pageBody(i), ["eth_getLogs"], client, reserved, by, null, undefined, true);
        if (a.status === 200) break;
      }
      if (a.status !== 200) return void (done[i] = { fail: a });
      let answer: unknown;
      try {
        answer = parse(a.body);
      } catch {
        return void (done[i] = { fail: UPSTREAM() });
      }
      if (isPlain(answer) && Object.hasOwn(answer, "error")) return void (done[i] = { fail: { status: 200, body: `{"jsonrpc":"2.0","id":${id},"error":${JSON.stringify(answer.error)}}` } });
      if (!isPlain(answer) || !Array.isArray(answer.result)) return void (done[i] = { fail: UPSTREAM() });
      const part = JSON.stringify(answer.result).slice(1, -1);
      bytes += Buffer.byteLength(part) + 1;
      done[i] = { part };
    };
    const worker = async (mine: string): Promise<void> => {
      while (!stop && next < n) {
        const i = next++;
        await one(i, mine);
        if (!(done[i] && "part" in done[i]!) || bytes > RPC_ANSWER_MAX) stop = true;
      }
    };
    const t0 = now();
    const t = traces.getStore();
    // each page's waits and send in a trace of its own: side by side, they would sum past the read's own time
    await Promise.all(list.slice(0, n).map((u) => traces.run({ waitMs: 0 }, () => worker(u))));
    if (t !== undefined) t.pages = { n: next, ms: now() - t0 };
    // in block order: the first page that failed, or the pages that fit the answer cap
    const parts: string[] = [];
    let size = 0;
    for (let i = 0; i < n; i++) {
      // pages start in order and every started one ends before here, so a page never asked follows a failure or the cap
      const d = done[i];
      if (d === undefined) return UPSTREAM();
      if ("fail" in d) return d.fail;
      size += Buffer.byteLength(d.part) + 1;
      if (size > RPC_ANSWER_MAX) return capAnswer(BigInt(Math.max(1, i)) * w, "eth_getLogs response size exceeded");
      if (d.part !== "") parts.push(d.part);
    }
    return { status: 200, body: `{"jsonrpc":"2.0","id":${id},"result":[${parts.join(",")}]}` };
  }

  /**
   * A Solana read the first keyed provider did not serve (its slot fallen back, or it failed this read; card
   * rpc-keyed-lists): the keyed spares in order (callList, the read already drawn on the chain's budget), and only when
   * none of them answers, the public endpoint on its own budget (or 503 for a slot with no public fallback). `key`: the
   * budget the spares draw on (SPARES_KEY) when the read drew on none yet; none when it already drew on the chain's.
   * `from`: the first keyed URL asked (0 when a company's URL is first, review L2). `by`: the read's walk's end (WALK_MS).
   */
  async function solanaRest(forward: string, methods: string[], client: string | undefined, reserved: boolean, by: number, key: string | null = null, from = 1, tried?: string): Promise<Answer> {
    // card helper-solana-slots-off-a-spent-key: the host's other Solana slot keys not spent first (slotKeys), then the
    // keyed spares; never `tried`, the key this read was just refused by
    const spares = [...new Set([...slotKeys.slice(1).filter((u) => !spent(u)), ...upstreams.solana.keyed.slice(from).map((k) => k.url)])].filter((u) => u !== tried);
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
  // `admit`: a last check once the share admitted the read (the NEAR seat's day, taken there); false refuses it
  // `page`: one page of a caller's paged read (pagedLogs), which waits behind other callers' reads for a bucket (limits.ts take)
  async function callList(c: RpcChain, providers: readonly string[], forward: string, methods: string[], client: string | undefined, reserved: boolean, by: number, key: string | null = c, admit?: () => boolean, page = false): Promise<Answer> {
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
      if (admit !== undefined && !admit()) return throttled(RETRY_AFTER_MAX_S, undefined, "near seat day");
    }
    // a log read is never sent to a provider that refuses every one (LOGS_REFUSED): its 429 would hold it for the reads
    // it does answer
    const list = providers.filter((u) => !(methods.includes("eth_getLogs") && LOGS_REFUSED.has(u)));
    // card helper-receipts-past-retention: a past record answered null is asked of the next upstream (PAST_NULL_TRIES);
    // `nulled` the answer with the fewest such nulls, the read's when none keeps them; `forgot` the upstreams that
    // answered so, never asked again in this read
    let asked: unknown;
    try {
      asked = EVM_CHAINS.has(c) && methods.some((m) => PAST_METHODS.has(m)) ? JSON.parse(forward) : undefined;
    } catch {
      asked = undefined;
    }
    const past = asked === undefined ? null : pastAsks(asked, (h) => sentLately(c, client, h));
    let nulled: { status: number; body: string; n: number } | undefined;
    let nullTries = 0;
    const forgot = new Set<string>();
    // card helper-base-trade-reads-429: this read drew the keyed URLs' budget (keysGated), once whichever of them it asks
    let keysDrawn = false;
    for (let tries = 0; ; tries++) {
      let soonestMs = Infinity;
      let down = false;
      // card solana-marks-route-answers: every provider skipped for its day alone, named in the 503's refusal line
      let daysOut = 0;
      let sent = false;
      let shaped: { status: number; body: string } | undefined;
      let capped: { span: bigint; status: number; body: string } | undefined;
      for (const url of list) {
        if (forgot.has(url)) continue;
        // review L4: no send starts once the walk's time is nearly spent; the read is answered inside the server's timeout
        if (by - now() < WALK_SEND_MIN_MS) {
          down = true;
          break;
        }
        const secretForms = formsByUrl.get(url) ?? [];
        // review M1, L3: a read past a URL's plan's batch (dRPC free: 3, its HTTP 400 code 31 past it) or its second's
        // bucket leaves in parts of both (partOf, fitPost), never put out for its size (card helper-receipts-past-retention)
        // review M3: a URL past its day's budget is out until the next UTC day, which is no wait: down for this read
        if (holds.dayOut(url, methods.length)) {
          down = true;
          daysOut++;
          continue;
        }
        const h = holds.heldMs(url);
        if (h > 0) {
          soonestMs = Math.min(soonestMs, h);
          continue;
        }
        // card helper-base-trade-reads-429: a keyed URL takes the read only while the keys' part of the total has room;
        // else the walk goes on to the public spares (or, a keyed-only read, waits as for a held one)
        // (a read that drew elsewhere, key null: a paged read's page on its logs allowance, sized to the keys alone)
        if (key !== null && !keysDrawn && keysGated(c, url)) {
          const kw = budget.takeEach([[keysKey(c), methods.length]], client, false, reserved);
          if (kw > 0) {
            soonestMs = Math.min(soonestMs, kw * 1000);
            continue;
          }
          keysDrawn = true;
        }
        // review L2: NEAR's existing names keep their chain's pacer on the walk, as call() paced them
        const own = ownPace(c, url);
        const gate = own > 0 ? pacer.go(url, methods.length, own) : 0;
        if (gate > 0) {
          soonestMs = Math.min(soonestMs, gate);
          continue;
        }
        // card helper-rpc-batch-learns-reader-size: a batch past the URL's part size (partOf) goes as its parts (fitPost),
        // each a post of its pace: the first's no room is the read's wait, a later one's is waited for as it leaves
        const room = takeParts(url, methods.length, page);
        if (room > 0) {
          soonestMs = Math.min(soonestMs, room);
          continue;
        }
        let r: Sent;
        let text: string | undefined;
        sent = true;
        const from = now();
        try {
          r = await fitPost(c, url, forward, methods.length, by, partOf(url), drawOf(url, page));
          if (r.status === 429) {
            sentTo(url, from, c);
            // card helper-solana-off-a-spent-key: a 429 naming a spent plan ("max usage reached") is no throttle to wait
            // out: that URL is down for this read and out of the mark routes (markSpent), and the next is asked
            if (formsByUrl.has(url) && CREDITS.test(r.text ?? "")) {
              markSpent(url);
              down = true;
              continue;
            }
            const s = upstreamRetryAfterS(r.headers, now());
            holds.hold(url, s);
            log(`rpc hold ${c} ${companyOf(new URL(url).host)} caller ${s} s${shapeTail()}`);
            soonestMs = Math.min(soonestMs, holds.heldMs(url));
            continue;
          }
          text = r.text;
          sentTo(url, from, c);
        } catch {
          sentTo(url, from, c);
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
          markSpent(url);
          down = true;
          continue;
        }
        // card solana-marks-route-answers: a route B provider that answers the scan with a JSON-RPC error (a keyless
        // one's plan or index refusing it, -32010 and the like) is down for this read, and the next is asked
        if (c === "solana-marks" && isPlain(answer) && answer.error !== undefined) {
          down = true;
          continue;
        }
        const limited = evmLimited(c, answer);
        if (limited > 0) {
          holds.hold(url, limited);
          log(`rpc hold ${c} ${companyOf(new URL(url).host)} caller ${limited} s${shapeTail()}`);
          soonestMs = Math.min(soonestMs, holds.heldMs(url));
          continue;
        }
        // a provider's range cap: out for this read alone (no hold: it serves smaller spans and every other read); the
        // largest span named is kept for the caller when every provider caps (card helper-evm-range-cap-walk)
        // an answer that holds this provider's key in any form is that provider down for this read: never kept, so a
        // clean cap or refusal from another still answers (review fold 1)
        const leaks = answerHoldsKey(url, secretForms, text, answer);
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
        const nulls = past === null ? 0 : pastNullsIn(past, answer);
        if (nulls > 0) {
          if (nulled === undefined || nulls < nulled.n) nulled = { status: r.status, body: text, n: nulls };
          forgot.add(url);
          log(`rpc past null ${c} ${companyOf(new URL(url).host)} ${nulls} of ${past!.size}${shapeTail()}`);
          if (nullTries++ < PAST_NULL_TRIES) continue;
          return { status: nulled.status, body: nulled.body };
        }
        return { status: r.status, body: text };
      }
      // the past nulls' answer when no other upstream is left to ask now (card helper-receipts-past-retention)
      if (nulled !== undefined && soonestMs === Infinity) return { status: nulled.status, body: nulled.body };
      // none could take it: the soonest provider's short hold or pace wait is waited out, and the read asked again (a
      // read sent and refused draws on the budget once more, as any send does)
      const waitMs = soonestMs + HOLD_MARGIN_MS;
      // a page waits for its bucket as often as the deadline allows: its read's pages share dRPC's one bucket (limits.ts
      // DRPC_IP_PACE), so a worker woken for a refill another took waits again, never failing the page for it
      if ((page || tries < 2) && soonestMs <= HOLD_WAIT_MS && now() + waitMs <= deadline) {
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
      if (nulled !== undefined) return { status: nulled.status, body: nulled.body };
      if (capped !== undefined) return { status: capped.status, body: capped.body };
      if (shaped !== undefined && soonestMs === Infinity) return { status: shaped.status, body: shaped.body };
      // every provider failed (none held or out of room; a company past its day's budget is down, review M3): upstream,
      // so the device reads its own; else the soonest wait
      if (down && soonestMs === Infinity) return daysOut === list.length ? { ...UPSTREAM(), why: `${c} every provider past its day` } : UPSTREAM();
      return throttled(soonestMs === Infinity ? RETRY_AFTER_MAX_S : Math.min(RETRY_AFTER_MAX_S, Math.max(1, Math.ceil(soonestMs / 1000))), undefined, `${c} every provider held`);
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
      return solanaRest(forward, methods, client, reserved, by, null, 1, url);
    };
    /** Card helper-solana-slots-off-a-spent-key: the key's plan is spent. Out for SLOT_RETRY_MS (markSpent), and the read
     *  goes on to the next (fellBack); the slot falls back only when no other slot key is left that is not spent. */
    const spentKey = (): Promise<Answer> => {
      markSpent(url);
      if (slotKeys.length === 0) slot.fail("credits");
      return fellBack();
    };
    // card helper-crowd-429: a hold that ends within HOLD_WAIT_MS is waited out and the send paced from its end, and a
    // send the provider throttles is sent once more after its short hold, all by `deadline`; a longer hold is the
    // caller's 429 with its seconds. An EVM chain's provider is held for every path of the helper that reads it (Deps
    // holds, card helper-robinhood-capacity): that hold is waited out and paced from the same way.
    const shared = EVM_CHAINS.has(c) ? url : undefined;
    const heldAt = (): number => heldOf(key, shared);
    const deadline = now() + HOLD_WAIT_MS + PACE_MAX_MS;
    /** Card helper-solana-slots-off-a-spent-key, round 2: the slot's key has no room (its pace past PACE_MAX_MS, or a hold
     *  past HOLD_WAIT_MS): the read goes on to the next provider (fellBack: the other slot keys, the keyed spares, the
     *  public endpoint), so a caller's send or simulation is never the helper's own 429 while one of them has room. The
     *  key's own pace is unchanged (a borrowed key still gets its half only). A slot with no public fallback (the
     *  holders key's) answers the 429 as before. */
    const noRoom = (refused: Answer): Promise<Answer> => (viaSlot && publicFallback ? fellBack() : Promise.resolve(refused));
    if (!(await holdOver(key, deadline, shared, rest))) return noRoom(throttled(heldAt(), undefined, `${key} held`));
    const wait = budget.takeEach(drawsOf(key, methods), client, false, reserved);
    if (wait > 0) return throttled(wait, undefined, budget.refusedBy());
    let r!: Sent;
    let text: string | undefined;
    let sent = now();
    for (let tries = 0; ; tries++) {
      const room = Math.max(0, Math.min(PACE_MAX_MS, deadline - now()));
      // card helper-serves-many-users-at-once: the first Solana key full for this second, a keyed spare with room takes
      // the read now; it drew the chain's budget above and draws nothing again (solanaRest with no key). A spare with
      // no room: the first key's wait, and past PACE_MAX_MS the next provider (noRoom)
      if (viaSlot && tries === 0 && upstreams.solana.keyed.length > 1 && pace(key, methods.length, room, shared, false) > 0 && spareHasRoom(methods.length)) return solanaRest(forward, methods, client, reserved, by, null, 1, url);
      const paced = pace(key, methods.length, room, shared);
      if (paced > room) return noRoom(throttled(Math.max(1, Math.ceil((paced - room) / 1000)), undefined, `${key} pace`));
      if (paced > 0) await rest(paced);
      // the hold is read again right before the send: the provider may have asked us to wait while this one waited
      // for its second (card helper-rpc-hold-queued); a short one is waited out and the send paced again
      if (heldAt() > 0) {
        if (tries < 2 && (await holdOver(key, deadline, shared, rest))) continue;
        return noRoom(throttled(Math.max(1, heldAt()), undefined, `${key} held`));
      }
      // the send counted where it leaves (Pacer.go), within the deadline
      const p = pacedOf(key);
      const goBy = performance.now() + Math.max(0, deadline - now());
      let gate = p === null ? 0 : pacer.go(p.url, methods.length, p.perSecond);
      for (let round = 0; gate > 0; round++) {
        // a few rounds at most: each waits for a send to leave the second, so more mean a crowd past the deadline
        if (round >= 4 || performance.now() + gate > goBy) return noRoom(throttled(Math.max(1, Math.ceil(gate / 1000)), undefined, `${key} pace`));
        await rest(gate);
        gate = pacer.go(p!.url, methods.length, p!.perSecond);
      }
      if (heldAt() > 0) return noRoom(throttled(Math.max(1, heldAt()), undefined, `${key} held`));
      // review L4: the public endpoint after a walk's spares is sent only inside the read's walk time
      if (by - now() < WALK_SEND_MIN_MS) return UPSTREAM();
      sent = now();
      try {
        // card helper-rpc-batch-learns-reader-size: a batch past the provider's kept size goes as its parts (fitPost)
        r = await fitPost(c, url, forward, methods.length, by);
        if (r.status === 429) {
          const body = viaSlot ? (r.text ?? "") : "";
          sentTo(url, sent);
          const waitS = upstreamRetryAfterS(r.headers, now());
          if (viaSlot && CREDITS.test(body)) return spentKey();
          if (viaSlot && slot.throttled(waitS)) return fellBack();
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
        text = r.text;
        sentTo(url, sent);
      } catch {
        sentTo(url, sent);
        if (viaSlot) return slot.unanswered(sent), fellBack();
        return UPSTREAM();
      }
      break;
    }
    if (viaSlot && (r.status === 401 || r.status === 403)) return slot.fail(String(r.status)), fellBack();
    if (viaSlot && r.status >= 400 && CREDITS.test(text ?? "")) return spentKey();
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
    if (viaSlot && planSpent(answer)) return spentKey();
    // an EVM provider's throttle in any answer (evmLimited: -32005 or a rate or request limit message) is its throttle, as
    // its 429 is: the chain is held for the backoff it names (Infura's error.data.backoff_seconds), else 1 s
    const limited = evmLimited(c, answer);
    if (limited > 0) {
      hold(key, limited, "caller");
      if (shared !== undefined) deps.holds?.hold(url, limited);
      return throttled(budget.heldFor(key), undefined, `${key} provider limit`);
    }
    if (answerHoldsKey(url, secretForms, text, answer)) return UPSTREAM();
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
      // card helper-solana-slots-off-a-spent-key: another slot's key (the holders key, say) is read in the half of its
      // second this client may take (slotShareOf) less the callers' room, so its own slot's reads keep the other half
      if (chain === "solana" && borrowed(url)) {
        const per = slotShareOf(ownPlans.solana);
        return holdsAll.heldMs(url) > 0 || pacer.go(url, 1, Math.max(1, per - userRoomOf(per))) > 0 ? 1 : 0;
      }
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
    else if (isSpare(chain, url) || (chain === "solana" && borrowed(url))) {
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
   * company's pace as a background read (one skipped while its pace, its day's probe share or any hold on it says wait, its
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
          // card helper-live-red: drawn on the day's probe share (limits.ts PROBE_DAY_SHARE), so a URL whose day the reads
          // spent is still read, never past its plan's day
          if (holdsAll.heldMs(k.url) > 0 || holdsAll.take(k.url, 1, true, false, true) > 0) return;
          probedAt.set(k.url, now());
          let state: KeyedState = "down";
          try {
            const r = await doFetch(k.url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: KEYED_IDENTITY[c].body, redirect: "error", signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
            if (r.status === 429) {
              // card helper-solana-off-a-spent-key: a 429 naming a spent plan is "spent", out of the mark routes
              const said = await readAnswer(r).catch(() => undefined);
              if (CREDITS.test(said ?? "")) {
                markSpent(k.url);
                state = "spent";
              } else {
                holdsAll.hold(k.url, upstreamRetryAfterS(r.headers, now()));
                state = "held";
              }
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
  const keyOf = (chain: RpcChain, url: string): string | null => (url === upstreams[chain].url && !companyUrls.has(url) && (chain !== "solana" || url === slotKey()) ? chain : chain === "solana" && keyed && url === SOLANA_PUBLIC ? PUBLIC_KEY : null);

  /** A chain's budget (card helper-serves-many-users-at-once) as the IETF RateLimit-Policy field
   *  (draft-ietf-httpapi-ratelimit-headers-11, 23 May 2026, read 11 Nov 06:01Z: `"burst";q=100;w=60`): "chain", what
   *  every caller together may draw in its window, and "client", one caller's share; numbers only, no provider, URL or
   *  key. Undefined for a name that is no chain. /v1/health has no room for it (the kit's 1 KB at the longest config). */
  const policyOf = (chain: string): string | undefined => {
    if (!(RPC_CHAINS as readonly string[]).includes(chain)) return undefined;
    const l = limits[chain as RpcChain];
    const w = LIMIT_WINDOW_MS / 1000;
    return `"chain";q=${l.total};w=${w}, "client";q=${l.perClient};w=${w}`;
  };
  /** The slot as /v1/health names it (card helper-solana-off-a-spent-key): fallen back, its reads walk the keyed spares
   *  before the public endpoint (solanaRest), so it is "keyed" while one of them serves (not spent, its last identity
   *  read answered), and "fallback" only once none does. Its other members are the slot's own. */
  const shownSlot: Slot = { ...slot, state: () => (slot.state() === "fallback" && upstreams.solana.keyed.slice(1).some((k) => !spent(k.url) && probed.get(k.url) === "answers") ? "keyed" : slot.state()) };
  return { handle, background, backgroundThrottled, slot: shownSlot, pacer, keyed: keyedHealth, probe, policyOf, spent };
}

/** The chains whose keyed lists /v1/health names (card rpc-keyed-lists): mainnet's four. */
export const KEYED_CHAINS = ["solana", "base", "robinhood", "near"] as const;
export type KeyedChain = (typeof KEYED_CHAINS)[number];
/** A keyed URL's last probe: it answered its chain, answered another chain, refused us for a while (429), refused us
 *  with its plan spent (a 429 naming it, slot.ts CREDITS; card helper-solana-off-a-spent-key), failed (an error, a
 *  timeout, not 200 JSON), or is not probed yet. */
export type KeyedState = "answers" | "wrong chain" | "held" | "spent" | "down" | "unread";
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
/** Each keyed EVM chain's id, as eth_chainId answers it. */
const KEYED_ID: Partial<Record<RpcChain, string>> = { base: "0x2105", robinhood: "0x1237" };
const KEYED_IDENTITY: Readonly<Record<KeyedChain, { body: string; ok: (a: unknown) => boolean }>> = {
  base: { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), ok: (a) => (a as { result?: unknown } | null)?.result === KEYED_ID.base },
  robinhood: { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), ok: (a) => (a as { result?: unknown } | null)?.result === KEYED_ID.robinhood },
  solana: { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }), ok: (a) => (a as { result?: unknown } | null)?.result === SOLANA_GENESIS },
  near: { body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "status", params: [] }), ok: (a) => (a as { result?: { chain_id?: unknown } } | null)?.result?.chain_id === "mainnet" },
};
