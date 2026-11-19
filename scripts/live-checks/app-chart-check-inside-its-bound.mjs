#!/usr/bin/env node
// Live check of card app-chart-check-inside-its-bound, the helper's part: a listed Solana coin whose tape holds every
// trade from the mint's first signature (its trades answer says whole_ms 0) has a chart that is the coin's whole chart,
// never filling (apps/helper/src/data/solana/trades.ts candles, `born`). Before the card the deployed helper (release 207,
// 472d2d8e2) answered EHFrCL6p...pump's trades whole_ms 0 at 17:29:08Z on 19 Nov while its 1m chart said filling from
// 17:26:25Z to 17:30:46Z: the chart asked the history anyway and waited its turn for a read back of nothing, so the token
// page's chart kept loading and app-chart-fills-in-its-history ran past its bound in the merge queue.
// It reads, with Origin APP_HOST: GET /v1/market/lists?chain=solana, then for up to COINS tokens of its new column (the
// coins young enough to have their whole life in the first walk) GET /v1/market/trades?chain=solana&token=<t>&limit=50
// every POLL_MS until the answer names whole_ms (or TAPE_MS pass), and, when it says whole_ms 0, GET
// /v1/market/candles?chain=solana&token=<t>&tf=1m&limit=300 (the page's full read) at once. A chart that says filling is
// read again with its tape once, so a stream that went quiet between the two reads is no verdict.
// PASS: a coin's tape said whole_ms 0 and its chart did not say filling, and no BAD line. FAIL: a coin whose tape said
// whole_ms 0 had its chart say filling at both reads. INCONCLUSIVE: no coin's tape said whole_ms 0.
// After: helper
//   node scripts/live-checks/app-chart-check-inside-its-bound.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read (per coin, each
//   pair's whole_ms, the chart's status, bar count and filling; the token as <token>), for the test's replay.
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "app-chart-check-inside-its-bound";
export const BASE = "https://ct-api.unrealized.trade";
export const APP_HOST = "https://ct-app.unrealized.trade";
export const COINS = 8;
export const POLL_MS = 3_000;
export const TAPE_MS = 30_000;
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3 });

/** The verdict on a record: { verdict, lines }. */
export function judge(rec) {
  const lines = [];
  const coins = rec.coins ?? [];
  let whole = 0;
  let bad = false;
  for (const [n, c] of coins.entries()) {
    const pairs = (c.pairs ?? []).filter((p) => p.whole_ms === 0);
    if (pairs.length === 0) {
      lines.push(`ok  coin ${n + 1}: its tape never said whole_ms 0 (${c.whole_ms ?? "none"}): no verdict`);
      continue;
    }
    const ok = pairs.some((p) => p.status === 200 && p.filling !== true && p.bars > 0);
    const filling = pairs.filter((p) => p.status === 200 && p.filling === true).length;
    if (ok) {
      whole++;
      lines.push(`ok  coin ${n + 1}: tape whole_ms 0, chart ${pairs.map((p) => `${p.status} ${p.bars} bars${p.filling ? " filling" : ""}`).join(", then ")}`);
    } else if (filling >= 2) {
      bad = true;
      lines.push(`BAD coin ${n + 1}: tape whole_ms 0, yet its chart said filling at ${filling} reads: the coin's whole chart drawn as still loading`);
    } else lines.push(`ok  coin ${n + 1}: tape whole_ms 0, chart ${pairs.map((p) => `${p.status}${p.filling ? " filling" : ""}`).join(", ")}: no verdict`);
  }
  const verdict = bad ? "FAIL" : whole > 0 ? "PASS" : "INCONCLUSIVE";
  if (verdict === "INCONCLUSIVE") lines.push(`INCONCLUSIVE no coin of ${coins.length} had a tape that said whole_ms 0 and a chart read beside it`);
  return { verdict, lines };
}

const get = async (base, p) => {
  const r = await fetch(`${base}${p}`, { headers: { origin: APP_HOST, "cache-control": "no-cache" }, signal: AbortSignal.timeout(20_000) });
  let body = null;
  try {
    body = await r.json();
  } catch {}
  return { status: r.status, body };
};

async function coin(base, token) {
  const q = `chain=solana&token=${encodeURIComponent(token)}`;
  const out = { token, pairs: [], whole_ms: null };
  const until = Date.now() + TAPE_MS;
  for (;;) {
    const tape = await get(base, `/v1/market/trades?${q}&limit=50`);
    const w = tape.body?.whole_ms;
    out.whole_ms = typeof w === "number" ? w : out.whole_ms;
    if (w === 0) {
      const chart = await get(base, `/v1/market/candles?${q}&tf=1m&limit=300`);
      out.pairs.push({ whole_ms: 0, status: chart.status, bars: Array.isArray(chart.body?.candles) ? chart.body.candles.length : null, filling: chart.body?.filling === true });
      if (chart.body?.filling !== true || out.pairs.length >= 2) return out;
    } else if (typeof w === "number" || Date.now() > until) return out;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export async function collect(base = BASE) {
  const lists = await get(base, "/v1/market/lists?chain=solana");
  const tokens = [...new Set((lists.body?.lists?.new ?? []).map((x) => x?.token).filter((t) => typeof t === "string"))].slice(0, COINS);
  const coins = await Promise.all(tokens.map((t) => coin(base, t)));
  return { at: new Date().toISOString(), base, coins };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect(opt("--base", BASE));
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, coins: rec.coins.map((c) => ({ ...c, token: "<token>" })) }, null, 1)}\n`);
    const { verdict, lines } = judge(rec);
    for (const x of lines) console.log(x);
    console.log(`CARD ${KEY} / live: ${verdict}`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
