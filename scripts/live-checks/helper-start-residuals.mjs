#!/usr/bin/env node
// Live check of card helper-start-residuals: GET /v1/health never answers ready true while a Base or Robinhood mainnet
// pool holds no fee for the running minute, and it names each pool's fee. Since the card the helper's health answer
// carries X-Helper-Pool-Fees (apps/helper/src/server.ts POOL_FEES_HEADER; pool/evm.ts feeNow): "<network> <fee in wei>"
// once that minute's fee is in memory, "<network> reading" while its read at the minute's start is under way, or
// "<network> none" once that read ended with no fee, and `ready` is false while one names none. Before it, a helper
// whose start check had passed said ready true for the rest of its life, whatever its pools held (the review of card
// helper-evm-ready-holds-a-fee, PR 597). The same card refuses a start on fewer than two answering operators within
// EVM_READY_DEAD_MS: a start is a deploy's, so that half is held by its tests (pool/evm-failover.test.ts).
// Read, with no key and no transaction: GET <helper>/v1/health, its commit, `ready` and X-Helper-Pool-Fees, up to READS
// times EVERY_MS apart until one answers ready true with every mainnet pool's fee named.
// Judged: every read names both mainnet pools (base, robinhood), each a fee in wei over 0, "reading" or "none"; no read
// says ready true while a pool names none; and one read says ready true with both pools' fees named.
// Its recorded runs are helper-start-residuals.answers.json, replayed by its .test.mjs.
// After: helper --commit {commit}
//   node scripts/live-checks/helper-start-residuals.mjs --commit <sha> [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EXIT, verdictOf } from "./provider-answer.mjs";

export const BASE = "https://ct-api.unrealized.trade";
/** The mainnet EVM pools the helper serves (apps/helper/src/pool/evm.ts POOL_EVM_ENV, mainnets only). */
export const NETWORKS = ["base", "robinhood"];
export const HEADER = "x-helper-pool-fees";
/** Reads at most, EVERY_MS apart: past a minute, so a read that meets a minute's first seconds ("reading") is read
 *  again once that read is done. */
export const READS = 8;
export const EVERY_MS = 10_000;
const TIMEOUT_MS = 15_000;
const SHA = /^[0-9a-f]{40}$/;
const PART = /^([a-z0-9-]{1,32}) (\d{1,40}|reading|none)$/;

/** The header's fees by network, or null when it is absent or any part is not "<network> <wei|reading|none>". */
export function feesOf(header) {
  if (typeof header !== "string") return null;
  if (header === "") return {};
  const out = {};
  for (const part of header.split(", ")) {
    const m = PART.exec(part);
    if (m === null || Object.hasOwn(out, m[1])) return null;
    out[m[1]] = m[2];
  }
  return out;
}
const body = (h) => {
  try {
    return JSON.parse(h?.body ?? "null");
  } catch {
    return null;
  }
};
/** Whether one read is the end state: 200, ready true, every mainnet pool's fee named in wei over 0. */
const complete = (h) => {
  const f = feesOf(h?.fees);
  return h?.status === 200 && body(h)?.ready === true && f !== null && NETWORKS.every((n) => /^\d+$/.test(f[n] ?? "") && BigInt(f[n]) > 0n);
};

/** One run: GET /v1/health until a read is complete or READS reads. Never throws: a failed read is recorded. */
export async function read(base = BASE, fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const root = String(base).replace(/\/$/, "");
  const reads = [];
  for (let i = 0; i < READS; i++) {
    const at = new Date().toISOString();
    try {
      const r = await fetchFn(`${root}/v1/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      reads.push({ at, status: r.status, commit: r.headers.get("x-helper-commit"), fees: r.headers.get(HEADER), body: (await r.text()).slice(0, 4_000) });
    } catch (e) {
      reads.push({ at, error: String(e?.message ?? e).slice(0, 200) });
    }
    if (complete(reads.at(-1))) break;
    if (i < READS - 1) await sleep(EVERY_MS);
  }
  return { base: root, reads };
}

/** The verdict of a run for the deployed `commit`: { ok, verdict, lines }. */
export function judge(run, commit) {
  const lines = [];
  const say = (ok, what) => lines.push(`${ok ? "GOOD" : "BAD"} ${what}`);
  if (!SHA.test(String(commit))) say(false, `--commit ${commit ?? "none"} is not a full 40-hex commit`);
  const reads = Array.isArray(run?.reads) ? run.reads : [];
  if (reads.length === 0) say(false, "no read of /v1/health");
  reads.forEach((h, i) => {
    const tag = `[read ${i + 1} ${h?.at ?? ""}]`;
    const b = body(h);
    if (h?.status !== 200 || h?.commit !== commit || b?.commit !== commit) return say(false, `${tag} GET /v1/health answers ${h?.status ?? h?.error ?? "none"}, commit ${h?.commit ?? "none"} (deployed ${commit})`);
    const f = feesOf(h.fees);
    if (f === null) return say(false, `${tag} X-Helper-Pool-Fees ${h.fees === null || h.fees === undefined ? "absent: no pool's fee named" : `not "<network> <wei|reading|none>", ...: ${JSON.stringify(String(h.fees).slice(0, 200))}`}`);
    const missing = NETWORKS.filter((n) => !Object.hasOwn(f, n));
    if (missing.length > 0) return say(false, `${tag} X-Helper-Pool-Fees names no fee for ${missing.join(", ")}: ${JSON.stringify(h.fees)}`);
    const zero = NETWORKS.filter((n) => f[n] !== "reading" && f[n] !== "none" && BigInt(f[n]) === 0n);
    if (zero.length > 0) return say(false, `${tag} a fee of 0 wei for ${zero.join(", ")}`);
    const none = NETWORKS.filter((n) => f[n] === "none");
    if (b?.ready === true && none.length > 0) return say(false, `${tag} ready true while ${none.join(", ")} holds no fee for the running minute: ${JSON.stringify(h.fees)}`);
    lines.push(`${complete(h) ? "GOOD" : "WAIT"} ${tag} ready ${JSON.stringify(b?.ready ?? null)}, ${h.fees}`);
  });
  if (!reads.some(complete)) say(false, `no read answered ready true with every mainnet pool's fee named (${NETWORKS.join(", ")}), in ${reads.length} reads`);
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), false);
  return { ok: verdict === "PASS", verdict, lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  try {
    const commit = opt("--commit");
    if (!SHA.test(String(commit))) throw new Error("--commit <full 40-hex sha> is required");
    const run = await read(opt("--base") ?? BASE);
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(run, null, 1) + "\n");
    const r = judge(run, commit);
    for (const l of r.lines) console.log(l);
    console.log(`${r.verdict} helper-start-residuals`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`helper-start-residuals: ${e?.message ?? e}`);
    process.exit(2);
  }
}
