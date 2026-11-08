// The recorded-answers path gate (answers-no-local-paths.mjs) on planted trees: every absolute local path in a key or a
// string of a scripts/live-checks/*.answers.json is refused by file and JSON path, its look-alikes pass, and the repo's
// own answers files pass.
//   node --test scripts/ci/answers-no-local-paths.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { answersNoLocalPaths, localPath } from "./answers-no-local-paths.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(ROOT, "scripts/ci/answers-no-local-paths.mjs");
const DIR = "scripts/live-checks";

// each planted path is refused wherever it sits in a string: alone, after a label, after a colon or an equals sign
const REFUSED = [
  "/Users/someone/shots/0-desktop.png",
  "harness: the build /private/tmp/claude-501/x/scratchpad/dist at APP_HOST's name",
  "harness, SIGN_HOST from /tmp/tmp.cI2pD1U4Ff",
  "/home/runner/work/repo/apps/terminal/dist",
  "/root/build/out",
  "/var/folders/xy/T/shots",
  "/var/tmp/ct-run",
  "/Volumes/disk/shots",
  "/mnt/c/Users/x",
  "/opt/build/site",
  "/run/user/1000/x",
  "~/Downloads/confidential-trenches/shots",
  "C:\\Users\\someone\\shots\\0.png",
  "out at d:/builds/site",
  "\\\\server\\share\\shots",
  "file:///etc/site/index.html",
  "dir=/tmp/x",
  "(from /tmp/x)",
];
// look-alikes that are not local paths: a URL's own path, a dash or dot name, a repo path, a file name, a regex in code
const ALLOWED = [
  "/tmp-x",
  "https://h.example/tmp/a",
  "https://h.example/Users/x",
  "/users/123",
  "/v1/candles?tf=15m",
  "tmp.cI2pD1U4Ff",
  "apps/terminal/dist",
  "packages/signpage's build (deploy.mjs build())",
  "0-desktop.png",
  "if (!/^https:\\/\\//.test(url)) return",
  "a/home/b",
  "/home",
  "ratio 1:2",
  "live",
];

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "answers-no-local-paths-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof body === "string" ? body : `${JSON.stringify(body, null, 1)}\n`);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}
function run(dir) {
  try {
    return { rc: 0, out: execFileSync(process.execPath, [GATE, dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { rc: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

test("the repo's own answers files pass", () => {
  const r = answersNoLocalPaths(ROOT);
  assert.deepEqual(r.refusals, []);
  assert.ok(r.read >= 100, `${r.read} files read`);
});

test("each planted local path is refused, each look-alike passes", () => {
  for (const s of REFUSED) assert.ok(localPath(s), `not refused: ${s}`);
  for (const s of ALLOWED) assert.equal(localPath(s), null, `refused: ${s}`);
  assert.equal(localPath("harness, SIGN_HOST from /tmp/tmp.cI2pD1U4Ff, Chrome 141"), "/tmp/tmp.cI2pD1U4Ff");
});

test("a tree whose answers hold only file names, repo paths and URLs passes", () => {
  const dir = tree({
    [`${DIR}/a.answers.json`]: { good: { source: "harness: the build apps/terminal/dist", loads: [{ shot: "0-desktop.png", url: "https://h.example/tmp/a" }] } },
    [`${DIR}/b.answers.json`]: { bad: { source: "live", seen: ALLOWED } },
    // a record that is not an answers file is not this gate's
    [`${DIR}/c.run.json`]: { shot: "/Users/x/y.png" },
  });
  try {
    const r = run(dir);
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /^answers-no-local-paths: OK \(2 answers file\(s\) read\)/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a local path in a nested value, an array item, a key or a source string is refused by file and JSON path", () => {
  const dir = tree({
    [`${DIR}/ok.answers.json`]: { good: { shot: "0-desktop.png" } },
    [`${DIR}/shot.answers.json`]: { good: { loads: [{ shot: "0.png" }, { shot: "/private/tmp/x/1-phone.png" }] }, shots: "/private/tmp/x" },
    [`${DIR}/source.answers.json`]: { bad: { source: "harness, SIGN_HOST from /tmp/tmp.abc" } },
    [`${DIR}/key.answers.json`]: { files: { "C:\\Users\\x\\app.js": 1 } },
    [`${DIR}/list.answers.json`]: { seen: ["fine", REFUSED] },
  });
  try {
    const r = run(dir);
    assert.equal(r.rc, 1, r.out);
    const lines = r.out.split("\n").filter((l) => l.includes("REFUSED"));
    assert.ok(lines.some((l) => l.includes("shot.answers.json: good.loads[1].shot holds a local path, /private/tmp/x/1-phone.png")), r.out);
    assert.ok(lines.some((l) => l.includes("shot.answers.json: shots holds a local path, /private/tmp/x")), r.out);
    assert.ok(lines.some((l) => l.includes("source.answers.json: bad.source holds a local path, /tmp/tmp.abc")), r.out);
    assert.ok(lines.some((l) => l.includes("key.answers.json: files (a key) holds a local path, C:\\Users\\x\\app.js")), r.out);
    for (let i = 0; i < REFUSED.length; i++) assert.ok(lines.some((l) => l.includes(`list.answers.json: seen[1][${i}] holds`)), `seen[1][${i}]: ${REFUSED[i]}\n${r.out}`);
    assert.equal(lines.filter((l) => l.includes("list.answers.json")).length, REFUSED.length, r.out);
    assert.ok(!lines.some((l) => l.includes("ok.answers.json")), r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an answers file that is not JSON is refused, and an untracked one is read", () => {
  const dir = tree({ [`${DIR}/broken.answers.json`]: '{ "good": ' });
  try {
    const r = run(dir);
    assert.equal(r.rc, 1, r.out);
    assert.match(r.out, /REFUSED: scripts\/live-checks\/broken\.answers\.json: could not be read as JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
