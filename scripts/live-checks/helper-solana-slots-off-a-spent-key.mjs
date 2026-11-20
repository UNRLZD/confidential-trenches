#!/usr/bin/env node
// Live check of card helper-solana-slots-off-a-spent-key: the deployed helper's Solana slots stay on a keyed provider
// while one of the host's Solana slot keys answers. Live 20 Nov 11:2xZ (release 211) SOLANA_RPC_URL and
// SOLANA_TRADES_RPC_URL were one URL whose plan was spent (HTTP 429 "max usage reached") while SOLANA_HOLDERS_RPC_URL
// answered; GET /v1/health read solana {rpc keyed, holders keyed, trades fallback}, every plain read had gone to
// QuickNode then the public endpoint, and helper-gives-a-trade-its-reads served 16 of 42 Solana reads. The helper now
// reads each slot on the next slot key not spent (apps/helper/src/rpc/rpc.ts slotKey, server.ts solanaTradesRpcs and
// tradesSlotShown). It reads GET /v1/health and passes only when:
//   - it answers 200 with a `solana` object;
//   - while a slot key serves (solana.holders "keyed", or an rpc.solana entry that "answers"), solana.rpc and
//     solana.trades are each "keyed" (or "public": that slot is not set), never "fallback".
// With no slot key serving, "fallback" is the truth and nothing here is judged: INCONCLUSIVE (exit 3). A run that fails
// only on a slot's state reads the health again every 30 s for up to 3 min (the slot retries its key each SLOT_RETRY_MS
// and the probe each minute). Its other end states are helper-gives-a-trade-its-reads (42 of 42 Solana reads served)
// and solana-marks-route-answers (route B not out of its day).
// After: helper
//   node scripts/live-checks/helper-solana-slots-off-a-spent-key.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read, for the test's replay.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EXIT, verdictOf } from "./provider-answer.mjs";

const KEY = "helper-solana-slots-off-a-spent-key";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const SLOTS = ["rpc", "trades"];
export const RETRY_MS = 180_000;
export const RETRY_EVERY_MS = 30_000;
const STATE_LINE = /^BAD solana\.(rpc|trades) /;

export async function read(base = BASE, fetchFn = fetch) {
  const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/health`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
  return { base, status: r.status, body: await r.text() };
}

/** The check on one recorded read: { status, body }. */
export function judge({ status, body }) {
  const lines = [];
  const quiet = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(status === 200, `GET /v1/health answers ${status}`);
  let b;
  try {
    b = JSON.parse(body);
  } catch {
    b = undefined;
  }
  const solana = b?.solana;
  const isObj = typeof solana === "object" && solana !== null && !Array.isArray(solana);
  say(isObj, `solana ${isObj ? "is" : "is not"} an object`);
  if (!isObj) return { ok: false, verdict: "FAIL", lines };
  const list = Array.isArray(b?.rpc?.solana) ? b.rpc.solana : [];
  const serving = [...(solana.holders === "keyed" ? ["the holders slot's key"] : []), ...list.filter((e) => typeof e === "string" && / answers$/.test(e)).map((e) => e.replace(/ answers$/, ""))];
  if (serving.length === 0) quiet.push(`no Solana slot key serves (holders ${JSON.stringify(solana.holders)}, rpc.solana ${JSON.stringify(list)}): not judged`);
  else for (const s of SLOTS) say(solana[s] === "keyed" || solana[s] === "public", `solana.${s} ${JSON.stringify(solana[s])} while ${serving.join(", ")} serves`);
  for (const q of quiet) lines.push(`--- ${q}`);
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet.length > 0);
  return { ok: verdict === "PASS", verdict, lines };
}

/** A run: read and judged, and while it fails only on a slot's state, read again every `everyMs` up to `retryMs`. */
export async function run(readFn, sleep = (ms) => new Promise((go) => setTimeout(go, ms)), retryMs = RETRY_MS, everyMs = RETRY_EVERY_MS) {
  for (let waited = 0; ; waited += everyMs) {
    const answer = await readFn();
    const r = judge(answer);
    const passing = r.verdict === "FAIL" && r.lines.filter((l) => l.startsWith("BAD")).every((l) => STATE_LINE.test(l));
    if (!passing || waited + everyMs > retryMs) return { ...r, answer, waited };
    await sleep(everyMs);
  }
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const { verdict, lines, answer, waited } = await run(() => read(opt("--base", BASE)));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict} (${answer.base}${waited > 0 ? `, after ${waited / 1000} s of re-reads` : ""})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
}
