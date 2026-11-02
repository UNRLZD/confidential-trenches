// node --test scripts/live-checks/helper-host-health.test.mjs: the live check replays recorded answers
// (helper-host-health.answers.json). good: the helper of card helper-release-bump run locally at release 2 (its note
// says how): PASS, alone and against its --since record since_before (release 1 at the commit before) and against the
// deployed helper that reports no release. bad_release_stuck: a new commit at the record's release 1: FAIL.
// deployed_no_release: the live helper before this card, with no release: FAIL. bad_no_bind: apps/helper at 6aa24c5 in its image behind deploy/Caddyfile, before /v1/bind was mounted (delegate
// "down", POST /v1/bind 404): FAIL. bad_commit: a real answer from the same image built with another commit (854f02d):
// FAIL. bad_star: an answer with Access-Control-Allow-Origin: * on every read: FAIL.
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

// a fetch that answers each read with the recorded answer for the request's Origin, and POST /v1/bind with the recorded
// one (an answer recorded before the route was read: 404 not_found, as the helper answered an unmounted path)
const replay = (a) => async (url, init) => {
  if (init.method === "POST") {
    assert.equal(new URL(url).pathname, "/v1/bind");
    assert.equal(init.body, '{"signed_delegate":"AAAA"}');
    const b = a.bind ?? { status: 404, headers: a.reads[0].headers, body: '{"error":"not_found"}' };
    return new Response(b.body, { status: b.status, headers: b.headers });
  }
  const r = a.reads.find((x) => x.origin === init.headers.origin);
  return new Response(r.body, { status: r.status, headers: r.headers });
};

test("recorded good answer: 200, the six parts, delegate up and POST /v1/bind mounted, the commit, the two origins echoed, example.com none: PASS", async () => {
  const r = judge(await read("https://api.confidential.unrealized.trade", replay(A.good)), COMMIT);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes('ok  POST /v1/bind with no SignedDelegateAction answers 400 "bad_shape", want 400 "bad_shape"'), r.lines.join("\n"));
  assert.ok(r.lines.includes('ok  [https://confidential.unrealized.trade] Access-Control-Allow-Origin: "https://confidential.unrealized.trade"'));
  assert.ok(r.lines.includes("ok  [https://example.com] Access-Control-Allow-Origin: none"));
});

test("recorded bad answer: the helper before /v1/bind was mounted (delegate down, POST /v1/bind 404): FAIL", async () => {
  const r = judge(await read(undefined, replay(A.bad_no_bind)), A.bad_no_bind.commit);
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes('BAD [https://confidential.unrealized.trade] delegate (POST /v1/bind) is "down", want "up"'), r.lines.join("\n"));
  assert.ok(r.lines.includes('BAD POST /v1/bind with no SignedDelegateAction answers 404 none, want 400 "bad_shape"'), r.lines.join("\n"));
  // and nothing else in it fails: the bind reads are what this answer is refused on (and the release, which no helper
  // reported before card helper-release-bump)
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")).filter((l) => !l.includes("delegate") && !l.includes("/v1/bind") && !l.includes("release")), []);
});

test("recorded good answer against its --since record: another commit, release 2 up from 1: PASS; against the deployed helper's answer with no release: PASS", async () => {
  const r = judge(await read(undefined, replay(A.good)), COMMIT, A.since_before);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  [https://confidential.unrealized.trade] release 2 is a whole number, 1 or more"), r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  another commit than the record's (3e6cde60b504): release 2 went up from 1"), r.lines.join("\n"));
  const first = judge(A.good, COMMIT, A.deployed_no_release);
  assert.equal(first.ok, true, first.lines.join("\n"));
  assert.ok(first.lines.includes("ok  release 2 is up from the record's none (commit 3e6cde60b504, a helper before release reporting)"), first.lines.join("\n"));
  // without --since the comparison is not made, and the run says so; the rest still passes
  const alone = judge(A.good, COMMIT);
  assert.equal(alone.ok, true, alone.lines.join("\n"));
  assert.ok(alone.lines.includes("--  release not compared with an earlier run: no --since record"));
});

test("recorded bad answer: a new commit with the record's release (nothing raised it, as before this card): FAIL", async () => {
  const r = judge(await read(undefined, replay(A.bad_release_stuck)), A.bad_release_stuck.commit, A.since_before);
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("BAD another commit than the record's (3e6cde60b504): release 1, want above 1"), r.lines.join("\n"));
  // the release is what it is refused on
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")), ["BAD another commit than the record's (3e6cde60b504): release 1, want above 1"]);
});

test("recorded bad answer: the deployed helper before this card reports no release: FAIL", async () => {
  const r = judge(await read(undefined, replay(A.deployed_no_release)), A.deployed_no_release.commit);
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("BAD [https://confidential.unrealized.trade] release none is a whole number, 1 or more"), r.lines.join("\n"));
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")).filter((l) => !l.includes("release")), [], "only the release fails it");
});

test("the --since comparison: the same commit keeps the release, another raises it, never down; a bad record fails", () => {
  const withRelease = (a, release, commit = a.commit) => ({
    ...a,
    reads: a.reads.map((r) => ({ ...r, headers: { ...r.headers, "x-helper-commit": commit }, body: JSON.stringify({ ...JSON.parse(r.body), commit, release }) })),
    bind: { ...a.bind, headers: { ...a.bind.headers, "x-helper-commit": commit } },
  });
  // the same commit as the record: kept passes, raised or lowered fails
  assert.equal(judge(withRelease(A.good, 2), COMMIT, A.good).ok, true);
  const raised = judge(withRelease(A.good, 3), COMMIT, A.good);
  assert.equal(raised.ok, false);
  assert.ok(raised.lines.includes("BAD the same commit as the record: release 3, want kept at 2"), raised.lines.join("\n"));
  assert.equal(judge(withRelease(A.good, 1), COMMIT, A.good).ok, false);
  // another commit: up by more than one passes (deploys in between), lower fails
  assert.equal(judge(withRelease(A.good, 9), COMMIT, A.since_before).ok, true);
  assert.equal(judge(withRelease(A.good, 1), COMMIT, withRelease(A.since_before, 5)).ok, false);
  // a release that is no whole number, or differs between the reads, fails
  for (const bad of [0, -1, 1.5, "2", null]) assert.equal(judge(withRelease(A.good, bad), COMMIT).ok, false, JSON.stringify(bad));
  const mixed = structuredClone(A.good);
  mixed.reads[2].body = JSON.stringify({ ...JSON.parse(mixed.reads[2].body), release: 3 });
  assert.ok(judge(mixed, COMMIT).lines.includes("BAD every answer carries the same release: 2, 2, 3"));
  // a record that holds no health answer, or a release that is no whole number
  assert.equal(judge(A.good, COMMIT, { reads: [] }).ok, false);
  assert.equal(judge(A.good, COMMIT, withRelease(A.since_before, "1")).ok, false);
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
  const edit = (fn) => ({ reads: A.good.reads.map((r) => fn(structuredClone(r))), bind: A.good.bind });
  const body = (f) => (r) => ((r.body = JSON.stringify(f(JSON.parse(r.body)))), r);
  const cases = {
    "parts are exactly": edit(body((b) => (delete b.parts.log, b))),
    "parts are exactly ": edit(body((b) => ((b.parts.extra = "down"), b))),
    "each part is": edit(body((b) => ((b.parts.proxy = "maybe"), b))),
    "Vary: none": edit((r) => (delete r.headers.vary, r)),
    "no Access-Control-Allow-Credentials": edit((r) => ((r.headers["access-control-allow-credentials"] = "true"), r)),
    "answers 503": edit((r) => ((r.status = 503), r)),
    "delegate (POST /v1/bind) is": edit(body((b) => ((b.parts.delegate = "down"), b))),
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
