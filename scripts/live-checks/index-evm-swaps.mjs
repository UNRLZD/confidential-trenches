#!/usr/bin/env node
// Live check of cards index-evm-swaps and index-evm-swaps-2: a Base or Robinhood token's candles and trade tape come
// from the helper's own chain reads
// (apps/helper/src/data/evm/swaps.ts, candles.ts), and the chain agrees with them. It reads one listed Base token at
// HELPER_HOST with Origin APP_HOST (--token for a given one; otherwise the first token of the Base Discover lists whose
// candles answer 200):
//   GET /v1/market/candles?chain=base&token=<t>&tf=1m&limit=60
//   GET /v1/market/trades?chain=base&token=<t>&limit=50
// and passes only when:
//   - each answers 200 JSON with X-Helper-Commit a full sha, X-Fetched-At an ISO time within 15 s of the read and
//     Access-Control-Allow-Origin echoing APP_HOST; X-Helper-Source is "chain" (our own reads) for the tape, and for the
//     candles "chain" or "chain,geckoterminal" (the vendor only before our first bar);
//   - candles hold exactly the frozen fields tf, candles, src, own_from_s, as_of_ms; bars [t_s, o, h, l, c, vol_usd] on
//     the 1m grid, oldest first, USD decimal strings, high >= open, close >= low, bars from our own reads start at
//     own_from_s; the trades hold exactly trades, src, as_of_ms, each {t_ms, side, usd, amt, trader, tx}, newest first;
//   - the newest trades are on chain (RPC: SWAP_RPCS, two providers that agree on every answer): each receipt succeeded,
//     sits in the block whose Base clock time is the trade's, was sent by the trade's trader, and carries a Transfer of
//     the token for exactly `amt` to the pool (a sell) or from it (a buy), the pool being the emitter of the Swap log
//     every sampled receipt shares;
//   - no swap is missing: every swap of that pool in the blocks the tape covers, up to 12 blocks (24 s) behind the
//     providers' newest, is on the tape.
// On Robinhood (--chain robinhood), which has no fixed block clock, a trade's time must be its block's own time and the
// providers' newest block's time within 20 s of the read, each block time read on two providers that agree; its swaps
// include the Pons v2 curve's CurveBuy and CurveSell, and its pool's logs are read in the 100-block spans its keyless
// providers take.
//   node scripts/live-checks/index-evm-swaps.mjs [--chain base|robinhood] [--base <url>] [--token <0x..>] [--record <file>] [--speed <n>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes the run (every answer read).
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { BLOCK_CLOCK } from "../../apps/helper/src/data/evm/lists.ts";
import { SWAP_RPCS, TOPIC, VENUES } from "../../apps/helper/src/data/evm/swaps.ts";

const KEY = "index-evm-swaps";
export const BASE = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
export const SAMPLE = 5;
/** Blocks behind the providers' newest a swap must be on the tape by: 24 s on Base, 6 s on Robinhood. */
export const MARGIN = { base: 12, robinhood: 60 };
export const MARGIN_BLOCKS = MARGIN.base;
/** The most blocks one pool-log read asks (the chain's keyless providers' widest), and how far back the read goes. */
const SPAN = { base: 1000, robinhood: 100 };
const BACK = { base: 1000, robinhood: 1000 };
const LAG = { base: 10, robinhood: 50 };
const CLOCK = BLOCK_CLOCK.base;
const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const DEC = /^\d+(\.\d+)?$/;
const ADDR = /^0x[0-9a-f]{40}$/;
const TX = /^0x[0-9a-f]{64}$/;
const SWAP_TOPICS = [TOPIC.swap2, TOPIC.swap3, TOPIC.swap4, TOPIC.curveBuy, TOPIC.curveSell];
export const CANDLES_PATH = (t, net = "base") => `/v1/market/candles?chain=${net}&token=${t}&tf=1m&limit=60`;
export const TRADES_PATH = (t, net = "base") => `/v1/market/trades?chain=${net}&token=${t}&limit=50`;
const LISTS_PATH = (net) => `/v1/market/lists?chain=${net}`;

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const blockTime = (n) => CLOCK.genesisS + CLOCK.blockS * n;
const blockOf = (s) => Math.floor((s - CLOCK.genesisS) / CLOCK.blockS);
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

/**
 * The check on one run: { base, coin, readAt, reads: { candles, trades }, chain }, where chain is what `read` took from
 * the providers: { heads: [n..], decimals, receipts: { [tx]: receipt | null }, poolLogs: { key, from, to, logs } | null }.
 */
export function judge(run) {
  const net = run.net ?? "base";
  // a block's time: Base's clock; Robinhood's own, read on two agreeing providers (run.chain.blockTimes)
  const timeOf = (n) => (net === "base" ? blockTime(n) : run.chain?.blockTimes?.[n] ?? null);
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
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
    const at = Date.parse(h["x-fetched-at"] ?? "");
    say(ISO.test(h["x-fetched-at"] ?? "") && Math.abs(readAt - at) <= 15_000, `${k} X-Fetched-At: ${show(h["x-fetched-at"])}, within 15 s of the read at ${run.readAt}`);
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
  if (candles === undefined || trades === undefined) return { ok: false, lines };

  const c = run.chain ?? {};
  const heads = Array.isArray(c.heads) ? c.heads : [];
  say(heads.length === 2 && heads.every(Number.isSafeInteger) && Math.abs(heads[0] - heads[1]) <= LAG[net], `the chain: two providers' newest blocks ${show(heads)}`);
  const head = Math.min(...heads);
  say(c.heads?.every((n) => Number.isSafeInteger(timeOf(n)) && Math.abs(timeOf(n) - readAt / 1000) <= 20), `the providers' newest block's time${net === "base" ? " is on Base's clock and" : ", read on two providers,"} within 20 s of the read`);
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
    say(t.trader === r.from, `${name}: sent by ${show(t.trader)}, the receipt's sender ${show(r.from)}`);
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
  return { ok: lines.every((l) => l.startsWith("ok ") || l.startsWith("-- ")), lines };
}

async function get(base, path, fetchFn) {
  const t0 = performance.now();
  const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
  const headers = {};
  for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
  const body = await r.text();
  return { ms: Math.round(performance.now() - t0), status: r.status, headers, body };
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
  if (token === undefined) {
    const l = await get(base, LISTS_PATH(net), fetchFn);
    const snap = JSON.parse(l.body);
    candidates = [...new Set(Object.values(snap.lists).flatMap((rows) => rows.map((r) => r.token)))];
  }
  let reads;
  for (const t of candidates.slice(0, 12)) {
    const candles = await get(base, CANDLES_PATH(t, net), fetchFn);
    if (candles.status !== 200) continue;
    reads = { token: t, candles, trades: await get(base, TRADES_PATH(t, net), fetchFn) };
    break;
  }
  const at = net === "base" ? {} : { net };
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
    for (let lo = from; lo <= last; lo += SPAN[net]) {
      const logs = await agreed("eth_getLogs", [{ address, topics, fromBlock: hex(lo), toBlock: hex(Math.min(last, lo + SPAN[net] - 1)) }], fetchFn, rpcs, (ls) => ls.map((l) => ({ blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex, ...(net === "base" ? {} : { t: Number.parseInt(l.blockTimestamp, 16) }) })));
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
const receiptOf = (r) => ({ status: r.status, blockNumber: r.blockNumber, from: r.from, logs: (r.logs ?? []).map((l) => ({ address: l.address, topics: l.topics, data: l.data })) });

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const net = opt("--chain", "base");
    if (!["base", "robinhood"].includes(net)) throw new Error(`--chain ${net}: base or robinhood`);
    const run = await read(base, opt("--token"), fetch, undefined, net);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`first reads (${run.coin}): candles ${run.reads.candles?.ms} ms, trades ${run.reads.trades?.ms} ms`);
    const n = Number(opt("--speed", "0"));
    if (n > 0 && run.coin) {
      const ms = [];
      for (let i = 0; i < n; i++) ms.push((await get(base, CANDLES_PATH(run.coin, net), fetch)).ms);
      console.log(`speed: ${n} candle reads, p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms, max ${Math.max(...ms)} ms`);
    }
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
