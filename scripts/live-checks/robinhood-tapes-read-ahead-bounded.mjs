#!/usr/bin/env node
// Live check of card robinhood-tapes-read-ahead-bounded: a listed Robinhood or Base coin's whole trade list inside FILLED_MS of its
// first open, because the helper read it ahead (apps/helper/src/data/evm/swaps.ts tapesAhead: the lists' coins' tapes
// read in the helper's background lane as the lists load, rested ready, so a first open is a reopen). Live helper run
// 44279880076 (18 Nov 10:17Z, helper at ff65a0403): helper-robinhood-capacity opened 12 listed Robinhood coins and 10
// were "still filling 45xxx ms after its first read (21 reads), past 45000 ms", 2 more answered CoinGecko's rows.
// With Origin APP_HOST it reads each chain's Discover lists at HELPER_HOST, takes up to TOKENS listed tokens (Trending 1h,
// then Trending 5m, then New, each once, the order the helper reads them ahead), and reads GET
// /v1/market/trades?chain=<chain>&token=<t>&limit=50 for all of a chain's at once. It passes only when each chain's
// lists answer 200 with at least TOKENS_MIN tokens and every tape answers 200 JSON { trades: [...], src: "chain",
// as_of_ms } and is whole (not filling) at its first answer or within FILLED_MS of it (tape-read.mjs). How many first
// answers were whole at once is printed: the read ahead's own mark.
// After: helper
// Serial: evm-keyed 165
//   node scripts/live-checks/robinhood-tapes-read-ahead-bounded.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { fillingOf, filledVerdict, readFilled } from "./tape-read.mjs";

const KEY = "robinhood-tapes-read-ahead-bounded";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const CHAINS = ["robinhood", "base"];
export const TOKENS = 12;
/** Fewer listed tokens than this is no test of the read ahead: a FAIL, not a pass on little. */
export const TOKENS_MIN = 6;
const ADDRESS = /^0x[0-9a-f]{40}$/;

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

/** The listed tokens a run reads: Trending 1h, then Trending 5m, then New, each once, at most TOKENS. */
export function tokensOf(listsBody) {
  let l;
  try {
    l = JSON.parse(listsBody).lists;
  } catch {
    return [];
  }
  const out = [];
  for (const k of ["trending_1h", "trending_5m", "new"]) for (const r of Array.isArray(l?.[k]) ? l[k] : []) if (typeof r?.token === "string" && ADDRESS.test(r.token) && !out.includes(r.token) && out.length < TOKENS) out.push(r.token);
  return out;
}

/** What a tape's body is: "tape" when it is { trades: [...], src: "chain", as_of_ms }, else what is wrong. */
export function shapeOf(body) {
  try {
    const j = JSON.parse(body);
    if (!Array.isArray(j.trades)) return "no trades list";
    if (j.src !== "chain") return `src ${JSON.stringify(j.src)}`;
    if (!Number.isSafeInteger(j.as_of_ms)) return "no as_of_ms";
    return "tape";
  } catch {
    return "not JSON";
  }
}

export async function read(base = BASE, fetchFn = fetch, o = {}) {
  const at = new Date().toISOString();
  const chains = [];
  for (const chain of CHAINS) {
    const lists = await get(base, `/v1/market/lists?chain=${chain}`, fetchFn);
    const tokens = lists.status === 200 ? tokensOf(lists.body) : [];
    const answers = await Promise.all(
      tokens.map(async (t) => {
        const path = `/v1/market/trades?chain=${chain}&token=${t}&limit=50`;
        const a = await get(base, path, fetchFn);
        const d = { address: t, status: a.status, ms: a.ms, shape: a.status === 200 ? shapeOf(a.body) : null, ...(a.error ? { error: a.error } : {}), ...(a.status !== 200 ? { body: a.body.slice(0, 120) } : {}) };
        if (a.status === 200 && fillingOf(a.body)) Object.assign(d, { filling: true, filled: await readFilled(() => get(base, path, fetchFn), shapeOf, o) });
        return d;
      }),
    );
    chains.push({ chain, lists: { status: lists.status, ms: lists.ms, tokens: tokens.length }, answers });
  }
  return { base, at, chains };
}

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(Array.isArray(run.chains) && CHAINS.every((c) => run.chains.some((x) => x.chain === c)), `both chains read (${CHAINS.join(", ")})`);
  for (const c of run.chains ?? []) {
    const n = c.answers?.length ?? 0;
    say(c.lists?.status === 200 && n >= TOKENS_MIN && n === c.lists.tokens, `${c.chain}: GET /v1/market/lists answers ${c.lists?.status}, ${n} listed tokens read (at least ${TOKENS_MIN})`);
    for (const a of c.answers ?? []) {
      const ok = a.status === 200 && a.shape === "tape";
      say(ok, `${c.chain} trades ${a.address}: ${a.status}${a.status === 200 ? ` ${a.shape}${a.filling ? " filling" : " whole"}` : ` ${a.body ?? ""}`}${a.error ? ` ${a.error}` : ""} in ${a.ms} ms`);
      if (ok && a.filling === true) say(filledVerdict(a.filled).ok, `${c.chain} trades ${a.address}: ${filledVerdict(a.filled).text}`);
    }
    const whole = (c.answers ?? []).filter((a) => a.status === 200 && a.shape === "tape" && a.filling !== true).length;
    const good = (c.answers ?? []).filter((a) => a.status === 200 && a.shape === "tape" && (a.filling !== true || filledVerdict(a.filled).ok)).length;
    lines.push(`    ${c.chain}: ${good} of ${n} tapes whole inside 45 s, ${whole} of ${n} whole at their first answer`);
  }
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
