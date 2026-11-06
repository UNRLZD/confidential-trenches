#!/usr/bin/env node
// Live check of card market-data-solana-token: the token page's Solana data comes from the helper in the frozen field
// lists (markets paper M4.2, D1.1 D-S6, D-S7, D-S11, D-S12; 06b §6.1 TokenPage, Risk, Field, Holders and Candles;
// apps/helper/src/data/solana/token.ts). It reads one live mint (PUMP by default, --token for another) at HELPER_HOST
// with Origin APP_HOST:
//   GET /v1/market/token?chain=solana&token=<mint>
//   GET /v1/market/holders?chain=solana&token=<mint>
//   GET /v1/market/candles?chain=solana&token=<mint>&tf=1h&limit=24
// and passes only when each answers 200 JSON with X-Helper-Commit a full sha, its X-Helper-Source, X-Fetched-At an ISO
// time within 10 minutes of that answer's own read (freshAt) and Access-Control-Allow-Origin echoing APP_HOST, and its body holds exactly the
// frozen fields in their wire forms:
//   - token: TokenPage {row, decimals, pool, risk, route}, then `filling` (a boolean, card token-page-fills-after: true
//     only for a page named on chain whose Jupiter row is still coming, so never on a row of another source; a helper
//     from before that card leaves it out); `row` exactly the terminal's Row fields (read from
//     apps/terminal/src/screens/discover/fields.ts itself) for this mint on Solana; `risk` exactly 06b's 14 Risk fields,
//     each a Field {v, src, as_of_ms}, the authorities and the tax read from the chain;
//   - holders: Holders {holders, total, top_bps, src, as_of_ms}, at most 20 rows {addr, amt, bps[, kind]};
//   - candles: Candles {tf, candles, src, as_of_ms}, at least one bar, each [t_s, o, h, l, c, vol_usd] on the hour
//     grid, oldest first, USD values decimal strings. src is "geckoterminal" for a mint the lists do not hold, else
//     "chain" or "chain,geckoterminal" (the helper's own bars, the vendor's only before them,
//     apps/helper/src/data/solana/trades.ts); when the bars include ours, own_from_s (before as_of_ms) is our first bar.
//   node scripts/live-checks/market-data-solana-token.mjs [--base <url>] [--token <mint>] [--record <file>] [--speed <n>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read; --speed times n more page reads.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { ROW_FIELDS as TERMINAL_FIELDS } from "../../apps/terminal/src/screens/discover/fields.ts";

const KEY = "market-data-solana-token";
export const BASE = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
export const MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
export const READS = {
  token: (m) => `/v1/market/token?chain=solana&token=${m}`,
  holders: (m) => `/v1/market/holders?chain=solana&token=${m}`,
  candles: (m) => `/v1/market/candles?chain=solana&token=${m}&tf=1h&limit=24`,
};
// The frozen lists, as 06b §6.1 writes them (docs/spec/06b-wallet-webapp.md:1729-1749 at research main)
export const ROW = [...TERMINAL_FIELDS];
export const PAGE = ["row", "decimals", "pool", "risk", "route"];
export const RISK = ["mint_auth", "freeze_auth", "lp", "top10_bps", "dev_bps", "snipers_bps", "holders", "liq_usd", "age_s", "tax", "honeypot", "insiders_bps", "bundlers_bps", "fresh_bps"];
export const HOLDERS = ["holders", "total", "top_bps", "src", "as_of_ms"];
export const CANDLES = ["tf", "candles", "src", "as_of_ms"];
export const CANDLE_SOURCES = ["geckoterminal", "chain", "chain,geckoterminal"];
const SOURCE = { token: ["jupiter"], holders: ["chain", "jupiter"], candles: CANDLE_SOURCES };
const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const DEC = /^\d+(\.\d+)?$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const intOrNull = (v) => v === null || Number.isSafeInteger(v);
const bpsOrNull = (v) => v === null || (Number.isSafeInteger(v) && v >= 0 && v <= 10_000);

/** The first thing wrong with a TokenPage for `mint`, or null. */
export function pageFault(p, mint) {
  if (!isObj(p) || !(same(Object.keys(p), PAGE) || same(Object.keys(p), [...PAGE, "filling"]))) return `keys ${show(isObj(p) ? Object.keys(p) : p)}`;
  if ("filling" in p && typeof p.filling !== "boolean") return `filling ${show(p.filling)}`;
  if (!isObj(p.row) || !same(Object.keys(p.row), ROW)) return `row keys ${show(isObj(p.row) ? Object.keys(p.row) : p.row)}`;
  if (p.row.chain !== "solana" || p.row.token !== mint) return `row is ${show(p.row.chain)} ${show(p.row.token)}`;
  for (const f of ["symbol", "name", "src"]) if (typeof p.row[f] !== "string" || p.row[f] === "") return `row ${f} ${show(p.row[f])}`;
  if (p.filling === true && p.row.src !== "chain") return `filling true on a ${show(p.row.src)} row`;
  for (const f of ROW.filter((f) => f.endsWith("_usd"))) if (p.row[f] !== null && !(typeof p.row[f] === "string" && /^-?\d+(\.\d+)?$/.test(p.row[f]))) return `row ${f} ${show(p.row[f])}`;
  if (!(Number.isInteger(p.decimals) && p.decimals >= 0 && p.decimals <= 255)) return `decimals ${show(p.decimals)}`;
  if (!(p.pool === null || (typeof p.pool === "string" && B58.test(p.pool) && p.pool !== mint))) return `pool ${show(p.pool)}`;
  if (!["ok", "none", "unknown"].includes(p.route)) return `route ${show(p.route)}`;
  if (!isObj(p.risk) || !same(Object.keys(p.risk), RISK)) return `risk keys ${show(isObj(p.risk) ? Object.keys(p.risk) : p.risk)}`;
  for (const f of RISK) {
    const x = p.risk[f];
    if (!isObj(x) || !same(Object.keys(x), ["v", "src", "as_of_ms"]) || typeof x.src !== "string" || !Number.isSafeInteger(x.as_of_ms)) return `risk ${f} ${show(x)}`;
  }
  for (const f of ["mint_auth", "freeze_auth"]) if (p.risk[f].src !== "chain" || typeof p.risk[f].v !== "boolean" || p.risk[f].v !== p.row[f]) return `risk ${f} ${show(p.risk[f])}, row ${show(p.row[f])}`;
  const tax = p.risk.tax;
  if (tax.src !== "chain" || !isObj(tax.v) || !same(Object.keys(tax.v), ["buy_bps", "sell_bps"]) || !bpsOrNull(tax.v.buy_bps) || !bpsOrNull(tax.v.sell_bps)) return `risk tax ${show(tax)}`;
  for (const f of ["top10_bps", "dev_bps", "snipers_bps", "insiders_bps", "bundlers_bps", "fresh_bps"]) if (!bpsOrNull(p.risk[f].v)) return `risk ${f} ${show(p.risk[f])}`;
  if (!intOrNull(p.risk.holders.v) || !intOrNull(p.risk.age_s.v)) return `risk holders or age_s`;
  return null;
}

/** The first thing wrong with a Holders answer, or null. */
export function holdersFault(h) {
  if (!isObj(h) || !same(Object.keys(h), HOLDERS)) return `keys ${show(isObj(h) ? Object.keys(h) : h)}`;
  if (!Array.isArray(h.holders) || h.holders.length > 20) return `holders ${Array.isArray(h.holders) ? `${h.holders.length} rows, over 20` : "not a list"}`;
  for (const [i, r] of h.holders.entries()) {
    const keys = isObj(r) ? Object.keys(r) : [];
    if (!(same(keys, ["addr", "amt", "bps"]) || same(keys, ["addr", "amt", "bps", "kind"]))) return `row ${i} keys ${show(keys)}`;
    if (!B58.test(r.addr) || !/^\d+$/.test(r.amt) || !bpsOrNull(r.bps)) return `row ${i} ${show(r)}`;
  }
  if (!SOURCE.holders.includes(h.src)) return `src ${show(h.src)}`;
  if (!intOrNull(h.total) || !bpsOrNull(h.top_bps) || !Number.isSafeInteger(h.as_of_ms)) return `total ${show(h.total)}, top_bps ${show(h.top_bps)}`;
  return null;
}

/** The first thing wrong with a Candles answer for tf 1h, or null. */
export function candlesFault(c) {
  const own = isObj(c) && Object.hasOwn(c, "own_from_s");
  if (!isObj(c) || !same(Object.keys(c), own ? ["tf", "candles", "src", "own_from_s", "as_of_ms"] : CANDLES)) return `keys ${show(isObj(c) ? Object.keys(c) : c)}`;
  if (c.tf !== "1h" || !CANDLE_SOURCES.includes(c.src) || !Number.isSafeInteger(c.as_of_ms)) return `tf ${show(c.tf)}, src ${show(c.src)}`;
  if (own && (!c.src.startsWith("chain") || !Array.isArray(c.candles) || !c.candles.some((b) => Array.isArray(b) && b[0] === c.own_from_s))) return `own_from_s ${show(c.own_from_s)} with src ${show(c.src)}`;
  if (!Array.isArray(c.candles) || c.candles.length === 0 || c.candles.length > 24) return `candles ${Array.isArray(c.candles) ? c.candles.length : "not a list"}`;
  for (const [i, b] of c.candles.entries()) {
    if (!Array.isArray(b) || b.length !== 6 || !Number.isSafeInteger(b[0]) || b[0] % 3600 !== 0 || !b.slice(1).every((v) => typeof v === "string" && DEC.test(v))) return `bar ${i} ${show(b)}`;
    if (i > 0 && b[0] <= c.candles[i - 1][0]) return `bar ${i} not after bar ${i - 1}`;
  }
  return null;
}

/** The most an answer's X-Fetched-At may lie after the answer arrived: the helper's and the check's clocks apart (both
 *  NTP-kept) [design: 2 s, as index-evm-swaps.mjs]. */
const SKEW_MS = 2_000;
/** Whether answer `r`'s X-Fetched-At `at` (ms) is within `bound` of its own read: of its request's time (r.at), and not
 *  after it arrived (r.ms later) but for SKEW_MS; a run recorded before its reads carried their time, of the run's start.
 *  Each read by its own time, never the run's start (card helper-restart-fresh, the same rule as index-evm-swaps.mjs
 *  freshAt: a read late in a run was judged by when the run began). */
function freshAt(r, at, runAt, bound) {
  if (typeof r?.at !== "string" || !Number.isSafeInteger(r?.ms)) return { ok: Math.abs(runAt - at) <= bound, ref: `the read at ${new Date(runAt).toISOString()}` };
  const sent = Date.parse(r.at);
  return { ok: Math.abs(sent - at) <= bound && at - (sent + r.ms) <= SKEW_MS, ref: `its read at ${r.at} (answered in ${r.ms} ms)` };
}

/** The check on one recorded run { mint, readAt, reads: { token, holders, candles: { at, ms, status, headers, body } } }
 *  (at: the read's request time). */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const readAt = Date.parse(run.readAt);
  for (const [k, fault] of [["token", (b) => pageFault(b, run.mint)], ["holders", holdersFault], ["candles", candlesFault]]) {
    const r = run.reads?.[k] ?? { status: 0, headers: {}, body: "" };
    const h = r.headers ?? {};
    const path = READS[k](run.mint);
    say(r.status === 200, `GET ${path} answers ${r.status}`);
    say(/^application\/json/i.test(h["content-type"] ?? ""), `${k} Content-Type: ${show(h["content-type"])}`);
    say(SHA.test(h["x-helper-commit"] ?? ""), `${k} X-Helper-Commit: ${show(h["x-helper-commit"])}`);
    say(SOURCE[k].includes(h["x-helper-source"]), `${k} X-Helper-Source: ${show(h["x-helper-source"])}`);
    const fresh = freshAt(r, Date.parse(h["x-fetched-at"] ?? ""), readAt, 600_000);
    say(ISO.test(h["x-fetched-at"] ?? "") && fresh.ok, `${k} X-Fetched-At: ${show(h["x-fetched-at"])}, within 10 min of ${fresh.ref}`);
    say(h["access-control-allow-origin"] === APP, `${k} Access-Control-Allow-Origin: ${show(h["access-control-allow-origin"])}`);
    let b;
    try {
      b = JSON.parse(r.body);
    } catch {
      b = undefined;
    }
    const f = fault(b);
    say(f === null, `${k}: exactly the frozen fields in their wire forms${f === null ? "" : `: ${f}`}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
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

export async function read(base = BASE, mint = MINT, fetchFn = fetch) {
  const readAt = new Date().toISOString();
  const reads = {};
  for (const k of Object.keys(READS)) reads[k] = await get(base, READS[k](mint), fetchFn);
  return { base, mint, readAt, reads };
}

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const mint = opt("--token", MINT);
    const run = await read(base, mint);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`first reads: token ${run.reads.token.ms} ms, holders ${run.reads.holders.ms} ms, candles ${run.reads.candles.ms} ms`);
    const n = Number(opt("--speed", "0"));
    if (n > 0) {
      const ms = [];
      for (let i = 0; i < n; i++) ms.push((await get(base, READS.token(mint), fetch)).ms);
      console.log(`speed: ${n} token page reads, p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms, max ${Math.max(...ms)} ms`);
    }
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
