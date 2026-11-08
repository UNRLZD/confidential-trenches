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
import { spawnSync } from "node:child_process";
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

// seconds each sweep took on CI, rounded up, read from each part's own log, keyed `<package folder>: <command>`: the
// higher of main ad1136e1's pull request #436 (run 42430511830, its six test-mutants jobs) and this card's pull request
// #474 at e07b87ba (run 42494845995, its seven test-mutants jobs, the wallet's sweeps among them: card
// held-move-forgotten-tx), but where a line says otherwise; scripts/ci/test-shards.test.mjs fails on a key that names no
// sweep, and on a sweep with no key
export const MUTANT_SECONDS = {
  'packages/kit: node --test "test/mutants/*.test.mjs"': 468,
  "packages/kit: node test/evm-quote-mutants.mjs": 376,
  "packages/signpage: node --test test/pool-deposit-mutants.test.mjs": 273,
  "packages/signpage: node --test test/rules-pool-mutants.test.mjs": 133,
  "packages/signpage: node --test test/rules-refund-mutants.test.mjs": 76,
  "packages/signpage: node --test test/kit-version-mutants.test.mjs": 20,
  "packages/signpage: node --test test/pool-price-mutants.test.mjs": 15,
  "packages/signpage: node scripts/held-mutants.mjs": 84,
  "apps/helper: node test/pool-evm/sell-mutants.mjs 1/3": 226,
  "apps/helper: node test/pool-evm/sell-mutants.mjs 2/3": 301,
  "apps/helper: node test/pool-evm/sell-mutants.mjs 3/3": 208,
  "apps/helper: node test/pool-evm/release-mutants.mjs": 45,
  // the wallet's, before #474 run one after another in test-wallet after its tests: the higher of #474's split and
  // main 8ee3697b's test-wallet log at each sweep's last line (run 42488418921, job 128755272307)
  "packages/wallet: FULL_RUNS=1 node --test test/note-restore.test.ts test/store.test.ts test/note-store-crash.test.ts test/pool-solana.test.ts": 150,
  "packages/wallet: node scripts/note-restore-refund-mutants.mjs": 4,
  "packages/wallet: node scripts/near-prepay-taken-mutants.mjs": 276,
  "packages/wallet: node scripts/held-moveout-mutants.mjs": 271,
  "packages/wallet: node scripts/refund-move-mutants.mjs": 45,
  "packages/wallet: node scripts/exit-scan-mutants.mjs": 145,
  // card wallet-restore-wallets (main daa758ea): its pull request's test-wallet log, 15:42:46.7Z to 15:43:56.3Z (run
  // 42495419979, job 128776599060)
  "packages/wallet: node scripts/restore-wallets-mutants.mjs": 70,
};
// a sweep with no measured time yet: about the middle ones measured (162 and 223 s)
export const NEW_SWEEP_SECONDS = 200;
// a part's planned seconds at most, well inside test-mutants' 15 minutes; ci.yml's matrix lists enough parts to hold it
export const PART_BUDGET_SECONDS = 540;

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

// every part of total: [{ commands, seconds }], each command in exactly one
export function mutantParts(commands, total, seconds = MUTANT_SECONDS) {
  checkPart(0, total);
  if (!commands.length) throw new Error("no workspace package has a test:mutants sweep for the split");
  if (commands.length < total) throw new Error(`the sweeps are ${commands.length} command(s), fewer than ${total} parts`);
  const weight = (c) => seconds[sweepKey(c)] ?? NEW_SWEEP_SECONDS;
  const order = commands.map((c, i) => i).sort((a, b) => weight(commands[b]) - weight(commands[a]) || a - b);
  const parts = Array.from({ length: total }, () => ({ at: [], seconds: 0 }));
  for (const i of order) {
    const least = parts.reduce((best, p, j) => (p.seconds < parts[best].seconds ? j : best), 0);
    parts[least].at.push(i);
    parts[least].seconds += weight(commands[i]);
  }
  return parts.map((p) => ({ commands: p.at.sort((a, b) => a - b).map((i) => commands[i]), seconds: p.seconds }));
}

export function mutantsPart(commands, index, total, seconds = MUTANT_SECONDS) {
  checkPart(index, total);
  return mutantParts(commands, total, seconds)[index].commands;
}

// runs each command in root/<dir> under `pnpm exec sh -c` (the package's and the root's node_modules/.bin on PATH, as
// pnpm run gives a script), every one even after a failure: [{ dir, command, seconds, ok }]
export function runPart(commands, root, log = console.log) {
  const ran = [];
  for (const c of commands) {
    log(`\n== ${sweepKey(c)}`);
    const start = performance.now();
    const r = spawnSync("pnpm", ["exec", "sh", "-c", c.command], { cwd: path.join(root, c.dir), stdio: "inherit" });
    const seconds = Math.round((performance.now() - start) / 100) / 10;
    const ok = r.status === 0;
    log(`== ${ok ? "ok" : `failed (${r.error?.message ?? r.signal ?? `exit ${r.status}`})`} in ${seconds} s: ${sweepKey(c)}`);
    ran.push({ dir: c.dir, command: c.command, seconds, ok });
  }
  return ran;
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
    } else {
      throw new Error("usage: node scripts/ci/test-shards.mjs e2e|mutants <index> <total>");
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
