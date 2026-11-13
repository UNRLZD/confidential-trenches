#!/usr/bin/env node
// How long each Base or Robinhood provider the signing page reads takes to answer, measured read-only from this machine:
// per host of the page's pool, fee, history and venue lists, CT_DELAY_TRIES reads (default 3) of each kind a landing
// sends, one at a time: a block (eth_getBlockByNumber latest), a pool view (eth_call currentRoot() at latest) and a log
// page (eth_getLogs of the pool over the newest 100 blocks). Never a send. Writes {measuredAt, chain, hosts: {host:
// {block, call, logs}}} (each the median ms of its answered reads, null when none answered) for the mainnet copy
// (pool-fork-evm-carry-withdraw.mjs CT_HOST_DELAYS_FILE), which delays each request it answers by its host's figure.
//   node packages/signpage/scripts/evm-host-delays.mjs <base|robinhood> <out.json>
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The kind of a request, as the delays are measured: a log page, a view (eth_call, eth_estimateGas), else a block. */
export const delayKind = (method) => (method === "eth_getLogs" ? "logs" : method === "eth_call" || method === "eth_estimateGas" ? "call" : "block");
export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.floor((s.length - 1) / 2)];
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [chain, out] = process.argv.slice(2);
  if ((chain !== "base" && chain !== "robinhood") || !out) {
    console.error("usage: evm-host-delays.mjs <base|robinhood> <out.json>");
    process.exit(2);
  }
  globalThis.__SIGN_NETWORK__ = "mainnet";
  const { MAINNET_EVM_FEE_RPCS, MAINNET_POOL_HISTORY, MAINNET_POOL_RPCS } = await import("../src/pool-testnet.ts");
  const { EVM_POOLS } = await import("../../wallet/src/pool/evm.ts");
  const { evmPoolVenues } = await import("../../kit/src/trade/evm/buy-unpinned.ts");
  const urlsIn = (v, acc = []) => {
    if (typeof v === "string" && /^https:\/\//.test(v)) acc.push(v);
    else if (v && typeof v === "object") for (const x of Object.values(v)) urlsIn(x, acc);
    return acc;
  };
  const urls = new Map([...MAINNET_POOL_RPCS[chain], ...MAINNET_EVM_FEE_RPCS[chain], ...MAINNET_POOL_HISTORY[chain], ...urlsIn(evmPoolVenues()[chain])].map((u) => [new URL(u).host, u]));
  const pool = EVM_POOLS[chain].pool;
  const tries = Number(process.env.CT_DELAY_TRIES ?? 3);
  const rpc = async (url, method, params) => {
    const s = performance.now();
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
    const j = await r.json().catch(() => null);
    return { ms: Math.round(performance.now() - s), ok: r.status === 200 && j !== null && "result" in j, result: j?.result };
  };
  const hosts = {};
  for (const [host, url] of urls) {
    const got = { block: [], call: [], logs: [] };
    for (let k = 0; k < tries; k++) {
      const b = await rpc(url, "eth_getBlockByNumber", ["latest", false]).catch(() => null);
      if (b?.ok) got.block.push(b.ms);
      const head = b?.ok && typeof b.result?.number === "string" ? BigInt(b.result.number) : null;
      const c = await rpc(url, "eth_call", [{ to: pool, data: "0xfdab463d" }, "latest"]).catch(() => null);
      if (c?.ok) got.call.push(c.ms);
      if (head !== null) {
        const l = await rpc(url, "eth_getLogs", [{ address: pool, fromBlock: `0x${(head - 100n).toString(16)}`, toBlock: `0x${head.toString(16)}` }]).catch(() => null);
        if (l?.ok) got.logs.push(l.ms);
      }
    }
    hosts[host] = { block: median(got.block), call: median(got.call), logs: median(got.logs), answered: { block: got.block.length, call: got.call.length, logs: got.logs.length }, of: tries };
    console.log(`${chain} ${host}: block ${hosts[host].block} ms, call ${hosts[host].call} ms, logs ${hosts[host].logs} ms (answered ${got.block.length}/${got.call.length}/${got.logs.length} of ${tries})`);
  }
  writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), chain, tries, hosts }, null, 2) + "\n");
}
