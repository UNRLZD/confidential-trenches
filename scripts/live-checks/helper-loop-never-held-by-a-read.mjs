#!/usr/bin/env node
// Live check of card helper-loop-never-held-by-a-read: a page reads a 503's cause cross-origin. The helper names why it
// answered 503 in Server-Timing (server.ts SHED_WAIT's `loop` for the shed, a named read's wait otherwise), but a browser
// hands a page only the headers Access-Control-Expose-Headers names, and the kit's HELPER_CORS (packages/kit/src/helper/
// v1.ts) named Retry-After and not Server-Timing, so the app saw every 503 as bare. It reads the Solana lists, a cached
// read, with the app's Origin and passes only when the answer is 200, echoes that Origin, and its
// Access-Control-Expose-Headers names Server-Timing and Retry-After. The loop's own end state (no read's answer holds
// it past 100 ms) is read by helper-loop-never-held-by-a-write.mjs after the same deploy.
// After: helper
//   node scripts/live-checks/helper-loop-never-held-by-a-read.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "helper-loop-never-held-by-a-read";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const PATH = "/v1/market/lists?chain=solana";
/** The read's bound [design: the page's own 10 s read bound]. */
export const TIMEOUT_MS = 10_000;
/** The headers a page must read cross-origin: a 503's cause and its wait. */
export const EXPOSED = ["Server-Timing", "Retry-After"];

/** The run: { base, status, origin, expose, commit }. */
export async function read(base = BASE, fetchFn = fetch) {
  const r = await fetchFn(`${base.replace(/\/$/, "")}${PATH}`, { redirect: "manual", headers: { origin: APP }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  await r.arrayBuffer();
  return { base, status: r.status, origin: r.headers.get("access-control-allow-origin"), expose: r.headers.get("access-control-expose-headers"), commit: r.headers.get("x-helper-commit") };
}

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(run?.status === 200, `GET ${PATH} from ${APP} answers ${run?.status ?? "nothing"}${run?.commit ? ` (helper ${run.commit.slice(0, 9)})` : ""}`);
  say(run?.origin === APP, `Access-Control-Allow-Origin ${JSON.stringify(run?.origin ?? null)}`);
  const named = String(run?.expose ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => h !== "");
  for (const h of EXPOSED) say(named.includes(h.toLowerCase()), `Access-Control-Expose-Headers ${JSON.stringify(run?.expose ?? null)} names ${h}`);
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
