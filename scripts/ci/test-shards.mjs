// Card ci-test-shards: the share of apps/terminal's test:e2e that one part of ci.yml's test-browser matrix runs.
//   node scripts/ci/test-shards.mjs e2e <index> <total>    (prints the part's command; exit 1 and the reason otherwise)
//
// test:e2e is one chain, `a && b && c ...`: its first command (the build) runs in every part, and each later command
// in exactly one, command i in part (i - 1) % total. ci.yml passes the job's own strategy.job-index and
// strategy.job-total, so every command runs in some part whatever the matrix lists. A chain this cannot split into
// commands that stand alone (||, ;, a pipe, a newline) is refused rather than split wrong, and so is a part left
// with nothing but the build.
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
import { execFileSync, spawnSync } from "node:child_process";
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

export function e2ePart(script, index, total) {
  if (typeof script !== "string" || !script.trim()) throw new Error("apps/terminal has no test:e2e script");
  checkPart(index, total);
  const [build, ...runs] = chain(script, "test:e2e");
  if (runs.length < total) throw new Error(`test:e2e has ${runs.length} command(s) after the build, fewer than ${total} parts`);
  return [build, ...runs.filter((_, i) => i % total === index)].join(" && ");
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
  // card sol-rent-back-dust-burn: the rent back's plants in parts, mutant i in part (i % n) + 1. Its 86 plants ran as six
  // parts of 14 or 15 on the queue's runner (jobs 129687360235 (7), 129687360305 (8), 129687360082 (9)): 304.5, 333.8,
  // 378.8, 375.3, 279.4 and 259.4 s, the slowest 27.06 s a plant (part 3, 14 plants, 378.8 s), and eight parts of 11 or
  // 10 plants plan 11 * 27.06 = 298 s at most (six planned 379 s)
  // card round-trip-costs-less: 126 plants (the sale's closes and the rent backs' one-W reads added 39), mutant i in
  // part (i % 14) + 1, so 9 in each: 9 * 27.06 = 244 s at the slowest plant above; parts of 9 share out among the other
  // sweeps where twelve parts of 11 would not
  "packages/signpage: node scripts/rent-back-mutants.mjs 1/14": 244,
  "packages/signpage: node scripts/rent-back-mutants.mjs 2/14": 244,
  "packages/signpage: node scripts/rent-back-mutants.mjs 3/14": 244,
  "packages/signpage: node scripts/rent-back-mutants.mjs 4/14": 244,
  "packages/signpage: node scripts/rent-back-mutants.mjs 5/14": 244,
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
function shareOut(items, total, weight) {
  const order = items.map((c, i) => i).sort((a, b) => weight(items[b]) - weight(items[a]) || a - b);
  const parts = Array.from({ length: total }, () => ({ at: [], seconds: 0 }));
  for (const i of order) {
    const least = parts.reduce((best, p, j) => (p.seconds < parts[best].seconds ? j : best), 0);
    parts[least].at.push(i);
    parts[least].seconds += weight(items[i]);
  }
  return parts.map((p) => ({ ...p, at: p.at.sort((a, b) => a - b) }));
}

// the seconds a sweep is planned at: its listed time, or NEW_SWEEP_SECONDS when it has none
export const listedSeconds = (c, seconds = MUTANT_SECONDS) => seconds[sweepKey(c)] ?? NEW_SWEEP_SECONDS;

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
// data escapes %, CR and LF); a sweep with no listed time is planned at NEW_SWEEP_SECONDS
export function staleWarning(c, measured, seconds = MUTANT_SECONDS) {
  const listed = listedSeconds(c, seconds);
  if (!(measured > STALE_FACTOR * listed)) return null;
  const note = Object.hasOwn(seconds, sweepKey(c)) ? `listed ${listed} s` : `no listed time, planned at ${listed} s`;
  const text = `${sweepKey(c)} took ${measured} s, ${note}: set its MUTANT_SECONDS time in scripts/ci/test-shards.mjs to the measured time (a slow runner alone is not a failure)`;
  return `::warning::${text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`;
}

// runs each command in root/<dir> under `pnpm exec sh -c` (the package's and the root's node_modules/.bin on PATH, as
// pnpm run gives a script), every one even after a failure: [{ dir, command, seconds, ok }]. `clock` gives milliseconds
// (injected by the tests); a sweep past STALE_FACTOR times its listed seconds is followed by its warning line.
export function runPart(commands, root, log = console.log, { clock = () => performance.now(), seconds: table = MUTANT_SECONDS } = {}) {
  const ran = [];
  for (const c of commands) {
    log(`\n== ${sweepKey(c)}`);
    const start = clock();
    const r = spawnSync("pnpm", ["exec", "sh", "-c", c.command], { cwd: path.join(root, c.dir), stdio: "inherit" });
    const seconds = Math.round((clock() - start) / 100) / 10;
    const ok = r.status === 0;
    log(`== ${ok ? "ok" : `failed (${r.error?.message ?? r.signal ?? `exit ${r.status}`})`} in ${seconds} s: ${sweepKey(c)}`);
    const warning = staleWarning(c, seconds, table);
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
      throw new Error("usage: node scripts/ci/test-shards.mjs e2e|mutants <index> <total>, or packages plan|tests|typecheck <index> <total>");
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
