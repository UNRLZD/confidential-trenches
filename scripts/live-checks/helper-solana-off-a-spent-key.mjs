#!/usr/bin/env node
// Live check of card helper-solana-off-a-spent-key: the deployed helper's Solana reads stay on a keyed provider while one
// answers. Live 20 Nov 08:55Z SOLANA_RPC_URL's plan was spent (HTTP 429 "max usage reached") and GET /v1/health read
// solana.rpc "fallback" with rpc.solana ["helius-rpc.com held", "quiknode.pro answers"]: QuickNode served, and the
// health named the public endpoint. The helper now names a 429 that says the plan is spent "spent" (apps/helper/src/rpc/
// rpc.ts probe) and the rpc slot "keyed" while a keyed spare serves (rpc.ts shownSlot). It reads GET /v1/health and
// passes only when:
//   - it answers 200 with a `solana` object and an `rpc.solana` list, every entry "<domain>[ key<n>][ keyless] <state>";
//   - while any rpc.solana entry "answers", solana.rpc is "keyed" (never "fallback": the public endpoint is not the one
//     serving);
//   - no entry is "held" past the run's re-reads (a held entry with no spent plan is a short throttle, waited out).
// With no entry answering, solana.rpc "fallback" is the truth and nothing here is judged: INCONCLUSIVE (exit 3).
// The mark scan's two routes on two companies are held by sol-pools-mainnet-pin (the provider each route names, by
// company) and by the deploy's start check (apps/helper/src/env-check.ts checkMarksRoute refuses a pair on one company).
// A run that fails only on solana.rpc or a held entry reads the health again every 30 s for up to 3 min: the helper's
// probe reads a keyed URL that did not answer again each minute (rpc.ts KEYED_RETRY_MS).
// After: helper
//   node scripts/live-checks/helper-solana-off-a-spent-key.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read, for the test's replay.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EXIT, verdictOf } from "./provider-answer.mjs";

const KEY = "helper-solana-off-a-spent-key";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
const ENTRY = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+(?: key[1-9])?)( keyless)? (answers|wrong chain|held|spent|down|unread)$/;
export const RETRY_MS = 180_000;
export const RETRY_EVERY_MS = 30_000;
/** The BAD lines a re-read may clear: the slot's state and a held entry. */
const PASSING = /^BAD (solana\.rpc |rpc\.solana: .* held$)/;

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
  const slot = b?.solana?.rpc;
  const list = b?.rpc?.solana;
  say(typeof slot === "string", `solana.rpc is a state: ${JSON.stringify(slot)}`);
  say(Array.isArray(list), `rpc.solana is a list: ${JSON.stringify(list)}`);
  if (typeof slot !== "string" || !Array.isArray(list)) return { ok: false, verdict: "FAIL", lines };
  const parsed = list.map((e) => (typeof e === "string" ? ENTRY.exec(e) : null));
  say(parsed.every((m) => m !== null), `rpc.solana: every entry is "<domain> <state>"`);
  const answering = parsed.filter((m) => m !== null && m[3] === "answers").map((m) => m[1]);
  if (answering.length === 0) quiet.push(`no keyed Solana provider answers (${JSON.stringify(list)}): solana.rpc ${slot} not judged`);
  else say(slot === "keyed", `solana.rpc ${slot} while ${answering.join(", ")} answers`);
  for (const m of parsed) if (m !== null && m[3] === "held") say(false, `rpc.solana: ${m[1]} held`);
  for (const q of quiet) lines.push(`--- ${q}`);
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet.length > 0);
  return { ok: verdict === "PASS", verdict, lines };
}

/** A run: read and judged, and while it fails only on lines a re-read may clear, read again every `everyMs` up to `retryMs`. */
export async function run(readFn, sleep = (ms) => new Promise((go) => setTimeout(go, ms)), retryMs = RETRY_MS, everyMs = RETRY_EVERY_MS) {
  for (let waited = 0; ; waited += everyMs) {
    const answer = await readFn();
    const r = judge(answer);
    const passing = r.verdict === "FAIL" && r.lines.filter((l) => l.startsWith("BAD")).every((l) => PASSING.test(l));
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
