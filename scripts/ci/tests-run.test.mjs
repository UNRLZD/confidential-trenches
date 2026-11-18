// Every tracked test file runs in CI: each *.test.mjs and *.test.ts that git tracks is named, by path or by glob, by a
// `node --test` command in a ci.yml run: line, in a root script such a line runs (`pnpm run <name>`), or in a workspace
// package's script (resolved from the package's folder) while a ci.yml line runs `pnpm ... run <that script>` for that
// package (`-r`, or a --filter that selects it): `test`, or `test:mutants`, the sweeps CI runs nightly on main (card
// ci-fast-checks-on-the-pr; a nightly line counts as a run) and the README's fresh run leaves out (card
// fresh-run-margin). A ci.yml line that runs `node scripts/ci/test-shards.mjs
// mutants` runs every command that script's split shares out, each in its package's folder (card ci-mutants-sharded;
// scripts/ci/test-shards.test.mjs holds that the parts together run each one). Each tracked Foundry test (*.t.sol) is
// under the test/ folder of a `forge test` that names no filter, at its --root or else its folder. A test file that nothing runs passes review as
// coverage it does not give (net-window.test.mjs on main bb4eafd, 1 Nov 06:30Z).
//   node --test scripts/ci/tests-run.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { TEST_MS } from "../test-bound.mjs";
import { mutantCommands, packageItems, packagesPart } from "./test-shards.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// the text of every `run:` line and `run: |` block of a workflow, comments and step names left out
export function runLines(yml) {
  const out = [];
  let block = null; // the run key's indent while inside its block
  for (const line of yml.split(/\r?\n/)) {
    const indent = line.match(/^ */)[0].length;
    if (block !== null) {
      if (!line.trim() || indent > block) {
        out.push(line);
        continue;
      }
      block = null;
    }
    const m = /^( *)(?:- )?run:\s*(.*)$/.exec(line);
    if (!m) continue;
    if (/^[|>][-+]?\s*$/.test(m[2])) block = m[1].length;
    else out.push(m[2].replace(/^(['"])(.*)\1$/, "$2"));
  }
  return out;
}

// the paths and globs each `node --test` in a command names, with the folder they resolve from; `pnpm run <name>`
// adds the root script's own
function testArgs(command, cwd, rootScripts) {
  const out = [];
  for (const seg of command.split(/&&|\|\||[;|\n]/)) {
    const words = seg.trim().split(/\s+/).map((w) => w.replace(/^(['"])(.*)\1$/, "$2"));
    const at = words.findIndex((w, i) => /(^|\/)node$/.test(w) && words[i + 1] === "--test");
    if (at >= 0) for (const w of words.slice(at + 2)) if (w && !w.startsWith("-")) out.push({ cwd, pattern: w });
    const forge = words.findIndex((w, i) => /(^|\/)forge$/.test(w) && words[i + 1] === "test");
    // a filter (--match-path, --mc, --no-match-test, ...) runs part of the folder, so it vouches for no file
    if (forge >= 0 && !words.slice(forge + 2).some((w) => /^--(no-)?match-|^--n?m[cpt]$/.test(w))) {
      const at = words.indexOf("--root", forge);
      const eq = words.find((w) => w.startsWith("--root="));
      const root = at >= 0 ? words[at + 1] : eq ? eq.slice(7) : ".";
      out.push({ cwd, pattern: `${root}/test/**/*.t.sol` });
    }
    const run = /\bpnpm\s+run\s+(\S+)/.exec(seg);
    if (run && rootScripts[run[1]]) out.push(...testArgs(rootScripts[run[1]], cwd, {}));
  }
  return out;
}

// the workspace packages one `pnpm ... run <script>` command runs that script of, as a test of the package's name:
// with no --filter, every package under -r and none without it; --filter <name> (or -F, or --filter=) that package;
// --filter '!<name>' every package but that one (the shards of ci.yml's test job split the packages so). A selector
// of any other form (a glob, a path, ...) selects nothing here, so its packages' test files read as unrun.
function selects(command) {
  const words = command.trim().split(/\s+/).map((w) => w.replace(/^(['"])(.*)\1$/, "$2"));
  const filters = words.flatMap((w, i) => (w === "--filter" || w === "-F" ? [words[i + 1]] : w.startsWith("--filter=") ? [w.slice(9)] : []));
  if (!filters.length) return () => words.includes("-r") || words.includes("--recursive");
  const only = filters.filter((f) => !f.startsWith("!"));
  const not = filters.filter((f) => f.startsWith("!")).map((f) => f.slice(1));
  return (name) => (only.length ? only.includes(name) : true) && !not.includes(name);
}

// the tracked test files at root that no CI command runs
export function unrun(root) {
  const read = (f) => readFileSync(path.join(root, f), "utf8");
  const rootScripts = JSON.parse(read("package.json")).scripts ?? {};
  const lines = runLines(read(".github/workflows/ci.yml"));
  const args = lines.flatMap((l) => testArgs(l, root, rootScripts));
  const split = (seg) => /^\s*(\w+=\S*\s+)*node\s+scripts\/ci\/test-shards\.mjs\s+mutants(\s|$)/.test(seg);
  if (lines.flatMap((l) => l.split(/&&|\|\||[;|\n]/)).some(split)) {
    for (const c of mutantCommands(root)) args.push(...testArgs(c.command, path.join(root, c.dir), {}));
  }
  // each `pnpm ... run <script>`: the script it names and the packages it selects
  const selections = lines.flatMap((l) => l.split(/&&|\|\||[;\n]/)).flatMap((seg) => {
    const m = /\bpnpm\b.*\brun\s+([^\s'"]+)/.exec(seg);
    return m ? [{ script: m[1], pick: selects(seg) }] : [];
  });
  // a ci.yml line that runs `node scripts/ci/test-shards.mjs packages tests` runs every package's test script but the
  // wallet's, in the part its matrix lists (card ci-mutant-shards-true-times; scripts/ci/test-shards.test.mjs holds that the
  // parts together hold each package once, for every count of parts)
  const packagesSplit = (seg) => /^\s*(\w+=\S*\s+)*node\s+scripts\/ci\/test-shards\.mjs\s+packages\s+tests(\s|$)/.test(seg);
  if (lines.flatMap((l) => l.split(/&&|\|\||[;|\n]/)).some(packagesSplit)) {
    const ci = read(".github/workflows/ci.yml");
    const total = /\n {2}test-packages:\n(?:.*\n)*? {8}part:\s*\[([^\]]*)\]/.exec(ci)?.[1].split(",").length ?? 1;
    const items = packageItems(root);
    const names = new Set(Array.from({ length: total }, (_, i) => packagesPart(items, i, total)).flat().filter((i) => i.kind === "tests").map((i) => i.name));
    selections.push({ script: "test", pick: (n) => names.has(n) });
  }
  if (selections.length) {
    const globs = [...read("pnpm-workspace.yaml").matchAll(/^\s+-\s+["']?([^"'\s]+)["']?\s*$/gm)].map((m) => m[1]);
    for (const pkg of globs.flatMap((g) => globSync(`${g}/package.json`, { cwd: root }))) {
      const dir = path.join(root, path.dirname(pkg));
      const { name, scripts } = JSON.parse(read(pkg));
      for (const s of selections) if (scripts?.[s.script] && s.pick(name)) args.push(...testArgs(scripts[s.script], dir, {}));
    }
  }
  const ran = new Set(args.flatMap(({ cwd, pattern }) =>
    globSync(pattern, { cwd }).map((f) => path.relative(root, path.resolve(cwd, f)).split(path.sep).join("/"))));
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.test.mjs", "*.test.ts", "*.t.sol"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(Boolean);
  return tracked.filter((f) => !ran.has(f));
}

test("every tracked test file in this tree is run by CI", () => {
  assert.deepEqual(unrun(ROOT), [], "a test file no CI command runs: name it by a glob in ci.yml or in its package's test script");
});

// cards helper-sell-sweep-in-ci and helper-release-sweep-in-ci: the helper's EVM sell and release sweeps
// (apps/helper/test/pool-evm/sell-mutants.mjs, release-mutants.mjs) are no test files, so the check above cannot see
// them; each runs in CI only while a ci.yml line runs the mutant split and the helper's test:mutants gives the split
// every one of its parts (scripts/ci/test-shards.test.mjs holds that the split's parts together run each command)
for (const sweep of ["sell-mutants.mjs", "release-mutants.mjs"]) {
  test(`the helper's ${sweep} is a command of the mutant split that ci.yml's test-mutants runs, every part of it`, () => {
    const lines = runLines(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"));
    assert.ok(lines.some((l) => /^node scripts\/ci\/test-shards\.mjs mutants "\$INDEX" "\$TOTAL"$/.test(l.trim())), "no ci.yml line runs the mutant split");
    // its parts, one command each (node test/pool-evm/<sweep> <k>/<n>, or the sweep whole as 1/1): every k from 1 to n,
    // each once
    const cmd = `node test/pool-evm/${sweep}`;
    const parts = mutantCommands(ROOT).filter((c) => c.dir === "apps/helper" && (c.command === cmd || c.command.startsWith(`${cmd} `)))
      .map((c) => (c.command === cmd ? "1/1" : /^ ([1-9]\d*)\/([1-9]\d*)$/.exec(c.command.slice(cmd.length))?.slice(1).join("/") ?? c.command));
    assert.ok(parts.length > 0, `the mutant split has no apps/helper command running test/pool-evm/${sweep}`);
    const n = Number(parts[0].split("/")[1]);
    assert.deepEqual(parts.toSorted(), Array.from({ length: n }, (_, k) => `${k + 1}/${n}`).toSorted(), `the sweep's parts: ${parts.join(", ")}`);
  });
}

// a small tree: ci.yml runs a root script, a live-check glob and every package's test script; one package names its
// test files one by one, as packages/wallet did on main bb4eafd
test("a planted test file that no command names fails; the same tree without it passes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tests-run-"));
  try {
    const put = (f, text) => {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), text);
    };
    put(".github/workflows/ci.yml", [
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: pnpm install --frozen-lockfile",
      "      # node --test scripts/planted-in-a-comment.test.mjs",
      "      - name: node --test scripts/planted-in-a-name.test.mjs",
      "        run: GITLEAKS=x pnpm run test:gates",
      "      - run: pnpm -r --if-present --no-bail run test",
      "      - name: live checks",
      "        run: |",
      "          echo start",
      "          node --test scripts/live-checks/*.test.mjs",
      "          forge test --root contracts/x",
      "          forge test --root contracts/z --mt test_one",
      "  b:",
      "    steps:",
      "      - run: echo scripts/planted-in-an-echo.test.mjs",
      "",
    ].join("\n"));
    put("package.json", JSON.stringify({ scripts: { "test:gates": "node --test scripts/ci/*.test.mjs" } }));
    put("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\nminimumReleaseAge: 10080\n');
    put("packages/w/package.json", JSON.stringify({ scripts: { test: "node --test test/a.test.ts ../../scripts/live-checks/l.test.mjs" } }));
    for (const f of ["scripts/ci/g.test.mjs", "scripts/live-checks/l.test.mjs", "packages/w/test/a.test.ts", "contracts/x/test/A.t.sol", "contracts/x/test/deep/B.t.sol"]) put(f, "");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    assert.deepEqual(unrun(dir), []);

    const planted = [
      "contracts/y/test/C.t.sol",
      "contracts/z/test/D.t.sol",
      "packages/w/test/b.test.ts",
      "scripts/planted-in-a-comment.test.mjs",
      "scripts/planted-in-a-name.test.mjs",
      "scripts/planted-in-an-echo.test.mjs",
    ];
    for (const f of planted) put(f, "");
    execFileSync("git", ["add", "--", ...planted], { cwd: dir });
    assert.deepEqual(unrun(dir), planted);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ci.yml's test job splits the packages over shards with pnpm --filter (card ci-test-shards): a shard list that drops a
// package leaves its test files unrun, and must fail here, as a shard that runs no tests would pass on its own
test("planted: a package no pnpm --filter shard selects fails; the full split passes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tests-run-shards-"));
  try {
    const put = (f, text) => {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), text);
    };
    const ci = (...runs) => ["jobs:", ...runs.flatMap((r, i) => [`  s${i}:`, "    steps:", `      - run: ${r}`]), ""].join("\n");
    put("package.json", JSON.stringify({ scripts: {} }));
    put("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    put("packages/w/package.json", JSON.stringify({ name: "@x/w", scripts: { test: 'node --test "test/*.test.ts"' } }));
    put("packages/v/package.json", JSON.stringify({ name: "@x/v", scripts: { test: 'node --test "test/*.test.ts"' } }));
    for (const f of ["packages/w/test/a.test.ts", "packages/v/test/b.test.ts"]) put(f, "");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    const unrunWith = (yml) => {
      put(".github/workflows/ci.yml", yml);
      return unrun(dir);
    };

    assert.deepEqual(unrunWith(ci("pnpm --filter @x/w run test", "pnpm -r --filter '!@x/w' --if-present --no-bail run test")), []);
    assert.deepEqual(unrunWith(ci("pnpm -r --if-present --no-bail run test")), []);
    assert.deepEqual(unrunWith(ci("pnpm --filter=@x/w run test", "pnpm -F @x/v run test")), []);
    // the wallet-style shard dropped: the rest-of shard excludes it, so its files run nowhere
    assert.deepEqual(unrunWith(ci("pnpm -r --filter '!@x/w' --if-present --no-bail run test")), ["packages/w/test/a.test.ts"]);
    // a shard for a name no package has, a selector this does not read, and a run of another script vouch for nothing
    assert.deepEqual(unrunWith(ci("pnpm --filter @x/nope run test", "pnpm -r --filter '!@x/w' run test")), ["packages/w/test/a.test.ts"]);
    assert.deepEqual(unrunWith(ci("pnpm -r --filter './packages/*' run test")), ["packages/v/test/b.test.ts", "packages/w/test/a.test.ts"]);
    assert.deepEqual(unrunWith(ci("pnpm --filter @x/w run test:e2e", "pnpm --filter @x/v run test")), ["packages/w/test/a.test.ts"]);
    // with no filter and no -r, pnpm runs the root's own script, no package's
    assert.deepEqual(unrunWith(ci("pnpm run test")), ["packages/v/test/b.test.ts", "packages/w/test/a.test.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// card fresh-run-margin: the mutant sweeps leave each package's test script for its test:mutants script, which ci.yml
// runs after the tests, so a sweep is run only while a ci.yml line runs test:mutants for its package
test("planted: a sweep in test:mutants that no ci.yml line runs fails; run by -r or by the shard split, it passes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tests-run-mutants-"));
  try {
    const put = (f, text) => {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), text);
    };
    const ci = (...runs) => ["jobs:", ...runs.flatMap((r, i) => [`  s${i}:`, "    steps:", `      - run: ${r}`]), ""].join("\n");
    put("package.json", JSON.stringify({ scripts: {} }));
    put("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    put("packages/w/package.json", JSON.stringify({ name: "@x/w", scripts: { test: 'node --test "test/*.test.ts"', "test:mutants": "FULL_RUNS=1 node --test test/a.test.ts" } }));
    put("packages/k/package.json", JSON.stringify({ name: "@x/k", scripts: { test: 'node --test "test/*.test.mjs"', "test:mutants": 'node --test "test/mutants/*.test.mjs" && node test/q-mutants.mjs' } }));
    for (const f of ["packages/w/test/a.test.ts", "packages/k/test/b.test.mjs", "packages/k/test/mutants/m.test.mjs"]) put(f, "");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    const unrunWith = (yml) => {
      put(".github/workflows/ci.yml", yml);
      return unrun(dir);
    };

    // the tests alone leave the sweep unrun: test/*.test.mjs does not reach test/mutants/
    assert.deepEqual(unrunWith(ci("pnpm -r --if-present --no-bail run test")), ["packages/k/test/mutants/m.test.mjs"]);
    assert.deepEqual(unrunWith(ci("pnpm -r --if-present --no-bail run test && pnpm -r --if-present run test:mutants")), []);
    // the shard split, as ci.yml's test-wallet and test-packages run it
    const split = ["pnpm --filter @x/w run test", "pnpm --filter @x/w run test:mutants", "pnpm -r --filter '!@x/w' --if-present --no-bail run test", "pnpm -r --filter '!@x/w' --if-present run test:mutants"];
    assert.deepEqual(unrunWith(ci(...split)), []);
    // the rest-of shard's test:mutants dropped: the sweep runs nowhere
    assert.deepEqual(unrunWith(ci(...split.slice(0, 3))), ["packages/k/test/mutants/m.test.mjs"]);
    // test:mutants alone vouches only for its own files, never for the test script's
    assert.deepEqual(unrunWith(ci("pnpm -r --if-present run test:mutants")), ["packages/k/test/b.test.mjs"]);
    // a test:mutants line for a package whose script is test:mutant (a typo) vouches for nothing
    assert.deepEqual(unrunWith(ci("pnpm -r --if-present --no-bail run test", "pnpm -r --if-present run test:mutant")), ["packages/k/test/mutants/m.test.mjs"]);
    // the matrix split (card ci-mutants-sharded): its line runs every package's sweeps, the wallet's included (card
    // held-move-forgotten-tx), each from its package's folder, and a split line inside an echo runs nothing
    put("packages/w/package.json", JSON.stringify({ name: "@blindfill/wallet", scripts: { test: 'node --test "test/*.test.ts"', "test:mutants": "FULL_RUNS=1 node --test test/a.test.ts test/mutants/wm.test.mjs" } }));
    put("packages/w/test/mutants/wm.test.mjs", "");
    execFileSync("git", ["add", "--", "packages/w/test/mutants/wm.test.mjs"], { cwd: dir });
    const tests = "pnpm -r --if-present --no-bail run test";
    const shard = 'node scripts/ci/test-shards.mjs mutants "$INDEX" "$TOTAL"';
    assert.deepEqual(unrunWith(ci(tests, shard)), []);
    // card ci-fast-checks-on-the-pr: the split in a job that runs only nightly and by hand still runs every sweep
    const nightly = ["jobs:", "  t:", "    steps:", `      - run: ${tests}`, "  test-mutants:", "    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'", "    steps:", "      - name: the sweeps", `        run: ${shard}`, ""].join("\n");
    assert.deepEqual(unrunWith(nightly), []);
    assert.deepEqual(unrunWith(nightly.replace(`        run: ${shard}`, `        run: echo ${shard}`)), ["packages/k/test/mutants/m.test.mjs", "packages/w/test/mutants/wm.test.mjs"]);
    assert.deepEqual(unrunWith(ci(tests, "pnpm --filter @blindfill/wallet run test:mutants")), ["packages/k/test/mutants/m.test.mjs"]);
    assert.deepEqual(unrunWith(ci(tests, `echo ${shard}`)), ["packages/k/test/mutants/m.test.mjs", "packages/w/test/mutants/wm.test.mjs"]);
    assert.deepEqual(unrunWith(ci(tests, "node scripts/ci/test-shards.mjs e2e \"$INDEX\" \"$TOTAL\"")), ["packages/k/test/mutants/m.test.mjs", "packages/w/test/mutants/wm.test.mjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// card ci-mutant-shards-true-times: test-packages runs each package's tests through `node scripts/ci/test-shards.mjs packages
// tests`, which this reads as every package but the wallet's; the line missing, inside an echo or for another step leaves them unrun
test("planted: the packages split runs every package's test script but the wallet's; without its line they are unrun", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tests-run-packages-"));
  try {
    const put = (f, text) => {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), text);
    };
    const ci = (matrix, ...runs) => ["jobs:", "  test-packages:", "    strategy:", "      matrix:", `        part: [${matrix}]`, ...runs.flatMap((r) => ["    steps:", `      - run: ${r}`]), ""].join("\n");
    put("package.json", JSON.stringify({ scripts: {} }));
    put("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    put("packages/w/package.json", JSON.stringify({ name: "@blindfill/wallet", scripts: { test: 'node --test "test/*.test.ts"' } }));
    put("packages/v/package.json", JSON.stringify({ name: "@x/v", scripts: { test: 'node --test "test/*.test.ts"' } }));
    put("packages/u/package.json", JSON.stringify({ name: "@x/u", scripts: { test: 'node --test "test/*.test.ts"' } }));
    for (const f of ["packages/w/test/a.test.ts", "packages/v/test/b.test.ts", "packages/u/test/c.test.ts"]) put(f, "");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    const unrunWith = (yml) => {
      put(".github/workflows/ci.yml", yml);
      return unrun(dir);
    };
    const split = 'node scripts/ci/test-shards.mjs packages tests "$INDEX" "$TOTAL"';
    // the split runs both packages in some part; the wallet's own job runs its tests
    assert.deepEqual(unrunWith(ci("1, 2, 3", split, "pnpm --filter @blindfill/wallet run test")), []);
    assert.deepEqual(unrunWith(ci("1", split, "pnpm --filter @blindfill/wallet run test")), []);
    // the wallet is the split's to leave out: its line dropped leaves its file unrun
    assert.deepEqual(unrunWith(ci("1, 2, 3", split)), ["packages/w/test/a.test.ts"]);
    // the split line missing, in an echo, or for the typecheck step alone: the packages' tests run nowhere
    const all = ["packages/u/test/c.test.ts", "packages/v/test/b.test.ts"];
    assert.deepEqual(unrunWith(ci("1, 2, 3", "pnpm --filter @blindfill/wallet run test")), all);
    assert.deepEqual(unrunWith(ci("1, 2, 3", `echo ${split}`, "pnpm --filter @blindfill/wallet run test")), all);
    assert.deepEqual(unrunWith(ci("1, 2, 3", 'node scripts/ci/test-shards.mjs packages typecheck "$INDEX" "$TOTAL"', "pnpm --filter @blindfill/wallet run test")), all);
    assert.deepEqual(unrunWith(ci("1, 2, 3", 'node scripts/ci/test-shards.mjs mutants "$INDEX" "$TOTAL"', "pnpm --filter @blindfill/wallet run test")), all);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// card test-runs-never-hold-a-slot: every workspace package's `test` script runs each `node --test` under the bound
// (scripts/test-bound.mjs: --test-timeout cancels a test and names it, the preload stops a file or the run that is still
// going at its bound), so no suite can hold a CI job or a heavy slot for ever (18 Nov: 49 min in one wallet file)
export function unbounded(root) {
  const want = ["--require=../../scripts/test-bound-watch.cjs", `--test-timeout=${TEST_MS}`, "--test-force-exit"];
  const out = [];
  const globs = [...readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8").matchAll(/^\s+-\s+["']?([^"'\s]+)["']?\s*$/gm)].map((m) => m[1]);
  for (const pkg of globs.flatMap((g) => globSync(`${g}/package.json`, { cwd: root })).sort()) {
    const test = JSON.parse(readFileSync(path.join(root, pkg), "utf8")).scripts?.test;
    if (typeof test !== "string") continue;
    const dir = path.dirname(pkg).split(path.sep).join("/");
    const runs = test.split(/&&|\|\||[;|\n]/).map((seg) => seg.trim().split(/\s+/)).filter((w) => /(^|\/)node$/.test(w[0]) && w.includes("--test"));
    if (runs.length === 0) out.push(`${dir}: its test script runs no node --test`);
    for (const w of runs) {
      const flags = w.slice(w.indexOf("--test") + 1).filter((x) => x.startsWith("-"));
      const lacks = want.filter((f) => !flags.includes(f));
      if (path.resolve(root, dir, "../../scripts/test-bound-watch.cjs") !== path.join(root, "scripts/test-bound-watch.cjs")) out.push(`${dir}: ../../scripts/test-bound-watch.cjs is not the root's from here`);
      if (lacks.length) out.push(`${dir}: node --test lacks ${lacks.join(" ")}`);
    }
  }
  return out;
}

test("every package's test script runs node --test under the bound", () => {
  assert.deepEqual(unbounded(ROOT), []);
});

test("planted: a test script with no bound, a looser one or no force exit is refused", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tests-run-bound-"));
  try {
    const put = (f, text) => {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), text);
    };
    put("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    const bound = `--require=../../scripts/test-bound-watch.cjs --test-timeout=${TEST_MS} --test-force-exit`;
    const pkg = (test) => put("packages/w/package.json", JSON.stringify({ scripts: { test } }));
    pkg(`tsc -p . && node --test ${bound} "test/*.test.ts"`);
    assert.deepEqual(unbounded(dir), []);
    pkg('node --test "test/*.test.ts"');
    assert.deepEqual(unbounded(dir), [`packages/w: node --test lacks ${bound}`]);
    pkg(`node --test --require=../../scripts/test-bound-watch.cjs --test-timeout=${TEST_MS * 10} --test-force-exit "test/*.test.ts"`);
    assert.deepEqual(unbounded(dir), [`packages/w: node --test lacks --test-timeout=${TEST_MS}`]);
    pkg(`node --test --require=../../scripts/test-bound-watch.cjs --test-timeout=${TEST_MS} "test/*.test.ts"`);
    assert.deepEqual(unbounded(dir), ["packages/w: node --test lacks --test-force-exit"]);
    pkg(`node --test ${bound} "test/a.test.ts" && node --test "test/b.test.ts"`);
    assert.deepEqual(unbounded(dir), [`packages/w: node --test lacks ${bound}`], "each node --test of a chain");
    pkg("tsc -p .");
    assert.deepEqual(unbounded(dir), ["packages/w: its test script runs no node --test"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --test-force-exit ends a test file once the tests registered so far have ended, so a test registered after a top-level
// await (scripts/test-bound.mjs) is cancelled with "Promise resolution is still pending but the event loop has already
// resolved" (signpage's words-final.test.ts: 3 of 6 cancelled in the merge queue). In each package whose node --test
// runs --test-force-exit, each test file it names keeps every top-level await above its first test( / it( / describe(
// / suite( call. Reads the file's syntax: an await inside a function, a test callback included, is no top-level await.
const REGISTERS = new Set(["test", "it", "describe", "suite"]);
function topLevel(node, hit) {
  if (hit(node)) return true;
  if (ts.isFunctionLike(node) || ts.isClassLike(node)) return false;
  return ts.forEachChild(node, (c) => topLevel(c, hit) || undefined) ?? false;
}
const isAwait = (n) => ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier !== undefined);
const isRegister = (n) => {
  if (!ts.isCallExpression(n)) return false;
  const e = ts.isPropertyAccessExpression(n.expression) ? n.expression.expression : n.expression;
  return ts.isIdentifier(e) && REGISTERS.has(e.text);
};
/** The lines of `text` (a test file at `file`) holding a top-level await below its first test registration. */
export function awaitsAfterFirstTest(file, text) {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.m?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const out = [];
  let registered = false;
  for (const s of src.statements) {
    if (registered && topLevel(s, isAwait)) out.push(src.getLineAndCharacterOfPosition(s.getStart(src)).line + 1);
    if (topLevel(s, isRegister)) registered = true;
  }
  return out;
}

export function lateAwaits(root) {
  const out = [];
  const globs = [...readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8").matchAll(/^\s+-\s+["']?([^"'\s]+)["']?\s*$/gm)].map((m) => m[1]);
  for (const pkg of globs.flatMap((g) => globSync(`${g}/package.json`, { cwd: root })).sort()) {
    const test = JSON.parse(readFileSync(path.join(root, pkg), "utf8")).scripts?.test;
    if (typeof test !== "string") continue;
    const dir = path.join(root, path.dirname(pkg));
    for (const seg of test.split(/&&|\|\||[;|\n]/)) {
      const w = seg.trim().split(/\s+/).map((x) => x.replace(/^(['"])(.*)\1$/, "$2"));
      if (!(/(^|\/)node$/.test(w[0]) && w.includes("--test") && w.includes("--test-force-exit"))) continue;
      for (const pattern of w.slice(w.indexOf("--test") + 1).filter((x) => !x.startsWith("-")))
        for (const f of globSync(pattern, { cwd: dir }).sort()) {
          const rel = path.relative(root, path.join(dir, f)).split(path.sep).join("/");
          for (const line of awaitsAfterFirstTest(f, readFileSync(path.join(dir, f), "utf8"))) out.push(`${rel}:${line}: a top-level await below the file's first test, which --test-force-exit cancels`);
        }
    }
  }
  return out;
}

test("no test file run under --test-force-exit awaits at its top level below its first test", () => {
  assert.deepEqual(lateAwaits(ROOT), []);
});

test("planted: a top-level await below a test is refused under --test-force-exit; above it, in a test or without the flag it passes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tests-run-late-await-"));
  try {
    const put = (f, text) => {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), text);
    };
    put("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    const pkg = (flags) => put("packages/w/package.json", JSON.stringify({ scripts: { test: `node --test ${flags} "test/*.test.ts" test/*.test.mjs` } }));
    const late = 'import { test } from "node:test";\ntest("a", () => {});\nconst m = await import("./m.ts");\ntest("b", () => {});\n';
    put("packages/w/test/late.test.ts", late);
    put("packages/w/test/loop.test.mjs", 'import { test } from "node:test";\ndescribe("d", () => {});\nfor await (const x of [1]) test(`${x}`, () => {});\n');
    put("packages/w/test/fine.test.ts", 'import { test } from "node:test";\nconst m = await import("./m.ts");\ntest("a", async () => {\n  await m.x();\n});\nconst f = async () => await m.y();\ntest.skip("b", () => {});\n');
    pkg("--test-force-exit");
    assert.deepEqual(lateAwaits(dir), [
      "packages/w/test/late.test.ts:3: a top-level await below the file's first test, which --test-force-exit cancels",
      "packages/w/test/loop.test.mjs:3: a top-level await below the file's first test, which --test-force-exit cancels",
    ]);
    pkg("--test-timeout=1000");
    assert.deepEqual(lateAwaits(dir), [], "no --test-force-exit: the runner waits for the late tests");
    put("packages/w/test/late.test.ts", 'import { test } from "node:test";\nconst m = await import("./m.ts");\ntest("a", () => {});\ntest("b", () => {});\n');
    put("packages/w/test/loop.test.mjs", 'import { test } from "node:test";\n');
    pkg("--test-force-exit");
    assert.deepEqual(lateAwaits(dir), [], "the await moved above the first test");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
