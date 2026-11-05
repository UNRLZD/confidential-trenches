// node --test contracts/vault/scripts/mainnet-test-pastes.test.mjs: the mainnet test vault's paste 1
// (mainnet-test/1-create-parent.sh), offline. npx is a stub put first on PATH: it records its arguments and its TMPDIR,
// writes near-cli-rs-final-command.log into that TMPDIR as near-cli-rs 0.30.1 does on every run (src/common.rs
// l.4070-4086, save_cli_command), with a planted seed phrase in it, and exits STUB_EXIT. HOME is a temp dir whose
// ~/.confidential-trenches/keys/confidential.unrlzd.near.json is the published all-zero ed25519 seed (it never funds
// anything). The script's own KR10 public key is not that key's, so the run that must reach npx is a copy of the
// script whose KR10_PUBLIC_KEY is the zero seed's and whose deploy.mjs is this checkout's.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { b58encode } from "./near-tx.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PASTE1 = path.join(HERE, "mainnet-test", "1-create-parent.sh");
const SEED_WORDS = "planted seed phrase words for the test only";
const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), "paste1-test-")));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

// a fresh HOME holding the zero-seed key file for `account`, a user temp dir, and a stub npx; returns their paths
function world(account = "confidential.unrlzd.near") {
  const d = path.join(TMP, String(n++));
  const home = path.join(d, "home");
  const keys = path.join(home, ".confidential-trenches", "keys");
  const userTmp = path.join(d, "usertmp");
  const bin = path.join(d, "bin");
  for (const x of [keys, userTmp, bin]) mkdirSync(x, { recursive: true });
  const seed = Buffer.alloc(32);
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const pub = Buffer.from(createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "jwk" }).x, "base64url");
  writeFileSync(path.join(keys, "confidential.unrlzd.near.json"), JSON.stringify({ account_id: account, public_key: `ed25519:${b58encode(pub)}`, private_key: `ed25519:${b58encode(Buffer.concat([seed, pub]))}` }));
  const calls = path.join(d, "npx-calls.json");
  writeFileSync(
    path.join(bin, "npx"),
    `#!/bin/sh\nprintf '%s\\n' "$TMPDIR" >> "${calls}.tmpdir"\nprintf '%s\\n' "$*" >> "${calls}.args"\n` +
      `printf '%s\\n' "near account create-account ... sign-with-seed-phrase '${SEED_WORDS}'" > "$TMPDIR/near-cli-rs-final-command.log"\n` +
      // STUB_HOLD: the phrase is typed and near-cli-rs waits at its prompt, until a signal stops it
      `if [ -n "\${STUB_HOLD:-}" ]; then : > "\$STUB_HOLD"; while :; do sleep 1; done; fi\nexit "\${STUB_EXIT:-0}"\n`,
  );
  chmodSync(path.join(bin, "npx"), 0o755);
  return { d, home, userTmp, bin, calls, pub: `ed25519:${b58encode(pub)}` };
}

// the script with its KR10 key set to `pub` and its deploy.mjs this checkout's, in `dir` (a line that is not there is
// left as it is: the script before this card's fold has neither)
function copyWithKey(dir, pub) {
  const s = readFileSync(PASTE1, "utf8")
    .replace(/^KR10_PUBLIC_KEY=.*$/m, `KR10_PUBLIC_KEY=${pub}`)
    .replace(/^DEPLOY=.*$/m, `DEPLOY=${JSON.stringify(path.join(HERE, "deploy.mjs"))}`);
  const f = path.join(dir, "1-create-parent.sh");
  writeFileSync(f, s);
  return f;
}

const run = (w, script, exit = 0) =>
  spawnSync("/bin/sh", [script], { encoding: "utf8", timeout: 30_000, env: { PATH: `${w.bin}${path.delimiter}${process.env.PATH}`, HOME: w.home, TMPDIR: w.userTmp, STUB_EXIT: String(exit) } });
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n") : []);

test("paste 1 refuses a KR10 key file that is not WHHJ4Rmp... before npx runs", () => {
  const w = world();
  const r = run(w, PASTE1);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /KR10 key file .* holds ed25519:\S+, not ed25519:WHHJ4Rmp2dzkkWtE5UuNkeEnw6JCnXLPrnXV6fiQhhh: nothing was sent/);
  assert.deepEqual(lines(`${w.calls}.args`), [], "npx ran");
  assert.ok(!r.stdout.includes("private_key") && !r.stderr.includes("private_key"));
});

test("paste 1 refuses a key file for another account before npx runs", () => {
  const w = world("other.near");
  const r = run(w, copyWithKey(w.d, w.pub));
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /is other\.near's key, not confidential\.unrlzd\.near's: nothing was sent/);
  assert.deepEqual(lines(`${w.calls}.args`), [], "npx ran");
});

for (const exit of [0, 1]) {
  test(`paste 1 with near-cli-rs exiting ${exit}: its command log never reaches the user temp dir and its private TMPDIR is gone`, () => {
    const w = world();
    const r = run(w, copyWithKey(w.d, w.pub), exit);
    assert.equal(r.status, exit, r.stdout + r.stderr);
    const args = lines(`${w.calls}.args`);
    assert.equal(args.length, 1, "npx did not run once");
    const [priv] = lines(`${w.calls}.tmpdir`);
    assert.notEqual(path.resolve(priv), path.resolve(w.userTmp), "near-cli-rs ran with the user's temp dir");
    assert.equal(existsSync(priv), false, `the private TMPDIR ${priv} is left`);
    assert.deepEqual(readdirSync(w.userTmp).filter((f) => f.includes("near-cli-rs")), [], "a command log is in the user temp dir");
    const found = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (readFileSync(p, "utf8").includes(SEED_WORDS)) found.push(p);
      }
    };
    walk(w.userTmp);
    walk(w.home);
    assert.deepEqual(found, [], "the planted seed phrase is left on disk");
    assert.match(args[0], /^--yes near-cli-rs@0\.30\.1 --quiet account create-account fund-myself confidential\.unrlzd\.near 0\.1 NEAR use-manually-provided-public-key ed25519:\S+ sign-as unrlzd\.near network-config mainnet sign-with-seed-phrase$/);
    assert.match(r.stdout, /Press Cmd-K now to clear this window: its prompt showed the seed phrase\.\n$/);
  });
}

// Ctrl-C at near-cli-rs's prompt reaches the whole foreground group: near-cli-rs stops, then the script's INT trap
// runs. It must remove the private TMPDIR and still print the Cmd-K line, since the phrase may already be on screen.
test("paste 1 stopped by Ctrl-C at near-cli-rs's prompt: its private TMPDIR is gone and it prints the Cmd-K line", async () => {
  const w = world();
  const hold = path.join(w.d, "held");
  const child = spawn("/bin/sh", [copyWithKey(w.d, w.pub)], {
    detached: true,
    env: { PATH: `${w.bin}${path.delimiter}${process.env.PATH}`, HOME: w.home, TMPDIR: w.userTmp, STUB_HOLD: hold },
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (err += b));
  const done = new Promise((res) => child.on("close", (code, signal) => res({ code, signal })));
  const t0 = Date.now();
  while (!existsSync(hold)) {
    assert.ok(Date.now() - t0 < 20_000, `near-cli-rs never reached its prompt: ${out}${err}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  process.kill(-child.pid, "SIGINT");
  const r = await Promise.race([done, new Promise((r) => setTimeout(() => r(null), 20_000))]);
  if (r === null) process.kill(-child.pid, "SIGKILL");
  assert.ok(r, "the script did not stop on INT");
  assert.equal(r.code, 130, `${out}${err}`);
  const [priv] = lines(`${w.calls}.tmpdir`);
  assert.equal(existsSync(priv), false, `the private TMPDIR ${priv} is left`);
  assert.deepEqual(readdirSync(w.userTmp).filter((f) => f.includes("near-cli-rs")), [], "a command log is in the user temp dir");
  assert.match(out, /Press Cmd-K now to clear this window: its prompt showed the seed phrase\.\n$/);
});
