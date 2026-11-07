// node --test apps/helper/deploy/bind-relayer-key.test.mjs: the mainnet deposit carry's key step (card
// helper-bind-relayer-mainnet). Each test runs the real script on a temp "server": the script under apps/helper/deploy, a
// planted mainnet-v1.json under contracts/vault/deployments (the vault this checkout's image carries, send.ts
// MAINNET_VAULT, unless a test plants another), and a stub `docker` on PATH that logs its arguments and runs this
// machine's node from apps/helper with what follows the image name, as the image's node runs from its WORKDIR
// /app/apps/helper. With PLANT_OUT set, the stub prints that file instead: a maker gone wrong.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { base58 } from "../src/bind/checks.ts";
import { base58decode, relayerKey } from "../src/bind/send.ts";
import { bindSenderFromEnv } from "../src/bind/env.ts";
import { MAINNET_VAULT } from "../src/withdraw/send.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, "..");
const SCRIPT = path.join(HERE, "bind-relayer-key.sh");
const TEST_RECORD = path.join(HERE, "../../../contracts/vault/deployments/mainnet-test.json");
const COMMIT = "a".repeat(40);
const NAMES = ["BIND_VAULT_MAINNET", "BIND_RELAYER_MAINNET", "BIND_RELAYER_KEY_MAINNET"];
/** A deploy record for the vault this checkout carries: mainnet-test.json's fields, MAINNET_VAULT's account. */
const RECORD = JSON.stringify({ ...JSON.parse(readFileSync(TEST_RECORD, "utf8")), account_id: MAINNET_VAULT });
const BASE_ENV = `HELPER_COMMIT=${COMMIT}\nHELPER_RELEASE=3\nBIND_MARGIN_K=60\nJUPITER_API_KEY=test-jupiter-0001\n`;

/** A fresh ed25519 key as the helper reads it, from this run's randomness (no key in the tree). */
function freshKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return { key: `ed25519:${base58(Buffer.concat([seed, pub]))}`, account: pub.toString("hex"), seed };
}

function server({ env = BASE_ENV, record = RECORD } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "bind-key-"));
  const deploy = path.join(dir, "apps/helper/deploy");
  mkdirSync(deploy, { recursive: true });
  copyFileSync(SCRIPT, path.join(deploy, "bind-relayer-key.sh"));
  chmodSync(path.join(deploy, "bind-relayer-key.sh"), 0o755);
  mkdirSync(path.join(dir, "contracts/vault/deployments"), { recursive: true });
  // the test record is always there: the step must never fall back to it
  copyFileSync(TEST_RECORD, path.join(dir, "contracts/vault/deployments/mainnet-test.json"));
  if (record !== null) writeFileSync(path.join(dir, "contracts/vault/deployments/mainnet-v1.json"), record);
  if (env !== null) writeFileSync(path.join(deploy, ".env"), env, { mode: 0o600 });
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const log = path.join(dir, "docker.log");
  // logs every argument but the maker's code, then runs node from apps/helper with the arguments after the image
  writeFileSync(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
a=(); for x in "$@"; do [[ "$x" == "-e" ]] && break; a+=("$x"); done
printf '%s\\n' "\${a[*]}" >> "${log}"
while [[ $# -gt 0 && "$1" != ct-helper:* ]]; do shift; done
[[ "$1" == "ct-helper:${COMMIT}" ]] || exit 125
shift
if [[ -n "\${PLANT_OUT:-}" ]]; then cat > /dev/null; cat "$PLANT_OUT"; exit 0; fi
cd "${HELPER}"
exec "${process.execPath}" "$@"
`,
    { mode: 0o755 },
  );
  // `extra` sets names in the script's shell; a name set to undefined is removed from it
  const shellOf = (extra) => {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
    return env;
  };
  const run = (extra = {}, ...args) => spawnSync("bash", [path.join(deploy, "bind-relayer-key.sh"), ...args], { encoding: "utf8", env: shellOf(extra) });
  // the script under bash -x, as an operator tracing it would run it: every command bash runs is echoed on stderr
  const runTraced = (extra = {}) => spawnSync("bash", ["-x", path.join(deploy, "bind-relayer-key.sh")], { encoding: "utf8", env: shellOf(extra) });
  const envText = () => readFileSync(path.join(deploy, ".env"), "utf8");
  const plant = (text) => {
    const f = path.join(dir, "plant.out");
    writeFileSync(f, text);
    return { PLANT_OUT: f };
  };
  return { dir, deploy, log, run, runTraced, envText, plant };
}

const valueOf = (text, name) => text.split("\n").find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1);
const files = (s) => readdirSync(s.deploy).sort();

test("writes the three mainnet names once: the vault mainnet-v1.json's, the key a real ed25519 key of the implicit gas account; prints only public parts; the helper starts with them", () => {
  const s = server();
  const before = s.envText();
  const inode = statSync(path.join(s.deploy, ".env")).ino;
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  const after = s.envText();
  // review FIX 4: deploy/.env is replaced by one rename of a whole new file (a new inode), never rewritten in place, so
  // a run killed half way leaves the old file whole (with the withdraw relayer's funded key in it)
  assert.notEqual(statSync(path.join(s.deploy, ".env")).ino, inode, "deploy/.env replaced by a rename, not written in place");
  assert.ok(after.startsWith(before), "every line kept, byte for byte, the three added after them");
  for (const n of NAMES) assert.equal(after.split("\n").filter((l) => l.startsWith(`${n}=`)).length, 1, n);
  assert.equal(valueOf(after, "BIND_VAULT_MAINNET"), MAINNET_VAULT);
  const account = valueOf(after, "BIND_RELAYER_MAINNET");
  assert.match(account, /^[0-9a-f]{64}$/);
  const secret = valueOf(after, "BIND_RELAYER_KEY_MAINNET");
  assert.equal(Buffer.from(relayerKey(secret).pub).toString("hex"), account, "the gas account is the key's implicit account");
  // the helper's own start takes the three lines (bind/env.ts: the pin, the key's form, the margin and store set)
  const helperEnv = Object.fromEntries(after.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const sender = bindSenderFromEnv({ ...helperEnv, HELPER_STORE_DIR: mkdtempSync(path.join(tmpdir(), "bind-key-store-")) }, {}, async () => { throw new Error("no network in this test"); });
  assert.deepEqual(sender.carried?.(), { mainnet: account });
  sender.stop();
  // the output: the public key and the accounts, never the secret or any part of its seed
  const out = r.stdout + r.stderr;
  const seed = Buffer.from(base58decode(secret.slice(8))).subarray(0, 32);
  assert.ok(!out.includes(secret.slice(8)), "the secret is not printed");
  assert.ok(!out.includes(seed.toString("hex")) && !out.includes(seed.toString("base64")) && !out.includes(base58(seed)), "the seed is not printed");
  assert.ok(!readFileSync(s.log, "utf8").includes(secret.slice(8)), "nor in docker's argv");
  assert.match(out, new RegExp(`gas account ${account}\\n`));
  const printed = out.match(/public key ed25519:([1-9A-HJ-NP-Za-km-z]+)/)[1];
  assert.equal(Buffer.from(base58decode(printed)).toString("hex"), account, "the printed public key is the gas account's");
  const order = r.stdout.split("\n").filter((l) => /^bind-relayer-key: [1-3]\. /.test(l));
  assert.deepEqual(order, [
    "bind-relayer-key: 1. apps/helper/deploy/redeploy.sh <this commit>, so the helper starts with the three lines",
    `bind-relayer-key: 2. the owner sends 1 NEAR to ${account}`,
    "bind-relayer-key: 3. once it has landed: the helper's live checks, helper-bind-relayer-mainnet among them",
  ]);
  // the file stays mode 600 and no temporary file is left beside it
  assert.equal(statSync(path.join(s.deploy, ".env")).mode & 0o777, 0o600);
  assert.deepEqual(files(s), [".env", "bind-relayer-key.sh"]);
  // the image is the deployed one, with no network, read-only, and docker keeps no log of the secret line
  assert.match(readFileSync(s.log, "utf8").trim(), /^run --rm -i --log-driver none --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --entrypoint node ct-helper:a{40} --input-type=module$/);
});

test("planted: a second run, or any of the three names already set in any form redeploy.sh reads, is refused with nothing changed and no key made", () => {
  const a = server();
  assert.equal(a.run().status, 0);
  const before = a.envText();
  const again = a.run();
  assert.equal(again.status, 3);
  assert.match(again.stderr, /BIND_VAULT_MAINNET is already set in deploy\/.env; nothing changed/);
  assert.equal(a.envText(), before, "the existing key line is never overwritten");
  for (const n of NAMES) {
    for (const line of [`${n}=x`, `export ${n}=x`, `  ${n} = x`, `${n}=`]) {
      const s = server({ env: `${BASE_ENV}${line}\n` });
      const was = s.envText();
      const r = s.run();
      assert.equal(r.status, 3, `${line}: ${r.stderr}`);
      assert.equal(s.envText(), was);
      assert.equal(existsSync(s.log), false, "no key made");
    }
  }
});

// review FIX 3: an operator may trace the script with bash -x, which echoes every command with its expanded words; no
// key may reach that trace, neither a new one (never held in a shell variable) nor one already in deploy/.env (the
// exit-3 check never captures the line it finds)
test("under bash -x: a fresh run and every exit-3 refusal print no key text", () => {
  const s = server();
  const r = s.runTraced();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^\+ /m, "the run was traced");
  const secret = valueOf(s.envText(), "BIND_RELAYER_KEY_MAINNET");
  const seed = Buffer.from(base58decode(secret.slice(8))).subarray(0, 32);
  for (const t of [secret.slice(8), seed.toString("hex"), seed.toString("base64"), base58(seed)]) assert.ok(!(r.stdout + r.stderr).includes(t), "the new key is not in the trace");
  const k = freshKey();
  for (const line of [`BIND_RELAYER_KEY_MAINNET=${k.key}`, `export BIND_RELAYER_KEY_MAINNET=${k.key}`, `  BIND_RELAYER_KEY_MAINNET = ${k.key}`, `BIND_RELAYER_MAINNET=${k.account}\nBIND_RELAYER_KEY_MAINNET=${k.key}`]) {
    const t = server({ env: `${BASE_ENV}${line}\n` });
    const was = t.envText();
    const x = t.runTraced();
    assert.equal(x.status, 3, `${line.slice(0, 30)}: exit ${x.status}`);
    assert.match(x.stderr, /^\+ /m, "the run was traced");
    const out = x.stdout + x.stderr;
    assert.ok(!out.includes(k.key.slice(8)) && !out.includes(k.seed.toString("hex")), `the existing key is not in the trace: ${JSON.stringify(line.slice(0, 30))}`);
    assert.equal(t.envText(), was);
  }
});

test("planted: no mainnet-v1.json (only mainnet-test.json) is refused with a clear line, nothing changed and no key made", () => {
  const s = server({ record: null });
  const before = s.envText();
  const r = s.run();
  assert.equal(r.status, 4);
  assert.match(r.stderr, /^bind-relayer-key: no contracts\/vault\/deployments\/mainnet-v1\.json: the mainnet vault is not deployed yet/m);
  assert.equal(s.envText(), before);
  assert.equal(existsSync(s.log), false, "no key made");
  for (const bad of [JSON.stringify({ ...JSON.parse(RECORD), network: "testnet" }), JSON.stringify({ ...JSON.parse(RECORD), account_id: "Evil" }), "{not json", JSON.stringify({ network: "mainnet" })]) {
    const t = server({ record: bad });
    const was = t.envText();
    assert.equal(t.run().status, 4, bad);
    assert.equal(t.envText(), was);
    assert.deepEqual(files(t), [".env", "bind-relayer-key.sh"], "no temporary file left");
  }
});

test("planted: a vault not the record's (the image's pin, or WITHDRAW_VAULT_MAINNET in deploy/.env) is refused with nothing changed", () => {
  const other = server({ record: JSON.stringify({ ...JSON.parse(RECORD), account_id: `x${MAINNET_VAULT}` }) });
  const before = other.envText();
  const r = other.run();
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, new RegExp(`mainnet-v1.json names x${MAINNET_VAULT.replaceAll(".", "\\.")}, but this image carries ${MAINNET_VAULT.replaceAll(".", "\\.")}`));
  assert.equal(other.envText(), before);
  assert.deepEqual(files(other), [".env", "bind-relayer-key.sh"]);
  for (const line of ["WITHDRAW_VAULT_MAINNET=vault.other.near", `WITHDRAW_VAULT_MAINNET=${MAINNET_VAULT}.evil.near`, `WITHDRAW_VAULT_MAINNET=${MAINNET_VAULT} `, `WITHDRAW_VAULT_MAINNET=${MAINNET_VAULT}\nWITHDRAW_VAULT_MAINNET=${MAINNET_VAULT}`]) {
    const s = server({ env: `${BASE_ENV}${line}\n` });
    const was = s.envText();
    const t = s.run();
    assert.equal(t.status, 5, `${line}: ${t.stderr}`);
    assert.equal(s.envText(), was);
  }
  // the same vault in WITHDRAW_VAULT_MAINNET is fine; and a maker that writes another vault is refused
  const same = server({ env: `${BASE_ENV}WITHDRAW_VAULT_MAINNET=${MAINNET_VAULT}\n` });
  assert.equal(same.run().status, 0);
  const k = freshKey();
  const planted = server({ env: `${BASE_ENV}WITHDRAW_VAULT_MAINNET=${MAINNET_VAULT}\n` });
  const was = planted.envText();
  const p = planted.run(planted.plant(`BIND_VAULT_MAINNET=vault.other.near\nBIND_RELAYER_MAINNET=${k.account}\nBIND_RELAYER_KEY_MAINNET=${k.key}\n`));
  assert.equal(p.status, 5, p.stderr);
  assert.equal(planted.envText(), was);
  assert.ok(!(p.stdout + p.stderr).includes(k.key.slice(8)));
});

test("planted: a gas account or key equal to a withdraw relayer's (or the testnet carry's) is refused with nothing changed and no key text on any output", () => {
  const w = freshKey();
  const second = freshKey();
  for (const [name, value, keyOut, accountOut] of [
    ["WITHDRAW_RELAYER_KEYS_MAINNET", `${second.key},${w.key}`, w.key, freshKey().account],
    ["WITHDRAW_RELAYER_KEYS_MAINNET", w.key, w.key, w.account],
    ["WITHDRAW_RELAYER_KEYS_TESTNET", w.key, w.key, freshKey().account],
    ["BIND_RELAYER_KEY_TESTNET", w.key, w.key, freshKey().account],
    ["WITHDRAW_RELAYER_MAINNET", w.account, freshKey().key, w.account],
    ["BIND_RELAYER_TESTNET", w.account, freshKey().key, w.account],
  ]) {
    const s = server({ env: `${BASE_ENV}${name}=${value}\n` });
    const before = s.envText();
    const r = s.run(s.plant(`BIND_VAULT_MAINNET=${MAINNET_VAULT}\nBIND_RELAYER_MAINNET=${accountOut}\nBIND_RELAYER_KEY_MAINNET=${keyOut}\n`));
    assert.equal(r.status, 8, `${name}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`is the one ${name} names; this carry needs its own; nothing changed`));
    assert.equal(s.envText(), before);
    assert.deepEqual(files(s), [".env", "bind-relayer-key.sh"], "no temporary file left");
    const out = r.stdout + r.stderr;
    assert.ok(!out.includes(w.key.slice(8)) && !out.includes(keyOut.slice(8)) && !out.includes(w.seed.toString("hex")), "no key text on any output");
  }
  // other senders' different accounts and keys are fine
  const ok = server({ env: `${BASE_ENV}WITHDRAW_RELAYER_MAINNET=${w.account}\nWITHDRAW_RELAYER_KEYS_MAINNET=${w.key}\n` });
  const r = ok.run();
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(valueOf(ok.envText(), "BIND_RELAYER_KEY_MAINNET"), w.key);
  assert.ok(!(r.stdout + r.stderr).includes(w.key.slice(8)), "the withdraw key is not printed either");
});

test("planted: a maker whose lines are not in their form, or not once each, is refused with nothing changed", () => {
  const k = freshKey();
  for (const out of [
    "",
    `BIND_VAULT_MAINNET=${MAINNET_VAULT}\nBIND_RELAYER_MAINNET=${k.account}\n`,
    `BIND_VAULT_MAINNET=${MAINNET_VAULT}\nBIND_RELAYER_MAINNET=${k.account.toUpperCase()}\nBIND_RELAYER_KEY_MAINNET=${k.key}\n`,
    `BIND_VAULT_MAINNET=${MAINNET_VAULT}\nBIND_RELAYER_MAINNET=${k.account}\nBIND_RELAYER_KEY_MAINNET=${k.key}\nBIND_RELAYER_KEY_MAINNET=${k.key}\n`,
    `BIND_VAULT_MAINNET=${MAINNET_VAULT}\nBIND_RELAYER_MAINNET=${k.account}\nBIND_RELAYER_KEY_MAINNET=${k.key.slice(0, 40)}\n`,
  ]) {
    const s = server();
    const before = s.envText();
    const r = s.run(s.plant(out));
    assert.equal(r.status, 1, `${JSON.stringify(out)}: ${r.stderr}`);
    assert.equal(s.envText(), before);
    assert.ok(!(r.stdout + r.stderr).includes(k.key.slice(8)));
  }
});

test("no HELPER_COMMIT, no BIND_MARGIN_K the helper takes, or arguments: refused with nothing changed and no key made", () => {
  const noCommit = server({ env: "HELPER_RELEASE=3\nBIND_MARGIN_K=60\n" });
  assert.equal(noCommit.run().status, 6);
  const noEnv = server({ env: null });
  assert.equal(noEnv.run().status, 6);
  assert.equal(existsSync(path.join(noEnv.deploy, ".env")), false);
  for (const k of ["", "BIND_MARGIN_K=\n", "BIND_MARGIN_K=0\n", "BIND_MARGIN_K=601\n", "BIND_MARGIN_K=060\n", "BIND_MARGIN_K=6x\n", "BIND_MARGIN_K=60\nBIND_MARGIN_K=60\n", "export BIND_MARGIN_K=60\n"]) {
    const s = server({ env: `HELPER_COMMIT=${COMMIT}\nHELPER_RELEASE=3\n${k}` });
    const before = s.envText();
    const r = s.run({ BIND_MARGIN_K: undefined });
    assert.equal(r.status, 7, `${JSON.stringify(k)}: ${r.stderr}`);
    assert.equal(s.envText(), before);
    assert.equal(existsSync(s.log), false, "no key made");
  }
  // compose reads this shell first: BIND_MARGIN_K set here reaches the helper
  const shell = server({ env: `HELPER_COMMIT=${COMMIT}\n` });
  assert.equal(shell.run({ BIND_MARGIN_K: "600" }).status, 0);
  const args = server();
  assert.equal(args.run({}, "--force").status, 2);
  assert.equal(existsSync(args.log), false);
});

test("a .env whose last line has no newline keeps it whole: the three lines start on their own", () => {
  const s = server({ env: `HELPER_COMMIT=${COMMIT}\nBIND_MARGIN_K=60` });
  assert.equal(s.run().status, 0);
  const lines = s.envText().split("\n");
  assert.equal(lines[1], "BIND_MARGIN_K=60");
  assert.ok(lines[2].startsWith("BIND_VAULT_MAINNET="));
});

test("two runs make two different keys, each from the system's randomness", () => {
  const a = server();
  const b = server();
  assert.equal(a.run().status, 0);
  assert.equal(b.run().status, 0);
  assert.notEqual(valueOf(a.envText(), "BIND_RELAYER_KEY_MAINNET"), valueOf(b.envText(), "BIND_RELAYER_KEY_MAINNET"));
});
