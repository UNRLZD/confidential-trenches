#!/usr/bin/env node
// Live check of card helper-evm-sender-2: on Base and Robinhood the helper sends a pool withdraw or buy only when W
// signed exactly those bytes. Its end state is proven by helper-pool-senders' EVM branch, which this entry runs on each
// EVM pool a deploy record names (scripts/ci/helper-live-checks.mjs evmPools: the testnets' and, once deployed, the
// mainnets'), or on the one --pool given, with the worst exit code: POST /v1/pool/evm/send must refuse, before any send,
// a withdraw W signed for value + 1 and a buy carrying W's Withdraw signature (bad_signature), a withdraw past its
// deadline (deadline_near) and one to a recipient with code (recipient_code), each with its own code.
// Its recorded runs are helper-evm-sender-2.answers.json, replayed by helper-evm-sender-2.test.mjs.
//   node scripts/live-checks/helper-evm-sender-2.mjs [--base <helper url>] [--pool <EVM pool>]
// PASS exit 0, FAIL exit 1, error exit 2. No key that holds money, no transaction: every plant is refused before a send.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPools } from "../ci/helper-live-checks.mjs";

export const CHECKS = ["helper-pool-senders"];
const EVM_POOL = /^0x[0-9a-f]{40}$/;

/** The EVM pools this check runs on: the one asked, else every pool a deploy record names under `root`. */
export function poolsOf(asked, root) {
  if (asked !== undefined) return EVM_POOL.test(asked) ? [asked] : [];
  return Object.values(evmPools(root)).filter((p) => p !== null);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const pools = poolsOf(opt("--pool"));
  if (pools.length === 0) {
    console.error("helper-evm-sender-2: no EVM pool: --pool must be 0x and 40 lower-case hex, or a deploy record must name one");
    process.exit(2);
  }
  const dir = path.dirname(fileURLToPath(import.meta.url));
  let code = 0;
  for (const pool of pools) {
    const r = spawnSync(process.execPath, [path.join(dir, `${CHECKS[0]}.mjs`), "--pool", pool, ...(opt("--base") ? ["--base", opt("--base")] : [])], { stdio: "inherit" });
    code = Math.max(code, r.status ?? 2);
  }
  console.log(code === 0 ? "PASS helper-evm-sender-2" : "FAIL helper-evm-sender-2");
  process.exit(code);
}
