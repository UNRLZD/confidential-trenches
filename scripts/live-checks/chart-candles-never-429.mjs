#!/usr/bin/env node
// Live check of card chart-candles-never-429: no viewer's chart read is ever answered 429, and several viewers behind
// one address read one shared answer. Live run 43396216450 (13 Nov 08:54-08:56Z, helper 6de76338d) logged "refused
// /v1/market/candles geckoterminal budget" three times while GeckoTerminal's own 429 count was 0 and 1: the helper's own
// budget (5 calls in 75 s) refused cold charts with nothing held, the route answered 429, and the browser logged a failed
// load on the token page (app-shell BAD on "/" and "/token/<first listed>"). The helper now answers such a read 200 with
// no bars and `filling` true, which the page reads again FILL_WAIT_MS on, on every chain (apps/helper/src/server.ts
// fillingOf), and serves a cached proxy answer, or a call joining one in flight, with no draw on the caller's share
// (apps/helper/src/proxy/proxy.ts).
// From one address (this runner), with Origin APP_HOST, it opens CHARTS charts at once, each by VIEWERS viewers side by
// side: BONK on Solana (off Discover's lists, GeckoTerminal's bars) and the first rows of Solana's and Base's Discover
// lists, all at tf 15m, the chart's first read. Each viewer reads as the page does: a 200 `filling` with no bars again
// FILL_WAIT_MS on, until the span SPAN_S is waited (apps/terminal/src/screens/token/candles.ts THROTTLE_SPAN_S). Then
// PROXY_VIEWERS reads of 1Click's token list (POST /v1/proxy/oneclick/v0/tokens, kept 5 s, a share of 5 an address) at
// once. Want: BONK's chart among those opened, no read answered 429, every read answered within ANSWER_MS (the page's
// read gives up at 10 s), every token-list read 200. Whether each chart's viewers end on bars inside the span is
// printed, not judged: under a live run's load it is GeckoTerminal's keyless capacity (5 calls in 75 s for the whole
// helper, apps/helper/src/data/gecko.ts), not a refusal of ours, and a chart still filling at the span's end is the
// page's loading state, never a failed load.
// After: helper
//   node scripts/live-checks/chart-candles-never-429.mjs [--base <url>] [--charts <chain>:<token>,...] [--record <file>]
//     --charts: the charts to open in place of BONK and the lists' first rows (a local helper with no vendor key, whose
//     Solana lists cannot answer)
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { FILL_WAIT_MS, THROTTLE_SPAN_S } from "../../apps/terminal/src/screens/token/candles.ts";

const KEY = "chart-candles-never-429";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** BONK: the chart app-faults-seen-on-126 opens. */
export const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
/** Viewers of each chart behind this one address [design: a judge room's laptops, or the live run's checks]. */
export const VIEWERS = 6;
/** Readers of the cached token list at once: more than 1Click's share of 5 an address. */
export const PROXY_VIEWERS = 12;
/** BONK and each list's first row: at most this many charts. */
export const CHARTS = 3;
export const SPAN_S = THROTTLE_SPAN_S;
/** The longest a chart read may take to answer: the helper's bound (apps/helper/src/server.ts CANDLES_ANSWER_MS, 5 s) and
 *  room for the way there and back, under the page's 10 s request (candles.ts TIMEOUT_MS). */
export const ANSWER_MS = 8_000;
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[0-9a-f]{40}$/;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function ask(base, path, fetchFn, method = "GET") {
  const t0 = performance.now();
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { method, redirect: "manual", headers: { origin: APP, "cache-control": "no-cache", ...(method === "POST" ? { "content-type": "application/json" } : {}) }, ...(method === "POST" ? { body: "" } : {}), signal: AbortSignal.timeout(30_000) });
    const body = await r.text();
    return { status: r.status, ms: Math.round(performance.now() - t0), body };
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t0), body: "", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** A candles answer as the page reads it: its bar count and whether it is filling, or what is wrong with it. */
export function shapeOf(body) {
  try {
    const j = JSON.parse(body);
    if (j?.tf !== "15m" || !Array.isArray(j.candles) || typeof j.src !== "string" || !Number.isSafeInteger(j.as_of_ms)) return { bad: "not a 15m candles answer" };
    return { bars: j.candles.length, filling: j.filling === true };
  } catch {
    return { bad: "not JSON" };
  }
}

/** The first listed token of a lists answer (Trending 1h's first row, else any list's), or null. */
export function firstListed(body, re) {
  try {
    const l = JSON.parse(body).lists;
    for (const k of ["trending_1h", "trending_5m", "new"]) for (const r of Array.isArray(l?.[k]) ? l[k] : []) if (typeof r?.token === "string" && re.test(r.token)) return r.token;
  } catch {
    // no token
  }
  return null;
}

/** One viewer's reads of one chart: as the page's first read, again FILL_WAIT_MS on while it is filling, within SPAN_S. */
async function viewer(base, chain, token, fetchFn, wait) {
  const reads = [];
  const t0 = Date.now();
  for (;;) {
    const a = await ask(base, `/v1/market/candles?chain=${chain}&token=${token}&tf=15m`, fetchFn);
    const s = a.status === 200 ? shapeOf(a.body) : null;
    reads.push({ status: a.status, ms: a.ms, ...(s === null ? { body: a.body.slice(0, 120) } : s.bad !== undefined ? { shape: s.bad } : { bars: s.bars, filling: s.filling }), ...(a.error ? { error: a.error } : {}) });
    if (!(a.status === 200 && s?.filling === true && s.bars === 0) || Date.now() - t0 + FILL_WAIT_MS > SPAN_S * 1000) return reads;
    await wait(FILL_WAIT_MS);
  }
}

export async function read(base = BASE, fetchFn = fetch, wait = sleep, given = null) {
  const at = new Date().toISOString();
  const [sol, evm] = given !== null ? [{ status: null }, { status: null }] : await Promise.all([ask(base, "/v1/market/lists?chain=solana", fetchFn), ask(base, "/v1/market/lists?chain=base", fetchFn)]);
  const picks = given ?? [["solana", BONK], ["solana", sol.status === 200 ? firstListed(sol.body, SOL) : null], ["base", evm.status === 200 ? firstListed(evm.body, EVM) : null]];
  const seen = new Set();
  const charts = picks.filter(([c, t]) => t !== null && !seen.has(`${c}:${t}`) && seen.add(`${c}:${t}`)).slice(0, CHARTS);
  const opened = await Promise.all(charts.map(async ([chain, token]) => ({ chain, address: token, viewers: await Promise.all(Array.from({ length: VIEWERS }, () => viewer(base, chain, token, fetchFn, wait))) })));
  const proxy = (await Promise.all(Array.from({ length: PROXY_VIEWERS }, () => ask(base, "/v1/proxy/oneclick/v0/tokens", fetchFn, "POST")))).map((a) => ({ status: a.status, ms: a.ms, ...(a.error ? { error: a.error } : {}) }));
  return { base, at, lists: { solana: sol.status, base: evm.status }, charts: opened, proxy };
}

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const charts = run.charts ?? [];
  say(charts.some((c) => c.chain === "solana" && c.address === BONK) && charts.length <= CHARTS, `${charts.length} chart(s) opened, BONK's among them (BONK, Solana's and Base's first listed; ${run.lists?.solana === null ? "named by --charts" : `lists answered solana ${run.lists?.solana}, base ${run.lists?.base}`})`);
  for (const c of charts) {
    const vs = c.viewers ?? [];
    const all = vs.flat();
    const n429 = all.filter((r) => r.status === 429).length;
    const other = all.filter((r) => r.status !== 200 && r.status !== 429);
    const drawn = vs.filter((v) => v.length > 0 && v.at(-1).status === 200 && v.at(-1).bars > 0).length;
    const filled = all.filter((r) => r.filling === true && r.bars === 0).length;
    const ms = all.map((r) => r.ms).sort((x, y) => x - y);
    const name = `${c.chain} ${c.address}`;
    say(vs.length === VIEWERS, `${name}: ${vs.length} viewer(s) (want ${VIEWERS})`);
    say(n429 === 0, `${name}: ${n429} of ${all.length} reads answered 429`);
    say(other.length === 0, `${name}: ${other.length === 0 ? "no other failed read" : other.map((r) => `${r.status} ${r.body ?? r.shape ?? ""}${r.error ?? ""}`.trim()).join("; ")}`);
    const slow = all.filter((r) => !(r.ms <= ANSWER_MS)).length;
    say(all.length > 0 && slow === 0, `${name}: ${slow} of ${all.length} reads took past ${ANSWER_MS} ms (p50 ${ms[Math.floor(ms.length / 2)] ?? "-"} ms, max ${ms.at(-1) ?? "-"} ms)`);
    lines.push(`    ${name}: ${drawn} of ${vs.length} viewers drawn with bars inside ${SPAN_S} s, ${filled} filling read(s) on the way`);
  }
  const proxy = run.proxy ?? [];
  const p429 = proxy.filter((a) => a.status === 429).length;
  say(proxy.length === PROXY_VIEWERS && proxy.every((a) => a.status === 200), `1Click's token list read ${proxy.length} times at once from one address: ${proxy.filter((a) => a.status === 200).length} answered 200, ${p429} answered 429 (want ${PROXY_VIEWERS} and 0)`);
  return { ok: lines.length > 0 && lines.filter((l) => !l.startsWith("    ")).every((l) => l.startsWith("ok ")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const given = opt("--charts") === undefined ? null : opt("--charts").split(",").map((c) => c.split(":"));
    if (given !== null && !given.every(([c, t]) => (c === "solana" && SOL.test(t ?? "")) || ((c === "base" || c === "robinhood") && EVM.test(t ?? "")))) throw new Error("--charts takes <solana|base|robinhood>:<token>,...");
    const run = await read(opt("--base", BASE), fetch, sleep, given);
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
