// SPDX-License-Identifier: Apache-2.0
// The owner's mainnet paste (mainnet-deploy.sh, card pool-sol-deploy-mainnet) run on stubs: uname, curl and node are
// planted first on PATH, so nothing is fetched and nothing is deployed. It refuses before deploy.mjs runs when no return
// address is given, on a machine that is not a Mac, and when the CLI download is not the pinned bytes, and it removes its
// download folder each time. It reads no secret: nothing in it or in deploy.mjs reads a prompt or stdin, and it runs
// with stdin closed.
//   node --test contracts/pool-solana/scripts/mainnet-deploy.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PASTE = path.join(HERE, "mainnet-deploy.sh");
const RETURN = "CTnQzcmRUwDYkBx9cuyfcAidQZ6ogo27uGmWFEUyQGvb";

/** Runs the paste with stubs first on PATH; returns its exit, output and what each stub saw. */
function runPaste(args, { system = "Darwin", machine = "arm64", pinned = null } = {}) {
  const stubs = mkdtempSync(path.join(tmpdir(), "paste-stubs-"));
  const log = path.join(stubs, "calls.log");
  writeFileSync(log, "");
  const stub = (name, body) => {
    writeFileSync(path.join(stubs, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(path.join(stubs, name), 0o755);
  };
  stub("uname", `[ "$1" = "-s" ] && echo ${system}; [ "$1" = "-m" ] && echo ${machine}; exit 0`);
  // the download: junk bytes at -o's path (never the pinned release)
  stub("curl", `while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { echo not-the-release > "$2"; echo "$2" >> "${log}.out"; }; shift; done; exit 0`);
  // node: says whether the pinned CLI is first on its PATH
  stub("node", `echo "node-solana $(command -v solana)" >> "${log}"; exit 0`);
  if (pinned) {
    // the pinned release, planted: shasum answers the pin, tar unpacks a solana that answers 4.4.0
    stub("shasum", `echo "${pinned}  $3"`);
    stub("tar", `while [ $# -gt 0 ]; do [ "$1" = "-C" ] && D="$2"; shift; done; mkdir -p "$D/solana-release/bin"; printf '#!/bin/sh\necho "solana-cli 4.4.0 (src:9ef63128; feat:1, client:Agave)"\n' > "$D/solana-release/bin/solana"; chmod 755 "$D/solana-release/bin/solana"`);
  }
  const r = spawnSync("sh", [PASTE, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: stubs, TMPDIR: stubs } });
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  const outs = existsSync(`${log}.out`) ? readFileSync(`${log}.out`, "utf8").trim().split("\n") : [];
  rmSync(stubs, { recursive: true, force: true });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls, outs };
}

test("no return address: the usage line, nothing fetched or run", () => {
  for (const args of [[], [RETURN, "extra"], [RETURN, "--other", "x"], [RETURN, "--program", "x", "y"], ["--program", "x", "y"], ["--sweep-kept", "--program", "x"], ["--sweep-kept", "-x"]]) {
    const r = runPaste(args);
    assert.equal(r.status, 1);
    assert.match(r.out, /^usage: sh contracts\/pool-solana\/scripts\/mainnet-deploy.sh <your Solana address/);
    assert.deepEqual(r.calls, []);
  }
});

test("not a Mac: refused before any fetch", () => {
  const r = runPaste([RETURN], { system: "Linux", machine: "x86_64" });
  assert.equal(r.status, 1);
  assert.match(r.out, /this paste runs on a Mac .* not Linux x86_64: nothing was fetched or sent/);
  assert.ok(!r.calls.some((c) => /^(curl|node) /.test(c)), r.calls.join("\n"));
});

test("a CLI download that is not the pinned bytes is refused before deploy.mjs runs, and the download folder is removed", () => {
  for (const [machine, pin] of [["arm64", "7f54760a17ccc51b9aee2e019ef1f841a06edfaa8104ba30f94a877ceec0e8e0"], ["x86_64", "d072e2cfcebda282041e7878ea1c2029eb5cff9c777ea1b1953e5c98148bc85f"]]) {
    const r = runPaste([RETURN], { machine });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp(`has sha256 [0-9a-f]{64}, not the pinned ${pin}: nothing was sent`));
    assert.ok(r.calls.some((c) => c.startsWith("curl ") && c.includes("https://github.com/anza-xyz/agave/releases/download/v4.4.0/solana-release-")), r.calls.join("\n"));
    assert.ok(!r.calls.some((c) => c.startsWith("node ")), "deploy.mjs never ran");
    assert.equal(r.outs.length, 1);
    assert.equal(existsSync(r.outs[0]), false, "the download folder is gone");
  }
});

test("the paste runs deploy.mjs on mainnet with CI run 42012187381's build into deployments/mainnet.json, then records the live check; it reads no secret", () => {
  const sh = readFileSync(PASTE, "utf8");
  const code = sh.split("\n").filter((l) => !l.startsWith("#")).join("\n");
  assert.match(code, /node contracts\/pool-solana\/scripts\/deploy.mjs --mainnet --url https:\/\/api.mainnet-beta.solana.com \\\n {2}--ci-run "\$CI_RUN" --return "\$RETURN" --out contracts\/pool-solana\/deployments\/mainnet.json "\$@"$/m);
  // after the address, only a resume's --program <id> passes through
  assert.match(code, /^ {2}\*\) if \[ \$# -eq 1 \] \|\| \{ \[ \$# -eq 3 \] && \[ "\$2" = "--program" \]; \}; then FORM=deploy; fi ;;$/m);
  assert.match(code, /^CI_RUN=42012187381$/m);
  assert.match(code, /node scripts\/live-checks\/pool-sol-deploy-mainnet.mjs --record scripts\/live-checks\/pool-sol-deploy-mainnet.good.json --write-record/);
  // no prompt: neither the paste nor the deploy script reads a terminal or stdin
  assert.doesNotMatch(code, /\bread\b|\/dev\/tty|stty/);
  const deploy = readFileSync(path.join(HERE, "deploy.mjs"), "utf8");
  assert.doesNotMatch(deploy, /process\.stdin|readline|\/dev\/tty/);
});

const PIN_ARM = "7f54760a17ccc51b9aee2e019ef1f841a06edfaa8104ba30f94a877ceec0e8e0";
const nodeRuns = (r) => r.calls.filter((c) => c.startsWith("node ")).map((c) => c.slice(5));
const DEPLOY = "contracts/pool-solana/scripts/deploy.mjs --mainnet --url https://api.mainnet-beta.solana.com";

test("review 4: the paste's --sweep-kept form sweeps the paste's journal with the pinned CLI on PATH, --return only when given, and records nothing", () => {
  const r = runPaste(["--sweep-kept"], { pinned: PIN_ARM });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(nodeRuns(r), [`${DEPLOY} --sweep-kept contracts/pool-solana/deployments/mainnet.journal.json`]);
  assert.match(r.calls.find((c) => c.startsWith("node-solana ")), /\/solana-release\/bin\/solana$/);
  const r2 = runPaste(["--sweep-kept", RETURN], { pinned: PIN_ARM });
  assert.deepEqual(nodeRuns(r2), [`${DEPLOY} --sweep-kept contracts/pool-solana/deployments/mainnet.journal.json --return ${RETURN}`]);
  for (const args of [["--sweep-kept", RETURN, "x"], ["--sweep-kept", "--program", "x"]]) assert.equal(runPaste(args, { pinned: PIN_ARM }).status, 1);
});

test("review 5: the paste's resume form passes --program <id> to deploy.mjs on the paste's own record, then records the live check", () => {
  const r = runPaste([RETURN, "--program", "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"], { pinned: PIN_ARM });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(nodeRuns(r), [
    `${DEPLOY} --ci-run 42012187381 --return ${RETURN} --out contracts/pool-solana/deployments/mainnet.json --program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`,
    "scripts/live-checks/pool-sol-deploy-mainnet.mjs --record scripts/live-checks/pool-sol-deploy-mainnet.good.json --write-record",
  ]);
});
