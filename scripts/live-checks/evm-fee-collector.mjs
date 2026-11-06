#!/usr/bin/env node
// Live check of card evm-fee-collector: a sell's fee to the server is proven by a log only a real payment makes. The fee
// collector (contracts/pool-evm/src/FeeCollector.sol) deployed alone (contracts/pool-evm/script/deploy.mjs --only
// FeeCollector) on Base Sepolia and Robinhood testnet, its sink the network's server sell sender, and a real sell that
// paid it.
// For each chain's record (evm-fee-collector.<chain>.json), on two RPCs of two operators, each answering the chain's id:
//   - the collector's code is the FeeCollector build pinned to its address (pool-evm-deploy.build.json, pinnedBuild):
//     the same length and, with its one immutable's bytes zeroed, the same keccak256; the immutable holds one word, the
//     record's sink; and the record's sink is the sell sender the kit pins for the chain (evmPoolVenues().sellSender)
//     and has no code (an EIP-7702 delegation there would run inside every sell, and the sink cannot change);
//   - no admin: the EIP-1967 implementation, admin and beacon slots are 0, and owner() reverts (the collector has no
//     function at all, so any calldata does);
//   - every transaction of the run succeeded, was sent by the record's deployer, and the deploy made the record's address;
//   - the deployer has no code, a nonce equal to the transactions it sent, and at most DUST wei left.
// And each sell in evm-fee-collector.sells.json ({ sells: [{ chain, hash, w, fee }] }), on the same two RPCs: the
// transaction is a type 4 transaction to W whose input is SellDelegate.sell(Sell, fee, signature), sent by the sell
// sender the kit pins, with the Sell's feeRecipient the chain's collector and its fee the row's; its receipt succeeded
// and carries exactly one Paid(W, value) from the collector, value equal to that fee. A row naming a chain with no
// collector record fails, unless --deployment left that chain out (the rows left out are printed). None listed is
// "0 sells listed", ok: no EVM sell lands until the
// testnets run the 11-field SellDelegate (card evm-testnet-delegate-review3, which lists its real sells and makes
// one per chain required).
//   node scripts/live-checks/evm-fee-collector.mjs [--deployment <file>[,<file>]] [--rpc <url>,<url>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2. With no --deployment it reads both chains' records; --rpc applies to a
//     single record (a dry run's loopback fork), and its sells are read there too.
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
/** SellDelegate.sell's selector (contracts/pool-evm/src/SellDelegate.sol, the 11-field Sell) */
export const SELL_SELECTOR = selector("sell((address,uint256,address,bytes,uint256,address,uint256,uint256,address,uint256,uint256),uint256,bytes)");

/** The fee and the Sell's feeRecipient of SellDelegate.sell calldata, or null when `input` is no sell call */
export function sellArgs(input) {
  const h = lower(input);
  if (!h.startsWith(SELL_SELECTOR) || !/^0x[0-9a-f]*$/.test(h) || (h.length - 10) % 64 !== 0) return null;
  const words = h.slice(10).match(/.{64}/g) ?? [];
  const at = (i) => (i < words.length ? BigInt("0x" + words[i]) : null);
  const off = at(0);
  if (off === null || off % 32n !== 0n) return null;
  const base = Number(off / 32n);
  const recipient = at(base + 8);
  const fee = at(1);
  if (fee === null || recipient === null || recipient >> 160n !== 0n) return null;
  return { fee, feeRecipient: "0x" + recipient.toString(16).padStart(40, "0") };
}

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
      if (ADDRESS.test(sink)) {
        const sc = await rpc(fetchFn, url, "eth_getCode", [sink, "latest"], sleep);
        say(sc === "0x", `the sink ${sink} has no code (no EIP-7702 delegation) ${on}: ${sc === "0x" ? "none" : sc.slice(0, 50)}`);
      }
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

/** The rows the run judges: every one, but, when --deployment narrowed the run (`narrowed`), a row for a known chain whose
 * record it left out, which is returned in `leftOut` to be printed. A row for an unknown chain or a typo is judged, and
 * fails */
export function sellsFor(sells, collectors, narrowed) {
  const leftOut = narrowed && Array.isArray(sells) ? sells.filter((s) => Object.hasOwn(CHAINS, s?.chain) && !Object.hasOwn(collectors, s.chain)) : [];
  return { judged: Array.isArray(sells) ? sells.filter((s) => !leftOut.includes(s)) : sells, leftOut };
}

/** Each sell on two RPCs: W's type 4 SellDelegate.sell from the kit's pinned sell sender, paying the chain's collector
 * the row's fee, whose receipt succeeded with exactly one Paid(W, that fee) from the collector (`collectors`: chain =>
 * the record's collector address) */
export async function checkSells({ sells, collectors, fetchFn = fetch, rpcsOf = (c) => CHAINS[c]?.rpcs ?? [], sleep, venues = evmPoolVenues() }) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${text}`);
  };
  say(Array.isArray(sells), `${Array.isArray(sells) ? sells.length : "no list of"} sells listed`);
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
    const sender = Object.hasOwn(venues, s.chain) ? lower(venues[s.chain].sellSender) : "";
    if (!ADDRESS.test(at) || !ADDRESS.test(w) || fee <= 0n || !ADDRESS.test(sender)) {
      say(false, `${tag} names a chain with a collector record (${at || "none"}) and a pinned sell sender (${sender || "none"}), W ${w || "none"} and a fee above 0 (${s.fee})`);
      continue;
    }
    const rpcs = rpcsOf(s.chain);
    if (rpcs.length < 2) say(false, `${tag} two RPCs for ${s.chain}: ${rpcs.length}`);
    for (const url of rpcs.slice(0, 2)) {
      const on = `on ${url}`;
      try {
        const tx = await rpc(fetchFn, url, "eth_getTransactionByHash", [s.hash], sleep);
        say(!!tx && tx.type === "0x4" && lower(tx.to) === w, `${tag} is a type 4 transaction to W ${w} ${on}: ${tx ? `type ${tx.type}, to ${tx.to}` : "no transaction"}`);
        say(!!tx && lower(tx.from) === sender, `${tag} was sent by the sell sender the kit pins on ${s.chain}, ${sender} ${on}: ${tx ? tx.from : "no transaction"}`);
        const args = sellArgs(tx?.input);
        say(!!args && args.feeRecipient === at && args.fee === fee,
          `${tag} is SellDelegate.sell paying the collector ${at} the row's fee ${fee} ${on}: ${args ? `feeRecipient ${args.feeRecipient}, fee ${args.fee}` : `input ${String(tx?.input ?? "none").slice(0, 10)} is no sell`}`);
        const rc = await rpc(fetchFn, url, "eth_getTransactionReceipt", [s.hash], sleep);
        const paid = (rc?.logs ?? []).filter((l) => lower(l.address) === at && lower(l.topics?.[0]) === PAID);
        const ours = paid.length === 1 ? paid[0] : null;
        const value = ours && /^0x[0-9a-f]{64}$/i.test(ours.data) ? BigInt(ours.data) : -1n;
        say(!!rc && rc.status === "0x1", `${tag} succeeded ${on}: ${rc ? `status ${rc.status}` : "no receipt"}`);
        say(!!ours && ours.topics.length === 2 && lower(ours.topics[1]) === addrWord(w) && value === fee,
          `${tag} carries one Paid(W ${w}, ${fee}) from the collector ${at} ${on}: ${paid.length} Paid${ours ? `, from ${ours.topics[1]}, value ${value}` : ""}`);
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
    const files = opt("--deployment") ? opt("--deployment").split(",") : Object.keys(CHAINS).map(recordFile);
    const ds = files.map((f) => {
      if (!existsSync(f)) throw new Error(`no record ${path.basename(f)}`);
      return JSON.parse(readFileSync(f, "utf8"));
    });
    const rpcOpt = opt("--rpc") && ds.length === 1 ? opt("--rpc").split(",") : undefined;
    const sells = existsSync(SELLS_FILE) ? JSON.parse(readFileSync(SELLS_FILE, "utf8")).sells : [];
    const rec = recorder();
    const fetchFn = opt("--record") ? rec.fetchFn : fetch;
    const out = { notes: [], rpcs: {}, deployments: {}, sells, good: {} };
    let ok = true;
    for (const d of ds) {
      const rpcs = rpcOpt ?? CHAINS[d.chain]?.rpcs ?? [];
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
    const { judged, leftOut } = sellsFor(sells, collectors, !!opt("--deployment"));
    for (const s of leftOut) console.log(`live-check ${KEY}: --deployment leaves out the ${s.chain} sell ${s.hash}`);
    const r = await checkSells({ sells: judged, collectors, fetchFn, ...(rpcOpt ? { rpcsOf: () => rpcOpt } : {}) });
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
