#!/usr/bin/env node
// Live check of card helper-rpc-batch-learns-reader-size: HELPER_HOST's POST /v1/rpc/{base,robinhood} answers a device
// batch of the most calls the route takes (RPC_BATCH_MAX, 10) in full, whatever batch size each upstream behind it
// takes. Mainnet readers refuse a batch past their size (read 2026-11-18 20:41Z and again 23:20Z): base and robinhood
// .api.pocket.network HTTP 413 past 5, robinhood.drpc.org HTTP 400 code 31 past 3, rpc.sentio.xyz/base HTTP 429 code 8
// past 5, robinhood.daybreak-rpc.network HTTP 413 "max 20 calls". Before this card the helper dropped such an upstream
// for the read (a 413) or passed its refusal to the device as the answer (dRPC's 400, daybreak's 413), and held Sentio
// as if it throttled; now it sends the batch to that upstream in parts of the size it takes
// (apps/helper/src/rpc/rpc.ts fitPost). For each chain, read only, one POST: a batch of BATCH eth_blockNumber, ids 1 to
// BATCH (provider-answer.mjs rpcBatchAnswer).
// PASS when both chains answer HTTP 200 with every call a block number, the BATCH numbers of a chain within SPREAD
// blocks of each other (parts read a moment apart). FAIL: an HTTP answer other than 200 that carries a JSON-RPC error
// (the helper's 503 upstream, its 413 too_large, an upstream's refusal passed on), a call's own error, a call the batch
// left out, or a result that is no block number. INCONCLUSIVE (exit 3), named: a no-answer (no connection, a 429 or a
// rate limit's words, provider-answer.mjs classify).
// After: helper
// Serial: evm-keyed 15 (its batches on the helper's Base and Robinhood route draw the keyed providers)
//   node scripts/live-checks/helper-rpc-batch-learns-reader-size.mjs [--base <url>] [--record <file> --as good|bad]
//     [--answer <file> --as good|bad]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read; --answer judges a
//   recorded run instead of reading.
import "../net-window.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { EXIT, rpcBatchAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "helper-rpc-batch-learns-reader-size";
export const BASE = "https://ct-api.unrealized.trade";
export const CHAINS = Object.freeze(["base", "robinhood"]);
/** The device's largest batch, the route's own limit (packages/kit/src/helper/v1.ts HELPER_RPC_BATCH_MAX). */
export const BATCH = 10;
/** The most blocks a batch's numbers may differ by: parts answered a second apart on Base's 200 ms blocks are 5 apart.
 *  [design: 60, a 12 s spread on Base, 60 s on Robinhood.] */
export const SPREAD = 60;
export const TIMEOUT_MS = 15_000;
const HEX = /^0x[0-9a-f]{1,16}$/i;
const cut = (v, n = 160) => String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, n).replace(/\s+/g, " ");

/** One run: each chain's one batch, as rpcBatchAnswer reads it. */
export async function read(base = BASE, fetchFn = fetch) {
  const reads = {};
  for (const chain of CHAINS) {
    const url = `${base.replace(/\/$/, "")}/v1/rpc/${chain}`;
    reads[chain] = await rpcBatchAnswer(url, Array.from({ length: BATCH }, () => ["eth_blockNumber", []]), { fetchFn, timeoutMs: TIMEOUT_MS });
  }
  return { base, at: new Date().toISOString(), batch: BATCH, reads };
}

/** The check on one run: { verdict, ok, lines }. */
export function judge(run) {
  const lines = [];
  let bad = false;
  let quiet = false;
  const line = (good, s) => {
    lines.push(`${good ? "ok " : "BAD"} ${s}`);
    if (!good) bad = true;
  };
  line(run?.batch === BATCH, `the run's batch is ${run?.batch} calls (the route's most: ${BATCH})`);
  for (const chain of CHAINS) {
    const a = run?.reads?.[chain];
    if (a === undefined) {
      line(false, `${chain}: not read`);
      continue;
    }
    if (a.error !== undefined) {
      line(false, `${chain}: HTTP ${a.status} with one error for the batch: ${cut(a.error)}`);
      continue;
    }
    if (a.noAnswer !== undefined) {
      quiet = true;
      lines.push(`--- ${chain}: ${cut(a.noAnswer)}: INCONCLUSIVE`);
      continue;
    }
    line(a.status === 200, `${chain}: HTTP ${a.status}`);
    const answers = Array.isArray(a.answers) ? a.answers : [];
    line(answers.length === BATCH, `${chain}: ${answers.length} answers for ${BATCH} calls`);
    const blocks = [];
    answers.forEach((x, k) => {
      if (x.error !== undefined) line(false, `${chain} call ${k + 1}: an error: ${cut(x.error)}`);
      else if (x.noAnswer !== undefined && /no answer for call/.test(x.noAnswer)) line(false, `${chain} call ${k + 1}: left out of the batch's answer`);
      else if (x.noAnswer !== undefined) {
        quiet = true;
        lines.push(`--- ${chain} call ${k + 1}: ${cut(x.noAnswer)}: INCONCLUSIVE`);
      } else if (typeof x.result !== "string" || !HEX.test(x.result)) line(false, `${chain} call ${k + 1}: no block number: ${cut(x.result)}`);
      else blocks.push(Number(BigInt(x.result)));
    });
    if (blocks.length === BATCH) {
      const spread = Math.max(...blocks) - Math.min(...blocks);
      line(spread <= SPREAD, `${chain}: ${BATCH} of ${BATCH} calls answered blocks ${Math.min(...blocks)} to ${Math.max(...blocks)} (${spread} apart, at most ${SPREAD})`);
    }
  }
  const verdict = verdictOf(bad, quiet);
  return { verdict, ok: verdict === "PASS", lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
  try {
    const run = arg("--answer") !== undefined ? JSON.parse(readFileSync(arg("--answer"), "utf8"))[arg("--as") ?? "good"] : await read(arg("--base") ?? BASE);
    if (arg("--record") !== undefined) {
      const f = arg("--record");
      const all = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
      all[arg("--as") ?? "good"] = run;
      writeFileSync(f, JSON.stringify(all, null, 1) + "\n");
    }
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`${KEY}: ${verdict}`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
