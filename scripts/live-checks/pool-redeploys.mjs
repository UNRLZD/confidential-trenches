// The testnet pool sets a later card redeployed whole, and the record naming a testnet's current pool: the one list,
// read by pool-evm-deploy.mjs (poolRecordName, poolFile) and scripts/ci/helper-live-checks.mjs (evmPoolRecord). It
// imports only node: modules, so the live plan's fixtures copy this file alone.
// Runs: once, no check: a module the checks share (the list of testnet pool redeploys)
import { existsSync } from "node:fs";
import path from "node:path";

/** A testnet's pool redeployed with a whole new set by a later card, newest first: card pool-evm-buy-pays-revert's
 * (7 Nov: its buy pays a failed swap's chunk to W). The kit pins that set's pool and verifier; its adapters and sell
 * delegate stay unpinned, the kit keeping pool-evm-deploy's adapters and the sell delegate's own redeploy. */
export const POOL_REDEPLOYS = Object.freeze(["pool-evm-buy-pays-revert"]);
/** The name of the record that holds `chain`'s current testnet pool in `dir`: the newest redeploy's, else
 * pool-evm-deploy's. */
export const poolRecordName = (chain, dir) => POOL_REDEPLOYS.map((k) => `${k}.${chain}.json`).find((f) => existsSync(path.join(dir, f))) ?? `pool-evm-deploy.${chain}.json`;
