#!/usr/bin/env node
// Every live check runs after the deploy it covers, or says why not (card live-checks-listed). A check in no host's
// after-deploy list is never run, so a card that goes Live on it rests on nothing: balances-per-chain covered the deployed
// Portfolio screen and had never run after a deploy. Each scripts/live-checks/<key>.mjs (not its .test.mjs) is either:
//   - in a host's list, the ones live.yml runs (scripts/ci/live-plan.mjs HOSTS: the app's and the signing page's
//     deploy.mjs LIVE_CHECKS, scripts/ci/helper-live-checks.mjs), read the way the plan reads them (listOf); or
//   - not in any, with one line in its leading comment block that says why, the one place that reason is written:
//       // Runs: once, <why>          it checks what a host deploy cannot change (a contract deploy, a kit freeze, the
//                                    money gate's own records), or it is no check (a module the checks share, a tool)
//       // Runs: pending <card>[, <why>]   it fails on what is deployed today, so a list would undo the next deploy;
//                                    <card> is the key of the card that fixes it, and the check joins a list there
// A check in a list has no Runs line: the two would disagree the day one changes. A check may sit in two lists when it
// covers both hosts (signpage-release runs with --host app and --host sign).
//   node scripts/ci/live-listed.mjs      PASS exit 0; the problems and exit 1
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOSTS, ROOT, listOf } from "./live-plan.mjs";

const DIR = "scripts/live-checks";
const CARD = /^[a-z0-9]+(?:-[a-z0-9]+)+$/; // a card key, as the board names one: two words at least
const COMMIT = "0".repeat(40);

/** The Runs lines of a check's leading comment block (its shebang and the `//` lines before the first line of code). */
export function runsLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#!")) continue;
    if (!line.startsWith("//")) break;
    const m = /^\/\/\s*Runs:(.*)$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/** What is wrong with one Runs line's text (after "Runs:"), or null. */
export function runsProblem(value) {
  const once = /^once, (.+)$/.exec(value);
  if (once) return once[1].trim().length >= 20 ? null : `"Runs: once" gives no reason (at least 20 characters): ${value}`;
  const pending = /^pending ([^\s,]+)(?:, .+)?$/.exec(value);
  if (pending) return CARD.test(pending[1]) ? null : `"Runs: pending" names no card key (lowercase words joined by hyphens): ${pending[1]}`;
  return `a Runs line is "once, <why>" or "pending <card>", not: ${value}`;
}

/**
 * The problems of a set of checks: `checks` maps each key to its file's text, `listed` maps each key a host lists to the
 * hosts that list it. [] when every check is listed or says why it is not, and none does both.
 */
export function listedProblems(checks, listed) {
  const p = [];
  for (const [key, text] of Object.entries(checks).sort(([a], [b]) => a.localeCompare(b))) {
    const lines = runsLines(text);
    const hosts = listed.get(key) ?? [];
    const file = `${DIR}/${key}.mjs`;
    if (lines.length > 1) p.push(`${file} has ${lines.length} Runs lines: one says why it runs after no deploy`);
    for (const l of lines) {
      const bad = runsProblem(l);
      if (bad) p.push(`${file}: ${bad}`);
    }
    if (hosts.length && lines.length) p.push(`${file} is in ${hosts.join(" and ")}'s list and says Runs: ${lines[0]}: drop the line, or take it out of the list`);
    if (!hosts.length && !lines.length) p.push(`${file} is in no host's list (${Object.values(HOSTS).join(", ")}) and has no Runs line: add it to the list of the host it reads, or write "// Runs: once, <why>" or "// Runs: pending <card>" in its header`);
  }
  for (const key of listed.keys()) if (!(key in checks)) p.push(`${[...listed.get(key)].join(" and ")} list ${key}, which is no file in ${DIR}`);
  return p;
}

/** The checks under `root` ({ key: text }) and the hosts' lists (key to hosts), as live.yml's plan reads them. */
export function readTree(root = ROOT) {
  const checks = Object.fromEntries(
    readdirSync(path.join(root, DIR))
      .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
      .map((f) => [f.slice(0, -4), readFileSync(path.join(root, DIR, f), "utf8")]),
  );
  const listed = new Map();
  for (const host of Object.keys(HOSTS)) {
    for (const key of listOf(host, root, { commit: COMMIT, network: "mainnet" }).checks) listed.set(key, [...(listed.get(key) ?? []), host]);
  }
  return { checks, listed };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { checks, listed } = readTree();
  const p = listedProblems(checks, listed);
  for (const l of p) console.log(`BAD ${l}`);
  console.log(p.length ? `live-listed: FAIL (${p.length})` : `live-listed: PASS (${Object.keys(checks).length} checks, ${listed.size} in a host's list)`);
  process.exit(p.length ? 1 : 0);
}
