#!/usr/bin/env node
// Live check of card helper-candles-keyed-gt: with the owner's CoinGecko key on the helper (COINGECKO_API_KEY, written by
// the owner's key step), every chart read asks CoinGecko's keyed on-chain API first (apps/helper/src/data/coingecko.ts)
// and the answer's src names it: "coingecko" for a chart that is CoinGecko's bars alone (a Solana token off Discover's
// lists, data/solana/token.ts), "chain,coingecko" for our own bars after CoinGecko's history (a listed EVM or Solana
// token, data/evm/swaps.ts, data/solana/trades.ts). The keyless GeckoTerminal path answers "geckoterminal".
// From this runner, with Origin APP_HOST, it reads two charts at tf 1m, the newest range: BONK on Solana (a busy pool off
// the lists) and the first row of Base's Discover lists (a Base pool, our book's bars after the history). Each is read
// again every READ_EVERY_MS while its answer is not yet keyed, within SPAN_MS: bars a deploy's old helper read keyless
// are handed to the new one and served, named geckoterminal, until their re-read (the newest range 60 s, solana/token.ts
// CANDLES_FRESH_MS; the history before a book's first 1m bar is a new range for each helper's book). Want: each chart
// answered 200 with bars and a src whose parts include "coingecko" inside the span.
// After: helper
//   node scripts/live-checks/helper-candles-keyed-gt.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "helper-candles-keyed-gt";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** BONK: a busy Solana pool off Discover's lists, its chart CoinGecko's bars alone. */
export const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
export const KEYED = "coingecko";
/** How long a chart is read for a keyed answer [design: a held newest range's 60 s and a page read's wait]. */
export const SPAN_MS = 90_000;
export const READ_EVERY_MS = 10_000;
const EVM = /^0x[0-9a-f]{40}$/;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function ask(base, path, fetchFn) {
  const t0 = performance.now();
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
    const body = await r.text();
    return { status: r.status, ms: Math.round(performance.now() - t0), body };
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t0), body: "", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** A 1m candles answer's bar count, src and filling, or what is wrong with it. */
export function shapeOf(body) {
  try {
    const j = JSON.parse(body);
    if (j?.tf !== "1m" || !Array.isArray(j.candles) || typeof j.src !== "string" || !Number.isSafeInteger(j.as_of_ms)) return { bad: "not a 1m candles answer" };
    return { bars: j.candles.length, src: j.src, filling: j.filling === true };
  } catch {
    return { bad: "not JSON" };
  }
}
/** Whether an answer's src names the keyed source among its parts ("coingecko", "chain,coingecko"). */
export const keyed = (src) => typeof src === "string" && src.split(",").includes(KEYED);

/** The first Base token of a lists answer (Trending 1h's first row, else any list's), or null. */
export function firstListed(body) {
  try {
    const l = JSON.parse(body).lists;
    for (const k of ["trending_1h", "trending_5m", "new"]) for (const r of Array.isArray(l?.[k]) ? l[k] : []) if (typeof r?.token === "string" && EVM.test(r.token)) return r.token;
  } catch {
    // no token
  }
  return null;
}

async function chart(base, chain, token, fetchFn, wait) {
  const reads = [];
  const t0 = Date.now();
  for (;;) {
    const a = await ask(base, `/v1/market/candles?chain=${chain}&token=${token}&tf=1m`, fetchFn);
    const s = a.status === 200 ? shapeOf(a.body) : null;
    reads.push({ status: a.status, ms: a.ms, ...(s === null ? { body: a.body.slice(0, 120) } : s.bad !== undefined ? { shape: s.bad } : s), ...(a.error ? { error: a.error } : {}) });
    if ((a.status === 200 && s?.bars > 0 && keyed(s.src)) || Date.now() - t0 + READ_EVERY_MS > SPAN_MS) return reads;
    await wait(READ_EVERY_MS);
  }
}

export async function read(base = BASE, fetchFn = fetch, wait = sleep) {
  const at = new Date().toISOString();
  const lists = await ask(base, "/v1/market/lists?chain=base", fetchFn);
  const baseToken = lists.status === 200 ? firstListed(lists.body) : null;
  const picks = [["solana", BONK], ["base", baseToken]];
  const charts = await Promise.all(picks.map(async ([chain, token]) => ({ chain, address: token, reads: token === null ? [] : await chart(base, chain, token, fetchFn, wait) })));
  return { base, at, lists: { base: lists.status }, charts };
}

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const charts = run.charts ?? [];
  for (const chain of ["solana", "base"]) {
    const c = charts.find((x) => x.chain === chain);
    if (c === undefined || c.address === null || (c.reads ?? []).length === 0) {
      say(false, `${chain}: no chart read (${chain === "base" ? `Base's lists answered ${run.lists?.base}` : "BONK not read"})`);
      continue;
    }
    if (chain === "solana" && c.address !== BONK) say(false, `solana: ${c.address} read, not BONK`);
    const last = c.reads.at(-1);
    const srcs = [...new Set(c.reads.map((r) => r.src ?? `${r.status}`))].join(" then ");
    say(last.status === 200 && last.bars > 0 && keyed(last.src), `${chain} ${c.address}: ${last.status === 200 ? `${last.bars} bars, src ${last.src}` : `${last.status} ${last.body ?? last.shape ?? last.error ?? ""}`.trim()} after ${c.reads.length} read(s) (${srcs}); want bars and src naming ${KEYED}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE), fetch, sleep);
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
