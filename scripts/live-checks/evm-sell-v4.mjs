#!/usr/bin/env node
// Live check of card evm-sell-v4: the sell delegate redeployed alone (contracts/pool-evm/script/deploy.mjs --only
// SellDelegate) on Base Sepolia and Robinhood testnet, the one that sells through the pinned v4 PoolManager.
// For each chain's record (evm-sell-v4.<chain>.json), on two RPCs of two operators, each answering the chain's id:
//   - the delegate's code is the current build's SellDelegate (pool-evm-deploy.build.json `contracts`, which
//     test/deploy.test.mjs keeps equal to forge's output; never the frozen v1 build): the same length and, with the
//     immutables' bytes zeroed, the same keccak256; its two immutables each hold one word, the chain's WETH and v4
//     PoolManager, and WETH() and POOL_MANAGER() return them;
//   - the PoolManager and WETH have the code hash pool-evm-deploy pins (CHAINS);
//   - no admin: the EIP-1967 implementation, admin and beacon slots are 0, and owner() reverts;
//   - every transaction of the run succeeded, was sent by the record's deployer, and the deploy made the record's address;
//   - the deployer has no code, a nonce equal to the transactions it sent, and at most DUST wei left.
//   node scripts/live-checks/evm-sell-v4.mjs [--deployment <file>[,<file>]] [--rpc <url>,<url>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// With no --deployment it checks every chain's record present. --rpc applies to a single record. --record writes
// { notes, rpcs, deployments, good } to <file>: every RPC answer read, with the records and the RPCs they were read on,
// the shape evm-sell-v4.test.mjs replays (evm-sell-v4.answers.json).
import "../net-window.mjs";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD, CHAINS, DUST, EIP1967, keccak, operatorProblems, recorder, rpc, runtimeOf, selector } from "./pool-evm-deploy.mjs";

const KEY = "evm-sell-v4";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const recordFile = (chain) => path.join(HERE, `${KEY}.${chain}.json`);
const addrWord = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

export async function check({ deployment: d, fetchFn = fetch, rpcs, sleep }) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${text}`);
  };
  const chain = CHAINS[d.chain];
  if (!chain) {
    say(false, `the record's chain is one of ${Object.keys(CHAINS).join(", ")}: ${d.chain}`);
    return { ok, lines };
  }
  rpcs ??= chain.rpcs;
  for (const p of operatorProblems(rpcs, d)) say(false, p);
  const deployer = String(d.deployer ?? "").toLowerCase();
  const a = String(d.contracts?.SellDelegate?.address ?? "").toLowerCase();
  const names = Object.keys(d.contracts ?? {});
  say(names.length === 1 && /^0x[0-9a-f]{40}$/.test(a), `the record names SellDelegate alone: ${names.join(", ") || "none"}`);
  const txs = d.txs ?? [];
  say(txs.filter((t) => t.contract).length === 1 && txs.some((t) => t.contract === "SellDelegate"), `the record lists the run's transactions, one deploy, SellDelegate's: ${txs.map((t) => t.step).join(", ") || "none"}`);
  const b = BUILD.contracts.SellDelegate;
  const getters = [["WETH()", addrWord(chain.weth.address)], ["POOL_MANAGER()", addrWord(chain.poolManager.address)]];
  for (const url of rpcs.slice(0, 2)) {
    const on = `on ${url}`;
    try {
      const id = await rpc(fetchFn, url, "eth_chainId", [], sleep);
      say(id === chain.chainId, `chain id ${id} is ${d.chain}'s ${chain.chainId} ${on}`);
      if (a) {
        const code = await rpc(fetchFn, url, "eth_getCode", [a, "latest"], sleep);
        const r = runtimeOf(code, b.immutables);
        say(r.length === b.length && r.masked === b.masked,
          `SellDelegate ${a} code is the current build's: ${r.length} bytes (build ${b.length}), immutables zeroed keccak256 ${r.masked} (build ${b.masked}) ${on}`);
        const held = r.words.map((w) => (w.length === 1 ? w[0] : `${w.length} words`)).sort();
        say(JSON.stringify(held) === JSON.stringify(getters.map(([, w]) => w).sort()),
          `SellDelegate's ${b.immutables.length} immutables each hold one word, the chain's WETH and PoolManager ${on}: ${held.join(", ") || "none"}`);
        for (const [sig, w] of getters) {
          const got = await rpc(fetchFn, url, "eth_call", [{ to: a, data: selector(sig) }, "latest"], sleep).catch((e) => `error ${e.message}`);
          say(got === w, `SellDelegate.${sig} returns ${w} ${on}: ${got}`);
        }
        for (const [slot, s] of Object.entries(EIP1967)) {
          const v = await rpc(fetchFn, url, "eth_getStorageAt", [a, s, "latest"], sleep);
          say(BigInt(v) === 0n, `SellDelegate's EIP-1967 ${slot} slot is 0 ${on}: ${v}`);
        }
        const owner = await rpc(fetchFn, url, "eth_call", [{ to: a, data: selector("owner()") }, "latest"], sleep).then((v) => v, (e) => (e.rpcError ? "reverts" : `error ${e.message}`));
        say(owner === "reverts" || owner === "0x", `SellDelegate has no owner(): ${owner} ${on}`);
      }
      for (const [label, c] of [["PoolManager", chain.poolManager], ["WETH", chain.weth]]) {
        const code = await rpc(fetchFn, url, "eth_getCode", [c.address, "latest"], sleep);
        say(code !== "0x" && keccak(code) === c.codehash, `${label} ${c.address} code hash ${code === "0x" ? "(no code)" : keccak(code)} is the pinned ${c.codehash} ${on}`);
      }
      for (const t of txs) {
        const rc = await rpc(fetchFn, url, "eth_getTransactionReceipt", [t.hash], sleep);
        const made = t.contract ? String(d.contracts?.[t.contract]?.address ?? "").toLowerCase() : null;
        say(!!rc && rc.status === "0x1" && rc.from?.toLowerCase() === deployer && (made === null ? !rc.contractAddress : rc.contractAddress?.toLowerCase() === made),
          `${t.step} ${t.hash} succeeded, from the deployer${made !== null ? `, made ${t.contract} ${made}` : ""} ${on}${rc ? `: status ${rc.status}, from ${rc.from}, contract ${rc.contractAddress ?? "none"}` : ": no receipt"}`);
      }
      const dcode = await rpc(fetchFn, url, "eth_getCode", [deployer, "latest"], sleep);
      const nonce = BigInt(await rpc(fetchFn, url, "eth_getTransactionCount", [deployer, "latest"], sleep));
      const bal = BigInt(await rpc(fetchFn, url, "eth_getBalance", [deployer, "latest"], sleep));
      say(dcode === "0x" && nonce === BigInt(txs.length) && bal <= DUST,
        `deployer ${deployer} has no code, sent exactly the record's ${txs.length} transactions and keeps at most ${DUST} wei ${on}: code ${dcode.length > 2 ? "yes" : "none"}, nonce ${nonce}, ${bal} wei`);
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
    const files = opt("--deployment") ? opt("--deployment").split(",") : Object.keys(CHAINS).map(recordFile).filter(existsSync);
    if (files.length === 0) throw new Error(`no record (${KEY}.<chain>.json) to check`);
    const ds = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
    const rec = recorder();
    const out = { notes: [], rpcs: {}, deployments: {}, good: {} };
    let ok = true;
    for (const d of ds) {
      const rpcs = (opt("--rpc") && ds.length === 1 ? opt("--rpc").split(",") : undefined) ?? CHAINS[d.chain]?.rpcs ?? [];
      const from = rec.answers.length;
      const r = await check({ deployment: d, rpcs, fetchFn: opt("--record") ? rec.fetchFn : fetch });
      for (const l of r.lines) console.log(`live-check ${KEY} ${d.chain}: ${l}`);
      ok &&= r.ok;
      Object.assign(out.rpcs, { [d.chain]: rpcs.slice(0, 2) });
      Object.assign(out.deployments, { [d.chain]: d });
      Object.assign(out.good, { [d.chain]: rec.answers.slice(from) });
    }
    if (opt("--record")) {
      out.notes.push(`Recorded ${new Date().toISOString()} by: node scripts/live-checks/${KEY}.mjs ${args.join(" ")}; ${ds.some((d) => d.dryRun) ? "a dry run (anvil forks, loopback RPCs)" : "the deployed chains"}. The good answers; evm-sell-v4.test.mjs makes each bad answer from them.`);
      writeFileSync(opt("--record"), JSON.stringify(out) + "\n");
    }
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
