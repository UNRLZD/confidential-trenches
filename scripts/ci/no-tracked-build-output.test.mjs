// The build-output gate (no-tracked-build-output.mjs) on planted repositories: two signing page branches that each
// change one source line merge into main with no conflict and pass; a branch that commits a built bundle (one that is
// its source's build or one that is not) is refused, as is a tree whose .gitignore lets a build show as a new file; the
// repo's own tree passes.
//   node --test scripts/ci/no-tracked-build-output.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildOutputProblems } from "./no-tracked-build-output.mjs";
import { SIGN_BUILD_OUTPUTS } from "./sign-build-inputs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(ROOT, "scripts/ci/no-tracked-build-output.mjs");

/** A repository with this repo's .gitignore and a signing page source of two lines, committed on main. */
function plantedRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ct-build-output-"));
  const git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const write = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  git("init", "-q", "-b", "main");
  write(".gitignore", readFileSync(join(ROOT, ".gitignore"), "utf8"));
  write("packages/signpage/src/main.ts", 'export const a = "one";\n// between\nexport const b = "two";\n');
  write("packages/signpage/public/_headers", "/*\n  X-Frame-Options: DENY\n");
  git("add", "--", ".gitignore", "packages");
  git("commit", "-q", "-m", "base");
  return { dir, git, write };
}
/** A built bundle of the source as it is now, in the four places build-app.mjs writes (a stand-in for its build). */
const writeBuild = ({ dir, write }, junk = "") => {
  const js = readFileSync(join(dir, "packages/signpage/src/main.ts"), "utf8").replace(/export /g, "") + junk;
  for (const f of SIGN_BUILD_OUTPUTS) write(f, f.endsWith("index.html") ? `<script src="/app.js" integrity="x"></script>` : js);
};

test("the repo's own tree tracks no build output and ignores every one", () => {
  assert.deepEqual(buildOutputProblems(ROOT), []);
  const r = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("planted: two branches, each changing one source line and building locally, merge with no conflict and pass", () => {
  const r = plantedRepo();
  try {
    writeBuild(r); // a local build on main, ignored
    r.git("checkout", "-q", "-b", "card/one");
    r.write("packages/signpage/src/main.ts", 'export const a = "ONE";\n// between\nexport const b = "two";\n');
    writeBuild(r);
    r.git("commit", "-q", "-am", "Card one: line one");
    assert.deepEqual(buildOutputProblems(r.dir), []);
    r.git("checkout", "-q", "main");
    r.git("checkout", "-q", "-b", "card/two");
    r.write("packages/signpage/src/main.ts", 'export const a = "one";\n// between\nexport const b = "TWO";\n');
    writeBuild(r);
    r.git("commit", "-q", "-am", "Card two: line two");
    assert.deepEqual(buildOutputProblems(r.dir), []);
    r.git("checkout", "-q", "main");
    r.git("merge", "-q", "--no-edit", "card/one");
    r.git("merge", "-q", "--no-edit", "card/two"); // throws on a conflict
    assert.equal(readFileSync(join(r.dir, "packages/signpage/src/main.ts"), "utf8"), 'export const a = "ONE";\n// between\nexport const b = "TWO";\n');
    assert.equal(r.git("status", "--porcelain"), "", "the merge left nothing unmerged or untracked");
    assert.deepEqual(buildOutputProblems(r.dir), []);
    const g = spawnSync(process.execPath, [GATE, r.dir], { encoding: "utf8" });
    assert.equal(g.status, 0, g.stderr);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("planted: a branch that commits a built bundle is refused, whether or not it is its source's build", () => {
  for (const junk of ["", "\n/* not the source's build */"]) {
    const r = plantedRepo();
    try {
      writeBuild(r, junk);
      r.git("add", "-f", "--", ...SIGN_BUILD_OUTPUTS);
      r.git("commit", "-q", "-m", "Card bad: the bundle committed");
      const p = buildOutputProblems(r.dir);
      assert.deepEqual(p, SIGN_BUILD_OUTPUTS.map((f) => `${f} is tracked: it is build output (node packages/signpage/scripts/build-app.mjs writes it); git rm --cached -- ${f}`), junk);
      const g = spawnSync(process.execPath, [GATE, r.dir], { encoding: "utf8" });
      assert.equal(g.status, 1);
      assert.equal(g.stderr.trim().split("\n").length, SIGN_BUILD_OUTPUTS.length, g.stderr);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }
});

test("planted: a .gitignore that does not ignore a build output is refused, so a build never shows as a new file", () => {
  const r = plantedRepo();
  try {
    r.write(".gitignore", "node_modules/\n");
    assert.deepEqual(buildOutputProblems(r.dir), SIGN_BUILD_OUTPUTS.map((f) => `${f} is not ignored: add it to .gitignore`));
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

// review P3-2: another name for a build (public/app.min.js) or a dist/ folder is build output too
test("planted: a tracked file in packages/signpage/public/ that is not one of its sources, or any tracked dist/, is refused", () => {
  const r = plantedRepo();
  try {
    r.write("packages/signpage/public/app.min.js", "var a=1;\n");
    r.write("packages/signpage/dist/app.js", "var a=1;\n");
    r.write("apps/terminal/dist/index.html", "<!doctype html>\n");
    r.git("add", "-f", "--", "packages/signpage/public/app.min.js", "packages/signpage/dist/app.js", "apps/terminal/dist/index.html");
    r.git("commit", "-q", "-m", "Card bad: other build names committed");
    assert.deepEqual(buildOutputProblems(r.dir), [
      "packages/signpage/public/app.min.js is tracked in packages/signpage/public/, which holds only its sources (packages/signpage/public/_headers): build output is never committed; git rm --cached -- packages/signpage/public/app.min.js",
      "apps/terminal/dist/index.html is tracked in a dist/ folder: build output is never committed; git rm --cached -- apps/terminal/dist/index.html",
      "packages/signpage/dist/app.js is tracked in a dist/ folder: build output is never committed; git rm --cached -- packages/signpage/dist/app.js",
    ]);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});
