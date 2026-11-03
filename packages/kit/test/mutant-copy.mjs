// Where the kit's mutant sweeps run (test/evm-pool-buy-mutants.mjs, test/evm-pool-sell-mutants.mjs): a copy of the kit
// at packages/.kit-mutants-<pid>, beside it so every relative import resolves as it does in the kit (src and test
// copied, package.json and tsconfig.json too; node_modules and zk linked), removed when the sweep exits. A sweep changes
// files of the copy only: a test run at the same time (the kit's own, or a package that imports the kit's source) never
// reads a mutant.
import { cpSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const KIT = fileURLToPath(new URL("..", import.meta.url));

/** The copy's root: made once, removed at exit (an interrupt included). */
export function kitCopy() {
  const root = path.join(KIT, "..", `.kit-mutants-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root);
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
  for (const d of ["src", "test"]) cpSync(path.join(KIT, d), path.join(root, d), { recursive: true });
  for (const f of ["package.json", "tsconfig.json"]) cpSync(path.join(KIT, f), path.join(root, f));
  for (const l of ["node_modules", "zk"]) symlinkSync(path.join(KIT, l), path.join(root, l));
  return root;
}
