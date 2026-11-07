// node --test contracts/vault/scripts/mainnet-v1-pastes.test.mjs: the mainnet vault's pastes (mainnet-v1/), offline.
// gh, node and npx are stubs put first on PATH: each records its arguments and does what the case plants (gh answers the
// run's identity and writes the downloaded wasm, node exits as the case says and prints its lines). Nothing reaches a
// network or a key: the key file path is only passed on.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { MAINNET_PINS } from "./deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "mainnet-v1");
const PIN = JSON.parse(readFileSync(path.join(HERE, "..", "deployments", "mainnet-v1.pin.json"), "utf8"));
const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), "mainnet-v1-pastes-")));
after(() => rmSync(TMP, { recursive: true, force: true }));
const GOOD_RUN = `UNRLZD/confidential-trenches ${PIN.source_commit} .github/workflows/vault-build.yml completed success`;
let n = 0;

// a temp repo-shaped tree holding `paste` at contracts/vault/scripts/mainnet-v1/, with `edit` applied to its text,
// and a bin of stubs; returns its paths
function world(paste, { edit = (s) => s, run = GOOD_RUN, wasm = "not the vault", nodeExit = 0, nodeOut = "", record = false } = {}) {
  const root = path.join(TMP, String(n++));
  const dir = path.join(root, "contracts", "vault", "scripts", "mainnet-v1");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  for (const d of [dir, bin, home, path.join(root, "contracts", "vault", "deployments")]) mkdirSync(d, { recursive: true });
  if (record) writeFileSync(path.join(root, "contracts", "vault", "deployments", "mainnet-v1.json"), "{}\n");
  writeFileSync(path.join(dir, paste), edit(readFileSync(path.join(DIR, paste), "utf8")));
  const log = path.join(root, "calls");
  const stub = (name, body) => {
    writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  writeFileSync(path.join(root, "wasm"), wasm);
  writeFileSync(path.join(root, "node-out"), nodeOut);
  stub("gh", `case "$1" in api) printf '%s\\n' ${JSON.stringify(run)} ;; run) while [ $# -gt 0 ]; do [ "$1" = -D ] && D="$2"; shift; done; cp "${root}/wasm" "$D/blindfill_vault.wasm" ;; esac`);
  stub("node", `cat "${root}/node-out"; exit ${nodeExit}`);
  stub("npx", `echo "Transaction ID: ${"7".repeat(44)}"`);
  return { root, file: path.join(dir, paste), home, bin, log };
}
const exec = (w) => spawnSync("/bin/sh", [w.file], { encoding: "utf8", timeout: 30_000, env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.home } });
const calls = (w) => (existsSync(w.log) ? readFileSync(w.log, "utf8").trim().split("\n") : []);
const sha = (s) => createHash("sha256").update(s).digest("hex");

test("2-deploy.sh pins the run, the commit and the sha256 that mainnet-v1.pin.json and MAINNET_PINS hold, for vault.confidential.unrlzd.near", () => {
  const s = readFileSync(path.join(DIR, "2-deploy.sh"), "utf8");
  const v = (k) => new RegExp(`^${k}=(\\S+)$`, "m").exec(s)?.[1];
  assert.equal(v("RUN"), String(PIN.artifact.run));
  assert.equal(v("REVIEWED"), PIN.source_commit);
  assert.equal(v("PIN"), PIN.wasm_sha256);
  assert.equal(MAINNET_PINS[PIN.account_id], PIN.wasm_sha256);
  assert.match(s, /--parent confidential\.unrlzd\.near \\\n  --vault vault\.confidential\.unrlzd\.near \\\n/);
  assert.match(s, /--deployment contracts\/vault\/deployments\/mainnet-v1\.pin\.json --out contracts\/vault\/deployments\/mainnet-v1\.json\n$/);
});

test("2-deploy.sh refuses a run that is not the reviewed commit's, before any download or deploy", () => {
  const w = world("2-deploy.sh", { run: GOOD_RUN.replace(PIN.source_commit, "f".repeat(40)) });
  const r = exec(w);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /not UNRLZD\/confidential-trenches at e0623bf3\S+, completed and successful: nothing was sent/);
  assert.deepEqual(calls(w).map((c) => c.split(" ").slice(0, 2).join(" ")), ["gh api"]);
});

test("2-deploy.sh refuses a wasm whose sha256 is not the pin, before deploy.mjs runs", () => {
  const w = world("2-deploy.sh", { wasm: "a wasm that is not the pinned build" });
  const r = exec(w);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`hashes to ${sha("a wasm that is not the pinned build")}, not the pin ${PIN.wasm_sha256}: nothing was sent`));
  assert.ok(!calls(w).some((c) => c.startsWith("node ")), calls(w).join("\n"));
});

test("2-deploy.sh with the pin's wasm runs deploy.mjs once, on mainnet, from the pin record to mainnet-v1.json", () => {
  const wasm = "a planted wasm standing in for the pinned build";
  const w = world("2-deploy.sh", { wasm, edit: (s) => s.replace(/^PIN=.*$/m, `PIN=${sha(wasm)}`) });
  const r = exec(w);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const node = calls(w).filter((c) => c.startsWith("node "));
  assert.equal(node.length, 1);
  assert.match(node[0], new RegExp(`^node contracts/vault/scripts/deploy\\.mjs --network mainnet --parent confidential\\.unrlzd\\.near --vault vault\\.confidential\\.unrlzd\\.near --key-file ${w.home}/\\.confidential-trenches/keys/confidential\\.unrlzd\\.near\\.json --wasm \\S+/blindfill_vault\\.wasm --deployment contracts/vault/deployments/mainnet-v1\\.pin\\.json --out contracts/vault/deployments/mainnet-v1\\.json$`));
});

test("3-readback-write.sh signs nothing without mainnet-v1.json, or when the check's reads do not pass", () => {
  const none = world("3-readback-write.sh", { nodeExit: 3 });
  let r = exec(none);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no contracts\/vault\/deployments\/mainnet-v1\.json: run paste 2 first; nothing was signed/);
  assert.deepEqual(calls(none), []);
  const failed = world("3-readback-write.sh", { nodeExit: 1, record: true, nodeOut: "live-check vault-mainnet: FAIL\n" });
  r = exec(failed);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /the reads did not pass \(exit 1\): nothing was signed/);
  assert.ok(!calls(failed).some((c) => c.startsWith("npx ")));
});

test("3-readback-write.sh sends the printed storage_prepay once, then reads it back by its id and records the answer", () => {
  const line = `near call vault.confidential.unrlzd.near storage_prepay '{"precommitment":"12345"}' --useAccount confidential.unrlzd.near --depositYocto 7560000000000000000000 --gas 30000000000000 --networkId mainnet`;
  const w = world("3-readback-write.sh", { nodeExit: 3, record: true, nodeOut: `${line}\n` });
  exec(w);
  const c = calls(w);
  assert.equal(c[0], "node scripts/live-checks/vault-mainnet-deploy.mjs");
  assert.equal(c[1], `npx --yes near-cli-rs@0.30.1 contract call-function as-transaction vault.confidential.unrlzd.near storage_prepay json-args {"precommitment":"12345"} prepaid-gas 30 Tgas attached-deposit 7560000000000000000000 yoctoNEAR sign-as confidential.unrlzd.near network-config mainnet sign-with-access-key-file ${w.home}/.confidential-trenches/keys/confidential.unrlzd.near.json send`);
  assert.equal(c[2], `node scripts/live-checks/vault-mainnet-deploy.mjs --precommitment 12345 --tx ${"7".repeat(44)} --record scripts/live-checks/vault-mainnet-deploy.answers.json`);
});

test("4-fee-recipient.sh registers fees.unrlzd.near only, with exactly USDC's 0.00125 N bound, from the parent's key file", () => {
  const s = readFileSync(path.join(DIR, "4-fee-recipient.sh"), "utf8");
  assert.match(s, /^FEES=fees\.unrlzd\.near$/m);
  assert.match(s, /^MIN=1250000000000000000000$/m);
  assert.match(s, /^USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1$/m);
  assert.equal(PIN.asset, "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
  const w = world("4-fee-recipient.sh", { nodeExit: 1 });
  const r = exec(w);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /the reads did not pass \(exit 1\): nothing was sent/);
  assert.ok(!calls(w).some((c) => c.startsWith("npx ")));
});

test("1-fund-parent.sh sends 2 NEAR from unrlzd.near to confidential.unrlzd.near only, with near-cli-rs's log kept in a private TMPDIR", () => {
  const s = readFileSync(path.join(DIR, "1-fund-parent.sh"), "utf8");
  assert.match(s, /TMPDIR="\$PRIV" npx --yes near-cli-rs@0\.30\.1 --quiet tokens unrlzd\.near send-near confidential\.unrlzd\.near '2 NEAR' \\\n  network-config mainnet sign-with-seed-phrase\n/);
  const w = world("1-fund-parent.sh");
  const r = exec(w);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(calls(w).length, 1);
  assert.match(r.stdout, /Press Cmd-K now to clear this window/);
});
