#!/usr/bin/env node
// Live check of card wallet-rpc-hex-case: the device reads an RPC's hex in either case. robinhood-testnet.drpc.org
// answers eth_chainId "0xB626" (upper case; read 3 Nov 23:07Z) where rpc.testnet.chain.robinhood.com answers "0xb626",
// and on 3 Nov 22:55Z a Robinhood testnet restore left both its Ws' tokens unread on that pair because the wallet
// refused drpc's answer. This check reads both providers and runs their answers through the wallet's own parser and
// two-RPC check (packages/wallet/scripts/rpc-hex-case-check.ts, a child process, so Blindfill's code stays behind the
// kit's entry for this file and no check here is a second implementation of the wallet's):
//   - the finalized anchor, the lower of the two finalized blocks read by number on both, one hash on both;
//   - eth_chainId on both, read by the wallet, 46630 on both, and the anchor's height holding its hash on both.
// It fails if either answer is refused or the two disagree. It prints each provider's raw answer, so a run shows
// whether drpc still writes upper case.
//   node scripts/live-checks/wallet-rpc-hex-case.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every answer read, as the good run of wallet-rpc-hex-case.answers.json, and its bad run: the same
// answers with drpc's eth_chainId one higher ("0xB627", another chain in the same case), which the wallet must refuse.
// Runs: once, it reads no host: the wallet parser at the checkout against two Robinhood testnet RPCs; the wallet tests hold the parse
import "../net-window.mjs";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "wallet-rpc-hex-case";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
export const CHECK = path.join(REPO, "packages", "wallet", "scripts", "rpc-hex-case-check.ts");
/** Robinhood testnet (chain 46630, scripts/ci/money-gate.mjs CHAIN_ID): the upper-case provider, then a lower-case one. */
export const CHAIN_ID = 46630n;
export const RPCS = Object.freeze(["https://robinhood-testnet.drpc.org", "https://rpc.testnet.chain.robinhood.com"]);

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** One JSON-RPC call over the network: { result } or { error }; a 429, a 5xx or a failed fetch is tried 4 times. */
export async function post(url, method, params) {
  for (let t = 1; ; t++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
      if ((r.status === 429 || r.status >= 500) && t < 4) {
        await pause(1000 * t);
        continue;
      }
      const j = await r.json();
      if (j?.error) return { error: `RPC error ${j.error.code}: ${j.error.message}` };
      if (!r.ok) return { error: `HTTP ${r.status}` };
      return { result: j.result };
    } catch (e) {
      if (t < 4) {
        await pause(1000 * t);
        continue;
      }
      return { error: `fetch failed: ${e?.message ?? e}` };
    }
  }
}

/** A live transport that keeps every answer, in order. */
export function recorder() {
  const log = [];
  const transport = async (url, method, params) => {
    const a = await post(url, method, params);
    log.push({ url, method, params, ...a });
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
  return async (url, method, params) => {
    const q = queues.get(JSON.stringify([url, method, params]));
    const e = q?.length > 1 ? q.shift() : q?.[0];
    if (e === undefined) return { error: `no recorded answer to ${method} ${JSON.stringify(params)} on ${url}` };
    return "error" in e ? { error: e.error } : { result: e.result };
  };
}

/** The wallet's check on the pair, its RPCs bridged to `transport`. Resolves its report, or throws its refusal. */
function runCheck(transport, wait) {
  return new Promise((resolve, reject) => {
    const args = { chainId: CHAIN_ID.toString(), urls: RPCS, wait };
    const child = spawn(process.execPath, [CHECK, JSON.stringify(args)], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
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
          transport(RPCS[m.rpc.k], m.rpc.method, m.rpc.params).then((a) => {
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

/** The check: { ok, lines }. */
export async function check(transport, { wait = true } = {}) {
  const lines = [];
  try {
    const r = await runCheck(transport, wait);
    const want = `0x${CHAIN_ID.toString(16)}`;
    if (r.read.some((v) => v !== want)) throw new Error(`the wallet read eth_chainId ${r.read.join(" and ")}, not ${want} on both`);
    for (const [k, u] of RPCS.entries()) {
      const v = r.chainIds[k];
      lines.push(`${host(u)}: eth_chainId ${JSON.stringify(v)}${v !== v.toLowerCase() ? " (upper case)" : ""}, read by the wallet as ${CHAIN_ID}`);
    }
    lines.push(`the two RPCs agree: chain ${CHAIN_ID} on both, the finalized anchor ${r.anchor.number} ${r.anchor.hash} held on both`);
    return { ok: true, lines };
  } catch (e) {
    lines.push(`${e?.message ?? e}`);
    return { ok: false, lines };
  }
}

/** The bad run kept beside a good one: drpc's eth_chainId one higher, in upper case ("0xB627"). */
export function spoil(log) {
  return log.map((e) => (e.url === RPCS[0] && e.method === "eth_chainId" && typeof e.result === "string" ? { ...e, result: `0x${(BigInt(e.result) + 1n).toString(16).toUpperCase()}` } : e));
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
