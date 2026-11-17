#!/usr/bin/env node
// Live check of card solana-marks-route-answers: the helper's route B of the mainnet mark scan, POST
// /v1/rpc/solana-marks (apps/helper/src/rpc/rpc.ts marksRoutes), answers a sign-in's burst of restore scans. Live 16 Nov
// 23:37Z (release 177) it answered every scan 503 upstream at 0 ms, sending nothing: its one provider's day was spent
// by the helper's own background reads, and a restore on a new device stalled ("restore stalled: solana: HTTP 503").
// The card leaves callers a quarter of every keyed account's day (apps/helper/src/limits/limits.ts CALLER_DAY_ROOM).
// It sends BURST scans at once, the wallet lister's exact request (sol-pools-mainnet-pin scanParams: bucket 0 of each
// mark size, the addresses alone) with Origin SIGN_HOST, and passes only when each answers 200 with a list and its
// finalized slot, a full-sha X-Helper-Commit, and names one of route B's providers in its Server-Timing rpc entry. A 503
// is BAD; a scan with no usable answer (read again once: a 429, an empty body) is named on a `---` line and not judged,
// and the run is INCONCLUSIVE (exit 3) unless another line is BAD.
// After: helper
//   node scripts/live-checks/solana-marks-route-answers.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read, for the test's replay.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";
import { B_NAMES, BASE, mainnetProgram, providerOf, scanParams, SIGN, SIZES } from "./sol-pools-mainnet-pin.mjs";

const KEY = "solana-marks-route-answers";
/** Scans sent at once: each mark size twice, a restore's first page on two tabs. [design: 4, under the route's 30 a
 *  client in 10 s (rpc.ts RPC_PAGE_NEED) and QuickNode's 7 at once (limits.ts KEYED_PACE), so only a refusal of the
 *  route itself, never this check's own load, fails it.] */
export const BURST = 4;
const SHA = /^[0-9a-f]{40}$/;

/** The check on one recorded run: { reads: [{ size, status, headers, answer }] }. */
export function judge(run) {
  const lines = [];
  const quiet = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const reads = run.reads ?? [];
  say(reads.length === BURST, `${BURST} scans sent at once: ${reads.length} read`);
  reads.forEach((r, i) => {
    const tag = `[scan ${i + 1} size ${r.size}]`;
    if (r.answer?.noAnswer !== undefined) return void quiet.push(`${tag} ${r.answer.noAnswer}`);
    const v = r.answer?.result?.value;
    const slot = r.answer?.result?.context?.slot;
    const listed = r.status === 200 && Array.isArray(v) && Number.isSafeInteger(slot);
    say(listed, `${tag} a list with its slot: ${listed ? `${v.length} account(s) at slot ${slot}` : `HTTP ${r.status} ${JSON.stringify(r.answer).slice(0, 160)}`}`);
    const h = r.headers ?? {};
    say(SHA.test(h["x-helper-commit"] ?? ""), `${tag} X-Helper-Commit: ${h["x-helper-commit"] ?? "none"}`);
    const name = providerOf(h["server-timing"]);
    const right = name !== null && B_NAMES.includes(name);
    say(right, `${tag} answered by ${name ?? "no named provider"}${right ? "" : `, not one of ${B_NAMES.join(", ")}`}`);
  });
  for (const q of quiet) lines.push(`--- ${q}`);
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet.length > 0);
  return { ok: verdict === "PASS", verdict, lines };
}

/** One scan through rpcAnswer, with Origin SIGN_HOST, its status and headers kept. */
async function scan(url, size, program, fetchFn) {
  const seen = {};
  const withOrigin = async (u, init) => {
    const r = await fetchFn(u, { ...init, redirect: "manual", headers: { ...init.headers, origin: SIGN } });
    seen.status = r.status;
    seen.headers = {};
    for (const k of ["x-helper-commit", "server-timing"]) if (r.headers.get(k) !== null) seen.headers[k] = r.headers.get(k);
    return r;
  };
  const answer = await rpcAnswer(url, "getProgramAccounts", scanParams(program, size), { fetchFn: withOrigin, timeoutMs: 20_000 });
  return { size, status: seen.status ?? 0, headers: seen.headers ?? {}, answer };
}

export async function read(base = BASE, fetchFn = fetch, program = mainnetProgram()) {
  const url = `${base.replace(/\/$/, "")}/v1/rpc/solana-marks`;
  const reads = await Promise.all(Array.from({ length: BURST }, (_, i) => scan(url, SIZES[i % SIZES.length], program, fetchFn)));
  return { check: KEY, base, at: new Date().toISOString(), program, reads };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${verdict} (${run.base})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR: ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
