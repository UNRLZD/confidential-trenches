#!/usr/bin/env node
// Live check of card market-data-evm-lists: Discover's EVM lists come from the helper in the frozen field list, every
// row tagged with the launchpad whose factory made the token (apps/helper/src/data/evm/lists.ts). For each chain it
// reads GET /v1/market/lists?chain=<chain> at HELPER_HOST with Origin APP_HOST and passes only when:
//   - the answer is 200 JSON, X-Helper-Commit a full sha, X-Helper-Source "geckoterminal", X-Fetched-At an ISO time
//     within 10 minutes of the read, and Access-Control-Allow-Origin echoes APP_HOST;
//   - the body is 06b's `snapshot`: chain <chain>, `as_of_ms` within 10 minutes of the read, the five lists new,
//     trending, trending_5m, trending_1h and graduating, each at most 100 rows; new and trending_1h hold rows, trending
//     equals trending_1h;
//   - every row holds exactly the terminal's ROW_FIELDS (apps/terminal/src/screens/discover/fields.ts) in their wire
//     forms, chain <chain>, token a lowercase 0x address, launchpad null or one of the chain's table pads;
//   - the maker, re-read on chain: for up to SAMPLE tagged rows and SAMPLE untagged rows (each list's first), the
//     table's creation events over the row's pool block, read here on the chain's providers (MAKER_RPCS: two that
//     answer and agree), name the same pad as the row, or none for an untagged row. A row the read does not settle is
//     said, not failed; a sample with tagged rows and none of them settled is a FAIL, since then nothing was re-read.
//   node scripts/live-checks/market-data-evm.mjs [--base <url>] [--chain base] [--record <file>] [--speed <n>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read (the helper's answer and every RPC answer).
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { ROW_FIELDS, ROW_REQUIRED } from "../../apps/terminal/src/screens/discover/fields.ts";
import { FACTORIES, readMakers } from "../../apps/helper/src/data/evm/lists.ts";

const KEY = "market-data-evm";
export const BASE = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
/** The chains whose lists the helper serves (fold 1: Base). */
export const CHAINS = ["base", "robinhood"];
export const FIELDS = [...ROW_FIELDS];
export const LISTS = ["new", "trending", "trending_5m", "trending_1h", "graduating"];
export const SAMPLE = 6;
const path = (chain) => `/v1/market/lists?chain=${chain}`;
const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const DEC = /^-?\d+(\.\d+)?$/;
const ADDR = /^0x[0-9a-f]{40}$/;

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const isUsd = (f) => f.endsWith("_usd");
const isInt = (f) => f.endsWith("_bps") || f === "holders" || f === "created_s" || f === "as_of_ms" || f.startsWith("buys_") || f.startsWith("sells_");

/** The first thing wrong with one row, or null. */
export function rowFault(chain, r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "not an object";
  const keys = Object.keys(r);
  const missing = FIELDS.filter((f) => !keys.includes(f));
  if (missing.length) return `missing ${missing.join(", ")}`;
  const extra = keys.filter((k) => !FIELDS.includes(k));
  if (extra.length) return `extra ${extra.join(", ")}`;
  for (const f of ROW_REQUIRED) if (r[f] === undefined || (r[f] === null && f !== "price_usd" && f !== "launchpad")) return `${f} unset`;
  if (r.chain !== chain) return `chain ${show(r.chain)}`;
  if (!ADDR.test(r.token)) return `token ${show(r.token)}`;
  for (const f of ["symbol", "name", "src"]) if (typeof r[f] !== "string" || r[f] === "") return `${f} ${show(r[f])}`;
  if (typeof r.icon !== "boolean") return `icon ${show(r.icon)}`;
  for (const f of FIELDS.filter(isUsd)) if (r[f] !== null && !(typeof r[f] === "string" && DEC.test(r[f]))) return `${f} ${show(r[f])}`;
  for (const f of FIELDS.filter(isInt)) if (r[f] !== null && !Number.isSafeInteger(r[f])) return `${f} ${show(r[f])}`;
  const pads = new Set(FACTORIES[chain].map((x) => x.pad));
  if (r.launchpad !== null && !pads.has(r.launchpad)) return `launchpad ${show(r.launchpad)}, not a table pad`;
  return null;
}

/** The rows whose maker the check re-reads: up to SAMPLE tagged and SAMPLE untagged, each token once. */
export function sample(lists) {
  const seen = new Set();
  const all = LISTS.flatMap((k) => (Array.isArray(lists[k]) ? lists[k] : [])).filter((r) => r && ADDR.test(r.token) && Number.isSafeInteger(r.created_s) && !seen.has(r.token) && seen.add(r.token));
  return [...all.filter((r) => typeof r.launchpad === "string").slice(0, SAMPLE), ...all.filter((r) => r.launchpad === null).slice(0, SAMPLE)];
}

/** The check of one chain's read: { status, headers, body, readAt } and the makers re-read for its sample. */
export function judge(chain, r, makers) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(r.status === 200, `GET ${path(chain)} answers ${r.status}`);
  const h = r.headers;
  const readAt = Date.parse(r.readAt);
  say(/^application\/json/i.test(h["content-type"] ?? ""), `Content-Type: ${show(h["content-type"])}`);
  say(SHA.test(h["x-helper-commit"] ?? ""), `X-Helper-Commit: ${show(h["x-helper-commit"])}`);
  say(h["x-helper-source"] === "geckoterminal", `X-Helper-Source: ${show(h["x-helper-source"])}`);
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
  say(s?.chain === chain, `chain: ${show(s?.chain)}`);
  say(Number.isSafeInteger(s?.as_of_ms) && Math.abs(readAt - s.as_of_ms) <= 600_000, `as_of_ms: ${show(s?.as_of_ms)}, within 10 min of the read`);
  say(JSON.stringify(Object.keys(lists)) === JSON.stringify(LISTS), `lists: ${show(Object.keys(lists))}`);
  for (const k of LISTS) {
    const rows = lists[k];
    if (!Array.isArray(rows) || rows.length > 100) {
      say(false, `${k}: ${Array.isArray(rows) ? `${rows.length} rows, over 100` : "not a list"}`);
      continue;
    }
    const faults = rows.map((row, i) => [i, rowFault(chain, row)]).filter(([, f]) => f !== null);
    say(faults.length === 0, `${k}: ${rows.length} rows, each with exactly the ${FIELDS.length} fields in their wire forms${faults.length ? `: ${faults.length} not, first row ${faults[0][0]} (${show(rows[faults[0][0]]?.symbol)}) ${faults[0][1]}` : ""}`);
  }
  say(Array.isArray(lists.new) && lists.new.length > 0, `new holds rows: ${lists.new?.length ?? 0}`);
  say(Array.isArray(lists.trending_1h) && lists.trending_1h.length > 0, `trending_1h holds rows: ${lists.trending_1h?.length ?? 0}`);
  say(Array.isArray(lists.trending) && JSON.stringify(lists.trending) === JSON.stringify(lists.trending_1h), "trending equals trending_1h");
  const rows = sample(lists);
  let tagged = 0;
  let taggedRead = 0;
  for (const row of rows) {
    const m = makers.get(row.token);
    if (typeof row.launchpad === "string") tagged++;
    if (m === undefined) {
      lines.push(`--  ${row.symbol} ${row.token}: maker not settled by this read (a provider did not answer, the two differ, or its creation block is still to be searched)`);
      continue;
    }
    if (typeof row.launchpad === "string") taggedRead++;
    say(m === row.launchpad, `${row.symbol} ${row.token}: tagged ${show(row.launchpad)}, the creation events read on chain (two providers that agree) name ${show(m)}`);
  }
  say(tagged === 0 || taggedRead > 0, `tagged rows re-read on chain: ${taggedRead} of ${tagged} sampled`);
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

/** The pad the helper's own maker read (readMakers: two providers that answer and agree) names for each sampled row,
 *  re-read now from here; a row is absent when it did not settle. `log` gets every RPC request and answer. */
export async function rereadMakers(chain, rows, fetchFn = fetch, log = [], nowMs = Date.now()) {
  const logged = async (url, init) => {
    const r = await fetchFn(url, init);
    const text = await r.text();
    let answer;
    try {
      answer = JSON.parse(text);
    } catch {
      answer = text.slice(0, 200);
    }
    log.push({ url, request: JSON.parse(init.body), status: r.status, answer });
    return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
  };
  // one row at a time, so each row's reads are its own whatever else the sample holds
  const out = new Map();
  for (const r of rows) for (const [t, pad] of await readMakers(chain, logged, [{ token: r.token, createdS: r.created_s }], nowMs)) out.set(t, pad);
  return out;
}

export async function read(chain, base = BASE, fetchFn = fetch) {
  const readAt = new Date().toISOString();
  const t0 = performance.now();
  const r = await fetchFn(`${base.replace(/\/$/, "")}${path(chain)}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
  const headers = {};
  for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
  const body = await r.text();
  return { base, readAt, ms: Math.round(performance.now() - t0), status: r.status, headers, body };
}

/** Read and judge one chain: the helper's answer, then the sample's makers on chain. */
export async function check(chain, base = BASE, fetchFn = fetch, nowMs = Date.now()) {
  const answer = await read(chain, base, fetchFn);
  let lists = {};
  try {
    lists = JSON.parse(answer.body)?.lists ?? {};
  } catch {
    lists = {};
  }
  const rpc = [];
  const makers = await rereadMakers(chain, sample(lists), fetchFn, rpc, nowMs);
  return { answer, rpc, ...judge(chain, answer, makers) };
}

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const chains = opt("--chain") ? [opt("--chain")] : CHAINS;
    let ok = true;
    const record = {};
    for (const chain of chains) {
      const r = await check(chain, base);
      record[chain] = { answer: r.answer, rpc: r.rpc };
      for (const l of r.lines) console.log(`${chain}: ${l}`);
      ok &&= r.ok;
      const n = Number(opt("--speed", "0"));
      if (n > 0) {
        const ms = [];
        for (let i = 0; i < n; i++) ms.push((await read(chain, base)).ms);
        console.log(`${chain}: speed: ${n} reads, p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms, max ${Math.max(...ms)} ms (first read ${r.answer.ms} ms)`);
      }
    }
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(record, null, 1)}\n`);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
