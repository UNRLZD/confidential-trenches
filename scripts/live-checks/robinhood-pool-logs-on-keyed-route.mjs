#!/usr/bin/env node
// Live check of card robinhood-pool-logs-on-keyed-route: the deployed helper's keyed Robinhood route (POST
// /v1/rpc/robinhood?keyed=only, apps/helper/src/rpc/rpc.ts: the keyed URLs alone, never a public one) answers the
// mainnet pool's eth_getLogs over wide spans with the same logs as Robinhood's own RPC, so a cold restore pages the
// pool's history on two companies in a few calls instead of Pocket's 10,001-block pages. Live 13 Nov 16:1xZ the route
// answered {"error":{"code":"upstream"}} to every span past 101 blocks: its keyed providers are free plans, QuickNode's
// trial at 5 blocks (quicknode.com/docs/ethereum/eth_getLogs) and dRPC's free plan at 101 on Robinhood (HTTP 400, code
// 35, "ranges over 10000 blocks are not supported on free plan", which the route takes for that URL down). Alchemy's
// Pay As You Go serves Robinhood Mainnet's eth_getLogs over an "unlimited" range (alchemy.com/docs/reference/eth-getlogs,
// read 13 Nov 16:1xZ): its key as ROBINHOOD_RPC_URL, the route's first keyed name (research
// scripts/deploy/robinhood-alchemy-key.sh). It moves no money: it reads public logs. It passes only when, for each of two
// spans (the newest RECENT blocks, then the pool's whole history from its deploy block, packages/wallet/src/pool/
// evm.ts's mainnet pin), both up to one head block read on Robinhood's own RPC:
//   - the route answers a JSON-RPC result list, not an error (the helper's 503 {"error":{"code":"upstream"}} is one);
//   - Robinhood's own RPC answers the same request with a result list, and the two lists are the same logs (each log's
//     JSON, keys sorted);
//   - the route's Server-Timing names the keyed name that answered (rpc;desc="<NAME>"), never "none".
// Every read goes through provider-answer.mjs's rpcAnswer, the route's with no Origin (the helper answers it so, read 13
// Nov 16:3xZ): with the page's Origin a 5xx is a passing fault, so the route's upstream would never be judged. A no-answer
// (a 429, a failed fetch, a body that is no JSON-RPC answer) after its one retry is INCONCLUSIVE, never PASS.
// After: helper
//   node scripts/live-checks/robinhood-pool-logs-on-keyed-route.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read, so the check's test
//   can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EXIT, rpcAnswer } from "./provider-answer.mjs";

const KEY = "robinhood-pool-logs-on-keyed-route";
export const BASE = "https://ct-api.unrealized.trade";
export const OWN = "https://rpc.mainnet.chain.robinhood.com";
/** The mainnet pool and its deploy block (packages/wallet/src/pool/evm.ts, deploy tx 0xb5b5c6c0…88176). */
export const POOL = "0x9306359433127c4f3be426f6faeb00a3c41f66db";
export const FROM = 108_420_674;
export const RECENT = 100_000;
const TIMEOUT_MS = 30_000;

const hex = (n) => `0x${n.toString(16)}`;
/** One run: the head on Robinhood's own RPC, then each span on the route and on Robinhood's own. */
export async function read(base = BASE, fetchFn = fetch) {
  const route = `${base.replace(/\/$/, "")}/v1/rpc/robinhood?keyed=only`;
  const head = await rpcAnswer(OWN, "eth_blockNumber", [], { fetchFn });
  const h = typeof head.result === "string" && /^0x[0-9a-f]{1,16}$/i.test(head.result) ? Number.parseInt(head.result, 16) : NaN;
  if (!Number.isSafeInteger(h) || h <= FROM) throw new Error(`Robinhood's own RPC named no head past the pool's deploy block (${JSON.stringify(head).slice(0, 160)})`);
  const spans = [];
  for (const [name, from] of [[`newest ${RECENT}`, h - RECENT + 1], ["whole history", FROM]]) {
    const params = [{ address: POOL, fromBlock: hex(from), toBlock: hex(h) }];
    spans.push({ name, from, to: h, route: await rpcAnswer(route, "eth_getLogs", params, { fetchFn, timeoutMs: TIMEOUT_MS, keep: ["server-timing"] }), own: await rpcAnswer(OWN, "eth_getLogs", params, { fetchFn, timeoutMs: TIMEOUT_MS }) });
  }
  return { base, head: h, spans };
}

const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const said = (a) => (a?.noAnswer !== undefined ? `no answer (${a.noAnswer})` : a?.error !== undefined ? `error ${JSON.stringify(a.error).slice(0, 120)}` : Array.isArray(a?.result) ? `${a.result.length} log(s)` : `no log list (${JSON.stringify(a?.result).slice(0, 60)})`);

/** The check on one recorded run: PASS, FAIL, or INCONCLUSIVE when a side gave no answer and nothing else failed. */
export function judge({ spans }) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok === true ? "ok " : ok === null ? "N/A" : "BAD"} ${text}`);
  const list = Array.isArray(spans) ? spans : [];
  say(list.length === 2, `${list.length} of 2 spans read`);
  for (const s of list) {
    const blocks = s.to - s.from + 1;
    const r = s.route;
    const o = s.own;
    const rOk = Array.isArray(r?.result);
    say(rOk || (r?.noAnswer !== undefined ? null : false), `${s.name} (${blocks} blocks): the keyed route answers ${said(r)}`);
    const oOk = Array.isArray(o?.result);
    say(oOk || (o?.noAnswer !== undefined ? null : false), `${s.name}: Robinhood's own RPC answers ${said(o)}`);
    if (rOk && oOk) say(JSON.stringify(sorted(r.result)) === JSON.stringify(sorted(o.result)), `${s.name}: the same logs on both`);
    if (rOk) {
      const desc = /\brpc;dur=\d+;desc="([A-Z0-9_]+)"/.exec(r.kept?.["server-timing"] ?? "")?.[1];
      say(desc !== undefined && desc !== "none", `${s.name}: answered by ${desc ?? "no keyed name"} (Server-Timing)`);
    }
  }
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : lines.some((l) => l.startsWith("N/A")) ? "INCONCLUSIVE" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const answer = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { verdict, lines } = judge(answer);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict} (${answer.base})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
}
