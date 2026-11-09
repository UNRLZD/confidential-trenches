// The build-output gate (no-tracked-build-output.mjs) on planted repositories: two signing page branches that each
// change one source line merge into main with no conflict and pass; a branch that commits a built bundle (one that is
// its source's build or one that is not) is refused, as is a tree whose .gitignore lets a build show as a new file, or a
// tracked script that reads a build output without signBuilt() (card helper-live-red); the repo's own tree passes.
//   node --test scripts/ci/no-tracked-build-output.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildOutputProblems, directReadProblems, NAMES_NOT_READS } from "./no-tracked-build-output.mjs";
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

// card helper-live-red: withdraw-fee-busy-waits.mjs read packages/signpage/index.html at load with no build first, so
// live run 42694130536 failed it with ENOENT on a fresh checkout. Each form a reader takes, planted.
const READS = {
  "scripts/live-checks/one-path.mjs": 'export const PIN = readFileSync(path.join(ROOT, "packages/signpage/index.html"), "utf8");\n',
  "scripts/live-checks/folder.mjs": 'const SIGNPAGE = path.resolve(HERE, "../../packages/signpage");\nexport const js = () => readFileSync(path.join(SIGNPAGE, "public/app.js"));\n',
  "scripts/live-checks/segments.test.mjs": 'const w = readFileSync(path.join(ROOT, "packages", "signpage", "public", "prover-worker.js"));\n',
  "apps/terminal/test/url.mjs": 'const t = readFileSync(new URL("../../../packages/signpage/public/prover-thread.js", import.meta.url));\n',
};
const refusal = (f) => `${f} reads the signing page's build output without signBuilt(): no checkout holds it until a build makes it; read it at path.join(signBuilt(), <file>) (scripts/signpage-built.mjs)`;

test("planted: a tracked script that reads a build output without signBuilt() is refused, in each form; through signBuilt() it passes", () => {
  const r = plantedRepo();
  try {
    for (const [f, text] of Object.entries(READS)) r.write(f, text);
    // not reads: a sentence naming the file, a comment, a URL path on a host, the build through signBuilt()
    r.write("scripts/live-checks/words.mjs", 'say("the pin is read from packages/signpage/index.html");\n// readFileSync("packages/signpage/index.html")\nconst u = new URL("/app.js", SIGN);\n');
    r.write("scripts/live-checks/built.mjs", 'import { signBuilt } from "../signpage-built.mjs";\nconst SIGNPAGE = path.resolve(HERE, "../../packages/signpage");\nexport const pin = () => readFileSync(path.join(signBuilt(), "index.html"), "utf8");\n');
    r.git("add", "--", "scripts", "apps");
    r.git("commit", "-q", "-m", "Card bad: readers of the build");
    const files = Object.keys(READS).sort();
    assert.deepEqual(directReadProblems(r.dir).sort(), files.map(refusal));
    assert.deepEqual(buildOutputProblems(r.dir).sort(), files.map(refusal));
    const g = spawnSync(process.execPath, [GATE, r.dir], { encoding: "utf8" });
    assert.equal(g.status, 1);
    assert.equal(g.stderr.trim().split("\n").length, files.length, g.stderr);
    // the fix: each reads through signBuilt()
    for (const [f, text] of Object.entries(READS)) r.write(f, `import { signBuilt } from "../signpage-built.mjs";\nsignBuilt();\n${text}`);
    assert.deepEqual(directReadProblems(r.dir), []);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("each file the gate lets name a build output without reading it exists and says why", () => {
  for (const [f, why] of Object.entries(NAMES_NOT_READS)) {
    assert.ok(readFileSync(join(ROOT, f), "utf8").length > 0, f);
    assert.ok(why.length > 10, f);
  }
});
