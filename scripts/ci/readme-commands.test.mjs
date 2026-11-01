// readme-commands.mjs: every command and path README.md names runs or exists. The repo's own README passes; each
// planted command or path that names nothing fails, and its runnable twin passes.
//   node --test scripts/ci/readme-commands.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { problems } from "./readme-commands.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("every command and path this repo's README.md names runs or exists", () => {
  assert.deepEqual(problems(readFileSync(path.join(ROOT, "README.md"), "utf8"), ROOT), []);
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
  put("docs/security.md", "# Security\n");
  put("scripts/ci/gate.mjs", "");
  put("scripts/live-checks/one.test.mjs", "");
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
