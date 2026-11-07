#!/usr/bin/env node
// Live check of card vault-mainnet-deploy (vault.md VT-R02): the mainnet vault vault.confidential.unrlzd.near, read back
// by scripts/live-checks/vault-mainnet.mjs on mainnet's two operators (FastNEAR and dRPC) against its record: keys [],
// the code hash and sha256 of the pinned build (the mainnet build of e0623bf3, a4a2af69...87fc), the import and export
// lists, config() naming mainnet USDC and a mainnet version, the vault registered on mainnet USDC (--registered), then
// the one storage_prepay write (the owner's paste the check prints, signed by confidential.unrlzd.near) read back by
// --tx and --precommitment.
// The record is contracts/vault/deployments/mainnet-v1.json, which deploy.mjs writes once the deploy lands; before
// that, the pre-deploy record mainnet-v1.pin.json, whose pin is the same, so a run before the deploy reads the
// account's absence and FAILs. keys [] alone never passes the vault: view_access_key_list answers [] for an account
// that does not exist (the recorded bad answer, read before the deploy), so the code hash, code and config() reads are
// the ones that decide.
// This entry runs that check with the vault's account, record and signer fixed, the same exit codes, and any of its
// --tx, --precommitment and --record arguments passed on; its recorded runs are vault-mainnet-deploy.*.answers.json,
// replayed by vault-mainnet-deploy.test.mjs. Once the write has landed (contracts/vault/scripts/mainnet-v1/
// 3-readback-write.sh), PREPAY_TX and PREPAY_P name it, and the bare run reads it back, the card's whole end state.
//   node scripts/live-checks/vault-mainnet-deploy.mjs [--precommitment <P> --tx <hash>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, reads PASS and the write still to send exit 3
// Runs: once, a contract deploy read back on chain: after the mainnet vault's deploy (contracts/vault/scripts/mainnet-v1/2-deploy.sh); the vault has no deploy path after it
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ACCOUNT = "vault.confidential.unrlzd.near";
export const SIGNER = "confidential.unrlzd.near";
export const RECORD = path.join(HERE, "../../contracts/vault/deployments/mainnet-v1.json");
export const PIN_RECORD = path.join(HERE, "../../contracts/vault/deployments/mainnet-v1.pin.json");
export const deployment = () => (existsSync(RECORD) ? RECORD : PIN_RECORD);
export const args = () => ["--network", "mainnet", "--account", ACCOUNT, "--signer", SIGNER, "--deployment", deployment(), "--registered"];
// the landed write, set by the record commit after 3-readback-write.sh; null until then
export const PREPAY_TX = null;
export const PREPAY_P = null;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const given = process.argv.slice(2);
  const landed = PREPAY_TX && !given.includes("--tx") && !given.includes("--precommitment") ? ["--precommitment", PREPAY_P, "--tx", PREPAY_TX] : [];
  const r = spawnSync(process.execPath, [path.join(HERE, "vault-mainnet.mjs"), ...args(), ...landed, ...given], { stdio: "inherit" });
  process.exit(r.status ?? 2);
}
