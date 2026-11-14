#!/usr/bin/env node
// Live check of card helper-pool-logs-outside-the-caller-budget: HELPER_HOST's keyed-only Robinhood route (POST
// /v1/rpc/robinhood?keyed=only, the signing page's second seat for the pool's history) answers a finalized eth_getLogs
// page asked a second time from its cache (apps/helper/src/rpc/rpc.ts LOG_CACHE_ENTRIES), so a sign-in's walk of the
// pool's history draws nothing of the caller's share on a page asked before. With Origin SIGN_HOST it reads the chain's
// finalized head on the route, then asks two pages of the mainnet Robinhood pool's logs (its address, from the pool's
// deploy block: 100,000 then 200,000 blocks, the page's first two pages, packages/wallet/src/pool/evm.ts
// EVM_POOL_LOG_PAGE_BLOCKS), each twice in a row, and passes only when:
//   - the head read is a block number and both pages end below it (finalized);
//   - every answer is 200 with a JSON-RPC result list, never a 429 (read through provider-answer.mjs rpcAnswer, which
//     reads a 429 again once a second later: a 429 left after that is a FAIL here, since the helper is the subject);
//   - each page's second answer names the cache's hit in Server-Timing (rpc-cache;desc="hit") and holds the same logs
//     as its first;
//   - each answer carries a full-sha X-Helper-Commit and echoes SIGN_HOST in Access-Control-Allow-Origin.
// After: helper
//   node scripts/live-checks/helper-pool-logs-outside-the-caller-budget.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { rpcAnswer } from "./provider-answer.mjs";

const KEY = "helper-pool-logs-outside-the-caller-budget";
export const BASE = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
const SHA = /^[0-9a-f]{40}$/;
const BLOCK = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const HIT = 'rpc-cache;desc="hit"';
/** The mainnet Robinhood pool and its deploy block (packages/wallet/src/pool/evm.ts EVM_POOLS robinhood). */
export const POOL = "0x9306359433127c4f3be426f6faeb00a3c41f66db";
export const FROM = 108_420_674;
const hex = (n) => `0x${n.toString(16)}`;
/** The two pages: the pool sync's first two on a provider (100,000 blocks, then 200,000). */
export const PAGES = [
  [hex(FROM), hex(FROM + 99_999)],
  [hex(FROM + 100_000), hex(FROM + 299_999)],
];

/** The check on one recorded run: { head, reads: [{ page, ask, status, acao, kept, result | error | noAnswer }] }, each read
 *  as scripts/live-checks/provider-answer.mjs rpcAnswer gives it (a 429 is read again once, after RETRY.ms). */
export function judge({ head, reads }) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const num = head?.result?.number;
  const n = typeof num === "string" && BLOCK.test(num) ? BigInt(num) : null;
  say(n !== null, `[head] the route's finalized head: ${n ?? head?.noAnswer ?? JSON.stringify(head?.error ?? null)}`);
  for (const [p, [, to]] of PAGES.entries()) {
    say(n !== null && BigInt(to) <= n, `[page ${p}] ends at ${BigInt(to)}, at or below the finalized head`);
    const asks = [0, 1].map((ask) => reads?.find((r) => r.page === p && r.ask === ask));
    for (const [ask, r] of asks.entries()) {
      const tag = `[page ${p} ask ${ask}]`;
      if (r === undefined) {
        say(false, `${tag} no read`);
        continue;
      }
      say(r.status === 200 && Array.isArray(r.result), `${tag} answered: ${r.status} ${r.noAnswer ?? (r.error !== undefined ? JSON.stringify(r.error) : `${r.result?.length} logs`)}`);
      say(SHA.test(r.kept?.["x-helper-commit"] ?? ""), `${tag} X-Helper-Commit: ${r.kept?.["x-helper-commit"] ?? "none"}`);
      say(r.acao === SIGN, `${tag} allow-origin: ${r.acao ?? "none"}`);
      if (ask === 1) say((r.kept?.["server-timing"] ?? "").includes(HIT), `${tag} the cache's hit in Server-Timing: ${r.kept?.["server-timing"] ?? "none"}`);
    }
    const [a, b] = asks.map((r) => r?.result);
    if (Array.isArray(a) && Array.isArray(b)) say(JSON.stringify(a) === JSON.stringify(b), `[page ${p}] the same logs both asks: ${a.length} and ${b.length}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

/** A read as recorded: a result list cut to each log's block, index and transaction (the check reads only its length and
 *  the two asks' sameness); a head cut to its number. */
const cut = (a) => (Array.isArray(a.result) ? { ...a, result: a.result.map((l) => ({ blockNumber: l?.blockNumber, logIndex: l?.logIndex, transactionHash: l?.transactionHash })) } : a.result && typeof a.result === "object" ? { ...a, result: { number: a.result.number } } : a);

export async function read(base = BASE, fetchFn = fetch) {
  const url = `${base.replace(/\/$/, "")}/v1/rpc/robinhood?keyed=only`;
  const opts = { fetchFn, headers: { origin: SIGN }, redirect: "manual", keep: ["x-helper-commit", "server-timing", "retry-after"] };
  const timed = async (method, params) => {
    const t0 = performance.now();
    const a = await rpcAnswer(url, method, params, opts);
    return { ...cut(a), ms: Math.round(performance.now() - t0) };
  };
  const head = await timed("eth_getBlockByNumber", ["finalized", false]);
  const reads = [];
  for (const [page, [fromBlock, toBlock]] of PAGES.entries())
    for (const ask of [0, 1]) reads.push({ page, ask, ...(await timed("eth_getLogs", [{ address: POOL, fromBlock, toBlock }])) });
  return { base, at: new Date().toISOString(), head, reads };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`times (ms): head ${run.head.ms}, ${run.reads.map((r) => `page ${r.page} ask ${r.ask} ${r.ms}`).join(", ")}`);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
