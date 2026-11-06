#!/usr/bin/env node
// Live check of card helper-page-jup-429: every answer of the helper's Jupiter proxy names its own waits in
// Server-Timing, and a 503 names its cause (apps/helper/src/proxy/proxy.ts Cause: 429, held, budget, 5xx, timeout,
// send, key, answer), so a red build reads its cause off the answer (live run 42143211092 at 01:21Z: the swap build the
// device asks for answered a bare 503, and nothing said why). One build of 0.01 SOL into USDC for a fresh wallet goes
// through POST /v1/proxy/jupiter/swap/v2/build, as the kit asks it, and passes only when:
//   - the answer is 200 or 400 (Jupiter's own refusal, passed through) with Server-Timing holding the call's turn and
//     send (turn;dur=, send;dur=), or a 503 upstream whose Server-Timing names its cause (cause;desc="<cause>");
//   - never a 503 with no cause (a bare 503), never a 200 with no Server-Timing (a helper from before the card).
// The waits a Jupiter 429 made (429;desc="<n>") are printed, so a run that met one shows it was waited out.
//   node scripts/live-checks/helper-page-jup-429.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "helper-page-jup-429";
export const BASE = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
export const PATH = "/v1/proxy/jupiter/swap/v2/build";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const CAUSES = ["429", "held", "budget", "5xx", "timeout", "send", "key", "answer"];
const CAUSE = new RegExp(`(^|,\\s*)cause;desc="(${CAUSES.join("|")})"(,|$)`);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A fresh wallet address: 32 random bytes in base58 (a taker nobody holds, so the build moves nothing). */
function wallet() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let n = BigInt(`0x${Buffer.from(b).toString("hex")}`);
  let s = "";
  while (n > 0n) (s = B58[Number(n % 58n)] + s), (n /= 58n);
  return s;
}

export async function read(base = BASE, fetchFn = fetch) {
  const q = new URLSearchParams({ inputMint: SOL, outputMint: USDC, amount: "10000000", slippageBps: "1000", computeUnitPricePercentile: "veryHigh", maxAccounts: "40", taker: wallet() });
  const readAt = new Date().toISOString();
  const t0 = performance.now();
  const r = await fetchFn(`${base.replace(/\/$/, "")}${PATH}?${q}`, { method: "POST", redirect: "error", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(10_000) });
  const body = await r.text();
  return { base, readAt, ms: Math.round(performance.now() - t0), status: r.status, timing: r.headers.get("server-timing"), retryAfter: r.headers.get("retry-after"), body: body.slice(0, 120) };
}

/** The check on one recorded read. */
export function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const t = typeof r.timing === "string" ? r.timing : "";
  const waits = t.match(/(^|,\s*)429;desc="(\d+)"/)?.[2];
  if (r.status === 503) {
    say(CAUSE.test(t), `a 503 names its cause in Server-Timing: ${t || "none (a bare 503)"}${r.retryAfter ? `; Retry-After ${r.retryAfter}` : ""}`);
  } else {
    say(r.status === 200 || r.status === 400, `the build answered ${r.status} in ${r.ms} ms${r.status === 200 || r.status === 400 ? "" : ` (${String(r.body).slice(0, 80)})`}`);
    say(/(^|,\s*)turn;dur=\d+/.test(t) && /(^|,\s*)send;dur=\d+/.test(t), `Server-Timing names the call's turn and send: ${t || "none"}${waits ? ` (${waits} Jupiter 429 waited out)` : ""}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const r = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(r, null, 1)}\n`);
    const { ok, lines } = judge(r);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${r.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
