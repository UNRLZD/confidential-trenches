// Every tracked test file runs in CI: each *.test.mjs and *.test.ts that git tracks is named, by path or by glob, by a
// `node --test` command in a ci.yml run: line, in a root script such a line runs (`pnpm run <name>`), or in a workspace
// package's test script (resolved from the package's folder) while ci.yml runs `pnpm -r ... run test`. Each tracked
// Foundry test (*.t.sol) is under the test/ folder of a `forge test` that names no filter, at its --root or else its
// folder. A test file that nothing runs passes review as coverage it does not give (net-window.test.mjs on main
// bb4eafd, 1 Nov 06:30Z).
//   node --test scripts/ci/tests-run.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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

// the tracked test files at root that no CI command runs
export function unrun(root) {
  const read = (f) => readFileSync(path.join(root, f), "utf8");
  const rootScripts = JSON.parse(read("package.json")).scripts ?? {};
  const lines = runLines(read(".github/workflows/ci.yml"));
  const args = lines.flatMap((l) => testArgs(l, root, rootScripts));
  if (lines.some((l) => /\bpnpm\b.*\s-r\s.*\brun\s+test(\s|$)/.test(l))) {
    const globs = [...read("pnpm-workspace.yaml").matchAll(/^\s+-\s+["']?([^"'\s]+)["']?\s*$/gm)].map((m) => m[1]);
    for (const pkg of globs.flatMap((g) => globSync(`${g}/package.json`, { cwd: root }))) {
      const dir = path.join(root, path.dirname(pkg));
      const script = JSON.parse(read(pkg)).scripts?.test;
      if (script) args.push(...testArgs(script, dir, {}));
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
