#!/usr/bin/env node
// Every app live check that can run on a local build runs on the pull request's build (card
// app-live-checks-run-on-the-build-before-merge). On 12 Nov release 125 changed when the trade box says Making proof:
// the app's own fixtures moved with it, trade-box-pool's did not, CI was green and live run 43328445607 went red after
// the deploy; on release 178 rail-open-pushes-the-middle and app-legend-holds-still, --build checks no list ran, went red
// only on the live run (44429326442). A check in the app's list (its `// After: app` line, scripts/ci/live-after.mjs)
// whose code reads a --harness argument or a --build <dir> option (the terminal build served at APP_HOST's name,
// app-in-shell.mjs harnessRoute) can run on a local build, and is either:
//   - run in apps/terminal's test:e2e as `node ../../scripts/live-checks/<key>.mjs <args>`, its args naming --harness or
//     --build, on the build test:e2e makes first (apps/terminal/dist: --harness reads it by default, or `--build dist`); or
//   - not run there, with one line in its leading comment block that says why, the one place that reason is written:
//       // Harness: not in e2e, <why, at least 20 characters>
//   - or PENDING below: red on the build today, left out of test:e2e, named to the card that fixes it; that card adds
//     the run and removes its entry in the same change.
// A check with two of these, a Harness line or a PENDING entry on a check with neither mode or in no app list, a
// PENDING entry with no card key, and a test:e2e run of a check file that does not exist are refused too, so no place
// goes stale.
//   node scripts/ci/app-harness-in-e2e.mjs      PASS exit 0; the problems and exit 1
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKS_DIR as DIR, afterOf, headerLines, readChecks } from "./live-after.mjs";
import { ROOT } from "./live-plan.mjs";

export const TERMINAL_PACKAGE = "apps/terminal/package.json";
const HARNESS_ARG = /\bincludes\(\s*["']--harness["']\s*\)/; // how every check reads its --harness argument
const BUILD_OPT = /\bopt\(\s*["']--build["']/; // how every check reads its --build <dir> option
const E2E_RUN = /^node \.\.\/\.\.\/scripts\/live-checks\/([a-z0-9-]+)\.mjs((?: \S+)*)$/;
const LOCAL_ARG = /(?:^| )--(?:harness|build)(?: |$)/;
const CARD = /^[a-z0-9]+(?:-[a-z0-9]+)+$/; // a card key, as the board names one: two words at least

/** The app checks red on the build today, each to the card that fixes it (read on cebdf077e's build, 19 Nov). */
export const PENDING = Object.freeze({
  // the account chip grows when a signed-in load has no sign-in hint (hint.ts firstShape), CLS 0.0021 / 0.0016
  "app-shell": "app-first-paint-knows-sign-in",
  "app-legend-holds-still": "rail-and-legend-hold-on-r5",
  "rail-open-pushes-the-middle": "rail-and-legend-hold-on-r5",
});

/** Whether a check's code reads a --harness argument. */
export const hasHarness = (text) => HARNESS_ARG.test(text);
/** Whether a check's code reads a --build <dir> option. */
export const hasBuild = (text) => BUILD_OPT.test(text);
/** Whether a check can run on a local build: a --harness mode or a --build option. */
export const runsLocal = (text) => hasHarness(text) || hasBuild(text);

/** The keys test:e2e runs as `node ../../scripts/live-checks/<key>.mjs ...` with --harness or --build among its
 *  arguments, in order. */
export function e2eHarnessRuns(script) {
  return script
    .split("&&")
    .map((c) => E2E_RUN.exec(c.trim()))
    .filter((m) => m && LOCAL_ARG.test(m[2]))
    .map((m) => m[1]);
}

/** What is wrong with one Harness line's text (after "Harness:"), or null. */
export function harnessLineProblem(value) {
  const m = /^not in e2e, (.+)$/.exec(value);
  if (!m) return `a Harness line is "not in e2e, <why>", not: ${value}`;
  return m[1].trim().length >= 20 ? null : `"Harness: not in e2e" gives no reason (at least 20 characters): ${value}`;
}

/**
 * The problems of a set of checks ({ key: text }) against test:e2e's text. [] when every check in the app's list that
 * can run on a local build is run by test:e2e or says why not in its header, and none does both.
 */
export function harnessProblems(checks, e2e, pending = PENDING) {
  const p = [];
  const runs = new Set(e2eHarnessRuns(e2e));
  for (const key of runs) if (!(key in checks)) p.push(`test:e2e runs ${DIR}/${key}.mjs, which is no file`);
  for (const [key, card] of Object.entries(pending)) {
    if (!CARD.test(card ?? "")) p.push(`PENDING ${key} names no card key (lowercase words joined by hyphens): ${card}`);
    const text = checks[key];
    if (text === undefined) p.push(`PENDING names ${key}, which is no file in ${DIR}`);
    else if (!("app" in afterOf(text).runs) || !runsLocal(text)) p.push(`PENDING names ${key}, which is no app check that runs on a local build: drop the entry`);
  }
  for (const [key, text] of Object.entries(checks).sort(([a], [b]) => a.localeCompare(b))) {
    const file = `${DIR}/${key}.mjs`;
    const app = "app" in afterOf(text).runs;
    const local = runsLocal(text);
    const lines = headerLines(text, "Harness");
    if (lines.length > 1) p.push(`${file} has ${lines.length} Harness lines: one says why test:e2e does not run it`);
    for (const l of lines) {
      const bad = harnessLineProblem(l);
      if (bad) p.push(`${file}: ${bad}`);
    }
    if (lines.length && !(app && local)) p.push(`${file} has a Harness line but ${app ? "reads neither --harness nor --build" : "is in no app list (no After: app line)"}: drop the line`);
    if (!app || !local) continue;
    const ran = runs.has(key);
    const held = Object.hasOwn(pending, key);
    if (ran && lines.length) p.push(`${file} runs in test:e2e and says Harness: ${lines[0]}: drop one of the two`);
    if (held && ran) p.push(`${file} runs in test:e2e and is PENDING on ${pending[key]}: the card that adds the run removes its PENDING entry`);
    if (held && lines.length) p.push(`${file} is PENDING on ${pending[key]} and says Harness: ${lines[0]}: drop one of the two`);
    if (held) continue;
    const run = hasHarness(text) ? "--harness" : "--build dist";
    if (!ran && !lines.length) p.push(`${file} runs after the app's deploy and can run on a local build, but test:e2e does not run it: add "node ../../${file} ${run}" to ${TERMINAL_PACKAGE}'s test:e2e (and its seconds to scripts/ci/test-shards.mjs E2E_SECONDS), or write "// Harness: not in e2e, <why>" in its header`);
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
  const app = Object.values(checks).filter((t) => "app" in afterOf(t).runs && runsLocal(t)).length;
  console.log(p.length ? `app-harness-in-e2e: FAIL (${p.length})` : `app-harness-in-e2e: PASS (${app} app checks that run on a local build, ${new Set(e2eHarnessRuns(e2e)).size} run by test:e2e, ${Object.keys(PENDING).length} pending: ${Object.entries(PENDING).map(([k, c]) => `${k} on ${c}`).join(", ")})`);
  process.exit(p.length ? 1 : 0);
}
