#!/usr/bin/env node
// Live check of card pool-evm-deploy-mainnet: the EVM pool, its adapters and the sell delegate run on Base and
// Robinhood mainnet with no owner and no proxy, and the kit pins them. For each mainnet of pool-evm-deploy.mjs MAINNETS:
//   - its record, contracts/pool-evm/deployments/<chain>.json, exists and is a real run (the owner's paste,
//     contracts/pool-evm/script/mainnet-deploy.sh; evm-venues-pin.mjs recordOf refuses a dry run's);
//   - pool-evm-deploy.mjs's check of it on the chain's two RPCs of two operators passes: each contract's code is the
//     build's, no owner() answers, no EIP-1967 slot is set, the PoolManager's, the router's and WETH's code hashes (and
//     Robinhood WETH's implementation) are the pinned ones, and the run key sent exactly the record's transactions and
//     keeps at most DUST;
//   - evm-venues-pin.mjs's check of the kit's venue for it (evmPoolVenues(), through the kit's public entry) passes:
//     the pool, v3 and v4 adapter and sell delegate pins are the record's, each the build's code with the right
//     immutables on both RPCs at the newest block both have.
//   node scripts/live-checks/pool-evm-deploy-mainnet.mjs [--record <file>]     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every RPC answer read to <file>, for the test's replay (pool-evm-deploy-mainnet.answers.json).
// Runs: once, a contract deploy's read-back on Base and Robinhood mainnet, after the owner's paste on each chain; no host deploy changes the contracts, and the kit's pins move only with a card that redeploys one
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { check as pinCheck, recordOf } from "./evm-venues-pin.mjs";
import { MAINNETS, check as deployCheck, recorder } from "./pool-evm-deploy.mjs";

const KEY = "pool-evm-deploy-mainnet";

/** Every mainnet's lines and verdict. `read(chain)` is its record or null; `rpcsOf(chain)` its two RPCs. */
export async function checkMainnets({ read = (c) => recordOf(c), venues = evmPoolVenues(), fetchFn = fetch, rpcsOf = (c) => MAINNETS[c].rpcs, sleep } = {}) {
  const lines = [];
  let ok = true;
  for (const chain of Object.keys(MAINNETS)) {
    const say = (pass, text) => {
      ok &&= pass;
      lines.push(`${chain}: ${pass ? "PASS" : "FAIL"} ${text}`);
    };
    let d;
    try {
      d = read(chain);
    } catch (e) {
      say(false, String(e.message).split("\n")[0]);
      continue;
    }
    if (!d) {
      say(false, `no record: the owner's paste has not run: sh contracts/pool-evm/script/mainnet-deploy.sh ${chain} <address>`);
      continue;
    }
    const rpcs = rpcsOf(chain);
    const a = await deployCheck({ deployment: d, fetchFn, rpcs, ...(sleep ? { sleep } : {}) });
    for (const l of a.lines) lines.push(`${chain}: deploy ${l}`);
    say(a.ok, `the deploy record's check on ${rpcs.join(" and ")}`);
    const venue = venues[chain];
    if (!venue) {
      say(false, "the kit lists no venue for it");
      continue;
    }
    const b = await pinCheck({ chain, venue, deployment: d, fetchFn, rpcs, sleep });
    for (const l of b.lines) lines.push(`${chain}: kit pin ${l}`);
    say(b.ok, `the kit's pins are the record's on ${rpcs.join(" and ")}`);
  }
  return { ok, lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const rec = recorder();
    const r = await checkMainnets({ fetchFn: opt("--record") ? rec.fetchFn : fetch });
    for (const l of r.lines) console.log(`live-check ${KEY} ${l}`);
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers) + "\n");
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
