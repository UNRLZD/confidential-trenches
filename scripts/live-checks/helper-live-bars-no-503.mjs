#!/usr/bin/env node
// Live check of card helper-live-bars-no-503: a chart's live read of a Base token the helper holds bars for answers 200
// with the bars it holds and their age, never an error. Chrome prints "Failed to load resource" for every non-2xx answer
// and no page code can stop it (card app-chart-live, 5 Nov 13:16Z), and a 12:00Z read of 100 Base live reads of the
// deployed helper got 6 answers of 503. The helper now serves the bars it holds, dated by their read (as_of_ms and
// X-Fetched-At), when its upstream stalls or fails (apps/helper/src/data/evm/swaps.ts open), and answers 503 only for a
// token it holds nothing for.
// With Origin APP_HOST it reads Base's Discover lists at HELPER_HOST and takes up to TOKENS listed tokens (Trending 1h,
// then Trending 5m, then New, each once). Each is read once in full (GET /v1/market/candles?chain=base&token=<t>&tf=15m,
// the chart's first read): a token whose first read answers 200 with at least one bar is one the helper holds. Then
// READS live reads (the same with &limit=2, the chart's live read), turning among the held tokens, one every PACE_MS.
// It passes only when at least HELD_MIN tokens are held and every live read answers 200 JSON { tf: "15m", candles: [1 or
// 2 bars], src, as_of_ms }. A failing read is named by its token, status and time; the answers' age (read time less
// as_of_ms) is printed, so a stale serve stays on record.
//   node scripts/live-checks/helper-live-bars-no-503.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "helper-live-bars-no-503";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const TOKENS = 8;
/** Fewer held tokens than this is no test of the live reads: a FAIL, not a pass on little. */
export const HELD_MIN = 4;
/** Live reads a run makes: the brief's 100. */
export const READS = 100;
/** One live read every this long [design: a chart's live read is about once a second; 100 reads then span the minute
 *  and more in which an upstream stall shows, as the 12:00Z read did]. */
export const PACE_MS = 1_000;
const ADDRESS = /^0x[0-9a-f]{40}$/;

async function get(base, path, fetchFn) {
  const t0 = performance.now();
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
    const body = await r.text();
    return { status: r.status, at: Date.now(), ms: Math.round(performance.now() - t0), body };
  } catch (e) {
    return { status: 0, at: Date.now(), ms: Math.round(performance.now() - t0), body: "", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** The listed tokens a run reads: Trending 1h, then Trending 5m, then New, each once, at most TOKENS. */
export function tokensOf(listsBody) {
  let l;
  try {
    l = JSON.parse(listsBody).lists;
  } catch {
    return [];
  }
  const out = [];
  for (const k of ["trending_1h", "trending_5m", "new"]) for (const r of Array.isArray(l?.[k]) ? l[k] : []) if (typeof r?.token === "string" && ADDRESS.test(r.token) && !out.includes(r.token) && out.length < TOKENS) out.push(r.token);
  return out;
}

/** A candle answer's bar count and as_of_ms, or what is wrong with it. */
export function shapeOf(body) {
  try {
    const j = JSON.parse(body);
    if (j?.tf !== "15m") return { bad: `tf ${JSON.stringify(j?.tf)}` };
    if (!Array.isArray(j.candles) || !j.candles.every((c) => Array.isArray(c) && c.length === 6)) return { bad: "no candles list" };
    if (typeof j.src !== "string" || j.src === "") return { bad: "no src" };
    if (!Number.isSafeInteger(j.as_of_ms)) return { bad: "no as_of_ms" };
    return { bars: j.candles.length, asOfMs: j.as_of_ms };
  } catch {
    return { bad: "not JSON" };
  }
}

const row = (address, a) => {
  const s = a.status === 200 ? shapeOf(a.body) : null;
  return {
    address,
    status: a.status,
    ms: a.ms,
    ...(s === null ? { body: a.body.slice(0, 120) } : s.bad !== undefined ? { shape: s.bad } : { bars: s.bars, ageMs: a.at - s.asOfMs }),
    ...(a.error ? { error: a.error } : {}),
  };
};

export async function read(base = BASE, fetchFn = fetch, paceMs = PACE_MS) {
  const at = new Date().toISOString();
  const lists = await get(base, "/v1/market/lists?chain=base", fetchFn);
  const tokens = lists.status === 200 ? tokensOf(lists.body) : [];
  const first = await Promise.all(tokens.map(async (t) => row(t, await get(base, `/v1/market/candles?chain=base&token=${t}&tf=15m`, fetchFn))));
  const held = first.filter((f) => f.status === 200 && f.bars > 0).map((f) => f.address);
  const live = [];
  for (let i = 0; held.length > 0 && i < READS; i++) {
    const t0 = Date.now();
    const t = held[i % held.length];
    live.push(row(t, await get(base, `/v1/market/candles?chain=base&token=${t}&tf=15m&limit=2`, fetchFn)));
    const left = paceMs - (Date.now() - t0);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  }
  return { base, at, lists: { status: lists.status, ms: lists.ms, tokens: tokens.length }, first, live };
}

const pct = (xs, p) => (xs.length === 0 ? "-" : xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]);

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const first = run.first ?? [];
  const live = run.live ?? [];
  const held = new Set(first.filter((f) => f.status === 200 && f.bars > 0).map((f) => f.address));
  say(run.lists?.status === 200 && first.length === run.lists.tokens, `GET /v1/market/lists?chain=base answers ${run.lists?.status}, ${first.length} listed tokens read`);
  for (const f of first) lines.push(`    first read ${f.address}: ${f.status}${f.bars !== undefined ? ` ${f.bars} bars` : ` ${f.shape ?? f.body ?? ""}`}${f.error ? ` ${f.error}` : ""} in ${f.ms} ms${held.has(f.address) ? " (held)" : ""}`);
  say(held.size >= HELD_MIN, `${held.size} tokens held (at least ${HELD_MIN})`);
  say(live.length === READS, `${live.length} live reads (limit 2) made (${READS})`);
  for (const a of live) {
    const ok = held.has(a.address) && a.status === 200 && a.bars >= 1 && a.bars <= 2;
    if (!ok) say(false, `live read ${a.address}: ${a.status}${a.bars !== undefined ? ` ${a.bars} bars` : ` ${a.shape ?? a.body ?? ""}`}${a.error ? ` ${a.error}` : ""} in ${a.ms} ms${held.has(a.address) ? "" : " (not a held token)"}`);
  }
  const good = live.filter((a) => a.status === 200 && a.bars >= 1 && a.bars <= 2);
  const n503 = live.filter((a) => a.status === 503).length;
  const ms = live.map((a) => a.ms).sort((x, y) => x - y);
  const age = good.map((a) => a.ageMs).sort((x, y) => x - y);
  lines.push(`    ${good.length} of ${live.length} live reads 200, ${n503} answered 503 (p50 ${pct(ms, 0.5)} ms, p95 ${pct(ms, 0.95)} ms; age p50 ${pct(age, 0.5)} ms, max ${age.at(-1) ?? "-"} ms)`);
  return { ok: lines.filter((l) => !l.startsWith("    ")).every((l) => l.startsWith("ok ")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE), fetch);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
