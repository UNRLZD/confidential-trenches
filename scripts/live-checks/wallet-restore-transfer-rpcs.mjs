#!/usr/bin/env node
// Live check of card wallet-restore-transfer-rpcs: a restore from the 12 words reads every W's tokens on every EVM
// network, never "unread" because a provider caps the range, or because one is out: on Base and Robinhood on the live
// helper's route (POST https://api.confidential.unrealized.trade/v1/rpc/{chain}, one reader, decision M359, card
// evm-transfer-rpc-spares), on a testnet on its Transfer list (the wallet's EVM_TRANSFER_RPCS, which testnet-run takes
// too: three operators read as a pair with a spare; on 5 Nov 17:1xZ thirdweb's keyless daily quota failed Base and
// Robinhood testnet, HTTP 429 with Retry-After about 7.4 h). On 4 Nov 23:18Z the evm-buy-hookdata-fee run's restore left two of its three Base Sepolia Ws
// unread: base-sepolia.drpc.org answered code 19 "Temporary internal error" at 10 to 101 blocks and code 35 above
// (read 5 Nov 12:20Z), and the pager halved only on cap words it knew. This check runs a W's read through the wallet's
// own code (packages/wallet/scripts/transfer-rpcs-check.ts, a child process, so Blindfill's code stays behind the kit's
// entry for this file and no check here is a second implementation of the wallet's) on each network's list:
//   - Base Sepolia: that run's v3 buy's W 0x809286a1…078e from its buy's block 54553944 to the newest agreed block,
//     which must list the USDC it bought (0x036cbd53…3dcf7e), read on both providers alike;
//   - Base and Robinhood: a W's Transfer read over the newest 50,000 and 100,000 blocks on the helper's route, which
//     must answer (its provider's cap met by the pager). On 5 Nov 18:47-18:58Z the helper's Base provider answered a
//     Transfer filter with no address for one block only (-32701 "Please specify an address" at 2 to 10,000 blocks,
//     [] at 1), so a W's span never ended; since card evm-rpc-spare-list's helper deploy (3ed8cb1d) it answers 1,000
//     blocks (21:28Z: [] at 1 and 1,000 blocks, -32602 "maximum 1000 blocks" at 10,000);
//   - Robinhood testnet: a W's Transfer read over the newest 10,000 blocks, which must answer on both providers alike
//     (its dRPC caps at 101).
// Every call goes through the device's own client: on a list the signing page's pageRpc (the kit's solanaJsonRpc with
// SOLANA_RPC_RETRY), on the helper's route the helper client's (solanaJsonRpc with HELPER_FETCH_INIT, no retry), so a
// throttle reaches the wallet's pager as it does on the device.
// It fails if any read is refused, two providers disagree, or the W's USDC is not listed.
// Bounded (card restore-check-bounded): the four networks are read at once, each printed as it ends with its calls,
// time and refusals, and each has NETWORK_DEADLINE_MS: a read still going then fails, naming the call it is stuck on
// (the URL's host, never a key; the method, the block range, its try, and the Retry-After the provider named and the
// time waited since its last answer). Run 42146750370's job was cancelled at 20 min with no line: four reads one after
// another, printed only at the end, the Base one at 78-block pages (EVM_LOG_CEILING_PAGES in the wallet's evm.ts).
//   node scripts/live-checks/wallet-restore-transfer-rpcs.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every answer read, as the good run of wallet-restore-transfer-rpcs.answers.json, and its bad run: the
// same answers with every Transfer log of the Base Sepolia W taken out on both providers (a read that finds no USDC).
import "../net-window.mjs";
import { HELPER_FETCH_INIT, solanaJsonRpc, SOLANA_RPC_RETRY } from "../../packages/kit/src/index.ts";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "wallet-restore-transfer-rpcs";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
export const CHECK = path.join(REPO, "packages", "wallet", "scripts", "transfer-rpcs-check.ts");
/** scripts/live-checks/evm-buy-hookdata-fee.base-sepolia.json: the v3 buy's W, its block and the token it bought. */
export const W = "0x809286a1bf1585b1eeeefcc7a7f3508158fd078e";
export const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
export const HELPER = "https://api.confidential.unrealized.trade";
/** Each network's read ends within this: the slowest, Base's 50,000 blocks on the helper's route at its 1,000-block cap,
 * is 80 pages of 625 blocks at the holdings pace (2 eth_getLogs in 3 s), 130 s from the Mac (6 Nov 02:53Z, 88 calls)
 * and 3.2 min on GitHub's runner (run 42152968842); this is 2.8 times the Mac's read, and with the networks read at once
 * the job (its setup about 15 s) stays under 10 min. */
export const NETWORK_DEADLINE_MS = 360_000;
export const JOBS = Object.freeze([
  { network: "base-sepolia", w: W, from: "54553944", want: USDC },
  { network: "base", w: W, back: "50000", helper: HELPER },
  { network: "robinhood", w: W, back: "100000", helper: HELPER },
  // evm-buy-hookdata-fee.robinhood-testnet.json's first W
  { network: "robinhood-testnet", w: "0x764c5ac2e39fec9d25af6d3eaf9400f91d82a531", back: "10000" },
]);

const clients = new Map();
/** One JSON-RPC call through the device's client (pageRpc: solanaJsonRpc with SOLANA_RPC_RETRY, its 3.5 s retry and
 * no more; on the helper's route the helper client's, HELPER_FETCH_INIT and no retry): { result } or { error, name,
 * afterMs }, the name and Retry-After a throttle carries to the wallet's pager. */
export async function post(url, method, params) {
  if (!clients.has(url)) clients.set(url, url.startsWith(`${HELPER}/`) ? solanaJsonRpc(url, { init: HELPER_FETCH_INIT }) : solanaJsonRpc(url, { retry: SOLANA_RPC_RETRY }));
  try {
    return { result: await clients.get(url)(method, params) };
  } catch (e) {
    return { error: String(e?.message ?? e), name: String(e?.name ?? "Error"), afterMs: typeof e?.afterMs === "number" ? e.afterMs : null };
  }
}

/** A live transport that keeps every answer, in order, with the network it was read for. */
export function recorder() {
  const log = [];
  const transport = async (network, url, method, params) => {
    const a = await post(url, method, params);
    log.push({ network, url, method, params, ...a });
    return a;
  };
  return { transport, log };
}

/** A transport that answers each call with the recorded answers to that same call, in their order; past the last,
 * the last again. */
export function replayer(log) {
  const queues = new Map();
  for (const e of log) {
    const k = JSON.stringify([e.url, e.method, e.params]);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(e);
  }
  return async (_network, url, method, params) => {
    const q = queues.get(JSON.stringify([url, method, params]));
    const e = q?.length > 1 ? q.shift() : q?.[0];
    if (e === undefined) return { error: `no recorded answer to ${method} ${JSON.stringify(params)} on ${url}` };
    return "error" in e ? { error: e.error, ...(e.name ? { name: e.name } : {}), ...(e.afterMs !== undefined ? { afterMs: e.afterMs } : {}) } : { result: e.result };
  };
}

const host = (u) => new URL(u).host;
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
/** A call as a line names it: the method, an eth_getLogs page's range or a block's tag, and the URL's host only. */
function callName(c) {
  const f = c.params?.[0];
  const what = c.method === "eth_getLogs" && f?.fromBlock !== undefined ? ` ${BigInt(f.fromBlock)}..${BigInt(f.toBlock)} (${BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n} blocks)` : typeof f === "string" ? ` ${f}` : "";
  return `${c.method}${what} on ${host(c.url)}`;
}

/** The wallet's W read on one network's Transfer pair, its RPCs bridged to `transport`, ended at `deadlineMs`.
 * Resolves its report with its calls (`stats`), or throws its refusal; past the deadline the child is stopped and the
 * refusal names the stuck call: the oldest still unanswered, else the last answered (the read waiting out a throttle
 * or its pace), with its try, its error and Retry-After, and the time since. */
function runCheck(job, transport, wait, deadlineMs) {
  return new Promise((resolve, reject) => {
    const { want, ...args } = job;
    const t0 = Date.now();
    const child = spawn(process.execPath, [CHECK, JSON.stringify({ ...args, wait })], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", err = "", settled = false;
    const stats = { calls: 0, refused: new Map() };
    const open = new Map(); // id -> the call, asked at
    const tries = new Map(); // [url, method, params] -> times asked
    let last = null; // the last answered call, its answer and when
    child.stdin.on("error", () => {}); // an answer after the check has exited
    const stuck = () => {
      const now = Date.now();
      const o = [...open.values()].sort((a, b) => a.at - b.at)[0];
      if (o !== undefined) return `${callName(o)}, try ${o.try}, no answer in ${secs(now - o.at)}`;
      if (last === null) return "no call asked";
      const said = last.error === undefined ? "answered" : `refused (${String(last.error).slice(0, 100)}), Retry-After ${last.afterMs == null ? "none" : secs(last.afterMs)}`;
      return `${callName(last)}, try ${last.try}, ${said}, ${secs(now - last.at)} waited since`;
    };
    const timer = setTimeout(() => {
      const why = `no end in ${secs(deadlineMs)} (${stats.calls} calls): stuck on ${stuck()}`;
      settle(reject, new Error(why));
      child.kill("SIGKILL");
    }, deadlineMs);
    const settle = (f, v) => (settled ? undefined : ((settled = true), clearTimeout(timer), f(v)));
    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.rpc) {
          // the URL is the wallet's own (EVM_TRANSFER_RPCS[network], or the helper's route), named by the bridge
          const k = JSON.stringify([m.rpc.url, m.rpc.method, m.rpc.params]);
          const c = { url: m.rpc.url, method: m.rpc.method, params: m.rpc.params, at: Date.now(), try: (tries.get(k) ?? 0) + 1 };
          tries.set(k, c.try);
          open.set(m.rpc.id, c);
          stats.calls++;
          transport(m.rpc.url, m.rpc.method, m.rpc.params).then((a) => {
            open.delete(m.rpc.id);
            last = { ...c, at: Date.now(), error: a.error, afterMs: a.afterMs };
            if (a.error !== undefined) {
              const w = String(a.error).slice(0, 80);
              stats.refused.set(w, (stats.refused.get(w) ?? 0) + 1);
            }
            if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ id: m.rpc.id, ...a })}\n`);
          });
        } else if (m.done) settle(resolve, { ...m.done, stats: { calls: stats.calls, refused: stats.refused, ms: Date.now() - t0 } });
        else if (m.fail) settle(reject, new Error(m.fail));
      }
    });
    child.on("close", (code) => {
      child.stdin.destroy();
      settle(reject, new Error(`the check exited ${code} with no answer${err ? `: ${err.trim().split("\n").slice(-3).join(" ")}` : ""}`));
    });
  });
}

/** "88 calls in 129.8 s, 4 refused: <words> x4": a read's calls, its time and each refusal's words (the first 80
 * characters) with their count, the three most often. */
function statsOf({ calls, refused, ms }) {
  const n = [...refused.values()].reduce((a, b) => a + b, 0);
  const top = [...refused].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, c]) => `${w} x${c}`);
  return `${calls} calls in ${secs(ms)}${n ? `, ${n} refused: ${top.join("; ")}` : ""}`;
}

/** The check: { ok, lines, reports } (a job's report, or null when it failed), in the order of `jobs`, every job read
 * at once. `transport(network, url, method, params)`; each network's URLs are the wallet's own. `jobs`: JOBS, or others
 * of their shape. `onLine(ok, line)`: each job's line as it ends. `deadlineMs`: each job's (NETWORK_DEADLINE_MS). */
export async function check(transport, { wait = true, jobs = JOBS, onLine = () => {}, deadlineMs = NETWORK_DEADLINE_MS } = {}) {
  const ends = await Promise.all(jobs.map(async (job) => {
    let end;
    try {
      const r = await runCheck(job, (url, method, params) => transport(job.network, url, method, params), wait, deadlineMs);
      const urls = r.urls;
      const swapped = (r.asked ?? []).filter((u) => !urls.includes(u));
      if (job.want !== undefined && !r.tokens.includes(job.want)) throw new Error(`W ${job.w} lists ${r.tokens.length ? r.tokens.join(", ") : "no token"}, not ${job.want}`);
      const who = job.helper ? `the helper's route ${urls[0]}` : `${urls.map(host).join(" and ")}`;
      const { stats, ...report } = r;
      end = { ok: true, report, line: `${job.network}: ${who} read W ${job.w} from block ${r.from} to ${r.anchor.number}${job.helper ? "" : " alike"}: ${r.tokens.length ? r.tokens.join(", ") : "no token"} (last pages ${r.page.join(" and ")} blocks; ${statsOf(stats)})${swapped.length ? `; swapped out ${swapped.map(host).join(" and ")}` : ""}` };
    } catch (e) {
      end = { ok: false, report: null, line: `${job.network}: ${e?.message ?? e}` };
    }
    onLine(end.ok, end.line);
    return end;
  }));
  return { ok: ends.every((e) => e.ok), lines: ends.map((e) => e.line), reports: ends.map((e) => e.report) };
}

/** The bad run kept beside a good one: every Transfer log of the Base Sepolia W taken out of both providers' answers. */
export function spoil(log) {
  return log.map((e) => (e.network === "base-sepolia" && e.method === "eth_getLogs" && Array.isArray(e.result) ? { ...e, result: [] } : e));
}

async function main(argv) {
  const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const record = at("--record");
  const rec = recorder();
  const r = await check(rec.transport, { onLine: (ok, l) => console.log(`${ok ? "PASS" : "FAIL"} ${l}`) });
  if (record) {
    writeFileSync(record, `${JSON.stringify({ key: KEY, recorded: new Date().toISOString(), good: rec.log, bad: spoil(rec.log) }, null, 1)}\n`);
    console.log(`recorded ${record}`);
  }
  console.log(r.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`error: ${e?.stack ?? e}`), process.exit(2)));
