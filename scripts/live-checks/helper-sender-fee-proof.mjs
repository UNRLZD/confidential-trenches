#!/usr/bin/env node
// Live check of card helper-sender-fee-proof: HELPER_HOST counts a landed sale as paid only by the Paid log of the
// network's real FeeCollector (apps/helper/src/pool/evm.ts evmSaleUnpaid), so it must run with the collector the kit pins
// and the sell sender that collector pays (review M1: with any other collector address every sale would read as paid,
// the sell sender would pay every sale's gas, and no cap would ever engage). Nothing is sent and no key is read. For each
// EVM testnet pool its deploy record names (helper-evm-sender.mjs evmPoolRecords) it reads GET /v1/pool/fee?pool=<pool>
// and passes only when:
//   - the fee answer is 200 and its fee_collector is the kit's pin for the network (evmPoolVenues() feeCollector),
//     which is the FeeCollector card evm-fee-collector deployed (evm-fee-collector.<network>.json);
//   - its sell_sender is the kit's sell sender pin (evmPoolVenues() sellSender) and the collector's sink, the one
//     address the collector pays out to (the record's sink, held in its code's one immutable);
//   - its X-Helper-Commit is the commit this check runs at: live.yml checks out the commit redeploy.sh was given and
//     tests that it is HEAD, and this file exists only from this card's merge on, so the helper runs a commit that has
//     the merge as an ancestor;
// and, for each network's collector, on its chain's two RPCs of two operators, evm-fee-collector.mjs check() holds: its
// code is the FeeCollector build pinned to its address with the sink in its one immutable, the sink is the kit's sell
// sender pin, it has no admin and no owner, and its deploy transaction made it.
// After: helper
//   node scripts/live-checks/helper-sender-fee-proof.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (the helper has no block in the epoch or the one before: the
//   fee is read through evm-pool-fee-epoch.mjs). --record writes the fee answers and every RPC answer read, the shape
//   helper-sender-fee-proof.test.mjs replays.
import "../net-window.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { check as collectorCheck, recordFile } from "./evm-fee-collector.mjs";
import { evmPoolFeeAsk, noBlockYet } from "./evm-pool-fee-epoch.mjs";
import { BASE, evmPoolRecords, NETWORKS } from "./helper-evm-sender.mjs";
import { recorder } from "./pool-evm-deploy.mjs";
import { EXIT, verdictOf } from "./provider-answer.mjs";

export const KEY = "helper-sender-fee-proof";
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SHA = /^[0-9a-f]{40}$/;
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const lower = (v) => (typeof v === "string" ? v.toLowerCase() : null);
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** Each network's FeeCollector deploy record (evm-fee-collector.<network>.json), or null where there is none. */
export function collectorRecords(networks = NETWORKS) {
  return Object.fromEntries(networks.map((n) => [n, existsSync(recordFile(n)) ? JSON.parse(readFileSync(recordFile(n), "utf8")) : null]));
}

/** The commit this check runs at (live.yml: the deployed commit, checked out and tested to be HEAD). */
export function headCommit() {
  const out = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (!SHA.test(out)) throw new Error("no commit at HEAD");
  return out;
}

/** A fetch that answers each JSON-RPC call from recorded answers ({ url, method, params, status, json }), in order. */
export function replayed(answers) {
  const left = [...(answers ?? [])];
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const i = left.findIndex((a) => a.url === url && a.method === method && JSON.stringify(a.params) === JSON.stringify(params));
    if (i < 0) throw new Error(`no recorded answer for ${new URL(url).host} ${method}`);
    const [a] = left.splice(i, 1);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json };
  };
}

/**
 * The check on one recorded run: { base, pools: [{ network, pool, fee: { status, headers, body } }], rpc: { network:
 * answers } }, against the commit the helper must run, the pool records, the collector records and the kit's venues.
 */
export async function judge(run, { commit, records = evmPoolRecords(), collectors = collectorRecords(), venues = evmPoolVenues() } = {}) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let quiet = false;
  const want = Object.entries(records);
  const pools = run.pools ?? [];
  say(want.length > 0, `pools with a deploy record: ${show(want.map(([n]) => n))}`);
  say(pools.length === want.length && want.every(([n, pool]) => pools.some((p) => p.network === n && p.pool === pool)), `pools read: ${show(pools.map((p) => `${p.network} ${p.pool}`))}, want ${show(want.map(([n, p]) => `${n} ${p}`))}`);
  for (const p of pools) {
    const n = p.network;
    const v = Object.hasOwn(venues, n) ? venues[n] : undefined;
    const cpin = v !== undefined && Object.hasOwn(v, "feeCollector") ? lower(v.feeCollector) : null;
    const spin = v !== undefined && Object.hasOwn(v, "sellSender") ? lower(v.sellSender) : null;
    const d = Object.hasOwn(collectors, n) ? collectors[n] : null;
    const recorded = d?.chain === n ? lower(d.contracts?.FeeCollector?.address) : null;
    const sink = d?.chain === n ? lower(d.contracts?.FeeCollector?.sink) : null;
    const f = p.fee ?? {};
    const b = json(f.body ?? "");
    const coll = lower(b?.fee_collector);
    const seller = lower(b?.sell_sender);
    if (noBlockYet(f)) {
      // the chain made no block for over a minute: no fee answer to read; the collector's chain reads below still are
      quiet = true;
      lines.push(`QUIET [${n} fee] the helper has no block in the epoch or the one before (GET /v1/pool/fee answers ${f.status} index_behind)`);
    } else {
      say(f.status === 200 && coll !== null && ADDRESS.test(coll) && cpin !== null && coll === cpin && cpin === recorded,
        `[${n} fee] ${f.status}: fee_collector ${show(b?.fee_collector)} is the kit's pin ${show(cpin)}, which is evm-fee-collector.${n}.json's FeeCollector ${show(recorded)}`);
      say(f.status === 200 && seller !== null && ADDRESS.test(seller) && spin !== null && seller === spin && spin === sink,
        `[${n} fee] sell_sender ${show(b?.sell_sender)} is the kit's sell sender pin ${show(spin)} and the collector's sink ${show(sink)}`);
      const hc = f.headers?.["x-helper-commit"];
      say(SHA.test(commit ?? "") && hc === commit, `[${n} fee] X-Helper-Commit ${show(hc)} is the commit this check runs at ${show(commit)}`);
    }
    if (d === null || d === undefined) {
      say(false, `[${n} collector] no evm-fee-collector.${n}.json record`);
      continue;
    }
    const r = await collectorCheck({ deployment: d, fetchFn: replayed(run.rpc?.[n]), sleep: async () => {}, venues });
    for (const l of r.lines) say(l.startsWith("ok "), `[${n} collector] ${l.replace(/^(ok|FAIL)\s+/, "")}`);
  }
  const verdict = lines.length === 0 ? "FAIL" : verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

/** One read of HELPER_HOST and each collector's chain: the fee answers and every RPC answer, for judge(). */
export async function read(base = BASE, fetchFn = fetch, { records = evmPoolRecords(), collectors = collectorRecords(), rpcFetch = fetch } = {}) {
  const pools = [];
  for (const [network, pool] of Object.entries(records)) {
    // the epoch's fee and, when the helper has no block in it yet, the one before's (evm-pool-fee-epoch.mjs): the first
    // answer is kept as fee_first
    const ask = async (url) => {
      const r = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      return { readAt: new Date().toISOString(), status: r.status, headers: Object.fromEntries(r.headers), body: (await r.text()).slice(0, 2_000) };
    };
    const { answer, first } = await evmPoolFeeAsk(ask, base, pool);
    pools.push({ network, pool, fee: answer, ...(first ? { fee_first: first } : {}) });
  }
  const rpc = {};
  for (const [network, d] of Object.entries(collectors)) {
    if (d === null) continue;
    const rec = recorder(rpcFetch);
    await collectorCheck({ deployment: d, fetchFn: rec.fetchFn });
    rpc[network] = rec.answers;
  }
  return { base, pools, rpc };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  try {
    const commit = headCommit();
    const run = await read(opt("--base") ?? BASE);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify({ commit, ...run }, null, 1)}\n`);
    const r = await judge(run, { commit });
    for (const l of r.lines) console.log(l);
    console.log(`live-check ${KEY}: ${r.verdict} (${run.base}, commit ${commit})`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
