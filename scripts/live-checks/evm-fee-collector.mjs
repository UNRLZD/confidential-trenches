#!/usr/bin/env node
// Live check of card evm-fee-collector: a sell's fee to the server is proven by a log only a real payment makes. The fee
// collector (contracts/pool-evm/src/FeeCollector.sol) deployed alone (contracts/pool-evm/script/deploy.mjs --only
// FeeCollector) on Base Sepolia and Robinhood testnet, its sink the network's server sell sender, and a real sell that
// paid it.
// For each chain's record (evm-fee-collector.<chain>.json), on two RPCs of two operators, each answering the chain's id:
//   - the collector's code is the FeeCollector build pinned to its address (pool-evm-deploy.build.json, pinnedBuild):
//     the same length and, with its one immutable's bytes zeroed, the same keccak256; the immutable holds one word, the
//     record's sink; and the record's sink is the sell sender the kit pins for the chain (evmPoolVenues().sellSender);
//   - no admin: the EIP-1967 implementation, admin and beacon slots are 0, and owner() reverts (the collector has no
//     function at all, so any calldata does);
//   - every transaction of the run succeeded, was sent by the record's deployer, and the deploy made the record's address;
//   - the deployer has no code, a nonce equal to the transactions it sent, and at most DUST wei left.
// And each sell in evm-fee-collector.sells.json ({ sells: [{ chain, hash, w, fee }] }), on the same two RPCs: the
// transaction is a type 4 sell sent to W, its receipt succeeded and carries exactly one Paid(W, value) from the chain's
// collector, with value at least the sell's fee. At least one sell must be listed.
//   node scripts/live-checks/evm-fee-collector.mjs [--record <file>]   PASS exit 0, FAIL exit 1, error exit 2
// --record writes { notes, rpcs, deployments, sells, good } to <file> (evm-fee-collector.answers.json): every RPC answer
// read, the shape evm-fee-collector.test.mjs replays.
// Runs: once, a contract deploy and a sell's receipt read back on chain (the fee collector on two EVM testnets); no host deploy changes them
import "../net-window.mjs";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { CHAINS, DUST, EIP1967, keccak, operatorProblems, pinnedBuild, recorder, rpc, runtimeOf, selector } from "./pool-evm-deploy.mjs";

export const KEY = "evm-fee-collector";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const recordFile = (chain) => path.join(HERE, `${KEY}.${chain}.json`);
export const SELLS_FILE = path.join(HERE, `${KEY}.sells.json`);
/** keccak256("Paid(address,uint256)"): FeeCollector's one event */
export const PAID = keccak(new TextEncoder().encode("Paid(address,uint256)"));
const ADDRESS = /^0x[0-9a-f]{40}$/;
const lower = (s) => String(s ?? "").toLowerCase();
const addrWord = (a) => "0x" + lower(a).replace(/^0x/, "").padStart(64, "0");

/** The deploy record's check on two RPCs; `venues` is the kit's venue list (its sell sender pins) */
export async function check({ deployment: d, fetchFn = fetch, rpcs, sleep, venues = evmPoolVenues() }) {
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
  const deployer = lower(d.deployer);
  const a = lower(d.contracts?.FeeCollector?.address);
  const sink = lower(d.contracts?.FeeCollector?.sink);
  const names = Object.keys(d.contracts ?? {});
  say(names.length === 1 && ADDRESS.test(a), `the record names FeeCollector alone: ${names.join(", ") || "none"}`);
  const pin = Object.hasOwn(venues, d.chain) ? lower(venues[d.chain].sellSender) : "";
  say(ADDRESS.test(sink) && sink === pin, `the record's sink ${sink || "(none)"} is the sell sender the kit pins on ${d.chain}: ${pin || "none"}`);
  const txs = d.txs ?? [];
  say(txs.filter((t) => t.contract).length === 1 && txs.some((t) => t.contract === "FeeCollector"), `the record lists the run's transactions, one deploy, FeeCollector's: ${txs.map((t) => t.step).join(", ") || "none"}`);
  const b = pinnedBuild(d.chain, "FeeCollector", a);
  say(!!b && b.immutables?.length === 1, `the build file pins FeeCollector with one immutable: ${b ? `${b.immutables?.length} immutable(s)` : "no entry"}`);
  for (const url of rpcs.slice(0, 2)) {
    const on = `on ${url}`;
    try {
      const id = await rpc(fetchFn, url, "eth_chainId", [], sleep);
      say(id === chain.chainId, `chain id ${id} is ${d.chain}'s ${chain.chainId} ${on}`);
      if (a && b) {
        const code = await rpc(fetchFn, url, "eth_getCode", [a, "latest"], sleep);
        const r = runtimeOf(code, b.immutables);
        say(r.length === b.length && r.masked === b.masked,
          `FeeCollector ${a} code is the build's: ${r.length} bytes (build ${b.length}), immutables zeroed keccak256 ${r.masked} (build ${b.masked}) ${on}`);
        const held = r.words.map((w) => (w.length === 1 ? w[0] : `${w.length} words`));
        say(held.length === 1 && held[0] === addrWord(sink), `FeeCollector's immutable holds one word, the record's sink ${sink} ${on}: ${held.join(", ") || "none"}`);
        for (const [slot, s] of Object.entries(EIP1967)) {
          const v = await rpc(fetchFn, url, "eth_getStorageAt", [a, s, "latest"], sleep);
          say(BigInt(v) === 0n, `FeeCollector's EIP-1967 ${slot} slot is 0 ${on}: ${v}`);
        }
        const owner = await rpc(fetchFn, url, "eth_call", [{ to: a, data: selector("owner()") }, "latest"], sleep).then((v) => v, (e) => (e.rpcError ? "reverts" : `error ${e.message}`));
        say(owner === "reverts", `FeeCollector has no owner() (any calldata reverts): ${owner} ${on}`);
      }
      for (const t of txs) {
        const rc = await rpc(fetchFn, url, "eth_getTransactionReceipt", [t.hash], sleep);
        const made = t.contract ? lower(d.contracts?.[t.contract]?.address) : null;
        say(!!rc && rc.status === "0x1" && lower(rc.from) === deployer && (made === null ? !rc.contractAddress : lower(rc.contractAddress) === made),
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

/** Each sell's receipt on two RPCs: a type 4 sell to W that succeeded, with exactly one Paid(W, >= fee) from the
 * chain's collector (`collectors`: chain => the record's collector address) */
export async function checkSells({ sells, collectors, fetchFn = fetch, rpcsOf = (c) => CHAINS[c]?.rpcs ?? [], sleep }) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${text}`);
  };
  say(Array.isArray(sells) && sells.length > 0, `sells listed: ${Array.isArray(sells) ? sells.length : "none"}`);
  for (const s of Array.isArray(sells) ? sells : []) {
    const at = lower(collectors[s.chain]);
    const w = lower(s.w);
    let fee;
    try {
      fee = BigInt(s.fee);
    } catch {
      fee = -1n;
    }
    const tag = `[${s.chain} sell ${s.hash}]`;
    if (!ADDRESS.test(at) || !ADDRESS.test(w) || fee <= 0n) {
      say(false, `${tag} names a chain with a collector record (${at || "none"}), W ${w || "none"} and a fee above 0 (${s.fee})`);
      continue;
    }
    const rpcs = rpcsOf(s.chain);
    if (rpcs.length < 2) say(false, `${tag} two RPCs for ${s.chain}: ${rpcs.length}`);
    for (const url of rpcs.slice(0, 2)) {
      const on = `on ${url}`;
      try {
        const tx = await rpc(fetchFn, url, "eth_getTransactionByHash", [s.hash], sleep);
        say(!!tx && tx.type === "0x4" && lower(tx.to) === w, `${tag} is a type 4 transaction to W ${w} ${on}: ${tx ? `type ${tx.type}, to ${tx.to}` : "no transaction"}`);
        const rc = await rpc(fetchFn, url, "eth_getTransactionReceipt", [s.hash], sleep);
        const paid = (rc?.logs ?? []).filter((l) => lower(l.address) === at && lower(l.topics?.[0]) === PAID);
        const ours = paid.length === 1 ? paid[0] : null;
        const value = ours && /^0x[0-9a-f]{64}$/i.test(ours.data) ? BigInt(ours.data) : -1n;
        say(!!rc && rc.status === "0x1", `${tag} succeeded ${on}: ${rc ? `status ${rc.status}` : "no receipt"}`);
        say(!!ours && ours.topics.length === 2 && lower(ours.topics[1]) === addrWord(w) && value >= fee,
          `${tag} carries one Paid(W ${w}, >= ${fee}) from the collector ${at} ${on}: ${paid.length} Paid${ours ? `, from ${ours.topics[1]}, value ${value}` : ""}`);
      } catch (e) {
        say(false, `${tag} read ${on}: ${String(e.message).split("\n")[0]}`);
      }
    }
  }
  return { ok, lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const ds = Object.keys(CHAINS).map((c) => {
      if (!existsSync(recordFile(c))) throw new Error(`no record ${path.basename(recordFile(c))}`);
      return JSON.parse(readFileSync(recordFile(c), "utf8"));
    });
    const sells = existsSync(SELLS_FILE) ? JSON.parse(readFileSync(SELLS_FILE, "utf8")).sells : [];
    const rec = recorder();
    const fetchFn = opt("--record") ? rec.fetchFn : fetch;
    const out = { notes: [], rpcs: {}, deployments: {}, sells, good: {} };
    let ok = true;
    for (const d of ds) {
      const rpcs = CHAINS[d.chain].rpcs;
      const from = rec.answers.length;
      const r = await check({ deployment: d, rpcs, fetchFn });
      for (const l of r.lines) console.log(`live-check ${KEY} ${d.chain}: ${l}`);
      ok &&= r.ok;
      Object.assign(out.rpcs, { [d.chain]: rpcs.slice(0, 2) });
      Object.assign(out.deployments, { [d.chain]: d });
      Object.assign(out.good, { [d.chain]: rec.answers.slice(from) });
    }
    const from = rec.answers.length;
    const collectors = Object.fromEntries(ds.map((d) => [d.chain, d.contracts?.FeeCollector?.address]));
    const r = await checkSells({ sells, collectors, fetchFn });
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    ok &&= r.ok;
    out.good.sells = rec.answers.slice(from);
    if (opt("--record")) {
      out.notes.push(`Recorded ${new Date().toISOString()} by: node scripts/live-checks/${KEY}.mjs --record; the deployed chains and the sells listed in ${KEY}.sells.json. ${KEY}.test.mjs makes each bad answer from the good ones.`);
      writeFileSync(opt("--record"), JSON.stringify(out) + "\n");
    }
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
