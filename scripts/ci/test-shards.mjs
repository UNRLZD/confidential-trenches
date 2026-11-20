// Card ci-test-shards: the share of apps/terminal's test:e2e that one part of ci.yml's test-browser matrix runs.
//   node scripts/ci/test-shards.mjs e2e <index> <total>    (prints the part's command; exit 1 and the reason otherwise)
//
// test:e2e is one chain, `a && b && c ...`: its first command (the build) runs in every part, and each later command
// in exactly one. ci.yml passes the job's own strategy.job-index and strategy.job-total, so every command runs in some
// part whatever the matrix lists. A chain this cannot split into commands that stand alone (||, ;, a pipe, a newline)
// is refused rather than split wrong, and so is a part left with nothing but the build.
// Card ci-e2e-shards-by-time: the commands after the build are dealt largest first, each to the part with the fewest
// planned seconds, by the times E2E_SECONDS measured on CI; the first part starts with the prover step's seconds,
// since only it runs that step. The deal was round-robin, command i in part (i - 1) % total, so one command added to
// the chain moved every later one a part over, and PR #1029's took test-browser (1) past its 15 minutes (run
// 44375738505). A command with no measured time counts as NEW_E2E_SECONDS.
//   node scripts/ci/test-shards.mjs e2e-run <index> <total>    (builds, then runs the part's commands, each timed)
// runs the build, and when it passed each of the part's commands in apps/terminal, all of them even when one fails,
// with each one's time and a ::warning:: for a command past 1.25 times its listed seconds, as the mutants' parts do. A
// live check that reads the live helper (it imports scripts/live-checks/helper-misses.mjs) runs through
// scripts/ci/live-rerun.mjs's rerun rule (card queue-browser-checks-tell-a-helper-miss-from-a-page-fault: runE2ePart).
//
// Card ci-mutants-sharded: the share of the mutant sweeps that one part of ci.yml's test-mutants matrix runs.
//   node scripts/ci/test-shards.mjs mutants <index> <total>    (runs the part's sweeps; exit 1 when one failed)
//
// The sweeps are every workspace package's test:mutants, the wallet's included (card held-move-forgotten-tx), each
// script split on && into its commands, each command run in its package's folder as `pnpm run` would. Each
// command goes to exactly one part: largest first, each to the part with the fewest planned seconds so far, by the
// times MUTANT_SECONDS measured on CI. One that has no measured time counts as NEW_SWEEP_SECONDS, so a sweep added to
// any package lands in a part before anyone times it. A part runs its commands one after another, all of them even
// when one fails (as pnpm's --no-bail did), prints each one's time, and fails when any failed.
// Card ci-mutant-shards-true-times: a sweep that took more than 1.25 times its listed seconds prints a GitHub warning
// annotation (`::warning::`) naming the sweep, the listed and the measured time, so a stale table shows itself on the
// run; never a failure, since a runner's speed varies. No sweep is listed over 300 s: the sweeps that took longer run in
// parts (`<k>/<n>`, scripts/mutant-part.mjs), one command each, and a check refuses a file of a mutants folder that no
// command names.
//
// The same card: the share of the packages' tests that one part of ci.yml's test-packages matrix runs.
//   node scripts/ci/test-shards.mjs packages plan|tests|typecheck <index> <total>
// The items are each workspace package's test script but the wallet's (its own job runs it), the typecheck, the deploy
// gate's tests, the live-check replays and the bundle checks, each in exactly one part, largest first to the part with
// the fewest planned seconds, by PACKAGE_SECONDS. `plan` prints the part's yes/no for the three steps ci.yml writes out
// as GITHUB_OUTPUT lines; `tests` and `typecheck` run the part's pnpm line themselves, narrowed by the pull request's
// SELECT (the packages pr-paths.mjs picked) so a part runs no package the change leaves out.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// a plain `a && b && c` chain as its commands; anything else is refused rather than split wrong
function chain(script, what) {
  if (/[|;&\n`]|\$\(/.test(script.replaceAll("&&", ""))) throw new Error(`${what} is not a plain a && b chain: ${script}`);
  const commands = script.split("&&").map((c) => c.trim());
  if (commands.some((c) => !c)) throw new Error(`${what} has an empty command: ${script}`);
  return commands;
}

function checkPart(index, total) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`total ${total} is not a count of parts`);
  if (!Number.isInteger(index) || index < 0 || index >= total) throw new Error(`index ${index} is not a part of ${total}`);
}

// ---- the terminal's browser runs (card ci-e2e-shards-by-time)

export const E2E_DIR = "apps/terminal";
// seconds each command took in test-browser, rounded up, the slowest of the three merge queue runs read for this card:
// A, run 44371886994 (jobs 135040704496 as (1), 135040704826 as (2), 135040704676 as (3)) and B, run 44374813196 (jobs
// 135051111464, 135051111644, 135051111657), both on main's list, and C, run 44375738505 (jobs 135054404897,
// 135054404970, 135054405087), the shifted list of PR #1029, so each command ran three times, in two parts at least. A
// command's time is from the line that ended the command before it (the build's `built in`) to the line that ended it,
// its PASS or FAIL verdict (`ℹ duration_ms` for the node --test one). A verdict the runner sent in one batch with the
// next command's lines moves a few seconds from one command to the next, never out of a part's sum. These ran as one
// `sh -c` chain; e2e-run starts each under its own `pnpm exec`, about a second more each. Keyed `apps/terminal: <command>`, as
// a part's `== ok in N s:` lines print them; scripts/ci/test-shards.test.mjs fails on a key that names no command of
// test:e2e, and on a command with no key.
export const E2E_SECONDS = {
  "apps/terminal: node ../../scripts/live-checks/app-in-shell.mjs --harness --engines chromium": 53, // C1 52.5
  "apps/terminal: node test/bar10/run.mjs": 116, // B2 115.7
  "apps/terminal: node test/harness-sockets/run.mjs": 2, // C3 1.0
  "apps/terminal: node test/deposit-sheet/run.mjs": 48, // C1 47.3
  "apps/terminal: node test/welcome/run.mjs": 11, // B2 10.5
  "apps/terminal: node test/verify/run.mjs": 17, // C3 16.7
  "apps/terminal: node test/verify-mount/run.mjs": 12, // C1 11.6
  "apps/terminal: node ../../scripts/live-checks/app-portfolio-mount.mjs --harness": 29, // C3 28.2
  "apps/terminal: node ../../scripts/live-checks/app-deposit-mount.mjs --harness": 47, // C1 46.6
  "apps/terminal: node ../../scripts/live-checks/app-footer-bar.mjs --harness": 10, // B2 9.1
  "apps/terminal: node ../../scripts/live-checks/deposit-to-pool.mjs --harness": 73, // C3 72.9
  "apps/terminal: node ../../scripts/live-checks/app-faults-seen-on-122.mjs --harness": 12, // C1 11.4
  // C2's 22.5 s holds about 5 s of the next command's: its verdict came in the same batch as that one's lines
  "apps/terminal: node ../../scripts/live-checks/app-faults-seen-on-124.mjs --harness": 23, // C2 22.5
  "apps/terminal: node ../../scripts/live-checks/app-faults-seen-on-126.mjs --harness": 10, // C3 9.3
  "apps/terminal: node ../../scripts/live-checks/screens-never-say-proof.mjs --harness": 22, // C1 21.1
  "apps/terminal: node ../../scripts/live-checks/app-lock-holds-until-the-layer-closes.mjs --harness": 6, // B2 5.8
  "apps/terminal: node ../../scripts/live-checks/signed-out-portfolio-and-account-say-what-appears.mjs --harness": 34, // C3 33.8
  "apps/terminal: node ../../scripts/live-checks/app-pages-open-right.mjs --harness": 30, // A1 29.3
  // card app-live-checks-run-on-the-build-before-merge: each app check's own --harness, measured on a local run
  // (19 Nov), whole seconds from start to exit, 1 s at the least, until CI times them;
  // app-no-blank-pages replaces test/no-blank-pages/run.mjs (the same collect and judge on the same route, B2 122.0)
  "apps/terminal: node ../../scripts/live-checks/app-export-every-wallet.mjs --harness": 14, // 14 s
  "apps/terminal: node ../../scripts/live-checks/app-hop-sync-lock.mjs --harness": 5, // 5 s
  "apps/terminal: node ../../scripts/live-checks/app-list-age.mjs --harness": 6, // 6 s
  "apps/terminal: node ../../scripts/live-checks/app-no-blank-pages.mjs --harness": 123, // 120 s, 122.0 s as the wrapper
  "apps/terminal: node ../../scripts/live-checks/app-pool-withdraw.mjs --harness": 44, // 44 s
  "apps/terminal: node ../../scripts/live-checks/app-release-sri.mjs --harness": 1, // 0 s
  "apps/terminal: node ../../scripts/live-checks/app-shell-rpc-outage-judge.mjs --harness": 8, // 8 s
  "apps/terminal: node ../../scripts/live-checks/app-verify-mount.mjs --harness": 8, // 8 s
  "apps/terminal: node ../../scripts/live-checks/balances-per-chain.mjs --harness": 3, // 3 s
  "apps/terminal: node ../../scripts/live-checks/pool-balance-counts-the-remainder.mjs --harness": 22, // 22 s
  "apps/terminal: node ../../scripts/live-checks/portfolio-one-balance.mjs --harness": 11, // 11 s
  "apps/terminal: node ../../scripts/live-checks/signpage-pool-price.mjs --harness": 25, // 25 s
  "apps/terminal: node ../../scripts/live-checks/token-page-fills-after.mjs --harness": 49, // 49 s
  "apps/terminal: node ../../scripts/live-checks/trade-box-bal-cash.mjs --harness": 23, // 23 s
  "apps/terminal: node ../../scripts/live-checks/trade-box-pool.mjs --harness": 11, // 11 s
  // verify-pools (6 s) and verify-row-survives-one-provider (9 s) join with card e2e-reads-no-public-host (PENDING);
  // the same card's app checks that take --build, measured on a local run (19 Nov 00:55Z),
  // whole seconds, 1 s at the least; app-shell (105 s) joins with the card its PENDING entry names
  // (scripts/ci/app-harness-in-e2e.mjs); app-legend-holds-still and rail-open-pushes-the-middle joined once the rail fix
  // landed, the helper answered from the harness's recordings (19 Nov 07:20Z, local runs)
  "apps/terminal: node ../../scripts/live-checks/app-chains-evm-rail.mjs --build dist": 9, // 9 s
  "apps/terminal: node ../../scripts/live-checks/app-chains-evm.mjs --build dist": 27, // 27 s
  "apps/terminal: node ../../scripts/live-checks/app-chart-fills-in-its-history.mjs --build dist": 58, // 58 s
  "apps/terminal: node ../../scripts/live-checks/app-chart-live.mjs --build dist": 52, // 52 s
  "apps/terminal: node ../../scripts/live-checks/app-discover-live.mjs --build dist": 7, // 7 s
  "apps/terminal: node ../../scripts/live-checks/app-discover-rows-hold.mjs --build dist": 85, // 85 s
  "apps/terminal: node ../../scripts/live-checks/app-discover-toolbar.mjs --build dist": 21, // 21 s
  "apps/terminal: node ../../scripts/live-checks/app-launchpad-badges.mjs --build dist": 9, // 9 s
  "apps/terminal: node ../../scripts/live-checks/app-legend-holds-still.mjs --build dist": 66, // 66 s
  "apps/terminal: node ../../scripts/live-checks/app-near-trading.mjs --build dist": 6, // 6 s
  "apps/terminal: node ../../scripts/live-checks/app-no-test-token.mjs --build dist": 8, // 8 s
  "apps/terminal: node ../../scripts/live-checks/app-token-chart.mjs --build dist": 9, // 9 s
  "apps/terminal: node ../../scripts/live-checks/app-token-rail.mjs --build dist": 4, // 4 s
  "apps/terminal: node ../../scripts/live-checks/app-token-route.mjs --build dist": 21, // 21 s
  "apps/terminal: node ../../scripts/live-checks/app-trade-box-mount.mjs --build dist": 6, // 6 s
  "apps/terminal: node ../../scripts/live-checks/discover-matches-the-main-app.mjs --build dist": 13, // 13 s
  "apps/terminal: node ../../scripts/live-checks/rail-open-pushes-the-middle.mjs --build dist": 9, // 9 s
  "apps/terminal: node ../../scripts/live-checks/words-nov8-final.mjs --local --host app --build dist": 1, // 0 s
  "apps/terminal: node test/withdraw/run.mjs": 14, // B2 14.0
  "apps/terminal: node test/withdraw-form/run.mjs": 5, // C3 4.7
  "apps/terminal: node test/portfolio/run.mjs": 49, // C1 48.9
  "apps/terminal: node test/trade-box/run.mjs": 25, // B2 24.3
  "apps/terminal: node test/trade-pool/run.mjs": 38, // C3 37.2
  "apps/terminal: node test/trade-reads-after-buy/run.mjs": 29, // C1 28.9
  "apps/terminal: node test/buy-route/run.mjs": 16, // B2 15.4
  "apps/terminal: node test/holds-still/run.mjs": 16, // C3 15.5
  "apps/terminal: node test/token-page/run.mjs": 68, // C1 68.0
  "apps/terminal: node test/chart-pointer/run.mjs": 33, // B2 32.1
  "apps/terminal: node test/token-route/run.mjs": 65, // 64.6 s: the never-answers case waits READY_MS at both widths (card app-token-page-rides-out-a-slow-token-read)
  "apps/terminal: node test/chains-evm/run.mjs": 16, // C1 15.3
  "apps/terminal: node test/token-rail/run.mjs": 45, // B2 44.8
  "apps/terminal: node test/token-rail/sweep.mjs": 60, // C3 59.7 (this card's own command, run C only)
  "apps/terminal: node test/header-search/run.mjs": 51, // C1 50.3
  "apps/terminal: node test/trade-box-mount/run.mjs": 6, // C2 5.4
  "apps/terminal: node test/trade-unavailable/run.mjs": 80, // no CI time yet: 93 s on the test box with the send and a slot wait (card app-unavailable-before-the-tap); its test-browser time replaces it
  "apps/terminal: node test/trade-sheet/run.mjs": 29, // C3 28.7
  "apps/terminal: node test/quick-buy/run.mjs": 11, // C1 10.9
  "apps/terminal: node test/signin-screens/run.mjs": 28, // C2 27.4
  "apps/terminal: node test/discover-screens/run.mjs": 35, // C3 34.6
  "apps/terminal: node test/discover-logos/run.mjs": 69, // C1 68.5
  "apps/terminal: node test/sell-positions/run.mjs": 33, // C2 32.0
  "apps/terminal: node test/near-trade/run.mjs": 29, // C3 29.0
  "apps/terminal: node test/orders-soon/run.mjs": 11, // C1 10.2
  "apps/terminal: node ../../scripts/live-checks/app-sell-mount.mjs --harness": 5, // C2 4.8
  "apps/terminal: node test/e2e/signin/run.mjs": 32, // C3 31.7
  "apps/terminal: node test/e2e/signing-sheet/run.mjs": 268, // C1 267.2
  "apps/terminal: node ../../scripts/live-checks/signpage-shell.mjs --engine chromium --width phone": 45, // C2 44.8
  "apps/terminal: node ../../scripts/live-checks/deposit-quote-no-liquidity.mjs --local": 4, // C3 4.0
  "apps/terminal: node ../../scripts/live-checks/sign-out-stops-the-pages-reads.mjs --engine chromium --width phone": 45, // C1 44.7
};
// a command with no measured time yet: the mean of the 48 measured (1752 s / 48 = 36.5 s), above their median (29 s)
export const NEW_E2E_SECONDS = 37;
// test-browser's own steps around the commands, the slowest of the 24 test-browser jobs of the eight merge queue runs
// read (the three above and 44370112520, 44368477150, 44368474730, 44361957842, 44346930793, 44342817974), from the
// jobs API's step times: the job's start to the end of the Chrome step (set up, checkout, pnpm, node, install, Chrome)
// 73 s (job 135040704676), the build 2 s (1.2 s, C3) and the post steps to the job's end 3 s (job 135028592843)
export const E2E_FIXED_SECONDS = 73 + 2 + 3;
// the prover in Chromium (KIT_PROVER_E2E), which ci.yml runs in the first part only: 42 s at the slowest (job
// 135028592843; 21 s to 33 s in the others)
export const E2E_PROVER_SECONDS = 42;

// the build, and every later command as { dir, name, command }
function e2eCommands(script) {
  if (typeof script !== "string" || !script.trim()) throw new Error("apps/terminal has no test:e2e script");
  const [build, ...runs] = chain(script, "test:e2e");
  return { build, runs: runs.map((command) => ({ dir: E2E_DIR, name: "terminal", command })) };
}

// every part of total: [{ commands, seconds }], each command after the build in exactly one, in test:e2e's order; a
// part's seconds are its commands' and, for the first part, the prover's
export function e2eParts(script, total, seconds = E2E_SECONDS) {
  const { runs } = e2eCommands(script);
  checkPart(0, total);
  if (runs.length < total) throw new Error(`test:e2e has ${runs.length} command(s) after the build, fewer than ${total} parts`);
  const start = [E2E_PROVER_SECONDS];
  return shareOut(runs, total, (c) => listedSeconds(c, seconds, NEW_E2E_SECONDS), start).map((p) => ({ commands: p.at.map((i) => runs[i]), seconds: p.seconds }));
}

export function e2ePart(script, index, total, seconds = E2E_SECONDS) {
  const { build } = e2eCommands(script);
  checkPart(index, total);
  return [build, ...e2eParts(script, total, seconds)[index].commands.map((c) => c.command)].join(" && ");
}

// seconds each sweep took on CI, rounded up, the slowest of the two runs read for card ci-mutant-shards-true-times:
// pull request #576's (run 42771653929, its nine test-mutants jobs, 129680697348 as (1) to 129680697527 as (9)) and the
// merge queue's for it (run 42773744496, 129687359884 as (1) to 129687360082 as (9), a runner about 1.5 times slower).
// Each line is `== ok in N s:` of the job's log. Keyed `<package folder>: <command>`; scripts/ci/test-shards.test.mjs
// fails on a key that names no sweep, and on a sweep with no key. No sweep is listed over 300 s (the same test): one
// that took longer runs in parts, its seconds the part's mutants at the slowest time a mutant took.
export const MUTANT_SECONDS = {
  // the kit: test/mutants/*.test.mjs ran as one command (560 s in (1) of the PR run: node --test ran its files at once,
  // evm-pool-mutants.test.mjs 559 s, pool-usd 482 s) and now runs a file at a time. Together they ran, so a part alone
  // takes less than the time listed
  // evm-pool-mutants.test.mjs: its buy (96 mutants, 131.2 s), sell (122, 82.8 s) and index (64, 345.3 s) sweeps in a
  // row, 559.4 s in all, half of each in a part: 280 s (PR run, job 129680697348)
  "packages/kit: MUTANT_PART=1/2 node --test test/mutants/evm-pool-mutants.test.mjs": 280,
  "packages/kit: MUTANT_PART=2/2 node --test test/mutants/evm-pool-mutants.test.mjs": 280,
  // pool-usd-mutants.test.mjs (card solana-reference-read-holds-a-slot-apart): on main's 134 mutants, 67 to a part, part
  // 1/2 took 41 s and 48.2 s and part 2/2 347 s and 352.8 s (runs 42930005546 and 42928442142, jobs 130230098228,
  // 130230098304, 130220829639, 130220829714). 300 s of part 2/2 was one mutant (the S6 withheld-fee mask removed as "",
  // which made the walk's next line the if's body: it never ended and was killed at the sweep's RUN_MS); that row is now
  // ";" and dies in under a second. Net of it, the slowest rate is 52.8 s / 66 = 0.80 s a mutant. The sweep now holds
  // 173 mutants, 87 and 86 to a part: 70 s and 69 s at that rate (on the Mac, 11 Nov 01:44Z: 42.5 s and 50.4 s)
  "packages/kit: MUTANT_PART=1/2 node --test test/mutants/pool-usd-mutants.test.mjs": 70,
  "packages/kit: MUTANT_PART=2/2 node --test test/mutants/pool-usd-mutants.test.mjs": 69,
  "packages/kit: node --test test/mutants/pool-deposit-mutants.test.mjs": 11,
  "packages/kit: node --test test/mutants/vault-settle-mutants.test.mjs": 14,
  // card near-private-trading: 13 mutants and the named tests once, 51 s on the test box as a whole job, its transfer
  // in it (Linux, 11 Nov 18:36Z), at about 1.5 times that on a runner
  "packages/kit: node --test test/mutants/near-rhea-mutants.test.mjs": 77,
  // the NEAR swap calls' checks: 23 mutants and the named tests once, 111 s on the test box as a whole job (Linux, 11 Nov
  // 18:47Z, its slot shared at load 10), at about 1.5 times that on a runner
  "packages/kit: node --test test/mutants/near-swap-mutants.test.mjs": 167,
  // the quote sweep: 733 mutants and 340 named tests, 488.3 s in all on the queue's runner (job 129687360144): 150.3 s
  // for the named tests on the code as it is and 337.5 s for the mutants. A part runs the named tests of its mutants (233
  // of 340) and half the mutants: 150.3 * 233 / 340 + 337.5 * 367 / 733 = 272 s
  "packages/kit: node test/evm-quote-mutants.mjs 1/2": 272,
  "packages/kit: node test/evm-quote-mutants.mjs 2/2": 272,
  // the signing page's, each the slowest of the two runs (jobs (1) to (9) of the PR run; the queue's in brackets)
  "packages/signpage: node --test test/pool-deposit-mutants.test.mjs": 268, // (5) 267.2
  "packages/signpage: node --test test/rules-pool-mutants.test.mjs": 146, // queue (2) 145.3
  "packages/signpage: node --test test/rules-refund-mutants.test.mjs": 79, // (3) 78.1
  "packages/signpage: node --test test/kit-version-mutants.test.mjs": 30, // queue (7) 29.7
  // card pool-usd-price-never-stale: 42 mutants, 28.3 s on the test box (Linux, 10 Nov 18:53Z; main's 17 took 13.6 s
  // on the queue's runner (8)), the 30 min fake-clock runs drained by microtasks and each run's timers bounded
  "packages/signpage: node --test test/pool-price-mutants.test.mjs": 30,
  "packages/signpage: node scripts/held-mutants.mjs": 145, // (4) 144.5
  // card signpage-backup-export: the export of one key, 20 mutants then (19 now, its X9 dropped), 67 s on the Mac
  // (19 Nov 10:36:50-10:37:57Z, the run's output file), at about 1.5 times that on a runner
  "packages/signpage: node scripts/export-mutants.mjs": 101,
  // card sol-rent-back-dust-burn: the rent back's plants in parts, mutant i in part (i % n) + 1. Its 86 plants ran as six
  // parts of 14 or 15 on the queue's runner (jobs 129687360235 (7), 129687360305 (8), 129687360082 (9)): 304.5, 333.8,
  // 378.8, 375.3, 279.4 and 259.4 s, the slowest 27.06 s a plant (part 3, 14 plants, 378.8 s), and eight parts of 11 or
  // 10 plants plan 11 * 27.06 = 298 s at most (six planned 379 s)
  // card round-trip-costs-less: 131 plants (the rent backs' one-W reads added 24; the held passes, the sweep's record and
  // the found W's listing 11; the sale's stamp and the trade lock 3; the spacing store's bound, its newer-only stamp, the
  // clock set back and the stamp awaited before the trade lock goes 5), mutant i in part (i % 14) + 1, so 10 in parts 1
  // to 5 (10 * 27.06 = 271 s at the slowest plant above) and 9 in the rest (244 s); parts of 9 or 10 share out among the
  // other sweeps where eight parts of 17 would not
  "packages/signpage: node scripts/rent-back-mutants.mjs 1/14": 271,
  "packages/signpage: node scripts/rent-back-mutants.mjs 2/14": 271,
  "packages/signpage: node scripts/rent-back-mutants.mjs 3/14": 271,
  "packages/signpage: node scripts/rent-back-mutants.mjs 4/14": 271,
  "packages/signpage: node scripts/rent-back-mutants.mjs 5/14": 271,
  "packages/signpage: node scripts/rent-back-mutants.mjs 6/14": 244,
  "packages/signpage: node scripts/rent-back-mutants.mjs 7/14": 244,
  "packages/signpage: node scripts/rent-back-mutants.mjs 8/14": 244,
  "packages/signpage: node scripts/rent-back-mutants.mjs 9/14": 244,
  "packages/signpage: node scripts/rent-back-mutants.mjs 10/14": 244,
  "packages/signpage: node scripts/rent-back-mutants.mjs 11/14": 244,
  "packages/signpage: node scripts/rent-back-mutants.mjs 12/14": 244,
  "packages/signpage: node scripts/rent-back-mutants.mjs 13/14": 244,
  "packages/signpage: node scripts/rent-back-mutants.mjs 14/14": 244,
  // the helper's: the sell sweep's 244 mutants ran in three parts of 81 or 82 on the queue's runner, the third 301.9 s
  // (3.73 s a mutant, job 129687360155; 2.60 and 2.84 s in the others), so it runs in four parts of 61: 228 s
  "apps/helper: node test/pool-evm/sell-mutants.mjs 1/4": 228,
  "apps/helper: node test/pool-evm/sell-mutants.mjs 2/4": 228,
  "apps/helper: node test/pool-evm/sell-mutants.mjs 3/4": 228,
  "apps/helper: node test/pool-evm/sell-mutants.mjs 4/4": 228,
  "apps/helper: node test/pool-evm/release-mutants.mjs": 46, // PR run (1) 45.2
  // the wallet's
  "packages/wallet: FULL_RUNS=1 node --test test/note-restore.test.ts test/store.test.ts test/note-store-crash.test.ts test/pool-solana.test.ts": 148, // queue (4)
  "packages/wallet: node scripts/note-restore-refund-mutants.mjs": 4, // PR run (6) 3.4
  "packages/wallet: node scripts/near-prepay-taken-mutants.mjs": 269, // queue (4) 268.7
  // 168 mutants in 545.1 s on the PR run (job 129680697399 as (6), 3.24 s each), 84 to a part
  "packages/wallet: node scripts/held-moveout-mutants.mjs 1/2": 273,
  "packages/wallet: node scripts/held-moveout-mutants.mjs 2/2": 273,
  "packages/wallet: node scripts/refund-move-mutants.mjs": 45, // PR run (5) 44.4
  "packages/wallet: node scripts/exit-scan-mutants.mjs": 142, // PR run (3) 141.6
  "packages/wallet: node scripts/restore-wallets-mutants.mjs": 141, // queue (9) 140.3
};
// a sweep with no measured time yet: about the middle ones measured (162 and 223 s)
export const NEW_SWEEP_SECONDS = 200;
// a part's planned seconds at most, well inside test-mutants' 15 minutes; ci.yml's matrix lists enough parts to hold it
export const PART_BUDGET_SECONDS = 540;
// a sweep's listed seconds at most (card ci-mutant-shards-true-times): one slower than this runs in parts, so a slow
// runner holding one sweep can never fill a part alone
export const MAX_SWEEP_SECONDS = 300;

export const sweepKey = (c) => `${c.dir}: ${c.command}`;

// every sweep the split shares out: [{ dir, name, command }], each package's commands in their script's order
export function mutantCommands(root) {
  const read = (f) => readFileSync(path.join(root, f), "utf8");
  const globs = [...read("pnpm-workspace.yaml").matchAll(/^\s+-\s+["']?([^"'\s]+)["']?\s*$/gm)].map((m) => m[1]);
  const out = [];
  for (const pkg of globs.flatMap((g) => globSync(`${g}/package.json`, { cwd: root })).toSorted()) {
    const { name, scripts } = JSON.parse(read(pkg));
    const script = scripts?.["test:mutants"];
    if (script === undefined) continue;
    const dir = path.dirname(pkg).split(path.sep).join("/");
    if (typeof script !== "string" || !script.trim()) throw new Error(`${dir} has an empty test:mutants script`);
    for (const command of chain(script, `${dir}'s test:mutants`)) out.push({ dir, name, command });
  }
  return out;
}

// items shared out in parts of total: largest first, each to the part with the fewest planned seconds so far; [{ at, seconds }]
// (card ci-e2e-shards-by-time: start is the seconds a part holds before any item, by its index, and a part that has no
// item yet goes first, so a part that starts with seconds is never left with none when there are items enough)
function shareOut(items, total, weight, start = []) {
  const order = items.map((c, i) => i).sort((a, b) => weight(items[b]) - weight(items[a]) || a - b);
  const parts = Array.from({ length: total }, (_, j) => ({ at: [], seconds: start[j] ?? 0 }));
  const fewer = (p, q) => (!p.at.length && q.at.length) || (!p.at.length === !q.at.length && p.seconds < q.seconds);
  for (const i of order) {
    const least = parts.reduce((best, p, j) => (fewer(p, parts[best]) ? j : best), 0);
    parts[least].at.push(i);
    parts[least].seconds += weight(items[i]);
  }
  return parts.map((p) => ({ ...p, at: p.at.sort((a, b) => a - b) }));
}

// the seconds a sweep is planned at: its listed time, or NEW_SWEEP_SECONDS (a browser run's NEW_E2E_SECONDS) when it has none
export const listedSeconds = (c, seconds = MUTANT_SECONDS, fallback = NEW_SWEEP_SECONDS) => (Object.hasOwn(seconds, sweepKey(c)) ? seconds[sweepKey(c)] : fallback);

// every part of total: [{ commands, seconds }], each command in exactly one
export function mutantParts(commands, total, seconds = MUTANT_SECONDS) {
  checkPart(0, total);
  if (!commands.length) throw new Error("no workspace package has a test:mutants sweep for the split");
  if (commands.length < total) throw new Error(`the sweeps are ${commands.length} command(s), fewer than ${total} parts`);
  return shareOut(commands, total, (c) => listedSeconds(c, seconds)).map((p) => ({ commands: p.at.map((i) => commands[i]), seconds: p.seconds }));
}

export function mutantsPart(commands, index, total, seconds = MUTANT_SECONDS) {
  checkPart(index, total);
  return mutantParts(commands, total, seconds)[index].commands;
}

// A sweep that took more than this many times its listed seconds prints a warning annotation
export const STALE_FACTOR = 1.25;

// the GitHub annotation for a sweep that ran past STALE_FACTOR times its listed seconds, or null (a workflow command's
// data escapes %, CR and LF); a sweep with no listed time is planned at NEW_SWEEP_SECONDS. A browser run's command
// names its own table: { table: "E2E_SECONDS", fallback: NEW_E2E_SECONDS }
export function staleWarning(c, measured, seconds = MUTANT_SECONDS, { table = "MUTANT_SECONDS", fallback = NEW_SWEEP_SECONDS } = {}) {
  const listed = listedSeconds(c, seconds, fallback);
  if (!(measured > STALE_FACTOR * listed)) return null;
  const note = Object.hasOwn(seconds, sweepKey(c)) ? `listed ${listed} s` : `no listed time, planned at ${listed} s`;
  const text = `${sweepKey(c)} took ${measured} s, ${note}: set its ${table} time in scripts/ci/test-shards.mjs to the measured time (a slow runner alone is not a failure)`;
  return `::warning::${text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`;
}

// runs each command in root/<dir> under `pnpm exec sh -c` (the package's and the root's node_modules/.bin on PATH, as
// pnpm run gives a script), every one even after a failure: [{ dir, command, seconds, ok }]. `clock` gives milliseconds
// (injected by the tests); a sweep past STALE_FACTOR times its listed seconds is followed by its warning line.
export function runPart(commands, root, log = console.log, { clock = () => performance.now(), seconds: table = MUTANT_SECONDS, ...names } = {}) {
  const ran = [];
  for (const c of commands) {
    log(`\n== ${sweepKey(c)}`);
    const start = clock();
    const r = spawnSync("pnpm", ["exec", "sh", "-c", c.command], { cwd: path.join(root, c.dir), stdio: "inherit" });
    const seconds = Math.round((clock() - start) / 100) / 10;
    const ok = r.status === 0;
    log(`== ${ok ? "ok" : `failed (${r.error?.message ?? r.signal ?? `exit ${r.status}`})`} in ${seconds} s: ${sweepKey(c)}`);
    const warning = staleWarning(c, seconds, table, names);
    if (warning) log(warning);
    ran.push({ dir: c.dir, command: c.command, seconds, ok });
  }
  return ran;
}

// ---- the checks that read the live helper on a local build (card queue-browser-checks-tell-a-helper-miss-from-a-page-fault)
// Merge queue group 44547353452 (19 Nov 14:46Z) refused app-trade-box-mount on main's own build while the live helper's
// vendor answered 503: one read of a check that reads the live helper took the helper's miss for the page's fault. Each
// such check imports scripts/live-checks/helper-misses.mjs (liveHelper routes and watches the helper, its verdictOf makes a
// FAIL with a helper miss INCONCLUSIVE, exit 3), and e2e-run runs it through scripts/ci/live-rerun.mjs's rerun rule, as the
// live runs do: an INCONCLUSIVE runs again within RERUN's bound, a FAIL or an ERROR fails at once, and one still
// INCONCLUSIVE after the last run prints a notice and is no FAIL (live-rerun.mjs's header). No rerun starts past
// E2E_RERUN_BUDGET_S of the part's own clock, so the reruns stay inside test-browser's timeout-minutes.
export const HELPER_MISSES = /from\s+["']\.\/helper-misses\.mjs["']/;
export const E2E_RERUN_BUDGET_S = 12 * 60;
/** The live check's key when `command` runs one that reads the live helper (its file imports helper-misses.mjs), else
 *  null. `read(key)` returns the check's source, null when there is none. */
export function helperLiveKey(command, read = (k) => readFileSync(path.join(ROOT, "scripts/live-checks", `${k}.mjs`), "utf8")) {
  const m = /^node \.\.\/\.\.\/scripts\/live-checks\/([a-z][a-z0-9-]*)\.mjs(?=\s|$)/.exec(command);
  if (!m) return null;
  let text = null;
  try {
    text = read(m[1]);
  } catch {}
  return text && HELPER_MISSES.test(text) ? m[1] : null;
}
/** The live checks that route the live helper the way this card replaced (`HELPER_HOST ? r.continue() : harness(r)`),
 *  past helper-misses.mjs: [file], from `files` ({ file, text }). Each must use liveHelper, or its misses read as FAILs. */
export const OWN_HELPER_ROUTE = /HELPER_(?:HOST|URL)\s*\?\s*r\.continue\(\)\s*:\s*harness\(r\)/;
export const ownHelperRoutes = (files) => files.filter((f) => OWN_HELPER_ROUTE.test(f.text)).map((f) => f.file);

// Card queue-browser-checks-tell-a-helper-miss-from-a-page-fault, round 2: merge queue group 44559433373 (PR 1086),
// test-browser (4) job 135684403606, started app-chart-fills-in-its-history at 15:56:04Z, printed nothing, and was
// cancelled at the job's 15 minutes at 16:06:26Z: no command had a bound of its own, so one stall cancelled the shard and
// no verdict ran. That check's own walk is bounded only by TRIES picks of FIRST_MS + WATCH_MAX_MS each (6 x 230 s, about
// 23 min), and its first read of the helper's lists (candidates(), a fetch with no timeout) by Node's own. Every e2e-run
// command now runs in its own process group under a wall bound from its listed seconds (boundOf: E2E_BOUND.factor times
// them, at least E2E_BOUND.floorS more: 180 s, so app-chart-fills-in-its-history's one filling pick, FIRST_MS and
// WATCH_MAX_MS, 230 s, fits its 238 s); past it the group is sent SIGTERM, then SIGKILL after E2E_BOUND.graceS. A check
// that imports scripts/live-checks/helper-misses.mjs prints, on that SIGTERM, the helper misses it saw: with one it ends
// INCONCLUSIVE (exit 3, run again by the rerun rule), with none FAIL (exit 1); any other command stopped at its bound
// fails; the runner's own line names the bound.
export const E2E_BOUND = Object.freeze({ factor: 2, floorS: 180, graceS: 10 });
/** The build's bound (it takes about 2 s; E2E_FIXED_SECONDS counts it). */
export const E2E_BUILD_BOUND_S = 300;
/** A command's wall bound, seconds: E2E_BOUND.factor times its listed seconds, and at least E2E_BOUND.floorS more. */
export function boundOf(c, seconds = E2E_SECONDS, fallback = NEW_E2E_SECONDS) {
  const listed = listedSeconds(c, seconds, fallback);
  return Math.max(E2E_BOUND.factor * listed, listed + E2E_BOUND.floorS);
}
/** The line helper-misses.mjs prints when its check is stopped at its bound with a miss seen (its exit 3). */
export const STOPPED_INCONCLUSIVE = /^INCONCLUSIVE stopped at its bound\b/m;
/** The exit a command stopped at its bound is read as: 3 when its check said INCONCLUSIVE for a helper miss, else 1. */
export const stoppedCode = (output) => (STOPPED_INCONCLUSIVE.test(String(output)) ? 3 : 1);

/**
 * One run of `c` under `pnpm exec sh -c` in root/<dir>, in its own process group, under a wall bound of `boundS`
 * seconds: { code, output, stopped }. With `capture`, its stdout and stderr go through one pipe, each chunk to `write` as
 * it comes, and are kept; else they are the runner's own. Past the bound the group is sent SIGTERM and, `graceS` later,
 * SIGKILL; the run's code is then stoppedCode(output).
 */
export function runBounded(c, root, boundS, { capture = false, write = (b) => process.stdout.write(b), log = console.log, graceS = E2E_BOUND.graceS } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let stopped = false;
    let hard = null;
    const child = spawn("pnpm", ["exec", "sh", "-c", capture ? `${c.command} 2>&1` : c.command], {
      cwd: path.join(root, c.dir),
      detached: true,
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    const group = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {}
    };
    const soft = setTimeout(() => {
      stopped = true;
      log(`== past its bound of ${boundS} s: ${sweepKey(c)}: its process group sent SIGTERM (SIGKILL in ${graceS} s)`);
      group("SIGTERM");
      hard = setTimeout(() => group("SIGKILL"), graceS * 1000);
    }, boundS * 1000);
    if (capture) child.stdout.on("data", (b) => (write(b), chunks.push(b)));
    const done = (code, extra = "") => {
      clearTimeout(soft);
      const output = `${Buffer.concat(chunks).toString("utf8")}${extra}`;
      // what the group left running past the command's own end goes with it
      if (stopped) {
        clearTimeout(hard);
        group("SIGKILL");
      }
      resolve({ code: stopped ? stoppedCode(output) : code, output, stopped });
    };
    child.on("error", (e) => done(2, e.message));
    child.on("close", (code) => done(code ?? 2));
  });
}

// the part's commands, each under its bound (runBounded), and a check that reads the live helper through live-rerun's
// rerun(): [{ dir, command, seconds, ok }]. `run` ((c, boundS, capture) => { code, output }), `sleep`, `read` and
// `bound` are injected by the tests.
export async function runE2ePart(commands, root, log = console.log, { clock = () => performance.now(), run, sleep, read, bound, budgetS = E2E_RERUN_BUDGET_S, ...names } = {}) {
  const runOne = run ?? ((c, boundS, capture) => runBounded(c, root, boundS, { capture, log }));
  const boundFor = bound ?? ((c) => boundOf(c, names.seconds ?? E2E_SECONDS, names.fallback ?? NEW_E2E_SECONDS));
  const t0 = clock();
  const ran = [];
  for (const c of commands) {
    const key = helperLiveKey(c.command, read);
    const boundS = boundFor(c);
    const start = clock();
    let ok;
    let failed = "";
    let runs = null;
    if (!key) {
      log(`\n== ${sweepKey(c)}`);
      const r = await runOne(c, boundS, false);
      ok = r.code === 0;
      failed = r.stopped ? `stopped at its bound of ${boundS} s` : `exit ${r.code}`;
    } else {
      const { rerun, noticeLine } = await import("./live-rerun.mjs");
      log(`\n== ${sweepKey(c)} (reads the live helper: an INCONCLUSIVE runs again)`);
      const r = await rerun(key, [], { run: () => runOne(c, boundS, true), say: log, ...(sleep ? { sleep } : {}), before: async (n) => n === 1 || (clock() - t0) / 1000 < budgetS });
      ok = r.exit === 0;
      if (r.verdict === "inconclusive") log(noticeLine(key, `${r.reason}${r.stopped ? " (no rerun past the part's budget)" : ""}`));
      failed = `${r.verdict}, exit ${r.code}`;
      runs = r.runs;
    }
    const seconds = Math.round((clock() - start) / 100) / 10;
    const after = runs === null ? "" : ` after ${runs} run${runs === 1 ? "" : "s"}`;
    log(`== ${ok ? "ok" : `failed (${failed})`} in ${seconds} s${after}: ${sweepKey(c)}`);
    const warning = runs === null || runs === 1 ? staleWarning(c, seconds, names.seconds ?? MUTANT_SECONDS, names) : null;
    if (warning) log(warning);
    ran.push({ dir: c.dir, command: c.command, seconds, ok });
  }
  return ran;
}

// The test files of a package's test/mutants folder that none of the package's test:mutants commands names, by path or by
// glob (card ci-mutant-shards-true-times: the kit's four ran as one glob and now run a file at a time, so a new file is
// in no command until someone adds one). [path from the root], for the files git tracks.
export function unnamedMutantFiles(root, commands = mutantCommands(root)) {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", ":(glob)**/test/mutants/*.test.mjs", ":(glob)**/test/mutants/*.test.ts"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(Boolean).toSorted();
  return tracked.filter((f) => {
    const dir = f.slice(0, f.indexOf("/test/mutants/"));
    const rel = f.slice(dir.length + 1);
    return !commands.some((c) => c.dir === dir && c.command.split(/\s+/).some((w) => globSync(w.replace(/^(['"])(.*)\1$/, "$2"), { cwd: path.join(root, dir) }).includes(rel)));
  });
}

// ---- the packages' tests (card ci-mutant-shards-true-times)

// the wallet's tests run in the job test-wallet, not in the split
export const WALLET = "@blindfill/wallet";
// seconds each item took in pull request #576's test-packages job (run 42771653929, job 129680697146), rounded up: a
// package's `ℹ duration_ms` lines in the log (the signing page's six `node --test` commands added up), the typecheck, the
// deploy gate's tests, the live-check replays and the bundle checks by their steps' start and end. The merge queue's
// runner for it (run 42773744496, job 129687359981) took about 1.5 times as long: kit 319 s, signpage 492 s, terminal 33 s,
// exit 70 s, helper 240 s, typecheck 39 s, replays 107 s, and its test step 732 s against the 503 s here
export const PACKAGE_SECONDS = {
  "tests @blindfill/kit": 205,
  "tests signpage": 312,
  "tests @confidential-trenches/helper": 191,
  "tests @blindfill/exit": 42,
  "tests terminal": 24,
  // examples/agent's guard test (card example-agent-full-cycle): 4 tests, under a second on the Mac, rounded up
  "tests blindfill-agent-example": 1,
  typecheck: 25,
  "deploy gate": 1,
  "live-check replays": 74,
  "bundle checks": 5,
};
// an item with no measured time yet: about the middle of the packages' (the kit's, the helper's)
export const NEW_PACKAGE_SECONDS = 200;
// a part's planned seconds at most: 8 minutes, so that a runner 1.5 times slower still ends inside 15 (720 s, and the
// install and checkout)
export const PACKAGE_PART_BUDGET_SECONDS = 480;
export const PACKAGE_STEPS = ["typecheck", "deploy gate", "live-check replays", "bundle checks"];

export const packageKey = (item) => (item.kind === "tests" ? `tests ${item.name}` : item.name);

// the items the split shares out: each workspace package's test script but the wallet's, in name order, then the steps
export function packageItems(root) {
  const read = (f) => readFileSync(path.join(root, f), "utf8");
  const globs = [...read("pnpm-workspace.yaml").matchAll(/^\s+-\s+["']?([^"'\s]+)["']?\s*$/gm)].map((m) => m[1]);
  const tests = [];
  for (const pkg of globs.flatMap((g) => globSync(`${g}/package.json`, { cwd: root })).toSorted()) {
    const { name, scripts } = JSON.parse(read(pkg));
    if (name !== WALLET && scripts?.test !== undefined) tests.push({ kind: "tests", name, dir: path.dirname(pkg).split(path.sep).join("/") });
  }
  return [...tests, ...PACKAGE_STEPS.map((name) => ({ kind: "step", name }))];
}

// every part of total: [{ items, seconds }], each item in exactly one
export function packageParts(items, total, seconds = PACKAGE_SECONDS) {
  checkPart(0, total);
  if (!items.length) throw new Error("no workspace package has a test script for the split");
  if (items.length < total) throw new Error(`the packages' items are ${items.length}, fewer than ${total} parts`);
  return shareOut(items, total, (i) => seconds[packageKey(i)] ?? NEW_PACKAGE_SECONDS).map((p) => ({ items: p.at.map((i) => items[i]), seconds: p.seconds }));
}

export function packagesPart(items, index, total, seconds = PACKAGE_SECONDS) {
  checkPart(index, total);
  return packageParts(items, total, seconds)[index].items;
}

// pr-paths.mjs's selector for a step: "" every package, "none" none, else one --filter=<name> per package; as the names
// (null for every package, [] for none). Anything else is refused rather than read wrong.
export function selectedPackages(select) {
  const t = (select ?? "").trim();
  if (t === "") return null;
  if (t === "none") return [];
  return t.split(/\s+/).map((w) => {
    const m = /^--filter=([@a-z0-9/._-]+)$/.exec(w);
    if (!m) throw new Error(`the package selector ${JSON.stringify(select)} is neither empty, none nor --filter=<name> words`);
    return m[1];
  });
}

// the --filter words a part's test run takes: its packages the selector keeps
export function testFilters(part, select) {
  const keep = selectedPackages(select);
  return part.filter((i) => i.kind === "tests" && (keep === null || keep.includes(i.name))).map((i) => `--filter=${i.name}`);
}

// the typecheck run's pnpm words in the part that has it: every package for an empty selector, none for none
export function typecheckArgs(part, select) {
  if (!part.some((i) => i.name === "typecheck")) return null;
  const keep = selectedPackages(select);
  if (keep !== null && !keep.length) return null;
  return ["-r", ...(keep ?? []).map((n) => `--filter=${n}`), "--if-present", "run", "typecheck"];
}

// the packages' part: `plan` writes the part's yes or no for the steps ci.yml writes out (GITHUB_OUTPUT lines), `tests`
// and `typecheck` run the part's pnpm line, narrowed by SELECT, and exit with its status
function packagesMain(step, index, total) {
  const part = packagesPart(packageItems(ROOT), index, total);
  const names = part.map(packageKey);
  const out = (line) => process.stderr.write(`${line}\n`);
  if (step === "plan") {
    out(`part ${index + 1} of ${total}, planned ${packageParts(packageItems(ROOT), total)[index].seconds} s: ${names.join(", ")}`);
    for (const [key, name] of [["deploy_gate", "deploy gate"], ["replays", "live-check replays"], ["bundle", "bundle checks"]]) console.log(`${key}=${part.some((i) => i.name === name)}`);
    return;
  }
  const select = process.env.SELECT ?? "";
  let args = null;
  if (step === "tests") {
    const filters = testFilters(part, select);
    args = filters.length ? ["-r", ...filters, "--if-present", "--no-bail", "run", "test"] : null;
  } else if (step === "typecheck") args = typecheckArgs(part, select);
  else throw new Error(`no packages step ${step}: plan, tests or typecheck`);
  if (!args) return out(`skip: nothing of this part's ${step} to run (part ${index + 1} of ${total}: ${names.join(", ")}; selector ${JSON.stringify(select)})`);
  out(`part ${index + 1} of ${total}: pnpm ${args.join(" ")}`);
  process.exit(spawnSync("pnpm", args, { cwd: ROOT, stdio: "inherit" }).status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [what, index, total] = process.argv.slice(2);
  const int = (s) => (/^\d+$/.test(s ?? "") ? Number(s) : NaN);
  try {
    if (what === "e2e") {
      const script = JSON.parse(readFileSync(path.join(ROOT, "apps/terminal/package.json"), "utf8")).scripts?.["test:e2e"];
      console.log(e2ePart(script, int(index), int(total)));
    } else if (what === "e2e-run") {
      const script = JSON.parse(readFileSync(path.join(ROOT, "apps/terminal/package.json"), "utf8")).scripts?.["test:e2e"];
      const { build } = e2eCommands(script);
      checkPart(int(index), int(total));
      const parts = e2eParts(script, int(total));
      const part = parts[int(index)].commands;
      console.log(`part ${int(index) + 1} of ${int(total)}, planned ${parts[int(index)].seconds} s${int(index) === 0 ? ` (the prover's ${E2E_PROVER_SECONDS} s in it)` : ""}:`);
      for (const c of part) console.log(`  ${sweepKey(c)}`);
      const names = { seconds: E2E_SECONDS, table: "E2E_SECONDS", fallback: NEW_E2E_SECONDS };
      // the build, timed with the fixed steps (E2E_FIXED_SECONDS), so no table lists it and it is never warned on
      const [built] = await runE2ePart([{ dir: E2E_DIR, name: "terminal", command: build }], ROOT, console.log, { ...names, seconds: {}, fallback: Infinity, bound: () => E2E_BUILD_BOUND_S });
      if (!built.ok) process.exit(1);
      // a check that reads the live helper runs through live-rerun's rerun rule (runE2ePart)
      const ran = await runE2ePart(part, ROOT, console.log, names);
      console.log(`\npart ${int(index) + 1} of ${int(total)}:`);
      for (const r of [built, ...ran]) console.log(`  ${String(r.seconds).padStart(7)} s  ${r.ok ? "ok    " : "FAILED"}  ${sweepKey(r)}`);
      if (ran.some((r) => !r.ok)) process.exit(1);
    } else if (what === "mutants") {
      const commands = mutantCommands(ROOT);
      const parts = mutantParts(commands, int(total));
      const part = mutantsPart(commands, int(index), int(total));
      console.log(`part ${int(index) + 1} of ${int(total)}, planned ${parts[int(index)].seconds} s:`);
      for (const c of part) console.log(`  ${sweepKey(c)}`);
      const ran = runPart(part, ROOT);
      console.log(`\npart ${int(index) + 1} of ${int(total)}:`);
      for (const r of ran) console.log(`  ${String(r.seconds).padStart(7)} s  ${r.ok ? "ok    " : "FAILED"}  ${sweepKey(r)}`);
      if (ran.some((r) => !r.ok)) process.exit(1);
    } else if (what === "packages") {
      const [, , , step, i, t] = process.argv;
      packagesMain(step, int(i), int(t));
    } else {
      throw new Error("usage: node scripts/ci/test-shards.mjs e2e|e2e-run|mutants <index> <total>, or packages plan|tests|typecheck <index> <total>");
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
