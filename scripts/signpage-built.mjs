// The signing page's build, made from this tree's sources before anything here reads it (card
// signpage-generated-merge-free). index.html, public/app.js, public/prover-worker.js and public/prover-thread.js are
// build output and never committed (scripts/ci/sign-build-inputs.mjs SIGN_BUILD_OUTPUTS), so every script, test,
// harness and live check that reads them calls signBuilt() first: it runs build-app.mjs once per process (under a second
// on a laptop) and returns the package folder, so what is read is always the build of the sources beside it, never a
// stale or missing one. A failed build throws with build-app's own lines and the command that makes it. It lives in
// scripts/ and runs build-app.mjs as a child, never importing it, so a live check, a harness or a gate reaches no file of
// packages/ (pnpm run check:imports).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SIGN_PKG = join(dirname(dirname(fileURLToPath(import.meta.url))), "packages", "signpage");
export const BUILD_COMMAND = "node packages/signpage/scripts/build-app.mjs";
const BUILD_APP = join(SIGN_PKG, "scripts", "build-app.mjs");

/** Runs `script` (build-app.mjs) once; throws, naming BUILD_COMMAND and the script's own lines, when it fails. */
export function runBuild(script = BUILD_APP) {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  if (r.status === 0) return;
  const said = `${r.stderr ?? ""}${r.stdout ?? ""}${r.error ? String(r.error) : ""}`.trim();
  throw new Error(`the signing page's build failed (exit ${r.status ?? r.signal}); it is made by ${BUILD_COMMAND}${said ? `:\n${said}` : ""}`);
}

let built = false;
/** Builds the signing page's four output files in its package folder (once per process) and returns that folder. */
export function signBuilt() {
  if (!built) runBuild();
  built = true;
  return SIGN_PKG;
}
