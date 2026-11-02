// SPDX-License-Identifier: Apache-2.0
// The vault's near-sandbox suite in CI (.github/workflows/ci.yml, job vault-sandbox): when it runs, and how its test
// targets split over the job's shards.
//
// The rule: the suite runs when a change touches a file the suite reads (PATHS), and passes with a printed skip
// otherwise. What the suite reads is computed from the repo by suiteReads(): every file under contracts/vault/, every
// repo path a test names in a string (include_str!, a file it opens, a script it starts), and each script's import
// closure (relative imports and the workspace packages' exports). vault-sandbox.test.mjs fails when one of them is
// outside PATHS, so a test that starts reading a new file cannot leave the rule behind.
//
// The shards: SHARDS lists every test target of contracts/vault (the lib's unit tests and each tests/*.rs) in exactly
// one shard; vault-sandbox.test.mjs fails on a target in no shard or in two.
//
//   node scripts/ci/vault-sandbox.mjs decide <event> [<base> <head>]   prints run=true|false and why; with
//                                                                     GITHUB_OUTPUT set, writes run=... there too;
//                                                                     reads the change in the working directory
//   node scripts/ci/vault-sandbox.mjs shard <n>                        prints shard n's cargo test target args
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// A path matches when it starts with one of these (a directory ends with "/") or equals it.
export const PATHS = [
  "contracts/vault/",
  // what the suite's scripts import and the files its tests read (suiteReads)
  "packages/kit/src/",
  "packages/kit/zk/",
  "packages/kit/test/vectors/",
  "packages/kit/package.json",
  "apps/helper/src/bind/",
  "apps/helper/src/near/",
  "apps/helper/src/store/",
  "apps/helper/src/token-status/",
  "apps/helper/test/bind-send/",
  // the relayer's withdraw send, which sandbox tests will drive as bind-send is driven
  "apps/helper/src/withdraw/",
  "apps/helper/test/withdraw-send/",
  "scripts/live-checks/vault-",
  "scripts/ci/near-rpc-operators.mjs",
  "scripts/net-window.mjs",
  // the install every script runs on
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/helper/package.json",
  // the job itself
  ".github/workflows/ci.yml",
  "scripts/ci/vault-sandbox.mjs",
  "scripts/ci/vault-sandbox.test.mjs",
];

export function matches(file, paths = PATHS) {
  return paths.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p || file.startsWith(p)));
}

// Each shard's cargo test targets, about equal in time (box run 2026-11-02: s10 181 s, s04 95, relayer_send 95,
// payouts 70, s20 64 plus its two builds, s02 58, deposit_msg 47, ragequit 46, settle 42, real_token 29, smoke 27,
// s01 19, tree_prop 16, withdraw_spend 15, withdraw_context 14, prepay 12, groth16 5, lib 4, the rest under 1).
export const SHARDS = [
  ["s10", "s01", "withdraw_spend", "withdraw_context", "vkey"],
  ["s04", "relayer_send", "groth16", "events", "poseidon"],
  ["payouts", "s20", "s02", "withdraw_vectors"],
  ["lib", "deposit_msg", "ragequit", "settle", "real_token", "smoke", "tree_prop", "prepay"],
];

// Every test target of contracts/vault: the lib's unit tests and one per tests/*.rs.
export function targets(root = ROOT) {
  const dir = path.join(root, "contracts/vault/tests");
  return ["lib", ...readdirSync(dir).filter((f) => f.endsWith(".rs")).map((f) => f.slice(0, -3))].sort();
}

// What is wrong with `shards` for these targets: [] when every target is in exactly one shard.
export function shardProblems(shards, all) {
  const p = [];
  const seen = new Map();
  shards.forEach((s, i) => s.forEach((t) => {
    if (seen.has(t)) p.push(`${t} is in shard ${seen.get(t) + 1} and shard ${i + 1}`);
    else seen.set(t, i);
  }));
  for (const t of all) if (!seen.has(t)) p.push(`${t} is in no shard, so CI never runs it`);
  for (const t of seen.keys()) if (!all.includes(t)) p.push(`${t} is in a shard but is no test target`);
  return p;
}

// run.sh's arguments for shard `n` (1-based).
export function shardArgs(n, shards = SHARDS) {
  const s = shards[n - 1];
  if (!s) throw new Error(`no shard ${n}: there are ${shards.length}`);
  return ["--no-fail-fast", ...s.flatMap((t) => (t === "lib" ? ["--lib"] : ["--test", t]))];
}

const tracked = (root) => execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);

// The workspace packages by name: name -> the file its "." export names.
function workspaceEntries(root, files) {
  const m = new Map();
  for (const f of files.filter((f) => /^(packages|apps)\/[^/]+\/package\.json$/.test(f))) {
    const pkg = JSON.parse(readFileSync(path.join(root, f), "utf8"));
    const dot = pkg.exports?.["."];
    const entry = typeof dot === "string" ? dot : dot?.default ?? dot?.import;
    if (pkg.name && entry) m.set(pkg.name, path.posix.join(path.posix.dirname(f), entry));
    for (const [sub, v] of Object.entries(pkg.exports ?? {})) {
      const e = typeof v === "string" ? v : v?.default ?? v?.import;
      if (sub !== "." && e && pkg.name) m.set(pkg.name + sub.slice(1), path.posix.join(path.posix.dirname(f), e));
    }
  }
  return m;
}

const SPEC = /(?:\bimport\s[^'"]*?from\s*|\bimport\s*\(\s*|\bexport\s[^'"]*?from\s*|\bimport\s*)["']([^"']+)["']/g;

// The import closure of `start` (repo-relative files): relative imports and workspace packages, never node_modules.
export function closure(root, start, files = tracked(root)) {
  const have = new Set(files);
  const pkgs = workspaceEntries(root, files);
  const seen = new Set();
  const todo = [...start];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f) || !have.has(f)) continue;
    seen.add(f);
    if (!/\.(m?[jt]s|tsx?)$/.test(f)) continue;
    const text = readFileSync(path.join(root, f), "utf8");
    for (const [, spec] of text.matchAll(SPEC)) {
      let to = null;
      if (spec.startsWith(".")) to = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
      else if (pkgs.has(spec)) to = pkgs.get(spec);
      if (to) todo.push(to, to + ".ts", to + ".mjs", to + ".js", to + "/index.ts");
    }
  }
  return [...seen].sort();
}

// The repo paths a file names in a string literal that starts at apps/, packages/, scripts/ or contracts/, or climbs
// to them with "../". A path that is a directory stands for every tracked file under it.
export function namedPaths(text, files, from = "contracts/vault") {
  const out = new Set();
  for (const [, s] of text.matchAll(/"((?:\.\.\/)*(?:apps|packages|scripts|contracts)\/[^"\s]*)"/g)) {
    // from the repo root, from CARGO_MANIFEST_DIR (contracts/vault) in a join, or from the file's own dir (include_str!)
    const bases = s.startsWith("../") ? ["contracts/vault", from] : [".", "contracts/vault"];
    for (const b of bases) {
      const p = path.posix.normalize(path.posix.join(b, s));
      for (const f of files) if (f === p || f.startsWith(p.replace(/\/?$/, "/"))) out.add(f);
    }
  }
  return out;
}

// Every repo file the sandbox suite reads: everything under contracts/vault/; the repo paths its Rust code and run.sh
// name (include_str!, a file a test opens, a script a test starts); and the import closure of each script it starts
// (those named, and run.sh's fetch-wasm.mjs).
export function suiteReads(root = ROOT, files = tracked(root)) {
  const reads = new Set(files.filter((f) => f.startsWith("contracts/vault/")));
  const scripts = ["contracts/vault/tests/harness/fetch-wasm.mjs"];
  for (const f of [...reads].filter((f) => /\.rs$/.test(f) || f === "contracts/vault/tests/harness/run.sh")) {
    for (const p of namedPaths(readFileSync(path.join(root, f), "utf8"), files, path.posix.dirname(f))) {
      reads.add(p);
      if (/\.(m?[jt]s)$/.test(p)) scripts.push(p);
    }
  }
  for (const f of closure(root, scripts, files)) reads.add(f);
  return [...reads].sort();
}

// The files in `reads` no path of `paths` matches.
export function uncovered(reads, paths = PATHS) {
  return reads.filter((f) => !matches(f, paths));
}

// Whether the suite runs for this event and change: [run, why].
export function decide(event, changed) {
  if (event !== "pull_request" && event !== "push") return [true, `a ${event} run always runs the suite`];
  if (changed === null) return [true, "the change's files could not be read, so the suite runs"];
  const hit = changed.filter((f) => matches(f));
  if (hit.length) return [true, `${hit.length} changed file(s) the suite reads, first ${hit[0]}`];
  return [false, `none of the ${changed.length} changed file(s) is one the vault's sandbox suite reads`];
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
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === "decide") {
    const [run, why] = decide(a[0], a[0] === "pull_request" || a[0] === "push" ? changedFiles(a[1], a[2]) : []);
    console.log(`run=${run}: ${why}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
  } else if (cmd === "shard") {
    console.log(shardArgs(Number(a[0])).join(" "));
  } else {
    console.error("usage: vault-sandbox.mjs decide <event> [<base> <head>] | shard <n>");
    process.exit(2);
  }
}
