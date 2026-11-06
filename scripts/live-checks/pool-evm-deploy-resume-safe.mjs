#!/usr/bin/env node
// Live check of card pool-evm-deploy-resume-safe: an EVM pool deploy (contracts/pool-evm/script/deploy.mjs) paid for
// each contract once and left nothing on its run key. For each chain's deployment record (pool-evm-deploy.<chain>.json
// on the testnets, contracts/pool-evm/deployments/<chain>.json on a mainnet once deployed), on the chain's two RPCs, each
// read at its own head block, which must be at or past the block of every transaction the record lists:
//   - each contract the record names was made by exactly one of its deploys, whose receipt succeeded and made that
//     address, and its address holds code at that block: no contract was deployed twice;
//   - the run key sent exactly the record's transactions (its nonce at that block) and keeps at most DUST wei there, so
//     no transfer to it is left behind.
//   node scripts/live-checks/pool-evm-deploy-resume-safe.mjs [--deployment <file>[,<file>]] [--rpc <url>,<url>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every RPC answer read to <file>, for the test's replay (pool-evm-deploy-resume-safe.answers.json).
// Runs: after every EVM pool deploy (testnet or mainnet) and its --sweep-kept; no host deploy changes it
import "../net-window.mjs";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHAINS, DUST, MAINNETS, chainOf, deploymentFile, recorder, rpc } from "./pool-evm-deploy.mjs";

const KEY = "pool-evm-deploy-resume-safe";
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export async function check({ deployment: d, fetchFn = fetch, rpcs, sleep = sleepMs }) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${text}`);
  };
  const chain = chainOf(d.chain);
  if (!chain) {
    say(false, `the record's chain is one of ${[...Object.keys(CHAINS), ...Object.keys(MAINNETS)].join(", ")}: ${d.chain}`);
    return { ok, lines };
  }
  rpcs ??= chain.rpcs;
  say(rpcs.length >= 2 && new Set(rpcs.slice(0, 2)).size === 2, `two RPCs: ${rpcs.join(", ")}`);
  const deployer = String(d.deployer ?? "").toLowerCase();
  const txs = d.txs ?? [];
  const names = Object.keys(d.contracts ?? {});
  say(names.length > 0 && txs.length > 0, `the record names ${names.length} contract(s) and ${txs.length} transaction(s)`);
  for (const n of names) {
    const deploys = txs.filter((t) => t.step === `deploy ${n}`);
    say(deploys.length === 1 && deploys[0].contract === n, `${n} is made by exactly one deploy of the record: ${deploys.length}`);
  }
  for (const url of rpcs.slice(0, 2)) {
    const on = `on ${url}`;
    try {
      const id = await rpc(fetchFn, url, "eth_chainId", [], sleep);
      say(id === chain.chainId, `chain id ${id} is ${d.chain}'s ${chain.chainId} ${on}`);
      let last = 0n;
      for (const t of txs) {
        const rc = await rpc(fetchFn, url, "eth_getTransactionReceipt", [t.hash], sleep);
        const made = t.contract ? String(d.contracts?.[t.contract]?.address ?? "").toLowerCase() : null;
        say(!!rc && rc.status === "0x1" && rc.from?.toLowerCase() === deployer && (made === null || rc.contractAddress?.toLowerCase() === made),
          `${t.step} ${t.hash} landed from the run key${made ? ` and made ${made}` : ""} ${on}${rc ? `: block ${BigInt(rc.blockNumber)}, status ${rc.status}` : ": no receipt"}`);
        if (rc?.blockNumber != null && BigInt(rc.blockNumber) > last) last = BigInt(rc.blockNumber);
      }
      const head = BigInt(await rpc(fetchFn, url, "eth_blockNumber", [], sleep));
      say(head >= last, `head block ${head} is at or past the record's last transaction's block ${last} ${on}`);
      const tag = "0x" + head.toString(16);
      for (const n of names) {
        const a = String(d.contracts[n].address).toLowerCase();
        const code = await rpc(fetchFn, url, "eth_getCode", [a, tag], sleep);
        say(code !== "0x", `${n} ${a} holds code at block ${head} ${on}: ${(code.length - 2) / 2} bytes`);
      }
      const nonce = BigInt(await rpc(fetchFn, url, "eth_getTransactionCount", [deployer, tag], sleep));
      const bal = BigInt(await rpc(fetchFn, url, "eth_getBalance", [deployer, tag], sleep));
      say(nonce === BigInt(txs.length) && bal <= DUST,
        `run key ${deployer} sent exactly the record's ${txs.length} transactions and keeps at most ${DUST} wei at block ${head} ${on}: nonce ${nonce}, ${bal} wei`);
    } catch (e) {
      say(false, `read ${on}: ${String(e.message).split("\n")[0]}`);
    }
  }
  return { ok, lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const files = opt("--deployment") ? opt("--deployment").split(",") : [...Object.keys(CHAINS), ...Object.keys(MAINNETS)].map(deploymentFile).filter(existsSync);
    if (files.length === 0) throw new Error("no deployment record (pool-evm-deploy.<chain>.json) to check");
    const ds = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
    const rec = recorder();
    let ok = true;
    for (const d of ds) {
      const rpcs = opt("--rpc") && ds.length === 1 ? opt("--rpc").split(",") : undefined;
      const r = await check({ deployment: d, rpcs, fetchFn: opt("--record") ? rec.fetchFn : fetch });
      for (const l of r.lines) console.log(`live-check ${KEY} ${d.chain}: ${l}`);
      ok &&= r.ok;
    }
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers) + "\n");
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
