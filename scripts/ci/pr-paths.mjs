// SPDX-License-Identifier: Apache-2.0
// Which of ci.yml's test jobs a pull request runs (card ci-pr-light): a pull request's CI waits for no test it cannot
// affect, and the merge queue and every push to main still run every job.
//
// On pull_request, each unit below runs only when the change touches a file the unit reads: a workspace package's
// own tests and typecheck (PACKAGES), and the heavy jobs (JOBS). A package also runs when a workspace package it
// depends on runs (its package.json's workspace: dependencies, transitively). A change to a file every job reads
// (GLOBAL) runs every unit. On merge_group, push, workflow_dispatch and any other event every unit runs.
//
// What a unit reads is computed from the head checkout each run by reads(), never kept as a list that could fall
// behind: the files its seeds name (a package's whole folder, the files a job's steps run), their import closure
// (relative imports and the workspace packages' exports), and the repo paths each of those files names in a string (a
// fixture it opens, a script it starts, a folder it lists). pr-paths.test.mjs plants a test that starts reading a new
// file and fails unless a change to that file runs the test's job.
//
// The vault's sandbox suite keeps its own rule (scripts/ci/vault-sandbox.mjs), and the gates (gitleaks, deep-import,
// verify-gate, money-gate) and test-packages' repo-wide steps (the live-check replays, the bundle checks) always run.
//
//   node scripts/ci/pr-paths.mjs decide <event> [<base> <head>]   prints each unit's run=true|false and why; with
//                                                                GITHUB_OUTPUT set, writes ci.yml's outputs there;
//                                                                reads the change in the working directory
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closure, matches, namedPaths } from "./vault-sandbox.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// A change to one of these runs every unit: the install, the workflow and its local actions, and the scripts every
// test job runs on (this map, the closure reader it imports, the shard split, the download and retry helpers).
export const GLOBAL = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".gitmodules",
  ".github/workflows/ci.yml",
  ".github/actions/",
  "scripts/ci/pr-paths.mjs",
  "scripts/ci/vault-sandbox.mjs",
  "scripts/ci/test-shards.mjs",
  "scripts/ci/fetch.sh",
  "scripts/ci/retry.sh",
];

// Each workspace package's folder: the package reads every file in it and every file those read.
export const PACKAGES = {
  "@blindfill/kit": "packages/kit/",
  "@blindfill/wallet": "packages/wallet/",
  "@blindfill/exit": "packages/exit/",
  signpage: "packages/signpage/",
  "@confidential-trenches/helper": "apps/helper/",
  terminal: "apps/terminal/",
};

// The heavy jobs, by ci.yml job id. A job that runs a package's scripts names the package (pkgs) and runs whenever
// that package runs; seeds are the other files its steps run, and the job reads them and every file those read.
//   test-mutants: each named package's test:mutants (scripts/ci/test-shards.mjs, in GLOBAL, splits them)
//   test-browser: the terminal's test:e2e and the kit's prove-e2e.test.ts, in the Chrome the chrome action installs
//   test-vault: cargo test of contracts/vault, its crate and tests (include_str! and fixtures are named paths)
//   test-scripts: the vault's scripts' tests, the Solana pool's deploy script tests, the EVM pool's forge tests
//   pool-solana: the pool program's crate, its LiteSVM tests, the pin (its line in contracts/pool-review-2.md), the
//     venue fetch and the dry run (dry-run.sh starts deploy.mjs and the live check pool-sol-deploy)
//   slither: Slither on the EVM pool's sources and libs, then scripts/ci/slither-gate.mjs
export const JOBS = {
  "test-mutants": { pkgs: ["@blindfill/kit", "@blindfill/wallet", "signpage", "@confidential-trenches/helper"], seeds: [] },
  "test-browser": { pkgs: ["terminal", "@blindfill/kit"], seeds: ["scripts/browsers.mjs", "scripts/ci/browser-launch.mjs"] },
  "test-vault": { pkgs: [], seeds: ["contracts/vault/Cargo.toml", "contracts/vault/Cargo.lock", "contracts/vault/src/", "contracts/vault/tests/"] },
  "test-scripts": { pkgs: [], seeds: ["contracts/vault/scripts/", "contracts/pool-solana/scripts/", "contracts/pool-evm/"] },
  "pool-solana": {
    pkgs: [],
    seeds: [
      "contracts/pool-solana/Cargo.toml",
      "contracts/pool-solana/Cargo.lock",
      "contracts/pool-solana/src/",
      "contracts/pool-solana/svm-tests/",
      "contracts/pool-solana/fixtures/",
      "contracts/pool-solana/scripts/pin.mjs",
      "contracts/pool-solana/scripts/dry-run.sh",
      "contracts/pool-solana/scripts/deploy.mjs",
      "contracts/pool-review-2.md",
      "scripts/live-checks/pool-sol-deploy.mjs",
    ],
  },
  slither: {
    pkgs: [],
    seeds: [
      "contracts/pool-evm/src/",
      "contracts/pool-evm/lib/",
      "contracts/pool-evm/foundry.toml",
      "contracts/pool-evm/foundry.lock",
      "contracts/pool-evm/slither/",
      "scripts/ci/slither-gate.mjs",
    ],
  },
};

const tracked = (root) => execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);

// Every repo file the seeds read: the seeds, their import closure, and the repo paths those files name in a string.
// A named folder stands for every file in it only when a seed that lists folders (readdir, glob, git ls-files) names it:
// the unit's own code reads the folder. Any other file adds only the files it names one by one, so a shared module that
// lists a folder for its own command (money-gate.mjs reads every live-check record) does not make each importer read
// the folder, and a path built from a folder and a name (join(ROOT, "scripts/live-checks", file)) reads one file.
export function reads(seeds, root = ROOT, files = tracked(root)) {
  const start = files.filter((f) => matches(f, seeds) && !GENERATOR.test(f));
  const have = new Set(files);
  const out = new Set(closure(root, start, files));
  for (const f of start) out.add(f);
  for (const f of [...out]) {
    if (!/\.(m?[jt]sx?|rs|sh)$/.test(f)) continue;
    const text = readFileSync(path.join(root, f), "utf8");
    const lists = matches(f, seeds) && LISTS.test(text);
    for (const p of namedPaths(text, files, path.posix.dirname(f))) if (lists || namedFile(text, p, f, have)) out.add(p);
  }
  return [...out].sort();
}

// A fixture generator (fixtures/make-*.mjs) is run by hand and its output committed: the tests read the output, so the
// generator is no seed (a test that does start one names it, and that name adds it).
const GENERATOR = /\/fixtures\/make-[^/]*\.mjs$/;
const LISTS = /\breaddir(Sync)?\b|\bglob(Sync)?\b|\bls-files\b|\bopendir(Sync)?\b/;

// Whether `text` (the file `from`) names the file `p` itself, not only a folder holding it.
function namedFile(text, p, from, have) {
  for (const [, s] of text.matchAll(/"((?:\.\.\/)*(?:apps|packages|scripts|contracts)\/[^"\s]*)"/g)) {
    const bases = s.startsWith("../") ? ["contracts/vault", path.posix.dirname(from)] : [".", "contracts/vault"];
    if (bases.some((b) => path.posix.normalize(path.posix.join(b, s)) === p) && have.has(p)) return true;
  }
  return false;
}

// Each package's workspace dependencies, read from the packages' package.json files.
export function workspaceDeps(root = ROOT) {
  const deps = {};
  for (const [name, dir] of Object.entries(PACKAGES)) {
    const pkg = JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8"));
    deps[name] = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
      .filter(([, v]) => String(v).startsWith("workspace:"))
      .map(([k]) => k);
  }
  return deps;
}

// Which units run for this event and change: { packages: { name: [run, why] }, jobs: { id: [run, why] } }.
// `changed` is the change's file list, or null when it could not be read.
export function decide(event, changed, deps = workspaceDeps(), readsOf = (seeds) => reads(seeds)) {
  const all = (why) => ({
    packages: Object.fromEntries(Object.keys(PACKAGES).map((n) => [n, [true, why]])),
    jobs: Object.fromEntries(Object.keys(JOBS).map((j) => [j, [true, why]])),
  });
  if (event !== "pull_request") return all(`a ${event} run runs every job`);
  if (changed === null) return all("the change's files could not be read, so every job runs");
  const global = changed.find((f) => matches(f, GLOBAL));
  if (global) return all(`${global} is read by every job`);
  const packages = {};
  for (const [n, dir] of Object.entries(PACKAGES)) {
    const read = new Set(readsOf([dir]));
    const hit = changed.find((f) => read.has(f) || matches(f, [dir]));
    packages[n] = hit ? [true, `it reads ${hit}`] : [false, "it reads none of the changed files"];
  }
  // a package runs when a workspace package it depends on runs
  for (let grew = true; grew; ) {
    grew = false;
    for (const [n, d] of Object.entries(deps)) {
      const on = d.find((x) => packages[x]?.[0]);
      if (!packages[n][0] && on) [packages[n], grew] = [[true, `it depends on ${on}, which runs`], true];
    }
  }
  const jobs = {};
  for (const [j, { pkgs, seeds }] of Object.entries(JOBS)) {
    const pkg = pkgs.find((n) => packages[n][0]);
    const read = new Set(seeds.length ? readsOf(seeds) : []);
    const hit = seeds.length ? changed.find((f) => read.has(f) || matches(f, seeds)) : undefined;
    jobs[j] = pkg ? [true, `it runs ${pkg}, which runs`] : hit ? [true, `it reads ${hit}`] : [false, "it reads none of the changed files"];
  }
  return { packages, jobs };
}

// ci.yml's outputs: each job's run flag (its id with _ for -), test-wallet's, and the pnpm selectors for
// test-packages' two steps: "" for every package, "none" for no package, else a --filter=<name> per package.
export function outputs({ packages, jobs }) {
  const sel = (names) => {
    const on = names.filter((n) => packages[n][0]);
    return on.length === names.length ? "" : on.length ? on.map((n) => `--filter=${n}`).join(" ") : "none";
  };
  const names = Object.keys(packages);
  return {
    ...Object.fromEntries(Object.entries(jobs).map(([j, [run]]) => [j.replaceAll("-", "_"), String(run)])),
    test_wallet: String(packages["@blindfill/wallet"][0]),
    test_packages: "true",
    tests: sel(names.filter((n) => n !== "@blindfill/wallet")),
    typecheck: sel(names),
  };
}

// The files the change touches, read in the working directory: on a pull request CI runs main's copy of this file
// from outside the checkout, against the head checkout.
function changedFiles(base, head) {
  if (!base || /^0+$/.test(base) || !head) return null;
  try {
    execFileSync("git", ["cat-file", "-e", `${base}^{commit}`]);
    return execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [cmd, event, base, head] = process.argv.slice(2);
  if (cmd !== "decide" || !event) {
    console.error("usage: pr-paths.mjs decide <event> [<base> <head>]");
    process.exit(2);
  }
  // the package graph and every read come from the working directory, the head checkout: on a pull request this file
  // is main's copy, run from outside it
  const cwd = process.cwd();
  const files = tracked(cwd);
  const d = decide(event, event === "pull_request" ? changedFiles(base, head) : [], workspaceDeps(cwd), (seeds) => reads(seeds, cwd, files));
  for (const [n, [run, why]] of Object.entries(d.packages)) console.log(`package ${n}: run=${run}: ${why}`);
  for (const [j, [run, why]] of Object.entries(d.jobs)) console.log(`job ${j}: run=${run}: ${why}`);
  const out = outputs(d);
  console.log(Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(""));
}
