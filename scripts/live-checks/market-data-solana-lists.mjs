#!/usr/bin/env node
// Live check of card market-data-solana-lists: Discover's Solana lists come from the helper in the frozen field lists
// (markets paper M4.2, D1.1, M:3366-3367; apps/helper/src/data/solana/lists.ts). It reads
// GET /v1/market/lists?chain=solana at HELPER_HOST with Origin APP_HOST and passes only when:
//   - the answer is 200 JSON, X-Helper-Commit a full sha, X-Helper-Source "jupiter", X-Fetched-At an ISO time within
//     10 minutes of the read, and Access-Control-Allow-Origin echoes APP_HOST;
//   - the body is 06b's `snapshot`: chain "solana", `as_of_ms` within 10 minutes of the read, and the five lists new,
//     trending, trending_5m, trending_1h and graduating, each an array of at most 100 rows; new and trending_1h hold
//     rows, and trending equals trending_1h;
//   - every row of every list holds exactly the frozen field list: the terminal's ROW_FIELDS, read from
//     apps/terminal/src/screens/discover/fields.ts itself, plus buys_1h and sells_1h; every required field
//     (ROW_REQUIRED) set; USD values decimal strings, shares, changes and counts integers, chain "solana";
//   - every graduating row is on a curve by the terminal's one rule (a launchpad, curve_bps a whole number 0-9999).
// After: helper
//   node scripts/live-checks/market-data-solana-lists.mjs [--base <url>] [--record <file>] [--speed <n>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read; --speed times n more reads (printed).
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { ROW_FIELDS as TERMINAL_FIELDS, ROW_REQUIRED } from "../../apps/terminal/src/screens/discover/fields.ts";

const KEY = "market-data-solana-lists";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const PATH = "/v1/market/lists?chain=solana";
/** The frozen list: the terminal's Row fields, then the two the Trending column asked for. */
export const FIELDS = [...new Set([...TERMINAL_FIELDS, "buys_1h", "sells_1h"])];
export const LISTS = ["new", "trending", "trending_5m", "trending_1h", "graduating"];
const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const DEC = /^-?\d+(\.\d+)?$/;

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const isUsd = (f) => f.endsWith("_usd");
const isInt = (f) => f.endsWith("_bps") || f === "holders" || f === "created_s" || f === "as_of_ms" || f.startsWith("buys_") || f.startsWith("sells_");

/** The first thing wrong with one row, or null. */
export function rowFault(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "not an object";
  const keys = Object.keys(r);
  const missing = FIELDS.filter((f) => !keys.includes(f));
  if (missing.length) return `missing ${missing.join(", ")}`;
  const extra = keys.filter((k) => !FIELDS.includes(k));
  if (extra.length) return `extra ${extra.join(", ")}`;
  for (const f of ROW_REQUIRED) if (r[f] === undefined || (r[f] === null && f !== "price_usd" && f !== "launchpad")) return `${f} unset`;
  if (r.chain !== "solana") return `chain ${show(r.chain)}`;
  for (const f of ["token", "symbol", "name", "src"]) if (typeof r[f] !== "string" || r[f] === "") return `${f} ${show(r[f])}`;
  if (typeof r.icon !== "boolean") return `icon ${show(r.icon)}`;
  for (const f of FIELDS.filter(isUsd)) if (r[f] !== null && !(typeof r[f] === "string" && DEC.test(r[f]))) return `${f} ${show(r[f])}`;
  for (const f of FIELDS.filter(isInt)) if (r[f] !== null && !Number.isSafeInteger(r[f])) return `${f} ${show(r[f])}`;
  if (r.launchpad !== null && typeof r.launchpad !== "string") return `launchpad ${show(r.launchpad)}`;
  if (r.curve_bps !== null && !(r.curve_bps >= 0 && r.curve_bps <= 10000)) return `curve_bps ${show(r.curve_bps)}`;
  return null;
}

/** The check on one recorded read { status, headers, body, readAt }. */
export function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(r.status === 200, `GET ${PATH} answers ${r.status}`);
  const h = r.headers;
  const readAt = Date.parse(r.readAt);
  say(/^application\/json/i.test(h["content-type"] ?? ""), `Content-Type: ${show(h["content-type"])}`);
  say(SHA.test(h["x-helper-commit"] ?? ""), `X-Helper-Commit: ${show(h["x-helper-commit"])}`);
  say(h["x-helper-source"] === "jupiter", `X-Helper-Source: ${show(h["x-helper-source"])}`);
  const at = Date.parse(h["x-fetched-at"] ?? "");
  say(ISO.test(h["x-fetched-at"] ?? "") && Math.abs(readAt - at) <= 600_000, `X-Fetched-At: ${show(h["x-fetched-at"])}, within 10 min of the read at ${r.readAt}`);
  say(h["access-control-allow-origin"] === APP, `Access-Control-Allow-Origin: ${show(h["access-control-allow-origin"])}`);
  let s;
  try {
    s = JSON.parse(r.body);
  } catch {
    s = undefined;
  }
  const lists = s && typeof s === "object" && s.lists && typeof s.lists === "object" ? s.lists : {};
  say(s?.chain === "solana", `chain: ${show(s?.chain)}`);
  say(Number.isSafeInteger(s?.as_of_ms) && Math.abs(readAt - s.as_of_ms) <= 600_000, `as_of_ms: ${show(s?.as_of_ms)}, within 10 min of the read`);
  say(JSON.stringify(Object.keys(lists)) === JSON.stringify(LISTS), `lists: ${show(Object.keys(lists))}`);
  for (const k of LISTS) {
    const rows = lists[k];
    if (!Array.isArray(rows) || rows.length > 100) {
      say(false, `${k}: ${Array.isArray(rows) ? `${rows.length} rows, over 100` : "not a list"}`);
      continue;
    }
    const faults = rows.map((row, i) => [i, rowFault(row)]).filter(([, f]) => f !== null);
    say(faults.length === 0, `${k}: ${rows.length} rows, each with exactly the ${FIELDS.length} fields in their wire forms${faults.length ? `: ${faults.length} not, first row ${faults[0][0]} (${show(rows[faults[0][0]]?.symbol)}) ${faults[0][1]}` : ""}`);
  }
  say(Array.isArray(lists.new) && lists.new.length > 0, `new holds rows: ${lists.new?.length ?? 0}`);
  say(Array.isArray(lists.trending_1h) && lists.trending_1h.length > 0, `trending_1h holds rows: ${lists.trending_1h?.length ?? 0}`);
  say(Array.isArray(lists.trending) && JSON.stringify(lists.trending) === JSON.stringify(lists.trending_1h), "trending equals trending_1h");
  const g = Array.isArray(lists.graduating) ? lists.graduating : [];
  const off = g.filter((r) => !(r && typeof r.launchpad === "string" && Number.isInteger(r.curve_bps) && r.curve_bps >= 0 && r.curve_bps < 10000));
  say(off.length === 0, `graduating: every row on a curve (a launchpad and curve_bps 0-9999)${off.length ? `: ${off.length} not` : ""}`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

export async function read(base = BASE, fetchFn = fetch) {
  const readAt = new Date().toISOString();
  const t0 = performance.now();
  const r = await fetchFn(`${base.replace(/\/$/, "")}${PATH}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
  const headers = {};
  for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
  const body = await r.text();
  return { base, readAt, ms: Math.round(performance.now() - t0), status: r.status, headers, body };
}

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const answer = await read(base);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, lines } = judge(answer);
    for (const l of lines) console.log(l);
    const n = Number(opt("--speed", "0"));
    if (n > 0) {
      const ms = [];
      for (let i = 0; i < n; i++) ms.push((await read(base)).ms);
      console.log(`speed: ${n} reads, p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms, max ${Math.max(...ms)} ms (first read ${answer.ms} ms)`);
    }
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${answer.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
