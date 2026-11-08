#!/usr/bin/env node
// Every live check runs after the deploy it covers, or says why not (card live-checks-listed). A check in no host's
// after-deploy list is never run, so a card that goes Live on it rests on nothing: balances-per-chain covered the deployed
// Portfolio screen and had never run after a deploy. Each scripts/live-checks/<key>.mjs (not its .test.mjs) is either:
//   - in a host's list, the ones live.yml runs: a `// After: <host> [<args>]` line in its leading comment block for each
//     run (scripts/ci/live-after.mjs, the one parser, which the app's and the signing page's deploy.mjs and
//     scripts/ci/helper-live-checks.mjs make their LIVE_CHECKS from); or
//   - not in any, with one line in its leading comment block that says why, the one place that reason is written:
//       // Runs: once, <why>          it checks what a host deploy cannot change (a contract deploy, a kit freeze, the
//                                    money gate's own records), or it is no check (a module the checks share, a tool)
//       // Runs: pending <card>[, <why>]   it fails on what is deployed today, so a list would undo the next deploy;
//                                    <card> is the key of the card that fixes it, and the check joins a list there
// A check in a list has no Runs line: the two would disagree the day one changes. A check may sit in two lists when it
// covers both hosts (signpage-release runs with --host app and --host sign). An After line that names no host, or a
// word that is not one (app, sign, helper), is refused here, and every host's list refuses to load past it.
//   node scripts/ci/live-listed.mjs      PASS exit 0; the problems and exit 1
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AFTER_HOSTS, CHECKS_DIR as DIR, afterOf, headerLines, readChecks } from "./live-after.mjs";
import { ROOT } from "./live-plan.mjs";

const CARD = /^[a-z0-9]+(?:-[a-z0-9]+)+$/; // a card key, as the board names one: two words at least

/** The Runs lines of a check's leading comment block (its shebang and the `//` lines before the first line of code). */
export const runsLines = (text) => headerLines(text, "Runs");

/** What is wrong with one Runs line's text (after "Runs:"), or null. */
export function runsProblem(value) {
  const once = /^once, (.+)$/.exec(value);
  if (once) return once[1].trim().length >= 20 ? null : `"Runs: once" gives no reason (at least 20 characters): ${value}`;
  const pending = /^pending ([^\s,]+)(?:, .+)?$/.exec(value);
  if (pending) return CARD.test(pending[1]) ? null : `"Runs: pending" names no card key (lowercase words joined by hyphens): ${pending[1]}`;
  return `a Runs line is "once, <why>" or "pending <card>", not: ${value}`;
}

/** Each key whose After lines name a host, to those hosts. */
export function listedOf(checks) {
  const listed = new Map();
  for (const [key, text] of Object.entries(checks)) {
    const hosts = Object.keys(afterOf(text).runs);
    if (hosts.length) listed.set(key, AFTER_HOSTS.filter((h) => hosts.includes(h)));
  }
  return listed;
}

/**
 * The problems of a set of checks: `checks` maps each key to its file's text, `listed` maps each key a host lists to the
 * hosts that list it (by default, the checks' own After lines). [] when every check is listed or says why it is not, and
 * none does both.
 */
export function listedProblems(checks, listed = listedOf(checks)) {
  const p = [];
  for (const [key, text] of Object.entries(checks).sort(([a], [b]) => a.localeCompare(b))) {
    const lines = runsLines(text);
    const hosts = listed.get(key) ?? [];
    const file = `${DIR}/${key}.mjs`;
    for (const bad of afterOf(text).problems) p.push(`${file}: ${bad}`);
    if (lines.length > 1) p.push(`${file} has ${lines.length} Runs lines: one says why it runs after no deploy`);
    for (const l of lines) {
      const bad = runsProblem(l);
      if (bad) p.push(`${file}: ${bad}`);
    }
    if (hosts.length && lines.length) p.push(`${file} is in ${hosts.join(" and ")}'s list (After) and says Runs: ${lines[0]}: drop one of the two lines`);
    if (!hosts.length && !lines.length) p.push(`${file} is in no host's list and has no Runs line: write "// After: <host> [<args>]" (${AFTER_HOSTS.join(", ")}) for each run after the deploy of the host it reads, or "// Runs: once, <why>" or "// Runs: pending <card>", in its header`);
  }
  for (const key of listed.keys()) if (!(key in checks)) p.push(`${[...listed.get(key)].join(" and ")} list ${key}, which is no file in ${DIR}`);
  return p;
}

/** The checks under `root` ({ key: text }) and the hosts' lists (key to hosts), from each check's After lines. */
export function readTree(root = ROOT) {
  const checks = readChecks(root);
  return { checks, listed: listedOf(checks) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { checks, listed } = readTree();
  const p = listedProblems(checks, listed);
  for (const l of p) console.log(`BAD ${l}`);
  console.log(p.length ? `live-listed: FAIL (${p.length})` : `live-listed: PASS (${Object.keys(checks).length} checks, ${listed.size} in a host's list)`);
  process.exit(p.length ? 1 : 0);
}
