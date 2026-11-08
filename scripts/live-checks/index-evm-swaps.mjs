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
//     candles "chain" or "chain,geckoterminal" (the vendor only before our first bar);
//   - candles hold exactly the frozen fields tf, candles, src, own_from_s, as_of_ms; bars [t_s, o, h, l, c, vol_usd] on
//     the 1m grid, oldest first, USD decimal strings, high >= open, close >= low, bars from our own reads start at
//     own_from_s; the trades hold exactly trades, src, as_of_ms, each {t_ms, side, usd, amt, trader, tx}, newest first;
//   - the newest trades are on chain (RPC: SWAP_RPCS, two providers that agree on every answer): each receipt succeeded,
//     sits in the block whose Base clock time is the trade's, was sent by the trade's trader (for a bundle sent to an
//     ERC-4337 EntryPoint, the account of the user operation whose run holds the trade's swap, read from the receipt
//     here, never the helper's code), and carries a Transfer of
//     the token for exactly `amt` to the pool (a sell) or from it (a buy), the pool being the emitter of the Swap log
//     every sampled receipt shares;
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
//   node scripts/live-checks/index-evm-swaps.mjs [--chain base|robinhood] [--base <url>] [--token <0x..>] [--record <file>] [--speed <n>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes the run (every answer read).
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { BLOCK_CLOCK, blockAt } from "../../apps/helper/src/data/evm/lists.ts";
import { HEADER_TIMED, SWAP_RPCS, TOPIC, VENUES } from "../../apps/helper/src/data/evm/swaps.ts";

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

/** The first thing wrong with a Candles answer, or null. */
export function candlesFault(c) {
  if (!isObj(c) || !same(Object.keys(c), ["tf", "candles", "src", "own_from_s", "as_of_ms"])) return `keys ${show(isObj(c) ? Object.keys(c) : c)}`;
  if (c.tf !== "1m" || !["chain", "chain,geckoterminal"].includes(c.src) || !Number.isSafeInteger(c.as_of_ms)) return `tf ${show(c.tf)}, src ${show(c.src)}`;
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
  if (!isObj(t) || !same(Object.keys(t), ["trades", "src", "as_of_ms"])) return `keys ${show(isObj(t) ? Object.keys(t) : t)}`;
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
    ["candles", candlesFault, CANDLES_PATH(run.coin, net), ["chain", "chain,geckoterminal"]],
    ["trades", tradesFault, TRADES_PATH(run.coin, net), ["chain"]],
  ]) {
    const r = run.reads?.[k] ?? { status: 0, headers: {}, body: "" };
    const h = r.headers ?? {};
    say(r.status === 200, `GET ${path} answers ${r.status}`);
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
  say(c.heads?.every((n) => Number.isSafeInteger(timeOf(n)) && Math.abs(timeOf(n) - headsAt / 1000) <= 20), `the providers' newest block's time${net === "base" ? " is on Base's clock and" : ", read on two providers,"} within 20 s of their read${c.headsAt === undefined ? "" : ` at ${c.headsAt}`}`);
  say(Number.isSafeInteger(c.decimals), `token decimals read on chain: ${show(c.decimals)}`);
  const sample = trades.trades.slice(0, SAMPLE);
  const keys = [];
  let matched = 0;
  for (const t of sample) {
    const r = c.receipts?.[t.tx];
    const name = `trade ${t.tx.slice(0, 10)}`;
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
  // the pool: the one Swap-log key every sampled receipt holds
  const common = keys.length === 0 ? [] : [...keys[0]].filter((k) => keys.every((s) => s.has(k)));
  say(common.length >= 1, `the sampled trades share a pool: ${show(common)}`);
  const pool = common[0];
  const poolAddr = pool === undefined ? null : pool.split(":")[0];
  // each trade's sender: the receipt's, or for a bundle the account whose operation ran the trade's swap of the pool
  for (const t of sample) {
    const r = c.receipts?.[t.tx];
    if (!isObj(r)) continue;
    const { bundle, senders } = swapSenders(r, (l) => SWAP_TOPICS.includes(l.topics?.[0]) && (pool === undefined || poolKey(l, net) === pool));
    say(senders.includes(t.trader), `trade ${t.tx.slice(0, 10)}: sent by ${show(t.trader)}, ${bundle ? `the account of the user operation whose run holds its swap ${show(senders)} (a bundle to ${r.to}, sent by ${r.from})` : `the receipt's sender ${show(r.from)}`}`);
  }
  for (const t of sample) {
    // a buy: the pool (or the PoolManager) sends the token; a sell: it receives it. The token leg is exactly `amt`.
    const ok = poolAddr !== null && (t.moves ?? []).some(([from, to]) => (t.side === "b" ? from === poolAddr : to === poolAddr));
    if (ok) matched++;
    else if (c.receipts?.[t.tx]) lines.push(`--  trade ${t.tx.slice(0, 10)}: no Transfer of exactly ${t.amt} ${t.side === "b" ? "from" : "to"} the pool (a token with a fee on transfer moves less)`);
  }
  say(sample.length > 0 && matched * 2 >= sample.length, `${matched} of ${sample.length} sampled trades carry a Transfer of the token for exactly their amt, ${show(sample.map((t) => t.side).join(""))} against the pool`);

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

/** The verdict, and on FAIL a line for each read the helper answered: status, time, Server-Timing. */
function withReads(run, lines) {
  const ok = lines.every((l) => l.startsWith("ok ") || l.startsWith("-- "));
  if (!ok) {
    const st = (r) => `${r?.status ?? "none"} in ${r?.ms ?? "?"} ms, Server-Timing ${show(r?.headers?.["server-timing"])}`;
    if (run.listsRead !== undefined) lines.push(`--  read: lists ${st(run.listsRead)}`);
    for (const t of run.tried ?? []) lines.push(`--  read: ${t.token} before it: candles ${st(t.candles)}${t.trades === undefined ? "" : `; trades ${st(t.trades)}`}`);
    for (const k of ["candles", "trades"]) if (run.reads?.[k] !== undefined) lines.push(`--  read: ${run.coin} ${k} ${st(run.reads[k])}`);
  }
  return { ok, lines };
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

/** One JSON-RPC call on the first two providers that answer, which must agree on the result: the result, or null. */
async function agreed(method, params, fetchFn, rpcs = SWAP_RPCS.base, pick = (x) => x) {
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
  return got.length === 2 && got[0] === got[1] ? JSON.parse(got[0]) : null;
}

export async function read(base = BASE, token, fetchFn = fetch, rpcs, net = "base") {
  rpcs ??= SWAP_RPCS[net];
  const readAt = new Date().toISOString();
  let candidates = token === undefined ? [] : [token];
  /** Each read the helper answered before the judged token's, for the FAIL lines (withReads). */
  let listsRead;
  const tried = [];
  const seen = (r) => ({ status: r.status, ms: r.ms, headers: { "server-timing": r.headers["server-timing"] } });
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
    const candles = await get(base, CANDLES_PATH(t, net), fetchFn);
    if (candles.status !== 200) {
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
    const r = t0 === undefined ? {} : { candles: await get(base, CANDLES_PATH(t0, net), fetchFn), trades: await get(base, TRADES_PATH(t0, net), fetchFn) };
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
  for (const tr of tape) run.chain.receipts[tr.tx] = await agreed("eth_getTransactionReceipt", [tr.tx], fetchFn, rpcs, receiptOf);
  // the pool: the Swap-log key every sampled receipt holds, then its logs over the blocks the tape covers
  const keys = tape.map((tr) => new Set((run.chain.receipts[tr.tx]?.logs ?? []).filter((l) => SWAP_TOPICS.includes(l.topics?.[0])).map((l) => poolKey(l, net))));
  const pool = keys.length === 0 ? undefined : [...keys[0]].find((k) => keys.every((s) => s.has(k)));
  run.chain.poolLogs = null;
  if (pool !== undefined && heads.length === 2) {
    const last = Math.min(...heads) - MARGIN[net];
    const [address, id] = pool.split(":");
    const oldest = net === "base" ? blockOf(JSON.parse(reads.trades.body).trades.at(-1).t_ms / 1000) : -Infinity;
    const from = Math.max(oldest - 1, last - BACK[net]);
    const topic0 = (run.chain.receipts[tape[0].tx].logs ?? []).find((l) => poolKey(l, net) === pool).topics[0];
    const topics = id === undefined ? [topic0 === TOPIC.curveBuy || topic0 === TOPIC.curveSell ? [TOPIC.curveBuy, TOPIC.curveSell] : topic0] : [TOPIC.swap4, id];
    const all = [];
    // on Robinhood each log's time is part of what two providers must agree on, so only providers that log it pair:
    // the chain's own RPC logs blockTimestamp 0x0 (HEADER_TIMED) and, second in SWAP_RPCS, never agreed with the first
    // on a span with a swap (card helper-restart-fresh: live run 41871356171, "blocks none to none")
    const logRpcs = net === "base" ? rpcs : rpcs.filter((u) => !HEADER_TIMED.has(u));
    for (let lo = from; lo <= last; lo += SPAN[net]) {
      const logs = await agreed("eth_getLogs", [{ address, topics, fromBlock: hex(lo), toBlock: hex(Math.min(last, lo + SPAN[net] - 1)) }], fetchFn, logRpcs, (ls) => ls.map((l) => ({ blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex, ...(net === "base" ? {} : { t: Number.parseInt(l.blockTimestamp, 16) }) })));
      if (!Array.isArray(logs)) {
        all.length = 0;
        all.push(null);
        break;
      }
      all.push(...logs);
    }
    if (!all.includes(null)) run.chain.poolLogs = { key: pool, from, to: last, logs: all.map((l) => ({ blockNumber: l.blockNumber, transactionHash: l.transactionHash, ...(net === "base" ? {} : { t: l.t }) })) };
  }
  if (net !== "base") {
    // the block times the check needs: the heads', the sampled trades', and the pool read's first block
    const ns = new Set([...heads, ...Object.values(run.chain.receipts).filter(isObj).map((r) => Number.parseInt(r.blockNumber, 16)), ...(run.chain.poolLogs ? [run.chain.poolLogs.from] : [])]);
    run.chain.blockTimes = {};
    for (const n of ns) {
      const ts = await agreed("eth_getBlockByNumber", [hex(n), false], fetchFn, rpcs, (b) => b.timestamp);
      if (typeof ts === "string") run.chain.blockTimes[n] = Number.parseInt(ts, 16);
    }
  }
  return run;
}

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
    for (const net of nets) {
      const run = await read(base, opt("--token"), fetch, undefined, net);
      if (opt("--record")) writeFileSync(nets.length > 1 ? opt("--record").replace(/(\.json)?$/, `.${net}.json`) : opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
      const { ok, lines } = judge(run);
      for (const l of lines) console.log(`${nets.length > 1 ? `[${net}] ` : ""}${l}`);
      console.log(`first reads (${net} ${run.coin}): candles ${run.reads.candles?.ms} ms, trades ${run.reads.trades?.ms} ms`);
      const n = Number(opt("--speed", "0"));
      if (n > 0 && run.coin) {
        const ms = [];
        for (let i = 0; i < n; i++) ms.push((await get(base, CANDLES_PATH(run.coin, net), fetch)).ms);
        console.log(`speed (${net}): ${n} candle reads, p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms, max ${Math.max(...ms)} ms`);
      }
      all &&= ok;
    }
    console.log(`live-check ${KEY}: ${all ? "PASS" : "FAIL"} (${base}, ${nets.join(" and ")})`);
    process.exit(all ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
