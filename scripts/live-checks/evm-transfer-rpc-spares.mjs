#!/usr/bin/env node
// Live check of card evm-transfer-rpc-spares: on Base and Robinhood the restore's Transfer list (the wallet's
// EVM_TRANSFER_RPCS) is three operators or more, and with any one of them out for hours the W read still runs on two
// others, the out one asked once and never waited on. Base Sepolia and Robinhood testnet are not in it: their lists
// hold three operators, but no fourth keyless one answers a W's read from the browser (read 5 Nov 17:29-17:49Z, the
// list's doc comment), and thirdweb's, the third, was out for the day there then, so a second one out leaves one; the
// restore's check (./wallet-restore-transfer-rpcs.mjs) reads them on every deploy. On 5 Nov about 17:1xZ thirdweb's keyless daily quota answered
// HTTP 429 with Retry-After about 26,741,000 ms (7.4 h) on Base and Robinhood testnet, and a pair with no spare left
// the restore's Ws unread there. This check runs the wallet's own W read (packages/wallet/scripts/transfer-rpcs-check.ts
// through ./wallet-restore-transfer-rpcs.mjs, so no check here is a second implementation of the wallet's) on the
// newest 2,000 blocks of each network: once with every provider live (one already out, as thirdweb's quota was on
// 5 Nov, is swapped then too), then once per provider with a stand-in between
// the device and that provider that answers each of its calls as the device's client ends thirdweb's quota (HTTP 429,
// Retry-After 26,741,000 ms, one try); every other call reaches the provider.
// It passes when every list holds three operators or more and every run reads W alike on two providers of two
// operators, never the out one, which is asked at most once; it fails if any run is refused.
//   node scripts/live-checks/evm-transfer-rpc-spares.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every provider answer read, as the good run of evm-transfer-rpc-spares.answers.json, and its bad
// run: the same answers with every answer of Base's dRPC a quota 429 too (with thirdweb's quota out, as it was then,
// and one more out: one left, no pair).
// Runs: once, it reads no host: the wallet at the checkout against public RPCs; the wallet tests hold the swap rule
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { W, check, recorder, replayer } from "./wallet-restore-transfer-rpcs.mjs";

const KEY = "evm-transfer-rpc-spares";
export const NETWORKS = Object.freeze(["base", "robinhood"]);
export const BACK = "2000";
/** thirdweb's keyless daily quota as the device's client ends it (5 Nov 16:28Z and 17:29Z). */
export const QUOTA = Object.freeze({ error: "HTTP 429 (http_429, 1 try at a provider out for the day)", name: "SolanaRpcTransportError", afterMs: 26_741_000 });
const host = (u) => new URL(u).host;
const operator = (u) => new URL(u).hostname.split(".").slice(-2).join(".");

/** The check: { ok, lines }. `transport(network, url, method, params)` reaches the providers (live, or a replay). */
export async function spares(transport, { wait = true } = {}) {
  const lines = [];
  let ok = true;
  const job = (network) => ({ network, w: W, back: BACK });
  // every provider live: each network's list, from the wallet's own report
  const base = await check(transport, { wait, jobs: NETWORKS.map(job) });
  const lists = new Map();
  NETWORKS.forEach((n, i) => {
    const r = base.reports[i];
    if (r === null) return (ok = false), lines.push(base.lines[i]);
    lists.set(n, r.list);
    const ops = new Set(r.list.map(operator));
    if (ops.size < 3 || ops.size !== r.list.length) (ok = false), lines.push(`${n}: the list ${r.list.map(host).join(", ")} is not three operators or more`);
  });
  for (const [network, list] of lists) {
    for (const out of list) {
      let asked = 0;
      const t = (net, url, method, params) => (url === out ? (asked++, Promise.resolve({ ...QUOTA })) : transport(net, url, method, params));
      const r = await check(t, { wait, jobs: [job(network)] });
      const rep = r.reports[0];
      const seated = rep?.urls ?? [];
      const good = r.ok && seated.length === 2 && !seated.includes(out) && operator(seated[0]) !== operator(seated[1]) && asked <= 1;
      if (!good) ok = false;
      lines.push(`${network}, ${host(out)} out: ${r.ok ? `${seated.map(host).join(" and ")} read W alike from block ${rep.from} to ${rep.anchor.number}, the out one asked ${asked} ${asked === 1 ? "time" : "times"}` : r.lines[0]}`);
    }
  }
  return { ok, lines };
}

/** The bad run kept beside a good one: every answer of Base's dRPC a quota 429 too. */
export const SPOILED = "https://base.drpc.org";
export function spoil(log) {
  return log.map((e) => (e.url === SPOILED ? { network: e.network, url: e.url, method: e.method, params: e.params, ...QUOTA } : e));
}

async function main(argv) {
  const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const record = at("--record");
  const rec = recorder();
  const r = await spares(rec.transport);
  for (const l of r.lines) console.log(`${r.ok ? "PASS" : "FAIL"} ${l}`);
  if (record) {
    writeFileSync(record, `${JSON.stringify({ key: KEY, recorded: new Date().toISOString(), good: rec.log, bad: spoil(rec.log) }, null, 1)}\n`);
    console.log(`recorded ${record}`);
  }
  console.log(r.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`error: ${e?.stack ?? e}`), process.exit(2)));
