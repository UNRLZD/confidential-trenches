#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The mainnet money run's source gate (card vault-mainnet-money): a paste that signs real money runs only from a fresh
// clone of the public repo at the one reviewed commit its line names, so what signs is that commit and nothing else.
// The paste line makes the clone (git clone of REPO into a new folder, with no global or system git config, then a
// detached checkout of the commit); this gate then holds, before pnpm installs and again in the driver right before each
// signature (mainnet-money.ts):
//   - HEAD is the named commit, and (mainnet) an ancestor of main as REPO itself answers it now (git ls-remote, then a
//     fetch when main moved on since the clone), origin being REPO; the commit and every tree of it hash to their ids;
//   - the clone's own git config is what git clone writes and nothing more (no url.insteadOf, include, hooksPath,
//     fsmonitor, status or core setting of anyone's), no alternates, no grafts, no info/exclude patterns;
//   - every file on disk is the commit's, read here byte for byte against the commit's tree (git's blob hash), not
//     through git status or the index, so no assume-unchanged or skip-worktree flag, ignore rule or stat cache can hide
//     an edit; a tracked path that is a symlink, a missing file or any file the commit does not hold is refused;
//   - the only paths the commit does not hold are the node_modules folders pnpm makes (the root's and each workspace
//     package's), and once installed, every link in them points inside the clone and what the driver loads from them
//     resolves inside it: the wallet's @blindfill/kit to the clone's packages/kit, snarkjs and fake-indexeddb to the
//     clone's own node_modules/.pnpm.
// The rehearsal on testnet runs from a clone of a commit that is not on main yet: --not-on-main skips only the origin
// and main check, and is refused unless the network is testnet.
//   node contracts/vault/scripts/source-gate.mjs --commit <sha> [--before-install] [--not-on-main --network testnet]
//        (from the clone's root; exit 1 with the reason when refused)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = "https://github.com/UNRLZD/confidential-trenches";
/** What git clone writes into a new clone's .git/config (and git init's core keys): every other key is refused. */
const CLONE_CONFIG = /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.origin\.(url|fetch)|branch\.[^\n=]+\.(remote|merge))=/;
/** The folders pnpm install makes: the root's node_modules and each workspace package's (pnpm-workspace.yaml's globs). */
export const MODULES = /^(node_modules|(apps|packages|examples)\/[^/]+\/node_modules)$/;

/** git with no config but the clone's own: every GIT_* of the caller's environment dropped, no global or system file, no replace refs. */
function gitIn(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" });
  const run = (a, input) => execFileSync("git", ["-C", root, ...a], { env, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], maxBuffer: 256 << 20 });
  const git = (...a) => run(a).toString("utf8");
  git.bytes = (a, input) => run(a, input);
  return git;
}

/** [] when the commit and every tree of it hash to their ids: git reads a loose object without checking it, so a forged one is read here. */
function objectProblems(git, commit) {
  const trees = [git("rev-parse", `${commit}^{tree}`).trim()];
  for (const rec of git("ls-tree", "-r", "-t", "-z", "--full-tree", commit).split("\0").filter(Boolean)) {
    const [, type, id] = rec.slice(0, rec.indexOf("\t")).split(" ");
    if (type === "tree") trees.push(id);
  }
  const ids = [commit, ...new Set(trees)];
  const out = git.bytes(["cat-file", "--batch"], ids.join("\n") + "\n");
  const p = [];
  let at = 0;
  for (const id of ids) {
    const nl = out.indexOf(10, at);
    const [got, type, size] = out.subarray(at, nl).toString("utf8").split(" ");
    if (got !== id || (type !== "commit" && type !== "tree")) return [`the clone's object ${id} is not read whole: make a fresh clone`];
    const body = out.subarray(nl + 1, nl + 1 + Number(size));
    if (createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest("hex") !== id) p.push(`${type} ${id} does not hash to its id: make a fresh clone`);
    at = nl + 1 + Number(size) + 1;
  }
  return p;
}

/** Every link under the clone's node_modules folders that points outside the clone (relative to `rel`, e.g. "node_modules"). */
function linksOutside(real, rel) {
  const inside = (f) => f === real || f.startsWith(real + path.sep);
  const out = [];
  const walk = (r) => {
    for (const d of readdirSync(path.join(real, r), { withFileTypes: true })) {
      const e = `${r}/${d.name}`;
      if (d.isSymbolicLink()) {
        const to = path.resolve(path.join(real, r), readlinkSync(path.join(real, e)));
        let target = to;
        try {
          target = realpathSync(to);
        } catch {}
        if (!inside(to) || !inside(target)) out.push(e);
      } else if (d.isDirectory()) walk(e);
    }
  };
  walk(rel);
  return out;
}

/** git's blob id of a file's bytes. */
const blobId = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/**
 * [] when `root` is a clone at `commit` that holds exactly the commit's files (and, `installed`, pnpm's node_modules
 * resolving inside it); `onMain`: also origin is REPO and the commit is an ancestor of main as `remote` (REPO; a test's
 * local stand-in) answers it now.
 */
export function cloneProblems({ root, commit, onMain = true, installed = true, remote = REPO }) {
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) return [`--commit ${String(commit)}: not a 40-hex commit`];
  const git = gitIn(root);
  const p = [];
  let head;
  try {
    if (realpathSync(git("rev-parse", "--show-toplevel").trim()) !== realpathSync(root)) return [`${root} is not the top of its own clone`];
    head = git("rev-parse", "--verify", "HEAD^{commit}").trim();
  } catch (e) {
    return [`${root} is not a git clone with a commit: ${String(e.stderr || e.message).trim().split("\n")[0]}`];
  }
  if (head !== commit) return [`HEAD is ${head}, not the paste's commit ${commit}`];
  const gitDir = path.join(root, ".git");
  if (!existsSync(gitDir) || !lstatSync(gitDir).isDirectory()) return [`${root}/.git is not a clone's own folder (a worktree or a linked .git file)`];
  // -z: each entry is "key\nvalue", so a value holding a newline is one value, never a second line
  const config = git("config", "--local", "--list", "-z").split("\0").filter(Boolean).map((e) => (e.includes("\n") ? `${e.slice(0, e.indexOf("\n"))}=${e.slice(e.indexOf("\n") + 1)}` : e));
  const extra = config.filter((l) => !CLONE_CONFIG.test(l));
  if (extra.length) p.push(`the clone's git config holds ${extra.map((l) => l.split("=")[0]).join(", ")}: make a fresh clone`);
  for (const f of ["objects/info/alternates", "info/grafts", "shallow"]) if (existsSync(path.join(gitDir, f))) p.push(`the clone has .git/${f}: make a fresh clone`);
  const exclude = path.join(gitDir, "info", "exclude");
  if (existsSync(exclude) && readFileSync(exclude, "utf8").split("\n").some((l) => l.trim() && !l.startsWith("#"))) p.push("the clone's .git/info/exclude holds a pattern: make a fresh clone");
  p.push(...objectProblems(git, commit));
  if (onMain) {
    const url = config.find((l) => l.startsWith("remote.origin.url="))?.slice("remote.origin.url=".length);
    if (url !== REPO && url !== `${REPO}.git`) p.push(`the clone's origin is ${url ?? "none"}, not ${REPO}`);
    else if (p.length === 0) p.push(...mainProblems(git, commit, remote));
  }
  // the commit's tree, every entry: mode, type, id, path
  const tree = new Map();
  for (const rec of git("ls-tree", "-r", "-z", "--full-tree", commit).split("\0").filter(Boolean)) {
    const [meta, file] = [rec.slice(0, rec.indexOf("\t")), rec.slice(rec.indexOf("\t") + 1)];
    const [mode, type, id] = meta.split(" ");
    tree.set(file, { mode, type, id });
  }
  const dirs = new Set([""]);
  for (const f of tree.keys()) for (let d = path.posix.dirname(f); d !== "."; d = path.posix.dirname(d)) dirs.add(d);
  const changed = [];
  for (const [file, e] of tree) {
    const abs = path.join(root, file);
    if (e.type === "commit") {
      // a submodule: a fresh clone leaves its folder empty, and nothing the run loads is in one
      if (existsSync(abs) && (!lstatSync(abs).isDirectory() || readdirSync(abs).length)) changed.push(`${file} (a submodule with content)`);
      continue;
    }
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      changed.push(`${file} (missing)`);
      continue;
    }
    if (e.mode === "120000" || !st.isFile() || blobId(readFileSync(abs)) !== e.id) changed.push(file);
  }
  // every path on disk the commit does not hold: only pnpm's node_modules folders, once installed
  const strays = [];
  const walk = (rel) => {
    for (const d of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (r === ".git") continue;
      if (tree.has(r)) continue;
      if (installed && MODULES.test(r) && d.isDirectory()) continue;
      if (dirs.has(r) && d.isDirectory() && !d.isSymbolicLink()) walk(r);
      else strays.push(r);
    }
  };
  walk("");
  if (changed.length) p.push(`${changed.length} file(s) differ from commit ${commit.slice(0, 12)} (${changed.slice(0, 3).join(", ")}): make a fresh clone`);
  if (strays.length) p.push(`${strays.length} path(s) the commit does not hold (${strays.slice(0, 3).join(", ")}): make a fresh clone`);
  if (installed) {
    const real = realpathSync(root);
    const links = [];
    for (const d of dirs) {
      const m = d ? `${d}/node_modules` : "node_modules";
      if (MODULES.test(m) && existsSync(path.join(real, m)) && lstatSync(path.join(real, m)).isDirectory()) links.push(...linksOutside(real, m));
    }
    for (const l of links.slice(0, 3)) p.push(`${l} links outside the clone: make a fresh clone`);
    if (links.length > 3) p.push(`${links.length - 3} more link(s) under node_modules point outside the clone`);
    p.push(...moduleProblems(root));
  }
  return p;
}

/** [] when `commit` is an ancestor of main as `remote` answers it now: its sha read by ls-remote, fetched when the clone lacks it. */
function mainProblems(git, commit, remote) {
  const no = (why) => [`commit ${commit} is not on ${REPO}'s main (${why}): the paste runs only a reviewed, merged commit`];
  let lines;
  try {
    lines = git("ls-remote", "--", remote, "refs/heads/main").split("\n").filter(Boolean);
  } catch (e) {
    return [`${REPO}'s main was not read (git ls-remote: ${String(e.stderr || e.message).trim().split("\n")[0]}): nothing signed, paste the line again`];
  }
  // ls-remote matches the pattern at a ref's tail (a pushed a/refs/heads/main is listed too): main is the one line whose
  // ref is exactly refs/heads/main
  const exact = lines.map((l) => l.split("\t")).filter((f) => f.length === 2 && f[1] === "refs/heads/main");
  if (exact.length !== 1) return no(`ls-remote names ${exact.length} refs/heads/main`);
  const main = exact[0][0];
  if (!/^[0-9a-f]{40}$/.test(main)) return no("ls-remote names no main");
  const has = () => {
    try {
      git("cat-file", "-e", `${main}^{commit}`);
      return true;
    } catch {
      return false;
    }
  };
  if (!has()) {
    try {
      git("fetch", "-q", "--no-tags", "--", remote, "refs/heads/main");
    } catch {}
    if (!has()) return [`${REPO}'s main ${main} could not be fetched into the clone: nothing signed, paste the line again`];
  }
  try {
    git("merge-base", "--is-ancestor", commit, main);
  } catch {
    return no(`not an ancestor of main ${main.slice(0, 12)}`);
  }
  return [];
}

/** [] when what the run loads from node_modules resolves inside the clone (realpath), the workspace's kit to its own packages/kit. */
export function moduleProblems(root) {
  const real = realpathSync(root);
  const inside = (f, under) => f === under || f.startsWith(under + path.sep);
  const p = [];
  const want = [
    ["packages/wallet/src/deposit/bind.ts", "@blindfill/kit", path.join(real, "packages", "kit")],
    ["packages/kit/package.json", "snarkjs", path.join(real, "node_modules", ".pnpm")],
    ["packages/wallet/package.json", "fake-indexeddb", path.join(real, "node_modules", ".pnpm")],
  ];
  for (const [from, name, under] of want) {
    let f;
    try {
      f = realpathSync(createRequire(path.join(real, from)).resolve(name));
    } catch (e) {
      p.push(`${name} does not resolve from ${from}: run pnpm install --frozen-lockfile in the clone (${String(e.message).split("\n")[0]})`);
      continue;
    }
    if (!inside(f, under)) p.push(`${name} from ${from} resolves to ${f}, outside ${path.relative(real, under) || "."} of the clone`);
  }
  return p;
}

/** The CLI's flags: --commit, and --not-on-main only with --network testnet. */
export function gateArgs(argv) {
  const v = { commit: undefined, network: "mainnet", notOnMain: false, beforeInstall: false };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === "--commit") v.commit = argv[++k];
    else if (a === "--network") v.network = argv[++k];
    else if (a === "--not-on-main") v.notOnMain = true;
    else if (a === "--before-install") v.beforeInstall = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (v.network !== "mainnet" && v.network !== "testnet") throw new Error("--network: mainnet or testnet");
  if (v.notOnMain && v.network !== "testnet") throw new Error("--not-on-main is for the testnet rehearsal only: a mainnet paste runs only a commit on main");
  return v;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let p;
  try {
    const v = gateArgs(process.argv.slice(2));
    p = cloneProblems({ root: process.cwd(), commit: v.commit, onMain: !v.notOnMain, installed: !v.beforeInstall });
  } catch (e) {
    p = [e.message];
  }
  if (p.length) {
    console.error(`refused, nothing signed: ${p.join("; ")}`);
    process.exit(1);
  }
}
