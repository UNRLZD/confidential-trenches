#!/usr/bin/env node
// Live check of card vault-readback: scripts/live-checks/vault-mainnet.mjs, the read-back the mainnet vault cards run
// (vault-mainnet-test, vault-mainnet-deploy). This entry runs it with the same arguments and exit code, so the verify
// gate's scripts/live-checks/<key>.mjs is that one check; its recorded runs are vault-mainnet.*.answers.json, replayed
// by vault-mainnet.test.mjs.
//   node scripts/live-checks/vault-readback.mjs <vault-mainnet.mjs's arguments>
// Runs: once, a contract deploy read back on chain: after each vault deploy (testnet, the mainnet test vault, the mainnet vault), with that vault's --account; no host deploy changes it
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "vault-mainnet.mjs"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 2);
