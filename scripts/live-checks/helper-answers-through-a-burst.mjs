#!/usr/bin/env node
// Live check of card helper-answers-through-a-burst: the deployed helper answers a burst of page opens, each answer
// within the bound and readable by the page, never a 502 from Caddy with no CORS header (19 Nov 14:30-14:33Z: every
// answer a 502 in 3.6 s while 300 live run jobs opened pages at once). It reads the Solana lists once for the coin the
// first screen opens, then PAGES pages' first reads all at once (apps/terminal/src: the four chains' lists, the token,
// its tape and its chart; apps/helper/deploy/burst.mjs is the same page at any size, for a copy of the helper only),
// and SOCKETS of the pages' push sockets with them (each a fresh connection Caddy must dial: on a copy of main, 112 of
// 600 pages' sockets failed while every plain read got through). The burst is bounded so the check can never make an
// outage of its own: PAGES * READS requests, all cached reads, under one client's window (the helper's API_RATE_MAX,
// 120 in 10 s), and SOCKETS sockets under one client's PUSH_CLIENT_MAX (8), each closed once upgraded, once. It passes
// only when:
//   - every request is answered (no connection error, no timeout at TIMEOUT_MS) and every socket is upgraded (101);
//   - no answer is a 502, 504 or 500, and every answer carries Access-Control-Allow-Origin APP_HOST, so the page reads
//     it (a 503 the helper sheds with, a 429, a 200);
//   - the answers' p99 is within P99_MAX_MS.
// After: helper
//   node scripts/live-checks/helper-answers-through-a-burst.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const KEY = "helper-answers-through-a-burst";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** Pages opened at once [design: 12 pages of READS each, 84 requests, under API_RATE_MAX's 120 a client in 10 s with
 *  the lists read for the coin, so a pass is never a 429 of the check's own making]. */
export const PAGES = 12;
/** The first screen's reads of one page (the four lists, the token, its tape, its chart). */
export const READS = 7;
/** The pages' push sockets opened with them [design: 6, under the helper's PUSH_CLIENT_MAX of 8 a client]. */
export const SOCKETS = 6;
export const PUSH = "/v1/market/push";
/** The p99 bound on one answer, the card's [design: 3 s; a cached read answers in milliseconds]. */
export const P99_MAX_MS = 3_000;
/** How long one request may take before it counts as unanswered [design: the page's own 10 s read bound]. */
export const TIMEOUT_MS = 10_000;
const CHAINS = ["solana", "base", "robinhood", "near"];

/** A path without its query. */
const routeOf = (path) => path.split("?")[0];
const pct = (xs, p) => (xs.length === 0 ? null : [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]);

/** One page's first reads for `token`, as paths. */
export function pagePaths(token) {
  const t = encodeURIComponent(token);
  return [...CHAINS.map((c) => `/v1/market/lists?chain=${c}`), `/v1/market/token?chain=solana&token=${t}`, `/v1/market/trades?chain=solana&token=${t}&limit=50`, `/v1/market/candles?chain=solana&token=${t}&tf=15m&limit=500`];
}

async function one(base, fetchFn, path, now) {
  const began = now();
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await r.text();
    return { route: routeOf(path), status: r.status, ms: Math.round(now() - began), cors: r.headers.get("access-control-allow-origin"), body: r.status === 200 ? undefined : body.slice(0, 200) };
  } catch (e) {
    return { route: routeOf(path), status: null, ms: Math.round(now() - began), error: String(e?.cause?.code ?? e?.name ?? "error") };
  }
}

/** One push socket's handshake with Origin APP_HOST: 101 when upgraded (then closed), else the status answered, null
 *  with no answer in TIMEOUT_MS. */
export function upgrade(base, coin, now = () => performance.now()) {
  const url = new URL(`${PUSH}?chain=solana&token=${encodeURIComponent(coin)}`, base);
  const headers = { Origin: APP, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64") };
  const began = now();
  return new Promise((ok) => {
    const req = (url.protocol === "https:" ? https : http).request(url, { headers, timeout: TIMEOUT_MS, agent: false });
    const end = (status, error) => ok({ route: PUSH, status, ms: Math.round(now() - began), ...(error === undefined ? {} : { error }) });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "timeout" })));
    req.on("error", (e) => end(null, String(e?.code ?? "error")));
    req.on("response", (res) => (res.resume(), end(res.statusCode)));
    req.on("upgrade", (res, socket) => (socket.destroy(), end(res.statusCode)));
    req.end();
  });
}

/** The run: { base, coin, answers }; answers in the order sent, each by its route (the path, no query: a record holds
 *  no coin address beside a "token" key, which a secret scan reads as one). */
export async function read(base = BASE, fetchFn = fetch, now = () => performance.now(), upgradeFn = upgrade) {
  let coin = null;
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/market/lists?chain=solana`, { headers: { origin: APP }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const s = await r.json();
    coin = Object.values(s.lists ?? {}).flat().map((x) => x?.token).find((t) => typeof t === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) ?? null;
  } catch {
    coin = null;
  }
  if (coin === null) return { base, coin, answers: [] };
  const paths = Array.from({ length: PAGES }, () => pagePaths(coin)).flat();
  const answers = await Promise.all([...paths.map((p) => one(base, fetchFn, p, now)), ...Array.from({ length: SOCKETS }, () => upgradeFn(base, coin, now))]);
  return { base, coin, answers };
}

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const all = Array.isArray(run?.answers) ? run.answers : [];
  const answers = all.filter((a) => a.route !== PUSH);
  const sockets = all.filter((a) => a.route === PUSH);
  say(typeof run?.coin === "string", `the coin the first screen opens, from the Solana lists: ${run?.coin ?? "none read"}`);
  say(answers.length === PAGES * READS, `${answers.length} reads of ${PAGES} pages at once (want ${PAGES * READS})`);
  const shut = sockets.filter((a) => a.status !== 101);
  say(sockets.length === SOCKETS && shut.length === 0, `push sockets upgraded: ${sockets.length - shut.length} of ${sockets.length} (want ${SOCKETS}; not: ${shut.map((a) => a.status ?? a.error).join(", ") || "none"})`);
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
