#!/usr/bin/env node
// Live check of card restore-check-bounded: a restore's EVM token read ends in bounded time and the check says where it
// stands. Its end state is wallet-restore-transfer-rpcs.mjs's own: the four networks read at once, a line for each as
// it ends with its calls, time and refusals, a deadline per network (NETWORK_DEADLINE_MS) that fails naming the stuck
// call, and the wallet's pager no longer halving the rest of a W's read for one refusal under a cap
// (EVM_LOG_CEILING_PAGES, packages/wallet/src/pool/evm.ts). This entry runs that check with its exit code (as
// base-rpc-list-fix.mjs runs its checks), so the verify gate's scripts/live-checks/<key>.mjs is that check; its
// recorded runs are wallet-restore-transfer-rpcs.answers.json, replayed by restore-check-bounded.test.mjs.
//   node scripts/live-checks/restore-check-bounded.mjs
// Runs: once, at merge; wallet-restore-transfer-rpcs is in the helper's list (scripts/ci/helper-live-checks.mjs) and runs
// after every helper deploy. PASS exit 0, FAIL exit 1, error exit 2. Reads only: no key, no transaction.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CHECK = "wallet-restore-transfer-rpcs";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), `${CHECK}.mjs`)], { stdio: "inherit" });
  const code = r.status ?? 2;
  console.log(code === 0 ? "PASS restore-check-bounded" : "FAIL restore-check-bounded");
  process.exit(code);
}
