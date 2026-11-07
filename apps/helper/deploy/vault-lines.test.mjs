// node --test apps/helper/deploy/vault-lines.test.mjs: cutover step 1, the two mainnet vault lines moved to the deploy
// record's vault (card vault-lines-record-read). Each test runs the real script on a temp "server": the script under
// apps/helper/deploy, a mainnet-v1.json under contracts/vault/deployments (a copy of the real one unless a test plants
// another), and a stub `docker` on PATH that logs its arguments (all but the reader's code) and runs this machine's node
// with what follows the image name, as the image's node would. The real record carries sources.account_id beside
// account_id, which the grep read before this card took for two answers (exit 4 on the server, 7 Nov 20:27Z).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "vault-lines.sh");
const REAL = path.join(HERE, "../../../contracts/vault/deployments/mainnet-v1.json");
const TEST_RECORD = path.join(HERE, "../../../contracts/vault/deployments/mainnet-test.json");
const VAULT = JSON.parse(readFileSync(REAL, "utf8")).account_id;
const OLD = "vault-test.confidential.unrlzd.near";
const COMMIT = "a".repeat(40);
const OTHER = [`HELPER_COMMIT=${COMMIT}`, "HELPER_RELEASE=3", "# a comment kept", "", "JUPITER_API_KEY=test-jupiter-0001", "WITHDRAW_RELAYER_MAINNET=" + "b".repeat(64), "  SPACED = kept as it is"];
const envOf = (...lines) => `${[...OTHER.slice(0, 3), ...lines, ...OTHER.slice(3)].join("\n")}\n`;
const BOTH = envOf(`WITHDRAW_VAULT_MAINNET=${OLD}`, `BIND_VAULT_MAINNET=${OLD}`);

function server({ env = BOTH, record = readFileSync(REAL, "utf8") } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "vault-lines-"));
  const deploy = path.join(dir, "apps/helper/deploy");
  mkdirSync(deploy, { recursive: true });
  copyFileSync(SCRIPT, path.join(deploy, "vault-lines.sh"));
  chmodSync(path.join(deploy, "vault-lines.sh"), 0o755);
  mkdirSync(path.join(dir, "contracts/vault/deployments"), { recursive: true });
  // the test record is always there: the step must never fall back to it
  copyFileSync(TEST_RECORD, path.join(dir, "contracts/vault/deployments/mainnet-test.json"));
  if (record !== null) writeFileSync(path.join(dir, "contracts/vault/deployments/mainnet-v1.json"), record);
  if (env !== null) writeFileSync(path.join(deploy, ".env"), env, { mode: 0o600 });
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const log = path.join(dir, "docker.log");
  writeFileSync(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
a=(); for x in "$@"; do [[ "$x" == "-e" ]] && break; a+=("$x"); done
printf '%s\\n' "\${a[*]}" >> "${log}"
[[ -n "\${DOCKER_FAILS:-}" ]] && { cat > /dev/null; exit "$DOCKER_FAILS"; }
while [[ $# -gt 0 && "$1" != ct-helper:* ]]; do shift; done
[[ "$1" == "ct-helper:${COMMIT}" ]] || exit 125
shift
cd "${dir}"
exec "${process.execPath}" "$@"
`,
    { mode: 0o755 },
  );
  const run = (extra = {}) => spawnSync("bash", [path.join(deploy, "vault-lines.sh")], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra } });
  const envPath = path.join(deploy, ".env");
  const envText = () => readFileSync(envPath, "utf8");
  const docker = () => {
    try {
      return readFileSync(log, "utf8");
    } catch {
      return "";
    }
  };
  return { dir, deploy, envPath, run, envText, docker };
}

/** No value of deploy/.env or the record on the run's output: names only. */
function noValues(r, ...extra) {
  const out = r.stdout + r.stderr;
  for (const v of [VAULT, OLD, COMMIT, "test-jupiter-0001", "b".repeat(64), ...extra]) assert.ok(!out.includes(v), `a value on the output: ${v.slice(0, 12)}...`);
}
const unchanged = (s, before, inode) => {
  assert.equal(s.envText(), before, "deploy/.env unchanged");
  assert.equal(statSync(s.envPath).ino, inode, "deploy/.env not rewritten");
  assert.deepEqual(readdirSync(s.deploy).sort(), [".env", "vault-lines.sh"], "no temporary file left");
};

test("the real mainnet-v1.json (sources.account_id beside account_id): both lines move to its top-level account_id, every other line kept byte for byte, names only on the output", () => {
  const s = server();
  const inode = statSync(s.envPath).ino;
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /moved WITHDRAW_VAULT_MAINNET BIND_VAULT_MAINNET to mainnet-v1\.json's vault/);
  assert.equal(s.envText(), envOf(`WITHDRAW_VAULT_MAINNET=${VAULT}`, `BIND_VAULT_MAINNET=${VAULT}`), "the two lines moved in place, every other line byte for byte");
  assert.notEqual(statSync(s.envPath).ino, inode, "replaced by one rename");
  assert.equal(statSync(s.envPath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(s.deploy).sort(), [".env", "vault-lines.sh"]);
  noValues(r);
  // the record is read by node in the running image, offline and read-only, the record on stdin (not argv)
  const call = s.docker().trim().split("\n");
  assert.equal(call.length, 1);
  for (const flag of ["run --rm -i", "--log-driver none", "--pull never", "--network none", "--read-only", "--cap-drop ALL", "--entrypoint node", `ct-helper:${COMMIT}`]) assert.ok(call[0].includes(flag), flag);
  assert.ok(!call[0].includes("mainnet-v1.json"), "the record goes on stdin");
});

test("a name not set stays unset; a rerun with both naming the vault writes nothing", () => {
  const s = server({ env: envOf(`WITHDRAW_VAULT_MAINNET=${OLD}`) });
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /moved WITHDRAW_VAULT_MAINNET to/);
  assert.equal(s.envText(), envOf(`WITHDRAW_VAULT_MAINNET=${VAULT}`));
  assert.ok(!s.envText().includes("BIND_VAULT_MAINNET"), "BIND_VAULT_MAINNET stays unset");
  const done = server({ env: envOf(`WITHDRAW_VAULT_MAINNET=${VAULT}`, `BIND_VAULT_MAINNET=${VAULT}`) });
  const before = done.envText();
  const inode = statSync(done.envPath).ino;
  const again = done.run();
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /every vault line set already names mainnet-v1\.json's vault; nothing changed/);
  unchanged(done, before, inode);
  noValues(again);
});

test("refusals, each with deploy/.env unchanged and no value on the output: no record, a testnet record, a bad id, only sources.account_id, no JSON (4); a line not plain (1); no HELPER_COMMIT (6); the reader's image missing (1)", () => {
  const real = JSON.parse(readFileSync(REAL, "utf8"));
  const cases = [
    ["no record", { record: null }, 4, /no contracts\/vault\/deployments\/mainnet-v1\.json/],
    ["a testnet record", { record: JSON.stringify({ ...real, network: "testnet" }) }, 4, /names no mainnet vault/],
    ["a bad id", { record: JSON.stringify({ ...real, account_id: "Vault..BAD" }) }, 4, /names no mainnet vault/],
    ["an id past 64", { record: JSON.stringify({ ...real, account_id: `${"a".repeat(60)}.near` }) }, 4, /names no mainnet vault/],
    ["only sources.account_id", { record: JSON.stringify({ ...real, account_id: undefined, sources: { account_id: VAULT } }) }, 4, /names no mainnet vault/],
    ["account_id not a string", { record: JSON.stringify({ ...real, account_id: [VAULT] }) }, 4, /names no mainnet vault/],
    ["not JSON", { record: `"account_id": "${VAULT}", "network": "mainnet"` }, 4, /names no mainnet vault/],
    ["export form", { env: envOf(`export WITHDRAW_VAULT_MAINNET=${OLD}`) }, 1, /WITHDRAW_VAULT_MAINNET in deploy\/\.env is not one plain/],
    ["the name twice", { env: envOf(`BIND_VAULT_MAINNET=${OLD}`, `BIND_VAULT_MAINNET=${OLD}`) }, 1, /BIND_VAULT_MAINNET in deploy\/\.env is not one plain/],
    ["the NAME: form", { env: envOf(`BIND_VAULT_MAINNET: ${OLD}`) }, 1, /BIND_VAULT_MAINNET in deploy\/\.env is not one plain/],
    ["no HELPER_COMMIT", { env: BOTH.replace(`HELPER_COMMIT=${COMMIT}\n`, "") }, 6, /names no HELPER_COMMIT/],
  ];
  for (const [name, o, code, said] of cases) {
    const s = server(o);
    const before = s.envText();
    const inode = statSync(s.envPath).ino;
    const r = s.run();
    assert.equal(r.status, code, `${name}: ${r.stderr}`);
    assert.match(r.stderr, said, name);
    unchanged(s, before, inode);
    noValues(r);
  }
  const gone = server();
  const before = gone.envText();
  const inode = statSync(gone.envPath).ino;
  const r = gone.run({ DOCKER_FAILS: "125" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /the record reader stopped \(exit 125\)/);
  unchanged(gone, before, inode);
  noValues(r);
});

test("no deploy/.env: nothing to move, nothing written, no image run", () => {
  const s = server({ env: null });
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no deploy\/\.env; nothing to move/);
  assert.deepEqual(readdirSync(s.deploy).sort(), ["vault-lines.sh"]);
  assert.equal(s.docker(), "");
});
