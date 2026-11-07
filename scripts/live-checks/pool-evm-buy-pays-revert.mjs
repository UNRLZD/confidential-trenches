#!/usr/bin/env node
// Live check of card pool-evm-buy-pays-revert: the pool the owner's paste deployed on each mainnet runs the reviewed
// build, the one whose buy pays its fee and never reverts when its swap fails (contracts/pool-evm/NOTICE change 18).
// For each mainnet of pool-evm-deploy.mjs MAINNETS:
//   - its record, contracts/pool-evm/deployments/<chain>.json, exists and is a real run (evm-venues-pin.mjs recordOf
//     refuses a dry run's); no record: FAIL, the paste has not run;
//   - the record's PrivacyPoolSimple holds the same code on the chain's two RPCs of two operators, byte for byte;
//   - that code is the current build in pool-evm-deploy.build.json (`contracts`, never a frozen one): its length and its
//     keccak256 with every immutable's bytes zeroed, the build this card's review read;
//   - and it dispatches buySwap((address,bytes,uint256,address),address,uint256) (PUSH4 0x25faf2a3), the buy's
//     self-call, which the pool before this card lacks.
//   node scripts/live-checks/pool-evm-buy-pays-revert.mjs [--record <file>]   PASS exit 0, FAIL 1, error 2
// --record writes every RPC answer read to <file>, for the test's replay (pool-evm-buy-pays-revert.answers.json).
// Runs: once, after the owner's mainnet paste on each chain (the pool has no upgrade path, so its code never changes)
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordOf } from "./evm-venues-pin.mjs";
import { BUILD, MAINNETS, recorder, rpc, runtimeOf } from "./pool-evm-deploy.mjs";

const KEY = "pool-evm-buy-pays-revert";
/** buySwap's selector as PUSH4 (0x63) in the runtime's dispatcher */
export const BUY_SWAP_PUSH4 = "6325faf2a3";

/** Every mainnet's lines and verdict. `read(chain)` is its record or null; `rpcsOf(chain)` its two RPCs. */
export async function check({ read = (c) => recordOf(c), fetchFn = fetch, rpcsOf = (c) => MAINNETS[c].rpcs, build = BUILD.contracts.PrivacyPoolSimple, sleep } = {}) {
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
    const pool = d?.contracts?.PrivacyPoolSimple?.address;
    if (!d || typeof pool !== "string") {
      say(false, `no record of the pool: the owner's paste has not run: sh contracts/pool-evm/script/mainnet-deploy.sh ${chain} <address>`);
      continue;
    }
    const rpcs = rpcsOf(chain);
    const codes = [];
    for (const url of rpcs) {
      try {
        codes.push(String(await rpc(fetchFn, url, "eth_getCode", [pool, "latest"], ...(sleep ? [sleep] : []))).toLowerCase());
      } catch (e) {
        codes.push(null);
        say(false, `the pool ${pool}'s code could not be read on ${url}: ${String(e.message).split("\n")[0]}`);
      }
    }
    if (codes.some((c) => c === null)) continue;
    say(codes.length === 2 && codes[0] === codes[1], `the pool ${pool} holds the same code on ${rpcs.join(" and ")}`);
    const r = runtimeOf(codes[0], build.immutables);
    say(r.length === build.length && r.masked === build.masked, `the pool ${pool} is the reviewed build: length ${r.length} (build ${build.length}), keccak256 with the immutables zeroed ${r.masked} (build ${build.masked})`);
    say(codes[0].includes(BUY_SWAP_PUSH4), `the pool ${pool} dispatches buySwap (0x25faf2a3): a buy whose swap fails pays out`);
  }
  return { ok, lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const rec = recorder();
    const r = await check({ fetchFn: opt("--record") ? rec.fetchFn : fetch });
    for (const l of r.lines) console.log(`live-check ${KEY} ${l}`);
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers) + "\n");
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
