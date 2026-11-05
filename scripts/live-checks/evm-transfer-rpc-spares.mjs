#!/usr/bin/env node
// Live check of card evm-transfer-rpc-spares: every EVM read pair the device names a provider to directly is a pinned
// list read as a pair with spares (the wallet's evmPair), and with any one provider of it out for hours the read still
// runs on two others, the out one asked at most once and never waited on. Two kinds of list:
//   - the pool lists (the kit's evmPoolVenues providers, which evmPool and evmTreeSync read): on every network the
//     newest 2,000 blocks read in the pool's shape (the two anchors, the chain id and the anchor's hash on both, a log
//     read with an address and the pool's three topics), alike on both;
//   - the testnets' Transfer lists (the wallet's EVM_TRANSFER_RPCS; Base's and Robinhood's Ws are read on the helper's
//     route, decision M359, which ./wallet-restore-transfer-rpcs.mjs reads): a W's Transfer read over the same blocks.
// Each list is read once with every provider live, then once per provider but thirdweb's with a stand-in between the
// device and that provider that answers each of its calls as the device's client ends thirdweb's keyless daily quota
// (HTTP 429, Retry-After 26,741,000 ms, one try, read 5 Nov 16:28Z and 17:29Z); every other call reaches the provider.
// thirdweb is never taken out: it is the last spare, out for the day on every chain at once when its quota is spent.
// Skipped, not passed, one line each: a provider out on a list of two (the testnets' pool lists: the kit pins two, and
// no third keyless operator answers there), and a provider out on a testnet's Transfer list while thirdweb, its only
// third keyless operator, is out too (its quota spent at the run); the .md beside this file says the same.
// The wallet's own read runs (packages/wallet/scripts/transfer-rpcs-check.ts through ./wallet-restore-transfer-rpcs.mjs),
// so no check here is a second implementation of the wallet's.
// It passes when every live read and every case not skipped reads alike on two providers of two operators, never the
// out one, which is asked at most once; it fails if any is refused.
//   node scripts/live-checks/evm-transfer-rpc-spares.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every provider answer read, as the good run of evm-transfer-rpc-spares.answers.json, and its bad
// run: the same answers with every answer of Base's pool list but its first provider's a quota 429 too (one left, no
// pair).
// Runs: once, it reads no host: the wallet at the checkout against public RPCs; the wallet tests hold the swap rule
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { W, check, recorder, replayer } from "./wallet-restore-transfer-rpcs.mjs";

const KEY = "evm-transfer-rpc-spares";
export const BACK = "2000";
const TRANSFER_LISTS = Object.freeze({
  "base-sepolia": ["https://base-sepolia.gateway.tenderly.co", "https://base-testnet.api.pocket.network", "https://84532.rpc.thirdweb.com"],
  "robinhood-testnet": ["https://robinhood-testnet.drpc.org", "https://rpc.testnet.chain.robinhood.com", "https://46630.rpc.thirdweb.com"],
});
/** The lists read: each network's pool list from the kit, each testnet's Transfer list (the wallet's, which the
 * wallet's report names; the copy here only labels the run and is checked against that report). */
export const LISTS = Object.freeze([
  ...["base", "robinhood", "base-sepolia", "robinhood-testnet"].map((network) => ({ label: `${network} pool`, network, pool: evmPoolVenues()[network].providers })),
  ...Object.entries(TRANSFER_LISTS).map(([network, urls]) => ({ label: `${network} transfer`, network, urls })),
]);
/** thirdweb's keyless daily quota as the device's client ends it (5 Nov 16:28Z and 17:29Z). */
export const QUOTA = Object.freeze({ error: "HTTP 429 (http_429, 1 try at a provider out for the day)", name: "SolanaRpcTransportError", afterMs: 26_741_000 });
const host = (u) => new URL(u).host;
const operator = (u) => new URL(u).hostname.split(".").slice(-2).join(".");
const THIRDWEB = (u) => operator(u) === "thirdweb.com";

/** The check: { ok, lines }. `transport(network, url, method, params)` reaches the providers (live, or a replay). */
export async function spares(transport, { wait = true } = {}) {
  const lines = [];
  let ok = true;
  for (const l of LISTS) {
    const job = { network: l.network, w: W, back: BACK, ...(l.pool ? { pool: l.pool } : {}) };
    const all = await check(transport, { wait, jobs: [job] });
    const rep0 = all.reports[0];
    if (rep0 === null) {
      ok = false;
      lines.push(`${l.label}, every provider live: ${all.lines[0]}`);
      continue;
    }
    const list = rep0.list;
    if (l.urls && JSON.stringify(list) !== JSON.stringify(l.urls)) {
      ok = false;
      lines.push(`${l.label}: the wallet's list is ${list.map(host).join(", ")}, not ${l.urls.map(host).join(", ")}`);
      continue;
    }
    if (new Set(list.map(operator)).size !== list.length) (ok = false), lines.push(`${l.label}: the list ${list.map(host).join(", ")} repeats an operator`);
    lines.push(`${l.label}, every provider live: ${rep0.urls.map(host).join(" and ")} read alike from block ${rep0.from} to ${rep0.anchor.number}`);
    for (const out of list.filter((u) => !THIRDWEB(u))) {
      if (list.length < 3) {
        lines.push(`${l.label}, ${host(out)} out: skipped: the list is two providers and ${l.network} has no third keyless operator`);
        continue;
      }
      let asked = 0, thirdwebOut = false;
      const t = async (net, url, method, params) => {
        if (url === out) return (asked++, { ...QUOTA });
        const a = await transport(net, url, method, params);
        if (THIRDWEB(url) && "error" in a && /\b429\b/.test(a.error)) thirdwebOut = true;
        return a;
      };
      const r = await check(t, { wait, jobs: [job] });
      const rep = r.reports[0];
      const seated = rep?.urls ?? [];
      const good = r.ok && seated.length === 2 && !seated.includes(out) && operator(seated[0]) !== operator(seated[1]) && asked <= 1;
      if (!good && l.urls && thirdwebOut) {
        lines.push(`${l.label}, ${host(out)} out: skipped: thirdweb, ${l.network}'s only third keyless operator, is out too (HTTP 429)`);
        continue;
      }
      if (!good) ok = false;
      lines.push(`${l.label}, ${host(out)} out: ${r.ok ? `${seated.map(host).join(" and ")} read alike from block ${rep.from} to ${rep.anchor.number}, the out one asked ${asked} ${asked === 1 ? "time" : "times"}` : r.lines[0]}`);
    }
  }
  return { ok, lines };
}

/** The bad run kept beside a good one: every answer of Base's pool list but its first provider's a quota 429 too. */
export const SPOILED = Object.freeze(LISTS[0].pool.slice(1));
export function spoil(log) {
  return log.map((e) => (SPOILED.includes(e.url) ? { network: e.network, url: e.url, method: e.method, params: e.params, ...QUOTA } : e));
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
