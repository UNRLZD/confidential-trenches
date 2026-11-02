#!/usr/bin/env node
// Writes a release's list: every file SIGN_HOST and APP_HOST serve, at its published path, with its size, sha256 and
// sha384 and the headers its _headers rules give it, plus each host's _headers file itself (wallet.md W4.5 and §2.7
// items 3-4, W:852-858; E2E-22). The list is made from this checkout's own builds, by the hosts' own build steps:
// SIGN_HOST's is deploy.mjs build() (index.html, public/ and the prover's setup files), APP_HOST's is the terminal's
// `vite build` into an empty folder (its SRI plugin, card app-release-sri); each build must pass its own deploy gate
// first. So anyone with the release tag can run this at the tag and get the same list, byte for byte.
// check-signpage.mjs reads both hosts over HTTPS against the list.
//   node packages/signpage/scripts/release-list.mjs <release-N>        writes packages/signpage/releases/<release-N>.json
//   node packages/signpage/scripts/release-list.mjs --check (release-<N> | --list <file>)
//     exit 1 when a fresh build of the hosts the list holds differs from it
//   node packages/signpage/scripts/release-list.mjs --print [--host sign|app]
//     this checkout's own build's list (named build-<sha>), for both hosts or the one asked, to stdout: what a deploy
//     from this commit serves, which the live check after a deploy reads that host against
// Writing refuses a tree with uncommitted changes outside releases/, since the list names the commit it was built from.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDir as checkApp } from "../../../apps/terminal/scripts/check-deploy.ts";
import { HOST_ARGS, readList, RELEASES, TAG } from "./check-signpage.mjs";
import { build as buildSign, checkDir as checkSign } from "./deploy.mjs";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = dirname(dirname(PKG));
export const HOSTS = Object.freeze({ SIGN_HOST: "https://sign.confidential.unrealized.trade", APP_HOST: "https://confidential.unrealized.trade" });
// Pages reads these from the build as configuration and serves none of them (Cloudflare Pages docs: headers, redirects,
// routing, Functions); each host's gate refuses _worker.js, and a build with any other one is refused below
const CONFIG = ["_headers", "_redirects", "_routes.json", "_worker.js"];

const hash = (alg, bytes, enc) => createHash(alg).update(bytes).digest(enc);
export const digests = (bytes) => ({ bytes: bytes.length, sha256: hash("sha256", bytes, "hex"), sha384: `sha384-${hash("sha384", bytes, "base64")}` });

/** A _headers file's rules in file order: [{ path, headers: [[name lower case, value]] }]. */
export function parseRules(text) {
  const rules = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) rules.push({ path: line.trim(), headers: [] });
    else {
      const kv = /^\s+([^:\s!]+):\s*(.*)$/.exec(line);
      if (!kv || !rules.length) throw new Error(`_headers line cannot be read: ${JSON.stringify(line)}`);
      rules.at(-1).headers.push([kv[1].toLowerCase(), kv[2].trim()]);
    }
  }
  return rules;
}

/** Does a _headers rule's URL pattern match `path`: a splat (*) matches any run of characters, :name one segment. */
export function matches(pattern, path) {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/:[A-Za-z]\w*/g, "[^/]+");
  return new RegExp(`^${re}$`).test(path);
}

/** The headers `path` is served with: every matching rule in file order, one header's values joined with ", " as Pages joins them. */
export function headersFor(rules, path) {
  const out = {};
  for (const r of rules) if (matches(r.path, path)) for (const [k, v] of r.headers) out[k] = k in out ? `${out[k]}, ${v}` : v;
  return out;
}

/** The path Pages serves a build file at: index.html at its folder's path, every other file at its own. */
export function publishedPath(rel) {
  const p = `/${rel.split(sep).join("/")}`;
  if (p.endsWith("/index.html")) return p.slice(0, -"index.html".length);
  if (p.endsWith(".html")) throw new Error(`${p}: Pages serves an .html file at a path without .html; the list names only index.html pages`);
  return p;
}

/** One host's part of the list from a build folder: { headers_file, files: [{ path, bytes, sha256, sha384, headers }] } by path. */
export function listDir(dir) {
  const rels = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else rels.push(relative(dir, f));
    }
  };
  walk(dir);
  if (!rels.includes("_headers")) throw new Error(`${dir}: no _headers file`);
  const extra = rels.filter((r) => CONFIG.includes(r) && r !== "_headers");
  if (extra.length) throw new Error(`${dir}: carries ${extra.join(", ")}, which the list does not model`);
  const headersText = readFileSync(join(dir, "_headers"));
  const rules = parseRules(headersText.toString("utf8"));
  const files = rels
    .filter((r) => r !== "_headers")
    .map((r) => {
      const path = publishedPath(r);
      return { path, ...digests(readFileSync(join(dir, r))), headers: headersFor(rules, path) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { headers_file: digests(headersText), files };
}

/** APP_HOST's build: the terminal's own `vite build` into an empty folder. */
function buildApp(repo) {
  const app = mkdtempSync(join(tmpdir(), "ct-release-app-"));
  const term = join(repo, "apps", "terminal");
  const vite = join(term, "node_modules", "vite", "bin", "vite.js");
  const r = spawnSync(process.execPath, [vite, "build", "--outDir", app, "--emptyOutDir", "--logLevel", "warn"], { cwd: term, encoding: "utf8" });
  return { dir: app, problems: r.status !== 0 ? [`vite build failed (exit ${r.status ?? r.signal}): ${r.stderr}`] : checkApp(app) };
}

/** Builds the hosts named (both by default) with their own build steps, each passed by its own deploy gate: { [name]: dir }. */
export function buildHosts(names = Object.keys(HOSTS), repo = REPO) {
  const dirs = {};
  const p = [];
  try {
    for (const name of Object.keys(HOSTS).filter((n) => names.includes(n))) {
      if (name === "SIGN_HOST") {
        dirs.SIGN_HOST = buildSign();
        p.push(...checkSign(dirs.SIGN_HOST).map((x) => `SIGN_HOST: ${x}`));
      } else {
        const b = buildApp(repo);
        dirs.APP_HOST = b.dir;
        p.push(...b.problems.map((x) => `APP_HOST: ${x}`));
      }
    }
  } catch (e) {
    removeBuilds(dirs);
    throw e;
  }
  if (p.length) {
    removeBuilds(dirs);
    throw new Error(`a build its deploy gate refuses:\n${p.join("\n")}`);
  }
  return dirs;
}

export const removeBuilds = (dirs) => Object.values(dirs).forEach((d) => rmSync(d, { recursive: true, force: true }));

/** A list's name: release-<N> for a tagged release, build-<sha> for a checkout's own build (-dirty with uncommitted changes). */
export const NAME = /^(release-[1-9][0-9]*|build-[0-9a-f]{12}(-dirty)?)$/;

/** The list named `name` from the build folders in `dirs` (the hosts it holds, in HOSTS' order). */
export function makeList(name, dirs, commit) {
  if (!NAME.test(name)) throw new Error(`${name}: a release is named release-<N>, N from 1`);
  const hosts = {};
  for (const [host, origin] of Object.entries(HOSTS)) if (dirs[host]) hosts[host] = { origin, ...listDir(dirs[host]) };
  if (!Object.keys(hosts).length) throw new Error("no host built");
  return { release: name, commit, hosts };
}

/** Lines where `fresh` and `listed` differ for the hosts `fresh` holds, the commit left out (empty = the same files and headers). */
export function diffLists(fresh, listed) {
  const p = [];
  for (const name of Object.keys(fresh.hosts)) {
    const a = fresh.hosts[name];
    const b = listed.hosts?.[name];
    if (!b) {
      p.push(`${name}: not in the list`);
      continue;
    }
    if (JSON.stringify(a.headers_file) !== JSON.stringify(b.headers_file)) p.push(`${name} _headers: the build's is not the list's`);
    const byPath = new Map(b.files.map((f) => [f.path, f]));
    for (const f of a.files) {
      const l = byPath.get(f.path);
      if (!l) p.push(`${name} ${f.path}: built, not in the list`);
      else if (JSON.stringify(f) !== JSON.stringify(l)) p.push(`${name} ${f.path}: the build's ${f.sha256} is not the list's ${l.sha256}, or its headers differ`);
      byPath.delete(f.path);
    }
    for (const path of byPath.keys()) p.push(`${name} ${path}: in the list, not built`);
  }
  return p;
}

export const listPath = (tag) => join(RELEASES, `${tag}.json`);

const git = (...args) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).stdout.trim();
const uncommitted = () => git("status", "--porcelain", "--", ".", ":!packages/signpage/releases");

/** The list of this checkout's own build, in memory, for the hosts named: what a deploy from this commit serves. */
export function headList(names = Object.keys(HOSTS)) {
  const commit = git("rev-parse", "HEAD");
  const dirs = buildHosts(names);
  try {
    return makeList(`build-${commit.slice(0, 12)}${uncommitted() ? "-dirty" : ""}`, dirs, commit);
  } finally {
    removeBuilds(dirs);
  }
}

const USAGE = [
  "usage: node packages/signpage/scripts/release-list.mjs release-<N>                     write the list",
  "       node packages/signpage/scripts/release-list.mjs --check (release-<N> | --list <file>)",
  "       node packages/signpage/scripts/release-list.mjs --print [--host sign|app]       this checkout's build's list, to stdout",
].join("\n");

/** The command line: { code, out, err } (no process.exit inside, so every build is removed before the process ends). */
export function main(a) {
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  const usage = { code: 2, err: [USAGE] };
  if (a[0] === "--print") {
    const host = opt("--host");
    if (a.length !== (host === undefined ? 1 : 3) || (host !== undefined && !HOST_ARGS[host])) return usage;
    return { code: 0, out: [JSON.stringify(headList(host ? [HOST_ARGS[host]] : undefined), null, 1)] };
  }
  if (a[0] === "--check") {
    const file = opt("--list");
    const tag = file === undefined ? a[1] : undefined;
    if (a.length !== (file === undefined ? 2 : 3) || (tag !== undefined && !TAG.test(tag))) return usage;
    if (file === undefined && !existsSync(listPath(tag))) return { code: 2, err: [`no list ${listPath(tag)}`] };
    const listed = file === undefined ? readList(tag) : JSON.parse(readFileSync(file, "utf8"));
    const fresh = headList(Object.keys(listed.hosts ?? {}));
    const p = diffLists(fresh, listed);
    return p.length ? { code: 1, err: p } : { code: 0, out: [`a fresh build of ${fresh.commit.slice(0, 7)} equals ${listed.release}'s list`] };
  }
  if (a.length !== 1 || !TAG.test(a[0])) return usage;
  const dirty = uncommitted();
  if (dirty) return { code: 1, err: [`uncommitted changes, so the list could not name its commit:\n${dirty}`] };
  const list = headList();
  list.release = a[0];
  writeFileSync(listPath(a[0]), `${JSON.stringify(list, null, 1)}\n`);
  return { code: 0, out: Object.entries(list.hosts).map(([name, h]) => `${a[0]} ${name} ${h.files.length} files, _headers ${h.headers_file.sha256}`) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = main(process.argv.slice(2));
  const print = process.argv[2] === "--print";
  for (const l of r.out ?? []) console.log(print ? l : `release-list: ${l}`);
  for (const l of r.err ?? []) console.error(`release-list: ${l}`);
  process.exitCode = r.code;
}
