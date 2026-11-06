#!/usr/bin/env node
// Live check of card helper-token-page-cold: a Solana token page nobody opened yet answers 200 within 1 s, at p95 over
// COLD_MIN or more cold reads, including one asked right after the helper's last Jupiter search (before the card such a
// read waited out the search's 4 s batch gap, JUP_GAP_MS).
//
// The cold mints: PAIRS x 2 tokens drawn at random from Jupiter's verified list (keyless GET POOL_URL, 4131 tokens at
// 2026-11-04 14:46Z), less every token on the helper's own Discover lists (GET /v1/market/lists?chain=solana: a listed
// token takes its row from the lists and never searches). Each read is judged cold on its own answer: the page's
// Jupiter row (risk.holders, src "jupiter") was read at or after the moment the request was sent, less SKEW_MS for the
// two clocks, so it was searched for this read, not served from what the helper held. A read that is not cold is
// listed and left out of the timing.
//
// The reads go in pairs, PAIR_GAP_MS apart: the first of a pair, then the second as soon as the first answers (within
// a second of the first's search). PAIR_GAP_MS keeps the check's own searches at 12 a minute, under the search's 16 a
// counted minute (apps/helper/src/data/solana/token.ts SEARCH_PER_SPAN), so it measures the page, not the budget.
//
// The time judged is the helper's: each page read goes right after two GET /v1/health on the same kept-alive
// connection (the first opens it), and the second's time (the round trip to the helper, which answers it at once) is
// taken off the page read's. So a runner far from the helper, or a connection made anew, is not counted as the page's.
//   node scripts/live-checks/helper-token-page-cold.mjs [--base <url>] [--pairs <n>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "helper-token-page-cold";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const POOL_URL = "https://lite-api.jup.ag/tokens/v2/tag?query=verified";
export const PAIRS = 16;
export const COLD_MIN = 30;
export const LIMIT_MS = 1_000;
export const PAIR_GAP_MS = 10_000;
export const SKEW_MS = 1_000;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The nearest-rank percentile of `ms`. */
export const pct = (ms, p) => {
  const s = [...ms].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
};

const ms = (t0) => Math.round(performance.now() - t0);
/** The round trip to the helper: a GET /v1/health, which answers at once. */
async function trip(base, fetchFn) {
  const t0 = performance.now();
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/health`, { headers: { origin: APP, "cache-control": "no-cache" } });
    await r.arrayBuffer();
    return r.status === 200 ? ms(t0) : null;
  } catch {
    return null;
  }
}

async function page(base, mint, fetchFn) {
  // the first opens (or keeps) the connection the page reuses; the second is the round trip on it
  const rttMs = (await trip(base, fetchFn)) === null ? null : await trip(base, fetchFn);
  const sentAt = Date.now();
  const t0 = performance.now();
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/market/token?chain=solana&token=${mint}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
    const text = await r.text();
    const ms = Math.round(performance.now() - t0);
    let jupAt = null;
    let src = null;
    try {
      const h = JSON.parse(text).risk?.holders;
      if (Number.isSafeInteger(h?.as_of_ms)) jupAt = h.as_of_ms;
      if (typeof h?.src === "string") src = h.src;
    } catch {}
    return { mint, sentAt, status: r.status, ms, rttMs, jupAt, src, retryAfter: r.headers.get("retry-after"), timing: r.headers.get("server-timing") };
  } catch (e) {
    return { mint, sentAt, status: 0, ms: Math.round(performance.now() - t0), rttMs, jupAt: null, src: null, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Every token on the helper's Solana lists, or null when they do not answer. */
async function listed(base, fetchFn) {
  const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/market/lists?chain=solana`, { headers: { origin: APP } });
  if (r.status !== 200) return { status: r.status, tokens: null };
  const out = new Set();
  for (const list of Object.values(JSON.parse(await r.text()).lists ?? {})) if (Array.isArray(list)) for (const row of list) if (typeof row?.token === "string") out.add(row.token);
  return { status: 200, tokens: out };
}

export async function read(base = BASE, fetchFn = fetch, pairs = PAIRS, wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), rand = Math.random) {
  const at = new Date().toISOString();
  const lists = await listed(base, fetchFn);
  const p = await fetchFn(POOL_URL, { headers: { accept: "application/json" } });
  const pool = p.status === 200 ? JSON.parse(await p.text()) : [];
  const ids = [...new Set((Array.isArray(pool) ? pool : []).map((t) => t?.id).filter((id) => typeof id === "string" && ADDRESS.test(id) && !lists.tokens?.has(id)))];
  // a random draw without repeats: the first pairs x 2 of a shuffle
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const mints = ids.slice(0, pairs * 2);
  const reads = [];
  for (let i = 0; i + 1 < mints.length; i += 2) {
    if (i > 0) await wait(PAIR_GAP_MS);
    reads.push({ pair: i / 2, order: 0, ...(await page(base, mints[i], fetchFn)) });
    reads.push({ pair: i / 2, order: 1, ...(await page(base, mints[i + 1], fetchFn)) });
  }
  return { base, at, pairs, lists: { status: lists.status, size: lists.tokens?.size ?? 0 }, pool: { status: p.status, size: ids.length }, reads };
}

/** The helper's time for a read: its time less the round trip read just before it on the same connection. */
export const helperMs = (r) => Math.max(0, r.ms - r.rttMs);

/** A read whose Jupiter row was read for it: at or after its send, less the clocks' skew. */
export const cold = (r) => r.src === "jupiter" && r.jupAt !== null && r.jupAt >= r.sentAt - SKEW_MS;

/**
 * Every read over LIMIT_MS of the helper's time, with its offset from the run's start and the helper's Server-Timing
 * (each upstream the read waited on, card helper-ready-page-warm): the WARN lines that say which wait a slow read was.
 * They never change the verdict.
 */
export function slow(run) {
  const start = Date.parse(run.at ?? "");
  return (run.reads ?? [])
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.status === 200 && Number.isSafeInteger(r.rttMs) && helperMs(r) > LIMIT_MS)
    .map(({ r, i }) => `WARN slow read #${i} (pair ${r.pair}, ${r.order === 0 ? "first" : "second"}) ${r.mint}: helper ${helperMs(r)} ms at +${Number.isFinite(start) ? ((r.sentAt - start) / 1000).toFixed(1) : "?"} s; Server-Timing: ${r.timing ?? "none"}`);
}

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(run.lists?.status === 200, `GET /v1/market/lists?chain=solana answers ${run.lists?.status} (${run.lists?.size} listed tokens left out)`);
  say(run.pool?.status === 200 && run.pool.size >= run.pairs * 2, `Jupiter's verified list answers ${run.pool?.status}, ${run.pool?.size} tokens off the lists to draw from`);
  const reads = run.reads ?? [];
  const noTrip = reads.filter((r) => !Number.isSafeInteger(r.rttMs));
  say(noTrip.length === 0, `${reads.length - noTrip.length} of ${reads.length} round trips read (GET /v1/health twice before each page read)`);
  const failed = reads.filter((r) => r.status !== 200);
  // card helper-ready-page-warm: a not-ready page names its cause in Server-Timing (search-room, search-gap, search-held,
  // search-429, search-upstream, rpc), printed with the FAIL so no one needs the helper's log
  const kinds = [...new Set(failed.map((r) => `${r.status}${r.retryAfter ? ` Retry-After ${r.retryAfter}` : ""}${r.timing ? ` Server-Timing ${r.timing}` : ""}${r.error ? ` ${r.error}` : ""}`))];
  say(failed.length === 0, `${reads.length - failed.length} of ${reads.length} page reads answered 200${failed.length ? `; ${failed.length} did not: ${kinds.join(", ")}` : ""}`);
  // card helper-page-jup-429: a not-ready page with no cause in Server-Timing is a bare 503, its own failure
  const bare = failed.filter((r) => r.status === 503 && !/(^|,\s*)(search-[a-z0-9]+|rpc)(;|,|$)/.test(r.timing ?? ""));
  if (bare.length > 0) say(false, `${bare.length} page reads answered 503 with no cause in Server-Timing (a bare 503)`);
  const ok = reads.filter((r) => r.status === 200 && Number.isSafeInteger(r.rttMs));
  const c = ok.filter(cold);
  const warm = ok.filter((r) => !cold(r));
  say(c.length >= COLD_MIN, `${c.length} of ${ok.length} read cold (the Jupiter row read for the request)${warm.length ? `; not cold: ${warm.map((r) => r.mint).join(", ")}` : ""}`);
  if (c.length === 0) return { ok: false, lines };
  const t = c.map(helperMs);
  const second = c.filter((r) => r.order === 1).map(helperMs);
  const rtt = c.map((r) => r.rttMs);
  say(pct(t, 95) <= LIMIT_MS, `cold page reads, the helper's time: p50 ${pct(t, 50)} ms, p95 ${pct(t, 95)} ms, max ${Math.max(...t)} ms, n=${t.length} (p95 at most ${LIMIT_MS} ms; round trip p50 ${pct(rtt, 50)} ms, as read p95 ${pct(c.map((r) => r.ms), 95)} ms)`);
  // the reads the batch gap held before the card: their middle within the limit (before: p50 about 3.5 s)
  say(second.length > 0 && pct(second, 50) <= LIMIT_MS, `asked right after a search (the second of each pair): p50 ${pct(second, 50)} ms (at most ${LIMIT_MS} ms), p95 ${pct(second, 95)} ms, n=${second.length}`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE), fetch, Number(opt("--pairs", String(PAIRS))));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    for (const l of slow(run)) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
