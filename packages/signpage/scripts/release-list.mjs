#!/usr/bin/env node
// Writes a release's list: every file SIGN_HOST and APP_HOST serve, at its published path, with its size, sha256 and
// sha384 and the headers its _headers rules give it, plus each host's _headers file itself (wallet.md W4.5 and §2.7
// items 3-4, W:852-858; E2E-22). The list is made from this checkout's own builds, by the hosts' own build steps:
// SIGN_HOST's is deploy.mjs build() (index.html, public/ and the prover's setup files), APP_HOST's is the terminal's
// `vite build` into an empty folder (its SRI plugin, card app-release-sri); each build must pass its own deploy gate
// first. So anyone with the release tag can run this at the tag and get the same list, byte for byte.
// check-signpage.mjs reads both hosts over HTTPS against the list.
//   node packages/signpage/scripts/release-list.mjs <release-N>           writes packages/signpage/releases/<release-N>.json
//   node packages/signpage/scripts/release-list.mjs --check <release-N>   exit 1 when a fresh build differs from the list
// Writing refuses a tree with uncommitted changes outside releases/, since the list names the commit it was built from.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDir as checkApp } from "../../../apps/terminal/scripts/check-deploy.ts";
import { build as buildSign, checkDir as checkSign } from "./deploy.mjs";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = dirname(dirname(PKG));
export const RELEASES = join(PKG, "releases");
export const TAG = /^release-[1-9][0-9]*$/;
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

/** Builds both hosts with their own build steps, each passed by its own deploy gate: { SIGN_HOST: dir, APP_HOST: dir }. */
export function buildHosts(repo = REPO) {
  const sign = buildSign();
  const app = mkdtempSync(join(tmpdir(), "ct-release-app-"));
  const term = join(repo, "apps", "terminal");
  const vite = join(term, "node_modules", "vite", "bin", "vite.js");
  const r = spawnSync(process.execPath, [vite, "build", "--outDir", app, "--emptyOutDir", "--logLevel", "warn"], { cwd: term, encoding: "utf8" });
  const dirs = { SIGN_HOST: sign, APP_HOST: app };
  const p = r.status !== 0 ? [`APP_HOST: vite build failed (exit ${r.status ?? r.signal}): ${r.stderr}`] : [];
  p.push(...checkSign(sign).map((x) => `SIGN_HOST: ${x}`), ...(r.status === 0 ? checkApp(app).map((x) => `APP_HOST: ${x}`) : []));
  if (p.length) {
    removeBuilds(dirs);
    throw new Error(`a build its deploy gate refuses:\n${p.join("\n")}`);
  }
  return dirs;
}

export const removeBuilds = (dirs) => Object.values(dirs).forEach((d) => rmSync(d, { recursive: true, force: true }));

/** The list for `tag` from the two build folders. */
export function makeList(tag, dirs, commit) {
  if (!TAG.test(tag)) throw new Error(`${tag}: a release is named release-<N>, N from 1`);
  const hosts = {};
  for (const [name, origin] of Object.entries(HOSTS)) hosts[name] = { origin, ...listDir(dirs[name]) };
  return { release: tag, commit, hosts };
}

/** Lines where `fresh` and `listed` differ, the commit left out (empty = the same files and headers). */
export function diffLists(fresh, listed) {
  const p = [];
  for (const name of Object.keys(HOSTS)) {
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

/** The newest release list in releases/ by N, or the one named. */
export function readList(tag = null) {
  if (!tag) {
    const n = readdirSync(RELEASES).map((f) => /^release-([1-9][0-9]*)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number);
    if (!n.length) throw new Error(`no release list in ${RELEASES}`);
    tag = `release-${Math.max(...n)}`;
  }
  if (!TAG.test(tag)) throw new Error(`${tag}: a release is named release-<N>, N from 1`);
  return JSON.parse(readFileSync(listPath(tag), "utf8"));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const checking = a[0] === "--check";
  const tag = checking ? a[1] : a[0];
  if (!tag || !TAG.test(tag) || a.length !== (checking ? 2 : 1)) {
    console.error("usage: node packages/signpage/scripts/release-list.mjs [--check] release-<N>");
    process.exit(2);
  }
  const git = (...args) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).stdout.trim();
  const dirty = git("status", "--porcelain", "--", ".", ":!packages/signpage/releases");
  if (!checking && dirty) {
    console.error(`release-list: uncommitted changes, so the list could not name its commit:\n${dirty}`);
    process.exit(1);
  }
  const dirs = buildHosts();
  try {
    const fresh = makeList(tag, dirs, git("rev-parse", "HEAD"));
    if (checking) {
      if (!existsSync(listPath(tag))) throw new Error(`no list ${listPath(tag)}`);
      const p = diffLists(fresh, readList(tag));
      for (const l of p) console.error(`release-list: ${l}`);
      if (!p.length) console.log(`release-list: a fresh build of ${fresh.commit.slice(0, 7)} equals ${tag}'s list`);
      process.exit(p.length ? 1 : 0);
    }
    writeFileSync(listPath(tag), `${JSON.stringify(fresh, null, 1)}\n`);
    for (const [name, h] of Object.entries(fresh.hosts)) console.log(`release-list: ${tag} ${name} ${h.files.length} files, _headers ${h.headers_file.sha256}`);
  } finally {
    removeBuilds(dirs);
  }
}
