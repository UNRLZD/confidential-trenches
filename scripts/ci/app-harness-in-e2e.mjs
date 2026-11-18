#!/usr/bin/env node
// Every app live check that can run on a local build runs on the pull request's build (card
// app-live-checks-run-on-the-build-before-merge). On 12 Nov release 125 changed when the trade box says Making proof:
// the app's own fixtures moved with it, trade-box-pool's did not, CI was green and live run 43328445607 went red after
// the deploy. A check in the app's list (its `// After: app` line, scripts/ci/live-after.mjs) whose code reads a
// --harness argument is either:
//   - run in apps/terminal's test:e2e as `node ../../scripts/live-checks/<key>.mjs --harness [<args>]`, on the build
//     test:e2e makes first (each check's --harness reads apps/terminal/dist by default); or
//   - not run there, with one line in its leading comment block that says why, the one place that reason is written:
//       // Harness: not in e2e, <why, at least 20 characters>
// A check with both, a Harness line on a check with no --harness mode or in no app list, and a test:e2e run of a check
// file that does not exist are refused too, so neither place goes stale.
//   node scripts/ci/app-harness-in-e2e.mjs      PASS exit 0; the problems and exit 1
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKS_DIR as DIR, afterOf, headerLines, readChecks } from "./live-after.mjs";
import { ROOT } from "./live-plan.mjs";

export const TERMINAL_PACKAGE = "apps/terminal/package.json";
const HARNESS_ARG = /\bincludes\(\s*["']--harness["']\s*\)/; // how every check reads its --harness argument
const E2E_RUN = /^node \.\.\/\.\.\/scripts\/live-checks\/([a-z0-9-]+)\.mjs --harness(?:\s|$)/;

/** Whether a check's code reads a --harness argument. */
export const hasHarness = (text) => HARNESS_ARG.test(text);

/** The keys test:e2e runs as `node ../../scripts/live-checks/<key>.mjs --harness ...`, in order. */
export function e2eHarnessRuns(script) {
  return script
    .split("&&")
    .map((c) => E2E_RUN.exec(c.trim()))
    .filter(Boolean)
    .map((m) => m[1]);
}

/** What is wrong with one Harness line's text (after "Harness:"), or null. */
export function harnessLineProblem(value) {
  const m = /^not in e2e, (.+)$/.exec(value);
  if (!m) return `a Harness line is "not in e2e, <why>", not: ${value}`;
  return m[1].trim().length >= 20 ? null : `"Harness: not in e2e" gives no reason (at least 20 characters): ${value}`;
}

/**
 * The problems of a set of checks ({ key: text }) against test:e2e's text. [] when every check in the app's list with a
 * --harness mode is run by test:e2e or says why not in its header, and none does both.
 */
export function harnessProblems(checks, e2e) {
  const p = [];
  const runs = new Set(e2eHarnessRuns(e2e));
  for (const key of runs) if (!(key in checks)) p.push(`test:e2e runs ${DIR}/${key}.mjs --harness, which is no file`);
  for (const [key, text] of Object.entries(checks).sort(([a], [b]) => a.localeCompare(b))) {
    const file = `${DIR}/${key}.mjs`;
    const app = "app" in afterOf(text).runs;
    const harness = hasHarness(text);
    const lines = headerLines(text, "Harness");
    if (lines.length > 1) p.push(`${file} has ${lines.length} Harness lines: one says why test:e2e does not run it`);
    for (const l of lines) {
      const bad = harnessLineProblem(l);
      if (bad) p.push(`${file}: ${bad}`);
    }
    if (lines.length && !(app && harness)) p.push(`${file} has a Harness line but ${app ? "reads no --harness argument" : "is in no app list (no After: app line)"}: drop the line`);
    if (!app || !harness) continue;
    const ran = runs.has(key);
    if (ran && lines.length) p.push(`${file} runs in test:e2e and says Harness: ${lines[0]}: drop one of the two`);
    if (!ran && !lines.length) p.push(`${file} runs after the app's deploy and has a --harness mode, but test:e2e does not run it: add "node ../../${file} --harness" to ${TERMINAL_PACKAGE}'s test:e2e (and its seconds to scripts/ci/test-shards.mjs E2E_SECONDS), or write "// Harness: not in e2e, <why>" in its header`);
  }
  return p;
}

/** The checks under `root` and test:e2e's text. */
export function readTree(root = ROOT) {
  return { checks: readChecks(root), e2e: JSON.parse(readFileSync(path.join(root, TERMINAL_PACKAGE), "utf8")).scripts["test:e2e"] };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { checks, e2e } = readTree();
  const p = harnessProblems(checks, e2e);
  for (const l of p) console.log(`BAD ${l}`);
  const app = Object.values(checks).filter((t) => "app" in afterOf(t).runs && hasHarness(t)).length;
  console.log(p.length ? `app-harness-in-e2e: FAIL (${p.length})` : `app-harness-in-e2e: PASS (${app} app checks with a --harness mode, ${new Set(e2eHarnessRuns(e2e)).size} run by test:e2e)`);
  process.exit(p.length ? 1 : 0);
}
