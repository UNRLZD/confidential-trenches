#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Builds the vault reproducibly, deploys it with no key and registers it on its token (vault.md 2.8, V1.6).
//
// 1. Build: two clean builds by `cargo near build reproducible-wasm` (NEP-330), each into its own new out dir, and their
//    sha256 compared. cargo-near clones the committed HEAD into a new folder and runs Cargo.toml's
//    container_build_command in the Docker image Cargo.toml names by digest, so the bytes do not depend on the machine
//    or its architecture, and the wasm's contract_source_metadata names this repository, the commit and the command.
//    Before the first build, Cargo.toml's [package.metadata.near.reproducible_build] must be exactly REPRODUCIBLE (the
//    image pinned by its digest), `rustc +1.96.0` must be 1.96.0 and `cargo +1.96.0 near --version` exactly CARGO_NEAR.
//    Two different builds, or a wasm whose metadata is not this repository at HEAD built by the pinned image and
//    command, stop the run before anything is sent. Both out dirs are removed on every exit, a SIGINT or SIGTERM
//    included; the wasm stays at <build-dir>/blindfill_vault.wasm. Builds run from a clone or the main checkout: from
//    a worktree inside the main checkout, cargo-near takes the outer repository and the commit check refuses the build.
//    A testnet deploy first refuses a tree with changes and a HEAD on no branch or tag of REPO (sourceProblems), so the
//    commit its metadata names is one anyone can fetch and rebuild.
// 2. Static checks on the wasm: every problem list scripts/live-checks/vault-skeleton.mjs wasmProblems returns is empty
//    (fail-closed: a field it adds later refuses here too; today none of 2.8's banned imports, promise imports inside
//    the seven, exports inside 2.5.7's list); every function body at most 196,608 B
//    (`max_function_body_size`); a testnet deploy must be the testnet build (it names the team's testnet USDC,
//    scripts/live-checks/vault-testnet-t01.mjs TESTNET_TOKEN, and no other token).
// 3. The chain: every RPC the run uses answers `status` with the network's chain id (testnet: "testnet" on both;
//    sandbox: near-sandbox's test-chain-<id>), else nothing is sent; a sandbox --rpc is a loopback URL only.
//    The recipe: the parent signs one transaction to vault.<parent> with [CreateAccount, Transfer(code storage +
//    0.01 N), DeployContract(wasm), FunctionCall(config, 0 deposit)] and no AddKey; the config() call in the same
//    receipt compiles and runs the wasm, so a wasm that cannot run rolls the whole batch back. The +0.01 N (1,000 B)
//    pays the 200 B state record the first storage_prepay writes (2.3).
// 4. Read back: `view_access_key_list` is `keys: []` on every read (testnet: two RPCs at final; sandbox: its RPC at
//    optimistic and at final), and the code hash is the build's.
// 5. Registration: the parent calls the token config() names, `storage_deposit(vault, registration_only)` with the
//    token's own `storage_balance_bounds().min`, signed only when min = max and min <= MAX_REGISTRATION (0.01 N), then
//    reads `storage_balance_of(vault)` back.
// It prints the recipe's tx hash before sending it, writes a partial record (--out) as soon as the send lands, then the
// whole record after the read-back and the registration, and prints the live check to run next (nextLine: testnet's
// and mainnet's; a sandbox deploy has none).
//
// Mainnet (card vault-mainnet-test): the owner's paste, signed by the parent's key file in the owner's process. It never
// builds: it deploys --wasm (the vault-build workflow's artifact, two clean ubuntu-24.04 builds) only when three agree:
// the wasm's sha256, MAINNET_PINS' pin for --vault (in this file, so a record edited alone cannot move it), and the
// --deployment record's (contracts/vault/deployments/mainnet-test.json), whose builds agree, whose code_hash is the
// pin's base58, whose account is --vault and whose network is mainnet. The wasm must export REQUIRED_EXPORTS (the
// methods without which a note could not be paid out on a vault with no upgrade) and hold mainnet USDC and neither test
// token. Both mainnet RPCs (MAINNET_RPCS, two operators) must answer chain_id mainnet, the parent's key must be its
// full-access key, its balance must cover the code storage, the registration and MAINNET_GAS_MARGIN, the vault must
// not exist, and the signed batch must be exactly the recipe (recipeProblems: no AddKey), else nothing is sent. Then
// the read-back on both RPCs at final and the registration on mainnet USDC. The record --out keeps the pre-deploy
// record's fields and adds the deploy's. Testnet's and the sandbox's rules are unchanged by any of this.
// Since the reproducible build (card vault-reproducible-build), the record must name the commit the wasm was built at
// (source_commit, recordSourceProblems), on a branch or tag of REPO, and the wasm's NEP-330 metadata must name that
// commit; a record marked non_reproducible is never deployed again.
//
// Records (--verify-records): every vault deploy record in deployments/ (a code_hash and a blindfill-vault version)
// names exactly one of source_commit (a reproducible build: the commit is cloned, rebuilt twice in the pinned image and
// its sha256 must be the record's wasm_sha256 and code_hash) or non_reproducible (an earlier build, with its reason:
// printed as a NOTE, never compared). The wasm's metadata names its own commit, so no record can pin the build of the
// commit that holds it: a record is checked at its own commit, never at HEAD.
//
// The signer's key comes from --key-file, a path given at run time: the near CLI's keychain file
// (~/.near-credentials/<network>/<parent>.json) or any file holding {account_id, public_key, private_key}. A path inside
// this repository is refused. The key is read and checked before the build, into this process only, to sign: it is
// never printed, written or sent.
// Sandbox runs use the sandbox's own genesis key.
//
//   node contracts/vault/scripts/deploy.mjs --build-only [--flavor testnet|mainnet] [--build-dir <new dir>]
//   node contracts/vault/scripts/deploy.mjs --verify-records [--build-dir <new dir>]
//   node contracts/vault/scripts/deploy.mjs --network testnet --parent <name>.testnet --key-file <path>
//     [--vault <label>.<parent>] [--build-dir <new dir>] [--out <file>]
//   node contracts/vault/scripts/deploy.mjs --network sandbox --rpc <url> --parent <id> --key-file <path>
//     [--wasm <file> | --flavor mainnet|testnet] [--vault <id>] [--out <file>]
//   node contracts/vault/scripts/deploy.mjs --network mainnet --parent <name>.near --vault <label>.<parent>
//     --key-file <path> --wasm <file> --deployment <pre-deploy record> --out <file>
import "../../../scripts/net-window.mjs";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { b58decode, b58encode, functionCallTx, recipeTx } from "./near-tx.mjs";
import { EXPORTS_ALLOWED, RPCS as TESTNET_RPCS, TESTNET_VERSION, wasmProblems } from "../../../scripts/live-checks/vault-skeleton.mjs";
import { MAINNET_USDC, TESTNET_TOKEN, networkProblems, tokenProblems } from "../../../scripts/live-checks/vault-testnet-t01.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRATE = path.resolve(HERE, "..");
const TGAS = 10n ** 12n;
const NEAR = 10n ** 24n;
const BYTE = 10n ** 19n; // storage_amount_per_byte
export const CONFIG_GAS = 100n * TGAS;
export const REGISTER_GAS = 30n * TGAS;
export const MAX_FUNCTION_BODY = 196_608; // max_function_body_size, parameters.snap l.233
export const TOOLCHAIN = "1.96.0";
// The cargo-near the vault is built with: `cargo +1.96.0 near --version` must print exactly this.
export const CARGO_NEAR = "cargo-near-near 0.22.0";
export const BUILD_ARGS = ["near", "build", "reproducible-wasm"];
// The repository the wasm's NEP-330 metadata links to (Cargo.toml package.repository).
export const REPO = "https://github.com/UNRLZD/confidential-trenches";
// The vault crate's path in it (NEP-330 build_info.contract_path).
export const CONTRACT_PATH = "contracts/vault";
// What Cargo.toml's [package.metadata.near.reproducible_build] must say, held here too so a Cargo.toml edited alone
// cannot move the image: cargo-near 0.22.0's own pin for a new project (cargo-near 0.21.1 on rustc 1.96.0), named by
// the digest Docker Hub serves for that tag; the mainnet command, and the testnet variant's.
const CONTAINER_BUILD = ["cargo", "near", "build", "non-reproducible-wasm", "--locked", "--no-embed-abi"];
export const REPRODUCIBLE = {
  image: "sourcescan/cargo-near:0.21.1-rust-1.96.0",
  image_digest: "sha256:ccb22bb4e677ed022d8b9d1aa1b32f0af52dd0471ef1c32e48dedbf68ee6ee17",
  passed_env: [],
  container_build_command: CONTAINER_BUILD,
  variant: { testnet: { container_build_command: [...CONTAINER_BUILD, "--features", "testnet"] } },
};
export const LIVE_CHECK = "scripts/live-checks/vault-testnet-t01.mjs";
export const MAINNET_LIVE_CHECK = "scripts/live-checks/vault-mainnet.mjs";
// FastNEAR and dRPC, mainnet's two operators: vault-mainnet.mjs MAINNET_RPCS, held equal by deploy.test.mjs. Written
// here, not imported: that module's imports reach scripts/ci (money-gate.mjs), which the sandbox suite does not read.
export const MAINNET_RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
// The one wasm each mainnet vault may be deployed with (review MED-1): the pin of its pre-deploy record, held here too.
// vault-test: mainnet-test.json (card vault-mainnet-test). vault: mainnet-v1.pin.json, the mainnet build of e0623bf3
// (card vault-mainnet-deploy), which deploy.mjs turns into mainnet-v1.json once the vault exists.
export const MAINNET_PINS = { "vault-test.confidential.unrlzd.near": "57535ae7486f840d9c9d29934e265712c44ada1992abc14344e431c2f2caca6a", "vault.confidential.unrlzd.near": "a4a2af6960d93e5187271cf401ffe0e1a6f1ae5da0af1d82b1250eee313e87fc" };
// config().version of a mainnet build (contracts/vault/src/constants.rs NETWORK)
export const MAINNET_VERSION = /^blindfill-vault \S+ mainnet$/;
// What the parent must hold on mainnet beyond the code storage and the registration: the recipe's 100 Tgas config call
// and the deploy's own gas (testnet-v1's vault receipt burnt 23.7 Tgas), with room: 0.05 N.
export const MAINNET_GAS_MARGIN = NEAR / 20n;
// The methods a mainnet vault must export (vault.md 2.5.7): without any one of them a note could not be made, spent,
// paid out, taken back or settled, and the vault has no upgrade to add it later. Each is also inside EXPORTS_ALLOWED.
export const REQUIRED_EXPORTS = ["settle", "withdraw", "on_payout", "ragequit", "ft_on_transfer", "storage_prepay", "config"];
for (const e of REQUIRED_EXPORTS) if (!EXPORTS_ALLOWED.has(e)) throw new Error(`REQUIRED_EXPORTS names ${e}, which vault-skeleton.mjs EXPORTS_ALLOWED refuses`);

// The line a deploy on `network` ends with: the live check to run next. Testnet's vault has LIVE_CHECK, which reads two
// public testnet RPCs and refuses any build but the testnet one. A sandbox deploy lives on this machine only, so no
// live check can read it (tests/s20.rs checks its end state). Mainnet's is vault-mainnet.mjs on the vault it made.
export function nextLine(network, record, { account, signer } = {}) {
  if (network === "testnet") return `next: node ${LIVE_CHECK} --deployment ${record}`;
  if (network === "mainnet") return `next: node ${MAINNET_LIVE_CHECK} --network mainnet --account ${account} --signer ${signer} --deployment ${record}`;
  if (network === "sandbox") return "next: no live check (a sandbox deploy lives on this machine only; tests/s20.rs checks its end state)";
  throw new Error(`no network ${network}`);
}

// What keeps Cargo.toml (its text) from building the vault reproducibly with the pinned image: package.repository is
// not REPO, or [package.metadata.near.reproducible_build] (and its variant tables) is not exactly REPRODUCIBLE. An image
// with no digest, a tag or a mutable name in its place, another digest, an extra key, a passed env or a line this
// reader cannot read are each refused (fail-closed). Values are read as TOML basic strings and arrays of them, which
// are JSON.
export function reproducibleProblems(toml) {
  const tables = new Map();
  let at = null;
  const p = [];
  for (const [i, raw] of toml.split("\n").entries()) {
    const line = raw.replace(/^\s+|\s+$/g, "");
    if (!line || line.startsWith("#")) continue;
    const head = /^\[([^\[\]]+)\]$/.exec(line);
    if (head) {
      at = head[1].trim();
      if (!tables.has(at)) tables.set(at, {});
      continue;
    }
    if (line.startsWith("[")) {
      at = null;
      continue;
    }
    if (at !== "package" && !at?.startsWith("package.metadata.near.reproducible_build")) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    let v;
    try {
      if (!kv) throw new Error("not key = value");
      v = JSON.parse(kv[2]);
    } catch {
      if (at === "package") continue; // [package] lines other than repository may be any TOML
      p.push(`Cargo.toml l.${i + 1} in [${at}] is not one line of a string or a list of strings: ${raw}`);
      continue;
    }
    tables.get(at)[kv[1]] = v;
  }
  if (tables.get("package")?.repository !== REPO) p.push(`Cargo.toml package.repository is ${JSON.stringify(tables.get("package")?.repository ?? null)}, want "${REPO}"`);
  const root = "package.metadata.near.reproducible_build";
  const want = new Map([[root, (({ variant, ...r }) => r)(REPRODUCIBLE)], ...Object.entries(REPRODUCIBLE.variant).map(([k, v]) => [`${root}.variant.${k}`, v])]);
  const digest = tables.get(root)?.image_digest;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) p.push(`the image is not pinned by digest: Cargo.toml [${root}] image_digest is ${JSON.stringify(digest ?? null)}`);
  for (const name of tables.keys()) {
    if (name.startsWith(root) && !want.has(name)) p.push(`Cargo.toml [${name}] is not one of deploy.mjs REPRODUCIBLE's tables`);
  }
  for (const [name, w] of want) {
    const t = tables.get(name);
    if (!t) {
      p.push(`Cargo.toml has no [${name}]`);
      continue;
    }
    for (const k of new Set([...Object.keys(w), ...Object.keys(t)])) {
      if (JSON.stringify(t[k]) !== JSON.stringify(w[k])) p.push(`Cargo.toml [${name}] ${k} is ${JSON.stringify(t[k] ?? null)}, deploy.mjs REPRODUCIBLE has ${JSON.stringify(w[k] ?? null)}`);
    }
  }
  return p;
}

// The full cargo command line of one build into outDir.
export function buildCommand({ flavor, outDir }) {
  const args = [`+${TOOLCHAIN}`, ...BUILD_ARGS];
  if (flavor === "testnet") args.push("--variant", "testnet");
  else if (flavor !== "mainnet") throw new Error(`flavor ${flavor}: want testnet or mainnet`);
  args.push("--out-dir", outDir);
  return ["cargo", args];
}

// The NEP-330 metadata the vault's contract_source_metadata returns, as near-sdk writes it into the wasm: the one JSON
// object in its bytes that starts {"version": and holds "standards". null when there is not exactly one.
export function sourceMetadata(wasm) {
  const b = Buffer.from(wasm).toString("latin1");
  const found = [];
  for (let at = b.indexOf('{"version":'); at >= 0; at = b.indexOf('{"version":', at + 1)) {
    let depth = 0, inStr = false, end = -1;
    for (let i = at; i < b.length; i++) {
      const c = b[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (--depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) continue;
    try {
      const m = JSON.parse(Buffer.from(b.slice(at, end), "latin1").toString("utf8"));
      if (Array.isArray(m?.standards)) found.push(m);
    } catch {}
  }
  return found.length === 1 ? found[0] : null;
}

// What keeps the wasm's NEP-330 metadata from naming this vault's source: REPO's tree at the commit `commit` (the link
// cargo-near writes for a github.com repository), the commit, the crate's path, the pinned image by digest and the
// flavor's container command.
export function metadataProblems(wasm, { commit, flavor }) {
  const m = sourceMetadata(wasm);
  if (!m) return ["the wasm holds no single NEP-330 contract_source_metadata"];
  const command = flavor === "testnet" ? REPRODUCIBLE.variant.testnet.container_build_command : REPRODUCIBLE.container_build_command;
  const want = {
    link: `${REPO}/tree/${commit}`,
    "build_info.build_environment": `${REPRODUCIBLE.image}@${REPRODUCIBLE.image_digest}`,
    "build_info.source_code_snapshot": `git+${REPO}?rev=${commit}`,
    "build_info.contract_path": CONTRACT_PATH,
    "build_info.build_command": command,
  };
  const p = [];
  for (const [k, w] of Object.entries(want)) {
    const got = k.split(".").reduce((o, f) => o?.[f], m);
    if (JSON.stringify(got) !== JSON.stringify(w)) p.push(`the wasm's contract_source_metadata ${k} is ${JSON.stringify(got ?? null)}, want ${JSON.stringify(w)}`);
  }
  return p;
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// What keeps a deploy record from saying where its wasm came from: exactly one of source_commit (the 40-hex commit a
// reproducible build was made at, with wasm_sha256 and its base58 code_hash) and non_reproducible (why it was not).
export function recordSourceProblems(record) {
  const has = (k) => Object.hasOwn(record ?? {}, k);
  if (has("source_commit") && has("non_reproducible")) return ["the record names both source_commit and non_reproducible: a reproducible record can never carry the non_reproducible mark"];
  if (has("non_reproducible")) return typeof record.non_reproducible === "string" && record.non_reproducible.trim() ? [] : ["the record's non_reproducible mark gives no reason"];
  if (!has("source_commit")) return ["the record names neither source_commit (a reproducible build's commit) nor non_reproducible"];
  const p = [];
  if (!/^[0-9a-f]{40}$/.test(record.source_commit)) p.push(`the record's source_commit ${JSON.stringify(record.source_commit)} is not a 40-hex commit`);
  if (!/^[0-9a-f]{64}$/.test(record.wasm_sha256 ?? "")) p.push(`the record pins no wasm_sha256: ${JSON.stringify(record.wasm_sha256 ?? null)}`);
  else if (record.code_hash !== b58encode(Buffer.from(record.wasm_sha256, "hex"))) p.push(`the record's code_hash ${record.code_hash} is not the base58 of its wasm_sha256`);
  return p;
}

// What keeps `commit` from being a source anyone can rebuild: with `clean`, a tree with changes or untracked files at
// `cwd`; and a commit on no branch or tag of REPO (git ls-remote, then merge-base --is-ancestor against each tip this
// clone holds: a tip it has not fetched counts as not holding it, so fetch first).
export function sourceProblems({ cwd = CRATE, commit, clean = true } = {}) {
  const git = (...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const p = [];
  if (clean) {
    const changed = git("status", "--porcelain").split("\n").filter(Boolean);
    if (changed.length) p.push(`the tree has ${changed.length} changed or untracked path(s) (${changed.slice(0, 3).join(", ")}): build from a clean checkout`);
  }
  let tips;
  try {
    tips = git("ls-remote", "--heads", "--tags", REPO).split("\n").filter(Boolean).map((l) => l.split("\t")[0]);
  } catch (e) {
    return [...p, `git ls-remote ${REPO} failed: ${String(e.stderr || e.message).trim().split("\n")[0]}`];
  }
  const held = tips.some((t) => {
    try {
      execFileSync("git", ["-C", cwd, "merge-base", "--is-ancestor", commit, t], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!held) p.push(`commit ${commit} is on no branch or tag of ${REPO}: push it (then git fetch) so anyone can rebuild it`);
  return p;
}

// The exit code of a run whose hashes disagree: the two clean builds differ, or a record rebuilds to a hash other than
// its own. Every other failure exits 1 (or 128 + the signal). vault-build.yml runs --build-only and --verify-records
// under scripts/ci/retry.sh with RETRY_FINAL=3, so a failure before any hash exists (a crates.io blip, the image) is
// tried again and a disagreement never is: a build that is reproducible only some of the time cannot pass on its second
// try. scripts/ci/download-retry.mjs refuses a vault-build step that does not name this code.
export const EXIT_HASH_DISAGREE = 3;
const disagreement = (message) => Object.assign(new Error(message), { exitCode: EXIT_HASH_DISAGREE });

// The pinned tools, read before any build: rustc of the pinned toolchain and exactly CARGO_NEAR. Returns their version
// lines, or throws naming what is not pinned.
export function toolVersions() {
  const rustc = execFileSync("rustc", [`+${TOOLCHAIN}`, "--version"], { encoding: "utf8" }).trim();
  const near = execFileSync("cargo", [`+${TOOLCHAIN}`, "near", "--version"], { encoding: "utf8" }).trim();
  if (!rustc.startsWith(`rustc ${TOOLCHAIN} `)) throw new Error(`rustc is "${rustc}", want rustc ${TOOLCHAIN}: nothing was built`);
  if (near !== CARGO_NEAR) throw new Error(`cargo near is "${near}", want "${CARGO_NEAR}": nothing was built`);
  return { rustc, near };
}

// One build as a child process in its own process group, so an interrupt can stop the whole build before its target
// dir is removed. Resolves { status, signal, output } when the child and its group have exited.
function runBuild(cmd, args, opts, children) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    children.add(c);
    let output = "";
    const keep = (d) => {
      output = (output + d).slice(-(1 << 16));
    };
    c.stdout.on("data", keep);
    c.stderr.on("data", keep);
    c.on("error", (e) => (children.delete(c), reject(e)));
    c.on("close", (status, signal) => (children.delete(c), resolve({ status, signal, output })));
  });
}

// The signals that stop a build: Ctrl-C, kill, a closed terminal and Ctrl-\. The build runs in its own process group
// (so a terminal's signal reaches only this process), and each of these is caught to stop that group too.
export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

// Two clean builds in two new target dirs under buildDir; the wasm and its sha256 when they are equal, else an error
// naming both. The tools are checked first. Both target dirs are removed on every exit, any STOP_SIGNALS included:
// the handler stops the build's process group, the build then fails, and the finally removes the dirs. The handlers
// stay on until the dirs are gone and one more turn of the event loop has run, so a signal that arrives while the
// script is busy (reading build b's wasm, or removing a dir) is still seen, and the run stops before any send.
export async function reproducibleBuild({ flavor, buildDir, crate = CRATE, log = console.log }) {
  buildDir = path.resolve(buildDir);
  if (existsSync(buildDir) && readdirSync(buildDir).length) throw new Error(`--build-dir ${buildDir} is not empty: each build starts from a new target dir`);
  const rp = reproducibleProblems(readFileSync(path.join(crate, "Cargo.toml"), "utf8"));
  if (rp.length) throw new Error(`${rp.join("; ")}: nothing was built`);
  const { near } = toolVersions();
  // the commit cargo-near builds (it clones HEAD), which the wasm's metadata must name
  const commit = execFileSync("git", ["-C", crate, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  mkdirSync(buildDir, { recursive: true });
  // the command as printed and recorded: the out dir is <out-dir>, never this machine's path
  const shown = `${buildCommand({ flavor, outDir: "<out-dir>" }).flat().join(" ")}`;
  const env = { ...process.env };
  delete env.RUSTFLAGS;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  const out = [];
  const file = path.join(buildDir, "blindfill_vault.wasm");
  const children = new Set();
  let interrupted = null;
  const onSignal = (sig) => {
    interrupted = sig;
    for (const c of children) {
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {}
    }
  };
  for (const s of STOP_SIGNALS) process.on(s, onSignal);
  try {
    for (const name of ["a", "b"]) {
      const target = path.join(buildDir, name);
      const [cmd, args] = buildCommand({ flavor, outDir: target });
      log(`build ${name}: ${cmd} ${args.join(" ")} (in ${crate})`);
      const r = await runBuild(cmd, args, { cwd: crate, env }, children);
      if (interrupted) throw Object.assign(new Error(`interrupted by ${interrupted}: the build target dirs were removed, nothing was sent`), { signal: interrupted });
      if (r.status !== 0) throw new Error(`build ${name} failed (exit ${r.status ?? r.signal}): ${r.output.split("\n").slice(-15).join("\n")}`);
      const wasm = readFileSync(path.join(target, "blindfill_vault.wasm"));
      out.push({ wasm, sha: sha256(wasm) });
      log(`build ${name}: ${wasm.length} B sha256 ${out.at(-1).sha}`);
    }
    if (out[0].sha !== out[1].sha) throw disagreement(`the two clean builds differ: ${out[0].sha} (${out[0].wasm.length} B) and ${out[1].sha} (${out[1].wasm.length} B); nothing was sent`);
    const mp = metadataProblems(out[0].wasm, { commit, flavor });
    if (mp.length) throw new Error(`${mp.join("; ")}; nothing was sent`);
    writeFileSync(file, out[0].wasm);
  } finally {
    for (const name of ["a", "b"]) rmSync(path.join(buildDir, name), { recursive: true, force: true });
    // one full loop turn: a signal caught by libuv during the sync work above runs onSignal before the handlers go
    // (one setImmediate let a signal through in one run on 2 Nov, so two)
    await new Promise((r) => setImmediate(() => setImmediate(r)));
    for (const s of STOP_SIGNALS) process.off(s, onSignal);
  }
  if (interrupted) throw Object.assign(new Error(`interrupted by ${interrupted}`), { signal: interrupted });
  return { file, wasm: out[0].wasm, sha: out[0].sha, shas: out.map((o) => o.sha), commit, build: `${shown} (${near}, image ${REPRODUCIBLE.image}@${REPRODUCIBLE.image_digest}, on ${os.platform()} ${os.arch()}), at ${commit}` };
}

// What a record this run writes says of its wasm's source (recordSourceProblems): a build made here names its commit;
// a sandbox --wasm file was not built by this run, so it is marked non_reproducible; a mainnet record keeps the
// --deployment record's own source_commit (spread in whole), so nothing is added.
export function deploySource({ network, wasmFile, commit }) {
  if (network === "mainnet") return {};
  if (wasmFile) return { non_reproducible: `a wasm file given to the run (--wasm ${path.basename(wasmFile)}), not built by it` };
  return { source_commit: commit };
}

// The vault deploy records in `dir`: each *.json with a code_hash and a blindfill-vault version (a token's record or a
// run record is neither).
export function vaultRecords(dir = path.join(CRATE, "deployments")) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((name) => ({ name, record: JSON.parse(readFileSync(path.join(dir, name), "utf8")) }))
    .filter(({ record }) => Object.hasOwn(record, "code_hash") && /^blindfill-vault /.test(record.version ?? ""));
}

// Every vault deploy record checked at its own commit (see the header, Records). Throws on the first record that is
// not marked, or whose rebuild is not its code hash; returns { name, sha | note } per record.
export async function verifyRecords({ dir, buildDir, log = console.log }) {
  buildDir = path.resolve(buildDir);
  if (existsSync(buildDir) && readdirSync(buildDir).length) throw new Error(`--build-dir ${buildDir} is not empty`);
  const top = execFileSync("git", ["-C", CRATE, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const done = [];
  for (const { name, record } of vaultRecords(dir)) {
    const p = recordSourceProblems(record);
    if (p.length) throw new Error(`${name}: ${p.join("; ")}`);
    if (Object.hasOwn(record, "non_reproducible")) {
      log(`NOTE: ${name} (${record.account_id}, code hash ${record.code_hash}) was made by a non-reproducible build and is not compared: ${record.non_reproducible}`);
      done.push({ name, note: record.non_reproducible });
      continue;
    }
    const src = path.join(buildDir, `${name}.src`);
    try {
      execFileSync("git", ["clone", "--quiet", "--no-checkout", top, src], { stdio: ["ignore", "pipe", "pipe"] });
      execFileSync("git", ["-C", src, "checkout", "--quiet", "--detach", record.source_commit], { stdio: ["ignore", "pipe", "pipe"] });
      const flavor = record.network === "mainnet" ? "mainnet" : "testnet";
      const b = await reproducibleBuild({ flavor, buildDir: path.join(buildDir, name), crate: path.join(src, CONTRACT_PATH), log });
      if (b.sha !== record.wasm_sha256) throw disagreement(`${name}: the rebuild of ${record.source_commit} is sha256 ${b.sha}, the record's is ${record.wasm_sha256} (code hash ${record.code_hash})`);
      log(`${name}: the rebuild of ${record.source_commit} is sha256 ${b.sha}, the record's code hash ${record.code_hash}`);
      done.push({ name, sha: b.sha });
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  }
  return done;
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

// wasmProblems' fields that only describe the wasm; every other field is a problem list.
export const WASM_INFO = new Set(["functionExports", "promiseImports"]);

// What stops this wasm from being deployed on `network`: [] when nothing does. Fail-closed: any wasmProblems field
// outside WASM_INFO that is not an empty list refuses, so a rule added to the live check later refuses here with no
// edit to this file.
export function deployProblems(wasm, network, problems = wasmProblems) {
  const p = [];
  for (const [field, list] of Object.entries(problems(wasm))) {
    if (WASM_INFO.has(field)) continue;
    if (!Array.isArray(list)) p.push(`wasmProblems.${field} is not a list: ${JSON.stringify(list)}`);
    else if (list.length) p.push(`${field} (vault.md 2.8, 2.5.7): ${list.join(", ")}`);
  }
  const big = functionBodies(wasm).filter((n) => n > MAX_FUNCTION_BODY);
  if (big.length) p.push(`${big.length} function bod${big.length === 1 ? "y" : "ies"} over ${MAX_FUNCTION_BODY} B: ${big.join(", ")}`);
  if (network === "testnet") p.push(...networkProblems(wasm).map((x) => `not a testnet build: ${x}`));
  if (network === "mainnet") {
    const fns = new Set(wasmProblems(wasm).functionExports);
    const missing = REQUIRED_EXPORTS.filter((e) => !fns.has(e));
    if (missing.length) p.push(`missing exports (vault.md 2.5.7): ${missing.join(", ")}`);
    p.push(...tokenProblems(wasm, MAINNET_USDC).map((x) => `not a mainnet build: ${x}`));
  }
  return p;
}

// What keeps `wasm` from being the pinned mainnet build of `record` (the pre-deploy record): its sha256 is the record's
// wasm_sha256 and `pins`' pin for the vault (`vault`, else the record's account), the record's builds (at least two) all
// agree on it, its code_hash is that sha's base58, the record is a mainnet one and, with `vault`, the record's account
// is `vault`. [] when it is the pin.
export function pinProblems(wasm, record, vault, pins = MAINNET_PINS) {
  const p = [];
  const sha = sha256(wasm);
  const id = vault ?? record?.account_id;
  const pin = Object.hasOwn(pins, id) ? pins[id] : undefined;
  if (pin === undefined) p.push(`MAINNET_PINS holds no pin for ${id}`);
  else {
    if (sha !== pin) p.push(`the wasm's sha256 ${sha} is not MAINNET_PINS' pin ${pin} for ${id}`);
    if (record?.wasm_sha256 !== pin) p.push(`the record's pin ${record?.wasm_sha256} is not MAINNET_PINS' pin ${pin} for ${id}`);
  }
  if (!/^[0-9a-f]{64}$/.test(record?.wasm_sha256 ?? "")) return [...p, `the record pins no wasm_sha256: ${JSON.stringify(record?.wasm_sha256 ?? null)}`];
  if (sha !== record.wasm_sha256) p.push(`the wasm's sha256 ${sha} is not the pin ${record.wasm_sha256}`);
  const builds = record.wasm_builds_sha256;
  if (!Array.isArray(builds) || builds.length < 2 || !builds.every((b) => b === record.wasm_sha256)) p.push(`the record's builds do not all agree on the pin: ${JSON.stringify(builds ?? null)}`);
  if (record.code_hash !== b58encode(Buffer.from(record.wasm_sha256, "hex"))) p.push(`the record's code_hash ${record.code_hash} is not the base58 of its pin`);
  if (record.network !== "mainnet") p.push(`the record is a ${record.network} record, not mainnet`);
  if (vault !== undefined && record.account_id !== vault) p.push(`the record is ${record.account_id}'s, not ${vault}'s`);
  p.push(...recordSourceProblems(record));
  if (Object.hasOwn(record, "non_reproducible")) p.push(`the record is marked non_reproducible: a mainnet vault deploys a reproducible build only`);
  else if (/^[0-9a-f]{40}$/.test(record.source_commit ?? "")) p.push(...metadataProblems(wasm, { commit: record.source_commit, flavor: "mainnet" }));
  return p;
}

// The action tags of an encoded transaction (near-tx.mjs's V0 layout): CreateAccount 0, DeployContract 1, FunctionCall 2,
// Transfer 3, Stake 4, AddKey 5, DeleteKey 6, DeleteAccount 7, Delegate 8. Reads the header to the action count, then
// each action's tag and the fields of the four the recipe holds; any other tag ends the read (its fields are not parsed).
export function txActionTags(tx) {
  const b = Buffer.from(tx);
  let p = 0;
  const u32 = () => ((p += 4), b.readUInt32LE(p - 4));
  // the length is read first, then added: `p += u32()` would add it to p as it was before the length's own 4 bytes
  const str = () => {
    const n = u32();
    p += n;
  };
  str(); // signer
  p += 1 + 32 + 8; // key tag, key, nonce
  str(); // receiver
  p += 32; // block hash
  const tags = [];
  for (let n = u32(); n > 0; n--) {
    const t = b[p++];
    tags.push(t);
    if (t === 0) continue;
    else if (t === 3) p += 16;
    else if (t === 1) str();
    else if (t === 2) (str(), str(), (p += 8 + 16));
    else break;
  }
  return tags;
}

// What keeps `tx` from being exactly the 2.8 recipe [CreateAccount, Transfer, DeployContract, FunctionCall]: any other
// action (an AddKey above all) would leave a key on the vault, or do something the recipe does not. [] when it is.
export function recipeProblems(tx) {
  const tags = txActionTags(tx);
  return tags.join(",") === "0,3,1,2" ? [] : [`the batch's actions are [${tags.join(", ")}], want exactly [0, 3, 1, 2] (CreateAccount, Transfer, DeployContract, FunctionCall), no AddKey`];
}

// What keeps a mainnet parent holding `amount` yocto from paying the recipe's `transfer`, the registration and the gas.
export function balanceProblems(amount, transfer) {
  const need = BigInt(transfer) + MAX_REGISTRATION + MAINNET_GAS_MARGIN;
  return BigInt(amount) >= need ? [] : [`the parent holds ${amount} yocto, short of ${need} (code storage ${transfer} + registration ${MAX_REGISTRATION} + gas ${MAINNET_GAS_MARGIN})`];
}

// The vault's account: a direct sub-account of the parent (CreateAccount makes no other), never an implicit id.
export function vaultIdProblems(vault, parent) {
  if (!vault.endsWith(`.${parent}`) || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(vault.slice(0, -parent.length - 1))) return [`${vault} is not <label>.${parent}`];
  if (/^[0-9a-f]{64}$/.test(vault) || /^0x[0-9a-f]{40}$/.test(vault)) return [`${vault} is an implicit id`];
  return [];
}

// The most a registration may attach: 0.01 N (USDC's bound is 0.00125 N, 2.8).
export const MAX_REGISTRATION = NEAR / 100n;
// near-sandbox's chain id: `neard init` without --chain-id names it test-chain-<5 random characters>
// (near-chain-configs 0.37.4 test_utils.rs l.222-224).
export const SANDBOX_CHAIN = /^test-chain-[0-9A-Za-z]+$/;

// What is wrong with the RPC a run on `network` would use: a sandbox run talks to this machine only.
export function rpcProblems(network, url) {
  if (network !== "sandbox") return [];
  let u;
  try {
    u = new URL(url);
  } catch {
    return [`--rpc ${url} is not a URL`];
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!/^https?:$/.test(u.protocol) || !loopback) return [`--network sandbox takes a loopback --rpc only (localhost, 127.0.0.0/8 or ::1), not ${url}`];
  return [];
}

// What is wrong with the chain id an RPC answers for `network`.
export function chainProblems(network, chainId) {
  if (network === "testnet") return chainId === "testnet" ? [] : [`chain_id ${JSON.stringify(chainId)}, want "testnet"`];
  if (network === "mainnet") return chainId === "mainnet" ? [] : [`chain_id ${JSON.stringify(chainId)}, want "mainnet"`];
  if (network === "sandbox") return typeof chainId === "string" && SANDBOX_CHAIN.test(chainId) ? [] : [`chain_id ${JSON.stringify(chainId)}, want near-sandbox's test-chain-<id>`];
  return [`no network ${network}`];
}

// What stops signing storage_deposit with the token's bounds: a fixed price (min = max), at most MAX_REGISTRATION.
export function registrationProblems(bounds) {
  let min, max;
  try {
    min = BigInt(bounds.min);
    max = BigInt(bounds.max);
  } catch {
    return [`storage_balance_bounds ${JSON.stringify(bounds)} is not {min, max}`];
  }
  const p = [];
  if (min !== max) p.push(`storage_balance_bounds min ${min} is not max ${max}`);
  if (min > MAX_REGISTRATION) p.push(`storage_balance_bounds min ${min} is over MAX_REGISTRATION ${MAX_REGISTRATION}`);
  return p;
}

// The repository's roots: this checkout and, for a worktree, the main checkout.
export function repoRoots() {
  const roots = [path.resolve(HERE, "../../..")];
  try {
    const common = execFileSync("git", ["-C", HERE, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    roots.push(path.dirname(common));
  } catch {}
  return roots.map((r) => realpathSync.native(r));
}

// The signer's key from `file`: { pub (32 B), privateKey (a KeyObject) }. Never returns or prints the secret's text.
// Paths are compared as the file system spells them (realpathSync.native), so a case-changed path on a
// case-insensitive disk is still inside its root.
export function loadKey(file, parent, roots = repoRoots()) {
  const real = realpathSync.native(file);
  roots = roots.map((r) => realpathSync.native(r));
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

function signTx(tx, privateKey) {
  const hash = createHash("sha256").update(tx).digest();
  return { hash: b58encode(hash), signed: Buffer.concat([tx, Buffer.from([0]), sign(null, hash, privateKey)]) };
}

async function rpc(url, method, params) {
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "deploy", method, params }),
      signal: AbortSignal.timeout(180_000),
      // an answer comes from the URL asked, never from where a redirect points
      redirect: "error",
    });
  } catch (e) {
    // fetch says only "fetch failed"; its cause names why (a redirect, a refused connection)
    throw new Error(`${method} on ${url}: ${e.message}${e.cause?.message ? `: ${e.cause.message}` : ""}`);
  }
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
  const known = new Set(["--build-only", "--verify-records", "--flavor", "--build-dir", "--network", "--rpc", "--parent", "--key-file", "--vault", "--wasm", "--out", "--deployment"]);
  const flags = new Set(["--build-only", "--verify-records"]);
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
  const buildDir = o["build-dir"] ? path.resolve(o["build-dir"]) : path.join(os.tmpdir(), `blindfill-vault-build-${stamp}-${process.pid}`);

  if (o["verify-records"]) {
    const done = await verifyRecords({ buildDir });
    console.log(`records: ${done.filter((d) => d.sha).length} rebuilt to their code hash, ${done.filter((d) => d.note).length} noted as non-reproducible`);
    return;
  }

  if (o["build-only"]) {
    const b = await reproducibleBuild({ flavor: o.flavor ?? "testnet", buildDir });
    console.log(`reproducible: both builds sha256 ${b.sha}, ${b.wasm.length} B; wasm ${b.file}`);
    const p = deployProblems(b.wasm, o.flavor ?? "testnet");
    if (p.length) throw new Error(`the build would be refused: ${p.join("; ")}`);
    if (o.deployment) {
      const pp = pinProblems(b.wasm, JSON.parse(readFileSync(o.deployment, "utf8")));
      if (pp.length) throw new Error(`the build is not the pin of ${o.deployment}: ${pp.join("; ")}`);
      console.log(`the pin of ${o.deployment}: the build's sha256 ${b.sha} equals it`);
    }
    return;
  }

  const network = o.network;
  if (network !== "testnet" && network !== "sandbox" && network !== "mainnet") throw new Error("--network testnet|sandbox|mainnet");
  // mainnet deploys the pinned wasm only: never built on the owner's machine, never another vault by default
  let record = null;
  if (network === "mainnet") {
    if (!o.wasm || !o.deployment || !o.vault || !o.out || o.rpc || o.flavor || o["build-dir"]) throw new Error("--network mainnet takes --wasm, --deployment, --vault and --out, and no --rpc, --flavor or --build-dir: it deploys the pinned build to two public RPCs' network");
    record = JSON.parse(readFileSync(o.deployment, "utf8"));
  }
  if (!o.parent || !o["key-file"]) throw new Error("--parent and --key-file are required");
  const parent = o.parent;
  const rpcs = network === "testnet" ? TESTNET_RPCS : network === "mainnet" ? MAINNET_RPCS : [o.rpc];
  if (!rpcs[0]) throw new Error("--network sandbox needs --rpc <url>");
  const rp = rpcProblems(network, rpcs[0]);
  if (rp.length) throw new Error(rp.join("; "));
  if (network === "testnet" && (o.rpc || o.wasm)) throw new Error("--network testnet takes no --rpc or --wasm: it reads two public RPCs and builds the wasm itself, twice");
  if (network === "testnet" && o.flavor && o.flavor !== "testnet") throw new Error("--network testnet deploys the testnet build only");
  const url = rpcs[0];
  const vault = o.vault ?? `vault.${parent}`;
  const idp = vaultIdProblems(vault, parent);
  if (idp.length) throw new Error(idp.join("; "));
  const out = o.out ?? (network === "testnet" ? path.join(CRATE, "deployments", "testnet-vault.json") : null);
  if (!out) throw new Error("--network sandbox needs --out <file>");

  // the parent's key, read and checked before the build so a wrong key costs no build
  const { pub, privateKey } = loadKey(o["key-file"], parent);
  const pubText = `ed25519:${b58encode(pub)}`;

  // a public chain's vault names its source: testnet builds HEAD here, so the tree is clean and HEAD is on REPO;
  // mainnet deploys the record's build, so the record's commit is on REPO (pinProblems holds the rest). The sandbox is
  // this machine's own chain, with nothing anyone else rebuilds.
  if (network === "testnet") {
    const head = execFileSync("git", ["-C", CRATE, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const sp = sourceProblems({ commit: head });
    if (sp.length) throw new Error(`${sp.join("; ")}: nothing was built or sent`);
  }
  if (network === "mainnet" && /^[0-9a-f]{40}$/.test(record.source_commit ?? "")) {
    const sp = sourceProblems({ commit: record.source_commit, clean: false });
    if (sp.length) throw new Error(`refused before any send: ${sp.join("; ")}`);
  }

  // 1-2. the wasm: built twice here, or (sandbox only) the file given; refused before any send if it breaks a rule
  let wasm, build, shas, commit;
  if (o.wasm) {
    wasm = readFileSync(o.wasm);
    build = `given: ${o.wasm}`;
    shas = [sha256(wasm)];
  } else {
    const b = await reproducibleBuild({ flavor: network === "testnet" ? "testnet" : (o.flavor ?? "mainnet"), buildDir });
    wasm = b.wasm;
    build = b.build;
    shas = b.shas;
    commit = b.commit;
    console.log(`reproducible: both builds sha256 ${b.sha}`);
  }
  const sha = sha256(wasm);
  const source = deploySource({ network, wasmFile: o.wasm, commit });
  const problems = [...deployProblems(wasm, network), ...(network === "mainnet" ? pinProblems(wasm, record, vault) : [])];
  if (problems.length) throw new Error(`refused before any send: ${problems.join("; ")}`);
  if (network === "mainnet") {
    build = record.build;
    shas = record.wasm_builds_sha256;
  }
  const bodies = functionBodies(wasm);
  console.log(`wasm ${wasm.length} B, sha256 ${sha}, ${bodies.length} functions, largest body ${Math.max(...bodies)} B (limit ${MAX_FUNCTION_BODY})`);

  // 3. every RPC this run uses answers the network's chain id; then the parent's nonce; the vault must not exist yet
  for (const u of rpcs) {
    const status = await rpc(u, "status", []);
    const cp = chainProblems(network, status?.chain_id);
    if (cp.length) throw new Error(`refused before any send: ${u}: ${cp.join("; ")}`);
    console.log(`chain on ${u}: ${status.chain_id}`);
  }
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
  if (network === "mainnet") {
    const acct = await rpc(url, "query", { request_type: "view_account", account_id: parent, finality: "final" });
    const bp = balanceProblems(acct.amount, transfer);
    if (bp.length) throw new Error(`refused before any send: ${bp.join("; ")}`);
    console.log(`the parent holds ${acct.amount} yocto: it pays ${transfer} of code storage, the registration and the gas`);
  }
  let block = await rpc(url, "block", { finality: "final" });
  const tx = recipeTx({ signer: parent, publicKey: pub, nonce: BigInt(ak.nonce) + 1n, receiver: vault, blockHash: b58decode(block.header.hash), wasm, transfer, configGas: CONFIG_GAS });
  const rcp = recipeProblems(tx);
  if (rcp.length) throw new Error(`refused before any send: ${rcp.join("; ")}`);
  console.log(`sending tx ${signTx(tx, privateKey).hash}: [CreateAccount, Transfer(${transfer}), DeployContract(${wasm.length} B), FunctionCall(config, ${CONFIG_GAS / TGAS} Tgas, 0)] from ${parent} to ${vault}, no AddKey`);
  const d = await send(url, tx, privateKey, "the recipe");
  // the deploy is on chain from here: its record is written before any read that could stop the run
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify({ ...(network === "mainnet" ? record : {}), ...source, network, account_id: vault, parent, tx_hash: d.hash, stage: "deployed: the read-back and the registration are not recorded yet", wasm_sha256: sha, deployed_at: new Date().toISOString() }, null, 2) + "\n");
  console.log(`deployed: tx ${d.hash}; partial record ${out}`);
  const config = JSON.parse(Buffer.from(d.r.status.SuccessValue, "base64").toString("utf8"));
  if (network === "testnet" && (config.asset !== TESTNET_TOKEN || !TESTNET_VERSION.test(config.version))) throw new Error(`deployed, but config() names asset ${config.asset}, version ${config.version}: not the testnet build`);
  if (network === "mainnet" && (config.asset !== MAINNET_USDC || !MAINNET_VERSION.test(config.version))) throw new Error(`deployed ${vault} (tx ${d.hash}), but config() names asset ${config.asset}, version ${config.version}: not the mainnet build`);
  // the scope the record computed ahead (context.rs scope_for over the account and the token) against the one the vault
  // answers: said, never thrown, since the vault is deployed by now and the read-back and the registration must still run
  if (network === "mainnet" && record.scope !== undefined) console.log(config.scope === record.scope ? `config() scope ${config.scope} is the record's` : `SCOPE DIFFERS: config() names ${config.scope}, the record computed ${record.scope}; the record now holds config()'s`);
  const vaultReceipt = d.r.receipts_outcome.find((x) => x.outcome.executor_id === vault);
  console.log(`deployed: tx ${d.hash}; config() asset ${config.asset}, version ${config.version}; the vault's receipt burnt ${vaultReceipt?.outcome.gas_burnt} gas`);

  // 4. read back: no key, the build's code
  const reads = network === "sandbox" ? [[url, "optimistic"], [url, "final"]] : rpcs.map((u) => [u, "final"]);
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
  const regp = registrationProblems(bounds);
  if (regp.length) throw new Error(`deployed ${vault} (tx ${d.hash}), registration refused before signing: ${token}: ${regp.join("; ")}`);
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
    ...(network === "mainnet" ? record : {}),
    ...source,
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
  console.log(nextLine(network, path.relative(path.resolve(CRATE, "../.."), path.resolve(out)), { account: vault, signer: parent }));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`deploy: ERROR: ${String(e.message)}`);
    process.exit(e.signal ? 128 + os.constants.signals[e.signal] : (e.exitCode ?? 1));
  });
}
