// node --test apps/helper/deploy/withdraw-relayer-key.test.mjs: the mainnet relayer key step (card
// helper-mainnet-vault-env). Each test runs the real script on a temp "server": the script under apps/helper/deploy,
// the real mainnet deploy record (or a planted one) under contracts/vault/deployments, and a stub `docker` on PATH that
// logs its arguments and runs this machine's node with what follows the image name, as the image's node would.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { base58decode, relayerKey } from "../src/bind/send.ts";
import { MAINNET_VAULT } from "../src/withdraw/send.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "withdraw-relayer-key.sh");
// the repo's mainnet deploy record by the kit's rule (the script's own): mainnet-v1.json once it exists, else mainnet-test.json
const DEPLOYMENTS = path.join(HERE, "../../../contracts/vault/deployments");
const RECORD = path.join(DEPLOYMENTS, existsSync(path.join(DEPLOYMENTS, "mainnet-v1.json")) ? "mainnet-v1.json" : "mainnet-test.json");
const COMMIT = "a".repeat(40);
const NAMES = ["WITHDRAW_VAULT_MAINNET", "WITHDRAW_RELAYER_MAINNET", "WITHDRAW_FEE_RECIPIENT_MAINNET", "WITHDRAW_RELAYER_KEYS_MAINNET"];

function server({ env = `HELPER_COMMIT=${COMMIT}\nHELPER_RELEASE=3\nJUPITER_API_KEY=test-jupiter-0001\n`, record = readFileSync(RECORD, "utf8") } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "relayer-key-"));
  const deploy = path.join(dir, "apps/helper/deploy");
  mkdirSync(deploy, { recursive: true });
  copyFileSync(SCRIPT, path.join(deploy, "withdraw-relayer-key.sh"));
  chmodSync(path.join(deploy, "withdraw-relayer-key.sh"), 0o755);
  if (record !== null) {
    mkdirSync(path.join(dir, "contracts/vault/deployments"), { recursive: true });
    writeFileSync(path.join(dir, "contracts/vault/deployments", path.basename(RECORD)), record);
  }
  if (env !== null) writeFileSync(path.join(deploy, ".env"), env, { mode: 0o600 });
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const log = path.join(dir, "docker.log");
  // logs every argument but the maker's code, then runs node with the arguments after the image
  writeFileSync(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
a=(); for x in "$@"; do [[ "$x" == "-e" ]] && break; a+=("$x"); done
printf '%s\\n' "\${a[*]}" >> "${log}"
while [[ $# -gt 0 && "$1" != ct-helper:* ]]; do shift; done
[[ "$1" == "ct-helper:${COMMIT}" ]] || exit 125
shift
[[ -n "\${STUB_SLEEP:-}" ]] && sleep "\$STUB_SLEEP"
exec "${process.execPath}" "$@"
`,
    { mode: 0o755 },
  );
  const run = (...args) => spawnSync("bash", [path.join(deploy, "withdraw-relayer-key.sh"), ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const envText = () => readFileSync(path.join(deploy, ".env"), "utf8");
  return { dir, deploy, log, run, envText };
}

const valueOf = (text, name) => text.split("\n").find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1);

test("writes the four mainnet names once, the vault the deploy record's, the key a real ed25519 key of the implicit relayer; prints only public parts", () => {
  const s = server();
  const before = s.envText();
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  const after = s.envText();
  assert.ok(after.startsWith(before), "every line kept, byte for byte, the four added after them");
  for (const n of NAMES) assert.equal(after.split("\n").filter((l) => l.startsWith(`${n}=`)).length, 1, n);
  const record = JSON.parse(readFileSync(RECORD, "utf8"));
  assert.equal(valueOf(after, "WITHDRAW_VAULT_MAINNET"), record.account_id);
  assert.equal(valueOf(after, "WITHDRAW_VAULT_MAINNET"), MAINNET_VAULT, "the one vault the helper carries on mainnet");
  const relayer = valueOf(after, "WITHDRAW_RELAYER_MAINNET");
  assert.match(relayer, /^[0-9a-f]{64}$/);
  assert.equal(valueOf(after, "WITHDRAW_FEE_RECIPIENT_MAINNET"), relayer, "no --fee-recipient: the relayer account");
  const secret = valueOf(after, "WITHDRAW_RELAYER_KEYS_MAINNET");
  const { pub } = relayerKey(secret); // the helper's own parser: 64 bytes, the public half the seed's
  assert.equal(Buffer.from(pub).toString("hex"), relayer, "the relayer is the key's implicit account");
  // the output: the public key and the accounts, never the secret or any part of its seed
  const out = r.stdout + r.stderr;
  const seed = Buffer.from(base58decode(secret.slice(8))).subarray(0, 32);
  assert.ok(!out.includes(secret.slice(8)), "the secret is not printed");
  assert.ok(!out.includes(seed.toString("hex")) && !out.includes(seed.toString("base64")), "the seed is not printed");
  assert.match(out, new RegExp(`relayer account ${relayer}\\n`));
  // the order after the key: redeploy, the owner funds the relayer and registers it on USDC (the fee recipient by default,
  // and fee quotes hold until it is registered: fee.ts readFeeAccount), then the live checks
  const usdc = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // gitleaks:allow (a public account id)
  const order = r.stdout.split("\n").filter((l) => /^withdraw-relayer-key: [1-4]\. /.test(l));
  assert.equal(order.length, 4, r.stdout);
  assert.equal(order[0], "withdraw-relayer-key: 1. apps/helper/deploy/redeploy.sh <this commit>, so the helper starts with the four lines");
  assert.equal(order[1], `withdraw-relayer-key: 2. the owner sends 1 NEAR to ${relayer}`);
  assert.equal(order[2], `withdraw-relayer-key: 3. the owner calls storage_deposit on ${usdc} with {"account_id":"${relayer}","registration_only":true}, attaching 0.00125 NEAR`);
  assert.equal(order[3], "withdraw-relayer-key: 4. once both have landed: the helper's live checks, helper-mainnet-vault-env among them");
  assert.match(out, /public key ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}\n/);
  const printed = out.match(/public key ed25519:([1-9A-HJ-NP-Za-km-z]+)/)[1];
  assert.equal(Buffer.from(base58decode(printed)).toString("hex"), relayer, "the printed public key is the relayer's");
  assert.ok(!readFileSync(s.log, "utf8").includes(secret.slice(8)), "nor in docker's argv");
  // the file stays mode 600 and no temporary file is left beside it
  assert.equal(statSync(path.join(s.deploy, ".env")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(s.deploy).sort(), [".env", "withdraw-relayer-key.sh"]);
  // the image is the deployed one, with no network, read-only
  const call = readFileSync(s.log, "utf8").trim();
  // --log-driver none: the container's stdout carries the secret line, and docker's default json-file driver would keep
  // a copy of it on the server's disk under /var/lib/docker/containers
  assert.match(call, /^run --rm -i --log-driver none --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --entrypoint node ct-helper:a{40} --input-type=module$/);
});

test("two runs make two different keys (each from the system's randomness), and the second is refused with nothing changed", () => {
  const a = server();
  const b = server();
  assert.equal(a.run().status, 0);
  assert.equal(b.run().status, 0);
  assert.notEqual(valueOf(a.envText(), "WITHDRAW_RELAYER_KEYS_MAINNET"), valueOf(b.envText(), "WITHDRAW_RELAYER_KEYS_MAINNET"));
  const before = a.envText();
  const again = a.run();
  assert.equal(again.status, 3);
  assert.match(again.stderr, /WITHDRAW_VAULT_MAINNET is already set in deploy\/.env; nothing changed/);
  assert.equal(a.envText(), before);
});

test("any one of the four names already set, in any form redeploy.sh reads, is refused with nothing changed and no key made", () => {
  for (const n of NAMES) {
    for (const line of [`${n}=x`, `export ${n}=x`, `  ${n} = x`, `${n}=`]) {
      const s = server({ env: `HELPER_COMMIT=${COMMIT}\n${line}\n` });
      const before = s.envText();
      const r = s.run();
      assert.equal(r.status, 3, `${line}: ${r.stderr}`);
      assert.equal(s.envText(), before);
      assert.equal(existsSync(s.log), false, "no key made");
    }
  }
});

test("--fee-recipient names the fee account; one that is not a NEAR account id, or other arguments, are refused", () => {
  const s = server();
  assert.equal(s.run("--fee-recipient", "fees.confidential.unrlzd.near").status, 0);
  assert.equal(valueOf(s.envText(), "WITHDRAW_FEE_RECIPIENT_MAINNET"), "fees.confidential.unrlzd.near");
  for (const args of [["--fee-recipient", "Bad.Near"], ["--fee-recipient", "a"], ["--fee-recipient", "x.near\nWITHDRAW_VAULT_MAINNET=evil.near"], ["--fee-recipient"], ["--other"], ["--fee-recipient", "x.near", "y"], ["--fee-recipient", "intents.near"], ["--fee-recipient", MAINNET_VAULT]]) {
    const t = server();
    const before = t.envText();
    const r = t.run(...args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(t.envText(), before);
  }
});

test("no HELPER_COMMIT, no deploy record, or a record that names no mainnet vault: refused with nothing changed", () => {
  const noCommit = server({ env: "HELPER_RELEASE=3\n" });
  assert.equal(noCommit.run().status, 6);
  assert.equal(noCommit.envText(), "HELPER_RELEASE=3\n");
  const noEnv = server({ env: null });
  assert.equal(noEnv.run().status, 6);
  assert.equal(existsSync(path.join(noEnv.deploy, ".env")), false);
  const noRecord = server({ record: null });
  const before = noRecord.envText();
  assert.equal(noRecord.run().status, 4);
  assert.equal(noRecord.envText(), before);
  const rec = JSON.parse(readFileSync(RECORD, "utf8"));
  for (const bad of [JSON.stringify({ ...rec, network: "testnet" }), JSON.stringify({ ...rec, account_id: "Evil" }), "{not json", JSON.stringify({ network: "mainnet" })]) {
    const s = server({ record: bad });
    const was = s.envText();
    const r = s.run();
    assert.equal(r.status, 4, bad);
    assert.equal(s.envText(), was);
    assert.deepEqual(readdirSync(s.deploy).sort(), [".env", "withdraw-relayer-key.sh"], "no temporary file left");
  }
});

test("a .env whose last line has no newline keeps it whole: the four lines start on their own", () => {
  const s = server({ env: `HELPER_COMMIT=${COMMIT}\nJUPITER_API_KEY=test-jupiter-0001` });
  assert.equal(s.run().status, 0);
  const lines = s.envText().split("\n");
  assert.equal(lines[1], "JUPITER_API_KEY=test-jupiter-0001");
  assert.ok(lines[2].startsWith("WITHDRAW_VAULT_MAINNET="));
});

// card helper-v1-cutover: on the server the checkout is a git checkout, and the printed step 1 names its commit
test("in a git checkout, the printed step 1 names the checkout's commit", () => {
  const s = server();
  const git = (...a) => spawnSync("git", ["-C", s.dir, "-c", "core.hooksPath=/dev/null", "-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("commit", "-q", "--allow-empty", "-m", "t").status, 0);
  const sha = git("rev-parse", "HEAD").stdout.trim();
  assert.match(sha, /^[0-9a-f]{40}$/);
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`withdraw-relayer-key: 1. apps/helper/deploy/redeploy.sh ${sha}, so the helper starts with the four lines\n`), r.stdout);
});

test("once mainnet-v1.json exists the vault is its account_id (the helper's pin rule, send.ts MAINNET_VAULT; the kit's, mainnet-v1.json's or null, meets it there)", () => {
  const s = server();
  const v1 = JSON.stringify({ ...JSON.parse(readFileSync(RECORD, "utf8")), account_id: "vault.confidential.unrlzd.near" });
  writeFileSync(path.join(s.dir, "contracts/vault/deployments/mainnet-v1.json"), v1);
  assert.equal(s.run().status, 0);
  assert.equal(valueOf(s.envText(), "WITHDRAW_VAULT_MAINNET"), "vault.confidential.unrlzd.near");
});

// card helper-sol-fee-payer-mainnet, review FIX 2 (P-twice): two runs at once both passed the "already set" check and
// both renamed, two accounts printed and only the second key kept, so NEAR sent to the first account funded a key
// nobody holds. The three key steps now share deploy/.env.lock from the check through the rename.
test("two runs at once: one writes, the other refuses on the lock (exit 9); one key, one account printed, no lock left", async () => {
  const s = server();
  const runAsync = (extra) =>
    new Promise((ok) => {
      const p = spawn("bash", [path.join(s.deploy, "withdraw-relayer-key.sh")], { env: { ...process.env, PATH: `${path.join(s.dir, "bin")}:${process.env.PATH}`, ...extra } });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (c) => (stdout += c));
      p.stderr.on("data", (c) => (stderr += c));
      p.on("close", (status) => ok({ status, stdout, stderr }));
    });
  const first = runAsync({ STUB_SLEEP: "1.5" });
  await new Promise((ok) => setTimeout(ok, 400));
  const [a, b] = await Promise.all([first, runAsync({})]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 9, b.stderr);
  assert.match(b.stderr, /another key step holds deploy\/\.env\.lock/);
  const env = s.envText();
  assert.equal(env.split("\n").filter((l) => l.startsWith("WITHDRAW_RELAYER_KEYS_MAINNET=")).length, 1);
  const printed = [a, b].flatMap((r) => [...(r.stdout + r.stderr).matchAll(/^withdraw-relayer-key: relayer account ([0-9a-f]{64})$/gm)].map((m) => m[1]));
  assert.deepEqual(printed, [valueOf(env, "WITHDRAW_RELAYER_MAINNET")], "one relayer account printed, the kept key's");
  assert.deepEqual(readdirSync(s.deploy).sort(), [".env", "withdraw-relayer-key.sh"], "no temporary file, no lock left");
});
