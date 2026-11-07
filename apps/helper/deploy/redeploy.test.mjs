// node --test apps/helper/deploy/redeploy.test.mjs: the redeploy (card helper-release-bump) raises HELPER_RELEASE by one
// for every new commit and keeps it for the same one. Each test runs the real script on a temp "server": a git
// checkout that fetches from a local repository (REDEPLOY_REMOTE) holding two commits of this script, and a stub
// `docker` on PATH that records every call and models the running containers (card helper-ready-gate: the swap starts the
// new container beside the old one, waits bounded for it, then stops the old one). Nothing reaches a network or a real server.
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
  // The stub models the service's containers in `state`, one "<id> <status> <image>" line each, as compose does with
  // --no-recreate: `compose ps -q helper` prints the running ids, `-a` every id, `--status <s>` (any number) those in one
  // of the statuses; `compose up --scale helper=<n>` first starts the stopped containers it counts (as compose does),
  // then adds new-<k> from ct-helper:$HELPER_COMMIT until there are n, and with no --scale adds one; it exits 1 after
  // that when STUB_READY=0 (compose does the same when --wait times out). `compose run` (the settings check) exits 2 when
// STUB_ENV=1. STUB_ADD=0 makes it add none and STUB_IMAGE
  // names the image it adds. `inspect -f <fmt> <id>` prints the id's image; `stop -t <s> <id>` leaves it exited;
  // `rm [-f] <id>` takes it out. Every call is logged as "<cwd>|<args>|<HELPER_COMMIT>|<HELPER_RELEASE>".
  const state = path.join(dir, "containers");
  writeFileSync(state, "");
  writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh
echo "$PWD|$*|$HELPER_COMMIT|$HELPER_RELEASE" >> "${log}"
S="${state}"
drop() { awk -v id="$1" '$1 != id' "$S" > "$S.tmp"; mv "$S.tmp" "$S"; }
mark() { awk -v id="$1" -v st="$2" '$1 == id { $2 = st } { print }' "$S" > "$S.tmp"; mv "$S.tmp" "$S"; }
case "$1 $2" in
  "compose ps")
    all=0; want=""
    shift 2
    while [ $# -gt 0 ]; do
      case "$1" in -a) all=1 ;; --status) want="$want $2"; shift ;; esac
      shift
    done
    if [ -n "$want" ]; then awk -v w="$want " 'index(" " w, " " $2 " ") { print $1 }' "$S"
    elif [ $all = 1 ]; then awk '{ print $1 }' "$S"
    else awk '$2 == "running" { print $1 }' "$S"; fi ;;
  "compose build") ;;
  "compose run") [ "\${STUB_ENV:-0}" = 0 ] || { echo "helper env: POOL_EVM_ADDRESS_BASE_SEPOLIA must be an address" >&2; exit 2; } ;;
  "compose up")
    want=$(echo "$*" | sed -n 's/.*--scale helper=\\([0-9]*\\).*/\\1/p')
    if [ -n "$want" ]; then
      for id in $(awk '$2 != "running" { print $1 }' "$S"); do mark "$id" running; done
    else want=$(( $(wc -l < "$S") + 1 )); fi
    while [ "\${STUB_ADD:-1}" = 1 ] && [ "$(wc -l < "$S")" -lt "$want" ]; do
      n=$(cat "$S.n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$S.n"
      echo "new-$n running \${STUB_IMAGE:-ct-helper:$HELPER_COMMIT}" >> "$S"
    done
    [ "\${STUB_READY:-1}" = 0 ] && exit 1
    ;;
  "inspect -f") awk -v id="$4" '$1 == id { print $3 }' "$S" ;;
  "logs --tail") echo "helper: POOL_EVM_ADDRESS_BASE_SEPOLIA must be an address ($4)" >&2 ;;
  "rm -f") drop "$3" ;;
  "stop -t") mark "$4" exited ;;
  "rm "*) drop "$2" ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  const running = () => readFileSync(state, "utf8").split("\n").filter((l) => l.split(" ")[1] === "running").map((l) => l.split(" ")[0]);
  const all = () => readFileSync(state, "utf8").split("\n").filter(Boolean);
  const seed = (...ids) => writeFileSync(state, ids.map((i) => (i.includes(" ") ? `${i}\n` : `${i} running ct-helper:${"e".repeat(40)}\n`)).join(""));
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
  return { dir, root, A, B, env, git, run, runWith, docker, running, all, seed, head, values, deployDir: path.join(root, "apps/helper/deploy"), done: () => rmSync(dir, { recursive: true, force: true }) };
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
      // compose built and ran in deploy/ with the written values, not the operator's stray ones: the first deploy brings the
      // stack up, each later one adds a second helper beside the running one
      const ups = s.docker().filter((l) => l.includes("|compose up "));
      const up = i === 0 ? "compose up -d --wait --wait-timeout 300" : "compose up -d --no-deps --no-recreate --scale helper=2 --wait --wait-timeout 300 helper";
      assert.equal(ups[i], `${s.deployDir}|${up}|${sha}|${release}`);
      assert.ok(s.docker().includes(`${s.deployDir}|compose build helper|${sha}|${release}`), "built with the written values");
      assert.equal(s.running().length, 1, "one helper runs after each deploy");
    }
    assert.equal(s.docker().filter((l) => l.includes("|compose up ")).length, deploys.length);
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
    assert.equal(s.docker().filter((l) => l.includes("|compose up ")).length, 2 * taken, "compose ran only for the values the helper takes");
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

// card helper-ready-gate: the swap has no gap. The new helper starts beside the old one (docker-rollout's pattern:
// `up --no-recreate --scale helper=<n+1>`), compose waits bounded for its healthcheck, and only then is the old one stopped.
const lines = (s) => s.docker().map((l) => l.split("|")[1]);

test("a new helper that never gets ready: the deploy fails naming the bound, the new container is removed, the old one is never stopped or removed and still runs", () => {
  const s = server();
  try {
    s.seed("old-1");
    const r = s.runWith({ STUB_READY: "0", REDEPLOY_READY_S: "45" }, s.B);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /redeploy: the new helper was not ready within 45 s; the old one keeps serving/);
    const calls = lines(s);
    assert.ok(calls.includes("compose up -d --no-deps --no-recreate --scale helper=2 --wait --wait-timeout 45 helper"), calls.join("\n"));
    assert.ok(calls.includes("rm -f new-1"), "the new container was removed");
    // card helper-ready-without-gt: its last lines first, so the deploy names why (18:55-18:58Z: removed with its logs)
    assert.ok(calls.indexOf("logs --tail 30 new-1") !== -1 && calls.indexOf("logs --tail 30 new-1") < calls.indexOf("rm -f new-1"), calls.join("\n"));
    assert.match(r.out, /redeploy: new-1's last lines:\n {2}helper: POOL_EVM_ADDRESS_BASE_SEPOLIA must be an address \(new-1\)/);
    assert.ok(!calls.some((c) => /^(stop|rm)\b.*\bold-1\b/.test(c)), `the old one was touched:\n${calls.join("\n")}`);
    assert.deepEqual(s.running(), ["old-1"], "the old one still runs, the new one is gone");
  } finally {
    s.done();
  }
});

test("the new image's pool senders' settings check refuses (a half set): the redeploy fails after the build, starts no helper and never stops or removes the old one", () => {
  const t = server();
  try {
    t.seed("old-1");
    const r = t.runWith({ STUB_ENV: "1" }, t.B);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /refuses its senders' settings \(above; a vault line on the vault before: apps\/helper\/deploy\/vault-lines\.sh\)/);
    const calls = t.docker().map((l) => l.split("|")[1]);
    const check = calls.findIndex((c) => c === "compose run --rm --no-deps -T helper node src/env-check.ts");
    assert.ok(check > calls.indexOf("compose build helper"), calls.join("\n"));
    assert.ok(!calls.some((c) => c.startsWith("compose up") || c.startsWith("stop") || c.startsWith("rm")), calls.join("\n"));
    assert.deepEqual(t.running(), ["old-1"]);
  } finally {
    t.done();
  }
});

test("a new helper that gets ready: the old one is stopped (-t 60) and removed after the up --wait line, and the new one is left running", () => {
  const s = server();
  try {
    s.seed("old-1");
    const r = s.run(s.B);
    assert.equal(r.status, 0, r.out);
    const calls = lines(s);
    const up = calls.findIndex((c) => c.startsWith("compose up ") && c.includes("--wait"));
    const stop = calls.indexOf("stop -t 60 old-1");
    const rm = calls.indexOf("rm old-1");
    assert.ok(up >= 0 && stop > up && rm > stop, `order up < stop < rm:\n${calls.join("\n")}`);
    assert.ok(calls.indexOf("compose build helper") < up, "built before the new one starts");
    assert.ok(!calls.some((c) => c.startsWith("rm -f")), "nothing force-removed on success");
    assert.deepEqual(s.running(), ["new-1"]);
    assert.ok(r.out.includes("old-1") && r.out.includes("new-1"), `the swap is named:\n${r.out}`);
  } finally {
    s.done();
  }
});

test("two old helpers running: the new one is scale 3, and both old ones are stopped and removed once it is ready", () => {
  const s = server();
  try {
    s.seed("old-1", "old-2");
    const r = s.run(s.B);
    assert.equal(r.status, 0, r.out);
    const calls = lines(s);
    assert.ok(calls.includes("compose up -d --no-deps --no-recreate --scale helper=3 --wait --wait-timeout 300 helper"), calls.join("\n"));
    for (const id of ["old-1", "old-2"]) assert.ok(calls.indexOf(`stop -t 60 ${id}`) > 0 && calls.indexOf(`rm ${id}`) > calls.indexOf(`stop -t 60 ${id}`), id);
    assert.deepEqual(s.running(), ["new-1"]);
  } finally {
    s.done();
  }
});

test("a stopped helper left from before is removed first: --scale counts it and would start it in place of the new one", () => {
  const s = server();
  try {
    s.seed("old-1", `stale-1 exited ct-helper:${"d".repeat(40)}`);
    const r = s.run(s.B);
    assert.equal(r.status, 0, r.out);
    const calls = lines(s);
    const up = calls.findIndex((c) => c.startsWith("compose up "));
    assert.ok(calls.indexOf("rm stale-1") >= 0 && calls.indexOf("rm stale-1") < up, `the stopped one removed before the up:\n${calls.join("\n")}`);
    assert.deepEqual(s.running(), ["new-1"], "a new helper from this commit's image runs, the stale one never started");
    assert.deepEqual(s.all(), [`new-1 running ct-helper:${s.B}`]);
  } finally {
    s.done();
  }
});

test("compose answers ready but no new helper from this commit's image runs: the deploy fails and no old one is stopped", () => {
  for (const [shell, what] of [[{ STUB_ADD: "0" }, "none added"], [{ STUB_IMAGE: "ct-helper:wrong" }, "another image"]]) {
    const s = server();
    try {
      s.seed("old-1");
      const r = s.runWith(shell, s.B);
      assert.notEqual(r.status, 0, `${what}: ${r.out}`);
      assert.match(r.out, new RegExp(`redeploy: no new helper from ct-helper:${s.B} is running; the old one keeps serving`), what);
      const calls = lines(s);
      assert.ok(!calls.some((c) => /^(stop|rm)\b.*\bold-1\b/.test(c)), `${what}: the old one was touched:\n${calls.join("\n")}`);
      assert.deepEqual(s.running(), ["old-1"], what);
    } finally {
      s.done();
    }
  }
});

test("a first deploy (no helper running) brings the whole stack up with --wait and the default bound, and stops nothing", () => {
  const s = server();
  try {
    const r = s.run(s.A);
    assert.equal(r.status, 0, r.out);
    const calls = lines(s);
    assert.ok(calls.includes("compose up -d --wait --wait-timeout 300"), calls.join("\n"));
    assert.ok(!calls.some((c) => /^(stop|rm)\b/.test(c)), "nothing stopped or removed");
    // a first deploy that is not ready in time fails with one line naming the bound
    const first = server();
    try {
      const r2 = first.runWith({ STUB_READY: "0", REDEPLOY_READY_S: "9" }, first.A);
      assert.notEqual(r2.status, 0, r2.out);
      assert.match(r2.out, /redeploy: the helper was not ready within 9 s/);
    } finally {
      first.done();
    }
  } finally {
    s.done();
  }
});

test("REDEPLOY_READY_S that is not whole seconds from 1 to 9999 exits 2 before anything changes; 45 reaches --wait-timeout 45", () => {
  const s = server();
  try {
    for (const v of ["abc", "0", "01", "-5", "1.5", "10000", " 5", "5s", "1e3"]) {
      const r = s.runWith({ REDEPLOY_READY_S: v }, s.B);
      assert.equal(r.status, 2, `${JSON.stringify(v)}: ${r.out}`);
      assert.match(r.out, /usage: redeploy\.sh <40-hex commit>.*REDEPLOY_READY_S/);
      assert.equal(existsSync(s.env), false, "no .env write");
      assert.equal(s.head(), s.A, "no checkout");
      assert.deepEqual(s.docker(), [], "no docker call");
    }
    const ok = s.runWith({ REDEPLOY_READY_S: "45" }, s.B);
    assert.equal(ok.status, 0, ok.out);
    assert.ok(lines(s).some((c) => c.startsWith("compose up ") && c.includes("--wait-timeout 45")));
    const max = s.runWith({ REDEPLOY_READY_S: "9999" }, s.B);
    assert.equal(max.status, 0, max.out);
    assert.ok(lines(s).some((c) => c.includes("--wait-timeout 9999")));
  } finally {
    s.done();
  }
});

/** The helper service's healthcheck in compose.yaml; throws unless it passes only when /v1/health says ready === true. */
export function healthcheckProblem(yml) {
  const service = /^ {2}helper:\n([\s\S]*?)(?=^ {2}[a-z_]+:\n|^\S)/m.exec(yml)?.[1] ?? "";
  const block = /^ {4}healthcheck:\n((?: {6}.*\n|\s*#.*\n)+)/m.exec(service)?.[1];
  if (!block) return "no healthcheck under services.helper";
  const field = (k) => new RegExp(`^ {6}${k}: (.*)$`, "m").exec(block)?.[1]?.trim();
  let cmd;
  try {
    cmd = JSON.parse(field("test") ?? "");
  } catch {
    return "healthcheck test is not one JSON list";
  }
  if (!Array.isArray(cmd) || cmd[0] !== "CMD" || cmd[1] !== "node" || cmd[2] !== "-e" || typeof cmd[3] !== "string" || cmd.length !== 4) return "healthcheck test is not CMD node -e <script>";
  const js = cmd[3];
  if (!js.includes("http://127.0.0.1:8080/v1/health")) return "healthcheck does not read /v1/health on 8080";
  if (!/process\.exit\(j\.ready===true\?0:1\)/.test(js)) return "healthcheck does not exit 0 only on ready===true";
  if (!/,\(\)=>process\.exit\(1\)\)/.test(js)) return "healthcheck does not fail when the read fails";
  for (const [k, v] of [["interval", "2s"], ["timeout", "2s"], ["retries", "3"], ["start_period", "300s"]]) if (field(k) !== v) return `healthcheck ${k} is not ${v}`;
  return "";
}

test("compose.yaml's helper healthcheck passes only on ready === true; a copy that drops it fails the parser", () => {
  const yml = readFileSync(path.join(path.dirname(SCRIPT), "compose.yaml"), "utf8");
  assert.equal(healthcheckProblem(yml), "");
  assert.match(healthcheckProblem(yml.replace("j.ready===true?0:1", "0")), /ready===true/);
  assert.match(healthcheckProblem(yml.replace("j.ready===true?0:1", "j.ready!==false?0:1")), /ready===true/);
  assert.match(healthcheckProblem(yml.replace(/^ {4}healthcheck:\n(?: {6}.*\n)+/m, "")), /no healthcheck/);
  assert.match(healthcheckProblem(yml.replace("start_period: 300s", "start_period: 5s")), /start_period/);
  assert.match(healthcheckProblem(yml.replaceAll("/v1/health", "/v1/other")), /\/v1\/health/);
});
