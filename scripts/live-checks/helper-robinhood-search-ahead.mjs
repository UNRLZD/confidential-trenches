#!/usr/bin/env node
// Live check of card helper-robinhood-search-ahead: a dozen Robinhood tokens opened at once all get their trade tapes
// from the helper's own chain reads within ANSWER_MS. The lists' tokens' pools are looked for as each lists answer loads,
// not at a token's first open (apps/helper/src/data/evm/swaps.ts ahead), and a discovery asks each read with every other
// no answer it waits for names (findPool). Card helper-robinhood-capacity's check asks the same 12 for 200 alone; at
// 38249ca a pinned dozen took up to 15.5 s, 5 of 12 within 15 s on a slow run (2026-11-05 07:2xZ).
// With Origin APP_HOST it reads Robinhood's Discover lists at HELPER_HOST, takes up to TOKENS listed tokens (Trending 1h,
// then Trending 5m, then New, each once), and reads GET /v1/market/trades?chain=robinhood&token=<t>&limit=50 for all of
// them at once. It passes only when the lists answer 200 with at least TOKENS_MIN tokens and every tape answers 200 JSON
// { trades: [...], src: "chain", as_of_ms } within ANSWER_MS. A failing tape is named by its status, Retry-After and time.
// After: helper
//   node scripts/live-checks/helper-robinhood-search-ahead.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "helper-robinhood-search-ahead";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const TOKENS = 12;
/** Fewer listed tokens than this is no test of the queues: a FAIL, not a pass on little. */
export const TOKENS_MIN = 6;
/** A tape's answer past this is a FAIL: a cold token's first read took about 5 s on the helper box (18:55Z). [design:
 *  three times that, under the server's request timeout.] */
export const ANSWER_MS = 15_000;
const ADDRESS = /^0x[0-9a-f]{40}$/;

async function get(base, path, fetchFn) {
  const t0 = performance.now();
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(60_000) });
    const body = await r.text();
    return { status: r.status, retryAfter: r.headers.get("retry-after"), ms: Math.round(performance.now() - t0), body };
  } catch (e) {
    return { status: 0, retryAfter: null, ms: Math.round(performance.now() - t0), body: "", error: String(e?.message ?? e).slice(0, 200) };
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
function shapeOf(body) {
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

export async function read(base = BASE, fetchFn = fetch) {
  const at = new Date().toISOString();
  const lists = await get(base, "/v1/market/lists?chain=robinhood", fetchFn);
  const tokens = lists.status === 200 ? tokensOf(lists.body) : [];
  const answers = await Promise.all(
    tokens.map(async (t) => {
      const a = await get(base, `/v1/market/trades?chain=robinhood&token=${t}&limit=50`, fetchFn);
      return { address: t, status: a.status, retryAfter: a.retryAfter, ms: a.ms, shape: a.status === 200 ? shapeOf(a.body) : null, ...(a.error ? { error: a.error } : {}), ...(a.status !== 200 ? { body: a.body.slice(0, 120) } : {}) };
    }),
  );
  return { base, at, lists: { status: lists.status, ms: lists.ms, tokens: tokens.length }, answers };
}

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const n = run.answers?.length ?? 0;
  say(run.lists?.status === 200 && n >= TOKENS_MIN && n === run.lists.tokens, `GET /v1/market/lists?chain=robinhood answers ${run.lists?.status}, ${n} listed tokens read (at least ${TOKENS_MIN})`);
  const ms = (run.answers ?? []).map((a) => a.ms).sort((x, y) => x - y);
  for (const a of run.answers ?? []) {
    const ok = a.status === 200 && a.shape === "tape" && a.ms <= ANSWER_MS;
    say(ok, `trades ${a.address}: ${a.status}${a.retryAfter ? ` Retry-After ${a.retryAfter}` : ""}${a.status === 200 ? ` ${a.shape}` : ` ${a.body ?? ""}`}${a.error ? ` ${a.error}` : ""} in ${a.ms} ms${a.ms > ANSWER_MS ? ` (past ${ANSWER_MS} ms)` : ""}`);
  }
  const good = (run.answers ?? []).filter((a) => a.status === 200 && a.shape === "tape" && a.ms <= ANSWER_MS).length;
  lines.push(`    ${good} of ${n} tapes 200 within ${ANSWER_MS} ms (p50 ${ms[Math.floor(ms.length / 2)] ?? "-"} ms, max ${ms.at(-1) ?? "-"} ms)`);
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
