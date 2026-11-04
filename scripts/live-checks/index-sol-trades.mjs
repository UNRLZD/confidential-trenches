#!/usr/bin/env node
// Live check of card index-sol-trades: a listed Solana token's trade tape and 1s candles come from the helper's own
// chain reads (apps/helper/src/data/solana/trades.ts, decode.ts) and a fresh trade reaches them within 2 s. It reads the
// Solana Discover lists at HELPER_HOST (Origin APP_HOST), opens the tape of the first OPEN listed tokens, and watches the
// same tokens itself on Solana's public websocket (logsSubscribe, confirmed). The first trade it decodes from the venue's
// own event (pump.fun curve or PumpSwap) is the fresh trade: from the moment the check holds it, it reads
//   GET /v1/market/trades?chain=solana&token=<t>&limit=50   (every POLL_MS, up to WAIT_MS)
//   GET /v1/market/candles?chain=solana&token=<t>&tf=1s&limit=60
// and passes only when:
//   - each answers 200 JSON with X-Helper-Commit a full sha, X-Helper-Source "chain", X-Fetched-At an ISO time within
//     15 s of the read and Access-Control-Allow-Origin echoing APP_HOST; the trades hold exactly trades, src, as_of_ms,
//     each {t_ms, side, usd, amt, trader, tx}, newest first;
//   - the fresh trade's signature is on the tape in a read that answered within 2 s of the check holding the trade, with
//     its side, its time (the event's clock) and its trader (the event's user);
//   - the 1s candles hold a bar at the trade's second with a volume above 0.
//   node scripts/live-checks/index-sol-trades.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { fromLogs, poolMints, PUMP_AMM, USDC, WSOL } from "../../apps/helper/src/data/solana/decode.ts";

const KEY = "index-sol-trades";
export const BASE = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
export const WS = "wss://api.mainnet-beta.solana.com";
const RPC = "https://api.mainnet-beta.solana.com";
export const FRESH_MS = 2_000;
const OPEN = 8;
const POLL_MS = 200;
const WAIT_MS = 90_000;
const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const DEC = /^\d+(\.\d+)?$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;
export const TRADES_PATH = (t) => `/v1/market/trades?chain=solana&token=${t}&limit=50`;
export const CANDLES_PATH = (t) => `/v1/market/candles?chain=solana&token=${t}&tf=1s&limit=60`;
const LISTS_PATH = "/v1/market/lists?chain=solana";

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** The first thing wrong with a Trades answer, or null. */
export function tradesFault(t) {
  if (!isObj(t) || !same(Object.keys(t), ["trades", "src", "as_of_ms"])) return `keys ${show(isObj(t) ? Object.keys(t) : t)}`;
  if (t.src !== "chain" || !Number.isSafeInteger(t.as_of_ms)) return `src ${show(t.src)}`;
  if (!Array.isArray(t.trades) || t.trades.length > 50) return "trades not a list of at most 50";
  for (const [i, r] of t.trades.entries()) {
    if (!isObj(r) || !same(Object.keys(r), ["t_ms", "side", "usd", "amt", "trader", "tx"])) return `trade ${i} keys ${show(isObj(r) ? Object.keys(r) : r)}`;
    if (!Number.isSafeInteger(r.t_ms) || r.t_ms % 1000 !== 0 || !["b", "s"].includes(r.side) || !DEC.test(r.usd) || !DEC.test(r.amt) || !B58.test(r.tx) || !(r.trader === null || B58.test(r.trader))) return `trade ${i} ${show(r)}`;
    if (i > 0 && r.t_ms > t.trades[i - 1].t_ms) return `trade ${i} is newer than trade ${i - 1}`;
  }
  return null;
}

/** The checks on one recorded answer's headers and body; returns the parsed body or undefined. */
function answer(say, name, r, readAtMs) {
  const h = r?.headers ?? {};
  say(r?.status === 200, `${name} answers ${r?.status}`);
  if (r?.status !== 200) return undefined;
  say(SHA.test(h["x-helper-commit"] ?? ""), `${name} X-Helper-Commit: ${show(h["x-helper-commit"])}`);
  say(h["x-helper-source"] === "chain", `${name} X-Helper-Source: ${show(h["x-helper-source"])}, our own chain reads`);
  const at = Date.parse(h["x-fetched-at"] ?? "");
  say(ISO.test(h["x-fetched-at"] ?? "") && Math.abs(readAtMs - at) <= 15_000, `${name} X-Fetched-At: ${show(h["x-fetched-at"])}, within 15 s of the read`);
  say(h["access-control-allow-origin"] === APP, `${name} Access-Control-Allow-Origin: ${show(h["access-control-allow-origin"])}`);
  try {
    return JSON.parse(r.body);
  } catch {
    say(false, `${name}: not JSON`);
    return undefined;
  }
}

/**
 * The check on one run: { base, coin, fresh: { sig, heldAtMs, side, ts, user }, polls: [{ atMs, answeredMs, status,
 * headers, body }], candles: { atMs, status, headers, body } }.
 */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const f = run.fresh;
  if (!isObj(f) && Array.isArray(run.polls) && run.polls[0]) answer(say, `GET ${TRADES_PATH(run.coin)}`, run.polls[0], run.polls[0].answeredMs);
  say(isObj(f) && B58.test(f.sig ?? "") && Number.isSafeInteger(f.heldAtMs) && ["b", "s"].includes(f.side) && Number.isSafeInteger(f.ts), `a fresh trade decoded from the chain: ${show(f?.sig)} of ${show(run.coin)}`);
  if (!isObj(f)) return { ok: false, lines };
  const polls = Array.isArray(run.polls) ? run.polls : [];
  say(polls.length > 0, `${polls.length} tape reads`);
  if (polls.length === 0) return { ok: false, lines };
  // every read is a well-formed answer; the first that holds the trade is the one timed
  let hit = null;
  for (const [i, p] of polls.entries()) {
    const b = answer(i === 0 || p.status !== 200 ? say : () => undefined, `GET ${TRADES_PATH(run.coin)} (read ${i + 1})`, p, p.answeredMs);
    if (b === undefined) return { ok: false, lines };
    const fault = tradesFault(b);
    if (fault !== null) {
      say(false, `trades read ${i + 1}: exactly the frozen fields in their wire forms: ${fault}`);
      return { ok: false, lines };
    }
    const row = b.trades.find((r) => r.tx === f.sig);
    if (row !== undefined) {
      hit = { i, p, row };
      break;
    }
  }
  say(true, "every tape read holds exactly the frozen fields in their wire forms");
  say(hit !== null, `the fresh trade ${f.sig.slice(0, 12)} is on the tape${hit === null ? ` in none of ${polls.length} reads` : ` at read ${hit.i + 1}`}`);
  if (hit === null) return { ok: false, lines };
  const ms = hit.p.answeredMs - f.heldAtMs;
  say(ms <= FRESH_MS, `on the tape ${ms} ms after the check held it on chain (at most ${FRESH_MS})`);
  // where the time went (the helper's clock for as_of_ms, so within the two hosts' clock skew): the helper folded the
  // trade after the last read that lacked it was sent and by the as_of_ms of the read that holds it; the rest is the
  // read's own round trip
  const prev = hit.i > 0 ? polls[hit.i - 1] : null;
  const asOf = JSON.parse(hit.p.body).as_of_ms;
  lines.push(`    timing: the helper folded it after +${prev === null ? "?" : prev.atMs - f.heldAtMs} ms (read ${hit.i} sent, without it) and by +${asOf - f.heldAtMs} ms (as_of_ms of read ${hit.i + 1}); read ${hit.i + 1} sent at +${hit.p.atMs - f.heldAtMs} ms, answered in ${hit.p.answeredMs - hit.p.atMs} ms`);
  say(hit.row.side === f.side && hit.row.t_ms === f.ts * 1000 && hit.row.trader === f.user, `its side ${show(hit.row.side)}, time ${hit.row.t_ms} and trader ${show(hit.row.trader)} are the event's (${f.side}, ${f.ts * 1000}, ${f.user})`);
  const c = answer(say, `GET ${CANDLES_PATH(run.coin)}`, run.candles, run.candles?.answeredMs);
  if (c === undefined) return { ok: false, lines };
  const bar = Array.isArray(c.candles) ? c.candles.find((b) => Array.isArray(b) && b[0] === f.ts) : undefined;
  say(c.tf === "1s" && bar !== undefined && bar.length === 6 && bar.slice(1).every((v) => typeof v === "string" && DEC.test(v)) && Number(bar[5]) > 0, `the 1s candles hold the trade's second ${f.ts}: ${show(bar)}`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

/** One read, its error naming the request (a run's ERROR line says which read failed, and a timeout says so). */
async function get(base, path, fetchFn) {
  const t0 = Date.now();
  try {
    const r = await fetchFn(`${base}${path}`, { headers: { origin: APP }, signal: AbortSignal.timeout(10_000) });
    const body = await r.text();
    return { atMs: t0, answeredMs: Date.now(), status: r.status, headers: Object.fromEntries(r.headers), body };
  } catch (e) {
    throw new Error(`GET ${path} ${e?.name === "TimeoutError" ? "timed out after 10 s" : `failed: ${e?.message}`}`);
  }
}

/** The quotes the helper prices a trade in (trades.ts): a curve or pool quoted in another token (a tokenized stock, say)
 *  has no dollar value there, so its trade is not one this check can time. */
const PRICED = [WSOL, USDC];

/** A PumpSwap pool's base mint when its quote is priced, read on the public RPC (the pool account its program owns), or
 *  null. */
async function poolBase(pool) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [pool, { encoding: "base64" }] }), signal: AbortSignal.timeout(10_000) });
  const v = (await r.json()).result?.value;
  const m = v?.owner === PUMP_AMM ? poolMints(Buffer.from(v.data[0], "base64")) : null;
  return m && PRICED.includes(m.quote) ? m.base : null;
}

/** The first trade of `open` tokens the public websocket sends, decoded from its venue's event. */
function watchOnce(open, ws) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(ws);
    const subs = new Map();
    const timer = setTimeout(() => (s.close(), reject(new Error(`no trade of ${open.length} tokens in ${WAIT_MS} ms`))), WAIT_MS);
    s.onopen = () => open.forEach((t, i) => s.send(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "logsSubscribe", params: [{ mentions: [t] }, { commitment: "confirmed" }] })));
    s.onmessage = (m) => {
      const j = JSON.parse(String(m.data));
      if (typeof j.id === "number" && typeof j.result === "number") subs.set(j.result, open[j.id - 1]);
      if (j.method !== "logsNotification") return;
      const coin = subs.get(j.params.subscription);
      const v = j.params.result.value;
      if (coin === undefined || v.err !== null) return;
      const heldAtMs = Date.now();
      const done = (t) => {
        clearTimeout(timer);
        s.close();
        resolve({ coin, sig: v.signature, heldAtMs, side: t.side, ts: t.ts, user: t.user });
      };
      // a curve trade names its mint; a PumpSwap trade is the token's only when its pool's base mint is the token (a
      // route through several pools mentions the token in a transaction that also trades others)
      const trades = fromLogs(v.logs).trades;
      const curve = trades.find((x) => x.mint === coin && x.venue === "pump" && PRICED.includes(x.quoteMint));
      if (curve !== undefined) return done(curve);
      for (const x of trades.filter((x) => x.venue === "pumpswap")) {
        void poolBase(x.pool).then((base) => base === coin && done(x)).catch(() => undefined);
      }
    };
    s.onerror = () => (clearTimeout(timer), reject(new Error("websocket error")));
  });
}

/** Reads each of `open`'s tapes every `everyMs` until the returned stop is called: the helper closes a token nobody read
 *  for IDLE_MS (60 s, trades.ts), and a wait for a trade can outlast that (a run once waited 66 s). */
export function keepOpen(base, open, fetchFn = fetch, everyMs = 20_000) {
  const timer = setInterval(() => {
    for (const t of open) void fetchFn(`${base}${TRADES_PATH(t)}`, { headers: { origin: APP }, signal: AbortSignal.timeout(10_000) }).then((r) => r.body?.cancel()).catch(() => undefined);
  }, everyMs);
  return () => clearInterval(timer);
}

/** One live run against `base`. */
export async function read(base = BASE, fetchFn = fetch, ws = WS) {
  const lists = await get(base, LISTS_PATH, fetchFn);
  if (lists.status !== 200) throw new Error(`lists answered ${lists.status}`);
  const rows = Object.values(JSON.parse(lists.body).lists ?? {}).flat();
  const tokens = [...new Set(rows.map((r) => r.token).filter((t) => typeof t === "string"))].slice(0, OPEN);
  // open each on the helper (a 404 there is the run's answer for that token), and watch each on the chain
  const first = {};
  for (const t of tokens) first[t] = await get(base, TRADES_PATH(t), fetchFn);
  const open = tokens.filter((t) => first[t].status === 200);
  if (open.length === 0) return { base, coin: tokens[0] ?? null, fresh: null, polls: tokens.length ? [first[tokens[0]]] : [], candles: null };
  // the public websocket refuses a connection now and then (several in a row from one address): five tries, 2 s apart
  let fresh;
  const stop = keepOpen(base, open, fetchFn);
  try {
    for (let attempt = 1; fresh === undefined; attempt++) {
      try {
        fresh = await watchOnce(open, ws);
      } catch (e) {
        if (attempt === 5 || !/websocket error/.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  } finally {
    stop();
  }
  const polls = [];
  while (Date.now() - fresh.heldAtMs < FRESH_MS + 3_000) {
    const p = await get(base, TRADES_PATH(fresh.coin), fetchFn);
    polls.push(p);
    if (p.status !== 200 || JSON.parse(p.body).trades?.some((r) => r.tx === fresh.sig)) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const candles = await get(base, CANDLES_PATH(fresh.coin), fetchFn);
  const { coin, ...rest } = fresh;
  return { base, coin, fresh: rest, polls, candles };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const run = await read(base);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${base}, ${run.coin})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
