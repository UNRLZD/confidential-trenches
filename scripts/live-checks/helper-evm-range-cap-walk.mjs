#!/usr/bin/env node
// Live check of card helper-evm-range-cap-walk: an EVM log read through the helper walks past a provider's range cap. Its
// end state is proven by evm-rpc-spare-list, which this entry runs with the same exit code (as base-rpc-list-fix.mjs
// does), so the verify gate's scripts/live-checks/<key>.mjs is that check: the helper's caller read with its first two
// providers answering base-pokt.nodies.app's -32001 "maximum allowed is 50 blocks" (its "cap" mode) answers 200 with a
// list from a provider past them, on Base and on Robinhood, and the deployed helper's address-less Transfer read of
// 1,000 blocks, which live run 42241935061 (6 Nov 15:19Z) answered with that cap, answers a list.
// Its recorded runs are evm-rpc-spare-list.answers.json's, replayed by helper-evm-range-cap-walk.test.mjs.
//   node scripts/live-checks/helper-evm-range-cap-walk.mjs [--base <helper url>]
// Runs: once, at merge: its check, evm-rpc-spare-list, is in the helper's list and runs after every deploy of HELPER_HOST
// PASS exit 0, FAIL exit 1, error exit 2. Reads only: no key, no transaction.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CHECKS = ["evm-rpc-spare-list"];

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const base = process.argv.indexOf("--base");
  const r = spawnSync(process.execPath, [path.join(dir, `${CHECKS[0]}.mjs`), ...(base > 0 ? ["--base", process.argv[base + 1]] : [])], { stdio: "inherit" });
  const code = r.status ?? 2;
  console.log(code === 0 ? "PASS helper-evm-range-cap-walk" : "FAIL helper-evm-range-cap-walk");
  process.exit(code);
}
