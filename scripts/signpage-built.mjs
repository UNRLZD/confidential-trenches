// The signing page's build, made from this tree's sources before anything here reads it (card
// signpage-generated-merge-free). index.html, public/app.js, public/prover-worker.js, public/prover-thread.js and
// public/walk-worker.js are
// build output and never committed (scripts/ci/sign-build-inputs.mjs SIGN_BUILD_OUTPUTS), so every script, test,
// harness and live check that reads them calls signBuilt() first: it runs build-app.mjs once per process (under a second
// on a laptop) and returns the package folder, so what is read is always the build of the sources beside it, never a
// stale or missing one. A failed build throws with build-app's own lines and the command that makes it. It lives in
// scripts/ and runs build-app.mjs as a child, never importing it, so a live check, a harness or a gate reaches no file of
// packages/ (pnpm run check:imports).
//
// Card readme-run-fits-an-agent-timeout: 96 test files reach signBuilt() (76 live checks' replays, 8 gates, 12 in the
// packages' own tests), each in its own process, and each ran build-app.mjs, about a CPU-second, on sources no test
// changes. So a build leaves a stamp, as make reads a target's
// time against its sources': every input's size and modified time (SIGN_BUILD_INPUTS, an output among them left out, a
// missing one named missing) and every output's, read after the build. A process whose inputs and outputs read as the
// stamp names, on the same node, builds nothing; an input or output changed, added or removed, another node, or no
// stamp, and it builds (scripts/ci/signpage-built.test.mjs).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SIGN_BUILD_INPUTS, SIGN_BUILD_OUTPUTS } from "./ci/sign-build-inputs.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SIGN_PKG = join(ROOT, "packages", "signpage");
export const BUILD_COMMAND = "node packages/signpage/scripts/build-app.mjs";
const BUILD_APP = join(SIGN_PKG, "scripts", "build-app.mjs");
/** Where a build's stamp is kept: the checkout's own node_modules, which git ignores and a fresh clone's install makes. */
export const STAMP = join(ROOT, "node_modules", ".cache", "signpage-built.json");

/** Runs `script` (build-app.mjs) once; throws, naming BUILD_COMMAND and the script's own lines, when it fails. */
export function runBuild(script = BUILD_APP) {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  if (r.status === 0) return;
  const said = `${r.stderr ?? ""}${r.stdout ?? ""}${r.error ? String(r.error) : ""}`.trim();
  throw new Error(`the signing page's build failed (exit ${r.status ?? r.signal}); it is made by ${BUILD_COMMAND}${said ? `:\n${said}` : ""}`);
}

/** The build's state under `root`: one line per input file ("<path> <size> <mtime>", or "<path> missing") and one per
 *  output, each list in path order. */
export function buildState(root = ROOT, inputs = SIGN_BUILD_INPUTS, outputs = SIGN_BUILD_OUTPUTS) {
  const out = new Set(outputs);
  const line = (rel) => {
    try {
      const s = statSync(join(root, rel));
      return s.isDirectory() ? null : `${rel} ${s.size} ${s.mtimeMs}`;
    } catch {
      return `${rel} missing`;
    }
  };
  const files = [];
  const walk = (rel) => {
    const l = line(rel);
    if (l !== null) return void (out.has(rel) || files.push(l));
    for (const e of readdirSync(join(root, rel)).sort()) walk(`${rel}/${e}`);
  };
  for (const i of [...inputs].sort()) walk(i);
  return { node: process.version, inputs: files.join("\n"), outputs: [...outputs].sort().map(line).join("\n") };
}

const same = (a, b) => a !== null && a.node === b.node && a.inputs === b.inputs && a.outputs === b.outputs;
const readStamp = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** Runs `build` unless the stamp at `stamp` names this state of `root`; after a build whose inputs did not change while
 *  it ran, writes the new state there (a write that fails leaves the next process to build). Returns whether it built. */
export function buildUnlessStamped({ root = ROOT, build = () => runBuild(), stamp = STAMP, inputs = SIGN_BUILD_INPUTS, outputs = SIGN_BUILD_OUTPUTS } = {}) {
  const before = buildState(root, inputs, outputs);
  if (same(readStamp(stamp), before)) return false;
  build();
  const after = buildState(root, inputs, outputs);
  if (after.inputs !== before.inputs) return true;
  try {
    mkdirSync(dirname(stamp), { recursive: true });
    const tmp = `${stamp}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(after));
    renameSync(tmp, stamp);
  } catch {}
  return true;
}

let built = false;
/** Builds the signing page's five output files in its package folder (once per process, and not at all where the last
 *  build's stamp names its sources and outputs as they are) and returns that folder. */
export function signBuilt() {
  if (!built) buildUnlessStamped();
  built = true;
  return SIGN_PKG;
}
