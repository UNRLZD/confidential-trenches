#!/usr/bin/env node
// Live check of card base-rpc-list-fix: a Base quote holds with two of its providers down, and every provider in the
// device's Base list answers the browser. Its end states are each proven by a check of their own, which this entry runs
// in turn with the same exit code (as vault-readback.mjs runs vault-mainnet.mjs), so the verify gate's
// scripts/live-checks/<key>.mjs is those checks:
//   (1) bloXroute's Base host out of the list: evm-quote-warm-round preflights and POSTs every listed Base provider;
//   (2) a fourth Base scan provider: evm-rpc-spare-list holds the first two down, asks the third for logs and checks the
//       CORS of every scan provider past the second;
//   (3) each lag case from a cold quote: evm-quote-lag-held runs each case in a process of its own.
// Their recorded runs are their own answers files, replayed by base-rpc-list-fix.test.mjs.
//   node scripts/live-checks/base-rpc-list-fix.mjs [--base <helper url>]   (--base goes to evm-rpc-spare-list)
// Runs: once, at merge: its three checks are in the app's list (evm-quote-warm-round, evm-quote-lag-held) and the helper's (evm-rpc-spare-list), each run after every deploy of its host
// PASS exit 0 when all three pass, else the first failing one's exit code. Reads only: no key, no transaction.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CHECKS = ["evm-quote-warm-round", "evm-rpc-spare-list", "evm-quote-lag-held"];

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const base = process.argv.indexOf("--base");
  let code = 0;
  for (const c of CHECKS) {
    const args = c === "evm-rpc-spare-list" && base > 0 ? ["--base", process.argv[base + 1]] : [];
    const r = spawnSync(process.execPath, [path.join(dir, `${c}.mjs`), ...args], { stdio: "inherit" });
    if ((r.status ?? 2) !== 0 && code === 0) code = r.status ?? 2;
  }
  console.log(code === 0 ? "PASS base-rpc-list-fix" : "FAIL base-rpc-list-fix");
  process.exit(code);
}
