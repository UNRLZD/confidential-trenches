// The owner's mainnet paste, three findings of the review of main 63c90229 (card evm-paste-fold):
//   - a closed terminal: script/deploy.mjs's own CLI, in a real terminal (a pty) on a mock chain
//     (test/closed-terminal-chain.mjs); the terminal is closed during the run, and the run still stops and sweeps
//   - forge-std not set up (a clone made without --recurse-submodules): forgeStdReady sets it up at its pin, on real git
//   - a checkout that is not main's code: mainCheckout refuses it, on real git, with nothing sent
//   node --test contracts/pool-evm/test/paste-fold.test.mjs     (after a forge build: the mock chain reads out/)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DUST } from "../../../scripts/live-checks/pool-evm-deploy.mjs";
import { FORGE_STD, FORGE_STD_FIX, forgeStdReady, mainCheckout } from "../script/deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY = path.join(HERE, "../script/deploy.mjs");
const E = "0x49f2425b7f33f3a10912de8add6839226ce663a2"; // a stand-in return address with no code
const TMP = mkdtempSync(path.join(tmpdir(), "pool-evm-paste-fold-"));

// Runs argv in a new pty (its session's terminal), passing its output through until a line starts with `mark`, then
// closes the terminal and sends SIGHUP, as a shell does to its jobs when its window closes; prints the exit status, or
// "hung" for a run still going 30 s later (killed then). At main 63c90229 the run never swept: on macOS the stop's
// first line opened stderr only then, and node's open of the gone terminal hung (sampled: uv_tty_init); with stderr
// opened earlier, a write to the gone terminal fails (EIO) and nothing heard that error, which ends the process
const PTY = `
import json, os, pty, signal, sys, time
mark = sys.argv[1].encode()
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
seen, buf, end = False, b"", time.time() + 90
while time.time() < end:
    try:
        b = os.read(fd, 4096)
    except OSError:
        break
    if not b:
        break
    buf += b
    if mark in buf:
        seen = True
        break
os.close(fd)
os.kill(pid, signal.SIGHUP)
code, end = "hung", time.time() + 30
while time.time() < end:
    done, st = os.waitpid(pid, os.WNOHANG)
    if done:
        code = os.waitstatus_to_exitcode(st)
        break
    time.sleep(0.1)
if code == "hung":
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
print(json.dumps({"seen": seen, "code": code, "out": buf.decode("utf8", "replace")[-2000:]}))
`;

test("a terminal closed during the run: the run stops at its next step and sweeps the run key back, and exits as a stopped run (2), never on a write to the gone terminal", { timeout: 180_000 }, () => {
  const state = path.join(TMP, "state.json");
  const out = path.join(TMP, "record.json");
  const r = spawnSync("python3", ["-c", PTY, "deploy: WithdrawalVerifier 0x", process.execPath, "--import", path.join(HERE, "closed-terminal-chain.mjs"), DEPLOY, "--chain", "base-sepolia", "--rpc", "https://mock.invalid", "--return", E, "--out", out, "--no-build"], {
    encoding: "utf8",
    env: { ...process.env, CT_STATE: state, CT_RETURN: E },
    timeout: 170_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.ok(p.seen, "the first deploy's line reached the terminal\n" + p.out);
  const s = JSON.parse(readFileSync(state, "utf8"));
  const why = `\n${JSON.stringify(s)}\nexit ${p.code}\n${p.out}`;
  assert.equal(p.code, 2, "a stopped run's exit (deploy: ERROR), not a hang or an unheard write error's 1" + why);
  const swept = s.landed.filter((x) => x.to?.toLowerCase() === E && BigInt(x.value) > 0n);
  assert.ok(swept.length >= 1, "a sweep landed at the return address" + why);
  assert.ok(BigInt(s.key) <= DUST, `the run key keeps ${s.key} wei` + why);
  // the deploy under way when the terminal closed may still be sent; none after it
  assert.ok(s.landed.filter((x) => x.to === null).length < 5, "the run stopped before its last deploy" + why);
  const rec = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(rec.txs.length, s.landed.length, "the record lists every landed transaction" + why);
  assert.equal(rec.txs[0].step, "deploy WithdrawalVerifier", why);
  assert.equal(rec.txs.at(-1).step, "sweep (the run key's rest back)", why);
});

// ---- real git: a repository standing in for origin, and a clone of it standing in for the owner's folder ----
const sh = (cwd, ...a) => {
  const r = spawnSync("git", ["-c", "protocol.file.allow=always", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const gitIn = (dir) => (...a) => spawnSync("git", ["-C", dir, "-c", "protocol.file.allow=always", ...a], { encoding: "utf8" });
const put = (dir, f, text) => (mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), writeFileSync(path.join(dir, f), text));
/** origin (a bare repository) with forge-std's stand-in as the submodule at FORGE_STD, and a clone without it set up */
function repos() {
  const d = mkdtempSync(path.join(TMP, "git-"));
  const std = path.join(d, "forge-std");
  mkdirSync(std);
  sh(std, "init", "-q");
  put(std, "src/console.sol", "// forge-std's stand-in\n");
  sh(std, "add", "src/console.sol");
  sh(std, "commit", "-q", "-m", "v1");
  const pin = sh(std, "rev-parse", "HEAD");
  put(std, "src/console.sol", "// a later forge-std\n");
  sh(std, "commit", "-q", "-am", "v2");
  const work = path.join(d, "work");
  mkdirSync(work);
  sh(work, "init", "-q");
  put(work, "contracts/pool-evm/script/deploy.mjs", "// deploy\n");
  put(work, "packages/kit/src/index.ts", "// kit\n");
  put(work, "README.md", "# readme\n");
  sh(work, "submodule", "add", "-q", std, FORGE_STD);
  sh(path.join(work, FORGE_STD), "checkout", "-q", pin);
  sh(work, "add", "--", ".gitmodules", FORGE_STD, "contracts", "packages", "README.md");
  sh(work, "commit", "-q", "-m", "first");
  const origin = path.join(d, "origin.git");
  sh(d, "clone", "-q", "--bare", work, origin);
  const clone = path.join(d, "clone");
  sh(d, "clone", "-q", origin, clone);
  return { d, std, pin, work, origin, clone };
}

test("forge-std not set up (a clone made without --recurse-submodules): forgeStdReady sets it up at its pinned commit itself, saying the line it runs", () => {
  const { clone, pin } = repos();
  assert.ok(!existsSync(path.join(clone, FORGE_STD, "src/console.sol")), "the clone has forge-std empty, as the owner's folder has it");
  const lines = [];
  forgeStdReady({ git: gitIn(clone), log: (l) => lines.push(l) });
  assert.equal(readFileSync(path.join(clone, FORGE_STD, "src/console.sol"), "utf8"), "// forge-std's stand-in\n");
  assert.equal(sh(path.join(clone, FORGE_STD), "rev-parse", "HEAD"), pin);
  assert.deepEqual(lines, [`deploy: ${FORGE_STD} is not set up: ${FORGE_STD_FIX} (its pinned commit)`]);
  // set up: nothing to do, nothing said
  forgeStdReady({ git: gitIn(clone), log: (l) => lines.push(l) });
  assert.equal(lines.length, 1);
});

test("forge-std at another commit is refused naming the fix line, and left where it is; an init that fails is refused as itself", () => {
  const { clone, pin } = repos();
  sh(clone, "submodule", "update", "--init", "-q");
  sh(path.join(clone, FORGE_STD), "checkout", "-q", "main");
  assert.throws(() => forgeStdReady({ git: gitIn(clone), log: () => {} }), (e) => e.message === `${FORGE_STD} is not set up at its pinned commit, so forge cannot build: nothing was sent; run ${FORGE_STD_FIX} here, then run the deploy again`);
  assert.notEqual(sh(path.join(clone, FORGE_STD), "rev-parse", "HEAD"), pin, "never moved here");
  // the submodule's source gone (no network): the init fails, and the refusal says so
  const r2 = repos();
  rmSync(r2.std, { recursive: true, force: true });
  assert.throws(() => forgeStdReady({ git: gitIn(r2.clone), log: () => {} }), (e) => e.message.startsWith(`${FORGE_STD_FIX} failed (`) && e.message.endsWith("nothing was sent; run it here once it works, then run the deploy again"));
});

test("mainCheckout: a clone at origin/main passes, its record folder aside; an edit, a file git does not track in the deploy's paths, or a commit behind or apart from main is refused with nothing sent", () => {
  const { work, origin, clone } = repos();
  const git = gitIn(clone);
  mainCheckout({ git });
  // the run's own output: a record and a journal not committed, then the record committed here and not yet on main
  put(clone, "contracts/pool-evm/deployments/base.json", "{}\n");
  put(clone, "contracts/pool-evm/deployments/base.journal.json", "{}\n");
  mainCheckout({ git });
  sh(clone, "add", "contracts/pool-evm/deployments/base.json");
  sh(clone, "commit", "-q", "-m", "the record");
  mainCheckout({ git });
  // an edit to a file the run runs, staged or not
  put(clone, "contracts/pool-evm/script/deploy.mjs", "// changed\n");
  assert.throws(() => mainCheckout({ git }), (e) => e.message === "this folder has changes main lacks (contracts/pool-evm/script/deploy.mjs): the paste runs main's code only: nothing was sent; put those files back as main has them (git status lists them), then run the paste again");
  sh(clone, "add", "contracts/pool-evm/script/deploy.mjs");
  assert.throws(() => mainCheckout({ git }), /changes main lacks \(contracts\/pool-evm\/script\/deploy\.mjs\)/);
  sh(clone, "checkout", "-q", "HEAD", "--", "contracts/pool-evm/script/deploy.mjs");
  mainCheckout({ git });
  // a file git does not track where the run could load it; elsewhere it is not the run's
  put(clone, "packages/kit/src/extra.ts", "// stray\n");
  assert.throws(() => mainCheckout({ git }), /changes main lacks \(packages\/kit\/src\/extra\.ts\)/);
  sh(clone, "clean", "-q", "-f", "--", "packages/kit/src/extra.ts");
  put(clone, "notes.txt", "mine\n");
  mainCheckout({ git });
  // main moved on: behind it is refused with the pull line
  put(work, "packages/kit/src/index.ts", "// kit v2\n");
  sh(work, "commit", "-q", "-am", "kit v2");
  sh(work, "push", "-q", origin, "main");
  assert.throws(() => mainCheckout({ git }), (e) => e.message === "this folder is not at origin/main (files that differ: packages/kit/src/index.ts): the paste runs main's code only: nothing was sent; run git pull --ff-only origin main here, then run the paste again");
  sh(clone, "pull", "-q", "--no-rebase", "origin", "main");
  mainCheckout({ git });
  // a commit of its own (not the record) is refused too
  put(clone, "README.md", "# mine\n");
  sh(clone, "commit", "-q", "-am", "mine");
  assert.throws(() => mainCheckout({ git }), /not at origin\/main \(files that differ: README\.md\)/);
});

test("mainCheckout: a fetch that fails is refused as itself, nothing sent", () => {
  assert.throws(() => mainCheckout({ git: (cmd) => ({ status: cmd === "fetch" ? 1 : 0, stdout: "" }) }), (e) => /^git fetch origin main failed, so main's code could not be read: nothing was sent/.test(e.message));
  assert.throws(() => mainCheckout({ git: (cmd) => ({ status: cmd === "ls-files" ? 128 : 0, stdout: "" }) }), (e) => e.message === "this folder could not be compared with origin/main: nothing was sent");
});
