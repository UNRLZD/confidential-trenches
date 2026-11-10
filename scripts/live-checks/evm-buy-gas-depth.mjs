#!/usr/bin/env node
// Live check of card evm-buy-gas-depth: the deployed helper prices each EVM pool's epoch fee on the gas limit it signs
// a buy with, so the fee per gas of that limit is at least twice the epoch block's base fee and a buy is fee_stale only
// once the base fee has doubled. PrivacyPoolSimple.buy reverts when gasleft() is under 651,000 before its swap, so a
// buy's limit (eth_estimateGas, which lands on that floor, x 1.2) is about twice its gas used; the kit's G(depth)
// (packages/kit/src/trade/evm/pool-fee.ts) covers it at every depth, which packages/kit/test/evm-pool-fee.test.ts holds
// against the measured table. For each EVM pool a deploy record names (scripts/ci/helper-live-checks.mjs evmPools):
//   - the chain's head on two of the network's providers (below): the newest epoch both hold a block in, E, the
//     epoch it judges (card evm-fee-quiet-epoch: helper live run 42726731385 asked the epoch now in the first half
//     second of 10 Nov 00:15Z, before the helper's provider held a block in it, and went red on a 404 that answered
//     200 two minutes later);
//   - GET <helper>/v1/pool/fee?pool=<pool>&epoch=<E> (evm-pool-fee-epoch.mjs evmPoolFeeAsk: on the helper's
//     "no block yet", 503 index_behind, or 404 not_found, E less one epoch, which both providers are a minute past):
//     200, this network, pool and epoch, the epoch's first block and its fee in wei. A pool the helper does not carry
//     answers 404 to both: FAIL. Fewer than two providers answering the head, two heads over an epoch apart, or no
//     epoch within a proof's life (POOL_LIFE_MAX_MS) with a block: INCONCLUSIVE, never a pass on nothing;
//   - that block, read by number on the kit's providers for the network (evmPoolVenues: its fee providers first, then
//     its quote providers): one hash and one base fee on every provider that answered, and the pool's
//     currentTreeDepth() at that hash, one word on each, with at least two answering;
//   - the fee is at least 2 x the base fee x G(depth).
// A provider that answers nothing usable (provider-answer.mjs: an empty body, not JSON, a 429 or a rate limit, a block
// or state it does not hold, read again once) is named and left out, never judged: robinhood.drpc.org answered
// "Unknown state. First available state is 1" (code 27) and the check died with exit 2 (helper live run 42556116812,
// 9 Nov 03:54Z). Any other JSON-RPC error is a wrong answer. Fewer than two answering for a pool is INCONCLUSIVE.
// The helper before this card priced G on the buy's gas used (686,816 at depth 2), under half of its limit: its fee on
// Base Sepolia at a 0.005 gwei base fee was the one-step floor, 1e13 wei, under 2 x 0.005 gwei x G(4) = 1.477e13.
// The buy's gas cap (EVM_BUY_GAS_MAX = G(32)) is not visible from outside: its proof is apps/helper/src/pool/
// evm-buy-gas-depth.test.ts.
// After: helper
//   node scripts/live-checks/evm-buy-gas-depth.mjs [--base <helper url>] [--record <file> --as good|bad] [--local]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3
// --local answers the fee from this tree's helper code in process (evmPoolSendersFromEnv with a throwaway sender key
// made at run time, which holds nothing and sends nothing) over the same providers: how the good answer was recorded
// before the deploy. --record writes the run under `--as` in the file (evm-buy-gas-depth.answers.json), replayed by
// evm-buy-gas-depth.test.mjs.
import "../net-window.mjs";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { evmPoolGas, evmPoolVenues } from "../../packages/kit/src/index.ts";
import { evmPools } from "../ci/helper-live-checks.mjs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";
import { epochOf, evmPoolFeeAsk, feeUrl, noBlockYet, POOL_EPOCH_MS, POOL_LIFE_MAX_MS } from "./evm-pool-fee-epoch.mjs";

export const BASE = "https://ct-api.unrealized.trade";
/** currentTreeDepth() (State.sol), as evm-buy-hookdata-fee.mjs reads it */
const TREE_DEPTH = "0x4a2b75c8";
const HEX = /^0x[0-9a-f]+$/;
const DEC = /^[0-9]{1,40}$/;

/** The providers a pool's block is read on: the network's fee providers, then its other quote providers */
export const providersOf = (network) => {
  const v = evmPoolVenues()[network];
  return [...new Set([...(v?.feeProviders ?? []), ...(v?.providers ?? [])])];
};

/** A proof's oldest epoch the helper still prices is POOL_LIFE_MAX_MS back on its clock: the check keeps this much
 *  clear of that edge, so a clock a few seconds apart never turns an old epoch into a 404. */
const LIFE_EDGE_MS = 5_000;

/** The chain's head on the network's providers, in order, until two answer: [{ host, number, timestamp } | { host,
 *  noAnswer }]. */
async function headsOf(network, fetchFn) {
  const heads = [];
  for (const url of providersOf(network)) {
    if (heads.filter((h) => h.noAnswer === undefined).length === 2) break;
    const host = new URL(url).host;
    const b = await rpcAnswer(url, "eth_getBlockByNumber", ["latest", false], { fetchFn, nullNoAnswer: true });
    if (b.noAnswer !== undefined) heads.push({ host, noAnswer: b.noAnswer });
    else if (b.error !== undefined || typeof b.result?.number !== "string" || !HEX.test(b.result.number) || typeof b.result?.timestamp !== "string" || !HEX.test(b.result.timestamp)) heads.push({ host, noAnswer: `${host}: no answer (not a block: ${JSON.stringify(b.error ?? b.result).slice(0, 120)})` });
    else heads.push({ host, number: b.result.number, timestamp: b.result.timestamp });
  }
  return heads;
}

/** The epoch to judge from the heads and the time now, ms: { epochMs } or { inconclusive: why }. */
export function epochToJudge(heads, nowMs) {
  const got = (Array.isArray(heads) ? heads : []).filter((h) => h?.noAnswer === undefined && typeof h?.timestamp === "string" && HEX.test(h.timestamp));
  if (got.length < 2) return { inconclusive: `${got.length} of ${Array.isArray(heads) ? heads.length : 0} providers answered the chain's head` };
  const [a, b] = got.map((h) => Number(BigInt(h.timestamp)) * 1000);
  if (Math.abs(a - b) > POOL_EPOCH_MS) return { inconclusive: `the providers' heads are ${Math.abs(a - b) / 1000} s apart (${got.map((h) => `${h.host} block ${BigInt(h.number)} at ${new Date(Number(BigInt(h.timestamp)) * 1000).toISOString()}`).join(", ")})` };
  const epochMs = epochOf(Math.min(a, b, nowMs));
  // the epoch before it, asked when the helper has no block in it yet, must still be inside a proof's life
  if (epochMs - POOL_EPOCH_MS < nowMs - POOL_LIFE_MAX_MS + LIFE_EDGE_MS) return { inconclusive: `no epoch within a proof's life has a block: the newest both providers hold is from ${new Date(Math.min(a, b)).toISOString()}` };
  return { epochMs };
}

/** One run: per pool, the chain's head on two providers, the epoch judged, the fee answer for it (and the first answer
 *  when the epoch before was asked) and the reads of its block on each provider. `feeOf(network, pool, epochMs)` gives
 *  the helper's answer as { status, body }. A read is { host, noAnswer } or { host, hash, baseFeePerGas, depth } with
 *  any JSON-RPC error kept as `error`, judged. */
export async function collect(feeOf, fetchFn = fetch, pools = evmPools(), now = Date.now) {
  const runs = [];
  for (const [network, pool] of Object.entries(pools)) {
    if (pool === null) continue;
    const heads = await headsOf(network, fetchFn);
    const nowMs = now();
    const e = epochToJudge(heads, nowMs);
    if (e.inconclusive !== undefined) {
      runs.push({ network, pool, heads, nowMs, inconclusive: e.inconclusive, fee: null, reads: [] });
      continue;
    }
    // the shared rule for which epoch is asked; feeOf makes its own request, so only the epoch is read from the URL
    const asked = await evmPoolFeeAsk((url) => feeOf(network, pool, Number(new URL(url).searchParams.get("epoch"))), "http://helper.invalid", pool, { epochMs: e.epochMs, nowMs });
    const fee = asked.answer;
    const reads = [];
    const block = fee?.body?.block;
    if (fee?.status === 200 && typeof block === "string" && HEX.test(block)) {
      for (const url of providersOf(network)) {
        const host = new URL(url).host;
        const b = await rpcAnswer(url, "eth_getBlockByNumber", [block, false], { fetchFn, nullNoAnswer: true });
        if (b.noAnswer !== undefined) {
          reads.push({ host, noAnswer: b.noAnswer, ...(b.nullResult ? { noBlock: true } : {}) });
          continue;
        }
        if (b.error !== undefined) {
          reads.push({ host, hash: null, baseFeePerGas: null, depth: null, error: b.error });
          continue;
        }
        const hash = b.result?.hash;
        const d = typeof hash === "string" ? await rpcAnswer(url, "eth_call", [{ to: pool, data: TREE_DEPTH }, { blockHash: hash }], { fetchFn }) : { result: null };
        if (d.noAnswer !== undefined) {
          reads.push({ host, noAnswer: d.noAnswer });
          continue;
        }
        reads.push({ host, hash: hash ?? null, baseFeePerGas: b.result?.baseFeePerGas ?? null, depth: d.result ?? null, ...(d.error !== undefined ? { error: d.error } : {}) });
      }
    }
    runs.push({ network, pool, heads, nowMs, epochMs: asked.epochMs, ...(asked.first === null ? {} : { first: { epochMs: e.epochMs, answer: asked.first } }), fee, reads });
  }
  return runs;
}

/** PASS lines, BAD lines and no-answer lines for one run, and its verdict: FAIL on any wrong answer, INCONCLUSIVE where a
 *  pool had fewer than two providers answering, PASS when there is a pool and every pool passes. */
export function judge(runs) {
  const lines = [];
  let quiet = false;
  const say = (ok, line) => lines.push(`${ok ? "PASS" : "BAD"} ${line}`);
  if (!Array.isArray(runs) || runs.length === 0) say(false, "no EVM pool to check");
  for (const r of Array.isArray(runs) ? runs : []) {
    const n = `${r?.network} ${r?.pool}`;
    // card evm-fee-quiet-epoch: a provider that did not answer the head is named as any other no-answer; a run that
    // could not name an epoch with a block is judged on nothing, so it is INCONCLUSIVE, never a pass
    for (const h of Array.isArray(r?.heads) ? r.heads.filter((x) => x?.noAnswer !== undefined) : []) lines.push(`--- ${n} ${h.host}: no answer: ${h.noAnswer}`);
    if (r?.heads !== undefined) {
      const e = epochToJudge(r.heads, r.nowMs);
      if (e.inconclusive !== undefined || r.inconclusive !== undefined || e.epochMs !== (r.first?.epochMs ?? r.epochMs)) {
        quiet = true;
        lines.push(`INCONCLUSIVE ${n}: ${e.inconclusive ?? r.inconclusive ?? `the run judged epoch ${r.first?.epochMs ?? r.epochMs}, the heads name ${e.epochMs}`}`);
        continue;
      }
      if (r.first !== undefined) lines.push(`--- ${n}: the helper answered ${r.first.answer?.status} ${JSON.stringify(r.first.answer?.body?.error ?? r.first.answer?.body ?? null).slice(0, 80)} for epoch ${new Date(r.first.epochMs).toISOString()}, which the providers hold a block in; judged the epoch before`);
    }
    const b = r?.fee?.body;
    if (r?.fee?.status !== 200 || b?.network !== r.network || b?.pool !== r.pool || typeof b?.fee !== "string" || !DEC.test(b.fee) || typeof b?.block !== "string" || !HEX.test(b.block) || (r.epochMs !== undefined && b?.epoch_start_ms !== r.epochMs)) {
      // the epoch before the one the heads name is a minute behind both providers: no block there is the helper's fault
      say(false, `${n}: the fee answer${r.epochMs === undefined ? "" : ` for epoch ${new Date(r.epochMs).toISOString()}`} ${JSON.stringify(r?.fee).slice(0, 300)}${noBlockYet(r?.fee) ? " (the helper holds no block in an epoch both providers are past)" : ""}`);
      continue;
    }
    const all = Array.isArray(r.reads) ? r.reads : [];
    // a provider's no-answer is named and left out; the pool is judged on the providers that answered
    const reads = all.filter((x) => x?.noAnswer === undefined);
    for (const x of all.filter((y) => y?.noAnswer !== undefined)) lines.push(`--- ${n} ${x.host}: no answer: ${x.noAnswer}`);
    // the helper named a block that every provider that answered says it does not hold, two or more of them: the
    // helper's answer is wrong, and no read again clears it (review of 6cfd2778, P2-1); one null beside no-answers is
    // one provider lagging at an epoch's turn, INCONCLUSIVE (delta review of 323af592, P3-a)
    if (reads.length === 0 && all.filter((x) => x?.noBlock === true).length >= 2) {
      say(false, `${n}: no provider holds block ${b.block} (${all.filter((x) => x?.noBlock === true).map((x) => x.host).join(", ")} answered none)`);
      continue;
    }
    const word = (x) => (typeof x === "string" && /^0x[0-9a-f]{64}$/.test(x) ? BigInt(x) : null);
    const one = all.length >= 2 && reads.every((x) => x.error === undefined && typeof x.hash === "string" && x.hash === reads[0].hash && typeof x.baseFeePerGas === "string" && HEX.test(x.baseFeePerGas) && x.baseFeePerGas === reads[0].baseFeePerGas && word(x.depth) !== null && x.depth === reads[0].depth);
    if (!one) {
      say(false, `${n}: block ${b.block} is not one block, base fee and tree depth on every provider that answered: ${JSON.stringify(reads).slice(0, 400)}`);
      continue;
    }
    if (reads.length < 2) {
      quiet = true;
      lines.push(`INCONCLUSIVE ${n}: ${reads.length} of ${all.length} providers answered`);
      continue;
    }
    const depth = word(reads[0].depth);
    if (depth > 32n) {
      say(false, `${n}: tree depth ${depth} past the pool's 32`);
      continue;
    }
    const base = BigInt(reads[0].baseFeePerGas);
    const fee = BigInt(b.fee);
    const g = evmPoolGas(Number(depth));
    const need = 2n * base * g;
    say(fee >= need, `${n}: block ${BigInt(b.block)} (${reads.map((x) => x.host).join(", ")}), base fee ${base} wei, tree depth ${depth}: fee ${fee} wei ${fee >= need ? ">=" : "<"} 2 x ${base} x G(${depth}) ${g} = ${need}`);
  }
  const bad = lines.length === 0 || lines.some((l) => l.startsWith("BAD"));
  const verdict = verdictOf(bad, quiet);
  return { verdict, ok: verdict === "PASS", lines };
}

const httpFee = (base, fetchFn) => async (_network, pool, epochMs) => {
  const r = await fetchFn(feeUrl(base, pool, epochMs), { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  let body = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, body };
};

/** This tree's helper code, in process, with a throwaway sender key: the answer GET /v1/pool/fee gives (server.ts). */
async function localFee() {
  const { evmPoolSendersFromEnv } = await import("../../apps/helper/src/pool/evm.ts");
  return async (network, pool, epochMs) => {
    const NAME = network.toUpperCase().replace(/-/g, "_");
    const senders = evmPoolSendersFromEnv({ [`POOL_EVM_ADDRESS_${NAME}`]: pool, [`POOL_EVM_SENDER_KEY_${NAME}`]: `0x${randomBytes(32).toString("hex")}` });
    const s = senders.get(pool);
    const body = await s.fee(epochMs ?? Date.now());
    // as server.ts answers it: no block in the epoch yet is 503 index_behind
    return body === null ? { status: 503, body: { error: { code: "index_behind" } } } : { status: 200, body };
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  try {
    const feeOf = args.includes("--local") ? await localFee() : httpFee(opt("--base") ?? BASE, fetch);
    // --pool <network>=<address>: that one pool instead of the deploy records' (how the not-carried answer was recorded)
    const one = opt("--pool")?.split("=");
    const runs = await collect(feeOf, fetch, one === undefined ? evmPools() : { [one[0]]: one[1]?.toLowerCase() ?? null });
    const r = judge(runs);
    for (const l of r.lines) console.log(l);
    const file = opt("--record");
    if (file !== undefined) {
      const as = opt("--as");
      if (as !== "good" && as !== "bad") throw new Error("--record takes --as good or --as bad");
      const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      all[as] = { at: new Date().toISOString(), from: args.includes("--local") ? "local" : opt("--base") ?? BASE, runs };
      writeFileSync(file, `${JSON.stringify(all, null, 1)}\n`);
    }
    console.log(`${r.verdict} evm-buy-gas-depth`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`evm-buy-gas-depth: ${e?.message ?? e}`);
    process.exit(2);
  }
}
