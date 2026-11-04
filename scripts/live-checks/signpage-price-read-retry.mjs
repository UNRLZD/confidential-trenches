#!/usr/bin/env node
// Live check of card signpage-price-read-retry: scripts/live-checks/signpage-pool-price.mjs, whose part 1 is the signing
// page's own Pyth SOL/USD read on its pair (the read this card makes retry a slow or lagging provider) and whose part 2 is
// Bal in USD and Buy on while that read is fresh. This entry runs it with the same arguments and exit code, so the verify
// gate's scripts/live-checks/<key>.mjs is that one check; its recorded runs are signpage-pool-price.answers.json,
// replayed by signpage-pool-price.test.mjs.
//   node scripts/live-checks/signpage-price-read-retry.mjs <signpage-pool-price.mjs's arguments>
// Runs: once, no check of its own: signpage-pool-price, which SIGN_HOST's and APP_HOST's deploy lists already run after every deploy
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "signpage-pool-price.mjs"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 2);
