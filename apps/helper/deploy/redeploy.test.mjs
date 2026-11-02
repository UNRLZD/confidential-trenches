// node --test apps/helper/deploy/redeploy.test.mjs: the redeploy (card helper-release-bump) raises HELPER_RELEASE by one
// for every new commit and keeps it for the same one. Each test runs the real script on a temp "server": a git
// checkout that fetches from a local repository (REDEPLOY_REMOTE) holding two commits of this script, and a stub
// `docker` on PATH that records what compose would be run with. Nothing reaches a network or a real server.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "redeploy.sh");
const REL = "apps/helper/deploy/redeploy.sh";
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
// a value that must never appear in the script's output
const SECRET = "sk-test-not-a-key-7f3a";

/** A temp server: remote (two commits A and B), a checkout at A, a stub docker. B's script starts with a longer header,
 * so every line of the file moves when B is checked out under a running A. */
function server() {
  const dir = mkdtempSync(path.join(tmpdir(), "redeploy-"));
  const remote = path.join(dir, "remote");
  const root = path.join(dir, "server");
  const bin = path.join(dir, "bin");
  const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();
  const script = readFileSync(SCRIPT, "utf8");
  mkdirSync(path.join(remote, path.dirname(REL)), { recursive: true });
  git(remote, "init", "-q", "-b", "main");
  const commit = (text, msg) => {
    writeFileSync(path.join(remote, REL), text, { mode: 0o755 });
    writeFileSync(path.join(remote, "apps/helper/deploy/compose.yaml"), `# ${msg}\n`);
    git(remote, "add", "--", "apps");
    git(remote, "commit", "-q", "--no-gpg-sign", "-m", msg);
    return git(remote, "rev-parse", "HEAD");
  };
  const A = commit(script, "A");
  const B = commit(script.replace("#!/usr/bin/env bash\n", `#!/usr/bin/env bash\n${"# a longer header in B\n".repeat(40)}`), "B");
  // the server: an empty repository with A fetched and checked out, as the first deploy's command leaves it
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "fetch", "-q", "--depth", "1", `file://${remote}`, A);
  git(root, "checkout", "-q", "--detach", A);
  mkdirSync(bin);
  const log = path.join(dir, "docker.log");
  writeFileSync(path.join(bin, "docker"), `#!/bin/sh\necho "$PWD|$*|$HELPER_COMMIT|$HELPER_RELEASE" >> "${log}"\n`, { mode: 0o755 });
  const env = path.join(root, "apps/helper/deploy/.env");
  const run = (...args) => {
    const r = spawnSync(path.join(root, REL), args, {
      encoding: "utf8",
      // a stray HELPER_COMMIT and HELPER_RELEASE in the operator's shell must not reach compose
      env: { ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, REDEPLOY_REMOTE: `file://${remote}`, HELPER_COMMIT: "f".repeat(40), HELPER_RELEASE: "77" },
    });
    return { status: r.status, out: r.stdout + r.stderr };
  };
  const docker = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const head = () => git(root, "rev-parse", "HEAD");
  const values = () => {
    const t = readFileSync(env, "utf8");
    return { commit: /^HELPER_COMMIT=(.*)$/m.exec(t)?.[1], release: /^HELPER_RELEASE=(.*)$/m.exec(t)?.[1] };
  };
  return { dir, root, A, B, env, run, docker, head, values, deployDir: path.join(root, "apps/helper/deploy"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const mode = (f) => statSync(f).mode & 0o777;

test("a missing release starts at 1; one commit twice keeps n; another commit gets n+1; a rollback gets n+2, never lower", () => {
  const s = server();
  try {
    const deploys = [
      [s.A, "1", "started at 1"],
      [s.A, "1", "kept"],
      [s.B, "2", "raised by one"],
      [s.B, "2", "kept"],
      [s.A, "3", "raised by one"], // a rollback ships with the next number
    ];
    for (const [i, [sha, release, said]] of deploys.entries()) {
      const r = s.run(sha);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, new RegExp(`HELPER_RELEASE ${said}`));
      assert.equal(s.head(), sha, "the checkout is the commit");
      assert.deepEqual(s.values(), { commit: sha, release });
      assert.equal(mode(s.env), 0o600);
      // compose ran in deploy/ with the written values, not the operator's stray ones
      assert.equal(s.docker()[i], `${s.deployDir}|compose up -d --build|${sha}|${release}`);
    }
    assert.equal(s.docker().length, deploys.length);
    // no temp file is left next to the .env
    assert.deepEqual(readdirSync(s.deployDir).filter((f) => f.startsWith(".env")), [".env"]);
  } finally {
    s.done();
  }
});

test("a .env with other lines keeps them byte for byte, in place; the release line is raised where it is; the commit line is added; mode 600 stays", () => {
  const s = server();
  try {
    // today's server: a hand-set HELPER_RELEASE=1 and no HELPER_COMMIT line
    const before = [
      "# vendor keys",
      `JUPITER_API_KEY=${SECRET}`,
      "",
      "HELPER_RELEASE=1",
      'QUOTED="a b $c \\ d = e"',
      "  SPACED = x ",
      "CRLF=1\r",
      "export EXPORTED=2",
      "HELPER_RELEASE_NOTE=not the release",
      "#HELPER_COMMIT=0000000000000000000000000000000000000000",
      "",
    ].join("\n");
    writeFileSync(s.env, before, { mode: 0o600 });
    chmodSync(s.env, 0o600);
    const r = s.run(s.A);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /HELPER_RELEASE raised by one/, "a release with no commit line was another commit's");
    assert.equal(readFileSync(s.env, "utf8"), `${before.replace("HELPER_RELEASE=1\n", "HELPER_RELEASE=2\n")}HELPER_COMMIT=${s.A}\n`);
    assert.equal(mode(s.env), 0o600);
    const again = s.run(s.B);
    assert.equal(again.status, 0, again.out);
    assert.equal(readFileSync(s.env, "utf8"), `${before.replace("HELPER_RELEASE=1\n", "HELPER_RELEASE=3\n")}HELPER_COMMIT=${s.B}\n`);
    // names only: no value of the .env, no commit and no number in what it printed
    for (const out of [r.out, again.out]) {
      for (const v of [SECRET, s.A, s.B, "=2", "=3", "a b $c"]) assert.ok(!out.includes(v), `printed ${v}:\n${out}`);
    }
  } finally {
    s.done();
  }
});

test("a last line with no newline keeps its bytes, and the new lines follow it", () => {
  const s = server();
  try {
    writeFileSync(s.env, `HELPER_COMMIT=${s.A}\nHELPER_RELEASE=4\nLAST=z`, { mode: 0o600 });
    const r = s.run(s.B);
    assert.equal(r.status, 0, r.out);
    assert.equal(readFileSync(s.env, "utf8"), `HELPER_COMMIT=${s.B}\nHELPER_RELEASE=5\nLAST=z\n`);
  } finally {
    s.done();
  }
});

test("a HELPER_RELEASE or HELPER_COMMIT line not in the plain form, or written twice, is refused: nothing changes, the checkout and compose included", () => {
  const bad = {
    "a word": "HELPER_RELEASE=abc\n",
    "zero": "HELPER_RELEASE=0\n",
    "a leading zero": "HELPER_RELEASE=07\n",
    "quoted": 'HELPER_RELEASE="3"\n',
    "exported": "export HELPER_RELEASE=3\n",
    "spaced": "HELPER_RELEASE = 3\n",
    "CRLF": "HELPER_RELEASE=3\r\n",
    "twice": "HELPER_RELEASE=3\nHELPER_RELEASE=4\n",
    "past the helper's 9 digits": "HELPER_RELEASE=1000000000\n",
    "a short commit": "HELPER_RELEASE=3\nHELPER_COMMIT=abc123\n",
    "a commit twice": `HELPER_RELEASE=3\nHELPER_COMMIT=${"a".repeat(40)}\nHELPER_COMMIT=${"b".repeat(40)}\n`,
  };
  const s = server();
  try {
    for (const [name, text] of Object.entries(bad)) {
      const body = `KEY=${SECRET}\n${text}`;
      writeFileSync(s.env, body, { mode: 0o600 });
      const r = s.run(s.B);
      assert.notEqual(r.status, 0, `${name}: ${r.out}`);
      assert.match(r.out, /in deploy\/\.env is not one plain HELPER_(RELEASE|COMMIT)=<value> line; nothing changed/, name);
      assert.ok(!r.out.includes(SECRET), name);
      assert.equal(readFileSync(s.env, "utf8"), body, name);
      assert.equal(s.head(), s.A, `${name}: the checkout did not move`);
      assert.deepEqual(s.docker(), [], `${name}: compose did not run`);
    }
  } finally {
    s.done();
  }
});

test("a usage error (no commit, a short or upper-case one, two) exits 2 and changes nothing", () => {
  const s = server();
  try {
    for (const args of [[], ["abc123"], [s.B.toUpperCase()], [s.B, s.A], ["main"]]) {
      const r = s.run(...args);
      assert.equal(r.status, 2, `${args}: ${r.out}`);
      assert.match(r.out, /usage: redeploy\.sh <40-hex commit>/);
      assert.equal(existsSync(s.env), false);
      assert.equal(s.head(), s.A);
    }
    assert.deepEqual(s.docker(), []);
  } finally {
    s.done();
  }
});

test("a commit the remote does not have fails before the .env is written", () => {
  const s = server();
  try {
    const r = s.run("e".repeat(40));
    assert.notEqual(r.status, 0, r.out);
    assert.equal(existsSync(s.env), false);
    assert.deepEqual(s.docker(), []);
  } finally {
    s.done();
  }
});
