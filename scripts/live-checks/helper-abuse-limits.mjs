#!/usr/bin/env node
// Live check of card helper-abuse-limits: the helper throttles one client with a wait a browser can read, and the wait
// it names is true. With Origin APP_HOST on every request it sends GET /v1/pool/fee for a pool no helper carries, one
// request after another, until the first 429 (at most BURST_MAX; the pool routes allow 30 a client in a 10 s window,
// so 61 inside one 10 s span must meet one). It passes only when:
//   - every answer before the 429 is neither a 429 nor a 5xx (the unknown pool's own 404);
//   - the 429 has a Retry-After of whole seconds, 1 to 60; Access-Control-Allow-Origin exactly APP_HOST;
//     Access-Control-Expose-Headers naming Retry-After (else a browser cannot read the wait); Vary: Origin; no
//     Access-Control-Allow-Credentials; and a body that is exactly { error: { code: "rate_limited" } };
//   - after waiting the Retry-After it named, the same request is no longer a 429.
// A second client in the same window is not read here: from one machine the helper sees one client (Caddy writes
// X-Forwarded-For from the peer it saw). apps/helper/src/server.test.ts reads it on a real socket with two forwarded
// addresses.
//   node scripts/live-checks/helper-abuse-limits.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "helper-abuse-limits";
export const BASE = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
/** A pool no helper carries (the system program's address): the route answers 404 after the limit, reading nothing. */
export const PROBE = "/v1/pool/fee?pool=11111111111111111111111111111111";
/** Two windows' worth and one: inside one 10 s span this many must meet a 429. */
export const BURST_MAX = 61;

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));

async function one(base, fetchFn) {
  const r = await fetchFn(`${base.replace(/\/$/, "")}${PROBE}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
  const headers = {};
  for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
  return { status: r.status, headers, body: await r.text() };
}

/** The burst, the 429 and the read after its wait: { base, statuses, throttle, after }. */
export async function read(base = BASE, fetchFn = fetch, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))) {
  const statuses = [];
  let throttle = null;
  for (let i = 0; i < BURST_MAX && throttle === null; i++) {
    const r = await one(base, fetchFn);
    statuses.push(r.status);
    if (r.status === 429) throttle = r;
  }
  let after = null;
  const wait = Number(throttle?.headers["retry-after"]);
  if (throttle !== null && Number.isInteger(wait) && wait >= 1 && wait <= 60) {
    await sleep(wait * 1000 + 250);
    after = await one(base, fetchFn);
  }
  return { base, statuses, throttle, after };
}

/** The check on one recorded run. */
export function judge({ statuses, throttle, after }) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const before = throttle === null ? statuses : statuses.slice(0, -1);
  say(before.every((s) => s !== 429 && s < 500), `before the first 429: ${before.length} answers, none 429 or 5xx (${[...new Set(before)].join(", ") || "none"})`);
  say(throttle !== null, `a 429 within ${BURST_MAX} requests (${statuses.length} sent)`);
  if (throttle !== null) {
    const h = throttle.headers;
    const wait = h["retry-after"];
    say(/^[1-9][0-9]?$/.test(wait ?? "") && Number(wait) <= 60, `Retry-After ${show(wait)}, whole seconds 1 to 60`);
    say(h["access-control-allow-origin"] === APP, `Access-Control-Allow-Origin ${show(h["access-control-allow-origin"])}`);
    const exposed = (h["access-control-expose-headers"] ?? "").split(",").map((s) => s.trim().toLowerCase());
    say(exposed.includes("retry-after"), `Access-Control-Expose-Headers ${show(h["access-control-expose-headers"])} names Retry-After`);
    say((h.vary ?? "").split(",").map((s) => s.trim().toLowerCase()).includes("origin"), `Vary ${show(h.vary)}`);
    say(h["access-control-allow-credentials"] === undefined, `Access-Control-Allow-Credentials ${show(h["access-control-allow-credentials"])}`);
    let body;
    try {
      body = JSON.parse(throttle.body);
    } catch {
      body = undefined;
    }
    say(JSON.stringify(body) === '{"error":{"code":"rate_limited"}}', `body ${show(throttle.body)} is the code only`);
    say(after !== null && after.status !== 429, `after the named wait: ${after === null ? "not read" : after.status}, not 429`);
  }
  lines.push("note second client: not read live (one source address: Caddy writes X-Forwarded-For from the peer); apps/helper/src/server.test.ts reads it with two forwarded addresses");
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const answer = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, lines } = judge(answer);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${answer.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
