#!/usr/bin/env node
// Writes a release's list: every file SIGN_HOST and APP_HOST serve, at its published path, with its size, sha256 and
// sha384 and the headers its _headers rules give it, plus each host's _headers file itself (wallet.md W4.5 and §2.7
// items 3-4, W:852-858; E2E-22). The list is made from this checkout's own builds, by the hosts' own build steps:
// SIGN_HOST's is deploy.mjs build() (index.html, public/ and the prover's setup files), APP_HOST's is the terminal
// deploy's build(), its `vite build` into an empty folder (its SRI plugin, card app-release-sri); each build must pass its own deploy gate
// first. So anyone with the release tag can run this at the tag and get the same list, byte for byte.
// check-signpage.mjs reads both hosts over HTTPS against the list.
//   node packages/signpage/scripts/release-list.mjs <release-N>        writes packages/signpage/releases/<release-N>.json
//   node packages/signpage/scripts/release-list.mjs --check (release-<N> | --list <file>)
//     exit 1 when a fresh build of the hosts the list holds differs from it
//   node packages/signpage/scripts/release-list.mjs --print [--host sign|app]
//     this checkout's own build's list (named build-<sha>), for both hosts or the one asked, to stdout: what a deploy
//     from this commit serves, which the live check after a deploy reads that host against
// Writing refuses a release that is already written (a release is never written again, card signpage-withdraw-form)
// and a tree with uncommitted changes outside releases/, since the list names the tree it was built from: `tree` (git
// rev-parse HEAD^{tree}) beside `commit`. On the remote test machine (its job runner sets HEAVY_JOB) the checkout's commit is made
// up for the job, so a list cut there names its tree only (commit null); the tree is the Mac's, byte for byte, and the
// verify gate (scripts/ci/verify-gate.mjs) holds every new list's tree to a commit of the pull request.
// RELEASED is the ledger of every written list's sha256: releaseProblems() fails an old list edited after it was
// written, a list missing from the ledger, and a newest list whose SIGN_HOST part is not a fresh deploy.mjs build of
// this checkout (every file, every header, the _headers file), so a page change lands with its own release-<N+1>,
// written here and added to RELEASED by hand; the verify gate refuses a change to a list or a ledger entry on main.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDir as checkApp } from "../../../apps/terminal/scripts/check-deploy.ts";
import { build as buildTerminal } from "../../../apps/terminal/scripts/deploy.mjs";
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

/** APP_HOST's build: the terminal deploy's own build() (its `vite build` into an empty folder), so the list and the
 *  deploy are one build; it installs nothing (a deploy installs first). */
function buildApp(repo) {
  const b = buildTerminal(process.env, spawnSync, repo);
  return { dir: b.dir, problems: b.problems.length ? b.problems : checkApp(b.dir) };
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

export const listPath = (tag, releases = RELEASES) => join(releases, `${tag}.json`);

/** Every written release list's sha256, as written: a list is never edited after (releaseProblems). */
export const RELEASED = Object.freeze({
  "release-1": "c8ffda0045fc1a814abea60ee8f0815cfd995e6c670b98e68b0c1e2f144ac3bc",
  "release-2": "05b618a384bbbb799ee9274611eaae07fbf8ebad3dedcba9ffc1100ec3c7073f",
  "release-3": "e764eebd5791cd91a644491fbe8819c79a45e145cd6675be353a31d566a3a68e",
  "release-4": "8193ae5a3ca8f329c6f6ef69b345cede9c27822acbddd216353d9e9d88671d2c",
  "release-5": "45d232b55ff0ddc2ab04093b209ba68c0732aef726a39fcf656b69cee68577cc",
  "release-6": "149fa1881f3916cc7c61c0e252136521228f79e22032a04c030f20d9ac5b5d9f",
  "release-7": "3cfbdb08286fb3083aa761f9fe28442cecfa8f1c77bac7e5f86026aadd6a3a63",
  "release-8": "098a30323b1b5ef4fadddd6aaa90724ccbb0aa87570d505636fc70057f89d98a",
  "release-9": "cedcd955c26364ea2b7bec862581b5ba725756788825430cb5dec23bfc077f78",
  "release-11": "60cbfd1024a316ba34bec78fd8cb71ab880340b03b427a784e895084e6c3efd6",
  "release-12": "6d54691cf78370b6afa438fe1c4c8833913ada26b287d813f961bfc986f8541c",
  "release-13": "9cce86b67f5230679fec7acc6a666c1540db896f8ca9fea5250d549eb5df628b",
  "release-16": "78c9ecf0f82394728e80646a957adb11a6a6528ff702ffba4f8b791390a00633",
  "release-18": "f9bd72f199a3eaee2bee78d56071bb921a61043a4f274fcdb77477b51ac6aeca",
  "release-19": "00e776b6fc9dbfc92c4528707a09834461e33bf04c3ad85e5958b057a8350bac",
  "release-20": "b7b5d889acb1d9eaee8dd476e4470c0b16e7d824c4b8d2e93b250eb34aa4c229",
  "release-21": "c50697858be001dec320baa55c5275fb5a75126d77271de6427af792b3924a82",
  "release-22": "b56d4ae1dc0569354c52f09b427697e7915ceb63f412c215aaf5b1693db87645",
  "release-23": "c60ed8eafce2bac7f4c847423105390307debed6723e677141802bb21d8f58d0",
  "release-24": "1aaeb1332d244e7e594df3adfb431520b169d4396e3a3b2c6fa13b2e689553fe",
  "release-25": "b0c73924984127841b7e2529c993a0a0209564cab90f0664aa3076e436f916aa",
  "release-26": "b025c4b049e9cf459aea916dc4142aa168d0a7560eaef05004bb44ecb6611fef",
  "release-27": "9e806cf3e5d2d2dd6691ea1e34dae9ff0daf8e09367d7cc64765322bde61405b",
  "release-28": "7e1d43c924ae94f5289e6effccf9f572a77b8ade67f6e299f75f87ceb1e00996",
  "release-29": "bdecdc553a1ddd3c24cd150684e11327bb93a23014419795c29b1f35672e4641",
  "release-30": "dbeb707c7be58047f8fa6c2afb46afe6131bef17512302e7a52729c62262e175",
  "release-31": "0295765661ccd4ad91b12bb83d1292b6f10bd709cfe135d34ee659c562df09c9",
  "release-32": "cc2e1256ef4ff7d978795f9cc2d5a126ad4f647f84632a0ebd17d46834ac0687",
  "release-33": "14241b8aaf6bca3ed02c12535c4ad0b9a22affebb076fa56cce745c16e77375a",
  "release-34": "6decfb368ca912256c14e95d7b8427a841f0cdb6bedf8e8b6b3697302dbd362e",
  "release-35": "e141dcb58380239b94ed6927507af5261c8bf359a15c3f6280e228305e592ff1",
  "release-36": "e08b3f3c080f17dede9621d5c3f7463c03db43be11238939fb23df0f0fd98f30",
  "release-37": "f4392e7e226aae17b84a4519b265fdf43e0f164fd701865d3a3e52408daab7d3",
  "release-39": "f60289ddf282e43e5e5f8dd2893276df963d4e9c523b0ff1b9d8ff624eb2011a",
  "release-41": "7554d6b0a0e0f86a7c5fe2680ded5db006da529587f0156aeff678daa39d31dc",
  "release-42": "2dfcf2b0f6eaac31e27fda7020167a7ab1dac5b5f99c1fdf7ffe19554717b0b6",
  "release-46": "9514bd35e9d68f1943a269fdd45e9efa8adc562579b1b4c7f21883d85d994d2d",
  "release-47": "f4e0d0cdb7a53b485ddd45a42f31d1899f44014730db37371260241f27516aad",
  "release-49": "c4dc252649717c339ae205f6b8ef84bbabd26502173f6feeab892fb2f0d27c5c",
  "release-51": "ab052741855a43361b31791a9ce7edb7b889fe6feaa74687545c6d8a24937cf8",
  "release-52": "68cb2916025d917e1d43b1ab0f2cbae1ab6773d8d9af963dd8d532c31aafc2f8",
  "release-53": "a189503ba2543abfb8d491b1ca6630e6e874bfee544039605059ed8822232da8",
  "release-54": "17bdff52d22255338e256b49ff33228c041b3384d91e48affc91d09dcfb50490",
  "release-55": "b5b49005bf656379c04f7e15d972c7ffc81c86081f50348da82ab5193b4989ad",
  "release-56": "f2cfffc99a86955c532ef44d1a9c54cc075ccb1bc4310ddc4265aef637fb9f61",
  "release-57": "9cea40159097f6452ce31666eff68a5ff701d00663c508cc09ec83b0695c4520",
  "release-58": "3d77402927879a4d9c53204f65635e29fbf4d43969b0abfe458e02f57a826496",
  "release-59": "ead23ca5536a11bf9e971fc7e50c8810c46f9bde3586b7ee41b3728c06d1726b",
  "release-60": "8a87b793edfbdc646ecd4d08e0995b4dc70dc70e0cad904605b9a674bfa21ebf",
  "release-61": "caf2aa0a1df7489fda915d8cc345a9e23ee7a29a048311583cd17c9fe8cc900f",
  "release-62": "b7a91bcb05730945f66e86fccfc7ba1df89f51e0c1a2426a9d30c6230891b9c2",
  "release-63": "27f3718f552962e29fe44822d5af2c6dd079ac6e414c5eccad85ec11b0d45e3d",
  "release-64": "949f18de379a5d21272f03178592e04012fd94106330c80470b53e6254ab3de2",
  "release-65": "a0e2454195502d2a99bfb1638ed507d3003ccbc29cc334f4ab83114f66d5bbca",
  "release-66": "2772a7fcc77e639ae77c10a784e1c6a94e0a0fecc8c38bd9395e5617b567e2b9",
  "release-68": "35d96e1ad9a46b9d2d054fcf3214dfe21fbc2e629e6c0428e8f460a9e3503ba8",
  "release-69": "76deff2f6fcf4abae76e1b0ebe820fcbe2c016d631dd554e476c71735bbd62e4",
  "release-72": "b2edf1616a997c86b2dd01ae711be8bb0ee194af2c0362e960571d82033a80ff",
  "release-73": "d6c6e603a75b6847d91b855bc2e95b48075b44479621d446a76a578385e95ac1",
  "release-75": "2c82306970f87a9bc5fc158a8de907ae27e407bcf3486a4172901fa1d941472a",
  "release-78": "e2e8455825a7775c3ae5eab38a200bdf292afd440f86e91ffd0359d7e250829e",
  "release-83": "747ade890c861f20a8eb6a828899f313e5333519025b38b7cdee5629cd09c9ab",
  "release-84": "057cd64dcf8bd9f7a31c2fa958f0d481e1090bb40e5c16c2a5e823681c55c2fb",
  "release-85": "63a33be5c014f7060833663110c6fe031b5fdaa6732509646b8cfda4ad1919fc",
  "release-86": "93c596770fadf1edbe4e11526f835434167281d42d16f4948057f2995ebbe5cf",
  "release-87": "ac96b156de92e1525ef17fd677b03ad6e1f6d934574ff7ddcbc611dff6d2c0e4",
  "release-88": "182bcc9a44535bce5c96cb35813b985e38565657ecbad9345a7769bee14c18fd",
  "release-89": "1afa107d76c63671db7b5813c418dcea513adefe78015e6c8552dc6538b87e42",
  "release-90": "7d10eb1ea222536cacf30298c7ee804fdafef63330047337fa30d2ae45cb1135",
  "release-91": "f1fd4de18a2fd09f640a9d6adc7e54b9b03503cb4d0f72313ecf854d528220ce",
  "release-94": "cea5443d805f3cf3b56a32e432d4911a47204d8c2d6d7752c99fa2f1a9a3d4e5",
});

/**
 * Problems with the release lists in `dir` against `ledger` and SIGN_HOST's build from the package folder `pkg`: an
 * old list edited, a list not in the ledger or a ledger entry with no list, and a newest list whose SIGN_HOST part is
 * not a fresh deploy.mjs build() of `pkg` (empty = none).
 */
export function releaseProblems(dir = RELEASES, ledger = RELEASED, pkg = PKG) {
  const p = [];
  const tags = readdirSync(dir).map((f) => /^(release-[1-9][0-9]*)\.json$/.exec(f)?.[1]).filter(Boolean);
  for (const tag of tags) {
    const sha = hash("sha256", readFileSync(join(dir, `${tag}.json`)), "hex");
    if (!Object.hasOwn(ledger, tag)) p.push(`${tag} is not in RELEASED: add its sha256 ${sha}`);
    else if (ledger[tag] !== sha) p.push(`${tag} was edited after it was written (sha256 ${sha}, written ${ledger[tag]})`);
  }
  for (const tag of Object.keys(ledger)) if (!tags.includes(tag)) p.push(`${tag} is in RELEASED but its list is gone`);
  if (!tags.length) return [...p, "no release list"];
  const newest = tags.sort((a, b) => Number(a.slice(8)) - Number(b.slice(8))).at(-1);
  const listed = JSON.parse(readFileSync(join(dir, `${newest}.json`), "utf8"));
  const built = buildSign(pkg);
  try {
    for (const l of diffLists(makeList(newest, { SIGN_HOST: built }, null), listed))
      p.push(`${newest} is not this checkout's SIGN_HOST build (${l}): write release-${Number(newest.slice(8)) + 1}`);
  } finally {
    rmSync(built, { recursive: true, force: true });
  }
  return p;
}

const git = (...args) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).stdout.trim();
const uncommitted = () => git("status", "--porcelain", "--", ".", ":!packages/signpage/releases");

/** The list of this checkout's own build, in memory, for the hosts named: what a deploy from this commit serves. */
export function headList(names = Object.keys(HOSTS)) {
  const commit = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const dirs = buildHosts(names);
  try {
    const list = makeList(`build-${commit.slice(0, 12)}${uncommitted() ? "-dirty" : ""}`, dirs, process.env.HEAVY_JOB ? null : commit);
    return { release: list.release, commit: list.commit, tree, hosts: list.hosts };
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
export function main(a, releases = RELEASES) {
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
    return p.length ? { code: 1, err: p } : { code: 0, out: [`a fresh build of ${(fresh.commit ?? fresh.tree).slice(0, 7)} equals ${listed.release}'s list`] };
  }
  if (a.length !== 1 || !TAG.test(a[0])) return usage;
  if (existsSync(listPath(a[0], releases))) return { code: 1, err: [`${a[0]} is already written: a release is never written again`] };
  const dirty = uncommitted();
  if (dirty) return { code: 1, err: [`uncommitted changes, so the list could not name its tree:\n${dirty}`] };
  const list = headList();
  list.release = a[0];
  writeFileSync(listPath(a[0], releases), `${JSON.stringify(list, null, 1)}\n`);
  return { code: 0, out: Object.entries(list.hosts).map(([name, h]) => `${a[0]} ${name} ${h.files.length} files, _headers ${h.headers_file.sha256}`) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = main(process.argv.slice(2));
  const print = process.argv[2] === "--print";
  for (const l of r.out ?? []) console.log(print ? l : `release-list: ${l}`);
  for (const l of r.err ?? []) console.error(`release-list: ${l}`);
  process.exitCode = r.code;
}
