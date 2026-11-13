#!/usr/bin/env node
// Live check of card signpage-restores-near-vault-notes: a sign-in with the 12 words on an empty store walks the NEAR
// vault with the pools (packages/signpage/src/pool-restore.ts pagePools: the vault's entry, read whole on the page's
// NEAR pair, each answer's bytes equal on both), and the run still ends done. Its end state on what is deployed is
// pool-restore-wired.mjs's own: the published vector's words typed into SIGN_HOST, the run with no tap ended done
// within WAIT_MS, every request on a pinned host (the NEAR pair among them), and no "restore stalled:" line. A vault
// the page cannot read throws in its walk, the run names "near vault" stalled (main.ts's console line), and that check
// fails. This entry runs that check with its exit code (as restore-check-bounded.mjs runs its check), so the verify
// gate's scripts/live-checks/<key>.mjs is that check; its recorded runs are pool-restore-wired.answers.json, replayed
// by signpage-restores-near-vault-notes.test.mjs.
// After: sign
// Bundle: out a browser (it runs pool-restore-wired)
//   node scripts/live-checks/signpage-restores-near-vault-notes.mjs   the deployed SIGN_HOST
//     (confidential.unrealized.trade), as pool-restore-wired.mjs reads it
// It is in the signing page's list (packages/signpage/scripts/deploy.test.mjs holds every signpage-* check there), so
// the restore run is read twice after a sign deploy, each in its own job; the first with the vault's walk in it is
// release 122's. PASS exit 0, FAIL exit 1, error exit 2. No money; the account is the published vector's, thrown away
// with the profile.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CHECK = "pool-restore-wired";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), `${CHECK}.mjs`)], { stdio: "inherit" });
  const code = r.status ?? 2;
  console.log(code === 0 ? "PASS signpage-restores-near-vault-notes" : "FAIL signpage-restores-near-vault-notes");
  process.exit(code);
}
