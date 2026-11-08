#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The mainnet money run's source gate (card vault-mainnet-money): a paste that signs real money runs only from a
// checkout anyone can read back, so what ran is what is on GitHub. Refused: a tree with a changed or untracked path (an
// edit under packages/wallet would change what the device signs), and a HEAD on no branch or tag of the public repo
// (not pushed). It is deploy.mjs's sourceProblems, the vault deploy's own gate, run on the checkout's HEAD.
//   node contracts/vault/scripts/source-gate.mjs     (from the checkout's root; exit 1 with the reason when refused)
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sourceProblems } from "./deploy.mjs";

/** [] when `dir`'s checkout is clean and its HEAD is on a branch or tag of the public repo. */
export function treeProblems(dir) {
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let top, head;
  try {
    top = git("rev-parse", "--show-toplevel");
    head = git("rev-parse", "--verify", "HEAD");
  } catch (e) {
    return [`${dir} is not a git checkout with a commit: ${String(e.stderr || e.message).trim().split("\n")[0]}`];
  }
  return sourceProblems({ cwd: top, commit: head });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const p = treeProblems(process.cwd());
  if (p.length) {
    console.error(`refused, nothing signed: ${p.join("; ")}`);
    process.exit(1);
  }
}
