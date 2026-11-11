#!/usr/bin/env node
// Live check of card sol-pool-buy-lands-on-mainnet on HELPER_HOST: the Solana pool sender names a blockhash its provider
// does not know before it signs or sends (apps/helper/src/pool/solana.ts simulateSignSend: W's bytes simulated on their
// own blockhash, slot 0 empty), so such a release is refused by name (422 blockhash_not_found) and nothing is sent. For each pool the helper must serve (poolsToRead
// of pool-senders-next-page-helper.mjs: each Solana cluster's deploy record pool, and on devnet each pool of the move) it
// reads GET /v1/pool/fee and POSTs that check's three plants, each signed by a throwaway W on a blockhash no cluster
// made; the tag 2 and the tag 3 pass every check on the bytes and must answer 422 blockhash_not_found. A helper before
// the card answered them 422 simulation_failed, and FAILs. Nothing is sent, and the fee payer signs none of them (a
// refused simulation comes before its signature). It does not prove a buy lands, nor the plain copy beside the bundle, nor the send
// line's new fields: only a mainnet tap does, read on the helper's log and on two RPCs.
// After: helper
//   node scripts/live-checks/sol-pool-buy-lands-on-mainnet-helper.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { BASE } from "./helper-pool-senders.mjs";
import { poolsToRead, read } from "./pool-senders-next-page-helper.mjs";

const KEY = "sol-pool-buy-lands-on-mainnet-helper";
/** The plants that reach the simulation, and the answer each must get: the plant's own blockhash, named. */
export const REACHED = ["next_tag2", "next_tag3"];
const SHA = /^[0-9a-f]{40}$/;
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The check on one recorded run { cluster, pool, reads: [{ asked, status, headers, body }] }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} [${run.cluster}] ${text}`);
  const fee = run.reads?.find((r) => r.asked === "fee");
  say(fee?.status === 200 && json(fee.body)?.pool === run.pool, `GET /v1/pool/fee ${run.pool} answers ${fee?.status}`);
  for (const asked of REACHED) {
    const r = run.reads?.find((x) => x.asked === asked);
    const b = json(r?.body ?? "");
    say(r?.status === 422 && b?.error?.code === "blockhash_not_found" && !("signature" in (b ?? {})), `planted ${asked} on a blockhash no cluster made: ${r?.status} ${r?.body?.slice(0, 120)} (want 422 blockhash_not_found)`);
  }
  for (const r of run.reads ?? []) say(SHA.test(r.headers?.["x-helper-commit"] ?? ""), `[${r.asked}] X-Helper-Commit: ${r.headers?.["x-helper-commit"]}`);
  return { ok: lines.every((l) => l.startsWith("ok ")) && lines.length === 1 + REACHED.length + (run.reads?.length ?? 0), lines };
}

/** Every run PASS, and one for each pool of `want`. */
export function judgeAll(runs, want = poolsToRead()) {
  const lines = [];
  for (const w of want) if (!runs.some((r) => r.pool === w.pool && r.cluster === w.cluster)) lines.push(`BAD [${w.cluster}] no run for pool ${w.pool}`);
  for (const run of runs) lines.push(...judge(run).lines);
  return { ok: runs.length > 0 && !lines.some((l) => l.startsWith("BAD")), lines };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.indexOf(k) < 0 ? undefined : args[args.indexOf(k) + 1]);
  try {
    const pools = poolsToRead();
    if (pools.length === 0) throw new Error("no Solana pool record");
    const runs = [];
    for (const { cluster, pool, program } of pools) runs.push({ cluster, program, ...(await read(opt("--base") ?? BASE, pool)) });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(runs, null, 1)}\n`);
    const r = judgeAll(runs);
    for (const l of r.lines) console.log(l);
    console.log(r.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.log(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
