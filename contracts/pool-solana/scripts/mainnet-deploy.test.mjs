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
function runPaste(args, { system = "Darwin", machine = "arm64" } = {}) {
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
  stub("node", "exit 0");
  const r = spawnSync("sh", [PASTE, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: stubs, TMPDIR: stubs } });
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  const outs = existsSync(`${log}.out`) ? readFileSync(`${log}.out`, "utf8").trim().split("\n") : [];
  rmSync(stubs, { recursive: true, force: true });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls, outs };
}

test("no return address: the usage line, nothing fetched or run", () => {
  for (const args of [[], [RETURN, "extra"], [RETURN, "--other", "x"], [RETURN, "--program", "x", "y"]]) {
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
  assert.match(code, /^if \[ \$# -ne 1 \] && \{ \[ \$# -ne 3 \] \|\| \[ "\$2" != "--program" \]; \}; then$/m);
  assert.match(code, /^CI_RUN=42012187381$/m);
  assert.match(code, /node scripts\/live-checks\/pool-sol-deploy-mainnet.mjs --record scripts\/live-checks\/pool-sol-deploy-mainnet.good.json --write-record/);
  // no prompt: neither the paste nor the deploy script reads a terminal or stdin
  assert.doesNotMatch(code, /\bread\b|\/dev\/tty|stty/);
  const deploy = readFileSync(path.join(HERE, "deploy.mjs"), "utf8");
  assert.doesNotMatch(deploy, /process\.stdin|readline|\/dev\/tty/);
});
