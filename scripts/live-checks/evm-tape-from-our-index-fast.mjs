#!/usr/bin/env node
// Live check of card evm-tape-from-our-index-fast: a cold Base tape short of TRADES_MAX trades reads back to a full tape
// or done within BOUND_MS, the bound a listed token's tape is held to (tape-read.mjs FILLED_MS, robinhood-listed-tape-opens). Its
// read back (apps/helper/src/data/evm/swaps.ts readBack) asks a step's pool swaps alone, and the ETH price and a hooked
// pool's transfers and claims only for a step that holds a swap. Before it every step asked all four filters a span:
// the deployed helper 0d308d3bc left DOTF (0x0a5f90ff..., a v4 DOTF / WETH pool, 113 swaps in the hour) still filling
// at 180,913 ms (helper live run 43683445143, 15 Nov 07:30Z), and LMTS 46,873 ms (robinhood-listed-tape-opens, the same
// run). The same tape on four public providers from a Mac: 39.0 to 55.0 s and 380 to 400 eth_getLogs before, 21.4 to
// 27.5 s and 180 to 198 after, the same 50 rows (15 Nov 08:0xZ).
// It reads, with Origin APP_HOST: GET /v1/market/lists?chain=base, then opens the third and fourth tokens of its new list
// and of trending_1h at once, leaving out the first two of each, which helper-base-tape-reads-back opens (GET
// /v1/market/trades?chain=base&token=<t>&limit=TRADES_MAX, as the page reads it), each read again every POLL_MS until its
// tape ends (TRADES_MAX trades, or no longer filling) or BOUND_MS pass.
// It passes only when every answer is 200 JSON in the tape's fields {trades, src, as_of_ms[, filling: true]} with rows
// {t_ms, side, usd, amt, trader, tx}, X-Helper-Commit a full sha; each tape ends within BOUND_MS, never holding fewer
// trades than at its first answer; and at least one tape said filling and then ended (a read back seen end to end).
// A tape still filling at BOUND_MS: FAIL. A short tape opened cold (its first answer's Server-Timing evm-open over 0 ms,
// or none) that never said filling: FAIL. Every tape full at its first answer, or open before this check's first read
// (evm-open 0 ms: its read back, if any, was another reader's), leaves nothing to read back: INCONCLUSIVE. Card
// evm-keyed-checks-hold-steady: helper live run 43722667540 attempt 1 (15 Nov 14:16Z) opened the four tapes
// helper-base-tape-reads-back had opened a minute before, two of them short and done at their first answer (5 trades
// at 135 ms, 1 at 389 ms), and FAILed with no read back to see.
// After: helper
// Serial: evm-keyed 85 (before evm-chart-opens-without-a-vendor-call, index-evm-swaps and helper-base-tape-reads-back, which
//   open Base tapes of the same lists, so its picks are cold)
//   node scripts/live-checks/evm-tape-from-our-index-fast.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read (each answer's
//   status, commit, row count, filling and fault, not its rows; each tape's token as `address`), for the test's replay.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EXIT } from "./provider-answer.mjs";
import { FILLED_MS } from "./tape-read.mjs";

const KEY = "evm-tape-from-our-index-fast";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** The helper's tape length (swaps.ts TRADES_MAX) and the page's read of it (trades.ts TRADES_LIMIT): a test holds both. */
export const TRADES_MAX = 50;
/** The page's read again of a filling tape (trades.ts TRADES_POLL_MS): a test holds it. */
export const POLL_MS = 3_000;
/** Tapes opened at once: the first OPEN / 2 of new and of trending_1h. */
export const OPEN = 4;
/** How long a cold tape may fill: the listed tape's bound (tape-read.mjs FILLED_MS, robinhood-listed-tape-opens; a test holds them equal). */
export const BOUND_MS = FILLED_MS;
export const ROW = ["t_ms", "side", "usd", "amt", "trader", "tx"];
const SHA = /^[0-9a-f]{40}$/;
const DEC = /^\d+(\.\d+)?$/;
const ADDR = /^0x[0-9a-f]{40}$/;
const TX = /^0x[0-9a-f]{64}$/;
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const read = (base) => ({
  lists: () => `${base}/v1/market/lists?chain=base`,
  trades: (t) => `${base}/v1/market/trades?chain=base&token=${t}&limit=${TRADES_MAX}`,
});

/** The first thing wrong with a tape's body, or null: exactly {trades, src, as_of_ms} and filling true when it says
 *  so, at most TRADES_MAX rows, each exactly the row fields, newest first. */
export function bodyFault(b) {
  if (!isObj(b)) return "no JSON object";
  const keys = Object.keys(b).sort().join(",");
  if (keys !== "as_of_ms,src,trades" && keys !== "as_of_ms,filling,src,trades") return `fields ${keys}`;
  if (Object.hasOwn(b, "filling") && b.filling !== true) return `filling ${JSON.stringify(b.filling)}`;
  if (!Array.isArray(b.trades) || b.trades.length > TRADES_MAX) return "trades: no list of at most TRADES_MAX";
  if (typeof b.src !== "string" || !Number.isSafeInteger(b.as_of_ms)) return "src or as_of_ms";
  let last = Infinity;
  for (const r of b.trades) {
    if (!isObj(r) || Object.keys(r).sort().join(",") !== [...ROW].sort().join(",")) return `row ${JSON.stringify(r).slice(0, 80)}: not the row fields`;
    if (!Number.isSafeInteger(r.t_ms) || r.t_ms > last) return `row ${r.tx}: t_ms ${r.t_ms} not newest first`;
    if ((r.side !== "b" && r.side !== "s") || !DEC.test(r.usd) || !DEC.test(r.amt) || !TX.test(r.tx) || (r.trader !== null && !ADDR.test(r.trader))) return `row ${JSON.stringify(r).slice(0, 80)}`;
    last = r.t_ms;
  }
  return null;
}

async function get(url, fetchFn) {
  const r = await fetchFn(url, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(20_000) });
  const body = await r.text();
  return { status: r.status, type: r.headers.get("content-type") ?? "", commit: r.headers.get("x-helper-commit") ?? "", timing: r.headers.get("server-timing") ?? "", body };
}

/** The helper's open of the tape in ms, from Server-Timing's evm-open (apps/helper/src/data/evm/swaps.ts laneTiming), or
 *  null when the answer names none. 0: the tape was open before this read. */
export function openMs(timing) {
  const m = /(?:^|,)\s*evm-open;dur=(\d+)(?:[;,]|$)/.exec(timing ?? "");
  return m === null ? null : Number(m[1]);
}
/** One answer as recorded: its time from the tape's first read, status, commit, rows, filling, the helper's open (ms)
 *  and first fault. */
function answer(a, t) {
  const b = parse(a.body);
  const fault = a.status !== 200 ? `HTTP ${a.status}` : !/^application\/json/i.test(a.type) ? `Content-Type ${a.type}` : bodyFault(b);
  return { t, status: a.status, commit: a.commit, n: Array.isArray(b?.trades) ? b.trades.length : null, filling: b?.filling === true, open: openMs(a.timing), fault };
}
/** Whether a tape's answer ends it: TRADES_MAX trades, or no longer filling. */
const ends = (a) => a.fault !== null || a.n >= TRADES_MAX || !a.filling;

export async function readRun(base = BASE, { fetchFn = fetch, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), now = () => performance.now() } = {}) {
  const at = read(base.replace(/\/$/, ""));
  const l = await get(at.lists(), fetchFn);
  const lists = l.status === 200 ? parse(l.body)?.lists : undefined;
  const of = (k) => (Array.isArray(lists?.[k]) ? lists[k] : []).map((r) => r?.token).filter((t) => typeof t === "string" && ADDR.test(t));
  const rows = lists?.new;
  // helper-base-tape-reads-back's picks (the first OPEN / 2 of each) are left out, so neither check reads the other's tapes
  const theirs = new Set([...of("new").slice(0, OPEN / 2), ...of("trending_1h").slice(0, OPEN / 2)]);
  const after = (k) => of(k).filter((t) => !theirs.has(t)).slice(0, OPEN / 2);
  const tokens = [...new Set([...after("new"), ...after("trending_1h")])];
  const tapes = await Promise.all(
    tokens.map(async (token) => {
      const t0 = now();
      const answers = [];
      for (;;) {
        const a = answer(await get(at.trades(token), fetchFn), Math.round(now() - t0));
        answers.push(a);
        if (ends(a) || now() - t0 >= BOUND_MS) break;
        await sleep(POLL_MS);
      }
      return { address: token, answers };
    }),
  );
  return { base, readAt: new Date().toISOString(), lists: { status: l.status, new: Array.isArray(rows) ? rows.length : null }, tapes };
}

/** The verdict on one run: PASS, FAIL, or INCONCLUSIVE when every tape was full at its first answer. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok === true ? "ok " : ok === null ? "N/A" : "BAD"} ${text}`);
  say(run.lists?.status === 200 && run.lists.new > 0, `GET lists?chain=base answers ${run.lists?.status}, ${run.lists?.new ?? "no"} new token(s)`);
  const tapes = Array.isArray(run.tapes) ? run.tapes : [];
  say(tapes.length > 0, `${tapes.length} tape(s) opened`);
  for (const { address: token, answers } of tapes) {
    const first = answers[0];
    const last = answers.at(-1);
    if (first === undefined) {
      say(false, `${token}: no answer`);
      continue;
    }
    const bad = answers.find((a) => a.fault !== null || !SHA.test(a.commit ?? ""));
    say(bad === undefined, `${token}: ${answers.length} answer(s) in the tape's fields${bad === undefined ? "" : `: at ${bad.t} ms ${bad.fault ?? `X-Helper-Commit ${JSON.stringify(bad.commit)}`}`}`);
    const said = answers.some((a) => a.filling);
    const ended = last.fault === null && (last.n >= TRADES_MAX || !last.filling);
    say(ended, `${token}: first ${first.n} trade(s)${first.filling ? " filling" : ""}, ${ended ? `${last.n} and ${last.n >= TRADES_MAX ? "full" : "done"} at ${last.t} ms` : `still filling at ${last.t} ms`}${said ? " (read back)" : ""}`);
    say(last.n !== null && first.n !== null && last.n >= first.n, `${token}: never fewer trades than at its first answer (${first.n} then ${last.n})`);
  }
  const back = tapes.some(({ answers }) => answers.some((a) => a.filling) && answers.at(-1)?.filling === false && answers.at(-1)?.fault === null);
  // a tape open before this check's first read (evm-open 0 ms) has read back, if it had to, for another reader
  const warm = (answers) => answers[0]?.open === 0;
  const coldShort = tapes.filter(({ answers }) => (answers[0]?.n ?? 0) < TRADES_MAX && !warm(answers));
  const allFull = tapes.length > 0 && tapes.every(({ answers }) => (answers[0]?.n ?? 0) >= TRADES_MAX);
  const warmShort = tapes.filter(({ answers }) => (answers[0]?.n ?? 0) < TRADES_MAX && warm(answers)).map((t) => t.address);
  say(
    back || (tapes.length > 0 && coldShort.length === 0 ? null : false),
    back ? "a short tape said filling, then ended: read back seen end to end"
    : allFull ? "every tape full at its first answer: nothing to read back"
    : tapes.length > 0 && coldShort.length === 0 ? `every short tape open before this check's first read (evm-open 0 ms: ${warmShort.join(", ")}), the rest full at its first answer: nothing of its own to read back`
    : "no tape said filling while a tape opened cold answered short: no read back",
  );
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : lines.some((l) => l.startsWith("N/A")) ? "INCONCLUSIVE" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await readRun(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict} (${run.base})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
}
