// node --test contracts/vault/scripts/deploy.test.mjs: deploy.mjs's refusals, offline. No test reaches a network or
// builds the vault:
//   - every spawned run imports a module that replaces fetch with one that throws, so a refusal "before any send" is
//     one whose output never names the blocked fetch;
//   - `cargo` and `rustc` are stubs put first on PATH: the cargo stub copies a planted wasm into the CARGO_TARGET_DIR it
//     is given (STUB_WASM_A for target dir `a`, STUB_WASM_B for `b`), so the two builds can be made equal or different;
//   - `cargo +1.96.0 near --version` answers the pinned CARGO_NEAR unless a test plants another (STUB_NEAR_VERSION);
//     STUB_SLEEP makes each build wait that many seconds, so a test can interrupt one;
//   - a test that needs an RPC's status answers swaps the blocking fetch for one that answers `status` alone with the
//     chain ids it is given and blocks every other method;
//   - the key is the published all-zero ed25519 seed (32 zero bytes; its public key 3b6a27bc…da29 is checked below),
//     written at run time to a temp dir outside both checkouts and removed afterwards. It never funds anything.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CARGO_NEAR, chainProblems, deployProblems, loadKey, MAX_FUNCTION_BODY, MAX_REGISTRATION, registrationProblems, repoRoots, rpcProblems } from "./deploy.mjs";
import { b58encode } from "./near-tx.mjs";
import { TESTNET_USDC } from "../../../scripts/live-checks/vault-skeleton.mjs";

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
function wasm({ body = 4, strings = [TESTNET_USDC], exports = ["config"] } = {}) {
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

// Stub cargo and rustc in <dir>/bin, and the planted wasm files; the env a run needs.
function stubs(dir, a, b = a) {
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const fa = path.join(dir, "a.wasm");
  const fb = path.join(dir, "b.wasm");
  writeFileSync(fa, a);
  writeFileSync(fb, b);
  writeFileSync(
    path.join(bin, "cargo"),
    `#!/bin/sh\ncase " $* " in *" --version "*) echo "\${STUB_NEAR_VERSION:-${CARGO_NEAR}}"; exit 0;; esac\n` +
      'mkdir -p "$CARGO_TARGET_DIR/near"\n' +
      'if [ -n "$STUB_SLEEP" ]; then echo $$ > "$CARGO_TARGET_DIR/../build.pid"; sleep "$STUB_SLEEP"; fi\n' +
      'if [ "$(basename "$CARGO_TARGET_DIR")" = a ]; then cp "$STUB_WASM_A" "$CARGO_TARGET_DIR/near/blindfill_vault.wasm"; else cp "$STUB_WASM_B" "$CARGO_TARGET_DIR/near/blindfill_vault.wasm"; fi\n',
  );
  writeFileSync(path.join(bin, "rustc"), '#!/bin/sh\necho "rustc 1.96.0 (stub)"\n');
  chmodSync(path.join(bin, "cargo"), 0o755);
  chmodSync(path.join(bin, "rustc"), 0o755);
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_WASM_A: fa, STUB_WASM_B: fb };
}

// deploy.mjs with `args`, fetch blocked; with `chains` ({ url: chain_id }), `status` alone answers, with that chain id,
// and every method asked is appended to <dir>/methods.log
function run(dir, args, env = process.env, chains = null) {
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
  return spawnSync(process.execPath, ["--import", pathToFileURL(block).href, SCRIPT, ...args], { encoding: "utf8", timeout: 30_000, env });
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

test("--network mainnet is refused before any build or send", () => {
  const dir = fresh();
  const k = keyFile(dir);
  const buildDir = path.join(dir, "build");
  const r = run(dir, ["--network", "mainnet", "--parent", "bf-test.near", "--key-file", k.file, "--build-dir", buildDir], stubs(dir, wasm()));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /no mainnet: a mainnet vault deploy is the owner's/);
  neverSent(r);
  assert.equal(existsSync(buildDir), false, "a build ran");
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

test("two clean builds that differ stop the run before any send, and both target dirs are gone", () => {
  const dir = fresh();
  const k = keyFile(dir);
  const buildDir = path.join(dir, "build");
  const r = run(dir, testnet(dir, k.file, buildDir), stubs(dir, wasm(), wasm({ strings: [TESTNET_USDC, "another build"] })));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /the two clean builds differ: [0-9a-f]{64} \(\d+ B\) and [0-9a-f]{64} \(\d+ B\); nothing was sent/);
  neverSent(r);
  targetsGone(buildDir);
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

for (const sig of ["SIGINT", "SIGTERM"]) {
  test(`${sig} during a build stops it and removes both target dirs`, async () => {
    const dir = fresh();
    const buildDir = path.join(dir, "build");
    const block = path.join(dir, "no-network.mjs");
    writeFileSync(block, 'globalThis.fetch = async (url) => { throw new Error(`network blocked by the test: ${url}`); };\n');
    const c = spawn(process.execPath, ["--import", pathToFileURL(block).href, SCRIPT, "--build-only", "--build-dir", buildDir], { env: { ...stubs(dir, wasm()), STUB_SLEEP: "30" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    c.stdout.on("data", (x) => (output += x));
    c.stderr.on("data", (x) => (output += x));
    const pidFile = path.join(buildDir, "build.pid");
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(path.join(buildDir, "a")), `build a never started: ${output}`);
    const buildPid = Number(readFileSync(pidFile, "utf8"));
    const started = Date.now();
    c.kill(sig);
    const [code] = await new Promise((r) => c.on("close", (...x) => r(x)));
    assert.ok(Date.now() - started < 10_000, "the run waited for the build");
    assert.equal(code, 128 + { SIGINT: 2, SIGTERM: 15 }[sig], output);
    assert.match(output, new RegExp(`interrupted by ${sig}`));
    targetsGone(buildDir);
    assert.throws(() => process.kill(buildPid, 0), /ESRCH/, "the build is still running");
  });
}
