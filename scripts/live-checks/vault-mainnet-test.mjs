#!/usr/bin/env node
// Live check of card vault-mainnet-test (vault.md VT-R01): the mainnet test vault vault-test.confidential.unrlzd.near,
// read back by scripts/live-checks/vault-mainnet.mjs on mainnet's two operators against its record,
// contracts/vault/deployments/mainnet-test.json: keys [], the code hash and sha256 of the pinned build (57535ae7...ca6a),
// the import and export lists, config() naming mainnet USDC and a mainnet version, then the one storage_prepay write
// (the owner's paste the check prints, signed by confidential.unrlzd.near) read back by --tx and --precommitment.
// This entry runs that check with the vault's account, record and signer fixed, the same exit codes, and any of its
// --tx, --precommitment and --record arguments passed on; its recorded runs are vault-mainnet-test.*.answers.json,
// replayed by vault-mainnet-test.test.mjs.
//   node scripts/live-checks/vault-mainnet-test.mjs [--precommitment <P> --tx <hash>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, reads PASS and the write still to send exit 3
// Runs: once, a contract deploy read back on chain: after the mainnet test vault's deploy (contracts/vault/scripts/mainnet-test/3-deploy.sh); the vault has no deploy path after it
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ACCOUNT = "vault-test.confidential.unrlzd.near";
export const SIGNER = "confidential.unrlzd.near";
export const DEPLOYMENT = path.join(HERE, "../../contracts/vault/deployments/mainnet-test.json");
export const ARGS = ["--network", "mainnet", "--account", ACCOUNT, "--signer", SIGNER, "--deployment", DEPLOYMENT];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = spawnSync(process.execPath, [path.join(HERE, "vault-mainnet.mjs"), ...ARGS, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 2);
}
