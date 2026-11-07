// node --test contracts/vault/scripts/mainnet-money-pastes.test.mjs: the mainnet money run's pastes (mainnet-money/),
// offline. node and npx are stubs put first on PATH: each records its arguments, node answers as the case plants (the
// driver's check line, or reads.mjs's exit), npx writes near-cli-rs's final-command log into its TMPDIR as the real one
// does and prints a Transaction ID. Nothing reaches a network or a key: the key file path is only passed on.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "mainnet-money");
const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), "mainnet-money-pastes-")));
after(() => rmSync(TMP, { recursive: true, force: true }));
const U = "ab".repeat(32);
const line = (o) => JSON.stringify({ vault: "vault.confidential.unrlzd.near", U, ...o });
let n = 0;

// a temp repo-shaped tree holding the pastes, a HOME with the run's folder, and a bin of stubs
function world({ u = U, checks = [], checkExit = 0, feeRc = 0, npxExit = 0, txs = null } = {}) {
  const root = path.join(TMP, String(n++));
  const dir = path.join(root, "contracts", "vault", "scripts", "mainnet-money");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const runs = path.join(home, ".confidential-trenches", "runs");
  const npxTmp = path.join(root, "npx-tmpdirs");
  for (const d of [dir, bin, runs, npxTmp, path.join(root, "contracts", "vault", "scripts", "mainnet-v1")]) mkdirSync(d, { recursive: true });
  for (const f of readdirSync(DIR)) writeFileSync(path.join(dir, f), readFileSync(path.join(DIR, f)));
  const state = path.join(runs, "vault-mainnet-money.json");
  if (u !== null) writeFileSync(`${state}.u`, u + "\n");
  if (txs !== null) writeFileSync(`${state}.open-u.txs`, txs);
  const log = path.join(root, "calls");
  writeFileSync(path.join(root, "checks"), checks.join("\n") + (checks.length ? "\n" : ""));
  const stub = (name, body) => {
    writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  // node: reads.mjs exits feeRc; the driver's check prints the next planted line (the last one again when they run out)
  stub("node", `case "$*" in *reads.mjs*) exit ${feeRc} ;; *" check "*) L=$(head -n 1 "${root}/checks"); [ "$(wc -l < "${root}/checks")" -gt 1 ] && sed -i.bak 1d "${root}/checks"; printf '%s\\n' "$L"; exit ${checkExit} ;; *) exit 0 ;; esac`);
  // npx: as near-cli-rs 0.30.1, its whole final command into $TMPDIR/near-cli-rs-final-command.log; the TMPDIR it saw kept
  stub("npx", `printf '%s\\n' "$TMPDIR" >> "${npxTmp}/seen"; printf '%s\\n' "$*" > "$TMPDIR/near-cli-rs-final-command.log"; [ ${npxExit} = 0 ] || exit ${npxExit}; echo "Transaction ID: ${"7".repeat(44)}"`);
  return { root, dir, bin, home, log, state, npxTmp };
}
const exec = (w, paste, args = []) => spawnSync("/bin/sh", [path.join(w.dir, paste), ...args], { encoding: "utf8", timeout: 30_000, env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.home } });
const calls = (w) => (existsSync(w.log) ? readFileSync(w.log, "utf8").trim().split("\n") : []);
const npxCalls = (w) => calls(w).filter((c) => c.startsWith("npx "));

test("2-open-u.sh without paste 1's U sends nothing", () => {
  const w = world({ u: null });
  const r = exec(w, "2-open-u.sh");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /start paste 1 first/);
  assert.deepEqual(calls(w), []);
});

test("2-open-u.sh with a U that is not a 64-hex implicit id sends nothing", () => {
  const w = world({ u: "vault.confidential.unrlzd.near" });
  const r = exec(w, "2-open-u.sh");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(npxCalls(w), []);
});

test("2-open-u.sh stops with nothing sent when the driver's gate or vault read refuses", () => {
  const w = world({ checks: [""], checkExit: 1 });
  const r = exec(w, "2-open-u.sh");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /refused \(above\): nothing was sent/);
  assert.deepEqual(npxCalls(w), []);
  assert.ok(calls(w).some((c) => c === `node contracts/vault/scripts/mainnet-money.ts check --u ${U}`), calls(w).join("\n"));
});

test("2-open-u.sh opens a new U: 0.01 NEAR and its USDC registration, from KR10's key file, never a typed phrase; no near-cli-rs log survives", () => {
  const w = world({ checks: [line({ u_exists: false, u_registered: false }), line({ u_exists: true, u_registered: true })] });
  const r = exec(w, "2-open-u.sh");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const sent = npxCalls(w);
  assert.equal(sent.length, 2, sent.join("\n"));
  const key = `${w.home}/.confidential-trenches/keys/confidential.unrlzd.near.json`;
  assert.equal(sent[0], `npx --yes near-cli-rs@0.30.1 --quiet tokens confidential.unrlzd.near send-near ${U} 0.01 NEAR network-config mainnet sign-with-access-key-file ${key} send`);
  assert.equal(sent[1], `npx --yes near-cli-rs@0.30.1 --quiet contract call-function as-transaction 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 storage_deposit json-args {"account_id":"${U}","registration_only":true} prepaid-gas 30 Tgas attached-deposit 1250000000000000000000 yoctoNEAR sign-as confidential.unrlzd.near network-config mainnet sign-with-access-key-file ${key} send`);
  assert.ok(!calls(w).some((c) => /seed-phrase/.test(c)), calls(w).join("\n"));
  // near-cli-rs's final-command log went to a private TMPDIR that is gone once the paste exits
  const seen = readFileSync(path.join(w.npxTmp, "seen"), "utf8").trim().split("\n");
  assert.equal(seen.length, 2);
  for (const d of seen) {
    assert.ok(d.length > 0 && !d.startsWith(w.dir), d);
    assert.equal(existsSync(d), false, `${d} survived`);
  }
  assert.equal(readFileSync(`${w.state}.open-u.txs`, "utf8"), `${"7".repeat(44)} confidential.unrlzd.near\n`.repeat(2));
  assert.match(r.stdout, /exists and is registered on USDC on both RPCs/);
});

test("2-open-u.sh sends nothing for a U that exists and is registered", () => {
  const w = world({ checks: [line({ u_exists: true, u_registered: true })] });
  const r = exec(w, "2-open-u.sh");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(npxCalls(w), []);
});

test("2-open-u.sh sends no registration when the token's bounds or U's registration do not read the same on both RPCs", () => {
  const w = world({ checks: [line({ u_exists: true, u_registered: false })], feeRc: 1 });
  const r = exec(w, "2-open-u.sh");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(npxCalls(w), []);
});

test("2-open-u.sh stops at a failed send, its TMPDIR removed", () => {
  const w = world({ checks: [line({ u_exists: false, u_registered: false })], npxExit: 1 });
  const r = exec(w, "2-open-u.sh");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(npxCalls(w).length, 1);
  assert.match(r.stdout, /rerun this paste/);
  for (const d of readFileSync(path.join(w.npxTmp, "seen"), "utf8").trim().split("\n")) assert.equal(existsSync(d), false);
});

test("1-run.sh runs the driver once, with the run's state outside the repo", () => {
  const w = world();
  const r = exec(w, "1-run.sh");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls(w), [`node contracts/vault/scripts/mainnet-money.ts run --state ${w.state}`]);
});

test("3-record.sh passes paste 2's transactions and the named ones to the record", () => {
  const w = world({ txs: `${"8".repeat(44)} confidential.unrlzd.near\n` });
  writeFileSync(w.state, "{}\n");
  const r = exec(w, "3-record.sh", ["--tx", "9".repeat(44), "relay.near"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls(w), [`node contracts/vault/scripts/mainnet-money.ts record --state ${w.state} --tx ${"9".repeat(44)} relay.near --tx ${"8".repeat(44)} confidential.unrlzd.near`]);
});
