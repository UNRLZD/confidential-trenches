#!/usr/bin/env node
// Live check of card evm-testnet-delegate-review3: the testnet pools sell through the SellDelegate at the pool-review-3
// build (the 11-field Sell the kit, the signing page and the helper build, its fee paid to the Sell's feeRecipient),
// redeployed alone (contracts/pool-evm/script/deploy.mjs --only SellDelegate) on Base Sepolia and Robinhood testnet and
// pinned by the kit. For each redeploy (evm-testnet-delegate-review3.<chain>.json), on two RPCs of two operators:
//   - the checks of evm-sell-v4.mjs (its code, both immutables and getters, no admin, the run's transactions, the swept
//     run key) with `current`: its code the current build of pool-evm-deploy.build.json, never one the build file froze
//     (main's pins at the exact-debit delegates held a frozen 10-field build and passed evm-venues-pin);
//   - its code dispatches the 11-field sell the kit signs (PUSH4 0x0c2cb9ca, pool-evm-testnet-run.mjs SELL_SELECTOR)
//     and not the 10-field one (0xbea5695c, SELL_SELECTOR_10), which main's pinned delegates dispatch;
//   - the kit's pinned sellDelegate for the chain is the record's address.
//   node scripts/live-checks/evm-testnet-delegate-review3.mjs [--record <file>] [--write-record]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes { notes, rpcs, deployments, good } to <file> (evm-testnet-delegate-review3.answers.json, which the
// test replays with its recorded bad answers, main's pins); --write-record, on PASS, writes the run record
// evm-testnet-delegate-review3.md (Money path: yes, one Tx line per transaction of the redeploys and their fundings).
// Runs: once, a contract deploy read back on chain, and after any card that moves the kit's testnet sell delegate pins
import "../net-window.mjs";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { check as sellCheck, runRecordFor } from "./evm-sell-v4.mjs";
import { recorder as deployRecorder, rpc } from "./pool-evm-deploy.mjs";
import { SELL_SELECTOR, SELL_SELECTOR_10 } from "./pool-evm-testnet-run.mjs";

export const KEY = "evm-testnet-delegate-review3";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CHAINS = Object.freeze(["base-sepolia", "robinhood-testnet"]);
export const deployFile = (c) => path.join(HERE, `${KEY}.${c}.json`);
const RUN_RECORD = path.join(HERE, `${KEY}.md`);
// The fundings of the redeploys' run keys from the team's testnet wallet E (scripts/devwallet/devwallet-evm.mjs,
// research repo), each
// read back as succeeded on both of its chain's RPCs, 6 Nov 17:04Z
export const FUNDINGS = Object.freeze({
  "base-sepolia": "0xe8d66aff401710d088505b78efdaae4fc9c485f26b901cd08d0fa678e545c54c",
  "robinhood-testnet": "0x372530f30ff7b2f84c7d368e24b1c991e9f05389ade7ec7b8e2145b1517052fa",
});
const push4 = (sel) => `63${sel.slice(2)}`;

/** evm-sell-v4's check with `current` (the build, never a frozen one), plus: the code at the record's address dispatches
 *  the 11-field sell and not the 10-field one on both RPCs, and the kit pins that address */
export async function check(o) {
  const r = await sellCheck({ ...o, current: true });
  const a = String(o.deployment?.contracts?.SellDelegate?.address ?? "").toLowerCase();
  let ok = r.ok;
  for (const url of (o.rpcs ?? []).slice(0, 2)) {
    let pass = false;
    let said = "";
    try {
      const code = String(await rpc(o.fetchFn, url, "eth_getCode", [a, "latest"], o.sleep)).toLowerCase();
      const has11 = code.includes(push4(SELL_SELECTOR));
      const has10 = code.includes(push4(SELL_SELECTOR_10));
      pass = has11 && !has10;
      said = `${SELL_SELECTOR} ${has11 ? "dispatched" : "absent"}, ${SELL_SELECTOR_10} ${has10 ? "dispatched" : "absent"}`;
    } catch (e) {
      said = String(e.message).split("\n")[0];
    }
    r.lines.push(`${pass ? "ok  " : "FAIL"} SellDelegate ${a} dispatches the 11-field sell the kit signs, not the 10-field one, on ${url}: ${said}`);
    ok &&= pass;
  }
  const venues = o.venues ?? evmPoolVenues();
  const pin = Object.hasOwn(venues, o.deployment?.chain) ? venues[o.deployment.chain].sellDelegate : undefined;
  const pinned = !!pin && pin.toLowerCase() === a;
  r.lines.push(`${pinned ? "ok  " : "FAIL"} the kit pins SellDelegate ${a} on ${o.deployment?.chain}: ${pin ?? "none"}`);
  return { ok: ok && pinned, lines: r.lines };
}

/** The run record: runRecordFor's (each redeploy's deploy and sweep), with each run key's funding from E */
export function runRecord(ds) {
  const head = runRecordFor(KEY, ds).split("\n");
  const fund = ds.map((d) => `Tx: ${d.chain} ${FUNDINGS[d.chain]}`);
  const i = head.findIndex((l) => l === "");
  const notes = ds.map((d) => `${d.chain}: the run key ${d.deployer} was funded from the team's testnet wallet E (0x49f2425b7f33f3a10912de8add6839226ce663a2) by ${FUNDINGS[d.chain]}, read back as succeeded on both RPCs.`);
  return [...head.slice(0, i), ...fund, ...head.slice(i), ...notes, ""].join("\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const out = { notes: [], rpcs: {}, deployments: {}, good: {} };
    let ok = true;
    for (const c of CHAINS) {
      if (!existsSync(deployFile(c))) throw new Error(`no record ${path.basename(deployFile(c))}`);
      const d = JSON.parse(readFileSync(deployFile(c), "utf8"));
      const rec = deployRecorder();
      const { CHAINS: DEPLOYED } = await import("./pool-evm-deploy.mjs");
      const r = await check({ deployment: d, fetchFn: rec.fetchFn, rpcs: DEPLOYED[c].rpcs });
      for (const l of r.lines) console.log(`live-check ${KEY} ${c}: ${l}`);
      ok &&= r.ok;
      Object.assign(out.deployments, { [c]: d });
      Object.assign(out.rpcs, { [c]: DEPLOYED[c].rpcs.slice(0, 2) });
      Object.assign(out.good, { [c]: rec.answers });
    }
    if (opt("--record")) {
      out.notes.push(`Recorded ${new Date().toISOString()} by: node scripts/live-checks/${KEY}.mjs --record; the redeploys at the kit's pins.`);
      writeFileSync(opt("--record"), JSON.stringify(out) + "\n");
    }
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"}`);
    if (ok && args.includes("--write-record")) {
      writeFileSync(RUN_RECORD, runRecord(CHAINS.map((c) => out.deployments[c])));
      console.log(`live-check ${KEY}: wrote ${path.relative(process.cwd(), RUN_RECORD)}`);
    }
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
