#!/usr/bin/env node
// Live check for card evm-mainnet-senders: the owner's one mainnet EVM paste per chain deploys the FeeCollector with
// the set, its sink the helper box's own mainnet sell sender. For Base and Robinhood mainnet:
//   - the kit pins the chain's sell sender (evmPoolVenues().sellSender): a lowercase address, not zero, apart from the
//     other mainnet's and from both testnets' pins (each network its own key, made on the box by the research repo's
//     scripts/deploy/evm-sender-key.mjs, which printed only the address);
//   - the paste's plan deploys FeeCollector with the set (pool-evm-deploy.mjs MAINNETS contracts), and its sink is that
//     pin (deploy.mjs sinkOf reads the same field, and refuses the paste before any key with none);
//   - each of the chain's two RPCs of two operators answers the chain's id, and the pin has no code on it (an EIP-7702 delegation there would run inside every
//     fee the collector forwards);
//   - once the paste has written contracts/pool-evm/deployments/<chain>.json: its FeeCollector's sink is the pin, the
//     collector's runtime on both RPCs is the build's with that one word at its immutable, and a kit feeCollector pin,
//     where there is one, is the record's address. Before the paste a chain's line says so and passes.
//   node scripts/live-checks/evm-mainnet-senders.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2. --record writes { notes, rpcs, good } (evm-mainnet-senders.answers.json):
//     every RPC answer read, the shape evm-mainnet-senders.test.mjs replays.
// Runs: once, a read of the kit's mainnet sell sender pins and of each owner paste's record and collector on chain; no host deploy changes them
import "../net-window.mjs";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { MAINNETS, deploymentFile, pinnedBuild, recorder, rpc, runtimeOf } from "./pool-evm-deploy.mjs";

export const KEY = "evm-mainnet-senders";
export const CHAIN_NAMES = Object.freeze(["base", "robinhood"]);
const TESTNETS = Object.freeze(["base-sepolia", "robinhood-testnet"]);
const ADDRESS = /^0x[0-9a-f]{40}$/;
const lower = (s) => String(s ?? "").toLowerCase();
const addrWord = (a) => "0x" + lower(a).replace(/^0x/, "").padStart(64, "0");
const pinOf = (venues, chain) => {
  const v = Object.hasOwn(venues, chain) ? venues[chain] : undefined;
  return v !== undefined && Object.hasOwn(v, "sellSender") ? lower(v.sellSender) : "";
};

/**
 * Each mainnet's pin, plan and (after its paste) record. `venues` is the kit's list, `plans` pool-evm-deploy.mjs
 * MAINNETS, `records` each chain's deployment record or undefined before its paste.
 */
export async function check({ venues = evmPoolVenues(), plans = MAINNETS, records = {}, fetchFn = fetch, rpcsOf = (c) => MAINNETS[c].rpcs, sleep }) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${text}`);
  };
  const pins = Object.fromEntries([...CHAIN_NAMES, ...TESTNETS].map((c) => [c, pinOf(venues, c)]));
  for (const chain of CHAIN_NAMES) {
    const pin = pins[chain];
    const others = Object.entries(pins).filter(([c, p]) => c !== chain && p !== "");
    say(ADDRESS.test(pin) && !/^0x0{40}$/.test(pin), `${chain}: the kit pins a sell sender: ${pin || "none"}`);
    say(!others.some(([, p]) => p === pin), `${chain}: its pin is its own, no other network's (${others.map(([c, p]) => `${c} ${p}`).join(", ") || "none other"})`);
    const contracts = plans[chain]?.contracts ?? [];
    say(contracts.at(-1) === "FeeCollector" && contracts.filter((n) => n === "FeeCollector").length === 1, `${chain}: the paste deploys FeeCollector with the set, its sink the pin: ${contracts.join(", ")}`);
    if (!ADDRESS.test(pin)) continue;
    // each RPC answers the chain's id before any code is read on it; one that does not is read no further
    const rpcs = [];
    for (const url of rpcsOf(chain).slice(0, 2)) {
      const on = `on ${new URL(url).host}`;
      try {
        const id = await rpc(fetchFn, url, "eth_chainId", [], sleep);
        say(id === plans[chain]?.chainId, `${chain}: chain id ${id} is ${chain}'s ${plans[chain]?.chainId} ${on}`);
        if (id === plans[chain]?.chainId) rpcs.push(url);
      } catch (e) {
        say(false, `${chain}: the chain id read ${on}: ${String(e.message).split("\n")[0]}`);
      }
    }
    for (const url of rpcs) {
      const on = `on ${new URL(url).host}`;
      try {
        const code = await rpc(fetchFn, url, "eth_getCode", [pin, "latest"], sleep);
        say(code === "0x", `${chain}: the pin ${pin} has no code (no EIP-7702 delegation) ${on}: ${code === "0x" ? "none" : String(code).slice(0, 50)}`);
      } catch (e) {
        say(false, `${chain}: the pin's code read ${on}: ${String(e.message).split("\n")[0]}`);
      }
    }
    const d = records[chain];
    if (d === undefined) {
      say(true, `${chain}: no deployment record yet (the owner's paste has not run): the collector is read once it has`);
      continue;
    }
    const at = lower(d.contracts?.FeeCollector?.address);
    const sink = lower(d.contracts?.FeeCollector?.sink);
    say(d.chain === chain && ADDRESS.test(at), `${chain}: the record holds a FeeCollector: ${at || "none"}`);
    say(sink === pin, `${chain}: the record's FeeCollector sink is the pin: ${sink || "none"}`);
    const kitCollector = Object.hasOwn(venues[chain] ?? {}, "feeCollector") ? lower(venues[chain].feeCollector) : "";
    say(kitCollector === "" || kitCollector === at, `${chain}: the kit's feeCollector pin is the record's: ${kitCollector || "none pinned yet"}`);
    if (!ADDRESS.test(at)) continue;
    const b = pinnedBuild(chain, "FeeCollector", at);
    for (const url of rpcs) {
      const on = `on ${new URL(url).host}`;
      try {
        const code = await rpc(fetchFn, url, "eth_getCode", [at, "latest"], sleep);
        const r = runtimeOf(code, b.immutables);
        const held = r.words.flat();
        say(r.length === b.length && r.masked === b.masked && held.length === 1 && held[0] === addrWord(pin), `${chain}: FeeCollector ${at} is the build's code with the pin at its immutable ${on}: ${r.length} bytes, ${held.join(", ") || "no word"}`);
      } catch (e) {
        say(false, `${chain}: the collector's code read ${on}: ${String(e.message).split("\n")[0]}`);
      }
    }
  }
  return { ok, lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const records = Object.fromEntries(CHAIN_NAMES.filter((c) => existsSync(deploymentFile(c))).map((c) => [c, JSON.parse(readFileSync(deploymentFile(c), "utf8"))]));
    const rec = recorder();
    const r = await check({ records, fetchFn: opt("--record") ? rec.fetchFn : fetch });
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    if (opt("--record")) {
      const out = { notes: [`Recorded ${new Date().toISOString()} by: node scripts/live-checks/${KEY}.mjs --record; the kit's pins at this commit, ${Object.keys(records).length} mainnet record(s).`], rpcs: Object.fromEntries(CHAIN_NAMES.map((c) => [c, MAINNETS[c].rpcs.slice(0, 2)])), records, good: rec.answers };
      writeFileSync(opt("--record"), JSON.stringify(out) + "\n");
    }
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: error: ${e.message}`);
    process.exit(2);
  }
}
