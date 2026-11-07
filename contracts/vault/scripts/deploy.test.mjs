// node --test contracts/vault/scripts/deploy.test.mjs: deploy.mjs's refusals, offline. No test reaches a network or
// builds the vault:
//   - every spawned run imports a module that replaces fetch with one that throws, so a refusal "before any send" is
//     one whose output never names the blocked fetch;
//   - `cargo` and `rustc` are stubs put first on PATH: the cargo stub copies a planted wasm into the --out-dir it is
//     given (STUB_WASM_A for out dir `a`, STUB_WASM_B for `b`), so the two builds can be made equal or different; each
//     planted wasm carries the NEP-330 metadata of this checkout's HEAD for the flavor asked (--variant testnet or none)
//     unless STUB_NO_META is set, and the stub appends its arguments to <build-dir>/cargo-args.log;
//   - `cargo +1.96.0 near --version` answers the pinned CARGO_NEAR unless a test plants another (STUB_NEAR_VERSION);
//     STUB_SLEEP makes each build wait that many seconds, so a test can interrupt one; STUB_FILES fills target dir a
//     with that many files first, so removing it takes seconds; STUB_FIFO_B makes build b's wasm a FIFO a background
//     writer fills 1.5 s after b exits, so reading it holds the script in sync code;
//   - a test that needs an RPC's status answers swaps the blocking fetch for one that answers `status` alone with the
//     chain ids it is given and blocks every other method;
//   - the key is the published all-zero ed25519 seed (32 zero bytes; its public key 3b6a27bc…da29 is checked below),
//     written at run time to a temp dir outside both checkouts and removed afterwards. It never funds anything.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import http from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CARGO_NEAR, CONTRACT_PATH, LIVE_CHECK, REPO, REPRODUCIBLE, STOP_SIGNALS, chainProblems, deployProblems, loadKey, MAX_FUNCTION_BODY, MAX_REGISTRATION, metadataProblems, nextLine, registrationProblems, repoRoots, reproducibleProblems, rpcProblems } from "./deploy.mjs";
import { b58encode } from "./near-tx.mjs";
import { TESTNET_TOKEN } from "../../../scripts/live-checks/vault-testnet-t01.mjs";
import { TEST_BUILD_MARK } from "../../../scripts/live-checks/vault-skeleton.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "deploy.mjs");
const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ZERO_SEED_PUB = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
const PARENT = "bf-test.testnet";

const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), "deploy-test-")));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = path.join(TMP, String(n++));
  mkdirSync(d);
  return d;
};

// The zero-seed key file for `account`, with `pub` as its public_key (the right one unless a test plants another).
function keyFile(dir, account = PARENT, pub) {
  const seed = Buffer.alloc(32);
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const real = Buffer.from(createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "jwk" }).x, "base64url");
  const f = path.join(dir, "key.json");
  writeFileSync(f, JSON.stringify({ account_id: account, public_key: `ed25519:${b58encode(pub ?? real)}`, private_key: `ed25519:${b58encode(Buffer.concat([seed, real]))}` }));
  return { file: f, pub: real };
}

// A wasm whose function exports are `exports` (all one function, `body` bytes), with `strings` in a custom section.
function wasm({ body = 4, strings = [TESTNET_TOKEN], exports = ["config"] } = {}) {
  const leb = (x) => {
    const o = [];
    do {
      const b = x & 0x7f;
      x = Math.floor(x / 128);
      o.push(x ? b | 0x80 : b);
    } while (x);
    return o;
  };
  const section = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
  const fn = [0, ...Array(body - 2).fill(0x01), 0x0b];
  const data = [4, ...Buffer.from("data"), ...Buffer.from(strings.join("\0"))];
  return Buffer.from([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(3, [1, 0]),
    ...section(7, [exports.length, ...exports.flatMap((e) => [e.length, ...Buffer.from(e), 0, 0])]),
    ...section(10, [1, ...leb(fn.length), ...fn]),
    ...section(0, data),
  ]);
}

// The commit deploy.mjs builds: this checkout's HEAD.
const HEAD = execFileSync("git", ["-C", HERE, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
// The NEP-330 metadata a reproducible build of `flavor` at `commit` holds, as near-sdk 5.29.1 serialises it. The link
// is cargo-near-build 0.11.5's for a github.com repository (nep330_build_info.rs compute_repo_link_hint): the tree at
// the commit, not the bare repository.
const meta = ({ flavor = "mainnet", commit = HEAD, ...over } = {}) => ({
  version: "0.1.0",
  link: `${REPO}/tree/${commit}`,
  standards: [{ standard: "nep330", version: "1.3.0" }],
  build_info: {
    build_environment: `${REPRODUCIBLE.image}@${REPRODUCIBLE.image_digest}`,
    build_command: flavor === "testnet" ? REPRODUCIBLE.variant.testnet.container_build_command : REPRODUCIBLE.container_build_command,
    contract_path: CONTRACT_PATH,
    source_code_snapshot: `git+${REPO}?rev=${commit}`,
    output_wasm_path: null,
  },
  ...over,
});
// `bytes` with one more custom section holding `strings` (a wasm may end in custom sections)
const withStrings = (bytes, ...strings) => {
  const body = Buffer.concat([Buffer.from([4]), Buffer.from("meta"), Buffer.from(strings.join("\0"))]);
  const len = [];
  for (let x = body.length; ; ) {
    const b7 = x & 0x7f;
    x = Math.floor(x / 128);
    len.push(x ? b7 | 0x80 : b7);
    if (!x) break;
  }
  return Buffer.concat([Buffer.from(bytes), Buffer.from([0, ...len]), body]);
};

// A `git` stub in `bin` in front of the real one: `ls-remote` answers one branch whose tip is STUB_GIT_TIP (HEAD unless
// a test plants another; STUB_GIT_NO_REMOTE makes it fail), `status` answers clean unless STUB_GIT_DIRTY names a path;
// everything else runs the real git. So no run reads GitHub, and the worktree's own state never decides a test.
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
function gitStub(bin) {
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\nfor a in "$@"; do case "$a" in\n` +
      `  ls-remote) [ -n "$STUB_GIT_NO_REMOTE" ] && { echo "fatal: stub: no remote" >&2; exit 128; }; printf '%s\\trefs/heads/main\\n' "\${STUB_GIT_TIP:-${HEAD}}"; exit 0;;\n` +
      `  status) [ -n "$STUB_GIT_DIRTY" ] && printf ' M %s\\n' "$STUB_GIT_DIRTY"; exit 0;;\n` +
      `esac; done\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`,
  );
  chmodSync(path.join(bin, "git"), 0o755);
  return bin;
}

// Stub cargo, rustc and git in <dir>/bin, and the planted wasm files; the env a run needs.
function stubs(dir, a, b = a) {
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const fa = path.join(dir, "a.wasm");
  const fb = path.join(dir, "b.wasm");
  for (const [f, w] of [[fa, a], [fb, b]]) {
    writeFileSync(f + ".raw", w);
    writeFileSync(f, withStrings(w, JSON.stringify(meta())));
    writeFileSync(f + ".testnet", withStrings(w, JSON.stringify(meta({ flavor: "testnet" }))));
  }
  writeFileSync(
    path.join(bin, "cargo"),
    `#!/bin/sh\ncase " $* " in *" --version "*) echo "\${STUB_NEAR_VERSION:-${CARGO_NEAR}}"; exit 0;; esac\n` +
      'prev=; for x in "$@"; do [ "$prev" = --out-dir ] && CARGO_TARGET_DIR=$x; prev=$x; done\n' +
      'SUF=; case " $* " in *" --variant testnet "*) SUF=.testnet;; esac; [ -n "$STUB_NO_META" ] && SUF=.raw\n' +
      '[ -n "$STUB_FAIL" ] && { echo "stub: a crates.io blip, before any wasm exists" >&2; exit 101; }\n' +
      'mkdir -p "$CARGO_TARGET_DIR"\necho "$*" >> "$CARGO_TARGET_DIR/../cargo-args.log"\nname=$(basename "$CARGO_TARGET_DIR")\n' +
      `if [ "$name" = a ] && [ -n "$STUB_FILES" ]; then "${process.execPath}" -e 'const fs=require("fs");const d=process.argv[1]+"/many";fs.mkdirSync(d);for(let i=0;i<+process.argv[2];i++)fs.writeFileSync(d+"/"+i,"x")' "$CARGO_TARGET_DIR" "$STUB_FILES"; fi\n` +
      'if [ -n "$STUB_SLEEP" ]; then echo $$ > "$CARGO_TARGET_DIR/../build.pid"; sleep "$STUB_SLEEP"; fi\n' +
      'if [ "$name" = b ] && [ -n "$STUB_FIFO_B" ]; then mkfifo "$CARGO_TARGET_DIR/blindfill_vault.wasm"\n' +
      '  ( sleep 1.5; cat "$STUB_WASM_B$SUF" > "$CARGO_TARGET_DIR/blindfill_vault.wasm" ) </dev/null >/dev/null 2>&1 &\n' +
      '  echo done > "$CARGO_TARGET_DIR/../b.exited"; exit 0; fi\n' +
      'if [ "$(basename "$CARGO_TARGET_DIR")" = a ]; then cp "$STUB_WASM_A$SUF" "$CARGO_TARGET_DIR/blindfill_vault.wasm"; else cp "$STUB_WASM_B$SUF" "$CARGO_TARGET_DIR/blindfill_vault.wasm"; fi\n',
  );
  writeFileSync(path.join(bin, "rustc"), '#!/bin/sh\necho "rustc 1.96.0 (stub)"\n');
  chmodSync(path.join(bin, "cargo"), 0o755);
  chmodSync(path.join(bin, "rustc"), 0o755);
  gitStub(bin);
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_WASM_A: fa, STUB_WASM_B: fb };
}

// deploy.mjs with `args`, fetch blocked; with `chains` ({ url: chain_id }), `status` alone answers, with that chain id,
// and every method asked is appended to <dir>/methods.log
// (the default env puts only the git stub in front)
const gitEnv = (dir) => ({ ...process.env, PATH: `${gitStub(path.join(dir, "git-bin"))}${path.delimiter}${process.env.PATH}` });
function run(dir, args, env = gitEnv(dir), chains = null) {
  return spawnSync(process.execPath, ["--import", pathToFileURL(net(dir, chains)).href, SCRIPT, ...args], { encoding: "utf8", timeout: 30_000, env });
}
// the same run, not waited for: { c, done } where done resolves { code, signal, output }; `chains` false lets the
// run reach the network (a test's own local servers only)
function start(dir, args, env = gitEnv(dir), chains = null) {
  const c = spawn(process.execPath, [...(chains === false ? [] : ["--import", pathToFileURL(net(dir, chains)).href]), SCRIPT, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  c.stdout.on("data", (x) => (output += x));
  c.stderr.on("data", (x) => (output += x));
  return { c, done: new Promise((r) => c.on("close", (code, signal) => r({ code, signal, output }))) };
}
// the fetch-replacing module of a run (see run)
function net(dir, chains) {
  const block = path.join(dir, "no-network.mjs");
  const log = path.join(dir, "methods.log");
  writeFileSync(
    block,
    chains
      ? `import { appendFileSync } from "node:fs";\nconst chains = ${JSON.stringify(chains)};\n` +
          `globalThis.fetch = async (url, init) => { const { method } = JSON.parse(init.body); appendFileSync(${JSON.stringify(log)}, method + " " + url + "\\n");\n` +
          `  if (method === "status" && url in chains) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: "deploy", result: { chain_id: chains[url] } }) };\n` +
          "  throw new Error(`network blocked by the test: ${method} ${url}`); };\n"
      : 'globalThis.fetch = async (url) => { throw new Error(`network blocked by the test: ${url}`); };\n',
  );
  return block;
}
const methods = (dir) => (existsSync(path.join(dir, "methods.log")) ? readFileSync(path.join(dir, "methods.log"), "utf8").trim().split("\n") : []);

const testnet = (dir, key, buildDir) => ["--network", "testnet", "--parent", PARENT, "--key-file", key, "--build-dir", buildDir, "--out", path.join(dir, "out.json")];
const neverSent = (r) => assert.doesNotMatch(r.stdout + r.stderr, /network blocked/, "the run reached the network");
const targetsGone = (buildDir) => {
  assert.equal(existsSync(path.join(buildDir, "a")), false, "build target dir a is left");
  assert.equal(existsSync(path.join(buildDir, "b")), false, "build target dir b is left");
};

// ---- the key ----

test("the zero-seed key file loads, and its public key is the published vector", () => {
  const k = keyFile(fresh());
  assert.equal(k.pub.toString("hex"), ZERO_SEED_PUB);
  assert.equal(loadKey(k.file, PARENT).pub.toString("hex"), ZERO_SEED_PUB);
});

test("a key file inside the repository is refused: this checkout and, for a worktree, the main checkout are roots", () => {
  const k = keyFile(fresh());
  assert.throws(() => loadKey(k.file, PARENT, [TMP]), /--key-file is inside the repository/);
  const roots = repoRoots();
  assert.ok(roots.includes(realpathSync(path.resolve(HERE, "../../.."))), `this checkout is not a root: ${roots}`);
  const common = execFileSync("git", ["-C", HERE, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  assert.ok(roots.includes(realpathSync(path.dirname(common))), `the main checkout is not a root: ${roots}`);
});

test("a key file for another account is refused", () => {
  const k = keyFile(fresh(), "someone-else.testnet");
  assert.throws(() => loadKey(k.file, PARENT, []), /--key-file is someone-else\.testnet's key, not bf-test\.testnet's/);
});

test("a key file whose public_key does not match its private key is refused", () => {
  const k = keyFile(fresh(), PARENT, Buffer.alloc(32, 1));
  assert.throws(() => loadKey(k.file, PARENT, []), /public_key does not match the private key/);
});

// ---- the network ----

// card vault-mainnet-test: mainnet deploys the pinned wasm only, so a mainnet run that would build is refused
test("--network mainnet without the pinned wasm is refused before any build or send", () => {
  const dir = fresh();
  const k = keyFile(dir);
  const buildDir = path.join(dir, "build");
  const r = run(dir, ["--network", "mainnet", "--parent", "bf-test.near", "--key-file", k.file, "--build-dir", buildDir], stubs(dir, wasm()));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /--network mainnet takes --wasm, --deployment, --vault and --out/);
  neverSent(r);
  assert.equal(existsSync(buildDir), false, "a build ran");
});

test("the next line names testnet's live check for a testnet deploy, and no live check for a sandbox one", () => {
  const rec = "contracts/vault/deployments/testnet-vault.json";
  assert.equal(nextLine("testnet", rec), `next: node scripts/live-checks/vault-testnet-t01.mjs --deployment ${rec}`);
  assert.ok(existsSync(path.join(fileURLToPath(new URL("../../..", import.meta.url)), LIVE_CHECK)), `${LIVE_CHECK} is not in the repo`);
  // vault-testnet-t01.mjs reads public testnet RPCs only, so it can never check a sandbox deploy
  assert.equal(nextLine("sandbox", "x/record.json"), "next: no live check (a sandbox deploy lives on this machine only; tests/s20.rs checks its end state)");
  assert.equal(nextLine("mainnet", "contracts/vault/deployments/mainnet-test.json", { account: "vault-test.p.near", signer: "p.near" }), "next: node scripts/live-checks/vault-mainnet.mjs --network mainnet --account vault-test.p.near --signer p.near --deployment contracts/vault/deployments/mainnet-test.json");
  assert.throws(() => nextLine("devnet", rec), /no network devnet/);
});

// ---- the wasm ----

test("a function body over 196,608 B is refused before any send, and both target dirs are gone", () => {
  const dir = fresh();
  const k = keyFile(dir);
  const buildDir = path.join(dir, "build");
  const r = run(dir, testnet(dir, k.file, buildDir), stubs(dir, wasm({ body: MAX_FUNCTION_BODY + 1 })));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /refused before any send: 1 function body over 196608 B: 196609/);
  neverSent(r);
  targetsGone(buildDir);
});

test("a mainnet build is refused on testnet before any send", () => {
  const dir = fresh();
  const k = keyFile(dir);
  const r = run(dir, testnet(dir, k.file, path.join(dir, "build")), stubs(dir, wasm({ strings: [MAINNET_USDC] })));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /refused before any send: .*not a testnet build: .*holds mainnet USDC/);
  neverSent(r);
});

// card vault-testnet-t01: the 1 Nov skeleton's testnet build named Circle's testnet USDC, so the wallet's testnet
// deposit (on the team's testnet USDC) was refused on chain; such a build is refused before any send
test("a testnet build naming Circle's testnet USDC is refused on testnet before any send", () => {
  const dir = fresh();
  const k = keyFile(dir);
  const r = run(dir, testnet(dir, k.file, path.join(dir, "build")), stubs(dir, wasm({ strings: ["3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"] })));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /refused before any send: .*not a testnet build: does not hold the testnet token bf-usdc-20261101t022248\.testnet.*holds Circle's testnet USDC/);
  neverSent(r);
});

test("two clean builds that differ stop the run before any send, and both target dirs are gone", () => {
  const dir = fresh();
  const k = keyFile(dir);
  const buildDir = path.join(dir, "build");
  const r = run(dir, testnet(dir, k.file, buildDir), stubs(dir, wasm(), wasm({ strings: [TESTNET_TOKEN, "another build"] })));
  // exit 3, deploy.mjs's own code for two hashes that disagree (card ci-cargo-fetch-retry): vault-build never retries it
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /the two clean builds differ: [0-9a-f]{64} \(\d+ B\) and [0-9a-f]{64} \(\d+ B\); nothing was sent/);
  neverSent(r);
  targetsGone(buildDir);
});

// card ci-cargo-fetch-retry: vault-build runs --build-only and --verify-records under scripts/ci/retry.sh, which tries a
// failed run again. A build that fails before any hash exists (a crates.io blip, the image) is that, exit 1; two builds
// of one commit that disagree are not, and end with the code RETRY_FINAL names there, so a build that is reproducible
// only some of the time is never green on its second try.
test("--build-only: two builds that differ exit 3, the code vault-build never retries; a build that fails before a hash exists exits 1", async () => {
  const { EXIT_HASH_DISAGREE } = await import(SCRIPT);
  assert.equal(EXIT_HASH_DISAGREE, 3);
  const args = (dir) => ["--build-only", "--flavor", "testnet", "--build-dir", path.join(dir, "build")];
  const dir = fresh();
  const differ = run(dir, args(dir), stubs(dir, wasm(), wasm({ strings: [TESTNET_TOKEN, "another build"] })));
  assert.equal(differ.status, 3, differ.stdout + differ.stderr);
  assert.match(differ.stderr, /the two clean builds differ/);
  const dir2 = fresh();
  const failed = run(dir2, args(dir2), { ...stubs(dir2, wasm()), STUB_FAIL: "1" });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /build a failed \(exit 101\)/);
});

test("the fetch block holds: a wasm that passes every rule stops at the first RPC read, after the build", () => {
  const dir = fresh();
  const k = keyFile(dir);
  const buildDir = path.join(dir, "build");
  const r = run(dir, testnet(dir, k.file, buildDir), stubs(dir, wasm()));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /reproducible: both builds sha256 [0-9a-f]{64}/);
  assert.match(r.stderr, /network blocked by the test: https:\/\/test\.rpc\.fastnear\.com/);
  targetsGone(buildDir);
});

test("--build-only: two equal builds pass, the wasm is kept and both target dirs are gone", () => {
  const dir = fresh();
  const buildDir = path.join(dir, "build");
  const r = run(dir, ["--build-only", "--flavor", "testnet", "--build-dir", buildDir], stubs(dir, wasm()));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /reproducible: both builds sha256 [0-9a-f]{64}/);
  assert.ok(existsSync(path.join(buildDir, "blindfill_vault.wasm")), "the wasm is not kept");
  targetsGone(buildDir);
});

// ---- the reproducible build (NEP-330) ----

const CARGO_TOML = readFileSync(path.join(HERE, "..", "Cargo.toml"), "utf8");

test("Cargo.toml pins the reproducible build's image by digest, as deploy.mjs REPRODUCIBLE holds it", () => {
  assert.deepEqual(reproducibleProblems(CARGO_TOML), []);
  assert.match(REPRODUCIBLE.image_digest, /^sha256:[0-9a-f]{64}$/);
  const swap = (a, b) => {
    assert.ok(CARGO_TOML.includes(a), `Cargo.toml has no ${a}`);
    return reproducibleProblems(CARGO_TOML.replace(a, b));
  };
  const digestLine = `image_digest = "${REPRODUCIBLE.image_digest}"`;
  // not pinned: no digest, an empty one, a tag in its place
  for (const p of [swap(digestLine, ""), swap(digestLine, 'image_digest = ""'), swap(digestLine, 'image_digest = "latest"')]) assert.ok(p.some((x) => /the image is not pinned by digest/.test(x)), p.join("; "));
  // pinned, but not by the digest deploy.mjs holds, or another image
  assert.ok(swap(digestLine, `image_digest = "sha256:${"0".repeat(64)}"`).some((x) => /image_digest is "sha256:0{64}", deploy\.mjs REPRODUCIBLE has/.test(x)));
  assert.ok(swap(`image = "${REPRODUCIBLE.image}"`, 'image = "sourcescan/cargo-near:latest"').some((x) => /\] image is "sourcescan\/cargo-near:latest"/.test(x)));
  // a passed env (a build parameter from the builder's shell), a command without --locked, an unread multi-line list
  assert.ok(swap("passed_env = []", 'passed_env = ["RUSTFLAGS"]').some((x) => /passed_env is \["RUSTFLAGS"\]/.test(x)));
  assert.ok(swap('"--locked", "--no-embed-abi"]', '"--no-embed-abi"]').some((x) => /container_build_command is/.test(x)));
  assert.ok(swap("passed_env = []", "passed_env = [\n]").some((x) => /is not one line of a string or a list of strings/.test(x)));
  // the testnet variant's command, an extra variant, no table, another repository
  assert.ok(swap('"--features", "testnet"]', '"--features", "testnet,test-on-payout-out-of-gas"]').some((x) => /variant\.testnet\] container_build_command/.test(x)));
  assert.ok(reproducibleProblems(`${CARGO_TOML}\n[package.metadata.near.reproducible_build.variant.oog]\ncontainer_build_command = ["cargo"]\n`).some((x) => /variant\.oog\] is not one of/.test(x)));
  assert.ok(swap("[package.metadata.near.reproducible_build]", "[package.metadata.near.other]").some((x) => /has no \[package\.metadata\.near\.reproducible_build\]/.test(x)));
  assert.ok(swap(`repository = "${REPO}"`, 'repository = "https://github.com/x/y"').some((x) => /package\.repository is "https:\/\/github\.com\/x\/y"/.test(x)));
});

test("each build is cargo near build reproducible-wasm into its own out dir, the testnet one with --variant testnet", () => {
  for (const [flavor, variant] of [["testnet", " --variant testnet"], ["mainnet", ""]]) {
    const dir = fresh();
    const buildDir = path.join(dir, "build");
    const r = run(dir, ["--build-only", "--flavor", flavor, "--build-dir", buildDir], stubs(dir, wasm({ strings: [flavor === "testnet" ? TESTNET_TOKEN : MAINNET_USDC] })));
    // the testnet stub passes every rule; the mainnet one is refused after the build, for its missing required exports
    assert.equal(r.status, flavor === "testnet" ? 0 : 1, r.stdout + r.stderr);
    if (flavor === "mainnet") assert.match(r.stderr, /the build would be refused: missing exports/);
    const args = readFileSync(path.join(buildDir, "cargo-args.log"), "utf8").trim().split("\n");
    assert.deepEqual(args, ["a", "b"].map((n) => `+1.96.0 near build reproducible-wasm${variant} --out-dir ${path.join(buildDir, n)}`), flavor);
  }
});

test("a build whose NEP-330 metadata is missing is refused before any send, and both out dirs are gone", () => {
  const dir = fresh();
  const k = keyFile(dir);
  const buildDir = path.join(dir, "build");
  const r = run(dir, testnet(dir, k.file, buildDir), { ...stubs(dir, wasm()), STUB_NO_META: "1" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /the wasm holds no single NEP-330 contract_source_metadata; nothing was sent/);
  neverSent(r);
  targetsGone(buildDir);
});

test("the wasm's NEP-330 metadata must name this repository at the commit, the pinned image and the flavor's command", () => {
  const m = (o) => withStrings(wasm(), JSON.stringify(meta(o)));
  assert.deepEqual(metadataProblems(m({ flavor: "testnet" }), { commit: HEAD, flavor: "testnet" }), []);
  assert.deepEqual(metadataProblems(m(), { commit: HEAD, flavor: "mainnet" }), []);
  const one = (w, o) => {
    const p = metadataProblems(w, o);
    assert.equal(p.length, 1, p.join("; "));
    return p[0];
  };
  // a build of another commit names it in both the link and the snapshot
  const another = metadataProblems(m({ commit: "0".repeat(40) }), { commit: HEAD, flavor: "mainnet" });
  assert.equal(another.length, 2, another.join("; "));
  assert.match(another[0], /metadata link is ".*\/tree\/0{40}"/);
  assert.match(another[1], /source_code_snapshot is "git\+https:\/\/github\.com\/UNRLZD\/confidential-trenches\?rev=0{40}"/);
  assert.match(one(m({ link: "https://github.com/x/y" }), { commit: HEAD, flavor: "mainnet" }), /metadata link is "https:\/\/github\.com\/x\/y"/);
  // the bare repository, or the tree at another commit, is not the link cargo-near writes for this commit
  assert.match(one(m({ link: REPO }), { commit: HEAD, flavor: "mainnet" }), /metadata link is "https:\/\/github\.com\/UNRLZD\/confidential-trenches", want ".*\/tree\//);
  assert.match(one(m({ link: `${REPO}/tree/${"0".repeat(40)}` }), { commit: HEAD, flavor: "mainnet" }), /metadata link is ".*\/tree\/0{40}"/);
  assert.match(one(m({ flavor: "testnet" }), { commit: HEAD, flavor: "mainnet" }), /build_info\.build_command is .*"testnet"\]/);
  const other = meta();
  other.build_info.build_environment = "sourcescan/cargo-near:0.21.1-rust-1.96.0";
  assert.match(one(withStrings(wasm(), JSON.stringify(other)), { commit: HEAD, flavor: "mainnet" }), /build_environment is "sourcescan\/cargo-near:0\.21\.1-rust-1\.96\.0", want ".*@sha256:/);
  // a host build carries no build_info; no metadata, or two, is none
  assert.equal(metadataProblems(withStrings(wasm(), JSON.stringify({ version: "0.1.0", standards: [{ standard: "nep330", version: "1.3.0" }] })), { commit: HEAD, flavor: "mainnet" }).length, 5);
  assert.match(one(wasm(), { commit: HEAD, flavor: "mainnet" }), /holds no single NEP-330/);
  assert.match(one(withStrings(wasm(), JSON.stringify(meta()), JSON.stringify(meta())), { commit: HEAD, flavor: "mainnet" }), /holds no single NEP-330/);
});

// ---- the source a deploy names (card vault-reproducible-build): a clean tree, a commit anyone can fetch, a marked record ----

// A branch tip this checkout does not hold: no test depends on the clone's depth or on this repository's history (CI
// checks out one commit). Whether a held tip that is not a descendant counts is read on a repository the test makes.
const UNFETCHED = "1".repeat(40);

test("sourceProblems holds a commit only when a branch or tag tip of the repository descends from it", async () => {
  const { sourceProblems } = await import(SCRIPT);
  const dir = fresh();
  const repo = path.join(dir, "repo");
  const g = (...a) => execFileSync(REAL_GIT, ["-C", repo, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  mkdirSync(repo);
  g("init", "-q");
  g("commit", "-q", "--allow-empty", "-m", "a");
  const a = g("rev-parse", "HEAD");
  g("commit", "-q", "--allow-empty", "-m", "b");
  const b = g("rev-parse", "HEAD");
  const saved = { PATH: process.env.PATH, STUB_GIT_TIP: process.env.STUB_GIT_TIP };
  process.env.PATH = `${gitStub(path.join(dir, "git-bin"))}${path.delimiter}${process.env.PATH}`;
  try {
    process.env.STUB_GIT_TIP = b;
    assert.deepEqual(sourceProblems({ cwd: repo, commit: a }), []);
    assert.deepEqual(sourceProblems({ cwd: repo, commit: b }), []);
    process.env.STUB_GIT_TIP = a;
    assert.match(sourceProblems({ cwd: repo, commit: b }).join(";"), new RegExp(`commit ${b} is on no branch or tag of`));
    process.env.STUB_GIT_TIP = UNFETCHED;
    assert.match(sourceProblems({ cwd: repo, commit: a }).join(";"), new RegExp(`commit ${a} is on no branch or tag of`));
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("a testnet deploy refuses a tree with changes, before any build or send", () => {
  const dir = fresh();
  const k = keyFile(dir);
  const buildDir = path.join(dir, "build");
  const r = run(dir, testnet(dir, k.file, buildDir), { ...stubs(dir, wasm()), STUB_GIT_DIRTY: "contracts/vault/src/lib.rs" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /the tree has 1 changed or untracked path\(s\) \( M contracts\/vault\/src\/lib\.rs\): build from a clean checkout: nothing was built or sent/);
  assert.equal(existsSync(path.join(buildDir, "cargo-args.log")), false, "a build ran");
  neverSent(r);
});

test("a testnet deploy refuses a HEAD on no branch or tag of the repository, or a repository it cannot list, before any build", () => {
  for (const [env, want] of [
    [{ STUB_GIT_TIP: UNFETCHED }, new RegExp(`commit ${HEAD} is on no branch or tag of https://github\\.com/UNRLZD/confidential-trenches: push it`)],
    [{ STUB_GIT_NO_REMOTE: "1" }, /git ls-remote https:\/\/github\.com\/UNRLZD\/confidential-trenches failed: fatal: stub: no remote/],
  ]) {
    const dir = fresh();
    const k = keyFile(dir);
    const buildDir = path.join(dir, "build");
    const r = run(dir, testnet(dir, k.file, buildDir), { ...stubs(dir, wasm()), ...env });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, want);
    assert.match(r.stderr, /: nothing was built or sent/);
    assert.equal(existsSync(path.join(buildDir, "cargo-args.log")), false, "a build ran");
    neverSent(r);
  }
});

test("a deploy record names exactly one source: source_commit or non_reproducible, never both; the earlier vault records are marked", async () => {
  const { recordSourceProblems, vaultRecords } = await import(SCRIPT);
  const sha = "ab".repeat(32);
  const rec = { wasm_sha256: sha, code_hash: b58encode(Buffer.from(sha, "hex")), source_commit: HEAD };
  assert.deepEqual(recordSourceProblems(rec), []);
  assert.deepEqual(recordSourceProblems({ non_reproducible: "an earlier host build" }), []);
  assert.match(recordSourceProblems({ ...rec, non_reproducible: "x" }).join(";"), /names both source_commit and non_reproducible/);
  assert.match(recordSourceProblems({ wasm_sha256: sha }).join(";"), /names neither source_commit/);
  assert.match(recordSourceProblems({ non_reproducible: " " }).join(";"), /gives no reason/);
  assert.match(recordSourceProblems({ ...rec, source_commit: "main" }).join(";"), /source_commit "main" is not a 40-hex commit/);
  assert.match(recordSourceProblems({ ...rec, code_hash: "x" }).join(";"), /code_hash x is not the base58/);
  const records = vaultRecords();
  assert.deepEqual(records.map((r) => r.name), ["mainnet-test.json", "testnet-skeleton.json", "testnet-v1.json", "testnet-v3.json", "testnet-v4.json"]);
  for (const { name, record } of records) {
    assert.deepEqual(recordSourceProblems(record), [], name);
    // testnet-v3 (card vault-review-fixes-3) is the first reproducible deploy and testnet-v4 (card vault-final-sha) the
    // vault's final commit: each names its commit; the earlier are marked
    if (name === "testnet-v3.json" || name === "testnet-v4.json") assert.match(record.source_commit, /^[0-9a-f]{40}$/, name);
    else assert.ok(Object.hasOwn(record, "non_reproducible"), `${name} is not marked`);
  }
});

test("the record a deploy writes names its source, so --verify-records can check it: a build here its commit, a --wasm file non_reproducible, mainnet the --deployment record's", async () => {
  const { deploySource, recordSourceProblems } = await import(SCRIPT);
  const sha = "ab".repeat(32);
  const written = (src) => ({ network: "testnet", version: "blindfill-vault 0.1.0 testnet", wasm_sha256: sha, code_hash: b58encode(Buffer.from(sha, "hex")), ...src });
  assert.deepEqual(deploySource({ network: "testnet", commit: HEAD }), { source_commit: HEAD });
  assert.deepEqual(recordSourceProblems(written(deploySource({ network: "testnet", commit: HEAD }))), []);
  assert.deepEqual(recordSourceProblems(written(deploySource({ network: "sandbox", commit: HEAD }))), []);
  const given = deploySource({ network: "sandbox", wasmFile: "/tmp/x/vault.wasm" });
  assert.match(given.non_reproducible, /--wasm vault\.wasm/);
  assert.deepEqual(recordSourceProblems(written(given)), []);
  assert.deepEqual(deploySource({ network: "mainnet", wasmFile: "/tmp/x/vault.wasm" }), {});
  // both records the run writes (the partial one at the send, the whole one after the read-back) carry it
  const src = readFileSync(SCRIPT, "utf8");
  assert.equal(src.match(/\.\.\.\(network === "mainnet" \? record : \{\}\),\s*\.\.\.source,/g)?.length, 2, "a record write without ...source");
});

test("mainnet: a record marked non_reproducible, a wasm naming another commit, or a record commit on no branch of the repository is refused before any send", async () => {
  const { pinProblems } = await import(SCRIPT);
  const w = mainnetWasm();
  const pin = sha256hex(w);
  const good = { network: "mainnet", account_id: MAINNET_VAULT, wasm_sha256: pin, wasm_builds_sha256: [pin, pin], code_hash: b58encode(Buffer.from(pin, "hex")), source_commit: HEAD };
  const pins = { [MAINNET_VAULT]: pin };
  assert.deepEqual(pinProblems(w, good, MAINNET_VAULT, pins), []);
  const { source_commit, ...unmarked } = good;
  assert.match(pinProblems(w, { ...unmarked, non_reproducible: "a host build" }, MAINNET_VAULT, pins).join(";"), /marked non_reproducible: a mainnet vault deploys a reproducible build only/);
  assert.match(pinProblems(w, unmarked, MAINNET_VAULT, pins).join(";"), /names neither source_commit/);
  assert.match(pinProblems(w, { ...good, non_reproducible: "x" }, MAINNET_VAULT, pins).join(";"), /names both/);
  const other = mainnetWasm(ALL_EXPORTS, UNFETCHED);
  const op = sha256hex(other);
  assert.match(pinProblems(other, { ...good, wasm_sha256: op, wasm_builds_sha256: [op, op], code_hash: b58encode(Buffer.from(op, "hex")) }, MAINNET_VAULT, { [MAINNET_VAULT]: op }).join(";"), new RegExp(`source_code_snapshot is "git\\+https://github\\.com/UNRLZD/confidential-trenches\\?rev=${UNFETCHED}"`));
  // the CLI's own run: the record's commit is on no branch of the repository
  const dir = fresh();
  const k = keyFile(dir, MAINNET_PARENT);
  const f = mainnetFiles(dir, w);
  const r = runMainnet(dir, mainnetArgs(dir, k.file, f), 10n ** 25n, { pins }, { STUB_GIT_TIP: UNFETCHED });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`refused before any send: commit ${HEAD} is on no branch or tag of https://github\\.com/UNRLZD/confidential-trenches`));
  assert.deepEqual(methods(dir), [], "the run asked an RPC");
});

test("--verify-records: a non-reproducible record is a NOTE, a reproducible one is rebuilt at its own commit and must be its code hash, an unmarked one is refused", async () => {
  const { verifyRecords } = await import(SCRIPT);
  const dir = fresh();
  const env = stubs(dir, wasm({ strings: [MAINNET_USDC], exports: ALL_EXPORTS }));
  const built = readFileSync(env.STUB_WASM_A);
  const sha = sha256hex(built);
  const recs = path.join(dir, "records");
  mkdirSync(recs);
  const write = (name, r) => writeFileSync(path.join(recs, name), JSON.stringify({ network: "mainnet", account_id: `${name}.near`, version: "blindfill-vault 0.1.0 mainnet", ...r }));
  const saved = { PATH: process.env.PATH, STUB_WASM_A: process.env.STUB_WASM_A, STUB_WASM_B: process.env.STUB_WASM_B };
  Object.assign(process.env, { PATH: env.PATH, STUB_WASM_A: env.STUB_WASM_A, STUB_WASM_B: env.STUB_WASM_B });
  const lines = [];
  try {
    write("a-old.json", { wasm_sha256: "cd".repeat(32), code_hash: "x", non_reproducible: "an earlier host build" });
    write("b-repro.json", { wasm_sha256: sha, code_hash: b58encode(Buffer.from(sha, "hex")), source_commit: HEAD });
    writeFileSync(path.join(recs, "c-token.json"), JSON.stringify({ network: "testnet", code_hash: "y" })); // not a vault record
    const done = await verifyRecords({ dir: recs, buildDir: path.join(dir, "v1"), log: (l) => lines.push(l) });
    assert.deepEqual(done.map((d) => [d.name, d.sha ?? "note"]), [["a-old.json", "note"], ["b-repro.json", sha]]);
    assert.ok(lines.some((l) => /^NOTE: a-old\.json \(a-old\.json\.near, code hash x\) was made by a non-reproducible build and is not compared: an earlier host build$/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => l === `b-repro.json: the rebuild of ${HEAD} is sha256 ${sha}, the record's code hash ${b58encode(Buffer.from(sha, "hex"))}`), lines.join("\n"));
    // the build ran in a clone of the record's commit, not in this checkout
    assert.ok(lines.some((l) => l.includes(`(in ${path.join(dir, "v1", "b-repro.json.src", "contracts", "vault")})`)), lines.join("\n"));
    assert.equal(existsSync(path.join(dir, "v1", "b-repro.json.src")), false, "the clone is left");
    // a rebuild that is not the record's code hash, and an unmarked record
    const wrong = "ef".repeat(32);
    write("b-repro.json", { wasm_sha256: wrong, code_hash: b58encode(Buffer.from(wrong, "hex")), source_commit: HEAD });
    // exit 3 for it too (see "--build-only" above): a record that rebuilds to another hash is never retried
    await assert.rejects(verifyRecords({ dir: recs, buildDir: path.join(dir, "v2"), log: () => {} }), (e) => e.exitCode === 3 && new RegExp(`b-repro\\.json: the rebuild of ${HEAD} is sha256 ${sha}, the record's is ${wrong}`).test(e.message));
    write("b-repro.json", { wasm_sha256: sha, code_hash: b58encode(Buffer.from(sha, "hex")) });
    await assert.rejects(verifyRecords({ dir: recs, buildDir: path.join(dir, "v3"), log: () => {} }), /b-repro\.json: the record names neither source_commit/);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("the wasm refusal is fail-closed: any wasmProblems field but functionExports and promiseImports refuses when not empty", () => {
  const ok = { banned: [], promises: [], exports: [], functionExports: ["config", "withdraw"], promiseImports: ["promise_result"] };
  assert.deepEqual(deployProblems(wasm(), "sandbox", () => ok), []);
  // a field the live check adds later (card vault-withdraw-verify: withdraw exported without on_payout)
  const later = deployProblems(wasm(), "sandbox", () => ({ ...ok, withdrawWithoutPayout: ["withdraw"] }));
  assert.equal(later.length, 1, later.join("; "));
  assert.match(later[0], /^withdrawWithoutPayout .*: withdraw$/);
  assert.match(deployProblems(wasm(), "sandbox", () => ({ ...ok, futureRule: "not a list" }))[0], /wasmProblems\.futureRule is not a list/);
  for (const field of ["banned", "promises", "exports"]) assert.equal(deployProblems(wasm(), "sandbox", () => ({ ...ok, [field]: ["x"] })).length, 1, field);
});

test("a wasm exporting withdraw without on_payout is refused before any send, naming withdrawWithoutPayout", () => {
  const dir = fresh();
  const k = keyFile(dir);
  const buildDir = path.join(dir, "build");
  const r = run(dir, testnet(dir, k.file, buildDir), stubs(dir, wasm({ exports: ["config", "withdraw"] })));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /refused before any send: withdrawWithoutPayout \(vault\.md 2\.8, 2\.5\.7\): withdraw/);
  neverSent(r);
  targetsGone(buildDir);
  assert.deepEqual(deployProblems(wasm({ exports: ["config", "withdraw", "on_payout"] }), "testnet"), []);
});

test("the out-of-gas test build (VT-S17, feature test-on-payout-out-of-gas) is refused before any send, naming testBuild", () => {
  // the stub build stands in for `cargo near build ... --features test-on-payout-out-of-gas`: its bytes hold the mark
  // that build's on_payout logs; tests/s17.rs runs deployProblems on the real build
  const dir = fresh();
  const k = keyFile(dir);
  const buildDir = path.join(dir, "build");
  const r = run(dir, testnet(dir, k.file, buildDir), stubs(dir, wasm({ strings: [TESTNET_TOKEN, TEST_BUILD_MARK] })));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /refused before any send: testBuild \(vault\.md 2\.8, 2\.5\.7\): blindfill-vault test build: on_payout runs out of gas/);
  neverSent(r);
  targetsGone(buildDir);
  for (const network of ["sandbox", "testnet"]) {
    assert.deepEqual(deployProblems(wasm({ strings: [TESTNET_TOKEN, TEST_BUILD_MARK] }), network).filter((x) => x.startsWith("testBuild")).length, 1, network);
    assert.deepEqual(deployProblems(wasm(), network), [], network);
  }
});

// ---- the pinned tools ----

test("a cargo-near that is not the pinned one is refused before any build", () => {
  const dir = fresh();
  const k = keyFile(dir);
  const buildDir = path.join(dir, "build");
  const r = run(dir, testnet(dir, k.file, buildDir), { ...stubs(dir, wasm()), STUB_NEAR_VERSION: "cargo-near-near 0.21.0" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`cargo near is "cargo-near-near 0\\.21\\.0", want "${CARGO_NEAR.replace(/\./g, "\\.")}": nothing was built`));
  neverSent(r);
  assert.equal(existsSync(buildDir), false, "a build ran");
  // --build-only checks it too
  const b = run(dir, ["--build-only", "--build-dir", path.join(dir, "build2")], { ...stubs(fresh(), wasm()), STUB_NEAR_VERSION: `${CARGO_NEAR}-dirty` });
  assert.equal(b.status, 1, b.stdout + b.stderr);
  assert.match(b.stderr, /cargo near is .*-dirty", want/);
  assert.equal(existsSync(path.join(dir, "build2")), false, "a build ran");
});

// ---- the RPCs and their chain ----

test("--network sandbox takes a loopback --rpc only: a mainnet URL is refused before any read", () => {
  const dir = fresh();
  const k = keyFile(dir, "test.near");
  const w = path.join(dir, "v.wasm");
  writeFileSync(w, wasm());
  for (const rpc of ["https://rpc.mainnet.near.org", "http://127.0.0.1.nip.io:3030", "http://localhost.example.com:3030"]) {
    const r = run(dir, ["--network", "sandbox", "--rpc", rpc, "--parent", "test.near", "--key-file", k.file, "--wasm", w, "--out", path.join(dir, "o.json")], process.env, {});
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /--network sandbox takes a loopback --rpc only/, rpc);
    neverSent(r);
  }
  assert.deepEqual(methods(dir), [], "an RPC was asked");
  for (const ok of ["http://localhost:3030", "http://127.0.0.1:3030", "http://127.4.5.6:1", "http://[::1]:3030"]) assert.deepEqual(rpcProblems("sandbox", ok), [], ok);
  for (const bad of ["ftp://localhost:3030", "not a url", "http://[::2]:3030"]) assert.equal(rpcProblems("sandbox", bad).length, 1, bad);
  assert.deepEqual(rpcProblems("testnet", "https://test.rpc.fastnear.com"), []);
});

test("an RPC that answers the wrong chain_id is refused before any other read: either testnet RPC, or a sandbox that is not one", () => {
  const [a, b] = ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"];
  for (const [chains, bad] of [[{ [a]: "mainnet", [b]: "testnet" }, a], [{ [a]: "testnet", [b]: "mainnet" }, b]]) {
    const dir = fresh();
    const k = keyFile(dir);
    const buildDir = path.join(dir, "build");
    const r = run(dir, testnet(dir, k.file, buildDir), stubs(dir, wasm()), chains);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.stderr.includes(`refused before any send: ${bad}: chain_id "mainnet", want "testnet"`), r.stderr);
    neverSent(r);
    assert.deepEqual(methods(dir), bad === a ? [`status ${a}`] : [`status ${a}`, `status ${b}`]);
    targetsGone(buildDir);
  }
  // a loopback RPC that is a tunnel to testnet is not a sandbox
  const dir = fresh();
  const k = keyFile(dir, "test.near");
  const w = path.join(dir, "v.wasm");
  writeFileSync(w, wasm());
  const rpc = "http://127.0.0.1:3030";
  const r = run(dir, ["--network", "sandbox", "--rpc", rpc, "--parent", "test.near", "--key-file", k.file, "--wasm", w, "--out", path.join(dir, "o.json")], process.env, { [rpc]: "testnet" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /refused before any send: http:\/\/127\.0\.0\.1:3030: chain_id "testnet", want near-sandbox's test-chain-<id>/);
  assert.deepEqual(methods(dir), [`status ${rpc}`]);
  assert.deepEqual(chainProblems("sandbox", "test-chain-Ab3x9"), []);
  assert.equal(chainProblems("testnet", "test-chain-Ab3x9").length, 1);
});

// ---- the registration ----

test("storage_deposit is signed only for a fixed bound (min = max) of at most 0.01 N", () => {
  assert.equal(MAX_REGISTRATION, 10n ** 22n);
  // Circle's testnet USDC, read 2026-11-01
  assert.deepEqual(registrationProblems({ min: "1250000000000000000000", max: "1250000000000000000000" }), []);
  assert.deepEqual(registrationProblems({ min: String(MAX_REGISTRATION), max: String(MAX_REGISTRATION) }), []);
  assert.match(registrationProblems({ min: "1250000000000000000000", max: "2500000000000000000000" }).join(), /min 1250000000000000000000 is not max 2500000000000000000000/);
  assert.match(registrationProblems({ min: String(MAX_REGISTRATION + 1n), max: String(MAX_REGISTRATION + 1n) }).join(), /is over MAX_REGISTRATION/);
  assert.match(registrationProblems({ min: "1250000000000000000000", max: null }).join(), /is not \{min, max\}/);
  assert.match(registrationProblems(null).join(), /is not \{min, max\}/);
});

// ---- paths ----

test("a key file inside a root is refused when its path or the root's is spelled in another case", (t) => {
  const d = fresh();
  const k = keyFile(d);
  const flip = (p) => p.replace(/deploy-test-/, "DEPLOY-TEST-");
  if (!existsSync(flip(k.file))) return t.skip("the file system is case-sensitive");
  assert.throws(() => loadKey(flip(k.file), PARENT, [TMP]), /--key-file is inside the repository/);
  assert.throws(() => loadKey(k.file, PARENT, [flip(TMP)]), /--key-file is inside the repository/);
});

// ---- interrupts ----

const waitFor = async (f, ms = 30_000) => {
  for (let t = 0; t < ms && !existsSync(f); t += 20) await new Promise((r) => setTimeout(r, 20));
  assert.ok(existsSync(f), `never made: ${f}`);
};
const EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131 };

for (const sig of STOP_SIGNALS) {
  test(`${sig} during a build stops it and removes both target dirs (exit ${EXIT[sig]})`, async () => {
    const dir = fresh();
    const buildDir = path.join(dir, "build");
    const { c, done } = start(dir, ["--build-only", "--build-dir", buildDir], { ...stubs(dir, wasm()), STUB_SLEEP: "30" });
    const pidFile = path.join(buildDir, "build.pid");
    await waitFor(pidFile);
    const buildPid = Number(readFileSync(pidFile, "utf8"));
    const started = Date.now();
    c.kill(sig);
    const r = await done;
    assert.ok(Date.now() - started < 10_000, "the run waited for the build");
    assert.equal(r.code, EXIT[sig], `exit ${r.code} signal ${r.signal}: ${r.output}`);
    assert.match(r.output, new RegExp(`interrupted by ${sig}`));
    targetsGone(buildDir);
    assert.throws(() => process.kill(buildPid, 0), /ESRCH/, "the build is still running");
  });
}

test("a second SIGINT while a target dir is being removed does not stop the removal (exit 130, both dirs gone)", async () => {
  const dir = fresh();
  const buildDir = path.join(dir, "build");
  const { c, done } = start(dir, ["--build-only", "--build-dir", buildDir], { ...stubs(dir, wasm()), STUB_FILES: "80000", STUB_SLEEP: "60" });
  await waitFor(path.join(buildDir, "build.pid"), 120_000);
  c.kill("SIGINT");
  await new Promise((r) => setTimeout(r, 150));
  c.kill("SIGINT");
  const r = await done;
  assert.equal(r.code, 130, `exit ${r.code} signal ${r.signal}: ${r.output}`);
  targetsGone(buildDir);
});

test("a SIGINT while the script reads build b's wasm stops the run before any RPC is asked (exit 130)", async () => {
  const dir = fresh();
  const k = keyFile(dir);
  const buildDir = path.join(dir, "build");
  const { c, done } = start(dir, testnet(dir, k.file, buildDir), { ...stubs(dir, wasm()), STUB_FIFO_B: "1" }, { "https://test.rpc.fastnear.com": "testnet", "https://near-testnet.drpc.org": "testnet" });
  await waitFor(path.join(buildDir, "b.exited"));
  await new Promise((r) => setTimeout(r, 300));
  c.kill("SIGINT");
  const r = await done;
  assert.equal(r.code, 130, `exit ${r.code} signal ${r.signal}: ${r.output}`);
  assert.deepEqual(methods(dir), [], "an RPC was asked after the SIGINT");
  targetsGone(buildDir);
});

// ---- redirects ----

test("an RPC answer is never taken from a redirect: a 307 from the sandbox --rpc is refused, its target never asked", async () => {
  const dir = fresh();
  const k = keyFile(dir, "test.near");
  const w = path.join(dir, "v.wasm");
  writeFileSync(w, wasm());
  const asked = [];
  const target = http.createServer((req, res) => {
    asked.push(req.method);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: "deploy", result: { chain_id: "test-chain-abc12", permission: "FullAccess", nonce: 1 } }));
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const redirect = http.createServer((req, res) => {
    res.statusCode = 307;
    res.setHeader("location", `http://127.0.0.1:${target.address().port}/`);
    res.end();
  });
  await new Promise((r) => redirect.listen(0, "127.0.0.1", r));
  try {
    const rpc = `http://127.0.0.1:${redirect.address().port}`;
    const r = await start(dir, ["--network", "sandbox", "--rpc", rpc, "--parent", "test.near", "--key-file", k.file, "--wasm", w, "--out", path.join(dir, "o.json")], process.env, false).done;
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, /deploy: ERROR: .*redirect/i);
    assert.deepEqual(asked, [], "the redirect's target was asked");
  } finally {
    target.close();
    redirect.close();
  }
});

// ---- mainnet (card vault-mainnet-test): the owner's paste deploys the pinned wasm, or nothing ----
// Each refusal is read from the CLI's own run (or, for the batch, from deploy.mjs's own check of the encoded tx); the
// new exports are imported at run time, so on a deploy.mjs without them the file still loads and each test fails alone.

const MAINNET_PARENT = "bf-test.near";
const MAINNET_VAULT = `vault-test.${MAINNET_PARENT}`;
const ALL_EXPORTS = ["config", "contract_source_metadata", "deposits", "ft_on_transfer", "is_known_label_root", "is_known_state_root", "label_tree", "labels", "leaves", "on_payout", "ragequit", "settle", "spends", "state_tree", "storage_prepay", "totals", "withdraw"];
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");

// the mainnet wasm `w` on disk and a pre-deploy record pinning `pin` (the wasm's own sha256 unless a test plants another)
function mainnetFiles(dir, w, pin = sha256hex(w)) {
  const file = path.join(dir, "mainnet.wasm");
  writeFileSync(file, w);
  const record = path.join(dir, "mainnet-test.json");
  writeFileSync(record, JSON.stringify({ network: "mainnet", account_id: MAINNET_VAULT, parent: MAINNET_PARENT, wasm_sha256: pin, wasm_builds_sha256: [pin, pin], code_hash: b58encode(Buffer.from(pin, "hex")), source_commit: HEAD, build: "test" }));
  return { file, record };
}
const mainnetArgs = (dir, key, f) => ["--network", "mainnet", "--parent", MAINNET_PARENT, "--vault", MAINNET_VAULT, "--key-file", key, "--wasm", f.file, "--deployment", f.record, "--out", path.join(dir, "out.json")];

// a fetch module answering a mainnet parent's reads: chain_id mainnet on both RPCs, the parent's full key, no vault yet,
// the parent's balance `amount`, a final block; every other method (send_tx above all) is blocked and logged, and a
// send_tx's signed_tx_base64 is kept in <dir>/sent.txt. With `pins`, a load hook gives deploy.mjs those MAINNET_PINS (the
// test vault's own wasm, which the real pin cannot be); with `mutateRecipe`, near-tx.mjs's recipeTx appends an AddKey.
function mainnetNet(dir, amount, { pins, mutateRecipe = false } = {}) {
  const f = path.join(dir, "mainnet-net.mjs");
  const log = path.join(dir, "methods.log");
  const hook =
    `import { registerHooks } from "node:module";\n` +
    `registerHooks({ load(url, context, next) { const r = next(url, context);\n` +
    (pins ? `  if (url.endsWith("/contracts/vault/scripts/deploy.mjs")) { const src = String(r.source); const out = src.replace(/^export const MAINNET_PINS = \\{.*\\};$/m, ${JSON.stringify(`export const MAINNET_PINS = ${JSON.stringify(pins)};`)}); if (out === src) throw new Error("the test found no MAINNET_PINS line"); r.source = out; }\n` : "") +
    (mutateRecipe ? `  if (url.endsWith("/contracts/vault/scripts/near-tx.mjs")) { const src = String(r.source); const out = src.replace("export function recipeTx(", "function recipeTx0(") + "\\nexport function recipeTx(a) { const t = recipeTx0(a); const at = 4 + Buffer.byteLength(a.signer) + 1 + 32 + 8 + 4 + Buffer.byteLength(a.receiver) + 32; const c = Buffer.from(t); c.writeUInt32LE(5, at); return Buffer.concat([c, new Borsh().u8(5).u8(0).fixed(Buffer.alloc(32, 3)).u64(0).u8(1).done()]); }\\n"; if (out === src) throw new Error("the test found no recipeTx"); r.source = out; }\n` : "") +
    `  return r; } });\n`;
  writeFileSync(
    f,
    hook +
      `import { appendFileSync, writeFileSync } from "node:fs";\n` +
      `const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: "deploy", result }) });\n` +
      `globalThis.fetch = async (url, init) => { const { method, params } = JSON.parse(init.body); appendFileSync(${JSON.stringify(log)}, method + " " + (params?.request_type ?? "") + " " + url + "\\n");\n` +
      `  if (method === "status") return ok({ chain_id: "mainnet" });\n` +
      `  if (method === "query" && params.request_type === "view_access_key") return ok({ permission: "FullAccess", nonce: 7 });\n` +
      `  if (method === "query" && params.request_type === "view_account" && params.account_id === ${JSON.stringify(MAINNET_VAULT)}) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: "deploy", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }) };\n` +
      `  if (method === "query" && params.request_type === "view_account" && params.account_id === ${JSON.stringify(MAINNET_PARENT)}) return ok({ amount: ${JSON.stringify(String(amount))}, locked: "0" });\n` +
      `  if (method === "block") return ok({ header: { hash: "11111111111111111111111111111111" } });\n` +
      `  if (method === "send_tx") writeFileSync(${JSON.stringify(path.join(dir, "sent.txt"))}, params.signed_tx_base64);\n` +
      "  throw new Error(`network blocked by the test: ${method} ${url}`); };\n",
  );
  return f;
}
const runMainnet = (dir, args, amount, o, env = {}) => spawnSync(process.execPath, ["--import", pathToFileURL(mainnetNet(dir, amount, o)).href, SCRIPT, ...args], { encoding: "utf8", timeout: 30_000, env: { ...gitEnv(dir), ...env } });
// a reproducible mainnet build of HEAD: its NEP-330 metadata names HEAD
const mainnetWasm = (exports = ALL_EXPORTS, commit = HEAD) => withStrings(wasm({ strings: [MAINNET_USDC], exports }), JSON.stringify(meta({ commit })));

test("mainnet (a): a wasm whose sha256 is not the record's pin is refused before any send", () => {
  const dir = fresh();
  const k = keyFile(dir, MAINNET_PARENT);
  const f = mainnetFiles(dir, mainnetWasm(), "ab".repeat(32));
  const r = run(dir, mainnetArgs(dir, k.file, f));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /refused before any send: .*the wasm's sha256 [0-9a-f]{64} is not the pin abab/);
  neverSent(r);
});

test("mainnet (a): a record whose builds disagree, or that is another vault's or another network's, is refused before any send", async () => {
  const { pinProblems } = await import(SCRIPT);
  const w = mainnetWasm();
  const pin = sha256hex(w);
  const good = { network: "mainnet", account_id: MAINNET_VAULT, wasm_sha256: pin, wasm_builds_sha256: [pin, pin], code_hash: b58encode(Buffer.from(pin, "hex")), source_commit: HEAD };
  const pins = { [MAINNET_VAULT]: pin };
  assert.deepEqual(pinProblems(w, good, MAINNET_VAULT, pins), []);
  assert.match(pinProblems(w, { ...good, wasm_builds_sha256: [pin] }, MAINNET_VAULT, pins).join(";"), /builds do not all agree/);
  assert.match(pinProblems(w, { ...good, wasm_builds_sha256: [pin, "cd".repeat(32)] }, MAINNET_VAULT, pins).join(";"), /builds do not all agree/);
  assert.match(pinProblems(w, { ...good, code_hash: "x" }, MAINNET_VAULT, pins).join(";"), /code_hash x is not the base58/);
  assert.match(pinProblems(w, { ...good, network: "testnet" }, MAINNET_VAULT, pins).join(";"), /a testnet record, not mainnet/);
  assert.match(pinProblems(w, good, `vault.${MAINNET_PARENT}`, { ...pins, [`vault.${MAINNET_PARENT}`]: pin }).join(";"), /not vault\.bf-test\.near's/);
  assert.match(pinProblems(w, { ...good, wasm_sha256: undefined }, MAINNET_VAULT, pins).join(";"), /pins no wasm_sha256/);
});

test("mainnet (b): a pinned wasm missing a required export (settle) is refused before any send", () => {
  const dir = fresh();
  const k = keyFile(dir, MAINNET_PARENT);
  const f = mainnetFiles(dir, mainnetWasm(ALL_EXPORTS.filter((e) => e !== "settle")));
  const r = run(dir, mainnetArgs(dir, k.file, f));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /refused before any send: missing exports \(vault\.md 2\.5\.7\): settle/);
  neverSent(r);
});

test("mainnet (b): each of the seven required exports is required, and a testnet build or a test token is refused", async () => {
  const { REQUIRED_EXPORTS } = await import(SCRIPT);
  assert.deepEqual([...REQUIRED_EXPORTS].sort(), ["config", "ft_on_transfer", "on_payout", "ragequit", "settle", "storage_prepay", "withdraw"]);
  for (const e of REQUIRED_EXPORTS) {
    // withdraw without on_payout also trips withdrawWithoutPayout; the missing line names the export either way
    const p = deployProblems(mainnetWasm(ALL_EXPORTS.filter((x) => x !== e)), "mainnet");
    assert.ok(p.some((x) => x === `missing exports (vault.md 2.5.7): ${e}`), `${e}: ${p.join("; ")}`);
  }
  assert.deepEqual(deployProblems(mainnetWasm(), "mainnet"), []);
  assert.match(deployProblems(wasm({ strings: [TESTNET_TOKEN], exports: ALL_EXPORTS }), "mainnet").join(";"), /not a mainnet build: does not hold mainnet USDC.*holds the testnet token/);
  // testnet's rules are as they were: no required exports there
  assert.deepEqual(deployProblems(wasm(), "testnet"), []);
});

test("mainnet (c): a parent too poor for the code storage, the registration and the gas is refused before any send", () => {
  const dir = fresh();
  const k = keyFile(dir, MAINNET_PARENT);
  const w = mainnetWasm();
  const f = mainnetFiles(dir, w);
  const need = BigInt(w.length + 100) * 10n ** 19n + 10n ** 22n + 10n ** 22n + 5n * 10n ** 22n;
  const r = runMainnet(dir, mainnetArgs(dir, k.file, f), need - 1n, { pins: { [MAINNET_VAULT]: sha256hex(w) } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`refused before any send: the parent holds ${need - 1n} yocto, short of ${need}`));
  assert.ok(!methods(dir).some((m) => m.startsWith("send_tx")), methods(dir).join("\n"));
  // both mainnet operators were asked for the chain id before anything else
  assert.deepEqual(methods(dir).slice(0, 2), ["status  https://rpc.mainnet.fastnear.com", "status  https://near.drpc.org"]);
});

test("mainnet (c): a parent holding exactly enough gets to the send, and only then", async () => {
  const dir = fresh();
  const k = keyFile(dir, MAINNET_PARENT);
  const w = mainnetWasm();
  const f = mainnetFiles(dir, w);
  const need = BigInt(w.length + 100) * 10n ** 19n + 10n ** 22n + 10n ** 22n + 5n * 10n ** 22n;
  const r = runMainnet(dir, mainnetArgs(dir, k.file, f), need, { pins: { [MAINNET_VAULT]: sha256hex(w) } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /network blocked by the test: send_tx https:\/\/rpc\.mainnet\.fastnear\.com/);
  // review LOW 2: the bytes sent are exactly the four actions, to the vault, with the code storage attached; LOW 5:
  // their hash was printed before the send
  const { txActionTags } = await import(SCRIPT);
  const signed = Buffer.from(readFileSync(path.join(dir, "sent.txt"), "utf8"), "base64");
  const tx = signed.subarray(0, signed.length - 65);
  assert.equal(signed[signed.length - 65], 0, "not an ed25519 signature");
  assert.deepEqual(txActionTags(tx), [0, 3, 1, 2]);
  assert.ok(tx.includes(Buffer.from(MAINNET_VAULT)), "the receiver is not the vault");
  assert.ok(tx.includes(w), "the wasm sent is not the pinned one");
  const hash = b58encode(createHash("sha256").update(tx).digest());
  assert.match(r.stdout, new RegExp(`sending tx ${hash}: \\[CreateAccount, Transfer\\(${BigInt(w.length + 100) * 10n ** 19n + 10n ** 22n}\\), DeployContract\\(${w.length} B\\), FunctionCall\\(config, 100 Tgas, 0\\)\\] from ${MAINNET_PARENT} to ${MAINNET_VAULT}, no AddKey`));
});

test("mainnet (d): a recipe that would carry an AddKey is refused before send_tx, in the CLI's own run", () => {
  const dir = fresh();
  const k = keyFile(dir, MAINNET_PARENT);
  const w = mainnetWasm();
  const f = mainnetFiles(dir, w);
  const r = runMainnet(dir, mainnetArgs(dir, k.file, f), 10n ** 25n, { pins: { [MAINNET_VAULT]: sha256hex(w) }, mutateRecipe: true });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /refused before any send: the batch's actions are \[0, 3, 1, 2, 5\]/);
  assert.ok(!methods(dir).some((m) => m.startsWith("send_tx")), methods(dir).join("\n"));
  assert.equal(existsSync(path.join(dir, "sent.txt")), false, "a tx was sent");
});

// review MED-1: the pin lives in deploy.mjs too, so a record edited to match another wasm cannot move it
test("mainnet MED-1: a record pinning a changed wasm for the real vault is refused before any RPC, by MAINNET_PINS", () => {
  const dir = fresh();
  const k = keyFile(dir, "confidential.unrlzd.near");
  const w = mainnetWasm();
  const file = path.join(dir, "changed.wasm");
  writeFileSync(file, w);
  const pin = sha256hex(w);
  const record = path.join(dir, "edited-record.json");
  writeFileSync(record, JSON.stringify({ network: "mainnet", account_id: "vault-test.confidential.unrlzd.near", parent: "confidential.unrlzd.near", wasm_sha256: pin, wasm_builds_sha256: [pin, pin], code_hash: b58encode(Buffer.from(pin, "hex")) }));
  const r = run(dir, ["--network", "mainnet", "--parent", "confidential.unrlzd.near", "--vault", "vault-test.confidential.unrlzd.near", "--key-file", k.file, "--wasm", file, "--deployment", record, "--out", path.join(dir, "out.json")]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /refused before any send: .*the wasm's sha256 [0-9a-f]{64} is not MAINNET_PINS' pin 57535ae7486f840d9c9d29934e265712c44ada1992abc14344e431c2f2caca6a for vault-test\.confidential\.unrlzd\.near/);
  assert.match(r.stderr, /the record's pin [0-9a-f]{64} is not MAINNET_PINS' pin 57535ae7/);
  neverSent(r);
});

test("mainnet MED-1: MAINNET_PINS names the test vault's pin, the one mainnet-test.json holds", async () => {
  const { MAINNET_PINS, pinProblems } = await import(SCRIPT);
  const rec = JSON.parse(readFileSync(path.join(HERE, "..", "deployments", "mainnet-test.json"), "utf8"));
  assert.deepEqual(MAINNET_PINS, { [rec.account_id]: rec.wasm_sha256 });
  // another vault has no pin at all
  const w = mainnetWasm();
  assert.match(pinProblems(w, { ...rec, account_id: "vault.confidential.unrlzd.near" }, "vault.confidential.unrlzd.near").join(";"), /MAINNET_PINS holds no pin for vault\.confidential\.unrlzd\.near/);
});

test("mainnet (d): a batch that would leave a key on the vault (an AddKey, or any action past the four) is refused", async () => {
  const { recipeProblems, txActionTags } = await import(SCRIPT);
  const { recipeTx, Borsh } = await import("./near-tx.mjs");
  const args = { signer: MAINNET_PARENT, publicKey: Buffer.alloc(32, 1), nonce: 8n, receiver: MAINNET_VAULT, blockHash: Buffer.alloc(32, 2), wasm: mainnetWasm(), transfer: 5n, configGas: 10n ** 14n };
  const tx = recipeTx(args);
  assert.deepEqual(txActionTags(tx), [0, 3, 1, 2]);
  assert.deepEqual(recipeProblems(tx), []);
  // the same four actions with an AddKey (tag 5, a full-access key) after them: the action count says 5
  const head = Buffer.from(recipeTx({ ...args }));
  const count = 4 + MAINNET_PARENT.length + 1 + 32 + 8 + 4 + MAINNET_VAULT.length + 32;
  const withKey = Buffer.concat([head.subarray(0, count), Buffer.from([5, 0, 0, 0]), head.subarray(count + 4), new Borsh().u8(5).u8(0).fixed(Buffer.alloc(32, 3)).u64(0).u8(1).done()]);
  assert.deepEqual(txActionTags(withKey), [0, 3, 1, 2, 5]);
  assert.match(recipeProblems(withKey).join(";"), /want exactly \[0, 3, 1, 2\].*no AddKey/);
  // an AddKey in place of the config call
  const swapped = Buffer.from(tx);
  swapped[swapped.length - (1 + 4 + 6 + 4 + 2 + 8 + 16)] = 5;
  assert.deepEqual(txActionTags(swapped)[3], 5);
  assert.ok(recipeProblems(swapped).length, "an AddKey in the fourth place passed");
});

test("mainnet: deploy.mjs sends to the two RPCs the mainnet read-back reads (vault-mainnet.mjs MAINNET_RPCS)", async () => {
  const { MAINNET_RPCS } = await import(SCRIPT);
  const { MAINNET_RPCS: READ } = await import("../../../scripts/live-checks/vault-mainnet.mjs");
  assert.deepEqual(MAINNET_RPCS, READ);
});

// review LOW 4: the vault-build workflow runs on a change to any file its build and pin steps read, deploy.mjs's own
// imports included (a static `import ... from "./x"` of a repository file, followed through each file it reaches)
test("vault-build.yml's paths hold contracts/vault/ and every repository file deploy.mjs imports", () => {
  const root = path.resolve(HERE, "../../..");
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const m of readFileSync(f, "utf8").matchAll(/^\s*import\s+(?:[^"']*?from\s+)?["']([^"']+)["']/gm)) if (m[1].startsWith(".")) walk(path.resolve(path.dirname(f), m[1]));
  };
  walk(SCRIPT);
  const outside = [...seen].map((f) => path.relative(root, f)).filter((f) => !f.startsWith("contracts/vault/")).sort();
  assert.deepEqual(outside, ["scripts/ci/near-rpc-operators.mjs", "scripts/ci/rpc-wait.mjs", "scripts/live-checks/vault-skeleton.mjs", "scripts/live-checks/vault-testnet-t01.mjs", "scripts/net-window.mjs"]);
  const yml = readFileSync(path.join(root, ".github/workflows/vault-build.yml"), "utf8");
  for (const f of ["contracts/vault/**", ...outside, "scripts/ci/retry.sh", "scripts/ci/fetch.sh"]) assert.ok(yml.includes(`      - "${f}"\n`), `vault-build.yml's paths miss ${f}`);
});
