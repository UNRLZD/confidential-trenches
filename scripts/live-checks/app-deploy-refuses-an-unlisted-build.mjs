#!/usr/bin/env node
// Live check of card app-deploy-refuses-an-unlisted-build: after an app deploy, APP_HOST (https://ct-app.unrealized.trade)
// serves the newest committed release list's APP_HOST part (packages/signpage/releases, newest by N, in the deployed
// commit's tree): every file it names, in both request modes, with its bytes and headers, the probes answered by its
// fallback page, and every script a page loads named by it. The app deploy (apps/terminal/scripts/deploy.mjs) refuses,
// before any upload, a build that list does not name (release-list.mjs unreleasedProblems, the sign deploy's comparer);
// this check reads what the host serves after it, so a deploy that went up some other way fails here.
// It runs check-signpage (packages/signpage/scripts/check-signpage.mjs, over HTTPS) through signpage-release's run(),
// which holds the list's origin to APP_HOST's real name.
// After: app
// Bundle: out the newest committed release list against what APP_HOST serves (the app deploy refuses a build that list does not name)
//   node scripts/live-checks/app-deploy-refuses-an-unlisted-build.mjs [--release release-<N>] [--record <file> | --answer <file>]
//     APP_HOST against the newest committed release list, or against release-<N> as if it were the newest; --record
//     writes what the run read (check-signpage's record: sizes, hashes and headers, no bodies), --answer judges such a
//     record instead of reading APP_HOST
//   PASS only when check-signpage exits 0 and its last line is MATCH release-<N>. PASS exit 0, FAIL exit 1, error exit 2.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./signpage-release.mjs";
import { newestTag } from "./signpage-release-at-deploy.mjs";

const KEY = "app-deploy-refuses-an-unlisted-build";
export const APP_HOST = "https://ct-app.unrealized.trade";
const RELEASES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/signpage/releases");
const TAG = /^release-[1-9][0-9]*$/;
const USAGE = `usage: node scripts/live-checks/${KEY}.mjs [--release release-<N>] [--record <file> | --answer <file>]`;

/** APP_HOST against `tag`'s list (the newest committed one when null), live or from a recorded answer: { ok, lines, release }. */
export function check(tag = null, args = [], dir = RELEASES) {
  const t = tag ?? newestTag(dir);
  if (!TAG.test(t)) throw new Error(USAGE);
  const full = JSON.parse(readFileSync(path.join(dir, `${t}.json`), "utf8"));
  if (!full.hosts?.APP_HOST) throw new Error(`${t} holds no APP_HOST`);
  const list = { ...full, hosts: { APP_HOST: full.hosts.APP_HOST } };
  const tmp = mkdtempSync(path.join(tmpdir(), "ct-app-release-at-deploy-"));
  try {
    const file = path.join(tmp, `${list.release}.json`);
    writeFileSync(file, JSON.stringify(list));
    return run(file, args, "app");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  try {
    const [answer, release, record] = [opt("--answer"), opt("--release"), opt("--record")];
    const known = new Set(["--answer", "--release", "--record"]);
    if (a.some((x, i) => (i % 2 === 0 ? !known.has(x) : known.has(x))) || a.length % 2) throw new Error(USAGE);
    if ((release && !TAG.test(release)) || (answer && record)) throw new Error(USAGE);
    const { ok, lines, release: tag } = check(release, answer ? ["--answer", answer] : record ? ["--record", record] : []);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${tag}, ${APP_HOST}${release ? "" : ", the newest committed release"}${answer ? `, replay of ${answer}` : ""})`);
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exitCode = 2;
  }
}
