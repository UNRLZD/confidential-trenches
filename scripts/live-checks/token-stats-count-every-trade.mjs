#!/usr/bin/env node
// Live check of card token-stats-count-every-trade: the deployed helper's trades answers say how far back each tape holds
// every trade (`whole_ms`), so a token page counts its buys, sells and volume from its own trades list for each window
// inside that reach (apps/terminal/src/screens/token/lower.ts aboutView).
// For each chain (CHAINS) the first COINS coins of its Trending (1h) list are read on GET /v1/market/trades (limit 50)
// every POLL_MS for READ_MS until the tape is settled (not filling). Then:
//   - every answer is 200;
//   - a filling tape claims no reach (whole_ms absent);
//   - a settled tape's whole_ms, when present, is a whole ms from 0 to its as_of_ms plus a minute;
//   - on each chain at least MIN_CLAIMED of the COINS settled tapes claim a reach.
// After: helper
//   node scripts/live-checks/token-stats-count-every-trade.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "token-stats-count-every-trade";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const CHAINS = ["solana", "base", "robinhood", "near"];
export const COINS = 3;
export const MIN_CLAIMED = 2;
export const READ_MS = 45_000;
export const POLL_MS = 3_000;

const obj = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);

/** The run: each chain's first COINS Trending (1h) coins, and each one's trades answers until settled or READ_MS. */
export async function read(base = BASE, fetchFn = fetch, wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), now = Date.now) {
  const b = base.replace(/\/$/, "");
  const get = async (p) => {
    const r = await fetchFn(`${b}${p}`, { headers: { origin: APP } });
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: r.status, body };
  };
  const chains = {};
  for (const chain of CHAINS) {
    const l = await get(`/v1/market/lists?chain=${chain}`);
    const coins = arr(obj(obj(l.body).lists).trending_1h).map((r) => obj(r).token).filter((t) => typeof t === "string").slice(0, COINS);
    const tapes = [];
    for (const coin of coins) {
      const end = now() + READ_MS;
      const reads = [];
      for (;;) {
        const t = await get(`/v1/market/trades?chain=${chain}&token=${encodeURIComponent(coin)}&limit=50`);
        const a = obj(t.body);
        const rows = arr(a.trades);
        reads.push({ status: t.status, n: rows.length, oldest_ms: rows.length ? Math.min(...rows.map((x) => obj(x).t_ms)) : null, filling: a.filling === true, ...(Object.hasOwn(a, "whole_ms") ? { whole_ms: a.whole_ms } : {}), src: a.src ?? null, as_of_ms: a.as_of_ms ?? null });
        if (t.status !== 200 || a.filling !== true || now() + POLL_MS > end) break;
        await wait(POLL_MS);
      }
      tapes.push({ coin, reads });
    }
    chains[chain] = { lists_status: l.status, tapes };
  }
  return { base: b, at: new Date(now()).toISOString(), chains };
}

/** PASS or FAIL with one line per rule (a failed rule starts BAD). */
export function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok" : "BAD"} ${text}`);
  for (const chain of CHAINS) {
    const c = obj(obj(r.chains)[chain]);
    const tapes = arr(c.tapes);
    say(c.lists_status === 200 && tapes.length === COINS, `${chain}: ${tapes.length} Trending coins read (lists ${c.lists_status})`);
    const reads = tapes.flatMap((t) => arr(t.reads));
    const not200 = reads.filter((x) => x.status !== 200);
    say(not200.length === 0, `${chain}: every trades answer 200: ${not200.length ? not200.map((x) => x.status).join(",") : "yes"}`);
    const filled = reads.filter((x) => x.filling && x.whole_ms !== undefined);
    say(filled.length === 0, `${chain}: no filling tape claims a reach: ${filled.length}`);
    const settled = tapes.map((t) => arr(t.reads).at(-1)).filter((x) => x && x.status === 200 && !x.filling);
    const badReach = settled.filter((x) => x.whole_ms !== undefined && !(Number.isSafeInteger(x.whole_ms) && x.whole_ms >= 0 && Number.isSafeInteger(x.as_of_ms) && x.whole_ms <= x.as_of_ms + 60_000));
    say(badReach.length === 0, `${chain}: every reach a whole ms from 0 to its read: ${badReach.length ? JSON.stringify(badReach[0]) : "yes"}`);
    const claimed = settled.filter((x) => x.whole_ms !== undefined);
    say(claimed.length >= MIN_CLAIMED, `${chain}: ${claimed.length} of ${settled.length} settled tapes claim a reach (at least ${MIN_CLAIMED}): ${tapes.map((t) => { const x = arr(t.reads).at(-1); return `${String(t.coin).slice(0, 10)} ${x?.src} n${x?.n} ${x?.filling ? "filling" : x?.whole_ms === undefined ? "none" : x.whole_ms === 0 ? "0" : `${Math.round((x.as_of_ms - x.whole_ms) / 60_000)}m`}`; }).join("; ")}`);
  }
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const r = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(r, null, 1)}\n`);
    const { ok, lines } = judge(r);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${r.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
