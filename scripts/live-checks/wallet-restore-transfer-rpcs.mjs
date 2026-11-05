#!/usr/bin/env node
// Live check of card wallet-restore-transfer-rpcs: a restore from the 12 words reads every W's tokens on every EVM
// network's Transfer list (the wallet's EVM_TRANSFER_RPCS, which testnet-run takes too), never "unread" because a
// provider caps the range, or because one is out (card evm-transfer-rpc-spares: each list is three operators read as a
// pair with a spare; on 5 Nov 17:1xZ thirdweb's keyless daily quota failed Base and Robinhood testnet, HTTP 429 with
// Retry-After about 7.4 h). On 4 Nov 23:18Z the evm-buy-hookdata-fee run's restore left two of its three Base Sepolia Ws
// unread: base-sepolia.drpc.org answered code 19 "Temporary internal error" at 10 to 101 blocks and code 35 above
// (read 5 Nov 12:20Z), and the pager halved only on cap words it knew. This check runs a W's read through the wallet's
// own code (packages/wallet/scripts/transfer-rpcs-check.ts, a child process, so Blindfill's code stays behind the kit's
// entry for this file and no check here is a second implementation of the wallet's) on each network's list:
//   - Base Sepolia: that run's v3 buy's W 0x809286a1…078e from its buy's block 54553944 to the newest agreed block,
//     which must list the USDC it bought (0x036cbd53…3dcf7e), read on both providers alike;
//   - Robinhood, Base and Robinhood testnet: a W's Transfer read over the newest 100,000, 50,000 and 10,000 blocks,
//     which must answer on both providers alike (Robinhood's own caps at 30,000 blocks and daybreak at 2,000, Base's
//     Tenderly and thirdweb at 1,000, thirdweb throttling after about 4 calls, Robinhood testnet's dRPC at 101).
// Every call goes through the device's own client (the signing page's pageRpc: the kit's solanaJsonRpc with
// SOLANA_RPC_RETRY), so a throttle reaches the wallet's pager as it does on the device.
// It fails if any read is refused, the two providers disagree, or the W's USDC is not listed.
//   node scripts/live-checks/wallet-restore-transfer-rpcs.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every answer read, as the good run of wallet-restore-transfer-rpcs.answers.json, and its bad run: the
// same answers with every Transfer log of the Base Sepolia W taken out on both providers (a read that finds no USDC).
// Runs: once, it reads no host: the wallet at the checkout against public RPCs; the wallet tests hold the pager
import "../net-window.mjs";
import { solanaJsonRpc, SOLANA_RPC_RETRY } from "../../packages/kit/src/index.ts";
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
export const JOBS = Object.freeze([
  { network: "base-sepolia", w: W, from: "54553944", want: USDC },
  { network: "base", w: W, back: "50000" },
  { network: "robinhood", w: W, back: "100000" },
  // evm-buy-hookdata-fee.robinhood-testnet.json's first W
  { network: "robinhood-testnet", w: "0x764c5ac2e39fec9d25af6d3eaf9400f91d82a531", back: "10000" },
]);

const clients = new Map();
/** One JSON-RPC call through the device's client (pageRpc: solanaJsonRpc with SOLANA_RPC_RETRY, its 3.5 s retry and
 * no more): { result } or { error, name, afterMs }, the name and Retry-After a throttle carries to the wallet's pager. */
export async function post(url, method, params) {
  if (!clients.has(url)) clients.set(url, solanaJsonRpc(url, { retry: SOLANA_RPC_RETRY }));
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

/** The wallet's W read on one network's Transfer pair, its RPCs bridged to `transport`. Resolves its report, or
 * throws its refusal. */
function runCheck(job, transport, wait) {
  return new Promise((resolve, reject) => {
    const { want, ...args } = job;
    const child = spawn(process.execPath, [CHECK, JSON.stringify({ ...args, wait })], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", err = "", settled = false;
    child.stdin.on("error", () => {}); // an answer after the check has exited
    const settle = (f, v) => (settled ? undefined : ((settled = true), f(v)));
    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.rpc) {
          // the URL is the wallet's own (EVM_TRANSFER_RPCS[network]), named by the bridge
          transport(m.rpc.url, m.rpc.method, m.rpc.params).then((a) => {
            if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ id: m.rpc.id, ...a })}\n`);
          });
        } else if (m.done) settle(resolve, m.done);
        else if (m.fail) settle(reject, new Error(m.fail));
      }
    });
    child.on("close", (code) => {
      child.stdin.destroy();
      settle(reject, new Error(`the check exited ${code} with no answer${err ? `: ${err.trim().split("\n").slice(-3).join(" ")}` : ""}`));
    });
  });
}

const host = (u) => new URL(u).host;

/** The check: { ok, lines }. `transport(network, url, method, params)`; each network's URLs are the wallet's own. */
export async function check(transport, { wait = true } = {}) {
  const lines = [];
  let ok = true;
  for (const job of JOBS) {
    try {
      const r = await runCheck(job, (url, method, params) => transport(job.network, url, method, params), wait);
      const urls = r.urls;
      const swapped = (r.asked ?? []).filter((u) => !urls.includes(u));
      if (job.want !== undefined && !r.tokens.includes(job.want)) throw new Error(`W ${job.w} lists ${r.tokens.length ? r.tokens.join(", ") : "no token"}, not ${job.want}`);
      lines.push(`${job.network}: ${urls.map(host).join(" and ")} read W ${job.w} from block ${r.from} to ${r.anchor.number} alike: ${r.tokens.length ? r.tokens.join(", ") : "no token"} (last pages ${r.page.join(" and ")} blocks)${swapped.length ? `; swapped out ${swapped.map(host).join(" and ")}` : ""}`);
    } catch (e) {
      ok = false;
      lines.push(`${job.network}: ${e?.message ?? e}`);
    }
  }
  return { ok, lines };
}

/** The bad run kept beside a good one: every Transfer log of the Base Sepolia W taken out of both providers' answers. */
export function spoil(log) {
  return log.map((e) => (e.network === "base-sepolia" && e.method === "eth_getLogs" && Array.isArray(e.result) ? { ...e, result: [] } : e));
}

async function main(argv) {
  const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const record = at("--record");
  const rec = recorder();
  const r = await check(rec.transport);
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
