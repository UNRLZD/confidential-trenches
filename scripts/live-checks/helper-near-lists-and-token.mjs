#!/usr/bin/env node
// Live check of card helper-near-lists-and-token: the helper answers chain=near on Discover's lists and the token page's
// reads in the other chains' shapes (apps/helper/src/data/near/). It reads, with Origin APP_HOST:
//   GET /v1/market/lists?chain=near, then for one token of it (the first row of trending_1h, else new):
//   GET /v1/market/token?chain=near&token=<id>
//   GET /v1/market/holders?chain=near&token=<id>
//   GET /v1/market/trades?chain=near&token=<id>
//   GET /v1/market/candles?chain=near&token=<id>&tf=1h
//   GET /v1/market/token?chain=near&token=<UNLISTED> (an account with no Rhea pool)
// It passes only when each answers 200 JSON with X-Helper-Commit a full sha, X-Fetched-At an ISO time within AGE_MS of
// the read and Access-Control-Allow-Origin echoing APP_HOST, and the bodies hold exactly the frozen fields: the lists
// {chain: "near", lists: {new, trending, ...}, as_of_ms} with rows exactly the terminal's Row fields, chain near, a
// decimal price; the page {row, decimals, pool, risk, route, filling, links} for that token; holders {holders, total,
// top_bps, src, as_of_ms}; trades {trades, src, as_of_ms} with rows {t_ms, side, usd, amt, trader, tx}; candles {tf,
// candles, src, as_of_ms} with 6-value bars; each part's src one the helper gives it (SRC); and the account with no pool
// answers 404. Anything else is a FAIL.
// After: helper
//   node scripts/live-checks/helper-near-lists-and-token.mjs [--base <url>] [--record <file>] [--speed <n>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read; --speed opens the token page of n listed
//   tokens cold (token, trades and candles at once, as the page does) and prints the first answer's and the last's time.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { ROW_FIELDS as TERMINAL_FIELDS } from "../../apps/terminal/src/screens/discover/fields.ts";

const KEY = "helper-near-lists-and-token";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const UNLISTED = "no-rhea-pool-here.near";
/** How old an answer's X-Fetched-At may be at its read [design: the lists read every minute and date a row by its block;
 *  a tape is read again after 5 s; 10 min leaves room for a slow provider and a held answer]. */
export const AGE_MS = 600_000;
export const READS = {
  lists: () => "/v1/market/lists?chain=near",
  token: (t) => `/v1/market/token?chain=near&token=${t}`,
  holders: (t) => `/v1/market/holders?chain=near&token=${t}`,
  trades: (t) => `/v1/market/trades?chain=near&token=${t}`,
  candles: (t) => `/v1/market/candles?chain=near&token=${t}&tf=1h`,
};
export const ROW = [...TERMINAL_FIELDS];
export const PAGE = ["row", "decimals", "pool", "risk", "route", "filling", "links"];
export const RISK = ["mint_auth", "freeze_auth", "lp", "top10_bps", "dev_bps", "snipers_bps", "holders", "liq_usd", "age_s", "tax", "honeypot", "insiders_bps", "bundlers_bps", "fresh_bps"];
export const HOLDERS = ["holders", "total", "top_bps", "src", "as_of_ms"];
export const TAPE = ["t_ms", "side", "usd", "amt", "trader", "tx"];
/** The sources the helper gives each part (card every-cell-shows-a-value): the engine's keyless API's, "unrealized"
 *  (apps/helper/src/data/near/engine.ts SRC), else Rhea's fallback's: rows "chain" (near/lists.ts), holders "none"
 *  (near/token.ts), tape and chart "fastnear" (near/trades.ts). Any other src is a FAIL. */
export const SRC = {
  row: ["unrealized", "chain"],
  holders: ["unrealized", "none"],
  trades: ["unrealized", "fastnear"],
  candles: ["unrealized", "fastnear"],
};
const srcFault = (part, b) => (SRC[part].includes(b.src) ? null : `src ${show(b.src)}`);
const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const DEC = /^\d+(\.\d+)?$/;
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (o, keys) => isObj(o) && JSON.stringify(Object.keys(o)) === JSON.stringify(keys);
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** The token the check reads: the first row of trending_1h, else of new; null when neither holds one. */
export function pick(snapshot) {
  const rows = ["trending_1h", "new"].flatMap((k) => (Array.isArray(snapshot?.lists?.[k]) ? snapshot.lists[k] : [])).filter((r) => isObj(r) && typeof r.token === "string" && ACCOUNT.test(r.token));
  return rows[0] ?? null;
}

const rowFault = (r) => {
  if (!isObj(r) || JSON.stringify(Object.keys(r).sort()) !== JSON.stringify([...ROW].sort())) return `row ${show(r?.token)}: not the Row fields`;
  if (r.chain !== "near") return `row ${r.token}: chain ${show(r.chain)}`;
  if (!SRC.row.includes(r.src)) return `row ${r.token}: src ${show(r.src)}`;
  if (r.price_usd !== null && !DEC.test(r.price_usd)) return `row ${r.token}: price ${show(r.price_usd)}`;
  return null;
};

/** The first thing wrong with each body, or null. */
export const FAULTS = {
  lists: (b) => {
    if (!isObj(b) || b.chain !== "near" || !isObj(b.lists) || !Number.isSafeInteger(b.as_of_ms)) return "not NEAR's snapshot";
    if (!Array.isArray(b.lists.new) || !Array.isArray(b.lists.trending)) return "new or trending missing";
    if (b.lists.new.length + b.lists.trending.length === 0) return "no rows";
    for (const rows of Object.values(b.lists)) for (const r of rows) if (rowFault(r) !== null) return rowFault(r);
    return null;
  },
  token: (b, row) => {
    if (!same(b, PAGE)) return "page: not the page fields";
    if (rowFault(b.row) !== null) return rowFault(b.row);
    if (b.row.token !== row.token) return `row.token ${show(b.row.token)}, not ${row.token}`;
    if (!same(b.risk, RISK)) return "risk: not the Risk fields";
    for (const f of RISK) if (!same(b.risk[f], ["v", "src", "as_of_ms"])) return `risk.${f} ${show(b.risk[f])}`;
    if (!(Number.isInteger(b.decimals) && b.decimals >= 0 && b.decimals <= 30)) return `decimals ${show(b.decimals)}`;
    if (b.pool !== null || b.route !== "unknown" || b.filling !== false) return `pool ${show(b.pool)}, route ${show(b.route)}, filling ${show(b.filling)}`;
    if (!isObj(b.links) || !Object.entries(b.links).every(([k, v]) => ["site", "x", "telegram"].includes(k) && typeof v === "string" && /^https?:\/\/[^\s]+$/.test(v))) return `links ${show(b.links)}`;
    return null;
  },
  holders: (b) => (same(b, HOLDERS) && Array.isArray(b.holders) ? srcFault("holders", b) : "not the holders fields"),
  trades: (b) => {
    if (!same(b, ["trades", "src", "as_of_ms"]) || !Array.isArray(b.trades)) return "not the trades fields";
    if (srcFault("trades", b) !== null) return srcFault("trades", b);
    for (const t of b.trades) if (!same(t, TAPE) || (t.side !== "b" && t.side !== "s") || !DEC.test(t.usd) || !DEC.test(t.amt)) return `trade ${show(t)}`;
    return null;
  },
  candles: (b) => {
    if (!same(b, ["tf", "candles", "src", "as_of_ms"]) || b.tf !== "1h" || !Array.isArray(b.candles)) return "not the candles fields";
    if (srcFault("candles", b) !== null) return srcFault("candles", b);
    for (const c of b.candles) if (!Array.isArray(c) || c.length !== 6 || !Number.isSafeInteger(c[0]) || !c.slice(1).every((x) => DEC.test(x))) return `bar ${show(c)}`;
    return null;
  },
};

/** The check of one run: { base, readAt, reads: { lists, token, holders, trades, candles, unlisted } }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const r = run.reads ?? {};
  const lists = r.lists ?? { status: 0, headers: {}, body: "" };
  const row = lists.status === 200 ? pick(parse(lists.body)) : null;
  say(lists.status === 200 && row !== null, `GET ${READS.lists()} answers ${lists.status}${row ? `, read ${row.symbol} ${row.token}` : ", no row to read"}`);
  for (const k of ["lists", "token", "holders", "trades", "candles"]) {
    if (row === null && k !== "lists") break;
    const a = r[k] ?? { status: 0, headers: {}, body: "" };
    const h = a.headers ?? {};
    if (k !== "lists") say(a.status === 200, `GET ${READS[k](row.token)} answers ${a.status}`);
    say(/^application\/json/i.test(h["content-type"] ?? ""), `${k} Content-Type: ${show(h["content-type"])}`);
    say(SHA.test(h["x-helper-commit"] ?? ""), `${k} X-Helper-Commit: ${show(h["x-helper-commit"])}`);
    const at = Date.parse(h["x-fetched-at"] ?? "");
    say(ISO.test(h["x-fetched-at"] ?? "") && Math.abs(Date.parse(a.at ?? run.readAt) - at) <= AGE_MS, `${k} X-Fetched-At: ${show(h["x-fetched-at"])}, within ${AGE_MS / 60_000} min of its read`);
    say(h["access-control-allow-origin"] === APP, `${k} Access-Control-Allow-Origin: ${show(h["access-control-allow-origin"])}`);
    const f = a.status !== 200 ? "not a 200" : FAULTS[k](parse(a.body), row);
    say(f === null, `${k}: exactly the frozen fields${f === null ? "" : `: ${f}`}`);
  }
  if (row !== null) {
    const u = r.unlisted ?? { status: 0 };
    say(u.status === 404, `GET ${READS.token(UNLISTED)} (no Rhea pool) answers ${u.status}`);
  }
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

async function get(base, path, fetchFn) {
  const at = new Date().toISOString();
  const t0 = performance.now();
  const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
  const headers = {};
  for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
  const body = await r.text();
  return { at, ms: Math.round(performance.now() - t0), status: r.status, headers, body };
}

export async function read(base = BASE, fetchFn = fetch) {
  const readAt = new Date().toISOString();
  const reads = { lists: await get(base, READS.lists(), fetchFn) };
  const row = reads.lists.status === 200 ? pick(parse(reads.lists.body)) : null;
  if (row !== null) {
    for (const k of ["token", "holders", "trades", "candles"]) reads[k] = await get(base, READS[k](row.token), fetchFn);
    reads.unlisted = await get(base, READS.token(UNLISTED), fetchFn);
  }
  return { base, readAt, reads };
}

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const run = await read(base);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    const n = Number(opt("--speed", "0"));
    if (n > 0) {
      // n tokens of the lists not opened yet in this run, each page's three reads at once
      const s = parse(run.reads.lists.body);
      const seen = new Set([pick(s)?.token]);
      const tokens = [...new Set(["trending_1h", "new"].flatMap((k) => s?.lists?.[k] ?? []).map((r) => r.token))].filter((t) => !seen.has(t)).slice(0, n);
      const first = [];
      const held = [];
      for (const t of tokens) {
        const t0 = performance.now();
        const done = [];
        await Promise.all(["token", "trades", "candles"].map((k) => get(base, READS[k](t), fetch).then((x) => done.push([k, x.status, performance.now() - t0]))));
        first.push(Math.round(Math.min(...done.map((d) => d[2]))));
        held.push(Math.round(Math.max(...done.map((d) => d[2]))));
        console.log(`speed: ${t} ${done.map(([k, s, ms]) => `${k} ${s} ${Math.round(ms)} ms`).join(", ")}`);
      }
      console.log(`speed: ${tokens.length} cold NEAR token pages, first answer p50 ${pct(first, 50)} ms p95 ${pct(first, 95)} ms, rows held p50 ${pct(held, 50)} ms p95 ${pct(held, 95)} ms`);
    }
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
