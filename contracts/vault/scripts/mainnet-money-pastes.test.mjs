// node --test contracts/vault/scripts/mainnet-money-pastes.test.mjs: the mainnet money run's pastes (mainnet-money/),
// offline. node, npx and npm are stubs put first on PATH, each recording its arguments: every paste must hand its whole
// work to the driver (mainnet-money.ts) in one node call, with the run's folder outside the repo, and none may reach for
// a package runner. Nothing reaches a network or a key: the key file's path is only passed on, to be read by the
// driver's own process (deploy.mjs loadKey).
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "mainnet-money");
const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), "mainnet-money-pastes-")));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const GATE = path.join(HERE, "source-gate.mjs");
const REPO = "https://github.com/UNRLZD/confidential-trenches";
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, ...a) => {
  const r = spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// a temp checkout holding the pastes and a file under packages/wallet, committed and pushed to a local bare repo that
// git reads in place of the public repo (url.insteadOf in the checkout's own config); a HOME outside it; a bin of stubs.
// The node stub runs the real source gate (source-gate.mjs, deploy.mjs's sourceProblems) and records every other call.
function world({ runExit = 0 } = {}) {
  const root = path.join(TMP, String(n++));
  const repo = path.join(root, "repo");
  const dir = path.join(repo, "contracts", "vault", "scripts", "mainnet-money");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const wallet = path.join(repo, "packages", "wallet", "src");
  for (const d of [dir, bin, home, wallet]) mkdirSync(d, { recursive: true });
  for (const f of readdirSync(DIR)) writeFileSync(path.join(dir, f), readFileSync(path.join(DIR, f)));
  writeFileSync(path.join(wallet, "sign.ts"), "export const x = 1;\n");
  const remote = path.join(root, "remote.git");
  git(root, "init", "-q", "--bare", remote);
  git(root, "init", "-q", "-b", "main", repo);
  git(repo, "config", `url.${remote}.insteadOf`, REPO);
  git(repo, "add", "contracts", "packages");
  git(repo, "commit", "-q", "-m", "w");
  git(repo, "push", "-q", REPO, "main");
  const log = path.join(root, "calls");
  for (const name of ["node", "npx", "npm", "pnpm", "near"]) {
    const gate = name === "node" ? `if [ "$1" = contracts/vault/scripts/source-gate.mjs ]; then exec "${process.execPath}" "${GATE}"; fi\n` : "";
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${gate}printf '%s\\n' "${name} $*" >> "${log}"\nexit 0\n`);
    chmodSync(path.join(bin, name), 0o755);
  }
  // timeout: records its arguments and answers as the case plants (124: the run was stopped while it waited)
  writeFileSync(path.join(bin, "timeout"), `#!/bin/sh\nprintf '%s\\n' "timeout $*" >> "${log}"\nexit ${runExit}\n`);
  chmodSync(path.join(bin, "timeout"), 0o755);
  const runs = path.join(home, ".confidential-trenches", "runs");
  return { root, repo, dir, home, runs, log, state: path.join(runs, "vault-mainnet-money"), env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home } };
}
const exec = (w, paste, args = []) => spawnSync("/bin/sh", [path.join(w.dir, paste), ...args], { encoding: "utf8", timeout: 30_000, env: w.env });
const calls = (w) => (existsSync(w.log) ? readFileSync(w.log, "utf8").trim().split("\n") : []);

test("1-run.sh without the account the withdrawal pays runs nothing", () => {
  const w = world();
  for (const args of [[], ["a.near", "b.near"]]) {
    const r = exec(w, "1-run.sh", args);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /name the NEAR account the withdrawal pays/);
  }
  assert.deepEqual(calls(w), []);
});

test("1-run.sh runs the driver once, its folder outside the repo (mode 700), paying the named account", () => {
  const w = world();
  const r = exec(w, "1-run.sh", ["owner.near"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls(w), [`node contracts/vault/scripts/mainnet-money.ts run --state ${w.state} --to owner.near`]);
  assert.equal(statSync(w.runs).mode & 0o777, 0o700);
  // pasted again after a stop, the same line: run goes on from the folder (create-or-continue)
  exec(w, "1-run.sh", ["owner.near"]);
  assert.equal(calls(w).length, 2);
  assert.equal(calls(w)[1], calls(w)[0]);
});

test("2-open-u.sh hands the key file's path to the driver's own signing: no package runner, no CLI, no typed phrase", () => {
  const w = world();
  const r = exec(w, "2-open-u.sh");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const key = `${w.home}/.confidential-trenches/keys/confidential.unrlzd.near.json`;
  assert.deepEqual(calls(w), [`node contracts/vault/scripts/mainnet-money.ts open-u --state ${w.state} --payer confidential.unrlzd.near --key-file ${key}`]);
  // nothing written beside the paste or in HOME by the paste itself
  assert.deepEqual(readdirSync(w.home), []);
});

test("3-record.sh passes the named funding and settle txs to the record", () => {
  const w = world();
  const r = exec(w, "3-record.sh", ["--fund-tx", "9".repeat(44), "sender.near", "--settle-tx", "8".repeat(44), "r.near"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls(w), [`node contracts/vault/scripts/mainnet-money.ts record --state ${w.state} --fund-tx ${"9".repeat(44)} sender.near --settle-tx ${"8".repeat(44)} r.near`]);
});

test("4-sweep-u.sh hands the run's folder to the driver's sweep, which signs as U: no key file, no runner", () => {
  const w = world();
  const r = exec(w, "4-sweep-u.sh");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls(w), [`node contracts/vault/scripts/mainnet-money.ts sweep-u --state ${w.state}`]);
});

// each paste that signs (1, 2 and 4) runs from a checkout anyone can read back: a planted edit under packages/wallet,
// an untracked file or a HEAD on no branch of the public repo stops it before the driver runs
const SIGNING = [["1-run.sh", ["owner.near"]], ["2-open-u.sh", []], ["4-sweep-u.sh", []]];
test("MB: 1-run.sh, 2-open-u.sh and 4-sweep-u.sh refuse a tree with an uncommitted edit under packages/wallet: the driver never runs", () => {
  for (const [paste, args] of SIGNING) {
    const w = world();
    writeFileSync(path.join(w.repo, "packages", "wallet", "src", "sign.ts"), "export const x = 2;\n");
    const r = exec(w, paste, args);
    assert.equal(r.status, 1, paste + r.stdout + r.stderr);
    assert.match(r.stderr, /refused, nothing signed: the tree has 1 changed or untracked path\(s\) \( M packages\/wallet\/src\/sign\.ts\)/, paste);
    assert.deepEqual(calls(w), [], paste);
    // an untracked file is refused the same way
    git(w.repo, "checkout", "-q", "--", "packages");
    writeFileSync(path.join(w.repo, "packages", "wallet", "src", "extra.ts"), "x\n");
    assert.equal(exec(w, paste, args).status, 1, paste);
    assert.deepEqual(calls(w), [], paste);
  }
});

test("MB: 1-run.sh, 2-open-u.sh and 4-sweep-u.sh refuse a HEAD that is not pushed; pushed, the driver runs", () => {
  for (const [paste, args] of SIGNING) {
    const w = world();
    writeFileSync(path.join(w.repo, "packages", "wallet", "src", "sign.ts"), "export const x = 3;\n");
    git(w.repo, "commit", "-q", "-am", "local only");
    const r = exec(w, paste, args);
    assert.equal(r.status, 1, paste + r.stdout + r.stderr);
    assert.match(r.stderr, /refused, nothing signed: commit [0-9a-f]{40} is on no branch or tag of https:\/\/github\.com\/UNRLZD\/confidential-trenches/, paste);
    assert.deepEqual(calls(w), [], paste);
    git(w.repo, "push", "-q", REPO, "main");
    assert.equal(exec(w, paste, args).status, 0, paste);
    assert.equal(calls(w).length, 1, paste);
  }
});

test("MB: the driver holds the same gate on mainnet for run, resume, open-u and sweep-u, before any read", () => {
  const SRC = readFileSync(path.join(HERE, "mainnet-money.ts"), "utf8");
  assert.match(SRC, /import \{ treeProblems \} from "\.\/source-gate\.mjs";/);
  for (const fn of ["go(argv: string[], create: boolean)", "openU(argv: string[])", "sweepU(argv: string[])"]) {
    const body = SRC.slice(SRC.indexOf(`async function ${fn}`));
    assert.match(body.slice(0, 400), /^[^\n]*\n[^\n]*flags\([^\n]*\n  sourceGate\(networkOf\(v\)\);\n  const o = await opened\(/, fn);
  }
  for (const f of ["1-run.sh", "2-open-u.sh", "4-sweep-u.sh"]) assert.match(readFileSync(path.join(DIR, f), "utf8"), /\nnode contracts\/vault\/scripts\/source-gate\.mjs\n/, f);
});

const G = "g-2b700409.bf-vt-20261102t071444.testnet";
const P = "bf-vt-20261102t071444.testnet";
test("rehearse-testnet.sh plan: the run planned and stopped while it waits, then U opened and the named account registered once, from P's key file", () => {
  const w = world({ runExit: 124 });
  const st = `${w.home}/ct-runs/vault-mainnet-money-testnet`;
  const key = `${w.home}/.near-credentials/testnet/${P}.json`;
  const D = "node contracts/vault/scripts/mainnet-money.ts";
  const r = exec(w, "rehearse-testnet.sh", ["plan"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls(w), [
    `timeout 180 ${D} run --network testnet --bind-relayer ${G} --state ${st} --to ${P}`,
    `${D} open-u --network testnet --bind-relayer ${G} --state ${st} --payer ${P} --key-file ${key} --register ${P}`,
    `${D} check --network testnet --bind-relayer ${G} --state ${st} --to ${P}`,
  ]);
  assert.equal(statSync(path.dirname(st)).mode & 0o777, 0o700);
  // a second plan, after the registration is kept in open-u.json, registers nothing again
  mkdirSync(st, { recursive: true });
  writeFileSync(path.join(st, "open-u.json"), JSON.stringify({ txs: [{ what: `storage_deposit of ${P} on bf-usdc-20261101t022248.testnet` }] }));
  writeFileSync(w.log, "");
  assert.equal(exec(w, "rehearse-testnet.sh", ["plan"]).status, 0);
  assert.ok(!calls(w).some((c) => c.includes("--register")), calls(w).join("\n"));
});

test("rehearse-testnet.sh plan stops when the run ends before its wait (a refusal): nothing opened", () => {
  const w = world({ runExit: 1 });
  const r = exec(w, "rehearse-testnet.sh", ["plan"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(calls(w).length, 1);
});

test("rehearse-testnet.sh finish: resume, sweep-u and the record with the funding tx; without it nothing runs", () => {
  const w = world();
  const st = `${w.home}/ct-runs/vault-mainnet-money-testnet`;
  const D = "node contracts/vault/scripts/mainnet-money.ts";
  assert.equal(exec(w, "rehearse-testnet.sh", ["finish"]).status, 1);
  assert.equal(exec(w, "rehearse-testnet.sh", []).status, 1);
  assert.deepEqual(calls(w), []);
  const r = exec(w, "rehearse-testnet.sh", ["finish", "9".repeat(44), "sender.testnet"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls(w), [
    `${D} resume --network testnet --bind-relayer ${G} --state ${st} --to ${P}`,
    `${D} sweep-u --network testnet --bind-relayer ${G} --state ${st}`,
    `${D} record --network testnet --bind-relayer ${G} --state ${st} --fund-tx ${"9".repeat(44)} sender.testnet`,
  ]);
});

test("no paste names a package runner, a downloaded CLI or a loose state file", () => {
  for (const f of readdirSync(DIR)) {
    const s = readFileSync(path.join(DIR, f), "utf8");
    assert.doesNotMatch(s.replace(/^#.*$/gm, ""), /npx|npm |pnpm|near-cli|curl|wget|\.u"|\.open-u\.txs|seed-phrase/, f);
  }
});
