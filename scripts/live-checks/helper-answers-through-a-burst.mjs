#!/usr/bin/env node
// Live check of card helper-answers-through-a-burst: the deployed helper answers a burst of page opens, each answer
// within the bound and readable by the page, never a 502 from Caddy with no CORS header (19 Nov 14:30-14:33Z: every
// answer a 502 in 3.6 s while 300 live run jobs opened pages at once). It reads the Solana lists once for the coin the
// first screen opens, then PAGES pages' first reads all at once (apps/terminal/src: the four chains' lists, the token,
// its tape and its chart; apps/helper/deploy/burst.mjs is the same page at any size, for a copy of the helper only).
// The burst is bounded so the check can never make an outage of its own: PAGES * READS requests, all cached reads,
// under one client's window (the helper's API_RATE_MAX, 120 in 10 s), once. It passes only when:
//   - every request is answered (no connection error, no timeout at TIMEOUT_MS);
//   - no answer is a 502, 504 or 500, and every answer carries Access-Control-Allow-Origin APP_HOST, so the page reads
//     it (a 503 the helper sheds with, a 429, a 200);
//   - the answers' p99 is within P99_MAX_MS.
// After: helper
//   node scripts/live-checks/helper-answers-through-a-burst.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "helper-answers-through-a-burst";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** Pages opened at once [design: 12 pages of READS each, 96 requests, under API_RATE_MAX's 120 a client in 10 s with
 *  the lists read for the coin, so a pass is never a 429 of the check's own making]. */
export const PAGES = 12;
/** The first screen's reads of one page (the four lists, the token, its tape, its chart). */
export const READS = 7;
/** The p99 bound on one answer, the card's [design: 3 s; a cached read answers in milliseconds]. */
export const P99_MAX_MS = 3_000;
/** How long one request may take before it counts as unanswered [design: the page's own 10 s read bound]. */
export const TIMEOUT_MS = 10_000;
const CHAINS = ["solana", "base", "robinhood", "near"];

const pct = (xs, p) => (xs.length === 0 ? null : [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]);

/** One page's first reads for `token`, as paths. */
export function pagePaths(token) {
  const q = `chain=solana&token=${encodeURIComponent(token)}`;
  return [...CHAINS.map((c) => `/v1/market/lists?chain=${c}`), `/v1/market/token?${q}`, `/v1/market/trades?${q}&limit=50`, `/v1/market/candles?${q}&tf=15m&limit=500`];
}

async function one(base, fetchFn, path, now) {
  const began = now();
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await r.text();
    return { path, status: r.status, ms: Math.round(now() - began), cors: r.headers.get("access-control-allow-origin"), body: r.status === 200 ? undefined : body.slice(0, 200) };
  } catch (e) {
    return { path, status: null, ms: Math.round(now() - began), error: String(e?.cause?.code ?? e?.name ?? "error") };
  }
}

/** The run: { base, token, answers }; answers in the order sent. */
export async function read(base = BASE, fetchFn = fetch, now = () => performance.now()) {
  let token = null;
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/market/lists?chain=solana`, { headers: { origin: APP }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const s = await r.json();
    token = Object.values(s.lists ?? {}).flat().map((x) => x?.token).find((t) => typeof t === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) ?? null;
  } catch {
    token = null;
  }
  if (token === null) return { base, token, answers: [] };
  const paths = Array.from({ length: PAGES }, () => pagePaths(token)).flat();
  const answers = await Promise.all(paths.map((p) => one(base, fetchFn, p, now)));
  return { base, token, answers };
}

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const answers = Array.isArray(run?.answers) ? run.answers : [];
  say(typeof run?.token === "string", `the coin the first screen opens, from the Solana lists: ${run?.token ?? "none read"}`);
  say(answers.length === PAGES * READS, `${answers.length} reads of ${PAGES} pages at once (want ${PAGES * READS})`);
  const lost = answers.filter((a) => a.status === null);
  say(lost.length === 0, `unanswered: ${lost.length}${lost.length ? ` (${[...new Set(lost.map((a) => a.error))].join(", ")})` : ""}`);
  const broken = answers.filter((a) => a.status === 500 || a.status === 502 || a.status === 504);
  say(broken.length === 0, `500, 502 or 504: ${broken.length}`);
  const unread = answers.filter((a) => a.status !== null && a.cors !== APP);
  say(unread.length === 0, `answers a page cannot read (no Access-Control-Allow-Origin ${APP}): ${unread.length}`);
  const by = {};
  for (const a of answers) by[a.status ?? "none"] = (by[a.status ?? "none"] ?? 0) + 1;
  const p99 = pct(answers.filter((a) => a.status !== null).map((a) => a.ms), 99);
  say(p99 !== null && p99 <= P99_MAX_MS, `p99 ${p99 ?? "none"} ms, within ${P99_MAX_MS} ms (p50 ${pct(answers.map((a) => a.ms), 50) ?? "none"} ms; by status ${JSON.stringify(by)})`);
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    const record = opt("--record", null);
    if (record !== null) writeFileSync(record, `${JSON.stringify(run, null, 2)}\n`);
    const v = judge(run);
    for (const l of v.lines) console.log(l);
    console.log(`live-check ${KEY}: ${v.ok ? "PASS" : "FAIL"}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: error ${e?.message ?? e}`);
    process.exit(2);
  }
}
