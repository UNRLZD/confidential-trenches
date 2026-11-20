// card mutant-sweeps-refuse-no-verdict: every mutant sweep reads its runs through scripts/mutant-run.mjs, so a run with no
// verdict is refused, never read as a survivor or a kill, and its plant goes back before the sweep's process ends. Before,
// thirteen sweeps read `ℹ fail` themselves (and restore-wallets-mutants.mjs kept its own copy of the rule): a hung run printed "SURVIVED pass undefined fail undefined", and a sweep
// that ended inside a run (group-run's exit 124 at its bound, which skips the sweep's own finally) left its plant written
// into the source.
//   node --test scripts/ci/mutant-run.test.mjs
// Each sweep runs as written on a copy of the folders it plants in, in a temp dir, so no plant touches this checkout.
// Every test run it starts hangs (a preload that blocks a `--test-isolation=none` run; a plain `--test` run, a sweep's
// check of the code as it is, passes at once), and the sweep runs inside a bound: its first mutant's run is killed at
// that bound, and its second mutant's run, planted, finds the bound past and exits 124.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "../group-run.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const KIT = ["packages/kit/src", "packages/kit/test", "packages/kit/package.json", "packages/kit/tsconfig.json"];
// a run needs its test file to reach the preload: each package's tests are copied too
const WALLET = ["packages/wallet/src", "packages/wallet/scripts", "packages/wallet/test"];
const SIGN = ["packages/signpage/src", "packages/signpage/scripts", "packages/signpage/test"];
// [sweep, the folders and files it reads and plants in]
const SWEEPS = [
  ["packages/signpage/scripts/rent-back-mutants.mjs", [...SIGN, "packages/kit/src"]],
  ["packages/signpage/scripts/held-mutants.mjs", SIGN],
  ["packages/kit/test/pool-deposit-mutants.mjs", KIT],
  ["packages/kit/test/vault-settle-mutants.mjs", KIT],
  ["packages/kit/test/near-swap-mutants.mjs", KIT],
  ["packages/kit/test/near-rhea-mutants.mjs", KIT],
  ["packages/wallet/scripts/pool-evm-sell-bans-mutants.mjs", WALLET],
  ["packages/wallet/scripts/exit-scan-mutants.mjs", [...WALLET, "packages/exit/src", "packages/exit/test"]],
  ["packages/wallet/scripts/near-prepay-taken-mutants.mjs", WALLET],
  ["packages/wallet/scripts/held-moveout-mutants.mjs", WALLET],
  ["packages/wallet/scripts/note-restore-refund-mutants.mjs", WALLET],
  ["packages/wallet/scripts/refund-move-mutants.mjs", [...WALLET, ...SIGN]],
  ["packages/wallet/scripts/pool-evm-restore-mutants.mjs", WALLET],
  ["packages/wallet/scripts/restore-wallets-mutants.mjs", [...WALLET, ...SIGN]],
];
const BOUND_MS = 5_000;
// A test process (the runner under --test-isolation=none, a test file's own process otherwise) started while a plant is
// written in the tree (any src file unlike this checkout's; the kit's copy read as the kit) hangs, never yielding; one
// started on the code as it is (a sweep's own check of it) ends at once, passed.
const HANG = (dir) => `import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
const planted = () => readdirSync(${JSON.stringify(path.join(dir, "packages"))}).some((pkg) => {
  const src = path.join(${JSON.stringify(path.join(dir, "packages"))}, pkg, "src");
  const real = path.join(${JSON.stringify(path.join(ROOT, "packages"))}, pkg.startsWith(".kit-mutants-") ? "kit" : pkg, "src");
  let all = [];
  try { all = readdirSync(src, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()); } catch { return false; }
  return all.some((d) => { const f = path.join(d.parentPath, d.name); return !readFileSync(f).equals(readFileSync(path.join(real, path.relative(src, f)))); });
});
if (process.execArgv.some((a) => a.startsWith("--test"))) {
  if (planted()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  else process.exit(0);
}
`;

const files = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(d.parentPath, d.name));

/** A copy of `paths` (and every scripts/*.mjs the sweeps import) in a temp dir: its root. */
function tree(paths) {
  // its real path: a sweep run by name compares its argv[1] with its own module's path (/private/var, not /var, on macOS)
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mutant-run-")));
  writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n');
  mkdirSync(path.join(dir, "scripts"));
  for (const f of readdirSync(path.join(ROOT, "scripts")).filter((f) => f.endsWith(".mjs"))) cpSync(path.join(ROOT, "scripts", f), path.join(dir, "scripts", f));
  for (const p of paths) cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true });
  mkdirSync(path.join(dir, "packages"), { recursive: true });
  writeFileSync(path.join(dir, "hang.mjs"), HANG(dir));
  return dir;
}

/** The sweep `rel` run whole in `dir`, inside a run that ends in BOUND_MS. */
async function sweep(dir, rel) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT" && k !== "ONLY"));
  env.NODE_OPTIONS = `--import=${pathToFileURL(path.join(dir, "hang.mjs")).href}`;
  // the bound is set inside the sweep's own process, so the outer run's own kill (60 s) never races it; the sweep's path
  // is its argv[1], as when it is run by name
  const at = path.join(dir, rel);
  const code = `process.env.GROUP_RUN_UNTIL_MS = String(Date.now() + ${BOUND_MS}); await import(${JSON.stringify(pathToFileURL(at).href)});`;
  const r = await run(process.execPath, ["--input-type=module", "-e", code, at], { env, timeoutMs: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// the sweeps run at once: each spends its bound blocked
describe("every sweep reads its runs through scripts/mutant-run.mjs", { concurrency: true }, () => {
  for (const [rel, paths] of SWEEPS) {
    test(`${rel}: a run that hangs is refused with no verdict, and the plant written when its bound ends is put back`, { timeout: 90_000 }, async () => {
      const dir = tree(paths);
      try {
        const r = await sweep(dir, rel);
        assert.match(r.out, /^HUNG \[.+\] pass 0 fail 0 cancelled 0: no verdict, refused$/m, r.out);
        assert.doesNotMatch(r.out, /^(SURVIVED|KILLED)/m, r.out);
        // its second mutant's run, planted, found the bound past
        assert.equal(r.status, 124, r.out);
        const changed = paths.flatMap((p) => {
          const at = path.join(dir, p);
          return (p.includes(".") ? [at] : files(at)).filter((f) => !readFileSync(f).equals(readFileSync(path.join(ROOT, path.relative(dir, f)))));
        });
        assert.deepEqual(changed.map((f) => path.relative(dir, f)), [], "a plant is left in the source");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

// A process ended while a plant is written, by an exit from inside the run (group-run's bound) or by a SIGINT, puts the
// plant back on its way out.
const STUB = "export const x = 1;\n";
async function stopped(body, signal) {
  const dir = tree([]);
  try {
    const f = path.join(dir, "src.mjs");
    writeFileSync(f, STUB);
    const ready = path.join(dir, "ready");
    const code = `import { writeFileSync } from "node:fs";
import { withPlant } from ${JSON.stringify(pathToFileURL(path.join(dir, "scripts/group-run.mjs")).href)};
withPlant(${JSON.stringify(f)}, "export const x = 2;\\n", () => {
  writeFileSync(${JSON.stringify(ready)}, String(process.pid));
  ${body}
});`;
    const p = run(process.execPath, ["--input-type=module", "-e", code], { timeoutMs: 30_000 });
    if (signal !== undefined) {
      for (let i = 0; i < 200 && !files(dir).includes(ready); i++) await new Promise((ok) => setTimeout(ok, 25));
      assert.ok(files(dir).includes(ready), "the plant was never written");
      // the run leads its own group (scripts/group-run.mjs): the group is signalled, as a terminal's interrupt is
      process.kill(-Number(readFileSync(ready, "utf8")), signal);
    }
    const r = await p;
    return { status: r.status, signal: r.signal, out: `${r.stdout}${r.stderr}`, back: readFileSync(f, "utf8") === STUB };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a plant is put back when the process exits inside its run (group-run's exit 124 at a bound)", { timeout: 30_000 }, async () => {
  const r = await stopped("process.exit(124);");
  assert.equal(r.status, 124, r.out);
  assert.ok(r.back, "the plant is left in the source");
});

test("a SIGINT that lands while a plant is written never ends the process with the plant in the source", { timeout: 30_000 }, async () => {
  // the run blocks 2 s with the plant written: the signal waits for the run (a handler is set before the write), never
  // ends the process with the plant in the source
  const r = await stopped("Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);", "SIGINT");
  assert.equal(r.signal, null, r.out);
  assert.ok(r.back, "the plant is left in the source");
});
