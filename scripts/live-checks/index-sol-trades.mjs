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
//     15 s of the read and Access-Control-Allow-Origin echoing APP_HOST; the trades hold exactly the tape's fields (tape-read.mjs tapeFieldsFault: trades, filling, whole_ms, src, as_of_ms),
//     each {t_ms, side, usd, amt, trader, tx}, newest first;
//   - the fresh trade's signature is on the tape in a read that answered within 2 s of the check holding the trade, with
//     its side, its time (the event's clock) and its trader (the event's user);
//   - the 1s candles hold a bar at the trade's second with a volume above 0.
// Card index-sol-trades-2 adds one listed Meteora coin per venue (DLMM, DBC, DAMM v2), after the pump.fun part: the
// check opens the listed coins off pump.fun on the helper (met-dbc's first) and watches them on the public websocket
// until each venue has a fresh trade of a listed coin against SOL or USDC, decoded from the venue's own event (read whole
// on the public RPC: the three send their events only to themselves); a venue with none in the wait takes a trade of
// the venue among the newest rows of those coins' tapes. It passes only when, for each venue, that coin's tape on the
// helper (read every POLL_MS from the moment the trade is found, up to METEORA_TAPE_MS; a trade that left a busy coin's
// 50 newest rows first is replaced by the venue's next) holds the trade's signature with its side and time, its answer
// is src "chain" and well-formed, and the signature reads back succeeded on two public RPCs (getSignatureStatuses, the
// history searched). DBC alone may read none, and only while the lists hold no coin on a DBC curve with DBC_VOL_USD in a
// day (dbc_curves, from the same lists). Card sol-meteora-tape-inside-rpc-budget: a coin whose tape answer names
// `sol-whole-cut` in Server-Timing (the helper read its Meteora trades whole past their budget, trades.ts: its own rows
// filling, or its pool's tape while it holds none) is skipped, named in the run's `cut` with when it was read, and its venue watched again; a venue whose
// every sampled coin was cut is BAD, and so is a cut answer that names a reach (whole_ms: every trade from then on) while
// a trade is unread (card solana-flooded-coin-first-answer-holds-rows). Card helper-sol-tape-checks-hold: a cut coin is passed over while its cut lasts
// (CUT_KEEP_MS), so the venue's next sample is another coin; the cut coins are counted once each; and the BAD names the
// budget as starving the venue only when its cuts not explained by the coin's own share (the helper's cut names its
// cause) were read more than CUT_KEEP_MS apart. Any other venue with every trade cut is BAD as none judged. A found trade out of the span its coin's tape answers for
// (older than a full tape's 50 rows, or than the reach the answer names in whole_ms: the route takes no time bound) is
// skipped and named in the run's `rolled`; a venue whose every sampled trade was skipped is BAD.
// The candles read is read as the token page reads it (candles-read.mjs): a 429 again at its Retry-After, for at most
// one 75 s span; a 429 still standing after it, or no bar at the trade's second, is BAD as any other answer.
// Card helper-sol-tape-checks-hold: a trade's time is its block's, on both parts (the transaction's blockTime read on
// READ_BACK), never its event's own clock, which is a second before its block in some slots (slot 471386582's DAMM v2
// event 1795102226, block 1795102227 on both RPCs): the tape's rows and its 1s bars are dated by their block, as
// sol-tape-in-order holds them. A signature a public RPC does not know yet (status null, a node behind) is asked again
// as a refusal is, 2, 4, 8 and 16 s on (solana-rpc.publicnode.com answered none for a finalized DAMM v2 trade, 19 Nov
// 15:31Z).
// After: helper
//   node scripts/live-checks/index-sol-trades.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { candlesReader, waitsText } from "./candles-read.mjs";
import { tapeFieldsFault } from "./tape-read.mjs";
import { writeFileSync } from "node:fs";
import { cutTrades, dbcPair, eventsInInner, fromLogs, METEORA_DAMM2, METEORA_DBC, METEORA_DLMM, poolMints, poolPair, PUMP_AMM, USDC, WSOL } from "../../apps/helper/src/data/solana/decode.ts";

const KEY = "index-sol-trades";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const WS = "wss://api.mainnet-beta.solana.com";
const RPC = "https://api.mainnet-beta.solana.com";
export const FRESH_MS = 2_000;
/** Card sol-stream-refuses-unsigned-notes: Signature::default(), 64 zero bytes in base58, which no transaction on chain
 *  carries: the public websocket sent one with a pump.fun trade's logs and err null (live run 45602902162, GEJvXD3R), and
 *  this check held it as the fresh trade. A note under it is no trade (the helper drops it too, trades.ts DEFAULT_SIG). */
export const DEFAULT_SIG = "1".repeat(64);
export const OPEN = 8;
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
  // `filling` true: a tape whose older trades the helper still reads (card token-page-data-complete-and-fast); never false
  // its own fields, whole_ms among them (tape-read.mjs tapeFieldsFault)
  if (!isObj(t) || tapeFieldsFault(t) !== null) return isObj(t) ? tapeFieldsFault(t) : `keys ${show(t)}`;
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
  say(r?.status === 200, `${name} answers ${r?.status}${waitsText(r)}`);
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
function judgePump(run) {
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
  // its time is its block's (card helper-sol-tape-checks-hold), read on READ_BACK
  say(Number.isSafeInteger(f.block), `its block time read back: ${show(f.block)}`);
  say(hit.row.side === f.side && hit.row.t_ms === f.block * 1000 && hit.row.trader === f.user, `its side ${show(hit.row.side)}, time ${hit.row.t_ms} and trader ${show(hit.row.trader)} are the event's side and trader and its block's time (${f.side}, ${f.block * 1000}, ${f.user})`);
  const c = answer(say, `GET ${CANDLES_PATH(run.coin)}`, run.candles, run.candles?.answeredMs);
  if (c === undefined) return { ok: false, lines };
  const bar = Array.isArray(c.candles) ? c.candles.find((b) => Array.isArray(b) && b[0] === f.block) : undefined;
  say(c.tf === "1s" && bar !== undefined && bar.length === 6 && bar.slice(1).every((v) => typeof v === "string" && DEC.test(v)) && Number(bar[5]) > 0, `the 1s candles hold the trade's block second ${f.block}: ${show(bar)}`);
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
export function watchOnce(open, ws) {
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
      if (coin === undefined || v.err !== null || v.signature === DEFAULT_SIG) return;
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

/** Card index-sol-trades-2: the venues the tape decodes past pump.fun's, Meteora's three. */
export const METEORA = { "meteora-dlmm": METEORA_DLMM, "meteora-dbc": METEORA_DBC, "meteora-damm2": METEORA_DAMM2 };
/** The two public RPCs a Meteora trade's signature reads back on. */
export const READ_BACK = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const METEORA_WAIT_MS = 180_000;
const METEORA_TAPE_MS = 30_000;
/** Card sol-meteora-tape-inside-rpc-budget: the Meteora part's coins, watched and kept open on the helper, at most. With the
 *  pump.fun part's OPEN (open until IDLE_MS after it) they hold 28 of the helper's OPEN_MAX 40 walks (trades.ts), so the
 *  users' pages keep 12. At 100 the check took every walk: "refused /v1/market/trades solana trades open 41 in 10 s", and
 *  its own DLMM coin was answered 429 (a local helper at 8ddec0fe2, 18 Nov 20:12Z). */
export const METEORA_WATCH = 20;
/** Card sol-meteora-tape-inside-rpc-budget: a found venue's tape read once a second, so the check stays one caller inside
 *  the helper's API_RATE_MAX (120 in 10 s): its coins kept open every 20 s (10) and three venues' reads (30). At
 *  POLL_MS (200 ms) three reads drew 150 in 10 s, and the helper answered the check 429 (a local helper at 7239c82e4,
 *  18 Nov 19:28Z and 19:34Z: "refused /v1/market/trades client window"). */
export const METEORA_POLL_MS = 1_000;
/** The listed coins whose tapes a venue with no fresh trade is looked for in, at most. */
const METEORA_SCAN = 40;
/** A DBC curve coin's 24 h volume in USD from which the check needs a DBC trade (the one listed DBC curve coin on 18 Nov
 *  14:50Z had 0.99 USD in a day and traded none in the run). */
export const DBC_VOL_USD = 1_000;
/** Card helper-sol-tape-checks-hold: how long the helper serves a coin whose Meteora trade went unread its pool's tape
 *  (trades.ts CUT_KEEP_MS, held equal by this check's test). A coin's trades are passed over while its cut lasts: read
 *  again inside it they only show the same cut (live run 44721792317: one DBC coin, fZgm5f3J, sampled 13 times). */
export const CUT_KEEP_MS = 60_000;
/** A cut the coin's own share of the whole reads explains (trades.ts CUT_WHY.coin, and round 3's CUT_WHY.busy: a coin with
 *  5 or more whole reads in its 10 s past the places busy coins share, which a quiet coin is never cut by): the design's
 *  bound for a busy coin, never the budget starving other coins. */
export const OWN_SHARE = /: past (the coin's own \d+ a \d+ s|the \d+ a second busy coins share)"$/;

async function call(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  if (r.status !== 200) throw new Error(`${method} answered ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 120)}`);
  return j.result;
}
/** The first of READ_BACK that answers. */
async function anyRpc(method, params) {
  let last;
  for (const u of READ_BACK) {
    try {
      return await call(u, method, params);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
async function acct(key) {
  const v = (await anyRpc("getAccountInfo", [key, { encoding: "base64", commitment: "confirmed" }]))?.value;
  return v ? { owner: v.owner, data: Buffer.from(v.data[0], "base64") } : null;
}
/** A Meteora trade's pool's two mints, each account taken only from its own program (decode.ts), or null. */
async function meteoraPair(t) {
  if (t.venue === "meteora-dbc") {
    const [p, c] = await Promise.all([acct(t.pool), acct(t.config)]);
    return p && c ? dbcPair(p, c, t.config) : null;
  }
  const p = await acct(t.pool);
  return p ? poolPair(t.venue, p.owner, p.data) : null;
}

/** The first trade of `coin` against SOL or USDC on one of `venues` in transaction `sig` (read whole on the public RPC,
 *  decoded by the helper's own decoder), told as `coin` sees it: { venue, side, ts }, or null. */
async function meteoraTradeOf(sig, coin, venues) {
  const r = await anyRpc("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
  if (!r || r.meta?.err !== null) return null;
  for (const t of cutTrades(fromLogs(r.meta.logMessages), r)) {
    if (!venues.has(t.venue)) continue;
    const p = await meteoraPair(t);
    if (p === null || ![p.a, p.b].includes(coin) || !PRICED.includes(p.a === coin ? p.b : p.a)) continue;
    // its block's time, never its event's own clock (card helper-sol-tape-checks-hold)
    return { venue: t.venue, side: p.a === coin ? t.side : t.side === "b" ? "s" : "b", ts: r.blockTime };
  }
  return null;
}

/**
 * Card index-sol-trades-2: the first fresh trade of a listed coin against SOL or USDC on each Meteora venue, watched on
 * the public websocket across `tokens`: { [venue]: { coin, sig, heldAtMs, side, ts } } for the venues found in time,
 * each also handed to `onFound` the moment it is found (its tape is read at once: a busy coin's 50 newest rows move on).
 * `onFound` answers whether the venue is done; a venue it answers false for is watched again (a trade that had left the
 * 50 newest rows of a coin trading 5 a second before its tape was read). A trade of a coin `passOver` names is not
 * read (card helper-sol-tape-checks-hold: a coin whose cut still lasts).
 */
export function watchMeteora(tokens, ws = WS, waitMs = METEORA_WAIT_MS, onFound = async () => true, passOver = () => false) {
  return new Promise((resolve) => {
    const found = {};
    const want = new Set(Object.keys(METEORA));
    let reading = 0;
    let s;
    let subs = new Map();
    let busy = 0;
    let ended = false;
    const done = () => (ended = true, clearTimeout(timer), s.close(), resolve(found));
    const timer = setTimeout(done, waitMs);
    // the public websocket refuses or drops a connection now and then: opened again 2 s on, until the wait ends
    const connect = () => {
      s = new WebSocket(ws);
      subs = new Map();
      s.onopen = () => tokens.forEach((t, i) => s.send(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "logsSubscribe", params: [{ mentions: [t] }, { commitment: "confirmed" }] })));
      s.onclose = () => void (ended || setTimeout(() => ended || connect(), 2_000));
      s.onmessage = onMessage;
    };
    const onMessage = (m) => {
      const j = JSON.parse(String(m.data));
      if (typeof j.id === "number" && typeof j.result === "number") subs.set(j.result, tokens[j.id - 1]);
      if (j.method !== "logsNotification") return;
      const coin = subs.get(j.params.subscription);
      const v = j.params.result.value;
      const ran = Object.entries(METEORA).filter(([k, p]) => want.has(k) && v.logs.some((l) => l.startsWith(`Program ${p} invoke`)));
      if (coin === undefined || v.err !== null || v.signature === DEFAULT_SIG || ran.length === 0 || !eventsInInner(v.logs) || busy >= 2 || passOver(coin)) return;
      const heldAtMs = Date.now();
      busy++;
      void (async () => {
        const t = await meteoraTradeOf(v.signature, coin, want);
        if (t === null || !want.has(t.venue)) return;
        want.delete(t.venue);
        found[t.venue] = { coin, sig: v.signature, heldAtMs, side: t.side, ts: t.ts };
        reading++;
        void Promise.resolve(onFound(t.venue, found[t.venue]))
          .catch(() => true)
          .then((kept) => {
            reading--;
            if (!kept && !ended) want.add(t.venue);
            if (want.size === 0 && reading === 0 && !ended) done();
          });
      })()
        .catch(() => undefined)
        .finally(() => busy--);
    };
    connect();
  });
}

/** `sig`'s status on each of READ_BACK, each RPC asked again 2, 4, 8 and 16 s on when it refuses (the public RPC
 *  answered 429 for 6 s, 18 Nov 15:07Z) or knows no status for it yet (card helper-sol-tape-checks-hold: publicnode
 *  answered none for a finalized trade, 19 Nov 15:31Z). `wait` is the sleep (a test plants it). */
export async function readBack(sig, callFn = call, wait = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const reads = {};
  for (const u of READ_BACK) {
    for (let i = 0; i < 5; i++) {
      reads[u] = await callFn(u, "getSignatureStatuses", [[sig], { searchTransactionHistory: true }]).catch((e) => ({ error: e.message }));
      if ((reads[u].error === undefined && reads[u]?.value?.[0] != null) || i === 4) break;
      await wait(2_000 * 2 ** i);
    }
  }
  return reads;
}

/** A transaction's block time (unix seconds) on the first of READ_BACK that names one, each asked again 2, 4 and 8 s on;
 *  null when none does. */
export async function blockOf(sig, callFn = call, wait = (ms) => new Promise((r) => setTimeout(r, ms))) {
  for (let i = 0; i < 4; i++) {
    for (const u of READ_BACK) {
      const r = await callFn(u, "getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]).catch(() => null);
      if (Number.isSafeInteger(r?.blockTime) && r.blockTime > 0) return r.blockTime;
    }
    if (i < 3) await wait(2_000 * 2 ** i);
  }
  return null;
}

/** A found venue's coin's tape on the helper until it holds the trade (every second, up to METEORA_TAPE_MS), then the
 *  trade's signature read back on each of READ_BACK. */
export async function readMeteoraOne(base, f, fetchFn = fetch) {
  const polls = [];
  // every METEORA_POLL_MS: a busy coin's 50 newest rows span a few seconds (TTW's 50 spanned 3 s, 18 Nov 15:00Z)
  for (const t0 = Date.now(); Date.now() - t0 < METEORA_TAPE_MS; await new Promise((r) => setTimeout(r, METEORA_POLL_MS))) {
    const p = await get(base, TRADES_PATH(f.coin), fetchFn).catch((e) => ({ status: 0, headers: {}, body: e.message }));
    polls.push(p);
    if (p.status === 200 && JSON.parse(p.body).trades?.some((r) => r.tx === f.sig)) break;
  }
  const reads = await readBack(f.sig);
  const hit = polls.findLast((p) => p.status === 200 && JSON.parse(p.body).trades?.some((r) => r.tx === f.sig));
  return { ...f, polls: [hit ?? polls.at(-1)], reads };
}

/** The Meteora part of a run: the listed coins off pump.fun watched (a pump.fun coin trades on its curve or PumpSwap; 100
 *  listed coins with them sent 470 notifications a second, 18 Nov 14:52Z), each venue's tape read as it is found. */
export async function readMeteora(base, rows, ws = WS, fetchFn = fetch, waitMs = METEORA_WAIT_MS) {
  // Meteora's own launchpad's coins (DBC) first
  const off = rows.filter((r) => r.launchpad !== "pump.fun");
  const tokens = [...new Set([...off.filter((r) => r.launchpad === "met-dbc"), ...off].map((r) => r.token))].filter((t) => typeof t === "string" && B58.test(t)).slice(0, METEORA_WATCH);
  // each watched coin opened on the helper first and kept open, so the helper holds a trade the moment it lands
  await Promise.all(tokens.map((t) => get(base, TRADES_PATH(t), fetchFn).catch(() => null)));
  const stop = keepOpen(base, tokens, fetchFn);
  const reading = {};
  // card sol-meteora-tape-inside-rpc-budget: a coin the helper serves past its whole reads' budget (sol-whole-cut) is
  // skipped and named, and its venue watched again: its trade is judged on a coin the helper reads whole
  const cut = {};
  // card helper-sol-tape-checks-hold: each cut dated (atMs), and its coin passed over until its cut ends (CUT_KEEP_MS),
  // so the venue's next sample is another coin, or the same one past its cut
  const cutTill = {};
  const skip = (venue, f, p) => {
    cutTill[f.coin] = Date.now() + CUT_KEEP_MS;
    // card solana-flooded-coin-first-answer-holds-rows: the reach a cut answer names, if any, kept for the judge
    const whole = wholeOf(p);
    if (!(cut[venue] ??= []).some((c) => c.sig === f.sig)) cut[venue].push({ coin: f.coin, sig: f.sig, timing: cutOf(p), atMs: Date.now(), ...(whole === null ? {} : { whole_ms: whole }) });
  };
  const cutNow = (coin) => (cutTill[coin] ?? 0) > Date.now();
  // and a trade out of the span its coin's tape answers for (outOfSpan) is skipped and named in `rolled`
  const rolled = {};
  const roll = (venue, v) => void ((rolled[venue] ??= []).some((c) => c.sig === v.sig) || rolled[venue].push({ coin: v.coin, sig: v.sig, ts: v.ts, why: outOfSpan(v) }));
  await watchMeteora(tokens, ws, waitMs, async (venue, f) => {
    const r = (reading[venue] = readMeteoraOne(base, f, fetchFn));
    const v = await r;
    const { polls } = v;
    // kept unless cut, or its trade out of the span its tape answers for (rolled), each named and its venue watched again
    if (cutOf(polls[0]) !== null) skip(venue, f, polls[0]);
    else if (outOfSpan(v) !== null) roll(venue, v);
    else return true;
    if (reading[venue] === r) delete reading[venue];
    return false;
  }, cutNow).finally(stop);
  const out = {};
  for (const [venue, r] of Object.entries(reading)) {
    const v = await r;
    // a read the watch's end left unjudged is skipped when cut, as the watch skips it (a local helper at aeb7b0a81, 18 Nov
    // 19:01Z: a DLMM coin served past the budget was judged), and when its trade is out of its tape's span
    if (cutOf(v.polls.at(-1)) !== null) skip(venue, v, v.polls.at(-1));
    else if (outOfSpan(v) !== null) roll(venue, v);
    else out[venue] = v;
  }
  // a venue none of whose listed coins traded in the wait (DBC: 3 listed coins at 18 Nov 14:50Z): the newest rows of
  // those coins' tapes on the helper, the first that is a trade of the venue by the helper's own decoder (`fromTape`)
  const left = new Set(Object.keys(METEORA).filter((v) => !(v in out)));
  for (const coin of tokens.slice(0, METEORA_SCAN)) {
    if (left.size === 0) break;
    if (cutNow(coin)) continue;
    const p = await get(base, TRADES_PATH(coin), fetchFn).catch(() => null);
    // only a tape of the helper's own chain reads names a trade it decoded: a vendor's (a coin past OPEN_MAX's walks, or
    // with no decoded venue) is passed over (a local helper at 8ddec0fe2, 18 Nov 20:07Z: a DLMM row off Ce2gx9KG's
    // CoinGecko tape was judged, and had left that tape's 50 rows by its next read)
    if (p?.headers?.["x-helper-source"] !== "chain") continue;
    const rows = p?.status === 200 ? (JSON.parse(p.body).trades ?? []).slice(0, 3) : [];
    for (const row of rows) {
      const t = B58.test(row?.tx ?? "") ? await meteoraTradeOf(row.tx, coin, left).catch(() => null) : null;
      if (t === null) continue;
      const f = { coin, sig: row.tx, heldAtMs: Date.now(), side: t.side, ts: t.ts, fromTape: true };
      // a tape past the budget lacks a trade it could not read, so none of its rows is judged (card
      // sol-meteora-tape-inside-rpc-budget; its rows our own or its pool's, card solana-flooded-coin-first-answer-holds-rows)
      if (cutOf(p) !== null) {
        skip(t.venue, f, p);
        continue;
      }
      // and a coin cut by the time its tape is read is skipped too (a starved local helper, 18 Nov 19:10Z: a DLMM coin's
      // scan read uncut, its tape cut 5 s on)
      const v = await readMeteoraOne(base, f, fetchFn);
      if (cutOf(v.polls.at(-1)) !== null) {
        skip(t.venue, f, v.polls.at(-1));
        break;
      }
      if (outOfSpan(v) !== null) {
        roll(t.venue, v);
        break;
      }
      left.delete(t.venue);
      out[t.venue] = v;
      break;
    }
  }
  // the listed coins on a DBC curve that trade (DBC_VOL_USD in a day): with none, no listed coin can show a DBC trade
  out.dbc_curves = dbcCurves(rows);
  out.cut = cut;
  out.rolled = rolled;
  return out;
}

/** Card sol-meteora-tape-inside-rpc-budget: why a found trade its coin's tape does not hold is outside what that tape
 *  answers for, or null when the tape holds it or should (it is then judged). GET /v1/market/trades takes a limit only (at
 *  most TRADES_MAX, 50: no time or cursor bound), so a trade is out when
 *    - 50 rows were answered and the trade is older than the oldest of them (a busy coin's trade rolled past them), or
 *    - the answer names its reach (whole_ms: every trade from then on) and the trade is older than it (a local helper at
 *      7239c82e4, 18 Nov 19:47Z: DAMM v2 trade m6AJaXiFvoPs at 1795031220 s, whole_ms 1795031235000, newest row 1795031191
 *      s, oldest 1795029860 s of 50).
 *  A missing trade inside the rows' span and inside the named reach is the tape's fault and is judged. */
export function outOfSpan(v) {
  const p = Array.isArray(v?.polls) ? v.polls.at(-1) : undefined;
  if (p?.status !== 200 || !Number.isSafeInteger(v?.ts)) return null;
  let b;
  try {
    b = JSON.parse(p.body);
  } catch {
    return null;
  }
  if (!Array.isArray(b?.trades) || b.trades.some((r) => r?.tx === v.sig)) return null;
  const at = v.ts * 1000;
  const oldest = b.trades.at(-1)?.t_ms;
  if (b.trades.length >= 50 && Number.isSafeInteger(oldest) && at < oldest) return `rolled past the tape's 50 rows (oldest ${oldest})`;
  if (Number.isSafeInteger(b.whole_ms) && at < b.whole_ms) return `before the tape's named reach (whole_ms ${b.whole_ms})`;
  return null;
}

/** Card sol-meteora-tape-inside-rpc-budget: an answer's `sol-whole-cut` Server-Timing entry (the helper served the coin
 *  its pool's tape: a Meteora trade of it went unread past the whole reads' budget, trades.ts), or null. */
/** The reach (whole_ms) an answer names, or null. */
export function wholeOf(p) {
  try {
    const w = JSON.parse(String(p?.body ?? "")).whole_ms;
    return w === undefined ? null : w;
  } catch {
    return null;
  }
}

export function cutOf(p) {
  const t = String(p?.headers?.["server-timing"] ?? "");
  return /(^|,\s*)sol-whole-cut(;|,|$)/.test(t) ? t.match(/sol-whole-cut[^,]*/)[0] : null;
}

/** The listed coins still on a DBC curve (curve_bps under 10,000) with DBC_VOL_USD in a day. */
export function dbcCurves(rows) {
  return rows.filter((r) => r.launchpad === "met-dbc" && Number.isInteger(r.curve_bps) && r.curve_bps < 10_000 && Number(r.vol_24h_usd) >= DBC_VOL_USD).map((r) => r.token);
}

/** Card index-sol-trades-2: the checks on a run's Meteora venues. */
export function judgeMeteora(m) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const venue of Object.keys(METEORA)) {
    // card sol-meteora-tape-inside-rpc-budget: coins past the helper's whole reads' budget are skipped and named; a venue
    // whose every sampled coin was past it is the budget starving the venue, a fault, never a pass
    const cut = isObj(m) && isObj(m.cut) && Array.isArray(m.cut[venue]) ? m.cut[venue] : [];
    // card solana-flooded-coin-first-answer-holds-rows: a cut answer is never whole: a Meteora trade is unread
    for (const c of cut.filter((x) => isObj(x) && x.whole_ms !== undefined)) lines.push(`BAD ${venue}: ${show(c.coin)}'s tape named the cut (${c.timing}) and a reach, whole_ms ${c.whole_ms}: never whole while a trade is unread`);
    // card sol-meteora-tape-inside-rpc-budget: a trade out of the span its tape answers for (outOfSpan) is skipped and named,
    // the judged one included; a venue whose every sampled trade was skipped has none judged, a fault, never a pass
    const rolled = [...(isObj(m) && isObj(m.rolled) && Array.isArray(m.rolled[venue]) ? m.rolled[venue] : [])];
    let v = isObj(m) ? m[venue] : undefined;
    if (isObj(v) && outOfSpan(v) !== null) {
      rolled.push({ coin: v.coin, sig: v.sig, ts: v.ts, why: outOfSpan(v) });
      v = undefined;
    }
    const rolledSay = rolled.map((c) => `${String(c.sig).slice(0, 12)} ${c.why}`).join("; ");
    if (!isObj(v) && rolled.length > 0) {
      lines.push(`BAD ${venue}: every sampled trade was skipped, none judged: ${rolled.length} out of its tape's span (${rolledSay})${cut.length > 0 ? `, ${cut.length} coin(s) past the helper's whole reads' budget` : ""}`);
      continue;
    }
    if (rolled.length > 0) lines.push(`ok  ${venue}: ${rolled.length} trade(s) out of its tape's span skipped: ${rolledSay}`);
    // card helper-sol-tape-checks-hold: the cut coins counted once each. The venue is starved only by cuts the coin's own
    // share does not explain (every coin's second spent, its provider held or unanswered: the helper's cut names which)
    // read more than a cut's keep (CUT_KEEP_MS) apart, the budget spent past one cut (live run 44721792317 named one DBC
    // coin 13 times as "every sampled coin"). Any other cut judges nothing either way: a fault too, named as that
    const coins = [...new Set(cut.map((c) => String(c.coin)))];
    const named = `${coins.length} coin(s), ${cut.length} trade(s): ${coins.map((c) => c.slice(0, 8)).join(", ")}`;
    const starving = cut.filter((c) => !OWN_SHARE.test(String(c.timing)));
    const at = starving.map((c) => c.atMs);
    const spanMs = starving.length > 0 && at.every(Number.isSafeInteger) ? Math.max(...at) - Math.min(...at) : null;
    if (!isObj(v) && cut.length > 0) {
      if (spanMs !== null && spanMs > CUT_KEEP_MS) lines.push(`BAD ${venue}: every sampled coin (${named}) was served past the helper's whole reads' budget (${starving.at(-1).timing}), cut again ${Math.round(spanMs / 1_000)} s after its first, past the ${CUT_KEEP_MS / 1_000} s a cut lasts: the budget starved the venue`);
      else if (starving.length === 0) lines.push(`BAD ${venue}: none judged: every trade found (${named}) was on a coin past its own share of the helper's whole reads (${cut[0].timing}), its tape naming the cut as a busy coin's does, and no other coin of the venue traded`);
      else lines.push(`BAD ${venue}: none judged: every trade found (${named}) was on a coin inside one cut of the helper's whole reads' budget (${starving[0].timing}${spanMs === null ? ", undated" : `, all within ${Math.round(spanMs / 1_000)} s`}), and none was read past the ${CUT_KEEP_MS / 1_000} s a cut lasts: a burst and a spent budget look the same`);
      continue;
    }
    if (cut.length > 0) lines.push(`ok  ${venue}: ${named} past the helper's whole reads' budget skipped (sol-whole-cut)`);
    if (isObj(v) && Array.isArray(v.polls) && cutOf(v.polls.at(-1)) !== null) {
      lines.push(`BAD ${venue}: the judged coin ${show(v.coin)} was served past the budget (${cutOf(v.polls.at(-1))})`);
      continue;
    }
    // DBC is a launchpad curve: while the lists hold no coin on a DBC curve that trades, no listed coin can show one
    if (venue === "meteora-dbc" && !isObj(v) && isObj(m) && Array.isArray(m.dbc_curves) && m.dbc_curves.length === 0) {
      lines.push(`ok  ${venue}: none to read: the lists hold no coin on a DBC curve with ${DBC_VOL_USD} USD in a day (its decoding is held by decode.test.ts's recorded DBC trades)`);
      continue;
    }
    say(isObj(v) && B58.test(v.coin ?? "") && B58.test(v.sig ?? "") && ["b", "s"].includes(v.side) && Number.isSafeInteger(v.ts), `${venue}: ${v?.fromTape ? "a trade on a listed coin's tape" : "a fresh trade of a listed coin"} decoded from the venue's own event: ${show(v?.sig)} of ${show(v?.coin)}`);
    if (!isObj(v)) continue;
    const p = Array.isArray(v.polls) ? v.polls.at(-1) : undefined;
    const b = p ? answer(say, `${venue}: GET ${TRADES_PATH(v.coin)}`, p, p.answeredMs) : undefined;
    if (b === undefined) continue;
    const fault = tradesFault(b);
    say(fault === null, `${venue}: the tape holds exactly the frozen fields in their wire forms${fault === null ? "" : `: ${fault}`}`);
    // card sol-meteora-tape-inside-rpc-budget: a transaction can hold several trades of the coin (a buy on one pool and a
    // sell on another: 25KF3ptvBtY1 of E5cbap6o, a local helper at 8ddec0fe2, 18 Nov 20:12Z, two rows of 26023135.8611,
    // "s" first): the trade is the row of its side and time among the transaction's rows, else its first row
    const mine = fault === null ? b.trades.filter((r) => r.tx === v.sig) : [];
    const row = mine.find((r) => r.side === v.side && r.t_ms === v.ts * 1000) ?? mine[0];
    say(row !== undefined, `${venue}: the trade ${String(v.sig).slice(0, 12)} is on the coin's tape${row === undefined ? `, not in its ${Array.isArray(b.trades) ? b.trades.length : 0} rows` : ""}`);
    if (row !== undefined) say(row.side === v.side && row.t_ms === v.ts * 1000, `${venue}: its side ${show(row.side)} and time ${row.t_ms} are the event's (${v.side}, ${v.ts * 1000})`);
    for (const u of READ_BACK) {
      const st = v.reads?.[u]?.value?.[0];
      say(isObj(st) && st.err === null && ["confirmed", "finalized"].includes(st.confirmationStatus), `${venue}: the signature reads back succeeded on ${new URL(u).host}: ${show(st?.confirmationStatus ?? v.reads?.[u]?.error)}`);
    }
  }
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

/** The pump.fun part's checks and the Meteora part's (card index-sol-trades-2). */
export function judge(run) {
  const p = judgePump(run);
  const m = judgeMeteora(run.meteora);
  return { ok: p.ok && m.ok, lines: [...p.lines, ...m.lines] };
}

/** One live run against `base`. */
/** `reader`: the run's candles reader (candles-read.mjs): a 429 is read again at its Retry-After, as the page reads it. */
export async function read(base = BASE, fetchFn = fetch, ws = WS, reader = candlesReader()) {
  const lists = await get(base, LISTS_PATH, fetchFn);
  if (lists.status !== 200) throw new Error(`lists answered ${lists.status}`);
  const rows = Object.values(JSON.parse(lists.body).lists ?? {}).flat();
  const listed = [...new Set(rows.map((r) => r.token).filter((t) => typeof t === "string" && B58.test(t)))];
  const tokens = listed.slice(0, OPEN);
  // open each on the helper (a 404 there is the run's answer for that token), and watch each on the chain
  const first = {};
  for (const t of tokens) first[t] = await get(base, TRADES_PATH(t), fetchFn);
  const open = tokens.filter((t) => first[t].status === 200);
  // card index-sol-trades-2: the Meteora part runs after the pump.fun part, so the public websocket carries one watch at
  // a time (with both at once it refused the pump.fun watch's connection five times in a row, 18 Nov 14:50Z)
  const meteora = () => readMeteora(base, rows, ws, fetchFn);
  if (open.length === 0) return { base, coin: tokens[0] ?? null, fresh: null, polls: tokens.length ? [first[tokens[0]]] : [], candles: null, meteora: await meteora() };
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
  const candles = await reader.read(() => get(base, CANDLES_PATH(fresh.coin), fetchFn));
  const { coin, ...rest } = fresh;
  return { base, coin, fresh: { ...rest, block: await blockOf(fresh.sig) }, polls, candles, meteora: await meteora() };
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
