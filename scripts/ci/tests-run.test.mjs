// Every tracked test file runs in CI: each *.test.mjs and *.test.ts that git tracks is named, by path or by glob, by a
// `node --test` command in a ci.yml run: line, in a root script such a line runs (`pnpm run <name>`), or in a workspace
// package's script (resolved from the package's folder) while a ci.yml line runs `pnpm ... run <that script>` for that
// package (`-r`, or a --filter that selects it): `test`, or `test:mutants`, the sweeps CI runs after the tests and the
// README's fresh run leaves out (card fresh-run-margin). A ci.yml line that runs `node scripts/ci/test-shards.mjs
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
import { mutantCommands } from "./test-shards.mjs";

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
    // the matrix split (card ci-mutants-sharded): its line runs every package's sweeps but the wallet's, each from its
    // package's folder; the wallet's own line still runs its, and a split line inside an echo runs nothing
    put("packages/w/package.json", JSON.stringify({ name: "@blindfill/wallet", scripts: { test: 'node --test "test/*.test.ts"', "test:mutants": "FULL_RUNS=1 node --test test/a.test.ts test/mutants/wm.test.mjs" } }));
    put("packages/w/test/mutants/wm.test.mjs", "");
    execFileSync("git", ["add", "--", "packages/w/test/mutants/wm.test.mjs"], { cwd: dir });
    const tests = "pnpm -r --if-present --no-bail run test";
    const shard = 'node scripts/ci/test-shards.mjs mutants "$INDEX" "$TOTAL"';
    assert.deepEqual(unrunWith(ci(tests, shard, "pnpm --filter @blindfill/wallet run test:mutants")), []);
    assert.deepEqual(unrunWith(ci(tests, shard)), ["packages/w/test/mutants/wm.test.mjs"]);
    assert.deepEqual(unrunWith(ci(tests, "pnpm --filter @blindfill/wallet run test:mutants")), ["packages/k/test/mutants/m.test.mjs"]);
    assert.deepEqual(unrunWith(ci(tests, `echo ${shard}`, "pnpm --filter @blindfill/wallet run test:mutants")), ["packages/k/test/mutants/m.test.mjs"]);
    assert.deepEqual(unrunWith(ci(tests, "node scripts/ci/test-shards.mjs e2e \"$INDEX\" \"$TOTAL\"", "pnpm --filter @blindfill/wallet run test:mutants")), ["packages/k/test/mutants/m.test.mjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
