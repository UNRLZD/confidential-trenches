#!/usr/bin/env node
// Live check of card evm-selldelegate-exact-debit: the sell delegate with the exact-debit check (SellDelegate.sell
// reverts unless W's balance of the token sold fell by exactly the signed amount, on v3 and v4) redeployed alone
// (contracts/pool-evm/script/deploy.mjs --only SellDelegate) on Base Sepolia and Robinhood testnet, and pinned by the kit.
// For each chain's record (evm-selldelegate-exact-debit.<chain>.json), on two RPCs of two operators, the checks of
// evm-sell-v4.mjs (its code, both immutables and getters, no admin, the run's transactions, the swept run key), with
// its code the CURRENT build's (pool-evm-deploy.build.json `contracts`, the build with the exact-debit check), never a
// build the file froze; and the kit's pinned sellDelegate for the chain is the record's address.
//   node scripts/live-checks/evm-selldelegate-exact-debit.mjs [--deployment <file>[,<file>]] [--rpc <url>,<url>]
//     [--record <file>] [--write-record]
//     PASS exit 0, FAIL exit 1, error exit 2
import "../net-window.mjs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { check as sellCheck, cli } from "./evm-sell-v4.mjs";

export const KEY = "evm-selldelegate-exact-debit";

/** evm-sell-v4's check on the current build, plus: the kit pins this record's delegate on its chain */
export async function check(o) {
  const r = await sellCheck({ ...o, current: true });
  const a = String(o.deployment?.contracts?.SellDelegate?.address ?? "").toLowerCase();
  const venues = o.venues ?? evmPoolVenues();
  const pin = Object.hasOwn(venues, o.deployment?.chain) ? venues[o.deployment.chain].sellDelegate : undefined;
  const pass = !!pin && pin.toLowerCase() === a;
  r.lines.push(`${pass ? "ok  " : "FAIL"} the kit pins SellDelegate ${a} on ${o.deployment?.chain}: ${pin ?? "none"}`);
  return { ok: r.ok && pass, lines: r.lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await cli(KEY, { current: true, check });
