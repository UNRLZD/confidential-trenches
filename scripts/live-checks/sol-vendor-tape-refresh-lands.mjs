#!/usr/bin/env node
// Live check of card sol-vendor-tape-refresh-lands: a Solana coin's tape served from the vendor's rows
// (apps/helper/src/data/solana/trades.ts poolTape, which names `sol-vendor-read;desc="rows read A ms ago"` in
// Server-Timing) is read again within SOL_VENDOR_REACH_MS (15 s) while a page holds it. The deployed helper served
// BONK's at 26 s (18 Nov 13:03Z), and its GeckoTerminal minute lines from 12:56Z to 13:48Z show no keyless
// "sol trades" call, the refresh lane's room taken by the lists and the read ahead (token.ts tapes).
// The coin: the first of CANDIDATES that no list of the lists answer holds now (a coin the lists held in the helper's
// last SERVED_MS is served from our own chain reads, apps/helper/src/data/solana/lists.ts listed, so a candidate a list
// names is skipped unread and the next one tried), then of the Trending (1h) list, whose tape answers from the vendor's
// rows where our reads do not decode its venue. On 22 Nov BONK, WIF, JUP and POPCAT had all been listed (the read of
// 11:02Z: each first answer from our chain reads; live run 45006783900 the same, nothing to judge), so the candidates
// are eleven long-traded coins. It is read as a page holds it, every
// POLL_MS for HOLD_MS; then:
//   - every answer is 200;
//   - at least MIN_VENDOR answers are the vendor's rows (named in Server-Timing), spanning more than TAPE_FRESH_MS, so
//     a refresh had to land; a coin whose tape turns to our own chain reads part way is left and the next one read;
//   - every vendor answer's rows were read at most SOL_VENDOR_REACH_MS before, by the helper's word.
// Then the gap (card sol-vendor-tape-waits-past-reach): the judged coin is left unread for GAP_MS, past
// SOL_VENDOR_REACH_MS and under STALE_MS, as a page opening a coin another reader held, and read again, GAPS times:
//   - every gap answer is 200 and the vendor's rows, read at most SOL_VENDOR_REACH_MS before (before that card the held
//     rows were served at once, as old as the gap: a local helper on mainnet served BONK's 17 s and more; live run
//     44938731300 served BONK's 33,606 and 54,172 ms old, and on 21 Nov POPCAT's 19,651 ms old in 1 ms, its refresh
//     refused as the helper's background read: card sol-vendor-tape-gap-served-inside-reach).
// And, a second rule on every answer, hold and gap: one whose rows are past SOL_VENDOR_REACH_MS says `filling`, so the
// page never draws it as live (card sol-vendor-tape-gap-served-inside-reach). It is its own BAD line; an answer past the
// reach that says filling is still BAD by the rule above.
// No coin served from the vendor long enough to judge, or no gap answer from the vendor: INCONCLUSIVE (exit 2,
// provider-answer.mjs nothingToJudge), never a pass.
// Each gap answer's time (Server-Timing total) is printed beside it, so a red run shows whether the helper waited for a
// refresh or answered at once.
// After: helper
//   node scripts/live-checks/sol-vendor-tape-refresh-lands.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error or INCONCLUSIVE (nothing to judge) exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { nothingToJudge } from "./provider-answer.mjs";
import { writeFileSync } from "node:fs";
import { SOL_VENDOR_REACH_MS } from "../../apps/helper/src/data/solana/trades.ts";
import { TAPE_FRESH_MS } from "../../apps/helper/src/data/solana/token.ts";

const KEY = "sol-vendor-tape-refresh-lands";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** Coins long traded on Solana's DEXes: BONK, WIF, JUP, POPCAT (when this check was written), then ORCA, KMNO, RENDER,
 *  PYTH, MEW, HNT, JTO (card sol-vendor-tape-refresh-lands-live, each traded in the 24 h before 22 Nov 11:05Z by
 *  DexScreener's token read). */
export const CANDIDATES = [
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
  "KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS",
  "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof",
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
  "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5",
  "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux",
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
];
/** Trending coins tried after the candidates. */
export const TRENDING = 6;
export const POLL_MS = 2_000;
export const HOLD_MS = 45_000;
/** Vendor answers a judged coin needs: 2 s apart, more than TAPE_FRESH_MS from first to last. */
export const MIN_VENDOR = 10;
/** How long the judged coin is left unread before a gap read: past SOL_VENDOR_REACH_MS (15 s), under STALE_MS (60 s),
 *  the 17 s gap card evm-vendor-tape-refresh-keyed met on Base (0x1668cd48 served 18.9 s old, 18 Nov 15:13:45Z). */
export const GAP_MS = 17_000;
/** Gap reads after the hold. */
export const GAPS = 3;
export const ENTRY = "sol-vendor-read";

/** The age in ms a Server-Timing names for `entry` (`<entry>;desc="rows read A ms ago"`), or null when it names none
 *  (as token-stats-count-every-trade.mjs reads it; not imported, since that check reads the keyed EVM routes and the
 *  live plan would count this one among them). */
export function vendorReadOf(entry, timing) {
  const m = new RegExp(`(?:^|,)\\s*${entry};desc="rows read (\\d+) ms ago"`).exec(String(timing ?? ""));
  return m === null ? null : Number(m[1]);
}

/** The answer's time a Server-Timing names (`total;dur=N`), or null. */
export function totalOf(timing) {
  const m = /(?:^|,)\s*total;dur=(\d+(?:\.\d+)?)/.exec(String(timing ?? ""));
  return m === null ? null : Math.round(Number(m[1]));
}

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
  const lists = obj(obj(l.body).lists);
  const tokens = (rows) => arr(rows).map((r) => obj(r).token).filter((t) => typeof t === "string");
  const trending = tokens(lists.trending_1h).slice(0, TRENDING);
  // a coin a list holds now is served from our own chain reads: not read
  const held = new Set(Object.values(lists).flatMap(tokens));
  const coins = [];
  for (const coin of [...CANDIDATES.filter((c) => !held.has(c)), ...trending.filter((t) => !CANDIDATES.includes(t))]) {
    const reads = [];
    for (const end = now() + HOLD_MS; ; ) {
      const t = await get(`/v1/market/trades?chain=solana&token=${encodeURIComponent(coin)}&limit=50`);
      const a = obj(t.body);
      reads.push({ at: t.at, status: t.status, timing: t.timing, src: a.src ?? null, n: arr(a.trades).length, as_of_ms: a.as_of_ms ?? null, ...(Object.hasOwn(a, "whole_ms") ? { whole_ms: a.whole_ms } : {}), ...(a.filling === true ? { filling: true } : {}) });
      // a coin not served from the vendor's rows at its first read, or no longer, is not this check's to judge
      if (t.status !== 200 || vendorReadOf(ENTRY, t.timing) === null || now() + POLL_MS > end) break;
      await wait(POLL_MS);
    }
    if (!judgeable(reads)) {
      coins.push({ coin, reads });
      continue;
    }
    // the gap: no read of this coin for GAP_MS, then one, GAPS times
    const gaps = [];
    for (let i = 0; i < GAPS; i++) {
      await wait(GAP_MS);
      const t = await get(`/v1/market/trades?chain=solana&token=${encodeURIComponent(coin)}&limit=50`);
      const a = obj(t.body);
      gaps.push({ at: t.at, ms: now() - t.at, status: t.status, timing: t.timing, src: a.src ?? null, n: arr(a.trades).length, as_of_ms: a.as_of_ms ?? null, ...(Object.hasOwn(a, "whole_ms") ? { whole_ms: a.whole_ms } : {}), ...(a.filling === true ? { filling: true } : {}) });
    }
    coins.push({ coin, reads, gaps });
    break;
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
  // the second rule: answers past the reach each say filling (a line only when one is past it)
  const unsaid = (coin, what, xs, as) => {
    const past = xs.filter((x, i) => as[i] > SOL_VENDOR_REACH_MS);
    const n = past.filter((x) => x.filling !== true).length;
    if (past.length > 0) say(n === 0, `${String(coin).slice(0, 10)}: ${past.length} ${what} answers past ${SOL_VENDOR_REACH_MS} ms, each saying filling: ${n ? `${n} with no word of it` : "yes"}`);
  };
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
  unsaid(c.coin, "hold", v, ages);
  // the gap reads: each a page opening the coin GAP_MS after the last reader
  const gaps = arr(c.gaps);
  const gNot200 = gaps.filter((x) => x.status !== 200);
  const gv = vendorReads(gaps);
  if (gNot200.length > 0) say(false, `${String(c.coin).slice(0, 10)}: every gap answer 200: ${gNot200.map((x) => x.status).join(",")}`);
  if (gv.length === 0) {
    const bad = lines.some((l) => l.startsWith("BAD"));
    return { ok: bad ? false : null, lines: [...lines, `--  ${String(c.coin).slice(0, 10)}: no gap answer from the vendor's rows (${gaps.length} gap reads)`] };
  }
  const gAges = gv.map((x) => vendorReadOf(ENTRY, x.timing));
  const gOver = gAges.filter((a) => a > SOL_VENDOR_REACH_MS);
  say(gOver.length === 0, `${String(c.coin).slice(0, 10)}: ${gv.length} vendor answers after ${GAP_MS / 1000} s unread, rows read ${gAges.join(", ")} ms before (at most ${SOL_VENDOR_REACH_MS}): ${gOver.length ? `${gOver.length} past it` : "every one"}`);
  lines.push(`--  ${String(c.coin).slice(0, 10)}: gap answers took ${gaps.map((x) => totalOf(x.timing) ?? "?").join(", ")} ms (Server-Timing total)`);
  unsaid(c.coin, "gap", gv, gAges);
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
      const n = nothingToJudge(KEY, r.base);
      console.log(n.line);
      process.exit(n.code);
    }
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${r.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
