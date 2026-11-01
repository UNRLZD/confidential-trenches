// node --test scripts/live-checks/helper-host-health.test.mjs: the live check replays recorded answers
// (helper-host-health.answers.json). good: apps/helper at 6aa24c5 in its image behind deploy/Caddyfile, run by
// deploy/compose.yaml on a Mac (HELPER_HOST has no server yet, so no served answer exists): PASS. bad_commit: a real
// answer from the same image built with another commit (854f02d): FAIL. bad_star: the good answer with
// Access-Control-Allow-Origin: * on every read: FAIL.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, read } from "./helper-host-health.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-host-health.answers.json"), "utf8"));
const COMMIT = A.good.commit;

// a fetch that answers each read with the recorded answer for the request's Origin
const replay = (a) => async (_url, init) => {
  const r = a.reads.find((x) => x.origin === init.headers.origin);
  return new Response(r.body, { status: r.status, headers: r.headers });
};

test("recorded good answer: 200, the six parts, the commit, the two origins echoed, example.com none: PASS", async () => {
  const r = judge(await read("https://api.confidential.unrealized.trade", replay(A.good)), COMMIT);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes('ok  [https://confidential.unrealized.trade] Access-Control-Allow-Origin: "https://confidential.unrealized.trade"'));
  assert.ok(r.lines.includes("ok  [https://example.com] Access-Control-Allow-Origin: none"));
});

test("recorded bad answer: X-Helper-Commit is not main's: FAIL", async () => {
  const r = judge(await read(undefined, replay(A.bad_commit)), COMMIT);
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes(`BAD [https://sign.confidential.unrealized.trade] X-Helper-Commit: "${A.bad_commit.reads[0].headers["x-helper-commit"]}", want "${COMMIT}"`), r.lines.join("\n"));
  assert.ok(r.lines.includes("BAD [https://confidential.unrealized.trade] body commit equals it"));
});

test("recorded bad answer: Access-Control-Allow-Origin: *: FAIL", async () => {
  const r = judge(await read(undefined, replay(A.bad_star)), COMMIT);
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes('BAD [https://example.com] Access-Control-Allow-Origin: "*", want none'), r.lines.join("\n"));
  assert.ok(r.lines.includes("BAD [https://confidential.unrealized.trade] no * in Access-Control-Allow-Origin"));
});

test("bad answers made from the good one: a part missing, a part added, no Vary, credentials allowed, a 503: FAIL", () => {
  const edit = (fn) => ({ reads: A.good.reads.map((r) => fn(structuredClone(r))) });
  const body = (f) => (r) => ((r.body = JSON.stringify(f(JSON.parse(r.body)))), r);
  const cases = {
    "parts are exactly": edit(body((b) => (delete b.parts.log, b))),
    "parts are exactly ": edit(body((b) => ((b.parts.extra = "down"), b))),
    "each part is": edit(body((b) => ((b.parts.proxy = "maybe"), b))),
    "Vary: none": edit((r) => (delete r.headers.vary, r)),
    "no Access-Control-Allow-Credentials": edit((r) => ((r.headers["access-control-allow-credentials"] = "true"), r)),
    "answers 503": edit((r) => ((r.status = 503), r)),
  };
  for (const [want, answer] of Object.entries(cases)) {
    const r = judge(answer, COMMIT);
    assert.equal(r.ok, false, want);
    assert.ok(r.lines.some((l) => l.startsWith("BAD") && l.includes(want.trim())), `${want}\n${r.lines.join("\n")}`);
  }
  assert.equal(judge(A.good, "main").ok, false, "an expected commit that is not a full sha fails");
});

test("the CLI on a host that does not answer is an error, exit 2", () => {
  const r = spawnSync(process.execPath, [path.join(HERE, "helper-host-health.mjs"), "--base", "http://127.0.0.1:9", "--commit", COMMIT], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /live-check helper-host-health: ERROR: /);
});

// The expected commit follows every input of the helper image, not apps/helper alone: in a repo of its own, a commit
// on main that touches only packages/kit (or only the lockfile) is the commit the live check expects next.
test("the expected commit is main's newest first-parent commit that touched an image input: a kit-only or lockfile-only commit moves it", () => {
  const ROOT = path.resolve(HERE, "../..");
  const repo = mkdtempSync(path.join(tmpdir(), "hhh-commit-"));
  try {
    for (const f of ["scripts/live-checks/helper-host-health.mjs", "scripts/net-window.mjs", "apps/helper/deploy/image-inputs.mjs"]) {
      if (!existsSync(path.join(ROOT, f))) continue;
      mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
      cpSync(path.join(ROOT, f), path.join(repo, f));
    }
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", env }).trim();
    const commit = (file, msg) => {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), `${msg}\n`);
      git("add", "--", file);
      git("commit", "-q", "--no-gpg-sign", "-m", msg, "--", file);
      return git("rev-parse", "HEAD");
    };
    git("init", "-q", "-b", "main");
    git("add", "--", "scripts", ...(existsSync(path.join(repo, "apps")) ? ["apps"] : []));
    git("commit", "-q", "--no-gpg-sign", "-m", "the check");
    // the repo's own copy of the check, in a process of its own, so its root is this repo
    const mainCommit = () =>
      execFileSync(process.execPath, ["--input-type=module", "-e", 'import { mainCommit } from "./scripts/live-checks/helper-host-health.mjs"; console.log(mainCommit());'], { cwd: repo, encoding: "utf8" }).trim();
    const helper = commit("apps/helper/src/server.ts", "helper");
    assert.equal(mainCommit(), helper);
    const kit = commit("packages/kit/src/index.ts", "kit only");
    assert.equal(mainCommit(), kit, "a kit-only commit must move the expected commit");
    const lock = commit("pnpm-lock.yaml", "lockfile only");
    assert.equal(mainCommit(), lock, "a lockfile-only commit must move the expected commit");
    commit("apps/terminal/src/x.ts", "terminal only");
    assert.equal(mainCommit(), lock, "a commit outside the image's inputs leaves it");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
