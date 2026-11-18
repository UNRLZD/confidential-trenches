#!/usr/bin/env node
// Live check of card sol-vendor-tape-refresh-lands: a Solana coin's tape served from the vendor's rows
// (apps/helper/src/data/solana/trades.ts poolTape, which names `sol-vendor-read;desc="rows read A ms ago"` in
// Server-Timing) is read again within SOL_VENDOR_REACH_MS (15 s) while a page holds it. The deployed helper served
// BONK's at 26 s (18 Nov 13:03Z), and its GeckoTerminal minute lines from 12:56Z to 13:48Z show no keyless
// "sol trades" call, the refresh lane's room taken by the lists and the read ahead (token.ts tapes).
// The coin: the first of CANDIDATES (coins on no Discover list, so served from the vendor while no walk of ours holds
// them), then of the Trending (1h) list, whose tape answers from the vendor's rows. It is read as a page holds it, every
// POLL_MS for HOLD_MS; then:
//   - every answer is 200;
//   - at least MIN_VENDOR answers are the vendor's rows (named in Server-Timing), spanning more than TAPE_FRESH_MS, so
//     a refresh had to land; a coin whose tape turns to our own chain reads part way is left and the next one read;
//   - every vendor answer's rows were read at most SOL_VENDOR_REACH_MS before, by the helper's word.
// No coin served from the vendor long enough to judge: error (exit 2), never a pass.
// After: helper
//   node scripts/live-checks/sol-vendor-tape-refresh-lands.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { SOL_VENDOR_REACH_MS } from "../../apps/helper/src/data/solana/trades.ts";
import { TAPE_FRESH_MS } from "../../apps/helper/src/data/solana/token.ts";
import { vendorReadOf } from "./token-stats-count-every-trade.mjs";

const KEY = "sol-vendor-tape-refresh-lands";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** Coins long listed on Solana's DEXes and on no Discover list (lists of new, trending and graduating coins) when this
 *  check was written: BONK, WIF, JUP, POPCAT. */
export const CANDIDATES = ["DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"];
/** Trending coins tried after the candidates. */
export const TRENDING = 6;
export const POLL_MS = 2_000;
export const HOLD_MS = 45_000;
/** Vendor answers a judged coin needs: 2 s apart, more than TAPE_FRESH_MS from first to last. */
export const MIN_VENDOR = 10;
export const ENTRY = "sol-vendor-read";

const obj = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);

/** The run: each coin tried in turn, its trades read every POLL_MS for HOLD_MS, until one held from the vendor's rows
 *  long enough to judge (or the coins run out). */
export async function read(base = BASE, fetchFn = fetch, wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), now = Date.now) {
  const b = base.replace(/\/$/, "");
  const get = async (p) => {
    const at = now();
    const r = await fetchFn(`${b}${p}`, { headers: { origin: APP } });
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return { at, status: r.status, timing: r.headers.get("server-timing") ?? "", body };
  };
  const l = await get(`/v1/market/lists?chain=solana`);
  const trending = arr(obj(obj(l.body).lists).trending_1h).map((r) => obj(r).token).filter((t) => typeof t === "string").slice(0, TRENDING);
  const coins = [];
  for (const coin of [...CANDIDATES, ...trending.filter((t) => !CANDIDATES.includes(t))]) {
    const reads = [];
    for (const end = now() + HOLD_MS; ; ) {
      const t = await get(`/v1/market/trades?chain=solana&token=${encodeURIComponent(coin)}&limit=50`);
      const a = obj(t.body);
      reads.push({ at: t.at, status: t.status, timing: t.timing, src: a.src ?? null, n: arr(a.trades).length, as_of_ms: a.as_of_ms ?? null, ...(Object.hasOwn(a, "whole_ms") ? { whole_ms: a.whole_ms } : {}) });
      // a coin not served from the vendor's rows at its first read, or no longer, is not this check's to judge
      if (t.status !== 200 || vendorReadOf(ENTRY, t.timing) === null || now() + POLL_MS > end) break;
      await wait(POLL_MS);
    }
    coins.push({ coin, reads });
    if (judgeable(reads)) break;
  }
  return { base: b, at: new Date(now()).toISOString(), lists_status: l.status, coins };
}

/** The vendor answers of a coin's reads, and whether they are enough to judge a refresh by. */
function vendorReads(reads) {
  return arr(reads).filter((x) => vendorReadOf(ENTRY, x.timing) !== null);
}
function judgeable(reads) {
  const v = vendorReads(reads);
  return v.length >= MIN_VENDOR && v.at(-1).at - v[0].at > TAPE_FRESH_MS;
}

/** PASS, FAIL or null (nothing to judge), with one line per rule (a failed rule starts BAD). */
export function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok" : "BAD"} ${text}`);
  const c = arr(r.coins).find((x) => judgeable(x.reads));
  for (const x of arr(r.coins)) if (x !== c) lines.push(`--  ${String(x.coin).slice(0, 10)}: ${vendorReads(x.reads).length} vendor answers of ${arr(x.reads).length}, not judged`);
  if (c === undefined) return { ok: null, lines: [...lines, "--  no coin served from the vendor's rows long enough to judge"] };
  const reads = arr(c.reads);
  const not200 = reads.filter((x) => x.status !== 200);
  say(not200.length === 0, `${String(c.coin).slice(0, 10)}: every trades answer 200: ${not200.length ? not200.map((x) => x.status).join(",") : "yes"}`);
  const v = vendorReads(reads);
  const ages = v.map((x) => vendorReadOf(ENTRY, x.timing));
  const over = ages.filter((a) => a > SOL_VENDOR_REACH_MS);
  say(over.length === 0, `${String(c.coin).slice(0, 10)}: ${v.length} vendor answers over ${Math.round((v.at(-1).at - v[0].at) / 1000)} s, rows read at most ${Math.max(...ages)} ms before (at most ${SOL_VENDOR_REACH_MS}): ${over.length ? `${over.length} past it` : "every one"}`);
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
    if (ok === null) {
      console.error(`live-check ${KEY}: ERROR: nothing to judge (${r.base})`);
      process.exit(2);
    }
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${r.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
