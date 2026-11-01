#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Builds the vault reproducibly, deploys it with no key and registers it on its token (vault.md 2.8, V1.6).
//
// 1. Build: two clean builds with the pinned toolchain and flags, each in its own new target dir, and their sha256
//    compared. Two different builds stop the run before anything is sent. The flags are fixed here: Rust 1.96.0,
//    cargo-near's `build non-reproducible-wasm --no-embed-abi --locked`, the release profile of Cargo.toml, and
//    RUSTFLAGS `-C link-arg=-s --remap-path-prefix=<CARGO_HOME>=/cargo`, so no home path of the machine that built it
//    is in the bytes (near-sdk's panic locations name the registry's source paths). Two machines of different
//    architectures still build different bytes (tests/harness/mod.rs names a Linux x86_64 and a macOS arm64 build).
// 2. Static checks on the wasm: none of 2.8's banned imports, its promise imports inside the seven, its exports inside
//    2.5.7's list (scripts/live-checks/vault-skeleton.mjs wasmProblems); every function body at most 196,608 B
//    (`max_function_body_size`); a testnet deploy must be the testnet build (it names Circle's testnet USDC).
// 3. The recipe: the parent signs one transaction to vault.<parent> with [CreateAccount, Transfer(code storage +
//    0.01 N), DeployContract(wasm), FunctionCall(config, 0 deposit)] and no AddKey; the config() call in the same
//    receipt compiles and runs the wasm, so a wasm that cannot run rolls the whole batch back. The +0.01 N (1,000 B)
//    pays the 200 B state record the first storage_prepay writes (2.3).
// 4. Read back: `view_access_key_list` is `keys: []` on every read (testnet: two RPCs at final; sandbox: its RPC at
//    optimistic and at final), and the code hash is the build's.
// 5. Registration: the parent calls the token config() names, `storage_deposit(vault, registration_only)` with the
//    token's own `storage_balance_bounds().min`, then reads `storage_balance_of(vault)` back.
// It writes the record (--out) and prints the live check to run next.
//
// The signer's key comes from --key-file, a path given at run time: the near CLI's keychain file
// (~/.near-credentials/<network>/<parent>.json) or any file holding {account_id, public_key, private_key}. A path inside
// this repository is refused. The key is read into this process only, to sign: it is never printed, written or sent.
// Sandbox runs use the sandbox's own genesis key. No mainnet: a mainnet deploy is the owner's, by another card.
//
//   node contracts/vault/scripts/deploy.mjs --build-only [--flavor testnet|mainnet] [--build-dir <new dir>]
//   node contracts/vault/scripts/deploy.mjs --network testnet --parent <name>.testnet --key-file <path>
//     [--vault <label>.<parent>] [--build-dir <new dir>] [--out <file>]
//   node contracts/vault/scripts/deploy.mjs --network sandbox --rpc <url> --parent <id> --key-file <path>
//     [--wasm <file> | --flavor mainnet|testnet] [--vault <id>] [--out <file>]
import "../../../scripts/net-window.mjs";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { b58decode, b58encode, recipeTx } from "./deploy-testnet.mjs";
import { RPCS as TESTNET_RPCS, TESTNET_USDC, TESTNET_VERSION, networkProblems, wasmProblems } from "../../../scripts/live-checks/vault-skeleton.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRATE = path.resolve(HERE, "..");
const TGAS = 10n ** 12n;
const NEAR = 10n ** 24n;
const BYTE = 10n ** 19n; // storage_amount_per_byte
export const CONFIG_GAS = 100n * TGAS;
export const REGISTER_GAS = 30n * TGAS;
export const MAX_FUNCTION_BODY = 196_608; // max_function_body_size, parameters.snap l.233
export const TOOLCHAIN = "1.96.0";
export const BUILD_ARGS = ["near", "build", "non-reproducible-wasm", "--no-embed-abi", "--locked"];
export const LIVE_CHECK = "scripts/live-checks/vault-skeleton.mjs";

// The RUSTFLAGS every build passes to cargo-near (it does not inherit the shell's).
export function rustflags(cargoHome) {
  // cargo-near splits RUSTFLAGS on whitespace
  if (/\s/.test(cargoHome)) throw new Error(`CARGO_HOME ${cargoHome} holds whitespace: the remap flag would split`);
  return `-C link-arg=-s --remap-path-prefix=${cargoHome}=/cargo`;
}

// The full cargo command line of one build.
export function buildCommand({ flavor, cargoHome }) {
  const args = [`+${TOOLCHAIN}`, ...BUILD_ARGS, "--env", `RUSTFLAGS=${rustflags(cargoHome)}`];
  if (flavor === "testnet") args.push("--features", "testnet");
  else if (flavor !== "mainnet") throw new Error(`flavor ${flavor}: want testnet or mainnet`);
  return ["cargo", args];
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// Two clean builds in two new target dirs under buildDir; the wasm and its sha256 when they are equal, else an error
// naming both.
export function reproducibleBuild({ flavor, buildDir, log = console.log }) {
  if (existsSync(buildDir) && readdirSync(buildDir).length) throw new Error(`--build-dir ${buildDir} is not empty: each build starts from a new target dir`);
  mkdirSync(buildDir, { recursive: true });
  const cargoHome = process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo");
  const [cmd, args] = buildCommand({ flavor, cargoHome });
  const env = { ...process.env };
  delete env.RUSTFLAGS;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  const out = [];
  for (const name of ["a", "b"]) {
    const target = path.join(buildDir, name);
    log(`build ${name}: CARGO_TARGET_DIR=${target} ${cmd} ${args.join(" ")} (in ${CRATE})`);
    const r = spawnSync(cmd, args, { cwd: CRATE, env: { ...env, CARGO_TARGET_DIR: target }, encoding: "utf8", maxBuffer: 64 << 20 });
    if (r.status !== 0) throw new Error(`build ${name} failed (exit ${r.status}): ${(r.stderr || r.stdout || String(r.error)).split("\n").slice(-15).join("\n")}`);
    const file = path.join(target, "near", "blindfill_vault.wasm");
    const wasm = readFileSync(file);
    out.push({ file, wasm, sha: sha256(wasm) });
    log(`build ${name}: ${file} ${wasm.length} B sha256 ${out.at(-1).sha}`);
  }
  if (out[0].sha !== out[1].sha) throw new Error(`the two clean builds differ: ${out[0].sha} (${out[0].wasm.length} B) and ${out[1].sha} (${out[1].wasm.length} B); nothing was sent`);
  const file = path.join(buildDir, "blindfill_vault.wasm");
  copyFileSync(out[0].file, file);
  const rustc = execFileSync("rustc", [`+${TOOLCHAIN}`, "--version"], { encoding: "utf8" }).trim();
  const near = execFileSync("cargo", [`+${TOOLCHAIN}`, "near", "--version"], { encoding: "utf8" }).trim();
  return { file, wasm: out[0].wasm, sha: out[0].sha, shas: out.map((o) => o.sha), build: `${cmd} ${args.join(" ")} (${near}, ${rustc}, ${os.platform()} ${os.arch()})` };
}

// The size of every function body in a wasm module's code section (section 10).
export function functionBodies(buf) {
  const b = Buffer.from(buf);
  if (b.length < 8 || b.readUInt32BE(0) !== 0x0061736d) throw new Error("not a wasm module");
  let p = 8;
  const leb = () => {
    let r = 0, s = 0, x;
    do {
      if (p >= b.length) throw new Error("wasm: truncated");
      x = b[p++];
      r += (x & 0x7f) * 2 ** s;
      s += 7;
    } while (x & 0x80);
    return r;
  };
  while (p < b.length) {
    const id = b[p++];
    const size = leb();
    const end = p + size;
    if (id === 10) {
      const bodies = [];
      for (let n = leb(); n > 0; n--) {
        const len = leb();
        bodies.push(len);
        p += len;
      }
      return bodies;
    }
    p = end;
  }
  return [];
}

// What stops this wasm from being deployed on `network`: [] when nothing does.
export function deployProblems(wasm, network) {
  const p = [];
  const w = wasmProblems(wasm);
  if (w.banned.length) p.push(`banned imports (vault.md 2.8): ${w.banned.join(", ")}`);
  if (w.promises.length) p.push(`promise imports outside 2.8's seven: ${w.promises.join(", ")}`);
  if (w.exports.length) p.push(`exports outside 2.5.7's list: ${w.exports.join(", ")}`);
  const big = functionBodies(wasm).filter((n) => n > MAX_FUNCTION_BODY);
  if (big.length) p.push(`${big.length} function bod${big.length === 1 ? "y" : "ies"} over ${MAX_FUNCTION_BODY} B: ${big.join(", ")}`);
  if (network === "testnet") p.push(...networkProblems(wasm).map((x) => `not a testnet build: ${x}`));
  return p;
}

// The vault's account: a direct sub-account of the parent (CreateAccount makes no other), never an implicit id.
export function vaultIdProblems(vault, parent) {
  if (!vault.endsWith(`.${parent}`) || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(vault.slice(0, -parent.length - 1))) return [`${vault} is not <label>.${parent}`];
  if (/^[0-9a-f]{64}$/.test(vault) || /^0x[0-9a-f]{40}$/.test(vault)) return [`${vault} is an implicit id`];
  return [];
}

// The repository's roots: this checkout and, for a worktree, the main checkout.
function repoRoots() {
  const roots = [path.resolve(HERE, "../../..")];
  try {
    const common = execFileSync("git", ["-C", HERE, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    roots.push(path.dirname(common));
  } catch {}
  return roots.map((r) => realpathSync(r));
}

// The signer's key from `file`: { pub (32 B), privateKey (a KeyObject) }. Never returns or prints the secret's text.
export function loadKey(file, parent, roots = repoRoots()) {
  const real = realpathSync(file);
  for (const r of roots) if (real === r || real.startsWith(r + path.sep)) throw new Error(`--key-file is inside the repository (${r}): a key never lives in the repo`);
  let j;
  try {
    j = JSON.parse(readFileSync(real, "utf8"));
  } catch {
    throw new Error("--key-file is not a JSON key file");
  }
  if (j.account_id !== undefined && j.account_id !== parent) throw new Error(`--key-file is ${j.account_id}'s key, not ${parent}'s`);
  const text = j.private_key ?? j.secret_key;
  if (typeof text !== "string" || !text.startsWith("ed25519:")) throw new Error("--key-file holds no ed25519 private_key");
  let raw;
  try {
    raw = b58decode(text.slice(8));
  } catch {
    throw new Error("--key-file: the private key is not base58");
  }
  if (raw.length !== 64) throw new Error("--key-file: the private key is not 64 bytes");
  const pub = raw.subarray(32);
  const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: raw.subarray(0, 32).toString("base64url"), x: pub.toString("base64url") }, format: "jwk" });
  const derived = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  if (!derived.equals(pub)) throw new Error("--key-file: the private key's public half does not match its seed");
  if (j.public_key !== undefined && j.public_key !== `ed25519:${b58encode(pub)}`) throw new Error("--key-file: public_key does not match the private key");
  return { pub: Buffer.from(pub), privateKey };
}

// nearcore's Transaction V0 (Borsh) with one FunctionCall; Action FunctionCall = 2, ED25519 = 0.
export function functionCallTx({ signer, publicKey, nonce, receiver, blockHash, method, args, gas, deposit }) {
  const str = (s) => {
    const b = Buffer.from(s, "utf8");
    const n = Buffer.alloc(4);
    n.writeUInt32LE(b.length);
    return Buffer.concat([n, b]);
  };
  const u64 = (x) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(x));
    return b;
  };
  const u128 = (x) => Buffer.concat([u64(BigInt(x) & 0xffffffffffffffffn), u64(BigInt(x) >> 64n)]);
  const one = Buffer.alloc(4);
  one.writeUInt32LE(1);
  const a = Buffer.from(args, "utf8");
  const alen = Buffer.alloc(4);
  alen.writeUInt32LE(a.length);
  return Buffer.concat([str(signer), Buffer.from([0]), publicKey, u64(nonce), str(receiver), blockHash, one, Buffer.from([2]), str(method), alen, a, u64(gas), u128(deposit)]);
}

function signTx(tx, privateKey) {
  const hash = createHash("sha256").update(tx).digest();
  return { hash: b58encode(hash), signed: Buffer.concat([tx, Buffer.from([0]), sign(null, hash, privateKey)]) };
}

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "deploy", method, params }),
    signal: AbortSignal.timeout(180_000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method} on ${url}: ${JSON.stringify(j.error).slice(0, 400)}`);
  if (j.result?.error) throw new Error(`${method} on ${url}: ${String(j.result.error).slice(0, 400)}`);
  return j.result;
}

const view = async (url, account_id, method, args, finality = "final") => {
  const r = await rpc(url, "query", { request_type: "call_function", account_id, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), finality });
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
};

// Sends a signed transaction and waits for FINAL; an error unless the transaction and every receipt succeeded.
async function send(url, tx, privateKey, what) {
  const { hash, signed } = signTx(tx, privateKey);
  const r = await rpc(url, "send_tx", { signed_tx_base64: signed.toString("base64"), wait_until: "FINAL" });
  const failed = [r.transaction_outcome, ...r.receipts_outcome].filter((o) => o.outcome.status.Failure);
  if (!("SuccessValue" in (r.status ?? {})) || failed.length) throw new Error(`${what} ${hash} failed: ${JSON.stringify(r.status).slice(0, 600)}`);
  return { hash, r };
}

function parseArgs(argv) {
  const known = new Set(["--build-only", "--flavor", "--build-dir", "--network", "--rpc", "--parent", "--key-file", "--vault", "--wasm", "--out"]);
  const flags = new Set(["--build-only"]);
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!known.has(k)) throw new Error(`unknown argument ${k}`);
    if (flags.has(k)) o[k.slice(2)] = true;
    else {
      if (argv[i + 1] === undefined) throw new Error(`${k} needs a value`);
      o[k.slice(2)] = argv[++i];
    }
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "t").toLowerCase();
  const buildDir = o["build-dir"] ?? path.join(os.tmpdir(), `blindfill-vault-build-${stamp}-${process.pid}`);

  if (o["build-only"]) {
    const b = reproducibleBuild({ flavor: o.flavor ?? "testnet", buildDir });
    console.log(`reproducible: both builds sha256 ${b.sha}, ${b.wasm.length} B; wasm ${b.file}`);
    const p = deployProblems(b.wasm, o.flavor ?? "testnet");
    if (p.length) throw new Error(`the build would be refused: ${p.join("; ")}`);
    return;
  }

  const network = o.network;
  if (network === "mainnet") throw new Error("no mainnet: a mainnet vault deploy is the owner's, by its own card");
  if (network !== "testnet" && network !== "sandbox") throw new Error("--network testnet|sandbox");
  if (!o.parent || !o["key-file"]) throw new Error("--parent and --key-file are required");
  const parent = o.parent;
  const rpcs = network === "testnet" ? TESTNET_RPCS : [o.rpc];
  if (!rpcs[0]) throw new Error("--network sandbox needs --rpc <url>");
  if (network === "testnet" && (o.rpc || o.wasm)) throw new Error("--network testnet takes no --rpc or --wasm: it reads two public RPCs and builds the wasm itself, twice");
  if (network === "testnet" && o.flavor && o.flavor !== "testnet") throw new Error("--network testnet deploys the testnet build only");
  const url = rpcs[0];
  const vault = o.vault ?? `vault.${parent}`;
  const idp = vaultIdProblems(vault, parent);
  if (idp.length) throw new Error(idp.join("; "));
  const out = o.out ?? (network === "testnet" ? path.join(CRATE, "deployments", "testnet-vault.json") : null);
  if (!out) throw new Error("--network sandbox needs --out <file>");

  // 1-2. the wasm: built twice here, or (sandbox only) the file given; refused before any send if it breaks a rule
  let wasm, build, shas;
  if (o.wasm) {
    wasm = readFileSync(o.wasm);
    build = `given: ${o.wasm}`;
    shas = [sha256(wasm)];
  } else {
    const b = reproducibleBuild({ flavor: network === "testnet" ? "testnet" : (o.flavor ?? "mainnet"), buildDir });
    wasm = b.wasm;
    build = b.build;
    shas = b.shas;
    console.log(`reproducible: both builds sha256 ${b.sha}`);
  }
  const sha = sha256(wasm);
  const problems = deployProblems(wasm, network);
  if (problems.length) throw new Error(`refused before any send: ${problems.join("; ")}`);
  const bodies = functionBodies(wasm);
  console.log(`wasm ${wasm.length} B, sha256 ${sha}, ${bodies.length} functions, largest body ${Math.max(...bodies)} B (limit ${MAX_FUNCTION_BODY})`);

  // 3. the parent's key and nonce; the vault must not exist yet
  const { pub, privateKey } = loadKey(o["key-file"], parent);
  const pubText = `ed25519:${b58encode(pub)}`;
  const ak = await rpc(url, "query", { request_type: "view_access_key", account_id: parent, public_key: pubText, finality: "optimistic" });
  if (ak.permission !== "FullAccess") throw new Error(`${parent}'s key ${pubText} is not a full-access key`);
  try {
    await rpc(url, "query", { request_type: "view_account", account_id: vault, finality: "optimistic" });
    throw new Error(`EXISTS`);
  } catch (e) {
    if (e.message === "EXISTS") throw new Error(`${vault} already exists: each deploy is a new keyless account`);
    if (!/UNKNOWN_ACCOUNT|does not exist/.test(e.message)) throw e;
  }
  const transfer = BigInt(wasm.length + 100) * BYTE + NEAR / 100n;
  let block = await rpc(url, "block", { finality: "final" });
  const tx = recipeTx({ signer: parent, publicKey: pub, nonce: BigInt(ak.nonce) + 1n, receiver: vault, blockHash: b58decode(block.header.hash), wasm, transfer, configGas: CONFIG_GAS });
  console.log(`sending [CreateAccount, Transfer(${transfer}), DeployContract(${wasm.length} B), FunctionCall(config, ${CONFIG_GAS / TGAS} Tgas, 0)] from ${parent} to ${vault}, no AddKey`);
  const d = await send(url, tx, privateKey, "the recipe");
  const config = JSON.parse(Buffer.from(d.r.status.SuccessValue, "base64").toString("utf8"));
  if (network === "testnet" && (config.asset !== TESTNET_USDC || !TESTNET_VERSION.test(config.version))) throw new Error(`deployed, but config() names asset ${config.asset}, version ${config.version}: not the testnet build`);
  const vaultReceipt = d.r.receipts_outcome.find((x) => x.outcome.executor_id === vault);
  console.log(`deployed: tx ${d.hash}; config() asset ${config.asset}, version ${config.version}; the vault's receipt burnt ${vaultReceipt?.outcome.gas_burnt} gas`);

  // 4. read back: no key, the build's code
  const reads = network === "testnet" ? rpcs.map((u) => [u, "final"]) : [[url, "optimistic"], [url, "final"]];
  const codeHash = b58encode(Buffer.from(sha, "hex"));
  for (const [u, finality] of reads) {
    let acct;
    for (let i = 0; i < 30 && !acct; i++) {
      try {
        acct = await rpc(u, "query", { request_type: "view_account", account_id: vault, finality });
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!acct) throw new Error(`${vault} not visible on ${u} at ${finality}`);
    const keys = await rpc(u, "query", { request_type: "view_access_key_list", account_id: vault, block_id: acct.block_hash });
    if (!Array.isArray(keys.keys) || keys.keys.length) throw new Error(`${vault} key list on ${u} at ${finality}: ${JSON.stringify(keys.keys)}; want []`);
    if (acct.code_hash !== codeHash) throw new Error(`${vault} code hash ${acct.code_hash} on ${u}, want ${codeHash}`);
    console.log(`read back on ${u} at ${finality}: keys [], code hash ${codeHash}`);
  }

  // 5. registration on the token config() names, with the token's own bound
  const token = config.asset;
  const bounds = await view(url, token, "storage_balance_bounds", {});
  const min = BigInt(bounds.min);
  const ak2 = await rpc(url, "query", { request_type: "view_access_key", account_id: parent, public_key: pubText, finality: "optimistic" });
  block = await rpc(url, "block", { finality: "final" });
  const args = JSON.stringify({ account_id: vault, registration_only: true });
  const reg = await send(url, functionCallTx({ signer: parent, publicKey: pub, nonce: BigInt(ak2.nonce) + 1n, receiver: token, blockHash: b58decode(block.header.hash), method: "storage_deposit", args, gas: REGISTER_GAS, deposit: min }), privateKey, "the registration");
  let balance = null;
  for (const [u, finality] of reads) {
    balance = await view(u, token, "storage_balance_of", { account_id: vault }, finality);
    if (balance === null) throw new Error(`${token}.storage_balance_of(${vault}) is null on ${u} at ${finality} after ${reg.hash}`);
  }
  console.log(`registered: tx ${reg.hash}, ${token}.storage_deposit(${vault}) with ${min} yocto; storage_balance_of ${JSON.stringify(balance)}`);

  const doc = {
    network,
    account_id: vault,
    parent,
    tx_hash: d.hash,
    tx_actions: ["CreateAccount", "Transfer", "DeployContract", "FunctionCall(config)"],
    transfer_yocto: String(transfer),
    config_gas: String(CONFIG_GAS),
    vault_receipt_gas_burnt: vaultReceipt ? String(vaultReceipt.outcome.gas_burnt) : null,
    wasm_sha256: sha,
    wasm_builds_sha256: shas,
    wasm_bytes: wasm.length,
    largest_function_body: Math.max(...bodies),
    code_hash: codeHash,
    asset: token,
    scope: config.scope,
    version: config.version,
    registration_tx: reg.hash,
    registration_yocto: String(min),
    build,
    deployed_at: new Date().toISOString(),
  };
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote ${out}`);
  console.log(`next: node ${LIVE_CHECK} --deployment ${path.relative(path.resolve(CRATE, "../.."), path.resolve(out))}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`deploy: ERROR: ${String(e.message)}`);
    process.exit(1);
  });
}
