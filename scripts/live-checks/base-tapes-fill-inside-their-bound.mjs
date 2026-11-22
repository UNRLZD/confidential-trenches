#!/usr/bin/env node
// Live check of card base-tapes-fill-inside-their-bound: a dozen listed Base coins opened at once each answer their whole
// trade list inside FILLED_MS of their first answer, on the public providers' paces (apps/helper/src/data/evm/swaps.ts:
// a Base tape's read back locates its pool's swaps over the hour in one base-rpc.publicnode.com read, then agrees only
// the blocks it names). Live run 44942886709 (21 Nov 20:14Z, helper at 61fa14a08), robinhood-tapes-read-ahead-bounded:
// 7 of 12 listed Base tapes "still filling 45013-46874 ms after its first read", 0 of 12 whole at their first answer.
// With Origin APP_HOST it reads Base's Discover lists at HELPER_HOST, takes up to TOKENS listed tokens (Trending 1h, then
// Trending 5m, then New, each once) and reads GET /v1/market/trades?chain=base&token=<t>&limit=50 for all at once. It
// passes only when the lists answer 200 with at least TOKENS_MIN tokens and every tape answers 200 JSON { trades: [...],
// src: "chain", as_of_ms } and is whole (not filling) at its first answer or within FILLED_MS of it (tape-read.mjs).
// After: helper
// Serial: evm-keyed 166
//   node scripts/live-checks/base-tapes-fill-inside-their-bound.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { APP, BASE, shapeOf, tokensOf, TOKENS_MIN } from "./robinhood-tapes-read-ahead-bounded.mjs";
import { fillingOf, filledVerdict, readFilled } from "./tape-read.mjs";

const KEY = "base-tapes-fill-inside-their-bound";

async function get(base, path, fetchFn) {
  const t0 = performance.now();
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(60_000) });
    const body = await r.text();
    return { status: r.status, ms: Math.round(performance.now() - t0), body };
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t0), body: "", error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function read(base = BASE, fetchFn = fetch, o = {}) {
  const at = new Date().toISOString();
  const lists = await get(base, "/v1/market/lists?chain=base", fetchFn);
  const tokens = lists.status === 200 ? tokensOf(lists.body) : [];
  const answers = await Promise.all(
    tokens.map(async (t) => {
      const path = `/v1/market/trades?chain=base&token=${t}&limit=50`;
      const a = await get(base, path, fetchFn);
      const d = { address: t, status: a.status, ms: a.ms, shape: a.status === 200 ? shapeOf(a.body) : null, ...(a.error ? { error: a.error } : {}), ...(a.status !== 200 ? { body: a.body.slice(0, 120) } : {}) };
      if (a.status === 200 && fillingOf(a.body)) Object.assign(d, { filling: true, filled: await readFilled(() => get(base, path, fetchFn), shapeOf, o) });
      return d;
    }),
  );
  return { base, at, lists: { status: lists.status, ms: lists.ms, tokens: tokens.length }, answers };
}

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const n = run.answers?.length ?? 0;
  say(run.lists?.status === 200 && n >= TOKENS_MIN && n === run.lists.tokens, `base: GET /v1/market/lists answers ${run.lists?.status}, ${n} listed tokens read (at least ${TOKENS_MIN})`);
  for (const a of run.answers ?? []) {
    const ok = a.status === 200 && a.shape === "tape";
    say(ok, `base trades ${a.address}: ${a.status}${a.status === 200 ? ` ${a.shape}${a.filling ? " filling" : " whole"}` : ` ${a.body ?? ""}`}${a.error ? ` ${a.error}` : ""} in ${a.ms} ms`);
    if (ok && a.filling === true) say(filledVerdict(a.filled).ok, `base trades ${a.address}: ${filledVerdict(a.filled).text}`);
  }
  const whole = (run.answers ?? []).filter((a) => a.status === 200 && a.shape === "tape" && a.filling !== true).length;
  const good = (run.answers ?? []).filter((a) => a.status === 200 && a.shape === "tape" && (a.filling !== true || filledVerdict(a.filled).ok)).length;
  const last = Math.max(0, ...(run.answers ?? []).map((a) => (a.filling === true ? (a.filled?.ms ?? 0) : 0)));
  lines.push(`    base: ${good} of ${n} tapes whole inside 45 s, ${whole} of ${n} whole at their first answer, the last filled ${last} ms after its first read`);
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
