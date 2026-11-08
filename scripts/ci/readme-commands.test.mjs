// readme-commands.mjs: every command and path the docs name runs or exists. The repo's own docs pass (every tracked
// README.md and every tracked .md under docs/); each planted command or path that names nothing fails, and its runnable
// twin passes, in the README and in a doc under docs/ or a package, the generated docs/performance.md included.
//   node --test scripts/ci/readme-commands.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { docFiles, docProblems, problems } from "./readme-commands.mjs";
import { loadRuns, renderDoc } from "../perf-table.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("every command and path this repo's docs name runs or exists", () => {
  const docs = docFiles(ROOT);
  for (const d of ["README.md", "docs/architecture.md", "docs/performance.md", "docs/security.md", "scripts/live-checks/README.md"]) {
    assert.ok(docs.includes(d), `the gate reads ${d}`);
  }
  assert.deepEqual(docProblems(ROOT, docs), []);
});

// scripts/perf-table.mjs writes docs/performance.md: what it makes from this repo's run records names only what exists
test("every path the doc perf-table.mjs makes from perf/runs names exists", () => {
  assert.deepEqual(problems(renderDoc(loadRuns(path.join(ROOT, "perf/runs"))), ROOT, "docs/performance.md"), []);
});

// a small tree: a root script, one workspace package with a test script, a doc, a folder and two scripts
function tree() {
  const dir = mkdtempSync(path.join(tmpdir(), "readme-commands-"));
  const put = (f, s) => {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), s);
  };
  put("package.json", JSON.stringify({ scripts: { "check:imports": "true" } }));
  put("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  put("packages/a/package.json", JSON.stringify({ name: "@x/a", scripts: { test: "true" } }));
  put("README.md", "# Readme\n");
  put("docs/security.md", "# Security\n");
  put("scripts/ci/gate.mjs", "");
  put("scripts/live-checks/one.test.mjs", "");
  put("packages/a/src/index.ts", "");
  put("contracts/vault/src/withdraw.rs", "");
  put("perf/runs/solana-phone-2026-10-26.json", "{}");
  return dir;
}

// the tree as a git repository with every file tracked, then `docs` written and tracked too
function repo(docs) {
  const dir = tree();
  for (const [f, s] of Object.entries(docs)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), s);
  }
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "add", "--", "."]);
  return dir;
}

const GOOD = [
  "`pnpm run check:imports`",
  "`pnpm install --frozen-lockfile`",
  "`pnpm -r --if-present --no-bail run test`",
  "`pnpm --dir packages/a test`",
  "`pnpm --filter @x/a run test`",
  "`node scripts/ci/gate.mjs --all`",
  "`node --test scripts/live-checks/*.test.mjs`",
  "| `packages/a/` | a folder |",
  "Kept private in `UNRLZD/confidential-trenches-proofs`.",
  "Served at `sign.example.trade`, built with `@blindfill/kit`.",
  "[Security](docs/security.md#keys) | [App](https://example.trade) | [Video](<video link>)",
  '<img src="docs/security.md"> `pnpm --filter <package> test` `<n>` tests',
  "```sh\npnpm install --frozen-lockfile\ncurl -s \"$RPC\" -H 'content-type: application/json'\n```",
];

const BAD = [
  ["`pnpm test`", 'no script "test" in package.json'],
  ["`pnpm run build:vault`", 'no script "build:vault" in package.json'],
  ["`pnpm --dir examples/private-buy start`", "no package.json in examples/private-buy"],
  ["`pnpm --dir packages/a start`", 'no script "start" in packages/a/package.json'],
  ["`pnpm --filter @x/b test`", 'no workspace package "@x/b"'],
  ["`pnpm -r run lint`", 'no script "lint" in any workspace package'],
  ["`CI=1 pnpm run typecheck`", 'no script "typecheck" in package.json'],
  ["`node scripts/ci/missing.mjs --all`", "no such path scripts/ci/missing.mjs"],
  ["`node --test scripts/nothing/*.test.mjs`", "no file matches scripts/nothing/*.test.mjs"],
  ["| `examples/private-buy/` | A private buy |", "no such path examples/private-buy/"],
  ["[Architecture](docs/architecture.md)", "no such path docs/architecture.md"],
  ['<img src="assets/banner.png">', "no such path assets/banner.png"],
  ["```sh\ngit clone x && cd x\npnpm test\n```", 'no script "test" in package.json'],
];

test("each planted command or path that names nothing fails; each runnable one passes", () => {
  const dir = tree();
  try {
    for (const g of GOOD) assert.deepEqual(problems(g, dir), [], g);
    for (const [b, want] of BAD) {
      const got = problems(b, dir);
      assert.equal(got.length, 1, `${b}: ${JSON.stringify(got)}`);
      assert.ok(got[0].endsWith(want), `${b}: ${got[0]}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a problem names its README line", () => {
  const dir = tree();
  try {
    assert.deepEqual(problems("# Title\n\n```sh\npnpm install\npnpm test\n```\n", dir),
      ['README.md:5: pnpm test: no script "test" in package.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// card docs-commands-every-doc: docs/security.md:98 named `pnpm run build:vault`, which the root package.json does not
// have, and the gate read README.md alone, so it passed
const SECURITY_98 = "2. The published code is the running code. `view_code` returns the hash of the deployed code. It must " +
  "equal the hash of the vault you build yourself with `pnpm run build:vault`.";

test("the gate reads every tracked doc: security.md's build:vault line fails it", () => {
  const dir = repo({ "docs/security.md": `# Security\n\n${SECURITY_98}\n`, "README.md": "# R\n" });
  try {
    assert.deepEqual(docProblems(dir), ['docs/security.md:3: pnpm run build:vault: no script "build:vault" in package.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the gate's docs: every tracked README.md and .md under docs/, never an untracked file", () => {
  const dir = repo({ "README.md": "# R\n", "packages/a/README.md": "# A\n", "docs/notes/deep.md": "# D\n", "notes.md": "x\n" });
  try {
    writeFileSync(path.join(dir, "docs/untracked.md"), "`pnpm run nothing`\n");
    assert.deepEqual(docFiles(dir), ["README.md", "docs/notes/deep.md", "docs/security.md", "packages/a/README.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// the generated doc: a perf-table change that names the raw run's path in the private research repo again fails
test("docs/performance.md: a record path in this tree passes, a private research path fails", () => {
  const dir = tree();
  try {
    const at = "docs/performance.md";
    assert.deepEqual(problems("Record: `perf/runs/solana-phone-2026-10-26.json`.", dir, at), []);
    assert.deepEqual(problems("Record: `proofs/g1-phone-trade/results/live-2026-10-26T11-29-51-268Z.json`.", dir, at),
      [`${at}:1: proofs/g1-phone-trade/results/live-2026-10-26T11-29-51-268Z.json: no such path proofs/g1-phone-trade/results/live-2026-10-26T11-29-51-268Z.json`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a doc's links resolve from its own folder; its code paths from the root or its folder", () => {
  const dir = tree();
  try {
    const ok = [
      ["docs/architecture.md", "[Security](security.md#keys) [Home](../README.md) [Root](/docs/security.md)"],
      ["packages/a/README.md", "resolves to `src/index.ts`; see [security](../../docs/security.md#x)"],
      ["packages/a/README.md", "`pnpm test` and `pnpm run check:imports`"],
      ["docs/security.md", "at `contracts/vault/src/withdraw.rs:256` and `contracts/vault/src/withdraw.rs:1-9`"],
    ];
    for (const [doc, text] of ok) assert.deepEqual(problems(text, dir, doc), [], `${doc}: ${text}`);
    const bad = [
      ["docs/architecture.md", "[Security](docs/security.md)", "no such path docs/security.md"],
      ["docs/architecture.md", "`src/index.ts`", "no such path src/index.ts"],
      ["docs/architecture.md", "`pnpm test`", 'no script "test" in package.json'],
      ["packages/a/README.md", "`pnpm run lint`", 'no script "lint" in package.json or packages/a/package.json'],
      ["docs/security.md", "`contracts/vault/src/deposit.rs:144`", "no such path contracts/vault/src/deposit.rs"],
    ];
    for (const [doc, text, want] of bad) {
      const got = problems(text, dir, doc);
      assert.equal(got.length, 1, `${doc}: ${text}: ${JSON.stringify(got)}`);
      assert.ok(got[0].startsWith(`${doc}:1: `) && got[0].endsWith(want), got[0]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
