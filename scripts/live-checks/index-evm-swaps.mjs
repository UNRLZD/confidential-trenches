#!/usr/bin/env node
// Live check of cards index-evm-swaps and index-evm-swaps-2: a Base or Robinhood token's candles and trade tape come
// from the helper's own chain reads
// (apps/helper/src/data/evm/swaps.ts, candles.ts), and the chain agrees with them. It reads one listed Base token at
// HELPER_HOST with Origin APP_HOST (--token for a given one; otherwise the first token of the Base Discover lists whose
// candles answer 200):
//   GET /v1/market/candles?chain=base&token=<t>&tf=1m&limit=60
//   GET /v1/market/trades?chain=base&token=<t>&limit=50
// and passes only when:
//   - each answers 200 JSON with X-Helper-Commit a full sha, X-Fetched-At an ISO time within 15 s of that answer's own
//     read (freshAt) and Access-Control-Allow-Origin echoing APP_HOST; X-Helper-Source is "chain" (our own reads) for the tape, and for the
//     candles "chain", "chain,geckoterminal" or "chain,coingecko" (the vendor, keyless or the paid plan, only before our
//     first bar);
//   - candles hold exactly the frozen fields tf, candles, src, own_from_s, as_of_ms; bars [t_s, o, h, l, c, vol_usd] on
//     the 1m grid, oldest first, USD decimal strings, high >= open, close >= low, bars from our own reads start at
//     own_from_s; the trades hold exactly trades, src, as_of_ms, each {t_ms, side, usd, amt, trader, tx}, newest first;
//   - the newest trades are on chain (RPC: SWAP_RPCS, two providers that agree on every answer): each receipt succeeded,
//     sits in the block whose Base clock time is the trade's, was sent by the trade's trader (for a bundle sent to an
//     ERC-4337 EntryPoint, the account of the user operation whose run holds the trade's swap, read from the receipt
//     here, never the helper's code); the pool being the emitter (and for v4 the pool id) of the Swap log every sampled
//     receipt shares (where they share more than one, each a route through two pools of the token, the one with most
//     swap transactions over the window, each key's logs read on two providers), a v4 trade's `amt` is exactly this pool's own Swap leg of the token in the receipt the two
//     providers agreed on (two that answered and differ fail, naming each one's leg), less a hook's cut where one is
//     read: what the trade's sender, whose one swap it is, moved with the PoolManager (helper-v4-hook-liquidity's
//     judgeable), or for a route, whose sender swaps more than once and nets the token inside the PoolManager, one take
//     of the token out of the PoolManager by an address that sent no swap (live run 42908764691: two such routes had no
//     Transfer of their amt and failed). Each v2, v3 or curve trade, and each v4 trade of a sender's one swap, is
//     asked a Transfer of the token for exactly `amt` to the pool (a sell) or from it (a buy), and at least half of
//     those asked carry one;
//   - no swap is missing: every swap of that pool in the blocks the tape covers, up to 120 blocks (24 s) behind the
//     providers' newest, is on the tape.
// On Robinhood (--chain robinhood), which has no fixed block clock, a trade's time must be its block's own time and the
// providers' newest block's time within 20 s of their read, each block time read on two providers that agree; its swaps
// include the Pons v2 curve's CurveBuy and CurveSell, and its pool's logs are read in the 100-block spans its keyless
// providers take.
// With no --chain it checks both chains and passes only when both pass (the deployed helper's run).
// On FAIL it names each read the helper answered (card helper-deploy-reads-fast): the lists read and every listed token
// it tried before the one judged, each with its status, its time and the helper's Server-Timing (an EVM read names its
// open and its wait for the providers' paces and in-flight queues, evm-open and evm-queue), so a late read names its
// cause (live run 42122733397 attempt 1: the judged token's candles came 23 s after the read, the reads before it named
// nowhere).
// Each candles read is read as the token page reads it (candles-read.mjs): a 429 again at its Retry-After, for at most
// one 75 s span in the run; a candidate whose candles still answer 429 after it is skipped as before, its waits named.
// After: helper
//   node scripts/live-checks/index-evm-swaps.mjs [--chain base|robinhood] [--base <url>] [--token <0x..>] [--record <file>] [--speed <n>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (a head no second provider knew yet, read again 5 times
//   2 s apart: the providers named). --record writes the run (every answer read).
import "../net-window.mjs";
import { candlesReader, waitsText } from "./candles-read.mjs";
import { writeFileSync } from "node:fs";
import { BLOCK_CLOCK, blockAt } from "../../apps/helper/src/data/evm/lists.ts";
import { HEADER_TIMED, SWAP_RPCS, TOPIC, VENUES } from "../../apps/helper/src/data/evm/swaps.ts";
import { judgeable } from "./helper-v4-hook-liquidity.mjs";

const KEY = "index-evm-swaps";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const SAMPLE = 5;
/** Blocks behind the providers' newest a swap must be on the tape by: 24 s on Base (200 ms blocks since block 53556127,
 *  lists.ts BLOCK_CLOCK), 6 s on Robinhood. */
export const MARGIN = { base: 120, robinhood: 60 };
export const MARGIN_BLOCKS = MARGIN.base;
/** The most blocks one pool-log read asks (the chain's keyless providers' widest), and how far back the read goes. */
const SPAN = { base: 1000, robinhood: 100 };
const BACK = { base: 6000, robinhood: 1000 };
const LAG = { base: 50, robinhood: 50 };
/** The most shared pool keys whose logs a run reads to find the busiest (a route's pools: two in every one read). */
export const SHARED_MAX = 3;
const CLOCK = BLOCK_CLOCK.base;
const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const DEC = /^\d+(\.\d+)?$/;
const ADDR = /^0x[0-9a-f]{40}$/;
const TX = /^0x[0-9a-f]{64}$/;
const SWAP_TOPICS = [TOPIC.swap2, TOPIC.swap3, TOPIC.swap4, TOPIC.curveBuy, TOPIC.curveSell];
/**
 * ERC-4337 (card helper-deploy-reads-fast fold): a transaction sent to an EntryPoint is a bundle, whose `from` is the
 * bundler that paid the gas; each user operation's logs run from the EntryPoint's BeforeExecution, SignatureAggregatorChanged
 * or previous UserOperationEvent to its own UserOperationEvent, whose second indexed topic is the operation's account
 * (eth-infinitism/account-abstraction EntryPoint.sol: handleOps emits BeforeExecution, then runs each operation, each
 * ending in its UserOperationEvent). The EntryPoints v0.6 to v0.9; the topics are keccak-256 of
 * "UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)", "BeforeExecution()" and
 * "SignatureAggregatorChanged(address)", the first two as Base tx 0x672edabc logged them from v0.6 (block 53645984, read
 * on base-rpc.publicnode.com and mainnet.base.org, 2026-11-05 23:2xZ). Written here on its own, never imported from the
 * helper: a check that shares the helper's code shares its bug.
 */
const ENTRY_POINTS = new Set(["0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789", "0x0000000071727de22e5e9d8baf0edac6f37da032", "0x4337084d9e255ff0702461cf8895ce9e3b5ff108", "0x433709009b8330fda32311df1c2afa402ed8d009"]);
const USER_OP_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const RUN_STARTS = new Set(["0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972", "0x575ff3acadd5ab348fe1855e217e0f3678f8d767d7494c9f9fefbee2e17cca4d"]);
/** Who sent the swaps `isSwap` picks in receipt `r`: its `from`; for a bundle, each user operation's account whose run
 *  holds one (none for a swap outside every run). */
export function swapSenders(r, isSwap) {
  const ep = typeof r.to === "string" ? r.to.toLowerCase() : null;
  if (ep === null || !ENTRY_POINTS.has(ep)) return { bundle: false, senders: [r.from] };
  const logs = r.logs ?? [];
  const out = new Set();
  let start = null;
  for (const [i, l] of logs.entries()) {
    if (String(l.address).toLowerCase() !== ep) continue;
    const t0 = l.topics?.[0];
    if (t0 === USER_OP_EVENT) {
      const account = topicAddr(l.topics?.[2]);
      if (start !== null && account !== null && logs.slice(start + 1, i).some(isSwap)) out.add(account);
      start = i;
    } else if (RUN_STARTS.has(t0)) start = i;
  }
  return { bundle: true, senders: [...out] };
}
export const CANDLES_PATH = (t, net = "base") => `/v1/market/candles?chain=${net}&token=${t}&tf=1m&limit=60`;
export const TRADES_PATH = (t, net = "base") => `/v1/market/trades?chain=${net}&token=${t}&limit=50`;
const LISTS_PATH = (net) => `/v1/market/lists?chain=${net}`;

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** A Base block's time (whole seconds, as its header's) by the clock era it is in, and the newest block at or before a
 *  time: a block-time change Base makes with no era for it here fails the trades' block times, naming the drift. */
const blockTime = (n) => {
  const e = CLOCK.findLast((x) => x.fromBlock <= n);
  return Math.floor((e.atMs + e.blockMs * (n - e.fromBlock)) / 1000);
};
const blockOf = (s) => blockAt("base", s);
const hex = (n) => `0x${n.toString(16)}`;

/** The candles' sources: our own bars, the vendor's (GeckoTerminal keyless, or CoinGecko's paid plan, apps/helper/src/
 *  data/coingecko.ts CG_SRC) only before our first. */
export const CANDLE_SOURCES = ["chain", "chain,geckoterminal", "chain,coingecko"];
/** The first thing wrong with a Candles answer, or null. */
export function candlesFault(c) {
  if (!isObj(c) || !same(Object.keys(c), ["tf", "candles", "src", "own_from_s", "as_of_ms"])) return `keys ${show(isObj(c) ? Object.keys(c) : c)}`;
  if (c.tf !== "1m" || !CANDLE_SOURCES.includes(c.src) || !Number.isSafeInteger(c.as_of_ms)) return `tf ${show(c.tf)}, src ${show(c.src)}`;
  if (!Array.isArray(c.candles) || c.candles.length === 0 || c.candles.length > 60) return `candles ${Array.isArray(c.candles) ? c.candles.length : "not a list"}`;
  for (const [i, b] of c.candles.entries()) {
    if (!Array.isArray(b) || b.length !== 6 || !Number.isSafeInteger(b[0]) || b[0] % 60 !== 0 || !b.slice(1).every((v) => typeof v === "string" && DEC.test(v))) return `bar ${i} ${show(b)}`;
    if (i > 0 && b[0] <= c.candles[i - 1][0]) return `bar ${i} not after bar ${i - 1}`;
    const [, o, h, l, cl] = b.map(Number);
    if (!(h >= o && h >= cl && l <= o && l <= cl && h >= l)) return `bar ${i} high/low does not hold open and close ${show(b)}`;
  }
  if (!Number.isSafeInteger(c.own_from_s) || c.own_from_s % 60 !== 0 || !c.candles.some((b) => b[0] === c.own_from_s)) return `own_from_s ${show(c.own_from_s)} is not a bar`;
  return null;
}

/** The first thing wrong with a Trades answer, or null. */
export function tradesFault(t) {
  // `filling` true: a tape whose older trades the helper still reads (card token-page-data-complete-and-fast); never false
  const keys = isObj(t) && t.filling === true ? ["trades", "filling", "src", "as_of_ms"] : ["trades", "src", "as_of_ms"];
  if (!isObj(t) || !same(Object.keys(t), keys)) return `keys ${show(isObj(t) ? Object.keys(t) : t)}`;
  if (t.src !== "chain" || !Number.isSafeInteger(t.as_of_ms)) return `src ${show(t.src)}`;
  if (!Array.isArray(t.trades) || t.trades.length === 0 || t.trades.length > 50) return `trades ${Array.isArray(t.trades) ? t.trades.length : "not a list"}`;
  for (const [i, r] of t.trades.entries()) {
    if (!isObj(r) || !same(Object.keys(r), ["t_ms", "side", "usd", "amt", "trader", "tx"])) return `trade ${i} keys ${show(isObj(r) ? Object.keys(r) : r)}`;
    if (!Number.isSafeInteger(r.t_ms) || r.t_ms % 1000 !== 0 || !["b", "s"].includes(r.side) || !DEC.test(r.usd) || !DEC.test(r.amt) || !TX.test(r.tx) || !(r.trader === null || ADDR.test(r.trader))) return `trade ${i} ${show(r)}`;
    if (i > 0 && r.t_ms > t.trades[i - 1].t_ms) return `trade ${i} is newer than trade ${i - 1}`;
  }
  return null;
}

/** `amt` (a decimal string) in the token's smallest unit, or null. */
export function units(amt, decimals) {
  const [w, f = ""] = String(amt).split(".");
  if (f.length > decimals) return null;
  return BigInt(w + f.padEnd(decimals, "0"));
}

const isAmount = (data, want) => /^0x[0-9a-f]{64}$/.test(data ?? "") && BigInt(data) === want;
const topicAddr = (t) => (typeof t === "string" && /^0x0{24}[0-9a-f]{40}$/.test(t) ? `0x${t.slice(26)}` : null);
/** The pool key of a Swap log: its emitter, and for the PoolManager the pool id. */
const poolKey = (l, net = "base") => (l.address === VENUES[net].poolManager ? `${l.address}:${l.topics[1]}` : l.address);
/**
 * The token legs of pool `key`'s v4 Swap logs in receipt `r` on a trade's side, with each log's place and sender. The
 * PoolManager logs Swap(id, sender, int128 amount0, int128 amount1, ...) from the swapper's side (v4-core PoolManager.swap
 * emits the caller's BalanceDelta: what it got is positive, what it owes negative), so a buy's token leg is the one
 * positive amount and a sell's the one negative one: Robinhood tx 0x2c7930a7 (block 111207407) logs +476842127889091326311
 * of the token for the router's buy on pool 0x1fa1e9b5, tx 0xcdc53645 (block 111207737) -106651292978592276941884 for its
 * sell (read on two providers, 2026-11-10 22:3xZ).
 */
export function poolLegs(r, key, net, side) {
  const out = [];
  for (const [i, l] of (r?.logs ?? []).entries()) {
    if (l.topics?.[0] !== TOPIC.swap4 || poolKey(l, net) !== key || !/^0x[0-9a-f]{128}/.test(l.data ?? "")) continue;
    const [a0, a1] = [0, 1].map((k) => BigInt.asIntN(128, BigInt(`0x${l.data.slice(2 + 64 * k, 66 + 64 * k)}`)));
    const leg = side === "b" ? [a0, a1].filter((v) => v > 0n) : [a0, a1].filter((v) => v < 0n).map((v) => -v);
    if (leg.length === 1) out.push({ i, sender: topicAddr(l.topics[2]), leg: leg[0] });
  }
  return out;
}
/** The takes of `coin` out of PoolManager `pm` in receipt `r` by an address that sent none of its v4 swaps `swaps4` (a
 *  hook's cut: Robinhood tx 0x8b878e95's Transfer of 21.761233208384569447 to the hook 0xe5e70264 right after the pool's
 *  Swap of 2,176.123320838456944793, its router taking 2,154.362087630072375346), as Transfers or ERC-6909 claims minted. */
function outsideTakes(r, coin, pm, swaps4) {
  const senders = new Set(swaps4.map((l) => topicAddr(l.topics?.[2])));
  const out = [];
  for (const l of r?.logs ?? []) {
    const t = l.topics ?? [];
    if (l.address === coin && t.length === 3 && t[0] === TOPIC.transfer && topicAddr(t[1]) === pm && /^0x[0-9a-f]{64}$/.test(l.data ?? "")) {
      const to = topicAddr(t[2]);
      if (to !== null && to !== pm && !senders.has(to)) out.push(BigInt(l.data));
    } else if (l.address === pm && t.length === 4 && t[0] === TOPIC.claims && t[1] === `0x${"0".repeat(64)}` && t[3] === `0x${coin.slice(2).padStart(64, "0")}` && /^0x[0-9a-f]{128}$/.test(l.data ?? "")) {
      const to = topicAddr(t[2]);
      if (to !== null && !senders.has(to)) out.push(BigInt(`0x${l.data.slice(66)}`));
    }
  }
  return out;
}
/** Token units in decimals, for a line: `[a, b]` of the smallest unit. */
const legText = (vs, dec) => (vs.length === 0 ? "none" : vs.map((v) => (dec === null ? `${v} units` : `${v / 10n ** BigInt(dec)}${v % 10n ** BigInt(dec) === 0n ? "" : `.${(v % 10n ** BigInt(dec)).toString().padStart(dec, "0").replace(/0+$/, "")}`}`)).join(" and "));

/** The most an answer's X-Fetched-At may lie after the answer arrived: the helper's and the check's clocks apart (both
 *  NTP-kept) [design: 2 s]. */
export const SKEW_MS = 2_000;
/**
 * Whether answer `r`'s X-Fetched-At `at` (ms) is within `bound` ms of the answer's own read: of the time its request was
 * sent (r.at), and not after the answer arrived (r.ms later) but for SKEW_MS. Each read is judged by its own time, never
 * by the run's start (card helper-restart-fresh: in live run 42163488602, straight after a restart, the Base token judged
 * was read 20.6 s into the run, after a cold token's 12 s not-ready 503 and ten quiet tokens, and its answers, dated 2.85 s
 * after their request and 53 ms before they arrived, failed "within 15 s of the read"; judged by the run's start, an
 * answer read late in a run could also be that much older than its own read and pass). A run recorded before its reads
 * carried their time is judged against the run's start, as it was then. `ref`: what it is judged against, for the line.
 */
export function freshAt(r, at, runAt, bound) {
  if (typeof r?.at !== "string" || !Number.isSafeInteger(r?.ms)) return { ok: Math.abs(runAt - at) <= bound, ref: `the read at ${new Date(runAt).toISOString()}` };
  const sent = Date.parse(r.at);
  return { ok: Math.abs(sent - at) <= bound && at - (sent + r.ms) <= SKEW_MS, ref: `its read at ${r.at} (answered in ${r.ms} ms)` };
}

/**
 * The check on one run: { base, coin, readAt, reads: { candles, trades }, chain }, each read { at, ms, status, headers,
 * body } (at: its request's time), and chain what `read` took from the providers: { heads: [n..], headsAt, decimals,
 * receipts: { [tx]: receipt | null }, poolLogs: { key, from, to, logs } | null }.
 */
export function judge(run) {
  const net = run.net ?? "base";
  // a block's time: Base's clock; Robinhood's own, read on two agreeing providers (run.chain.blockTimes)
  const timeOf = (n) => (net === "base" ? blockTime(n) : run.chain?.blockTimes?.[n] ?? null);
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  // the lists the token is picked from did not answer: nothing else to judge
  if (run.lists !== undefined) {
    say(false, `GET ${run.lists.path ?? `/v1/market/lists?chain=${net}`} answers ${run.lists.status}${run.lists.status === 200 ? " with no lists" : ""} (${net})`);
    return withReads(run, lines);
  }
  const readAt = Date.parse(run.readAt);
  const parsed = {};
  for (const [k, fault, path, source] of [
    ["candles", candlesFault, CANDLES_PATH(run.coin, net), CANDLE_SOURCES],
    ["trades", tradesFault, TRADES_PATH(run.coin, net), ["chain"]],
  ]) {
    const r = run.reads?.[k] ?? { status: 0, headers: {}, body: "" };
    const h = r.headers ?? {};
    say(r.status === 200, `GET ${path} answers ${r.status}${k === "candles" ? waitsText(r) : ""}`);
    say(/^application\/json/i.test(h["content-type"] ?? ""), `${k} Content-Type: ${show(h["content-type"])}`);
    say(SHA.test(h["x-helper-commit"] ?? ""), `${k} X-Helper-Commit: ${show(h["x-helper-commit"])}`);
    say(source.includes(h["x-helper-source"]), `${k} X-Helper-Source: ${show(h["x-helper-source"])}, our own chain reads`);
    const fresh = freshAt(r, Date.parse(h["x-fetched-at"] ?? ""), readAt, 15_000);
    say(ISO.test(h["x-fetched-at"] ?? "") && fresh.ok, `${k} X-Fetched-At: ${show(h["x-fetched-at"])}, within 15 s of ${fresh.ref}`);
    say(h["access-control-allow-origin"] === APP, `${k} Access-Control-Allow-Origin: ${show(h["access-control-allow-origin"])}`);
    let b;
    try {
      b = JSON.parse(r.body);
    } catch {
      b = undefined;
    }
    const f = fault(b);
    say(f === null, `${k}: exactly the frozen fields in their wire forms${f === null ? "" : `: ${f}`}`);
    if (f === null) parsed[k] = b;
  }
  const { candles, trades } = parsed;
  if (candles === undefined || trades === undefined) return withReads(run, lines);

  const c = run.chain ?? {};
  const heads = Array.isArray(c.heads) ? c.heads : [];
  say(heads.length === 2 && heads.every(Number.isSafeInteger) && Math.abs(heads[0] - heads[1]) <= LAG[net], `the chain: two providers' newest blocks ${show(heads)}`);
  const head = Math.min(...heads);
  // the heads' time against their own read (c.headsAt; a run recorded before it, the run's start), as each answer's
  const headsAt = c.headsAt === undefined ? readAt : Date.parse(c.headsAt);
  // a head another provider does not know yet (the lower head's provider, a block or two behind on Robinhood's 0.1 s
  // blocks) is read again and, still unknown on the last read (c.behind: its hosts), INCONCLUSIVE naming them, never FAIL
  const behind = (c.heads ?? []).filter((n) => !Number.isSafeInteger(timeOf(n)) && Array.isArray(c.behind?.[n]) && c.behind[n].length > 0);
  for (const n of behind) lines.push(`--  the newest block ${n}: ${c.behind[n].join(" and ")} did not know it yet after ${HEAD_TRIES} reads ${HEAD_WAIT_MS} ms apart: INCONCLUSIVE`);
  if (behind.length === 0) say(c.heads?.every((n) => Number.isSafeInteger(timeOf(n)) && Math.abs(timeOf(n) - headsAt / 1000) <= 20), `the providers' newest block's time${net === "base" ? " is on Base's clock and" : ", read on two providers,"} within 20 s of their read${c.headsAt === undefined ? "" : ` at ${c.headsAt}`}`);
  say(Number.isSafeInteger(c.decimals), `token decimals read on chain: ${show(c.decimals)}`);
  const sample = trades.trades.slice(0, SAMPLE);
  const keys = [];
  let matched = 0;
  for (const t of sample) {
    const r = c.receipts?.[t.tx];
    const name = `trade ${t.tx.slice(0, 10)}`;
    // two providers that answered with different receipts: judged by the pool's Swap leg on each, once the pool is known
    if (isObj(r) && Array.isArray(r.differ)) {
      keys.push(new Set((r.differ[0]?.logs ?? []).filter((l) => SWAP_TOPICS.includes(l.topics?.[0])).map((l) => poolKey(l, net))));
      continue;
    }
    if (!isObj(r)) {
      say(false, `${name}: no receipt on two agreeing providers`);
      continue;
    }
    say(r.status === "0x1", `${name}: the receipt succeeded`);
    const n = Number.parseInt(r.blockNumber, 16);
    say(Number.isSafeInteger(n) && Number.isSafeInteger(timeOf(n)) && timeOf(n) * 1000 === t.t_ms, `${name}: in block ${n}, whose ${net === "base" ? "Base clock time" : "time on two providers"} ${show(Number.isSafeInteger(n) ? timeOf(n) : null)} is the trade's ${t.t_ms / 1000}`);
    const swaps = (r.logs ?? []).filter((l) => SWAP_TOPICS.includes(l.topics?.[0]));
    keys.push(new Set(swaps.map((l) => poolKey(l, net))));
    const want = Number.isSafeInteger(c.decimals) ? units(t.amt, c.decimals) : null;
    const moves = (r.logs ?? []).filter((l) => l.address === run.coin && l.topics?.[0] === TOPIC.transfer && l.topics.length === 3 && want !== null && isAmount(l.data, want));
    t.moves = moves.map((l) => [topicAddr(l.topics[1]), topicAddr(l.topics[2])]);
    t.swapEmitters = swaps.map((l) => l.address);
  }
  // the pool: the one Swap-log key every sampled receipt holds; where they share more than one (each a route through
  // two pools of the token), the one with most swap transactions over the window, from each key's logs the run read
  // (card helper-live-run-green-after-122: live run 43250937996 took the first key of the first receipt, PENNY's 6%
  // side pool, though its other pool carried 44 of the 1,000 blocks' swaps to its 7)
  const common = keys.length === 0 ? [] : [...keys[0]].filter((k) => keys.every((s) => s.has(k)));
  const counted = common.length > 1 ? sharedCounts(c.shared, common) : null;
  const pool = counted === null ? common[0] : counted[0]?.key;
  say(common.length === 1 || (counted !== null && counted.length === common.length), `the sampled trades share a pool: ${show(common)}${common.length > 1 ? (counted !== null && counted.length === common.length ? `; judged on the busiest over the window, ${counted.map((x) => `${x.key} ${x.txs} swap transaction${x.txs === 1 ? "" : "s"}`).join(", ")}` : "; no swap count read for each of them") : ""}`);
  const poolAddr = pool === undefined ? null : pool.split(":")[0];
  const agreedReceipt = (t) => (isObj(c.receipts?.[t.tx]) && !Array.isArray(c.receipts[t.tx].differ) ? c.receipts[t.tx] : null);
  const v4 = pool !== undefined && poolAddr === VENUES[net].poolManager;
  const dec = Number.isSafeInteger(c.decimals) ? c.decimals : null;
  for (const t of sample) {
    const d = c.receipts?.[t.tx]?.differ;
    if (!Array.isArray(d)) continue;
    const [a, b] = d.map((r) => (v4 ? poolLegs(r, pool, net, t.side).map((x) => x.leg) : []));
    say(false, a.join() === b.join() ? `trade ${t.tx.slice(0, 10)}: the two providers' receipts differ` : `trade ${t.tx.slice(0, 10)}: this pool's Swap leg differs on the two providers: ${legText(a, dec)} on one, ${legText(b, dec)} on the other`);
  }
  // each trade's sender: the receipt's, or for a bundle the account whose operation ran the trade's swap of the pool
  for (const t of sample) {
    const r = agreedReceipt(t);
    if (r === null) continue;
    const { bundle, senders } = swapSenders(r, (l) => SWAP_TOPICS.includes(l.topics?.[0]) && (pool === undefined || poolKey(l, net) === pool));
    say(senders.includes(t.trader), `trade ${t.tx.slice(0, 10)}: sent by ${show(t.trader)}, ${bundle ? `the account of the user operation whose run holds its swap ${show(senders)} (a bundle to ${r.to}, sent by ${r.from})` : `the receipt's sender ${show(r.from)}`}`);
  }
  // a v4 trade: its amt is this pool's own Swap leg (the receipt two providers agreed on), less a hook's cut where its
  // sender's move of the token with the PoolManager is read (helper-v4-hook-liquidity's reading, judgeable). A route
  // whose sender swaps more than once nets the token inside the PoolManager: no Transfer is its trade's, so only the
  // Transfer match of a sender's one swap is asked
  const asked = [];
  let routed = 0;
  const pm = VENUES[net].poolManager;
  const used = new Map();
  for (const t of sample) {
    const r = agreedReceipt(t);
    if (r === null) continue;
    if (!v4) {
      asked.push(t);
      continue;
    }
    const name = `trade ${t.tx.slice(0, 10)}`;
    const want = dec === null ? null : units(t.amt, dec);
    const legs = poolLegs(r, pool, net, t.side).filter((x) => !(used.get(t.tx) ?? new Set()).has(x.i));
    const swaps4 = (r.logs ?? []).filter((l) => l.address === pm && l.topics?.[0] === TOPIC.swap4);
    // the pool's swap of the trade: the one whose leg less its cut is the amt, else the first, whose numbers the line names
    const takes = outsideTakes(r, run.coin, pm, swaps4);
    const judged = legs.map((x) => {
      const one = swaps4.filter((l) => topicAddr(l.topics?.[2]) === x.sender).length === 1;
      const m = one ? judgeable(r, run.coin, pm, t.side) : null;
      const move = m !== null && (m.sender === x.sender || swaps4.length === 1) ? (m.net < 0n ? -m.net : m.net) : null;
      // no move of its sender read (a route): the leg, or the leg less one take of the token out of the PoolManager by an
      // address that sent no swap (the hook's), exactly
      const off = want === null ? null : t.side === "b" ? x.leg - want : want - x.leg;
      const cut = move !== null ? (t.side === "b" ? x.leg - move : move - x.leg) : off !== null && off > 0n && takes.includes(off) ? off : 0n;
      return { ...x, one, move, cut, ok: want !== null && (move === null ? off === cut : cut >= 0n && want === move) };
    });
    const x = judged.find((j) => j.ok) ?? judged[0];
    if (x === undefined) {
      say(false, `${name}: no Swap of this pool ${t.side === "b" ? "paying out" : "taking in"} the token in its receipt`);
      continue;
    }
    if (x.ok) used.set(t.tx, (used.get(t.tx) ?? new Set()).add(x.i));
    if (x.one) asked.push(t);
    else routed++;
    const legT = legText([x.leg], dec);
    const many = x.one ? "" : ` (its sender's ${swaps4.filter((l) => topicAddr(l.topics?.[2]) === x.sender).length} swaps net the token in the PoolManager)`;
    const moved = x.move === null ? "" : legText([x.move], dec);
    if (x.ok) say(true, `${name}: amt ${t.amt} is this pool's Swap leg ${legT}${x.cut === 0n ? "" : ` less the hook's cut ${legText([x.cut], dec)}`}, read on two providers${x.move === null ? (x.cut === 0n ? "" : ": the cut a take of the token out of the PoolManager by an address that sent no swap") : ": what its sender, whose one swap this is, moved with the PoolManager"}${many}`);
    else if (x.move !== null && x.cut < 0n) say(false, `${name}: its sender's move of the token with the PoolManager, ${moved}, is ${t.side === "b" ? "more" : "less"} than this pool's Swap leg ${legT}, read on two providers`);
    else if (x.move !== null) say(false, `${name}: amt ${t.amt} is not the ${moved} its sender, whose one swap this is, moved with the PoolManager (a Transfer or claims of the token; this pool's Swap leg ${legT}, read on two providers)`);
    else say(false, `${name}: amt ${t.amt} is not this pool's Swap leg ${legT}, read on two providers, nor that leg less one take of the token out of the PoolManager by an address that sent no swap${many}`);
  }
  for (const t of asked) {
    // a buy: the pool (or the PoolManager) sends the token; a sell: it receives it. The token leg is exactly `amt`.
    const ok = poolAddr !== null && (t.moves ?? []).some(([from, to]) => (t.side === "b" ? from === poolAddr : to === poolAddr));
    if (ok) matched++;
    else lines.push(`--  trade ${t.tx.slice(0, 10)}: no Transfer of exactly ${t.amt} ${t.side === "b" ? "from" : "to"} the pool`);
  }
  const routedText = `${routed} routed v4 trade${routed === 1 ? "" : "s"} judged by the pool's Swap leg alone`;
  say(sample.length > 0 && matched * 2 >= asked.length, asked.length === 0 ? `no sampled trade is asked a Transfer of the token for its amt: ${routedText}` : `${matched} of ${asked.length} sampled trades carry a Transfer of the token for exactly their amt, ${show(asked.map((t) => t.side).join(""))} against the pool${routed === 0 ? "" : `; ${routedText}`}`);

  // no swap missing
  const pl = c.poolLogs;
  // the oldest trade's block: on Base its clock's. On Robinhood the read goes BACK blocks behind (its time read on two
  // providers) and each log carries its block's time, so a swap is due when its time is after the oldest trade's
  const oldestT = trades.trades.at(-1).t_ms;
  const oldestBlock = net === "base" ? blockOf(oldestT / 1000) : Infinity;
  const last = head - MARGIN[net];
  const timed = net === "base" || (isObj(pl) && Number.isSafeInteger(timeOf(pl.from)) && Array.isArray(pl.logs) && pl.logs.every((l) => Number.isSafeInteger(l.t)));
  say(isObj(pl) && pl.key === pool && pl.to === last && pl.from <= oldestBlock && Array.isArray(pl.logs) && timed, `the pool's Swap logs read on two agreeing providers over blocks ${show(pl?.from)} to ${show(pl?.to)}${net === "base" ? "" : `, from ${show(timeOf(pl?.from))} s, every log with its block time`}`);
  if (isObj(pl) && Array.isArray(pl.logs) && timed) {
    const onTape = new Set(trades.trades.map((t) => t.tx));
    const from = Math.max(pl.from, net === "base" ? oldestBlock + 1 : pl.from); // the oldest trade's block may hold more swaps than the tape
    const inWindow = (l) => Number.parseInt(l.blockNumber, 16) >= from && Number.parseInt(l.blockNumber, 16) <= last && (net === "base" || l.t * 1000 > oldestT);
    const due = [...new Set(pl.logs.filter(inWindow).map((l) => l.transactionHash))];
    const missing = due.filter((t) => !onTape.has(t));
    // the tape is full (50) when it covers fewer than 50 swaps on the window: a full tape's oldest rows are cut, not missing
    say(missing.length === 0, `${due.length} swap transaction${due.length === 1 ? "" : "s"} of the pool in blocks ${from} to ${last}${net === "base" ? "" : ` after the oldest trade's time`}, ${missing.length} missing from the tape${missing.length ? `: ${missing.slice(0, 3).join(", ")}` : ""}`);
  }
  return withReads(run, lines);
}

/** Each shared key's swap transactions over the run's window (c.shared: [{ key, from, to, logs }] as read() reads them),
 *  busiest first (ties: the order the keys came in), or null when the run read none; a key with no read is left out. */
export function sharedCounts(shared, keys) {
  if (!Array.isArray(shared)) return null;
  const out = [];
  for (const [i, key] of keys.entries()) {
    const s = shared.find((x) => isObj(x) && x.key === key && Array.isArray(x.logs));
    if (s !== undefined) out.push({ key, i, txs: new Set(s.logs.map((l) => l.transactionHash)).size });
  }
  return out.sort((a, b) => b.txs - a.txs || a.i - b.i).map(({ key, txs }) => ({ key, txs }));
}

/** The verdict, and on FAIL a line for each read the helper answered: status, time, Server-Timing. */
function withReads(run, lines) {
  const ok = lines.every((l) => l.startsWith("ok ") || l.startsWith("-- "));
  const verdict = !ok ? "FAIL" : lines.some((l) => l.startsWith("-- ") && l.endsWith(": INCONCLUSIVE")) ? "INCONCLUSIVE" : "PASS";
  if (!ok) {
    const st = (r) => `${r?.status ?? "none"}${waitsText(r)} in ${r?.ms ?? "?"} ms, Server-Timing ${show(r?.headers?.["server-timing"])}`;
    if (run.listsRead !== undefined) lines.push(`--  read: lists ${st(run.listsRead)}`);
    for (const t of run.tried ?? []) lines.push(`--  read: ${t.token} before it: candles ${st(t.candles)}${t.trades === undefined ? "" : `; trades ${st(t.trades)}`}`);
    for (const k of ["candles", "trades"]) if (run.reads?.[k] !== undefined) lines.push(`--  read: ${run.coin} ${k} ${st(run.reads[k])}`);
  }
  return { ok: verdict === "PASS", verdict, lines };
}

async function get(base, path, fetchFn) {
  // the read's own time, which its X-Fetched-At is judged against (freshAt)
  const at = new Date().toISOString();
  const t0 = performance.now();
  const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
  const headers = {};
  for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
  const body = await r.text();
  return { at, ms: Math.round(performance.now() - t0), status: r.status, headers, body };
}

/** One JSON-RPC call on one provider: the result, or undefined. */
async function single(method, params, fetchFn, url) {
  try {
    const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return r.status === 200 && isObj(j) && "result" in j ? j.result : undefined;
  } catch {
    return undefined;
  }
}

/** A head another provider just reported may be a block a provider does not hold yet (a null block): read again this
 *  often, this far apart (the wallet's EVM_LAG_TRIES and EVM_LAG_WAIT_MS), before its time is judged unknown. */
export const HEAD_TRIES = 5;
export const HEAD_WAIT_MS = 2_000;
const sleepMs = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** Block `n`'s time on the first two providers that hold it, which must agree: { ts }, or { behind: hosts } when fewer
 *  than two held it and those that answered null did not (read again `tries` times HEAD_WAIT_MS apart). Two that hold it
 *  and differ, or a provider giving no answer, are no time and name none: judged as before. */
export async function headTime(n, fetchFn, rpcs, tries = HEAD_TRIES, sleep = sleepMs) {
  let behind = [];
  for (let t = 1; t <= tries; t++) {
    const got = [];
    behind = [];
    for (const url of rpcs) {
      const b = await single("eth_getBlockByNumber", [hex(n), false], fetchFn, url);
      if (b === null) behind.push(new URL(url).host);
      else if (isObj(b) && typeof b.timestamp === "string") got.push(b.timestamp);
      if (got.length === 2) break;
    }
    if (got.length === 2) return got[0] === got[1] ? { ts: got[0], behind: [] } : { behind: [] };
    if (behind.length === 0) return { behind: [] };
    if (t < tries) await sleep(HEAD_WAIT_MS);
  }
  return { behind };
}

/** One JSON-RPC call on the first two providers that answer, which must agree on the result: the result, or null; with
 *  `both`, two that answered and differ are `{ differ: [a, b] }`, each answer's `pick`. */
async function agreed(method, params, fetchFn, rpcs = SWAP_RPCS.base, pick = (x) => x, both = false) {
  const got = [];
  for (const url of rpcs) {
    try {
      const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (r.status === 200 && isObj(j) && "result" in j) got.push(JSON.stringify(j.result === null ? null : pick(j.result)));
    } catch {
      // the next provider
    }
    if (got.length === 2) break;
  }
  if (got.length === 2 && got[0] !== got[1] && both && !got.includes("null")) return { differ: got.map((g) => JSON.parse(g)) };
  return got.length === 2 && got[0] === got[1] ? JSON.parse(got[0]) : null;
}

/** `reader`: the run's candles reader (candles-read.mjs): a 429 is read again at its Retry-After, as the page reads it. */
export async function read(base = BASE, token, fetchFn = fetch, rpcs, net = "base", reader = candlesReader(), sleep = sleepMs) {
  rpcs ??= SWAP_RPCS[net];
  const readAt = new Date().toISOString();
  let candidates = token === undefined ? [] : [token];
  /** Each read the helper answered before the judged token's, for the FAIL lines (withReads). */
  let listsRead;
  const tried = [];
  const seen = (r) => ({ status: r.status, ms: r.ms, headers: { "server-timing": r.headers["server-timing"] }, ...(r.waits === undefined ? {} : { waits: r.waits }) });
  if (token === undefined) {
    const l = await get(base, LISTS_PATH(net), fetchFn);
    listsRead = seen(l);
    let snap;
    try {
      snap = JSON.parse(l.body);
    } catch {}
    // a lists answer that is not a 200 with lists (card app-console-429: robinhood's 503 at 11:03:50Z crashed the check
    // with exit 2) is the run's answer, which judge() names as a BAD line with the chain and the status
    if (l.status !== 200 || !isObj(snap) || !isObj(snap.lists) || !Object.values(snap.lists).every(Array.isArray)) {
      return { base, ...(net === "base" ? {} : { net }), coin: null, readAt, lists: { path: LISTS_PATH(net), status: l.status, body: l.body.slice(0, 500) }, listsRead, reads: {}, chain: {} };
    }
    candidates = [...new Set(Object.values(snap.lists).flatMap((rows) => rows.map((r) => r?.token)).filter((t) => typeof t === "string"))];
  }
  // the first listed token with trades to check (a listed token with no pool our reads find answers an empty 200); else
  // the first that answered, whose empty tape the check then fails, never a pass
  let reads;
  let quiet;
  for (const t of candidates.slice(0, 12)) {
    const candles = await reader.read(() => get(base, CANDLES_PATH(t, net), fetchFn));
    // a chart still filling (a cold book past the helper's open bound: no bars yet) is passed over as a failed one is
    if (candles.status !== 200 || /"filling":true/.test(candles.body ?? "")) {
      tried.push({ token: t, candles: seen(candles) });
      continue;
    }
    const r = { token: t, candles, trades: await get(base, TRADES_PATH(t, net), fetchFn) };
    let n = 0;
    try {
      n = r.trades.status === 200 ? JSON.parse(r.trades.body).trades.length : 0;
    } catch {}
    if (n > 0) {
      reads = r;
      break;
    }
    tried.push({ token: t, candles: seen(r.candles), trades: seen(r.trades) });
    quiet ??= r;
  }
  reads ??= quiet;
  // the reads before the judged one (the quiet token judged is not one of them)
  const before = tried.filter((x) => x.token !== reads?.token);
  const at = { ...(net === "base" ? {} : { net }), ...(listsRead === undefined ? {} : { listsRead }), ...(before.length === 0 ? {} : { tried: before }) };
  if (reads === undefined) {
    // the first candidate's answers, so a run that found none shows why
    const t0 = candidates[0];
    const r = t0 === undefined ? {} : { candles: await reader.read(() => get(base, CANDLES_PATH(t0, net), fetchFn)), trades: await get(base, TRADES_PATH(t0, net), fetchFn) };
    return { base, ...at, coin: t0 ?? null, readAt, reads: r, chain: {} };
  }
  const t = reads.token;
  const run = { base, ...at, coin: t, readAt, reads: { candles: reads.candles, trades: reads.trades }, chain: {} };
  let tape;
  try {
    tape = JSON.parse(reads.trades.body).trades.slice(0, SAMPLE);
  } catch {
    return run;
  }
  const heads = [];
  for (const url of rpcs.slice(0, 4)) {
    if (heads.length === 2) break;
    const n = await single("eth_blockNumber", [], fetchFn, url);
    if (typeof n === "string") heads.push(Number.parseInt(n, 16));
  }
  run.chain.heads = heads;
  run.chain.headsAt = new Date().toISOString();
  const dec = await agreed("eth_call", [{ to: t, data: "0x313ce567" }, "latest"], fetchFn, rpcs);
  run.chain.decimals = typeof dec === "string" && /^0x[0-9a-f]{64}$/.test(dec) ? Number.parseInt(dec, 16) : null;
  run.chain.receipts = {};
  // two providers' receipts that differ are both kept, so the check names how (the pool's Swap leg, or else)
  for (const tr of tape) run.chain.receipts[tr.tx] = await agreed("eth_getTransactionReceipt", [tr.tx], fetchFn, rpcs, receiptOf, true);
  // the pool: the Swap-log key every sampled receipt holds, then its logs over the blocks the tape covers
  const keys = tape.map((tr) => new Set((one(run.chain.receipts[tr.tx])?.logs ?? []).filter((l) => SWAP_TOPICS.includes(l.topics?.[0])).map((l) => poolKey(l, net))));
  const common = keys.length === 0 ? [] : [...keys[0]].filter((k) => keys.every((s) => s.has(k)));
  run.chain.poolLogs = null;
  if (common.length > 0 && heads.length === 2) {
    const last = Math.min(...heads) - MARGIN[net];
    const oldest = net === "base" ? blockOf(JSON.parse(reads.trades.body).trades.at(-1).t_ms / 1000) : -Infinity;
    const from = Math.max(oldest - 1, last - BACK[net]);
    // on Robinhood each log's time is part of what two providers must agree on, so only providers that log it pair:
    // the chain's own RPC logs blockTimestamp 0x0 (HEADER_TIMED) and, second in SWAP_RPCS, never agreed with the first
    // on a span with a swap (card helper-restart-fresh: live run 41871356171, "blocks none to none")
    const logRpcs = net === "base" ? rpcs : rpcs.filter((u) => !HEADER_TIMED.has(u));
    /** One shared key's Swap logs over the window, on two agreeing providers; null when a span was not agreed. */
    const poolLogsOf = async (pool) => {
      const [address, id] = pool.split(":");
      const topic0 = (one(run.chain.receipts[tape[0].tx]).logs ?? []).find((l) => poolKey(l, net) === pool).topics[0];
      const topics = id === undefined ? [topic0 === TOPIC.curveBuy || topic0 === TOPIC.curveSell ? [TOPIC.curveBuy, TOPIC.curveSell] : topic0] : [TOPIC.swap4, id];
      const all = [];
      for (let lo = from; lo <= last; lo += SPAN[net]) {
        const logs = await agreed("eth_getLogs", [{ address, topics, fromBlock: hex(lo), toBlock: hex(Math.min(last, lo + SPAN[net] - 1)) }], fetchFn, logRpcs, (ls) => ls.map((l) => ({ blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex, ...(net === "base" ? {} : { t: Number.parseInt(l.blockTimestamp, 16) }) })));
        if (!Array.isArray(logs)) return null;
        all.push(...logs);
      }
      return { key: pool, from, to: last, logs: all.map((l) => ({ blockNumber: l.blockNumber, transactionHash: l.transactionHash, ...(net === "base" ? {} : { t: l.t }) })) };
    };
    if (common.length === 1) run.chain.poolLogs = await poolLogsOf(common[0]);
    else {
      // more than one shared key: each one's logs (SHARED_MAX at most), so judge() takes the busiest
      run.chain.shared = [];
      for (const k of common.slice(0, SHARED_MAX)) {
        const got = await poolLogsOf(k);
        if (got !== null) run.chain.shared.push(got);
      }
      const busiest = sharedCounts(run.chain.shared, common)?.[0]?.key;
      run.chain.poolLogs = run.chain.shared.find((x) => x.key === busiest) ?? null;
    }
  }
  if (net !== "base") {
    // the block times the check needs: the heads', the sampled trades', and the pool read's first block
    const ns = new Set([...heads, ...Object.values(run.chain.receipts).map(one).filter(isObj).map((r) => Number.parseInt(r.blockNumber, 16)), ...(run.chain.poolLogs ? [run.chain.poolLogs.from] : [])]);
    run.chain.blockTimes = {};
    for (const n of ns) {
      const got = await headTime(n, fetchFn, rpcs, heads.includes(n) ? HEAD_TRIES : 1, sleep);
      if (typeof got.ts === "string") run.chain.blockTimes[n] = Number.parseInt(got.ts, 16);
      else if (got.behind.length > 0 && heads.includes(n)) (run.chain.behind ??= {})[n] = got.behind;
    }
  }
  return run;
}

/** A receipt as read: two providers' that differ, the first's. */
const one = (r) => (Array.isArray(r?.differ) ? r.differ[0] : r);
/** What the check reads of a receipt, the same on every provider (their extra fields differ). */
const receiptOf = (r) => ({ status: r.status, blockNumber: r.blockNumber, from: r.from, to: r.to, logs: (r.logs ?? []).map((l) => ({ address: l.address, topics: l.topics, data: l.data })) });

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    // no --chain: both chains, as the deployed helper's runs ask it (scripts/ci/helper-live-checks.mjs passes no args)
    const nets = a.includes("--chain") ? [opt("--chain")] : ["base", "robinhood"];
    if (!nets.every((n) => ["base", "robinhood"].includes(n))) throw new Error(`--chain ${nets}: base or robinhood`);
    if (nets.length > 1 && opt("--token")) throw new Error("--token needs --chain");
    let all = true;
    let quiet = false;
    for (const net of nets) {
      const run = await read(base, opt("--token"), fetch, undefined, net);
      if (opt("--record")) writeFileSync(nets.length > 1 ? opt("--record").replace(/(\.json)?$/, `.${net}.json`) : opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
      const { ok, verdict, lines } = judge(run);
      quiet ||= verdict === "INCONCLUSIVE";
      for (const l of lines) console.log(`${nets.length > 1 ? `[${net}] ` : ""}${l}`);
      console.log(`first reads (${net} ${run.coin}): candles ${run.reads.candles?.ms} ms, trades ${run.reads.trades?.ms} ms`);
      const n = Number(opt("--speed", "0"));
      if (n > 0 && run.coin) {
        const ms = [];
        for (let i = 0; i < n; i++) ms.push((await get(base, CANDLES_PATH(run.coin, net), fetch)).ms);
        console.log(`speed (${net}): ${n} candle reads, p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms, max ${Math.max(...ms)} ms`);
      }
      all &&= ok || verdict === "INCONCLUSIVE";
    }
    const v = !all ? "FAIL" : quiet ? "INCONCLUSIVE" : "PASS";
    console.log(`live-check ${KEY}: ${v} (${base}, ${nets.join(" and ")})`);
    process.exit({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3 }[v]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
