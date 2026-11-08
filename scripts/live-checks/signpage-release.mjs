#!/usr/bin/env node
// Live check of card signpage-release: a host serves exactly the files of the build it was deployed from, and at a
// release both hosts serve exactly the release's list (wallet.md W4.5 and §2.7 items 3-4; E2E-22: check-signpage
// against the release list gives MATCH). It runs check-signpage (node packages/signpage/scripts/check-signpage.mjs,
// which reads the hosts over HTTPS), after holding the list's origins to the hosts' real names, written here:
// SIGN_HOST https://confidential.unrealized.trade, APP_HOST https://ct-app.unrealized.trade.
// After: app --host app
// After: sign --host sign
//   node scripts/live-checks/signpage-release.mjs --host sign|app [--record <file>]
//     after a deploy: that one host against this checkout's own build (release-list.mjs --print --host), so a host
//     that lags main fails only its own deploy's check, never the other host's
//   node scripts/live-checks/signpage-release.mjs --release release-<N> [--record <file>]
//     at a release: both hosts against the committed packages/signpage/releases/release-<N>.json
//   node scripts/live-checks/signpage-release.mjs --answer <file> --list <file> [--host sign|app]   a recorded answer
//   PASS only when check-signpage exits 0 and its last line is MATCH <list>. PASS exit 0, FAIL exit 1, error exit 2.
// --record writes what the run read (sizes, hashes and the listed headers per path and mode, no bodies), so the
// check's test can replay it against the same list.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "signpage-release";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RELEASES = path.join(REPO, "packages/signpage/releases");
const SCRIPTS = path.join(REPO, "packages/signpage/scripts");
export const ORIGINS = { SIGN_HOST: "https://confidential.unrealized.trade", APP_HOST: "https://ct-app.unrealized.trade" };
export const HOSTS = { sign: "SIGN_HOST", app: "APP_HOST" };

/** Problems with a list's hosts (empty = exactly the hosts asked, at their real names). */
export function originProblems(list, host = null) {
  const p = [];
  const named = Object.keys(list.hosts ?? {}).sort().join(",");
  const want = (host ? [HOSTS[host]] : Object.keys(ORIGINS)).sort().join(",");
  if (named !== want) p.push(`BAD ${list.release} names hosts ${named}, want ${want}`);
  for (const [k, o] of Object.entries(ORIGINS)) if (list.hosts?.[k] && list.hosts[k].origin !== o) p.push(`BAD ${list.release} ${k} is ${list.hosts[k].origin}, want ${o}`);
  return p;
}

/**
 * Runs check-signpage with `args` against the list in `listFile`, for one host or both: { ok, lines, release }. ok
 * only when the list holds exactly those hosts at their real names, check-signpage exits 0 and its last line is
 * MATCH <list>.
 */
export function run(listFile, args = [], host = null) {
  const list = JSON.parse(readFileSync(listFile, "utf8"));
  const lines = originProblems(list, host);
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, "check-signpage.mjs"), "--list", listFile, ...(host ? ["--host", host] : []), ...args], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  lines.push(...r.stdout.split("\n").filter(Boolean));
  if (r.status === 2 || r.status === null) throw new Error(`check-signpage: ${r.stderr.trim() || r.signal}`);
  const ok = !lines.some((l) => l.startsWith("BAD")) && r.status === 0 && lines.at(-1) === `MATCH ${list.release}`;
  return { ok, lines, release: list.release };
}

/** This checkout's own build's list for one host, written to `file` (release-list.mjs --print --host). */
export function headListFile(host, file) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, "release-list.mjs"), "--print", "--host", host], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`release-list --print: ${r.stderr.trim() || r.signal}`);
  writeFileSync(file, r.stdout);
  return file;
}

const USAGE = "usage: node scripts/live-checks/signpage-release.mjs (--host sign|app | --release release-<N> | --answer <file> --list <file> [--host sign|app]) [--record <file>]";

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  const host = opt("--host");
  const tmp = mkdtempSync(path.join(tmpdir(), "ct-signpage-release-"));
  try {
    let listFile;
    if (host !== null && !HOSTS[host]) throw new Error(USAGE);
    if (opt("--answer")) listFile = opt("--list");
    else if (opt("--release")) listFile = host ? null : path.join(RELEASES, `${opt("--release")}.json`);
    else if (host) listFile = headListFile(host, path.join(tmp, "head.json"));
    if (!listFile || (opt("--release") && !/^release-[1-9][0-9]*$/.test(opt("--release")))) throw new Error(USAGE);
    const args = opt("--answer") ? ["--answer", opt("--answer")] : opt("--record") ? ["--record", opt("--record")] : [];
    const { ok, lines, release } = run(listFile, args, host);
    for (const l of lines) console.log(l);
    const hosts = (host ? [HOSTS[host]] : Object.keys(ORIGINS)).map((k) => ORIGINS[k]).join(" and ");
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${release}, ${hosts}${opt("--answer") ? `, replay of ${opt("--answer")}` : ""})`);
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exitCode = 2;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
