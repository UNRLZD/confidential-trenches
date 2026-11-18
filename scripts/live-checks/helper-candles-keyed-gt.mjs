#!/usr/bin/env node
// Live check of card helper-candles-keyed-gt: a chart the key serves is full. Since card helper-listed-charts-own-reads
// (KEYED_COLD_ONLY, apps/helper/src/data/solana/token.ts) CoinGecko's key (COINGECKO_API_KEY) reads only what nothing
// holds, and every re-read of what is held goes keyless, so a chart's src is our own bars ("chain"), CoinGecko's for a
// cold read ("coingecko"), and GeckoTerminal's history before ours ("geckoterminal") once re-read. Before that card the
// check wanted every chart's src to name "coingecko": the key on every read, which spent its 3,225-call day in hours
// (15 Nov 21:20Z) and left listed charts empty.
// From this runner, with Origin APP_HOST, it reads two charts at tf 1m, the newest range: BONK on Solana (a busy pool off
// the lists) and the first row of Base's Discover lists that trades every minute (firstListed). Each is read again every READ_EVERY_MS while its answer is not
// yet full, within SPAN_MS, as the page reads a filling chart again. Want: each chart answered 200, not filling, with at
// least FULL_BARS bars (both picks trade every minute; live run 43776130630 read Base DRB, 1.7 years old and 1,648
// trades a day, as 1 bar, src chain, after 9 reads), and a src made of our own reads or CoinGecko's, GeckoTerminal's only
// as the history before them: "chain" or "coingecko" among its parts, and no part outside the three. BONK, off the lists,
// has no bars of ours (apps/helper/src/data/solana/trades.ts candles serves the history source alone), so once held its
// keyless re-read is GeckoTerminal's alone and its src says so: "geckoterminal" is its full chart too (card
// held-chart-names-its-bars: live run 43816654565 and the Mac's read at 07:02Z on 16 Nov, 500 bars src geckoterminal,
// which matched GeckoTerminal's keyless minute bars of its pool 5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9 in 499 of
// 500); Base's listed chart keeps the bar.
// After: helper
//   node scripts/live-checks/helper-candles-keyed-gt.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "helper-candles-keyed-gt";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** BONK: a busy Solana pool off Discover's lists, its chart one vendor's bars alone (CoinGecko's cold, GeckoTerminal's held). */
export const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
export const KEYED = "coingecko";
/** The sources a chart's src may name, and the bars a full chart of a coin that trades every minute holds [design: 100
 *  of the newest range's 500: more than an hour and a half of 1m bars]. */
export const SOURCES = ["chain", "coingecko", "geckoterminal"];
export const FULL_BARS = 100;
/** The trades in 5 minutes a Base pick must show to count as trading every minute [design: one a minute on average]. */
export const ACTIVE_TRADES_5M = 5;
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
/** Whether a src is our own reads or CoinGecko's, GeckoTerminal's only as the history before them. */
export const ours = (src) => {
  const parts = typeof src === "string" ? src.split(",") : [];
  return parts.length > 0 && parts.every((p) => SOURCES.includes(p)) && (parts.includes("chain") || parts.includes(KEYED));
};
/** Whether a src is a chart off the lists may answer: ours, or one vendor's alone (CoinGecko's cold read, or
 *  GeckoTerminal's keyless re-read of bars held, KEYED_COLD_ONLY). */
export const offLists = (src) => ours(src) || src === "geckoterminal";
/** Whether one read is a full chart; `off`: the chart is the pick off the lists (BONK). */
export const full = (r, off = false) => r.status === 200 && r.filling !== true && r.bars >= FULL_BARS && (off ? offLists(r.src) : ours(r.src));

/** A row's trades in its last 5 minutes (buys_5m + sells_5m), each count a whole number 0 or more, else 0. */
const trades5m = (r) => [r?.buys_5m, r?.sells_5m].reduce((n, v) => n + (Number.isSafeInteger(v) && v >= 0 ? v : 0), 0);

/** The first Base row of a lists answer that trades every minute: Trending 1h's rows in order, then 5m's, then New's,
 *  the first with ACTIVE_TRADES_5M trades or more in 5 minutes; as { token, list, row, trades_5m }, or null when none
 *  is. Card helper-candles-full-after-tape-behind: the first row whatever its trades read Base ANZ 0xeec46833 (0 buys
 *  and 0 sells in 5m, 858 USD in 24h, about 86 one-minute bars in its whole history) in live run 44249482613, a chart no
 *  helper can fill to FULL_BARS; the helper's order is GeckoTerminal's, and Discover re-ranks it by 1h volume. */
export function firstListed(body) {
  try {
    const l = JSON.parse(body).lists;
    for (const k of ["trending_1h", "trending_5m", "new"])
      for (const [i, r] of (Array.isArray(l?.[k]) ? l[k] : []).entries())
        if (typeof r?.token === "string" && EVM.test(r.token) && trades5m(r) >= ACTIVE_TRADES_5M) return { token: r.token, list: k, row: i, trades_5m: trades5m(r) };
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
    if (full(reads.at(-1), chain === "solana") || Date.now() - t0 + READ_EVERY_MS > SPAN_MS) return reads;
    await wait(READ_EVERY_MS);
  }
}

export async function read(base = BASE, fetchFn = fetch, wait = sleep) {
  const at = new Date().toISOString();
  const lists = await ask(base, "/v1/market/lists?chain=base", fetchFn);
  const pick = lists.status === 200 ? firstListed(lists.body) : null;
  const picks = [["solana", BONK], ["base", pick?.token ?? null]];
  const charts = await Promise.all(picks.map(async ([chain, token]) => ({ chain, address: token, reads: token === null ? [] : await chart(base, chain, token, fetchFn, wait) })));
  return { base, at, lists: { base: lists.status, pick: pick === null ? null : { list: pick.list, row: pick.row, trades_5m: pick.trades_5m } }, charts };
}

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const charts = run.charts ?? [];
  for (const chain of ["solana", "base"]) {
    const c = charts.find((x) => x.chain === chain);
    const pick = chain === "base" ? run.lists?.pick : undefined;
    if (chain === "base" && run.lists?.base === 200 && pick === null) {
      say(false, `base: no active Base pick (no Trending 1h, 5m or New row with ${ACTIVE_TRADES_5M} or more trades in 5m)`);
      continue;
    }
    if (c === undefined || c.address === null || (c.reads ?? []).length === 0) {
      say(false, `${chain}: no chart read (${chain === "base" ? `Base's lists answered ${run.lists?.base}` : "BONK not read"})`);
      continue;
    }
    // a run recorded before card helper-candles-full-after-tape-behind keeps no pick; every run since names its row
    if (pick !== undefined && !(Number.isSafeInteger(pick?.trades_5m) && pick.trades_5m >= ACTIVE_TRADES_5M))
      say(false, `base ${c.address}: picked with ${pick?.trades_5m ?? "no"} trades in 5m (${pick?.list ?? "?"} row ${pick?.row ?? "?"}); want ${ACTIVE_TRADES_5M} or more`);
    if (chain === "solana" && c.address !== BONK) say(false, `solana: ${c.address} read, not BONK`);
    const last = c.reads.at(-1);
    const srcs = [...new Set(c.reads.map((r) => r.src ?? `${r.status}`))].join(" then ");
    const off = chain === "solana";
    say(full(last, off), `${chain} ${c.address}: ${last.status === 200 ? `${last.bars} bars${last.filling ? ", filling" : ""}, src ${last.src}` : `${last.status} ${last.body ?? last.shape ?? last.error ?? ""}`.trim()} after ${c.reads.length} read(s) (${srcs}); want ${FULL_BARS} bars or more, not filling, src our own reads or ${KEYED}${off ? ", or geckoterminal off the lists" : ""}`);
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
