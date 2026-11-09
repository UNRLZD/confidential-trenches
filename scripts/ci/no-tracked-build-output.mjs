#!/usr/bin/env node
// Card signpage-generated-merge-free: the signing page's build output is never committed. A committed bundle is one
// minified file every signing page branch rebuilds, so any two of them conflict on it (9 Nov: three reviewed branches
// refused by push-card on index.html and public/app.js). The build is made from the sources wherever it is read
// (scripts/signpage-built.mjs signBuilt) and at every deploy (deploy.mjs build()); the release list pins its bytes.
//   node scripts/ci/no-tracked-build-output.mjs [root]      (exit 1 and one line per refusal)
// Refuses a tree that tracks any of SIGN_BUILD_OUTPUTS, or whose ignore rules do not ignore one (a local build would
// then show as a new file, one `git add` away from committed); that tracks any other file in packages/signpage/public/
// than its sources (SIGN_PUBLIC_SOURCES), or any file in a dist/ folder (review P3-2: another name for a build).
// Risk it holds: a branch that commits a bundle conflicts with every other signing page branch and can serve bytes its
// sources do not build.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SIGN_BUILD_OUTPUTS, SIGN_PUBLIC_SOURCES } from "./sign-build-inputs.mjs";

const git = (root, args) => {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git ${args.join(" ")} in ${root} failed: ${(r.stderr ?? "").trim()}`);
  return r;
};

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
  return p;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const p = buildOutputProblems(process.argv[2] ?? process.cwd());
  for (const l of p) console.error(`no-tracked-build-output: ${l}`);
  if (!p.length) console.log(`no-tracked-build-output: none of ${SIGN_BUILD_OUTPUTS.length} build outputs is tracked, each is ignored; packages/signpage/public/ tracks only its sources; no dist/ is tracked`);
  process.exit(p.length ? 1 : 0);
}
