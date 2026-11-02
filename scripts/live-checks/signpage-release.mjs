#!/usr/bin/env node
// Live check of card signpage-release: SIGN_HOST and APP_HOST serve exactly the newest release's files (wallet.md
// W4.5 and §2.7 items 3-4; E2E-22: check-signpage against the release list gives MATCH). It runs check-signpage
// (node packages/signpage/scripts/check-signpage.mjs, which reads both hosts over HTTPS) against the newest
// packages/signpage/releases/release-<N>.json, after holding the list's two origins to the hosts' real names, written
// here: SIGN_HOST https://sign.confidential.unrealized.trade, APP_HOST https://confidential.unrealized.trade.
// PASS only when check-signpage exits 0 and its last line is MATCH release-<N>.
//   node scripts/live-checks/signpage-release.mjs [--release release-<N>] [--record <file>]
//   node scripts/live-checks/signpage-release.mjs --answer <file> [--list <file>]   judges a recorded answer instead
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (sizes, hashes and the release's headers per path and mode, no bodies), so the
// check's test can replay it against the same list.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "signpage-release";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RELEASES = path.join(REPO, "packages/signpage/releases");
const CHECK = path.join(REPO, "packages/signpage/scripts/check-signpage.mjs");
export const ORIGINS = { SIGN_HOST: "https://sign.confidential.unrealized.trade", APP_HOST: "https://confidential.unrealized.trade" };

/** The newest release's name in packages/signpage/releases/, by N. */
export function newest() {
  const n = readdirSync(RELEASES).map((f) => /^release-([1-9][0-9]*)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number);
  if (!n.length) throw new Error(`no release list in ${RELEASES}`);
  return `release-${Math.max(...n)}`;
}

/** Problems with a list's hosts against ORIGINS (empty = both hosts, at their real names). */
export function originProblems(list) {
  const p = [];
  const named = Object.keys(list.hosts ?? {}).sort().join(",");
  const want = Object.keys(ORIGINS).sort().join(",");
  if (named !== want) p.push(`BAD ${list.release} names hosts ${named}, want ${want}`);
  for (const [k, o] of Object.entries(ORIGINS)) if (list.hosts?.[k] && list.hosts[k].origin !== o) p.push(`BAD ${list.release} ${k} is ${list.hosts[k].origin}, want ${o}`);
  return p;
}

/**
 * Runs check-signpage with `args` against the list in `listFile`: { ok, lines }. ok only when the list names both
 * hosts at their real names, check-signpage exits 0 and its last line is MATCH <release>.
 */
export function run(listFile, args = []) {
  const list = JSON.parse(readFileSync(listFile, "utf8"));
  const lines = originProblems(list);
  const r = spawnSync(process.execPath, [CHECK, "--list", listFile, ...args], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  lines.push(...r.stdout.split("\n").filter(Boolean));
  if (r.status === 2 || r.status === null) throw new Error(`check-signpage: ${r.stderr.trim() || r.signal}`);
  const ok = !lines.some((l) => l.startsWith("BAD")) && r.status === 0 && lines.at(-1) === `MATCH ${list.release}`;
  return { ok, lines, release: list.release };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  try {
    const listFile = opt("--list") ?? path.join(RELEASES, `${opt("--release") ?? newest()}.json`);
    const args = opt("--answer") ? ["--answer", opt("--answer")] : opt("--record") ? ["--record", opt("--record")] : [];
    const { ok, lines, release } = run(listFile, args);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${release}, ${Object.values(ORIGINS).join(" and ")}${opt("--answer") ? `, replay of ${opt("--answer")}` : ""})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
