#!/usr/bin/env node
// Live check of card signpage-release-at-deploy: after a sign deploy, SIGN_HOST (https://confidential.unrealized.trade)
// serves exactly the newest committed release list's SIGN_HOST part (packages/signpage/releases, newest by N, in the
// deployed commit's tree), so every build it serves is a release a user or a judge can read. A release is cut once per
// sign deploy, on main, right before it (packages/signpage/scripts/release-list.mjs's header), and the deploy refuses a
// build that list does not name (packages/signpage/scripts/deploy.mjs); this check reads what the host serves after it.
// It runs check-signpage (packages/signpage/scripts/check-signpage.mjs, over HTTPS) through signpage-release's run(),
// which holds the list's origin to SIGN_HOST's real name.
// After: sign
//   node scripts/live-checks/signpage-release-at-deploy.mjs [--release release-<N>] [--record <file> | --answer <file>]
//     SIGN_HOST against the newest committed release list, or against release-<N> as if it were the newest; --record
//     writes what the run read (check-signpage's record: sizes, hashes and headers, no bodies), --answer judges such a
//     record instead of reading SIGN_HOST
//   PASS only when check-signpage exits 0 and its last line is MATCH release-<N>. PASS exit 0, FAIL exit 1, error exit 2.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onlyHost, readList, TAG } from "../../packages/signpage/scripts/check-signpage.mjs";
import { ORIGINS, run } from "./signpage-release.mjs";

const KEY = "signpage-release-at-deploy";
const USAGE = "usage: node scripts/live-checks/signpage-release-at-deploy.mjs [--release release-<N>] [--record <file> | --answer <file>]";

/** SIGN_HOST against `tag`'s list (the newest committed one when null), live or from a recorded answer: { ok, lines, release }. */
export function check(tag = null, args = []) {
  const list = onlyHost(readList(tag), "sign");
  const tmp = mkdtempSync(path.join(tmpdir(), "ct-release-at-deploy-"));
  try {
    const file = path.join(tmp, `${list.release}.json`);
    writeFileSync(file, JSON.stringify(list));
    return run(file, args, "sign");
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
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${tag}, ${ORIGINS.SIGN_HOST}${release ? "" : ", the newest committed release"}${answer ? `, replay of ${answer}` : ""})`);
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exitCode = 2;
  }
}
