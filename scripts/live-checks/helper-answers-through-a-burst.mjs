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
// Each page is read as a browser reads it (card helper-checks-read-over-the-pages-connection): one HTTP/2 connection to
// HELPER_HOST carrying that page's READS reads at once (h2Page), each slow read naming when its page connected; Caddy
// still sends every read to the helper as its own request, so the helper meets the same burst. Before the card every read
// was a fetch of its own, PAGES * READS new connections from one machine at once, which no page makes: on helper live run
// 45538634464 the reads' headers came at 3.9 s with the helper's own time 0 ms (Server-Timing total;dur=0), red on the
// three helper runs before it, while the same burst from a Mac got its headers at 0.65 s.
// After: helper
// Record: each read's route, status, times and Server-Timing; a live run that fails keeps it beside its log
// Budget-exempt: its token reads are for a coin it takes from the Solana lists, and a listed coin takes its row from Discover's lists with no Jupiter call (apps/helper/src/data/solana/token.ts listedRow)
//   node scripts/live-checks/helper-answers-through-a-burst.mjs [--base <url>] [--coin <Solana mint>] [--record <file>]
// It prints each route's p50, p99 and max and the slowest reads with the helper's Server-Timing, so a p99 past the bound
// names the reads that made it; --coin opens that coin in place of the lists' first (a cold coin's first answers).
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { gunzipSync } from "node:zlib";

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
/** The slowest reads a run names with their Server-Timing. */
export const SLOWEST = 5;

/** A path without its query. */
const routeOf = (path) => path.split("?")[0];
const pct = (xs, p) => (xs.length === 0 ? null : [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]);

/** One page's first reads for `token`, as paths. */
export function pagePaths(token) {
  const t = encodeURIComponent(token);
  return [...CHAINS.map((c) => `/v1/market/lists?chain=${c}`), `/v1/market/token?chain=solana&token=${t}`, `/v1/market/trades?chain=solana&token=${t}&limit=50`, `/v1/market/candles?chain=solana&token=${t}&tf=15m&limit=500`];
}

/** A lists read's chain, as a record names it ({} for any other read). */
const chainOf = (path) => (routeOf(path) === "/v1/market/lists" ? { chain: new URLSearchParams(path.split("?")[1] ?? "").get("chain") } : {});

/** One read: its route, status, time and CORS header (with `keep`, the whole body as `text`, for the caller to drop);
 *  when it was sent (`at`, on `now`'s clock) and when its headers came (`head`, ms after it was sent), so a slow read
 *  tells a wait for the answer (late headers: the helper or the proxy before it) from its transfer (late body); a lists
 *  read names its chain. */
async function one(base, fetchFn, path, now, keep = false) {
  const began = now();
  const chain = chainOf(path);
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const head = Math.round(now() - began);
    const body = await r.text();
    // the helper's own account of the read (Server-Timing: each upstream it waited on, and its total), so a slow answer
    // names its wait
    const timing = r.headers.get("server-timing");
    return { route: routeOf(path), ...chain, status: r.status, ms: Math.round(now() - began), at: Math.round(began), head, cors: r.headers.get("access-control-allow-origin"), body: r.status === 200 ? undefined : body.slice(0, 200), ...(timing ? { timing } : {}), ...(keep && r.status === 200 ? { text: body } : {}) };
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

/** One page's first reads as a browser sends them (card helper-checks-read-over-the-pages-connection): one HTTP/2
 *  connection to `base`, every path a stream on it, all sent at once; the answers are one()'s, in `paths` order, each
 *  with `conn`, when the page's connection was up (ms after its reads were sent), so a slow read tells its page's connect
 *  from the helper's wait. A page not done in `timeoutMs` (TIMEOUT_MS) has its connection ended, every read still open on
 *  it a TimeoutError, as one()'s is, so the page always ends; a refused connection names its code on every read. */
export async function h2Page(base, paths, now = () => performance.now(), timeoutMs = TIMEOUT_MS) {
  const began = now();
  const session = http2.connect(base);
  const closed = new Promise((ok) => session.once("close", ok));
  let conn, lost;
  session.once("connect", () => (conn = Math.round(now() - began)));
  session.on("error", (e) => (lost = e));
  let late = false;
  const timer = setTimeout(() => ((late = true), session.destroy()), timeoutMs);
  const reads = paths.map((path) => new Promise((done) => {
    const req = session.request({ ":method": "GET", ":path": path, origin: APP, "accept-encoding": "gzip" });
    let h = null, head, ended = false;
    const chunks = [];
    req.on("response", (x) => ((h = x), (head = Math.round(now() - began))));
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => (ended = true));
    req.on("error", () => {}); // named below: the page's timeout, the session's error, or the stream's own end
    req.on("close", () => {
      const ms = Math.round(now() - began);
      if (h === null || !ended) return done({ route: routeOf(path), ...chainOf(path), status: null, ms, error: late ? "TimeoutError" : `rst ${req.rstCode}` });
      const status = h[":status"];
      let body = "";
      if (status !== 200) {
        const raw = Buffer.concat(chunks);
        try {
          body = (h["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8").slice(0, 200);
        } catch {
          body = raw.toString("utf8").slice(0, 200);
        }
      }
      const timing = h["server-timing"];
      done({ route: routeOf(path), ...chainOf(path), status, ms, at: Math.round(began), head, cors: h["access-control-allow-origin"] ?? null, body: status === 200 ? undefined : body, ...(timing ? { timing } : {}) });
    });
    req.end();
  }));
  const answers = await Promise.all(reads);
  session.close();
  await closed;
  clearTimeout(timer);
  // a refused or broken connection is named by its own code on every read it took down (the session's error comes after
  // its streams close)
  return answers.map((a) => ({ ...a, ...(a.status === null && lost !== undefined && !late ? { error: String(lost.code ?? lost.name ?? "error") } : {}), ...(conn === undefined ? {} : { conn }) }));
}

/** One page's first reads as one fetch each, in `paths` order: a plain http base (deploy/burst-proof.sh's local Caddy,
 *  which serves no HTTP/2 without TLS) or a fetch a test hands in. */
export const fetchPage = (fetchFn) => (base, paths, now) => Promise.all(paths.map((p) => one(base, fetchFn, p, now)));

/** How a run reads its pages: over HTTPS with the network's fetch, as a browser does (h2Page); else one fetch a read. */
export const pageOf = (base, fetchFn) => (fetchFn === fetch && new URL(base).protocol === "https:" ? h2Page : fetchPage(fetchFn));

/** The run: { base, coin, answers }; answers in the order sent, each by its route (the path, no query: a record holds
 *  no coin address beside a "token" key, which a secret scan reads as one). */
export async function read(base = BASE, fetchFn = fetch, now = () => performance.now(), upgradeFn = upgrade, asked = null) {
  // the lists read for the coin, kept in the record when it names none (a 502, a 503 shed, a timeout), so a replay says why
  const first = await one(base, fetchFn, "/v1/market/lists?chain=solana", now, true);
  let coin = null;
  try {
    coin = Object.values(JSON.parse(first.text ?? "{}").lists ?? {}).flat().map((x) => x?.token).find((t) => typeof t === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) ?? null;
  } catch {
    coin = null;
  }
  delete first.text;
  // --coin: a coin the operator names (a cold one, to read its first answers), in place of the lists' first
  if (asked !== null) coin = asked;
  if (coin === null) return { base, coin, answers: [first] };
  const pageFn = pageOf(base, fetchFn);
  const answers = (await Promise.all([...Array.from({ length: PAGES }, () => pageFn(base, pagePaths(coin), now)), ...Array.from({ length: SOCKETS }, () => upgradeFn(base, coin, now))])).flat();
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
  // each route's own times, and the slowest reads with the helper's Server-Timing, so a p99 past the bound names its reads
  for (const route of [...new Set(answers.map((a) => a.route))]) {
    const ms = answers.filter((a) => a.route === route && a.status !== null).map((a) => a.ms);
    lines.push(`    ${route}: ${ms.length} answered, p50 ${pct(ms, 50) ?? "none"} ms, p99 ${pct(ms, 99) ?? "none"} ms, max ${ms.length ? Math.max(...ms) : "none"} ms`);
  }
  // card helper-stays-fast-under-the-live-run: each slow read's start after the burst's first and its headers' time, and
  // a lists read's chain: helper-21's run 44989861313 landed every route at ~2.4 s, the slowest lists reads naming
  // nothing (no Server-Timing, no chain), so whether the wait was the answer's or its transfer was not read
  const first = Math.min(...answers.filter((a) => Number.isFinite(a.at)).map((a) => a.at));
  const when = (a) => (Number.isFinite(a.at) && Number.isFinite(a.head) ? `, sent +${a.at - first} ms, ${Number.isFinite(a.conn) ? `page connected at ${a.conn} ms, ` : ""}headers at ${a.head} ms` : "");
  for (const a of [...answers].filter((a) => a.status !== null).sort((x, y) => y.ms - x.ms).slice(0, SLOWEST)) lines.push(`    slow: ${a.route}${a.chain ? `?chain=${a.chain}` : ""} ${a.status} ${a.ms} ms${when(a)}${a.timing ? ` (${a.timing})` : ""}`);
  say(p99 !== null && p99 <= P99_MAX_MS, `p99 ${p99 ?? "none"} ms, within ${P99_MAX_MS} ms (p50 ${pct(answers.map((a) => a.ms), 50) ?? "none"} ms; by status ${JSON.stringify(by)})`);
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE), fetch, () => performance.now(), upgrade, opt("--coin", null));
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
