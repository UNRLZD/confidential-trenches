// node --test contracts/vault/scripts/mainnet-money-pastes.test.mjs: the mainnet money run's pastes (mainnet-money/),
// offline. The owner pastes the lines lines.sh prints; each line makes its own fresh clone of the public repo at the
// commit it names and runs that commit's paste script there. Here git is a shim that clones a local bare repo in place of
// the public one (then sets origin to the public URL, as a real clone has it), the source gate is the real one, and node
// (the driver), pnpm, npx, npm, near and timeout are stubs that record their arguments and folder. Nothing reaches a
// network or a key: the key file's path is only passed on, to be read by the driver's own process (deploy.mjs loadKey).
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

const REPO = "https://github.com/UNRLZD/confidential-trenches.git";
const GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const GIT_ENV = { PATH: process.env.PATH, HOME: TMP, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, ...a) => {
  const r = spawnSync(GIT, ["-C", cwd, ...a], { encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// the public repo, as a local bare one: the pastes, the source gate and a file under packages/wallet, on main (C) and on
// a card branch only (K); a HOME of its own; a bin of shims and stubs, each recording "<name> <args> @ <folder>"
function world({ runExit = 0 } = {}) {
  const root = path.join(TMP, String(n++));
  const src = path.join(root, "src");
  const bare = path.join(root, "remote.git");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const dir = path.join(src, "contracts", "vault", "scripts", "mainnet-money");
  for (const d of [dir, bin, home, path.join(src, "packages", "wallet", "src")]) mkdirSync(d, { recursive: true });
  for (const f of readdirSync(DIR)) writeFileSync(path.join(dir, f), readFileSync(path.join(DIR, f)));
  writeFileSync(path.join(src, "contracts", "vault", "scripts", "source-gate.mjs"), readFileSync(path.join(HERE, "source-gate.mjs")));
  writeFileSync(path.join(src, "packages", "wallet", "src", "sign.ts"), "export const x = 1;\n");
  writeFileSync(path.join(src, ".gitignore"), "node_modules/\n");
  git(root, "init", "-q", "--bare", bare);
  git(root, "init", "-q", "-b", "main", src);
  git(src, "add", "--", ".gitignore", "contracts", "packages");
  git(src, "commit", "-q", "-m", "w");
  git(src, "push", "-q", bare, "main");
  const C = git(src, "rev-parse", "HEAD");
  git(src, "checkout", "-q", "-b", "card");
  writeFileSync(path.join(src, "packages", "wallet", "src", "sign.ts"), "export const x = 2;\n");
  git(src, "commit", "-q", "-am", "card");
  git(src, "push", "-q", bare, "card");
  const K = git(src, "rev-parse", "HEAD");
  git(src, "checkout", "-q", "main");
  const log = path.join(root, "calls");
  const rec = (name) => `printf '%s\\n' "${name} $* @ $(pwd)" >> "${log}"`;
  // git: a clone of the public repo comes from the bare one, with origin then the public URL; it records whether the
  // line's environment holds no git config but the clone's own
  writeFileSync(path.join(bin, "git"), `#!/bin/sh
if [ "$1" = clone ]; then
  printf '%s\\n' "git clone GIT_CONFIG_GLOBAL=$GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM=$GIT_CONFIG_NOSYSTEM ENV=$(env | grep -c .)" >> "${log}"
  for last; do :; done
  "${GIT}" clone -q "${bare}" "$last" && exec "${GIT}" -C "$last" remote set-url origin "${REPO}"
fi
exec "${GIT}" "$@"
`);
  writeFileSync(path.join(bin, "node"), `#!/bin/sh\nif [ "$1" = contracts/vault/scripts/source-gate.mjs ]; then exec "${process.execPath}" "$@"; fi\n${rec("node")}\nexit 0\n`);
  for (const name of ["npx", "npm", "pnpm", "near"]) writeFileSync(path.join(bin, name), `#!/bin/sh\n${rec(name)}\nexit 0\n`);
  // timeout: records its arguments and answers as the case plants (124: the run was stopped while it waited)
  writeFileSync(path.join(bin, "timeout"), `#!/bin/sh\n${rec("timeout")}\nexit ${runExit}\n`);
  for (const f of readdirSync(bin)) chmodSync(path.join(bin, f), 0o755);
  const runs = path.join(home, ".confidential-trenches", "runs");
  return { root, src, bare, home, runs, log, C, K, state: path.join(runs, "vault-mainnet-money"), env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home } };
}
const calls = (w) => (existsSync(w.log) ? readFileSync(w.log, "utf8").trim().split("\n").filter(Boolean) : []);
const lines = (w, commit = w.C, account = "owner.near") => spawnSync("/bin/sh", [path.join(DIR, "lines.sh"), commit, account], { encoding: "utf8", env: w.env });
const paste = (w, k, extra = "", commit = w.C) => {
  const line = lines(w, commit).stdout.split("\n").filter((l) => l && !l.startsWith("#"))[k - 1];
  return spawnSync("/bin/sh", ["-c", line + extra], { encoding: "utf8", timeout: 60_000, env: w.env, cwd: w.root });
};
const SRC_DIR = (w) => path.join(w.home, ".confidential-trenches", "src");
const D = "node contracts/vault/scripts/mainnet-money.ts";

test("lines.sh prints the four lines for a 40-hex commit and an account id, and nothing else", () => {
  const w = world();
  for (const args of [[], [w.C], ["abc", "owner.near"], [w.C, "Owner Near"], [w.C, "a.near", "x"]]) {
    const r = spawnSync("/bin/sh", [path.join(DIR, "lines.sh"), ...args], { encoding: "utf8", env: w.env });
    assert.equal(r.status, 1, args.join(" "));
  }
  const r = lines(w);
  assert.equal(r.status, 0, r.stderr);
  const ls = r.stdout.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.equal(ls.length, 4);
  ls.forEach((l, k) => {
    assert.match(l, /^env -i HOME="\$HOME" PATH="\$PATH" GIT_CONFIG_GLOBAL=\/dev\/null GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 sh -c '/);
    assert.ok(l.includes(`git clone -q ${REPO} "$D"`), l);
    assert.ok(l.includes(`checkout -q --detach "$1"; exec sh contracts/vault/scripts/mainnet-money/${["1-run", "2-open-u", "3-record", "4-sweep-u"][k]}.sh "$@"'`), l);
    assert.ok(l.endsWith(k === 0 ? ` vmm ${w.C} owner.near` : ` vmm ${w.C}`), l);
  });
});

test("F1: line 1 clones the public repo into a new folder with no git config of the owner's, installs from the lockfile there and runs the driver at the commit", () => {
  const w = world();
  const r = paste(w, 1);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = calls(w);
  assert.equal(c.length, 3, c.join("\n"));
  assert.match(c[0], /^git clone GIT_CONFIG_GLOBAL=\/dev\/null GIT_CONFIG_NOSYSTEM=1 ENV=([0-9]+)$/);
  // env -i: HOME, PATH, the three git settings and what sh itself sets (PWD, SHLVL, _), nothing of the owner's shell
  assert.ok(Number(c[0].match(/ENV=([0-9]+)/)[1]) <= 9, c[0]);
  const clone = c[1].match(/ @ (.*)$/)[1];
  assert.equal(path.dirname(clone), SRC_DIR(w));
  assert.equal(c[1], `pnpm install --frozen-lockfile @ ${clone}`);
  assert.equal(c[2], `${D} run --commit ${w.C} --state ${w.state} --to owner.near @ ${clone}`);
  assert.equal(git(clone, "rev-parse", "HEAD"), w.C);
  assert.equal(statSync(w.runs).mode & 0o777, 0o700);
  assert.equal(statSync(clone).mode & 0o777, 0o700);
  // pasted again after a stop: a new clone of its own, the same driver line, the same run folder
  assert.equal(paste(w, 1).status, 0);
  const c2 = calls(w).slice(3);
  const clone2 = c2[2].match(/ @ (.*)$/)[1];
  assert.notEqual(clone2, clone);
  assert.equal(c2[2].replace(clone2, clone), c[2]);
});

test("F1: lines 2, 3 and 4 run open-u, record (with the txs typed after the line) and sweep-u from their own clones at the commit", () => {
  const w = world();
  assert.equal(paste(w, 2).status, 0);
  assert.equal(paste(w, 3, ` --fund-tx ${"9".repeat(44)} sender.near --settle-tx ${"8".repeat(44)} r.near`).status, 0);
  assert.equal(paste(w, 4).status, 0);
  const drivers = calls(w).filter((l) => l.startsWith("node "));
  const key = `${w.home}/.confidential-trenches/keys/confidential.unrlzd.near.json`;
  const at = (l) => l.replace(/ @ .*$/, "");
  assert.deepEqual(drivers.map(at), [
    `${D} open-u --commit ${w.C} --state ${w.state} --payer confidential.unrlzd.near --key-file ${key}`,
    `${D} record --commit ${w.C} --state ${w.state} --fund-tx ${"9".repeat(44)} sender.near --settle-tx ${"8".repeat(44)} r.near`,
    `${D} sweep-u --commit ${w.C} --state ${w.state}`,
  ]);
  assert.equal(new Set(drivers.map((l) => l.match(/ @ (.*)$/)[1])).size, 3, "each line its own clone");
  assert.equal(calls(w).filter((l) => l.startsWith("pnpm install --frozen-lockfile @ ")).length, 3);
});

test("F1: a commit not on the public repo's main (a pushed card branch) is refused before the install: nothing runs", () => {
  const w = world();
  for (const k of [1, 2, 3, 4]) {
    const r = paste(w, k, "", w.K);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /refused, nothing signed: commit [0-9a-f]{40} is not on https:\/\/github\.com\/UNRLZD\/confidential-trenches's main/);
  }
  assert.deepEqual(calls(w).filter((l) => !l.startsWith("git clone")), []);
});

test("F1: a paste script run in a checkout that is not the named commit's fresh clone, or without its commit, runs nothing", () => {
  const w = world();
  const clone = path.join(w.root, "stale");
  git(w.root, "clone", "-q", w.bare, clone);
  git(clone, "remote", "set-url", "origin", REPO);
  const run = (script, args) => spawnSync("/bin/sh", [path.join(clone, "contracts/vault/scripts/mainnet-money", script), ...args], { encoding: "utf8", env: w.env });
  // HEAD is the card commit, the paste names main's
  git(clone, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", w.K);
  let r = run("1-run.sh", [w.C, "owner.near"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HEAD is [0-9a-f]{40}, not the paste's commit/);
  // the owner's own checkout with an untracked deploy record beside it: refused, and nothing asks to delete it
  git(clone, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", w.C);
  mkdirSync(path.join(clone, "contracts", "pool-evm", "deployments"), { recursive: true });
  writeFileSync(path.join(clone, "contracts", "pool-evm", "deployments", "base.json"), "{}\n");
  r = run("4-sweep-u.sh", [w.C]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /path\(s\) the commit does not hold \(contracts\/pool-evm\)[^]*make a fresh clone/);
  assert.doesNotMatch(r.stderr, /git clean|delete|remove/);
  for (const [script, args] of [["1-run.sh", []], ["1-run.sh", ["owner.near"]], ["2-open-u.sh", []], ["3-record.sh", []], ["4-sweep-u.sh", []]]) {
    r = run(script, args);
    assert.equal(r.status, 1, script);
    assert.match(r.stdout, /paste [1-4]: /, script);
  }
  assert.deepEqual(calls(w), []);
});

test("F3: the record's two files in the run's folder stop no later paste: line 4 after line 3 reaches the driver", () => {
  const w = world();
  assert.equal(paste(w, 3, ` --fund-tx ${"9".repeat(44)} sender.near`).status, 0);
  mkdirSync(w.state, { recursive: true });
  for (const f of ["vault-mainnet-money.run.json", "vault-mainnet-money.md"]) writeFileSync(path.join(w.state, f), "{}\n");
  const r = paste(w, 4);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(calls(w).at(-1), new RegExp(`^${D} sweep-u --commit ${w.C} --state `));
  assert.equal(paste(w, 1).status, 0);
  assert.match(calls(w).at(-1), new RegExp(`^${D} run --commit ${w.C} `));
});

const G = "g-2b700409.bf-vt-20261102t071444.testnet";
const P = "bf-vt-20261102t071444.testnet";
const rehearse = (w, args) => spawnSync("/bin/sh", [path.join(w.src, "contracts/vault/scripts/mainnet-money/rehearse-testnet.sh"), ...args], { encoding: "utf8", timeout: 60_000, env: { ...w.env, TMPDIR: w.root } });
const commitOf = (l) => l.match(/--commit ([0-9a-f]{40})/)?.[1];

test("rehearse-testnet.sh plan: from a fresh clone of this checkout's tree, the run planned and stopped while it waits, then U opened and the named account registered once", () => {
  const w = world({ runExit: 124 });
  const st = `${w.home}/ct-runs/vault-mainnet-money-testnet-clone`;
  const key = `${w.home}/.near-credentials/testnet/${P}.json`;
  const r = rehearse(w, ["plan"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = calls(w);
  const C = commitOf(c[1]);
  assert.ok(C, c.join("\n"));
  const clone = c[0].match(/ @ (.*)$/)[1];
  assert.equal(path.dirname(clone), w.root);
  assert.equal(git(clone, "rev-parse", "HEAD"), C);
  assert.equal(git(clone, "rev-parse", "HEAD^{tree}"), git(w.src, "rev-parse", "HEAD^{tree}"), "the clone's commit holds this checkout's tree");
  const own = spawnSync("git", ["-C", clone, "cat-file", "-e", git(w.src, "rev-parse", "HEAD")], { env: { ...w.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.notEqual(own.status, 0, "only the tree is copied in: the checkout's own commit and its history stay out of the clone");
  const NET = `--network testnet --bind-relayer ${G} --commit ${C} --not-on-main`;
  assert.deepEqual(c.map((l) => l.replace(/ @ .*$/, "")), [
    "pnpm install --frozen-lockfile",
    `timeout 180 ${D} run ${NET} --state ${st} --to ${P}`,
    `${D} open-u ${NET} --state ${st} --payer ${P} --key-file ${key} --register ${P}`,
    `${D} check ${NET} --state ${st} --to ${P}`,
  ]);
  assert.equal(statSync(path.dirname(st)).mode & 0o777, 0o700);
  // a second plan job (its own clone) names the same commit, and after the registration is kept registers nothing again
  mkdirSync(st, { recursive: true });
  writeFileSync(path.join(st, "open-u.json"), JSON.stringify({ txs: [{ what: `storage_deposit of ${P} on bf-usdc-20261101t022248.testnet` }] }));
  writeFileSync(w.log, "");
  assert.equal(rehearse(w, ["plan"]).status, 0);
  assert.ok(!calls(w).some((l) => l.includes("--register")), calls(w).join("\n"));
  assert.equal(commitOf(calls(w)[1]), C);
  assert.notEqual(calls(w)[0].match(/ @ (.*)$/)[1], clone);
});

test("rehearse-testnet.sh plan from a shallow checkout (CI's kind): the clone is whole, with no .git/shallow, and the gate passes it", () => {
  const w = world({ runExit: 124 });
  const shallow = path.join(w.root, "shallow");
  git(w.root, "clone", "-q", "--depth", "1", `file://${w.src}`, shallow);
  assert.ok(existsSync(path.join(shallow, ".git", "shallow")));
  const r = spawnSync("/bin/sh", [path.join(shallow, "contracts/vault/scripts/mainnet-money/rehearse-testnet.sh"), "plan"], { encoding: "utf8", timeout: 60_000, env: { ...w.env, TMPDIR: w.root } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = calls(w);
  const clone = c[0].match(/ @ (.*)$/)[1];
  assert.ok(!existsSync(path.join(clone, ".git", "shallow")));
  assert.equal(git(clone, "rev-parse", "HEAD"), commitOf(c[1]));
  assert.equal(git(clone, "rev-parse", "HEAD^{tree}"), git(shallow, "rev-parse", "HEAD^{tree}"));
});

test("rehearse-testnet.sh plan stops when the run ends before its wait (a refusal): nothing opened", () => {
  const w = world({ runExit: 1 });
  const r = rehearse(w, ["plan"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(calls(w).length, 2);
});

test("rehearse-testnet.sh finish: resume, sweep-u and the record with the funding tx, the record copied back; without it nothing runs", () => {
  const w = world();
  const st = `${w.home}/ct-runs/vault-mainnet-money-testnet-clone`;
  assert.equal(rehearse(w, ["finish"]).status, 1);
  assert.equal(rehearse(w, []).status, 1);
  assert.deepEqual(calls(w), []);
  mkdirSync(st, { recursive: true });
  for (const f of ["vault-mainnet-money.testnet.run.json", "vault-mainnet-money.testnet.md"]) writeFileSync(path.join(st, f), `${f}\n`);
  mkdirSync(path.join(w.src, "scripts", "live-checks"), { recursive: true });
  const r = rehearse(w, ["finish", "9".repeat(44), "sender.testnet"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = calls(w);
  const NET = `--network testnet --bind-relayer ${G} --commit ${commitOf(c[1])} --not-on-main`;
  assert.deepEqual(c.map((l) => l.replace(/ @ .*$/, "")), [
    "pnpm install --frozen-lockfile",
    `${D} resume ${NET} --state ${st} --to ${P}`,
    `${D} sweep-u ${NET} --state ${st}`,
    `${D} record ${NET} --state ${st} --fund-tx ${"9".repeat(44)} sender.testnet`,
  ]);
  for (const f of ["vault-mainnet-money.testnet.run.json", "vault-mainnet-money.testnet.md"]) assert.equal(readFileSync(path.join(w.src, "scripts", "live-checks", f), "utf8"), `${f}\n`);
});

test("no paste names a package runner, a downloaded CLI or a loose state file; pnpm only installs from the lockfile", () => {
  for (const f of readdirSync(DIR)) {
    const s = readFileSync(path.join(DIR, f), "utf8").replace(/^#.*$/gm, "").replace(/(\$\{PNPM:-pnpm\}|pnpm) install --frozen-lockfile/g, "");
    assert.doesNotMatch(s, /npx|npm |pnpm|near-cli|curl|wget|\.u"|\.open-u\.txs|seed-phrase/, f);
  }
});
