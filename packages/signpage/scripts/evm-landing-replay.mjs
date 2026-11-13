#!/usr/bin/env node
// The busiest 10 s a Base or Robinhood landing sent each pool host in a mainnet copy (pool-fork-evm-carry-withdraw.mjs's
// "first leaf" step: hostWindowMax, its requests by method), sent again once to the real providers, read-only, at the
// same count per method inside 10 s, spread evenly: how many each provider refused (HTTP 429, or a JSON-RPC rate error).
// Every host of the record's windows is replayed, from the page's pool, fee and history lists. Never a send:
// eth_sendRawTransaction is replayed as eth_chainId, and every eth_call goes to the pool with its recorded selector alone
// (a revert is an answer, not a refusal).
//   node packages/signpage/scripts/evm-landing-replay.mjs <record.json> [<record.json> ...]
// Prints one line per record and host; exit 0 when no provider refused, 1 otherwise, 2 on error.
// Its plan (replayPlan) is tested offline: scripts/evm-landing-replay.test.mjs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const WINDOW_MS = 10_000;
const STEP = "first leaf: a ready proof inside its first minute";
const hex = (n) => `0x${n.toString(16)}`;

/** One read-only request of `m` (a record's method key) for `pool` at `head`. */
export const asRead = (m, pool, head) => {
  if (m.startsWith("eth_call ")) return ["eth_call", [{ to: pool, data: m.slice(9) }, "latest"]];
  switch (m) {
    case "eth_getBlockByNumber":
      return ["eth_getBlockByNumber", ["latest", false]];
    case "eth_getLogs":
      return ["eth_getLogs", [{ address: pool, fromBlock: hex(head - 100n), toBlock: hex(head) }]];
    case "eth_getBalance":
    case "eth_getTransactionCount":
      return [m, [pool, "latest"]];
    case "eth_estimateGas":
      return ["eth_estimateGas", [{ to: pool, data: "0x" }]];
    case "eth_getTransactionReceipt":
      return ["eth_getTransactionReceipt", [`0x${"00".repeat(32)}`]];
    default:
      return ["eth_chainId", []];
  }
};

/** A record's replay: per host of its busiest windows, the URL it was (from `lists`, the page's lists for the chain) and
 *  its methods, each as many times as recorded. A host in no list is an error (nothing sent to a guess). */
export const replayPlan = (rec, lists) => {
  const step = rec.steps.find((s) => s.name === STEP);
  const windows = step?.detail?.hostWindowMax ?? step?.hostWindowMax;
  if (!windows) throw new Error("no hostWindowMax in the record's first-leaf step");
  const urlOf = new Map(lists.map((u) => [new URL(u).host, u]));
  return Object.entries(windows)
    .filter(([, w]) => w.n > 0)
    .map(([host, w]) => {
      const url = urlOf.get(host);
      if (url === undefined) throw new Error(`${host}: in no list the page reads`);
      return { host, url, n: w.n, methods: Object.entries(w.by).flatMap(([m, k]) => Array.from({ length: k }, () => m)) };
    });
};

export const refused = (a) => a.status === 429 || /rate|limit|too many/i.test(String(a.body?.error?.message ?? "")) || a.body?.error?.code === -32005;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  globalThis.__SIGN_NETWORK__ = "mainnet";
  const { MAINNET_EVM_FEE_RPCS, MAINNET_POOL_HISTORY, MAINNET_POOL_RPCS } = await import("../src/pool-testnet.ts");
  const { EVM_POOLS } = await import("../../wallet/src/pool/evm.ts");
  const rpc = async (url, method, params) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: r.status, body };
  };
  let bad = 0;
  try {
    for (const file of process.argv.slice(2)) {
      const rec = JSON.parse(readFileSync(file, "utf8"));
      const chain = rec.chain;
      const pool = EVM_POOLS[chain].pool;
      for (const p of replayPlan(rec, [...MAINNET_POOL_RPCS[chain], ...MAINNET_EVM_FEE_RPCS[chain], ...MAINNET_POOL_HISTORY[chain]])) {
        const head = BigInt((await rpc(p.url, "eth_blockNumber", [])).body?.result ?? "0x0");
        const reads = p.methods.map((m) => asRead(m, pool, head));
        const gap = WINDOW_MS / reads.length;
        const t0 = Date.now();
        const answers = await Promise.all(reads.map(([m, q], i) => new Promise((r) => setTimeout(r, i * gap)).then(() => rpc(p.url, m, q).catch((e) => ({ status: 0, body: { error: { message: String(e?.name ?? e) } } })))));
        const n429 = answers.filter(refused).length;
        const others = answers.filter((a) => !refused(a) && a.status !== 200);
        const other = `${others.length}${others.length ? ` (${[...new Set(others.map((a) => `${a.status} ${String(a.body?.error?.message ?? "").slice(0, 80)}`))].join("; ")})` : ""}`;
        bad += n429;
        console.log(`${file.split("/").at(-1)} ${chain} ${p.host}: ${reads.length} reads in ${Date.now() - t0} ms, ${n429} refused for rate, ${other} other non-200`);
      }
    }
  } catch (e) {
    console.error(`evm-landing-replay: ${e?.message ?? e}`);
    process.exit(2);
  }
  process.exit(bad === 0 ? 0 : 1);
}
