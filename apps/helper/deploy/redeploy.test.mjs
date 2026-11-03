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
import { budgetFromEnv } from "../src/limits/limits.ts";
import { RPC_BATCH_MAX } from "../src/rpc/methods.ts";
import { RPC_RESERVE } from "../src/rpc/rpc.ts";
import { PROXY_RESERVE } from "../src/proxy/proxy.ts";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "redeploy.sh");
const REL = "apps/helper/deploy/redeploy.sh";
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
// a value that must never appear in the script's output
const SECRET = "sk-test-not-a-key-7f3a";
const TEST_KEYS = { JUPITER_API_KEY: "test-jupiter-0001", RELAY_API_KEY: "test-relay-0001", LIFI_API_KEY: "test-lifi-0001", ONECLICK_JWT: "test-oneclick-0001" };

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
  // `shell`: variables for the operator's shell; null takes one out. The vendor keys are test values (the start and the
  // redeploy refuse a vendor with no key and no keyless plan).
  const runWith = (shell, ...args) => {
    const env = { ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, REDEPLOY_REMOTE: `file://${remote}`, HELPER_COMMIT: "f".repeat(40), HELPER_RELEASE: "77", ...TEST_KEYS, ...shell };
    for (const [k, v] of Object.entries(env)) if (v === null) delete env[k];
    const r = spawnSync(path.join(root, REL), args, {
      encoding: "utf8",
      // a stray HELPER_COMMIT and HELPER_RELEASE in the operator's shell must not reach compose
      env,
    });
    return { status: r.status, out: r.stdout + r.stderr };
  };
  const run = (...args) => runWith({}, ...args);
  const docker = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const head = () => git(root, "rev-parse", "HEAD");
  const values = () => {
    const t = readFileSync(env, "utf8");
    return { commit: /^HELPER_COMMIT=(.*)$/m.exec(t)?.[1], release: /^HELPER_RELEASE=(.*)$/m.exec(t)?.[1] };
  };
  return { dir, root, A, B, env, git, run, runWith, docker, head, values, deployDir: path.join(root, "apps/helper/deploy"), done: () => rmSync(dir, { recursive: true, force: true }) };
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

// the rule as the helper's start applies it, each name with its own-read reserve
const rules = {
  RPC_BUDGET_SOLANA: { minShare: RPC_BATCH_MAX, perMethod: true, reserve: RPC_RESERVE.solana },
  RPC_BUDGET_BASE: { minShare: RPC_BATCH_MAX, perMethod: true, reserve: RPC_RESERVE.base },
  PROXY_BUDGET_JUPITER: { reserve: PROXY_RESERVE.jupiter },
  PROXY_BUDGET_RELAY: { reserve: PROXY_RESERVE.relay },
};
const helperTakes = (name, v) => {
  try {
    budgetFromEnv({ [name]: v }, name, { total: 1, perClient: 0 }, rules[name]);
    return true;
  } catch {
    return false;
  }
};
const values = ["", "100,16", "100,10", "100,9", "100,5", "16,16", "4,2", "2,1", "100,16,40", "100,16,10", "100,16,9", "100,16,12", "100,16,13", "100,16,100", "100,16,101", "100,16,", "100,16,40,1",
  "12,10", "13,10", "14,10", "34,1", "35,1", "36,1", "60,4", "38,4", "39,4", "600,4", "50,2", "3,2",
  "0,0", "05,4", "1e3,1", "-1,1", " 100,16", "100,16 ", "100;16", "１００,１６", "9999999,10", "10000000,10", "lots", `${SECRET},1`, "'100,16'"];
// The drift check (fold 5): redeploy.sh's budget_ok, run on its own, agrees with budgetFromEnv for every name with a
// reserve and one without, on every value.
test("budget_ok in redeploy.sh takes exactly the values budgetFromEnv takes, each name with its own-read reserve", () => {
  const text = readFileSync(SCRIPT, "utf8");
  const fn = /^budget_ok\(\) \{\n[\s\S]*?\n\}\n/m.exec(text)?.[0];
  assert.ok(fn, "budget_ok is in the script");
  let checked = 0;
  for (const name of Object.keys(rules))
    for (const v of values) {
      const r = spawnSync("bash", ["-c", `set -euo pipefail\n${fn}\nbudget_ok "$1" "$2"`, "budget_ok", name, v], { encoding: "utf8" });
      assert.equal(r.status === 0, helperTakes(name, v), `${name}=${JSON.stringify(v)}: bash ${r.status === 0 ? "takes" : "refuses"} it, the helper ${helperTakes(name, v) ? "takes" : "refuses"} it`);
      checked++;
    }
  assert.ok(checked >= 4 * 40, `checked ${checked}`);
});

// re-check finding 4: a budget value the helper's start refuses (budgetFromEnv, exit 2) would leave the container
// restarting; the redeploy refuses it first, with the same rule, naming the variable only, with nothing changed.
test("a budget variable the helper would refuse, in deploy/.env or in the shell, stops the redeploy with nothing changed; the rule is budgetFromEnv's", () => {
  const s = server();
  try {
    let refused = 0;
    for (const name of ["RPC_BUDGET_SOLANA", "PROXY_BUDGET_JUPITER"]) {
      for (const v of values) {
        const takes = helperTakes(name, v);
        for (const where of ["env", "shell"]) {
          const body = where === "env" ? `KEY=${SECRET}\nHELPER_RELEASE=3\nHELPER_COMMIT=${s.A}\n${name}=${v}\n` : `KEY=${SECRET}\nHELPER_RELEASE=3\nHELPER_COMMIT=${s.A}\n`;
          writeFileSync(s.env, body, { mode: 0o600 });
          const r = s.runWith(where === "shell" ? { [name]: v } : {}, s.B);
          const label = `${name}=${JSON.stringify(v)} in the ${where}`;
          if (takes) {
            assert.equal(r.status, 0, `${label}: the helper takes it, so must the redeploy: ${r.out}`);
            s.git(s.root, "checkout", "-q", "--detach", s.A); // back to A for the next case
            continue;
          }
          refused++;
          assert.notEqual(r.status, 0, `${label}: ${r.out}`);
          assert.match(r.out, new RegExp(`redeploy: ${name} in (this shell|deploy/\\.env) is not a budget the helper takes; nothing changed`), label);
          if (v.trim() !== "") assert.ok(!r.out.includes(v.trim()), `${label}: the value is never printed`);
          assert.ok(!r.out.includes(SECRET), label);
          assert.equal(readFileSync(s.env, "utf8"), body, `${label}: the .env is unchanged`);
          assert.equal(s.head(), s.A, `${label}: the checkout did not move`);
        }
      }
    }
    assert.ok(refused >= 40, `refused ${refused}`);
    // a budget line not in the plain form is refused the same way
    writeFileSync(s.env, `HELPER_RELEASE=3\nexport RPC_BUDGET_BASE=100,16\n`, { mode: 0o600 });
    const r = s.run(s.B);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /RPC_BUDGET_BASE in deploy\/\.env is not one plain RPC_BUDGET_BASE=<value> line; nothing changed/);
    const taken = ["RPC_BUDGET_SOLANA", "PROXY_BUDGET_JUPITER"].reduce((k, name) => k + values.filter((v) => helperTakes(name, v)).length, 0);
    assert.equal(s.docker().length, 2 * taken, "compose ran only for the values the helper takes");
  } finally {
    s.done();
  }
});

// re-check 4 finding 3: compose's .env parser also reads "NAME: value"; such a line is not one plain NAME=value line,
// so it is refused like any other form, the budgets' and the release's alike.
test("a \"NAME: value\" line (compose reads it) for a budget or the release is refused as not one plain line; nothing changes", () => {
  const s = server();
  try {
    for (const [name, line] of [["RPC_BUDGET_SOLANA", "RPC_BUDGET_SOLANA: 5,50"], ["RPC_BUDGET_SOLANA", "RPC_BUDGET_SOLANA:5,50"], ["PROXY_BUDGET_JUPITER", "PROXY_BUDGET_JUPITER: 9999,1"], ["HELPER_RELEASE", "HELPER_RELEASE: 3"]]) {
      const body = `KEY=${SECRET}\nHELPER_COMMIT=${s.A}\n${line}\n`;
      writeFileSync(s.env, body, { mode: 0o600 });
      const r = s.run(s.B);
      assert.notEqual(r.status, 0, `${line}: ${r.out}`);
      assert.match(r.out, new RegExp(`${name} in deploy/\\.env is not one plain ${name}=<value> line; nothing changed`), line);
      assert.ok(!r.out.includes("5,50") && !r.out.includes("9999,1") && !r.out.includes(SECRET), `${line}: no value printed`);
      assert.equal(readFileSync(s.env, "utf8"), body, line);
      assert.equal(s.head(), s.A, line);
    }
    assert.deepEqual(s.docker(), [], "compose never ran");
  } finally {
    s.done();
  }
});

// re-check 4 finding 4: every default budget is a keyed plan's; a vendor with no key must have its keyless plan named.
test("a vendor key unset (in the shell or deploy/.env) with no PROXY_BUDGET_<VENDOR> stops the redeploy, naming the variables only; a key in deploy/.env or a set budget passes", () => {
  const s = server();
  try {
    const base = `HELPER_RELEASE=3\nHELPER_COMMIT=${s.A}\n`;
    for (const [key, budget] of [["JUPITER_API_KEY", "PROXY_BUDGET_JUPITER"], ["RELAY_API_KEY", "PROXY_BUDGET_RELAY"], ["LIFI_API_KEY", "PROXY_BUDGET_LIFI"], ["ONECLICK_JWT", "PROXY_BUDGET_ONECLICK"]]) {
      for (const shell of [{ [key]: null }, { [key]: "" }]) {
        writeFileSync(s.env, base, { mode: 0o600 });
        const r = s.runWith(shell, s.B);
        assert.notEqual(r.status, 0, `${key} ${JSON.stringify(shell)}: ${r.out}`);
        assert.match(r.out, new RegExp(`redeploy: ${key} is unset: set it, or ${budget} to the plan without a key; nothing changed`));
        for (const v of Object.values(TEST_KEYS)) assert.ok(!r.out.includes(v), "no key printed");
        assert.equal(readFileSync(s.env, "utf8"), base);
        assert.equal(s.head(), s.A);
      }
      // the key in deploy/.env (none in the shell), or the keyless plan named: the redeploy goes ahead
      for (const [shell, body] of [[{ [key]: null }, `${base}${key}=${SECRET}\n`], [{ [key]: null }, `${base}${budget}=100,2\n`], [{ [key]: "", [budget]: "100,2" }, base]]) {
        writeFileSync(s.env, body, { mode: 0o600 });
        const r = s.runWith(shell, s.B);
        assert.equal(r.status, 0, `${key}: ${r.out}`);
        assert.ok(!r.out.includes(SECRET));
        s.git(s.root, "checkout", "-q", "--detach", s.A);
      }
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
