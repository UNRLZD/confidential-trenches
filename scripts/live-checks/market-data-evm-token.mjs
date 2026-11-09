#!/usr/bin/env node
// Live check of card market-data-evm-token: Base's and Robinhood's token page and holders come from the helper in the
// Solana path's frozen fields (06b §6.1 TokenPage, Risk, Field and Holders; apps/helper/src/data/evm/token.ts). For each
// chain it reads the helper's own lists at HELPER_HOST, takes one token from them (the first launchpad-tagged row of
// trending_1h, then new, else the first row), and reads with Origin APP_HOST:
//   GET /v1/market/token?chain=<chain>&token=<address>
//   GET /v1/market/holders?chain=<chain>&token=<address>
//   GET /v1/market/token?chain=<chain>&token=0x000000000000000000000000000000000000dead (an address no list holds)
// It passes only when the lists answer 200 with a row, the token and holders answer 200 JSON with X-Helper-Commit a full
// sha, X-Fetched-At an ISO time within 10 minutes of that answer's own read and Access-Control-Allow-Origin echoing
// APP_HOST, and their bodies hold exactly the frozen fields in their wire forms:
//   - token: {row, decimals, pool, risk, route, filling}; `row` exactly the terminal's Row fields
//     (apps/terminal/src/screens/discover/fields.ts) with chain <chain>, token <address> and the launchpad the lists'
//     row carries (the lists' maker read on chain, so the page's tag is the list's); `risk` exactly the 14 Risk fields,
//     each {v, src, as_of_ms}; decimals null or 0-30; pool null or a 0x pool address or v4 id; route "unknown";
//   - holders: {holders, total, top_bps, src, as_of_ms}, at most 20 rows {addr, amt, bps[, kind]};
// and the address no list holds answers 404. A 404 for the listed token, or a field missing or extra, is a FAIL.
// After: helper
//   node scripts/live-checks/market-data-evm-token.mjs [--base <url>] [--record <file>] [--speed <n>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read; --speed times n more page reads a chain.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { ROW_FIELDS as TERMINAL_FIELDS } from "../../apps/terminal/src/screens/discover/fields.ts";

const KEY = "market-data-evm-token";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const CHAINS = ["base", "robinhood"];
export const UNLISTED = "0x000000000000000000000000000000000000dead";
export const READS = {
  lists: (c) => `/v1/market/lists?chain=${c}`,
  token: (c, t) => `/v1/market/token?chain=${c}&token=${t}`,
  holders: (c, t) => `/v1/market/holders?chain=${c}&token=${t}`,
};
export const ROW = [...TERMINAL_FIELDS];
export const PAGE = ["row", "decimals", "pool", "risk", "route", "filling"];
export const RISK = ["mint_auth", "freeze_auth", "lp", "top10_bps", "dev_bps", "snipers_bps", "holders", "liq_usd", "age_s", "tax", "honeypot", "insiders_bps", "bundlers_bps", "fresh_bps"];
export const HOLDERS = ["holders", "total", "top_bps", "src", "as_of_ms"];
const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const ADDR = /^0x[0-9a-f]{40}$/;
const POOL = /^0x([0-9a-f]{40}|[0-9a-f]{64})$/;
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (o, keys) => isObj(o) && JSON.stringify(Object.keys(o)) === JSON.stringify(keys);
const keysOf = (o) => (isObj(o) ? Object.keys(o) : []);
const diff = (o, keys) => {
  const k = keysOf(o);
  const missing = keys.filter((x) => !k.includes(x));
  const extra = k.filter((x) => !keys.includes(x));
  return `${missing.length ? `missing ${missing.join(", ")}` : ""}${missing.length && extra.length ? "; " : ""}${extra.length ? `extra ${extra.join(", ")}` : ""}${!missing.length && !extra.length ? "out of order" : ""}`;
};
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** The token the check reads from one chain's lists answer: the first tagged row of trending_1h, then new, else the
 *  first row of either; null when they hold none. */
export function pick(snapshot) {
  const rows = ["trending_1h", "new"].flatMap((k) => (Array.isArray(snapshot?.lists?.[k]) ? snapshot.lists[k] : [])).filter((r) => isObj(r) && ADDR.test(r.token));
  return rows.find((r) => typeof r.launchpad === "string") ?? rows[0] ?? null;
}

/** The first thing wrong with a page body for `row` (the lists' row of the token) on `chain`, or null. */
export function pageFault(chain, row, p) {
  if (!same(p, PAGE)) return `page: ${diff(p, PAGE)}`;
  if (!same(p.row, ROW)) return `row: ${diff(p.row, ROW)}`;
  if (p.row.chain !== chain) return `row.chain ${show(p.row.chain)}, not ${chain}`;
  if (p.row.token !== row.token) return `row.token ${show(p.row.token)}, not ${row.token}`;
  if (p.row.launchpad !== row.launchpad) return `row.launchpad ${show(p.row.launchpad)}, the lists' row says ${show(row.launchpad)}`;
  for (const f of ["symbol", "name", "src"]) if (typeof p.row[f] !== "string" || p.row[f] === "") return `row.${f} ${show(p.row[f])}`;
  if (!same(p.risk, RISK)) return `risk: ${diff(p.risk, RISK)}`;
  for (const f of RISK) {
    const x = p.risk[f];
    if (!same(x, ["v", "src", "as_of_ms"]) || typeof x.src !== "string" || x.src === "" || !Number.isSafeInteger(x.as_of_ms)) return `risk.${f} ${show(x)}`;
  }
  if (p.decimals !== null && !(Number.isInteger(p.decimals) && p.decimals >= 0 && p.decimals <= 30)) return `decimals ${show(p.decimals)}`;
  if (p.pool !== null && !(typeof p.pool === "string" && POOL.test(p.pool))) return `pool ${show(p.pool)}`;
  if (p.route !== "unknown") return `route ${show(p.route)}`;
  if (typeof p.filling !== "boolean") return `filling ${show(p.filling)}`;
  return null;
}

/** The first thing wrong with a holders body, or null. */
export function holdersFault(h) {
  if (!same(h, HOLDERS)) return `holders: ${diff(h, HOLDERS)}`;
  if (!Array.isArray(h.holders) || h.holders.length > 20) return `holders ${Array.isArray(h.holders) ? `${h.holders.length} rows, over 20` : "not a list"}`;
  for (const r of h.holders) {
    if (!isObj(r) || typeof r.addr !== "string" || typeof r.amt !== "string" || !/^\d{1,40}$/.test(r.amt)) return `holder row ${show(r)}`;
    if (keysOf(r).some((k) => !["addr", "amt", "bps", "kind"].includes(k))) return `holder row ${show(r)}`;
  }
  if (h.total !== null && !(Number.isSafeInteger(h.total) && h.total >= 0)) return `total ${show(h.total)}`;
  if (h.top_bps !== null && !(Number.isInteger(h.top_bps) && h.top_bps >= 0 && h.top_bps <= 10_000)) return `top_bps ${show(h.top_bps)}`;
  if (typeof h.src !== "string" || h.src === "" || !Number.isSafeInteger(h.as_of_ms)) return `src ${show(h.src)}, as_of_ms ${show(h.as_of_ms)}`;
  return null;
}

/** The check of one run: { base, readAt, chains: { <chain>: { lists, token, holders, unlisted } } }, each a read
 *  { at, ms, status, headers, body }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const chain of CHAINS) {
    const c = run.chains?.[chain] ?? {};
    const lists = c.lists ?? { status: 0, headers: {}, body: "" };
    const row = lists.status === 200 ? pick(parse(lists.body)) : null;
    say(lists.status === 200 && row !== null, `${chain}: GET ${READS.lists(chain)} answers ${lists.status}${row ? `, read ${row.symbol} ${row.token} (launchpad ${show(row.launchpad)})` : ", no row to read"}`);
    if (row === null) continue;
    for (const k of ["token", "holders"]) {
      const r = c[k] ?? { status: 0, headers: {}, body: "" };
      const h = r.headers ?? {};
      say(r.status === 200, `${chain}: GET ${READS[k](chain, row.token)} answers ${r.status}`);
      say(/^application\/json/i.test(h["content-type"] ?? ""), `${chain} ${k} Content-Type: ${show(h["content-type"])}`);
      say(SHA.test(h["x-helper-commit"] ?? ""), `${chain} ${k} X-Helper-Commit: ${show(h["x-helper-commit"])}`);
      const at = Date.parse(h["x-fetched-at"] ?? "");
      const ref = Date.parse(r.at ?? run.readAt);
      say(ISO.test(h["x-fetched-at"] ?? "") && Math.abs(ref - at) <= 600_000, `${chain} ${k} X-Fetched-At: ${show(h["x-fetched-at"])}, within 10 min of its read at ${r.at ?? run.readAt}`);
      say(h["access-control-allow-origin"] === APP, `${chain} ${k} Access-Control-Allow-Origin: ${show(h["access-control-allow-origin"])}`);
      const b = parse(r.body);
      const f = r.status !== 200 ? "not a 200" : k === "token" ? pageFault(chain, row, b) : holdersFault(b);
      say(f === null, `${chain} ${k}: exactly the frozen fields in their wire forms${f === null ? "" : `: ${f}`}`);
      if (f === null && k === "token") lines.push(`--  ${chain} page: decimals ${show(b.decimals)}, holders ${show(b.row.holders)}, top 10 ${show(b.row.top10_bps)} bps, price ${show(b.row.price_usd)}, mc ${show(b.row.mc_usd)}, liq ${show(b.row.liq_usd)}`);
    }
    const u = c.unlisted ?? { status: 0 };
    say(u.status === 404, `${chain}: GET ${READS.token(chain, UNLISTED)} (no list holds it) answers ${u.status}`);
  }
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

async function get(base, path, fetchFn) {
  // the read's own time, which its X-Fetched-At is judged against
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
  const chains = {};
  for (const chain of CHAINS) {
    const lists = await get(base, READS.lists(chain), fetchFn);
    const row = lists.status === 200 ? pick(parse(lists.body)) : null;
    chains[chain] = { lists };
    if (row === null) continue;
    chains[chain].token = await get(base, READS.token(chain, row.token), fetchFn);
    chains[chain].holders = await get(base, READS.holders(chain, row.token), fetchFn);
    chains[chain].unlisted = await get(base, READS.token(chain, UNLISTED), fetchFn);
  }
  return { base, readAt, chains };
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
    for (const chain of CHAINS) {
      const c = run.chains[chain];
      if (c?.token) console.log(`${chain} first reads: token ${c.token.ms} ms, holders ${c.holders.ms} ms`);
    }
    const n = Number(opt("--speed", "0"));
    if (n > 0)
      for (const chain of CHAINS) {
        const row = pick(parse(run.chains[chain]?.lists?.body ?? ""));
        if (row === null) continue;
        const ms = [];
        for (let i = 0; i < n; i++) ms.push((await get(base, READS.token(chain, row.token), fetch)).ms);
        console.log(`speed: ${chain} ${n} token page reads, p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms, max ${Math.max(...ms)} ms`);
      }
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
