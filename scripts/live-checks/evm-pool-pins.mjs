#!/usr/bin/env node
// Live check of card evm-pool-pins: the testnet build's EVM pool pins (packages/wallet/src/pool/evm.ts EVM_POOLS,
// which packages/wallet/test/evm-pool-pins.test.ts holds equal to PINS here) are what is deployed and served.
// For Base Sepolia and Robinhood testnet, on both RPCs of pool-evm-deploy.mjs CHAINS (two operators each):
//   - the chain id is the testnet's;
//   - the pool's deploy tx (its newest pool record, pool-evm-deploy.mjs poolFile) succeeded, made the pinned pool, and
//     sits in the pinned deploy block (the block the wallet's pool sync starts at);
//   - the pool's code is its build (pool-evm-deploy.mjs pinnedBuild: length and keccak256 with immutables zeroed);
// and on the deployed helper, GET /v1/pool/fee for the pool names the pin's network, pool and fee recipient (the address
// every proof binds; a pin naming another is a deposit whose notes no relayer can ever spend).
//   node scripts/live-checks/evm-pool-pins.mjs [--record <file>]   PASS exit 0, FAIL 1, error 2
// --record writes the answers of a good run (PINS) and a bad run (BEFORE: the 3 Nov pools of pool-evm-deploy.md, which
// no helper serves) to <file>, for the test's replay (evm-pool-pins.answers.json).
// After: helper sign
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHAINS, pinnedBuild, poolFile, runtimeOf } from "./pool-evm-deploy.mjs";

export const KEY = "evm-pool-pins";
export const HELPER = "https://ct-api.unrealized.trade";

/** The pins the testnet build carries (the wallet's EVM_POOLS; its test holds the two equal). */
export const PINS = Object.freeze({
  "base-sepolia": Object.freeze({ network: "base-sepolia", pool: "0xeb967dfc1b4ffb22942f833c76866ea85fc42266", feeRecipient: "0x6c830ac1b22d96baf692af4dd17d822ba61c32ec", fromBlock: "55524040" }),
  "robinhood-testnet": Object.freeze({ network: "robinhood-testnet", pool: "0xed9fac860e6bc5e932455232eedca8b71c44da4d", feeRecipient: "0xe40f67e8502a3e2ebf4caf7bdee8ac8758b472a7", fromBlock: "149841188" }),
});
/** The pins pool-evm-deploy.md's 3 Nov pools would have made, each at its own deploy block (read 2026-11-09 21:5xZ):
 *  the bad run, which fails only on the helper (no relayer serves them). Their deploy txs are that record's. */
export const BEFORE = Object.freeze({
  "base-sepolia": Object.freeze({ network: "base-sepolia", pool: "0xb239a38af69b68e6c5c305df64985f283b5d5fe5", feeRecipient: "0x6c830ac1b22d96baf692af4dd17d822ba61c32ec", fromBlock: "53801443", tx: "0x388b62ddca5ba87084edb814e5290f097be2ff9b4ecb1dec69b5f2c567cb163a" }),
  "robinhood-testnet": Object.freeze({ network: "robinhood-testnet", pool: "0xe5e948414a89c23e73d76cd740dacdd9364c25d5", feeRecipient: "0xe40f67e8502a3e2ebf4caf7bdee8ac8758b472a7", fromBlock: "147492335", tx: "0x32169e3cd8f365ae90a10f43eca8f1cc32953ee9bc60e3d6cd2f3253ae3cba23" }),
});

/** The deploy tx of the pool in `net`'s newest pool record. */
export function deployTxOf(net) {
  const r = JSON.parse(readFileSync(poolFile(net), "utf8"));
  return r.txs.find((t) => t.contract === "PrivacyPoolSimple")?.hash ?? null;
}

/** A transport that answers through fetch and records each answer: { url, body, status, json }. */
export function recorder(fetchFn = fetch) {
  const log = [];
  const send = async (url, body) => {
    const r = await fetchFn(url, body === null ? { method: "GET" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await r.json().catch(() => null);
    log.push({ url, body, status: r.status, json });
    return { status: r.status, json };
  };
  return { log, send };
}
/** A transport that answers from a recorded log, each answer once, by url and body. */
export function replayer(log) {
  const left = [...log];
  return async (url, body) => {
    const i = left.findIndex((e) => e.url === url && JSON.stringify(e.body) === JSON.stringify(body));
    if (i < 0) throw new Error(`no recorded answer for ${url} ${JSON.stringify(body)}`);
    const [e] = left.splice(i, 1);
    return { status: e.status, json: e.json };
  };
}

const rpcCall = async (send, url, method, params) => {
  const { status, json } = await send(url, { jsonrpc: "2.0", id: 1, method, params });
  if (status !== 200 || !json || json.error) throw new Error(`${method}: HTTP ${status} ${JSON.stringify(json?.error ?? null).slice(0, 120)}`);
  return json.result;
};
const hostOf = (u) => new URL(u).hostname;

/** One pin's lines on its two RPCs and the helper. `epochMs`: the fee answer's epoch (a minute's start). */
export async function checkPin(send, net, pin, tx, epochMs) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${net}: ${text}`);
  };
  const chain = CHAINS[net];
  for (const url of chain.rpcs) {
    const on = `on ${hostOf(url)}`;
    try {
      const id = await rpcCall(send, url, "eth_chainId", []);
      say(id === chain.chainId, `chain id ${id} ${on}`);
      const r = await rpcCall(send, url, "eth_getTransactionReceipt", [tx]);
      const block = r?.blockNumber ? BigInt(r.blockNumber).toString() : "none";
      say(r?.status === "0x1" && String(r?.contractAddress).toLowerCase() === pin.pool && block === pin.fromBlock,
        `deploy tx ${tx.slice(0, 12)}… made ${r?.contractAddress ?? "nothing"} in block ${block} (status ${r?.status ?? "none"}); the pin: ${pin.pool} in block ${pin.fromBlock} ${on}`);
      const code = await rpcCall(send, url, "eth_getCode", [pin.pool, "latest"]);
      const b = pinnedBuild(net, "PrivacyPoolSimple", pin.pool);
      const rt = runtimeOf(code, b.immutables);
      say(rt.length === b.length && rt.masked === b.masked, `the pool's code is its build (${rt.length} bytes, masked ${rt.masked.slice(0, 12)}…) ${on}`);
    } catch (e) {
      say(false, `${on}: ${e.message}`);
    }
  }
  const { status, json } = await send(`${HELPER}/v1/pool/fee?pool=${pin.pool}&epoch=${epochMs}`, null);
  const f = json ?? {};
  say(status === 200 && f.network === net && String(f.pool).toLowerCase() === pin.pool && String(f.fee_recipient).toLowerCase() === pin.feeRecipient,
    `the helper's fee answer (HTTP ${status}) names ${f.network ?? "-"}, ${f.pool ?? "-"}, fee recipient ${f.fee_recipient ?? JSON.stringify(f.error ?? null)}; the pin: ${pin.feeRecipient}`);
  return { ok, lines };
}

/** Every pin's lines and the verdict. `pins` and `txOf` are the good run's (PINS, deployTxOf) unless given. */
export async function check(send, { pins = PINS, txOf = deployTxOf, epochMs } = {}) {
  const lines = [];
  let ok = Object.keys(pins).length === 2;
  if (!ok) lines.push(`FAIL the pins name ${Object.keys(pins).join(", ")}, not base-sepolia and robinhood-testnet`);
  for (const [net, pin] of Object.entries(pins)) {
    const tx = txOf(net);
    if (!tx) {
      ok = false;
      lines.push(`FAIL ${net}: no deploy tx of its pool in ${poolFile(net)}`);
      continue;
    }
    const r = await checkPin(send, net, pin, tx, epochMs);
    ok &&= r.ok;
    lines.push(...r.lines);
  }
  return { ok, lines };
}

async function main(argv) {
  const at = argv.indexOf("--record");
  const epochMs = Math.floor(Date.now() / 60_000) * 60_000;
  const good = recorder();
  const r = await check(good.send, { epochMs });
  for (const l of r.lines) console.log(l);
  console.log(r.ok ? "PASS" : "FAIL");
  if (at >= 0) {
    const bad = recorder();
    const b = await check(bad.send, { pins: BEFORE, txOf: (n) => BEFORE[n].tx, epochMs });
    for (const l of b.lines) console.log(`bad run: ${l}`);
    writeFileSync(argv[at + 1], JSON.stringify({ key: KEY, recorded: new Date().toISOString(), epochMs, good: { ok: r.ok, log: good.log }, bad: { ok: b.ok, log: bad.log } }, null, 1) + "\n");
  }
  return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`error: ${e?.stack ?? e}`), process.exit(2)));
