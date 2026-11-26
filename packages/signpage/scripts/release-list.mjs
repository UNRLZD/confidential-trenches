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
//   node packages/signpage/scripts/release-list.mjs --print [--host sign|app [--build <dir>]]
//     this checkout's own build's list (named build-<sha>), for both hosts or the one asked, to stdout: what a deploy
//     from this commit serves, which the live check after a deploy reads that host against; with --build, the list of
//     that build folder as the host's, built by nothing here
//   node packages/signpage/scripts/release-list.mjs --unreleased <dir> --host sign|app [--releases <dir> --ledger <file>]
//     exit 1, one line each, when the newest committed list (or the newest in --releases, against the ledger in --ledger,
//     a JSON file) does not name the build folder <dir> as that host's (unreleasedProblems), 0 when it does: what the
//     terminal deploy runs (apps/terminal/scripts/deploy.mjs, card app-deploy-refuses-an-unlisted-build), as a command,
//     since a file outside packages/ imports nothing of it (.dependency-cruiser.cjs)
// Writing refuses a release that is already written (a release is never written again, card signpage-withdraw-form)
// and a tree with uncommitted changes outside releases/, since the list names the tree it was built from: `tree` (git
// rev-parse HEAD^{tree}) beside `commit`. On the remote test machine (its job runner sets HEAVY_JOB) the checkout's commit is made
// up for the job, so a list cut there names its tree only (commit null); the tree is the Mac's, byte for byte, and the
// verify gate (scripts/ci/verify-gate.mjs) holds every new list's tree to a commit of the pull request.
// RELEASED is the ledger of every written list's sha256: ledgerProblems() fails an old list edited after it was
// written, a list missing from the ledger and a ledger entry whose list is gone, on every branch (release.test.mjs);
// the verify gate refuses a change to a list or a ledger entry on main. A card cuts no release (card
// signpage-release-at-deploy): a release is cut once per sign deploy, and the sign deploy (deploy.mjs) serves only
// origin/main's head with a passed full ci.yml run (the merge queue's on that commit), and only a build the newest committed list names (unreleasedProblems:
// every SIGN_HOST file, every header, the _headers file), so every build SIGN_HOST serves is a release on main. The flow:
//   1. cut release-<N> on a branch from origin/main's head (git worktree add -b card/<key> ... origin/main, a clean
//      tree, pnpm install --frozen-lockfile): node packages/signpage/scripts/release-list.mjs release-<N>, N exactly one
//      past the newest list (it refuses any other N, and a list whose Base or Robinhood pool index snapshot is past
//      SNAPSHOT_BEHIND_MAX behind the lower of two providers' heads: run evm-index-snapshot.mjs for both chains, record
//      robinhood-quote-answers-cold's good run again on the new files (its test pins their sha-256; the refusal names
//      the command), and commit both first), then add the row it prints (add to RELEASED: "release-<N>":
//      "<sha256 of the list>",) at the end of RELEASED below, run node --test packages/signpage/scripts/release.test.mjs,
//      and commit both: git commit -m "Card <key>: signing page release-<N>" -- packages/signpage/releases/release-<N>.json packages/signpage/scripts/release-list.mjs
//   2. push it with push-card (the team's push script, card/<key>);
//   3. merge it (the verify gate holds the new list's tree to the base's or the pull request's, with the head's
//      SIGN_HOST build inputs, and refuses a name main already holds with other bytes);
//   4. deploy main at that merge, once its full ci.yml run (the merge queue's, read by its sha) passed: scripts/deploy/pages.sh node
//      packages/signpage/scripts/deploy.mjs, then its live run; signpage-release-at-deploy reads SIGN_HOST against the
//      newest committed list. A change that lands on main after the cut and touches SIGN_HOST's build inputs makes the
//      deploy refuse: cut release-<N+1> the same way.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDir as checkApp } from "../../../apps/terminal/scripts/check-deploy.ts";
import { build as buildTerminal } from "../../../apps/terminal/scripts/deploy.mjs";
import { HOST_ARGS, readList, RELEASES, TAG } from "./check-signpage.mjs";
import { build as buildSign, checkDir as checkSign } from "./deploy.mjs";
import { SIGN_BUILD_INPUTS } from "../../../scripts/ci/sign-build-inputs.mjs";
import { EVM_INDEX } from "./build-app.mjs";
import { evmPoolVenues } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { evmPoolIndexFromSnapshot } from "../../kit/src/checks/evm/pool-index.ts";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = dirname(dirname(PKG));
export const HOSTS = Object.freeze({ SIGN_HOST: "https://confidential.unrealized.trade", APP_HOST: "https://ct-app.unrealized.trade" });
// Pages reads these from the build as configuration and serves none of them (Cloudflare Pages docs: headers, redirects,
// routing, Functions); each host's gate refuses _worker.js, and a build with any other one is refused below
const CONFIG = ["_headers", "_redirects", "_routes.json", "_worker.js"];

const hash = (alg, bytes, enc) => createHash(alg).update(bytes).digest(enc);
export const digests = (bytes) => ({ bytes: bytes.length, sha256: hash("sha256", bytes, "hex"), sha384: `sha384-${hash("sha384", bytes, "base64")}` });

/** A _headers file's rules in file order: [{ path, headers: [[name lower case, value]], removes: [name lower case] }]
 *  (a `! Name` line detaches a header, card signpage-answers-outside-apps' /connect). */
export function parseRules(text) {
  const rules = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) rules.push({ path: line.trim(), headers: [], removes: [] });
    else {
      const kv = /^\s+([^:\s!]+):\s*(.*)$/.exec(line);
      const rm = /^\s+!\s*([^:\s!]+)\s*$/.exec(line);
      if ((!kv && !rm) || !rules.length) throw new Error(`_headers line cannot be read: ${JSON.stringify(line)}`);
      if (rm) rules.at(-1).removes.push(rm[1].toLowerCase());
      else rules.at(-1).headers.push([kv[1].toLowerCase(), kv[2].trim()]);
    }
  }
  return rules;
}

/** Does a _headers rule's URL pattern match `path`: a splat (*) matches any run of characters, :name one segment. */
export function matches(pattern, path) {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/:[A-Za-z]\w*/g, "[^/]+");
  return new RegExp(`^${re}$`).test(path);
}

/** The headers `path` is served with: every matching rule in file order, one header's values joined with ", " as Pages
 *  joins them; a rule's `! Name` first detaches what the rules before it set, then its own headers are added. */
export function headersFor(rules, path) {
  const out = {};
  for (const r of rules) {
    if (!matches(r.path, path)) continue;
    for (const k of r.removes ?? []) delete out[k];
    for (const [k, v] of r.headers) out[k] = k in out ? `${out[k]}, ${v}` : v;
  }
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

/** Every written release list's sha256, as written: a list is never edited after (ledgerProblems). */
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
  "release-92": "07aa9172c19f95e48f9d8a52e52dbdb54e378f19466f4caa0cdf783bc49516db",
  "release-93": "17e691070cb88c3f330fcfaefb39c7c6770d6dd0ad4e13e56855927280b25534",
  "release-94": "96170a4d69d3181387ada026e3f47d35ca97875455360ca2e6cea18277518790",
  "release-95": "2a391205a1f0fa7aefdd659f3adfad1068e2889f19ae0aba9e3666acecdb8c99",
  "release-96": "e8e83c7e5c54999759874b4952a9535a2455fbb65a9d9261d03c98084018ee7c",
  "release-97": "ceb7d938d9658a889370b2f1a1b7511659b0cda64663d2051f842a8542127390",
  "release-98": "bf8849477302d00a427219590bd67200074897d94dba97a44d00b4d8b1bbed1e",
  "release-99": "a823aadfef5561a18f3ac8247088479171191756382de9c0c0603cf722deb2bd",
  "release-100": "862c35572e5d1dd75f08ef79a422c9715e2e3e9098f85905878642c12a647e0e",
  "release-101": "0983e8610d10e96b37d3c677c37263408b335f06135cd6d1a194249558276b71",
  "release-102": "8b178026e652cf127451e14bebcf07135e7e449eb373bcd9d9d94f13d0b9c3cc",
  "release-103": "21c78ac91122b3401d562b526385aaca7c4d3009fb8e3e019ac152b83d228c6a",
  "release-104": "603128f74f7d96eef98414906eb17b097fcfa239b770a078a3d46f6985b51d10",
  "release-105": "5c158057197ad95e678548dd4c05640a83e502e932906d4bf8b6c96616fba394",
  "release-106": "4552656d207f9b63f2c8a32b21ec91257b685786990d11212524ca11c5e79a33",
  "release-107": "ec841a86f0ea1e13dbbddf5faeae92bc4d435b4a3deb2bb79df538e414b4616c",
  "release-108": "8256b45c9b3bd68a25f2672d62c2cbafec0698e5d7f113b09ec7c5aa6dfe6889",
  "release-109": "592c0be49480b5ef0a708ffe2adaa39eecc2261f0916f83b228dba61550d1596",
  "release-110": "c53caf5a30b02daba78bd788c0a90a417aac9e699c87d2ca00a07f77611eb7ef",
  "release-111": "ea0e0e53bef308e530bb02e9ba4314421a9ac2034859d18b2d40ae831ce4d8ef",
  "release-112": "e7bbd8a36ea7122081a6ffc9d760407bf9521aeba6f87a3813c8186a7fa86c1c",
  "release-113": "b0d4cf9d0238f3647bef5d062a28d8dcf8b6917f8dce68f83740a8ab99eeb3e1",
  "release-114": "211a91cd1c352df3f1320217c2c5764a333af9abf3badb3542272c62cb5d52d1",
  "release-115": "0c509f06335f1ebd92ce78065adb399cf0c7cd4824daa0ef72c667f872336e65",
  "release-116": "5b68b2cc33d562c000af22966f1cdd635f945671623a1f5c1fb939a33d850836",
  "release-117": "78f1853620becb05ffcf369756102610bacd9446d2b684472dc71708e35e74c9",
  "release-118": "b98096cb3a8b87c170b52debf7858f5aa0f994086d97dff286cdbdaf278fbc94",
  "release-119": "b739c459edd5cedf95b045ca986eb31cb35a53351f83d2c2fd40611221f28d54",
  "release-120": "2b36de718f59dddd9d2d952ba2d44f8013c9680f4357839a7f6da4b6b021bf86",
  "release-121": "61c6040677cc6278274e7a5d517d0a0cc4e02f9619a860d1366472a8eb54345b",
  "release-122": "529a32c9b31df7785527f9f99afe5875b83969a1a0a43be30def0ebb887ae255",
  "release-123": "11661ca742648578acab29015413fa49783c43245a31d13bbe7b71013e61e9d1",
  "release-124": "260cabd19e1573ea0f7342d86704ad6ad713e98bb5f911a50d53b87b51149db8",
  "release-125": "11867b56316175ec511388d2fbdfef03fdd9b1245f448cd21a7aa9b3fd3bd721",
  "release-126": "5bb60638b0990f78d2d8bdadea61ff2502c89fd4966c19b6b4b6651a3e2f690f",
  "release-127": "72b29ef438b5faa33f9f5fa1c022b19961055e60e631bbc46189dd9f61484779",
  "release-128": "72f17def9273b2e957931cc669870c861c638f2e3e05ec3af1609f5b84317970",
  "release-129": "26c12318ce78813303de69dfb5b228dd04135fd5596311b0aaeda341e1d362aa",
  "release-130": "ae824be677e7684f7990ed55ae783fd34cafd42b8edcde79f3df6b8723684584",
  "release-131": "137975a0e2c35792c5fb1eec987cc87878dfc91886b4e05721d2692b3f1b2485",
  "release-132": "d677ec65da242e7cdcc55567321399ed74428d7d79648ff559f0a22f83dfe011",
  "release-133": "07772c7951a2d6b9473e54e3be162b4bffaf653f14690ffeb1965873c0958f88",
  "release-134": "4b7df06127df515b8b66b362c58c60ddc25871c3a82154fff9b159be623cfbf7",
  "release-135": "a688881cc9a49c8f5d5fd2330806b66931e6bc5502bf316a18475509fe26eabf",
  "release-136": "83866ea1e5b7aaafe69b96096ce1e95c0a89adf5d9b37146320f12e10a8ff026",
  "release-137": "aa772d5811e7ec6822998ed346e828a584d18e0c06ee2eaf6d2c19d2cfe8d3b9",
  "release-138": "0b2a669736ffd4a0a336af793baf0a76c015656e00a9372bbe4b27924630fe06",
  "release-142": "f3d34ed55449f86dced1b5c1dc8a0e513c1189618db4c4733c35a5e4ebf17fe9",
  "release-143": "471b5370a78212b995682e805eab2d5b7907ee2f76c0b559c2a71739aba935db",
  "release-144": "728aa32e69903e88a08d742bf140360350c6af9fb87cb093312bb85ceab15042",
  "release-145": "de025a3baed94694377a7254f7a82a2732f2636ed63ce83d467cbed47f380269",
  "release-146": "feaf925a8e985ff31ad1a2bf0e3e254215549092abd26a4e9110d49d077dd490",
  "release-147": "1c058d6a7ae7c4fdd7a495ed7a387f010eb95fc58b0f575ac35d5779f6ba32d2",
  "release-148": "38ded41fef47c6994e84dcbf392520cb6f51018fbb5486eae3db1a9c11d8add8",
  "release-149": "f61b47eb06d336bf415538c9a614ffd863117618a056671f048247c190273605",
  "release-150": "75aed65c18199a17fc9af6fa355b109f24c5cd58035e5d0f1557d9751e813b19",
  "release-151": "3c7cd76b8c825b6e8de72087169be378a076feb852e1753d45610614b5afbd8b",
  "release-152": "c60c2ce2676a6d01a44107ee7c3f143bff6d2e6511714a31ea6f27e4b4650bb6",
  "release-153": "f15c38bd1186d03a061d72bfb8f459d4edd6e57d089c0a9bad5530b123536a4c",
  "release-154": "15404d9e47d56f41c01da74db8dfebbf49fc5db79520186da040bddede0e801a",
  "release-155": "f1dbeed3a9ecd71ef80cc7515987355b963c7b24c047a4909040ba41014917e6",
  "release-156": "3df824fd8525938e95f502f50c2ca008461c056f2a050deba6cad68b9f750681",
  "release-157": "f321f6ce3813fd7829e725d8494225d9472212bbd6c93fb9f9ea6a0039004a3c",
  "release-158": "42240cd1dfe064185a6ff4e741fefb16ec25ff0ab78adb7e48d0db3d89b57246",
  "release-159": "033d6e4447c43117afb986fd993b79caa85b884fb0ec560a5444aa567b426fac",
  "release-160": "89621f3e873c489cccbf5efb02f4e9c160e36c08f34136b9cac10ddf8d7d8653",
  "release-161": "7ef6509fbcf9287d9d8bbd45359b1a0815ba1197baedaf12c66f6b5d95d52ac8",
  "release-162": "abd428ead2e109eb8ff0aeb1dc683abd1dc06d2d79f902dd37c3c6a43ab1cdb7",
  "release-163": "a742e1570411f73b73e16657d5dcf4aeed31d9d8a5a90f627f93596d46907a1b",
  "release-164": "e7dd5c21e93d7c2e0ba271419056595a3ea6c98253cee89940656bc1ccc34d10",
  "release-165": "e007011f2f95e4d3a11abeb39d006ca5dc2687a0f3e8d01baf3d295164377304",
  "release-166": "94e31e499c4dc3bca49db9be7b2825c53c13585c72ea952ce68776fd1e40d029",
  "release-167": "2dd210a90653701d7abd1eb27e3121007e96641fd3fa81c277c9ad76e20d752a",
  "release-168": "8922648c91be402388227a9e056895ff77c56a74b4fe70b79ab4572e394e2bd1",
  "release-169": "c4fa3b9f7166070976edbd78acf8f48a4c01ecc5edaec0cf526821b50a150872",
  "release-170": "7c58f61c6ebf6e2733c0177c176ccdff3bfab0a99c89eae82b3f07ee2f0f7875",
  "release-171": "47a75588dba3f4fd8e38b6ff8572bd297261a20d1fc2a8a0e59a1eccc909500c",
  "release-172": "81f88efbcccae06679765886dd8231e9a9959379ee7c0ad64a5d1c8d985940f3",
  "release-173": "e2a176636786ea2b83aea42c7fe9e33152fbaef02c95c39edeb156e0d703826e",
  "release-174": "23949e35d7c5ad64d859e1f39165acf220807cf5320919d1edb82f28d5ed5095",
  "release-175": "9fe6a50e3ca1a282c924be8011a6aaed1a04b7a3d8cbc2c8299205e381ed0caf",
  "release-176": "c5fd4852e52a49078f7b6ab63425aef490cad4882eb7f19a31094d09cbfd1bb8",
  "release-177": "75142cfbaa8ad697adba32c01fc12cd534842f16791a28e2a17fe1c3f986c426",
  "release-178": "9357683e3dd08757f2727476102a5a1b7a932ddd0880ef3cfea3990897f25db1",
  "release-179": "82c29559b246ab8c70976ec51d051cd870368952f2599cd77c7281021c41e82a",
  "release-180": "73c75e48bdf92ba2b98a9921acef9945245006bdb09f3df4ef9b85aa4210249e",
  "release-181": "4b76da4d83a79b0d448bf97f4b6d9fc6be94a0a1c2091e87f7e8fe4557e8fe75",
  "release-182": "46f60aedbaf455668b16e068966e1b468763d2351629d6dcd785a0a3a04c3c59",
  "release-183": "112409f66b3eb28b62ccf899afc96992553227477059f44a49b83f7e21988ffb",
  "release-184": "ee53a361d11b040016cfcfa5fe5b5b0a7b9668569b2f4f05d9c5760b01f5eddf",
  "release-185": "fb9b5a8d7a7ecb15ced0abf2f171058359c1cb9b84d11bca60a19058046227f3",
  "release-186": "c0db6e9f2f17bceec0c5826d657b2dd84ee5ff53026870d854cf69b419832d14",
  "release-187": "70ffc89defb9db339040e5298d41ae2355d5cc424ba1dfcd97a9b454ede0124d",
  "release-188": "11b38e286c59eb1069d0155828cab5970ffddc8bc32b6933993c7f5ac83dccc3",
  "release-189": "09d7df574900ebf8de6ac90fc3e3005eb122d6af375d389af46caeb7cecd96fc",
  "release-190": "328d448db04db9f0f92a79029e8e1a7e45db5945be75df9349166ee951451f00",
  "release-191": "02e023ece596c6313c3796bf5ce34bcc9488975ea515f4b4e1e90958c8be3d71",
  "release-192": "059230157122e69b1becc18fff4dfb0b2acd776d2c37ca41c30ddfc5627bdb5e",
  "release-193": "a767fa17b7a66e42dc70c8fe74950f597b995a76ba647a124211c9888f3b4ea2",
  "release-194": "18e8c71ced41affe1478a57ad926809f44d80514e3eceeb758afde3ae4553062",
  "release-195": "c2843e3372b51209829328ebba586c0056a7513a31d87977fef012e3d90cff8a",
  "release-196": "97a1c9785a79243e94bb429baaa673014098ddada60040bdd2b1e539b6ac27c2",
  "release-197": "e38f250f5d7eaa7153185452f9b7136cb356953d33b0b35320fc7f5dae910be2",
  "release-198": "72104a886b1dc62e95904ee350dce0f5cfae3addc9bcb3e28e3107b689fa3816",
  "release-199": "8df48c8f2cd6aaae70c071c07058217c08aef4fd7e1dbef64476863f625b5c8f",
  "release-200": "be78baa2ac9ce866ff8c1146bded1a9bddd5bd6c5ed7210c5eef5b731c57ae67",
  "release-201": "d07f498d47af0dc9982b6901d3f8614a987e94df6c09297b30d984d390a0d303",
  "release-202": "b6f2e2824d1b9dfeeadbfe6d2bfd0dd8afeb2626fdf9156a70b31c0361e31760",
  "release-203": "0e7c9a74a410610e42ab711992488b4f71b9ccb69131f344bbdbb02023f12ca9",
  "release-204": "d52a16483109234f53e7fe89327404c1c55b7021e54a19da537b0e11e4f4e4f0",
  "release-205": "0e97fbd55d9562846d78a8964a4688644bac7aeceb68810e1d7be614179d2bc3",
  "release-206": "57b706e596ef2cab34e0bb2b1aea91cc35f43b421fcae335fcb4fa5bd22b6951",
  "release-207": "899ba52820ad425b686e2a539d024ce8228ece23a3a8f0ecee7ecd622bf898a9",
  "release-208": "8aaf0c4becd5ebd2501cc6b4689f17dfabdddbba936bddd7c635eeee951a869c",
  "release-209": "a432a70ef5faaac31fa9cdfde39a66a5a23c878a48b16fc6382d34606e8e2af1",
});

const tagsIn = (dir) => readdirSync(dir).map((f) => /^(release-[1-9][0-9]*)\.json$/.exec(f)?.[1]).filter(Boolean);
/** The newest release list's tag in `dir`, by N (release-1000 after release-999), or null when there is none. */
export const newestRelease = (dir = RELEASES) => tagsIn(dir).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8))).at(-1) ?? null;

/**
 * Problems with the release lists in `dir` against `ledger` (empty = none): an old list edited after it was written, a
 * list not in the ledger, a ledger entry whose list is gone, no list at all. What every branch is held to.
 */
export function ledgerProblems(dir = RELEASES, ledger = RELEASED) {
  const p = [];
  const tags = tagsIn(dir);
  for (const tag of tags) {
    const sha = hash("sha256", readFileSync(join(dir, `${tag}.json`)), "hex");
    if (!Object.hasOwn(ledger, tag)) p.push(`${tag} is not in RELEASED: add its sha256 ${sha}`);
    else if (ledger[tag] !== sha) p.push(`${tag} was edited after it was written (sha256 ${sha}, written ${ledger[tag]})`);
  }
  for (const tag of Object.keys(ledger)) if (!tags.includes(tag)) p.push(`${tag} is in RELEASED but its list is gone`);
  if (!tags.length) p.push("no release list");
  return p;
}

/**
 * Problems with serving the build folder `built` on `host` as a release (empty = none): the ledger's, a newest list that
 * cannot be read, and every way the newest list's `host` part is not that build (every file, every header, the _headers
 * file). What the sign deploy (SIGN_HOST, deploy.mjs build()) and the terminal deploy (APP_HOST, apps/terminal/scripts/
 * deploy.mjs build(), card app-deploy-refuses-an-unlisted-build) are held to.
 */
export function unreleasedProblems(built, dir = RELEASES, ledger = RELEASED, host = "SIGN_HOST") {
  const p = ledgerProblems(dir, ledger);
  const newest = newestRelease(dir);
  if (!newest) return p;
  const next = `release-${Number(newest.slice(8)) + 1}`;
  const cut = `cut ${next} on a branch from origin/main's head (node packages/signpage/scripts/release-list.mjs ${next}, its row in RELEASED), push and merge it, then deploy main at that merge`;
  if (!Object.hasOwn(HOSTS, host)) throw new Error(`${host}: no such host (${Object.keys(HOSTS).join(", ")})`);
  const fresh = makeList(newest, { [host]: built }, null);
  let diff;
  try {
    // a list that is no JSON, or JSON with no hosts object, is one the deploy cannot read: refused, never a throw past it
    const listed = JSON.parse(readFileSync(join(dir, `${newest}.json`), "utf8"));
    if (listed === null || typeof listed !== "object" || listed.hosts === null || typeof listed.hosts !== "object") throw new Error("no hosts in it");
    diff = diffLists(fresh, listed);
  } catch (e) {
    return [...p, `${newest} cannot be read (${`${e?.message ?? e}`.split("\n")[0]}): ${cut}`];
  }
  for (const l of diff) p.push(`${newest}, the newest release, is not this ${host} build (${l}): ${cut}`);
  return p;
}

const git = (...args) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).stdout.trim();

/** The newest list's tree against `head` on SIGN_BUILD_INPUTS: { newest, tree, state, changed }, state "same", "differ"
 *  (changed: the input paths that differ) or "missing" (no tree named, or one this clone does not hold). */
export function listTreeInputs(dir = RELEASES, head = "HEAD") {
  const newest = newestRelease(dir);
  if (!newest) return { newest, state: "missing" };
  const { tree } = JSON.parse(readFileSync(join(dir, `${newest}.json`), "utf8"));
  if (typeof tree !== "string" || spawnSync("git", ["-C", REPO, "cat-file", "-e", `${tree}^{tree}`]).status !== 0) return { newest, tree, state: "missing" };
  const d = spawnSync("git", ["-C", REPO, "diff", "--name-only", tree, head, "--", ...SIGN_BUILD_INPUTS], { encoding: "utf8" });
  if (d.status !== 0) throw new Error(`git diff ${tree} ${head} failed: ${(d.stderr ?? "").trim()}`);
  const changed = d.stdout.split("\n").filter(Boolean);
  return { newest, tree, state: changed.length ? "differ" : "same", changed };
}

/**
 * Review P1(a): the newest list held to this checkout's own build whenever its tree has `head`'s SIGN_BUILD_INPUTS (the
 * bundle is built where the list is cut, so CI's clean install rebuilds it and compares): { newest, applies, missing,
 * problems }. A list whose tree is not in this clone gives missing: true, never a pass (CI checks out the whole history).
 */
export function newestReleaseOnHead(dir = RELEASES, ledger = RELEASED, head = "HEAD") {
  const t = listTreeInputs(dir, head);
  if (!t.newest) return { newest: t.newest, applies: false, missing: false, problems: ["no release list"] };
  if (t.state === "missing") return { newest: t.newest, applies: false, missing: true, problems: [`${t.newest} names tree ${t.tree}, which this clone does not hold: check out the whole history (fetch-depth: 0)`] };
  if (t.state === "differ") return { newest: t.newest, applies: false, missing: false, problems: [] };
  const built = buildSign();
  try {
    return { newest: t.newest, applies: true, missing: false, problems: unreleasedProblems(built, dir, ledger) };
  } finally {
    rmSync(built, { recursive: true, force: true });
  }
}

/**
 * Review P1: what the sign deploy is held to beside unreleasedProblems: the newest list's tree has HEAD's SIGN_BUILD_INPUTS.
 * Only then did HEAD's passed full ci.yml run hold that list to a clean build (newestReleaseOnHead); a list whose inputs are not
 * HEAD's was never compared to one, whatever bytes it names. Empty = fine.
 */
export function releaseTreeProblems(dir = RELEASES, head = "HEAD") {
  const t = listTreeInputs(dir, head);
  if (!t.newest) return [];
  const next = `release-${Number(t.newest.slice(8)) + 1}`;
  const cut = `cut ${next} on a branch from origin/main's head (node packages/signpage/scripts/release-list.mjs ${next}), push and merge it, then deploy main at that merge`;
  if (t.state === "missing") return [`${t.newest} names tree ${t.tree}, which this clone does not hold, so its SIGN_HOST build inputs cannot be read against HEAD's: fetch main's whole history, or ${cut}`];
  if (t.state === "differ") return [`${t.newest} was cut from other SIGN_HOST build inputs than HEAD's (${t.changed.slice(0, 10).join(", ")}${t.changed.length > 10 ? ", ..." : ""}), so no clean build of HEAD was compared to it: ${cut}`];
  return [];
}
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

/** The most blocks each EVM chain's pool index snapshot (data/evm-index/<chain>.json, served at /evm-index/) may be
 *  behind the lower of two providers' heads when a release is cut (card evm-snapshots-fresh-at-every-cut): 12 hours at
 *  the chain's measured block rate, so a fresh device starts its index sync from a snapshot hours old, never days.
 *  - Base: 4.98 blocks a second (block 58,051,548 at 2026-11-16 03:44:45Z, 58,851,461 at 2026-11-18 00:11:07Z, on
 *    base-rpc.publicnode.com), 5 x 43,200 s = 216,000.
 *  - Robinhood: 9.50 blocks a second (115,460,916 at 2026-11-16 03:33:37Z, 117,011,529 at 2026-11-18 00:54:08Z, on
 *    rpc.mainnet.chain.robinhood.com), 9.5 x 43,200 s = 410,400.
 *  Releases 170 and 171 shipped Base's 16 Nov snapshot, 810k blocks behind on 18 Nov: a fresh account's first Base buy
 *  quote answered at 73.6 s and the buy box drew none (card base-buy-box-answers-a-fresh-account). */
export const SNAPSHOT_BEHIND_MAX = Object.freeze({ base: 216_000, robinhood: 410_400 });
/** The most two providers' heads may differ for the cut to take the lower: two minutes at the same rates (Base 5 x 120,
 *  Robinhood 9.5 x 120). Wider, one of them is behind or ahead of the chain, and its word decides nothing: a provider far
 *  behind would make a stale snapshot look fresh. */
export const SNAPSHOT_HEAD_SPREAD_MAX = Object.freeze({ base: 600, robinhood: 1_140 });
const SNAPSHOT_HEAD_MS = 10_000;
const snapshotCommand = (chain) => `node packages/signpage/scripts/evm-index-snapshot.mjs --chain ${chain}`;
/** The live check whose test pins each committed snapshot's sha-256 (its "the committed snapshots are what the good run
 *  read"), so a refreshed snapshot needs its good run recorded again: PR 1288's release-205 cut left its merge queue
 *  group on that test (card snapshot-refusal-names-the-cold-record). */
const COLD_CHECK = "scripts/live-checks/robinhood-quote-answers-cold";
const COLD_RECORD = `node ${COLD_CHECK}.mjs --site <the folder of node packages/signpage/scripts/deploy.mjs --build> --record <file>, its run the answers' good run and its sha-256 their want`;

/** The refusals of a cut over each chain's snapshot read `read` ({ <chain>: { through, heads } }: the committed
 *  snapshot's last block, null when it does not read back, and the heads two providers named): none when every chain's
 *  snapshot is at most SNAPSHOT_BEHIND_MAX behind the lower head and not past it. Fewer than two heads, or two further
 *  apart than SNAPSHOT_HEAD_SPREAD_MAX, is a refusal: a single provider's word, high or low, never decides the age. */
export function snapshotProblems(read) {
  if (read == null) return ["the pool index snapshots' age was not read, so the list is not cut"];
  const problems = [];
  for (const [chain, max] of Object.entries(SNAPSHOT_BEHIND_MAX)) {
    const r = read[chain];
    const heads = (r?.heads ?? []).filter((h) => Number.isSafeInteger(h) && h > 0);
    const fix = `run ${snapshotCommand(chain)}, record ${COLD_CHECK}'s good run again on the new files (${COLD_RECORD}), commit packages/signpage/data/evm-index and ${COLD_CHECK}.answers.json, then cut again`;
    if (!Number.isSafeInteger(r?.through)) problems.push(`${chain}: its pool index snapshot does not read back: ${fix}`);
    else if (heads.length < 2) problems.push(`${chain}: the head was read on ${heads.length} of 2 providers, so the snapshot's age is not known: cut again`);
    else if (Math.max(...heads) - Math.min(...heads) > SNAPSHOT_HEAD_SPREAD_MAX[chain]) problems.push(`${chain}: the providers' heads ${heads[0]} and ${heads[1]} are ${Math.max(...heads) - Math.min(...heads)} blocks apart (at most ${SNAPSHOT_HEAD_SPREAD_MAX[chain]}), so the snapshot's age is not known: cut again`);
    else {
      const head = Math.min(...heads);
      const behind = head - r.through;
      if (behind < 0) problems.push(`${chain}: its pool index snapshot ends at ${r.through}, past the head ${head}: ${fix}`);
      else if (behind > max) problems.push(`${chain}: its pool index snapshot is ${behind} blocks behind the head ${head} (at most ${max}, 12 hours): ${fix}`);
    }
  }
  return problems;
}

/** Each chain's snapshot read for snapshotProblems: its committed file in `dir` through the kit's own check, and
 *  eth_blockNumber on the chain's quote providers in order until two answer. */
export async function snapshotFreshness(fetchFn = fetch, dir = EVM_INDEX, venues = evmPoolVenues()) {
  const read = {};
  for (const chain of Object.keys(SNAPSHOT_BEHIND_MAX)) {
    const v = venues[chain];
    let through = null;
    try {
      through = evmPoolIndexFromSnapshot(JSON.parse(readFileSync(join(dir, `${chain}.json`), "utf8")), { chainId: v.chainId, poolManager: v.poolManager, cap: v.index.cap })?.through ?? null;
    } catch {
      through = null;
    }
    const heads = [];
    for (const url of v?.providers ?? []) {
      if (heads.length === 2) break;
      try {
        const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(SNAPSHOT_HEAD_MS) });
        const j = r.ok ? await r.json() : null;
        if (typeof j?.result === "string" && /^0x[0-9a-f]{1,16}$/i.test(j.result)) heads.push(Number(j.result));
      } catch {
        /* the next provider */
      }
    }
    read[chain] = { through, heads };
  }
  return read;
}

const USAGE = [
  "usage: node packages/signpage/scripts/release-list.mjs release-<N>                     write the list",
  "       node packages/signpage/scripts/release-list.mjs --check (release-<N> | --list <file>)",
  "       node packages/signpage/scripts/release-list.mjs --print [--host sign|app [--build <dir>]]   a build's list, to stdout",
  "       node packages/signpage/scripts/release-list.mjs --unreleased <dir> --host sign|app [--releases <dir> --ledger <file>]",
].join("\n");

/** The command line: { code, out, err } (no process.exit inside, so every build is removed before the process ends).
 *  `snapshots`: writing a list, snapshotFreshness()'s read (the command line reads it first); a list is written only
 *  when snapshotProblems finds none. */
export function main(a, releases = RELEASES, snapshots = null) {
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  const usage = { code: 2, err: [USAGE] };
  if (a[0] === "--print") {
    const [host, build] = [opt("--host"), opt("--build")];
    if (a.length !== 1 + (host === undefined ? 0 : 2) + (build === undefined ? 0 : 2) || (host !== undefined && !HOST_ARGS[host]) || (build !== undefined && host === undefined)) return usage;
    if (build !== undefined) {
      const commit = git("rev-parse", "HEAD");
      return { code: 0, out: [JSON.stringify(makeList(`build-${commit.slice(0, 12)}`, { [HOST_ARGS[host]]: build }, commit), null, 1)] };
    }
    return { code: 0, out: [JSON.stringify(headList(host ? [HOST_ARGS[host]] : undefined), null, 1)] };
  }
  if (a[0] === "--unreleased") {
    const [built, host, dir, ledgerFile] = [a[1], opt("--host"), opt("--releases"), opt("--ledger")];
    const flags = ["--host", "--releases", "--ledger"];
    if (!built || built.startsWith("--") || !HOST_ARGS[host] || (dir === undefined) !== (ledgerFile === undefined)) return usage;
    if (a.length !== (dir === undefined ? 4 : 8) || a.slice(2).some((x, i) => (i % 2 === 0) !== flags.includes(x))) return usage;
    let ledger;
    try {
      ledger = ledgerFile === undefined ? RELEASED : JSON.parse(readFileSync(ledgerFile, "utf8"));
    } catch (e) {
      return { code: 2, err: [`--ledger ${ledgerFile} cannot be read: ${e.message}`] };
    }
    let p;
    try {
      p = unreleasedProblems(built, dir ?? releases, ledger, HOST_ARGS[host]);
    } catch (e) {
      // the build folder could not be listed (missing, or a Pages file the list does not model): no answer, never a pass
      return { code: 2, err: [`${built} could not be read against the newest release: ${`${e?.message ?? e}`.split("\n")[0]}`] };
    }
    return p.length ? { code: 1, err: p } : { code: 0, out: [`${newestRelease(dir ?? releases)}, the newest release, names this ${HOST_ARGS[host]} build`] };
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
  const newest = newestRelease(releases);
  const want = `release-${newest ? Number(newest.slice(8)) + 1 : 1}`;
  if (a[0] !== want) return { code: 1, err: [`${a[0]} is not the next release: the newest list is ${newest ?? "none"}, so the next is ${want}`] };
  // each EVM chain's pool index snapshot at most SNAPSHOT_BEHIND_MAX behind its head (card evm-snapshots-fresh-at-every-cut)
  const stale = snapshotProblems(snapshots);
  if (stale.length) return { code: 1, err: stale };
  const dirty = uncommitted();
  if (dirty) return { code: 1, err: [`uncommitted changes, so the list could not name its tree:\n${dirty}`] };
  const list = headList();
  list.release = a[0];
  const text = `${JSON.stringify(list, null, 1)}\n`;
  writeFileSync(listPath(a[0], releases), text);
  const row = `"${a[0]}": "${hash("sha256", text, "hex")}",`;
  return { code: 0, out: [...Object.entries(list.hosts).map(([name, h]) => `${a[0]} ${name} ${h.files.length} files, _headers ${h.headers_file.sha256}`), `add to RELEASED: ${row}`] };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  // writing a list: the snapshots' age read first (the heads are a network read; main stays synchronous)
  const r = main(argv, RELEASES, argv.length === 1 && TAG.test(argv[0]) ? await snapshotFreshness() : null);
  const print = process.argv[2] === "--print";
  for (const l of r.out ?? []) console.log(print ? l : `release-list: ${l}`);
  for (const l of r.err ?? []) console.error(`release-list: ${l}`);
  process.exitCode = r.code;
}
