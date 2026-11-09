#!/usr/bin/env node
// Card signpage-generated-merge-free: the signing page's build output is never committed. A committed bundle is one
// minified file every signing page branch rebuilds, so any two of them conflict on it (9 Nov: three reviewed branches
// refused by push-card on index.html and public/app.js). The build is made from the sources wherever it is read
// (scripts/signpage-built.mjs signBuilt) and at every deploy (deploy.mjs build()); the release list pins its bytes.
//   node scripts/ci/no-tracked-build-output.mjs [root]      (exit 1 and one line per refusal)
// Refuses a tree that tracks any of SIGN_BUILD_OUTPUTS, or whose ignore rules do not ignore one (a local build would
// then show as a new file, one `git add` away from committed); that tracks any other file in packages/signpage/public/
// than its sources (SIGN_PUBLIC_SOURCES), or any file in a dist/ folder (review P3-2: another name for a build).
// Refuses, too, a tracked script, test or live check that names a build output in the signing page's folder and never
// calls signBuilt() (scripts/signpage-built.mjs): it reads a file no checkout holds until a build makes it (card
// helper-live-red: withdraw-fee-busy-waits.mjs read packages/signpage/index.html at load, ENOENT in live run
// 42694130536 on every host, since da5519d8 untracked the build).
// Risk it holds: a branch that commits a bundle conflicts with every other signing page branch and can serve bytes its
// sources do not build; a reader of the build that never builds it fails on a fresh checkout (a live run, a CI job).
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SIGN_BUILD_OUTPUTS, SIGN_PUBLIC_SOURCES } from "./sign-build-inputs.mjs";

const git = (root, args) => {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git ${args.join(" ")} in ${root} failed: ${(r.stderr ?? "").trim()}`);
  return r;
};

/** Tracked files that name a build output's path and never read it: each with why. */
export const NAMES_NOT_READS = Object.freeze({
  "scripts/ci/sign-build-inputs.mjs": "the list of the build outputs itself",
  "scripts/ci/gitleaks-config.test.mjs": "the bundle's path as the name of a scanned text, never this checkout's file",
  "scripts/ci/gitleaks-scope.test.mjs": "writes a planted bundle into a planted repository",
});
const OUT = String.raw`(?:index\.html|public/app\.js|public/prover-worker\.js|public/prover-thread\.js)`;
// a path literal (one quote kind, no space): the output under the package folder, or the folder alone
const FULL_PATH = new RegExp(String.raw`(["'\x60])[^"'\x60\s]*packages/signpage/${OUT}\1`);
const FOLDER = new RegExp(String.raw`(["'\x60])[^"'\x60\s]*packages/signpage/?\1|(["'\x60])packages\2\s*,\s*(["'\x60])signpage\3`);
const OUT_NAME = new RegExp(String.raw`(["'\x60])/?${OUT}\1|(["'\x60])public\2\s*,\s*(["'\x60])(?:app|prover-worker|prover-thread)\.js\3`);
const CODE = /\.(?:m?js|cjs|tsx?)$/;
const uncommented = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The tracked code files under `root` that read a build output of the signing page's without calling signBuilt(). */
export function directReadProblems(root, files = git(root, ["ls-files", "-z"]).stdout.split("\0").filter(Boolean)) {
  const p = [];
  for (const f of files.filter((f) => CODE.test(f) && !(f in NAMES_NOT_READS) && f !== "scripts/signpage-built.mjs")) {
    let text;
    try { text = uncommented(readFileSync(join(root, f), "utf8")); } catch { continue; } // deleted in the working tree
    if (!FULL_PATH.test(text) && !(FOLDER.test(text) && OUT_NAME.test(text))) continue;
    if (!/\bsignBuilt\(/.test(text))
      p.push(`${f} reads the signing page's build output without signBuilt(): no checkout holds it until a build makes it; read it at path.join(signBuilt(), <file>) (scripts/signpage-built.mjs)`);
  }
  return p;
}

/** The refusals for the tree at `root` (empty = it tracks no build output and ignores each one). */
export function buildOutputProblems(root) {
  const tracked = new Set(git(root, ["ls-files", "-z", "--", ...SIGN_BUILD_OUTPUTS]).stdout.split("\0").filter(Boolean));
  const p = [];
  for (const f of SIGN_BUILD_OUTPUTS) {
    if (tracked.has(f)) p.push(`${f} is tracked: it is build output (node packages/signpage/scripts/build-app.mjs writes it); git rm --cached -- ${f}`);
    // --no-index: whether the ignore rules match the path, tracked or not
    else if (git(root, ["check-ignore", "-q", "--no-index", "--", f]).status !== 0) p.push(`${f} is not ignored: add it to .gitignore`);
  }
  const all = git(root, ["ls-files", "-z"]).stdout.split("\0").filter(Boolean);
  for (const f of all.filter((f) => f.startsWith("packages/signpage/public/") && !SIGN_PUBLIC_SOURCES.includes(f) && !SIGN_BUILD_OUTPUTS.includes(f)))
    p.push(`${f} is tracked in packages/signpage/public/, which holds only its sources (${SIGN_PUBLIC_SOURCES.join(", ")}): build output is never committed; git rm --cached -- ${f}`);
  for (const f of all.filter((f) => /(^|\/)dist\//.test(f))) p.push(`${f} is tracked in a dist/ folder: build output is never committed; git rm --cached -- ${f}`);
  return [...p, ...directReadProblems(root, all)];
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const p = buildOutputProblems(process.argv[2] ?? process.cwd());
  for (const l of p) console.error(`no-tracked-build-output: ${l}`);
  if (!p.length) console.log(`no-tracked-build-output: none of ${SIGN_BUILD_OUTPUTS.length} build outputs is tracked, each is ignored; packages/signpage/public/ tracks only its sources; no dist/ is tracked; every reader of the build calls signBuilt()`);
  process.exit(p.length ? 1 : 0);
}
