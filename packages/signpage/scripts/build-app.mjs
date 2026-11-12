#!/usr/bin/env node
// Builds the signing page's one script: src/main.ts and the wallet code it imports, bundled by Vite (rolldown) into
// public/app.js, and index.html with that file's sha384, since SIGN_HOST's Integrity-Policy blocks a script without
// integrity metadata (public/_headers). It also writes public/prover-worker.js, the kit's prover worker as the kit's
// build.mjs makes it (snarkjs 0.7.5's pinned browser build, then worker.js with the setup files' pins), unchanged: the
// prover runs on SIGN_HOST only (card signpage-prover-host; vault.md 2.14, M304 D-8), and public/prover-thread.js, the
// one file that worker starts its threads from (the kit's build.mjs, card signpage-prover-threads), and public/walk-worker.js,
// the restore's walk Worker (packages/wallet/src/restore/walk-worker.ts and what it imports, bundled by the same Vite setup
// into one module file with no chunk, no import at runtime and no eval; card restore-shows-the-balance-in-seconds), which
// the page starts at /walk-worker.js (src/walk-workers.ts). The five files are build
// output, never committed (card signpage-generated-merge-free: a committed bundle conflicted on every pair of signing
// page branches; scripts/ci/sign-build-inputs.mjs SIGN_BUILD_OUTPUTS, held by scripts/ci/no-tracked-build-output.mjs).
// Every reader in this repository builds them first (scripts/signpage-built.mjs signBuilt, once per process), the deploy builds
// them at HEAD into its own folder (scripts/deploy.mjs build(), `--out`), and the release list pins their bytes, so a
// release is still checked byte for byte.
// The six setup files (24 MB) are not copied into public/: the deploy's build copies them from packages/kit/zk/ to
// /assets/zk/<sha256>.<ext> (vault.md V2's end state) with copyServed below, which refuses any whose size or sha256
// is not its pin, and the licence texts beside them to /licenses/ (the worker's header names /licenses/GPL-3.0.txt).
//   node packages/signpage/scripts/build-app.mjs           writes public/app.js, index.html, public/prover-worker.js,
//     public/prover-thread.js and public/walk-worker.js
//   node packages/signpage/scripts/build-app.mjs --out <dir> [--pkg <dir>]   writes them into <dir> as served: index.html,
//     app.js, prover-worker.js, prover-thread.js, walk-worker.js (the deploy's build), from <pkg>'s sources (this package's
//     by default)
//   node packages/signpage/scripts/build-app.mjs --out <dir> --network testnet   the testnet build into <dir>, with its
//     _headers (SIGN_HOST's policy and the testnet EVM providers, signHeadersFor)
//   node packages/signpage/scripts/build-app.mjs --check   exit 1 when the files on disk differ from a fresh build,
//     or the fresh bundle carries a test path (bundleModuleProblems)
// No test path marks a wallet as armed (card signpage-pool-kinds, carried from signpage-solana-trade): only a test writes an
// arm record into a signing state, in its own fake store. The release build holds that: the bundle's module list has no
// test file, test helper or test-only package, and no source module in it writes a wallet into READY (an arm record is
// READY only from the device's own arming withdrawal, which no bundled module makes today; settleArm and moveArmRecord
// only move a READY record on).
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVER_THREAD_FILE, PROVER_WORKER_FILE, proverThreadSource, proverWorkerSource } from "../../kit/src/prover/build.mjs";
import { ZK_SETUP_FILES } from "../../kit/src/zk/setup-files.ts";
import { isSignBuildInput, SIGN_BUILD_INPUTS } from "../../../scripts/ci/sign-build-inputs.mjs";

export { SIGN_BUILD_INPUTS };

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const KIT = join(dirname(PKG), "kit");
export const sha384 = (bytes) => `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const WORKER = `public/${PROVER_WORKER_FILE}`;
export const THREAD = `public/${PROVER_THREAD_FILE}`;
/** The restore's walk Worker, served at /walk-worker.js (src/walk-workers.ts starts it there). */
export const WALK_FILE = "walk-worker.js";
export const WALK = `public/${WALK_FILE}`;
/** Its entry, relative to the signing page's package: the wallet's Worker side of the walk. */
export const WALK_ENTRY = "../wallet/src/restore/walk-worker.ts";

/**
 * What the deploy's build copies besides index.html and public/: { from, to, bytes?, sha256? }, `to` relative to the
 * build folder. The six setup files go to assets/zk/<sha256>.<ext>, each with its pin (packages/kit/src/zk/setup-files.ts);
 * the licences beside them (packages/kit/zk/NOTICE) and the GPL text the worker's header names go to licenses/.
 */
export const SERVED = Object.freeze([
  ...Object.entries(ZK_SETUP_FILES).map(([name, pin]) =>
    Object.freeze({ from: join(KIT, "zk", name), to: `assets/zk/${pin.sha256}.${name.slice(name.lastIndexOf(".") + 1)}`, bytes: pin.bytes, sha256: pin.sha256, name })),
  Object.freeze({ from: join(KIT, "zk", "LICENSE-GPL-3.0.txt"), to: "licenses/GPL-3.0.txt" }),
  Object.freeze({ from: join(KIT, "zk", "LICENSE-LGPL-3.0.txt"), to: "licenses/LGPL-3.0.txt" }),
  Object.freeze({ from: join(dirname(dirname(PKG)), "LICENSE"), to: "licenses/Apache-2.0.txt" }),
  Object.freeze({ from: join(KIT, "zk", "NOTICE"), to: "licenses/zk-NOTICE.txt" }),
]);
// every file SERVED copies is one of the build's inputs, the paths the verify gate compares a release list's tree on
const REPO = dirname(dirname(PKG));
for (const e of SERVED) {
  const path = relative(REPO, e.from).split(sep).join("/");
  if (!isSignBuildInput(path)) throw new Error(`SERVED copies ${path}, which is not in SIGN_BUILD_INPUTS (scripts/ci/sign-build-inputs.mjs)`);
}

/** Problems with one setup file's bytes against its pin (empty = it is the pinned file), named `label`. */
export function pinProblems(entry, bytes, label = entry.to) {
  if (bytes.length !== entry.bytes) return [`${label}: ${bytes.length} B, pinned ${entry.bytes} B`];
  const got = sha256(bytes);
  return got === entry.sha256 ? [] : [`${label}: sha256 ${got}, pinned ${entry.sha256}`];
}

/** Copies `list` into `out`; throws before writing anything when a setup file is not its pin. */
export function copyServed(out, list = SERVED) {
  for (const e of list) {
    if (e.sha256 === undefined) continue;
    const p = pinProblems(e, readFileSync(e.from), e.name);
    if (p.length) throw new Error(`${p[0]} (from ${e.from}); nothing was copied`);
  }
  for (const e of list) {
    mkdirSync(dirname(join(out, e.to)), { recursive: true });
    copyFileSync(e.from, join(out, e.to), constants.COPYFILE_FICLONE); // a clone where the disk can, else a copy
  }
  // what is uploaded is read back against the pins by the deploy gate (deploy.mjs checkProver), after this copy
}

/** The page around the script: no inline script or style, nothing but the one module script with its integrity. */
export const page = (integrity) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark" />
    <script type="module" src="/app.js" integrity="${integrity}"></script>
  </head>
  <body></body>
</html>
`;

/** Every tsconfig.json in a folder above `repo` (the repository root). The bundler applies the nearest tsconfig.json
 *  above each module it transforms, so with none in the repository's own folders one above the root would be applied
 *  (review P1(b): useDefineForClassFields false changed app.js); the build's inputs are the repository's alone. */
/** The files a build writes, path -> bytes: in the package (public/...) or, `served`, in the served layout (--out).
 *  build-app.test.mjs holds the package's set to SIGN_BUILD_OUTPUTS, the files CI's bundle scan copies, ignores and
 *  scans, so a fifth output is never written unscanned (review of 31f81cbd, P3). */
export function outputFiles({ js, html, worker, thread, walk }, served) {
  return served
    ? { "index.html": html, "app.js": js, [PROVER_WORKER_FILE]: worker, [PROVER_THREAD_FILE]: thread, [WALK_FILE]: walk }
    : { "index.html": html, "public/app.js": js, [WORKER]: worker, [THREAD]: thread, [WALK]: walk };
}

export function outsideTsconfigs(repo = REPO) {
  const found = [];
  for (let d = dirname(repo); ; d = dirname(d)) {
    if (existsSync(join(d, "tsconfig.json"))) found.push(join(d, "tsconfig.json"));
    if (dirname(d) === d) return found;
  }
}

/** The connect-src sources only the testnet build's page reaches (card evm-pools-on-mainnet): the kit's testnet EVM
 *  venues' providers (Base Sepolia, Robinhood testnet), which SIGN_HOST's build carries none of. public/_headers is
 *  SIGN_HOST's (mainnet) policy; signHeadersFor puts these back, in their old place, for a testnet build's server. */
export const TESTNET_CONNECT = Object.freeze(["https://base-sepolia-rpc.publicnode.com", "https://base-testnet.api.pocket.network", "https://sepolia.base.org", "https://rpc.testnet.chain.robinhood.com", "https://robinhood-sepolia-rpc.publicnode.com", "https://robinhood-testnet.drpc.org"]);
/** The _headers text a `network` build is served with: SIGN_HOST's own on mainnet; on testnet the same with
 *  TESTNET_CONNECT added to the page's connect-src after the Robinhood mainnet providers, or an error when the text has
 *  no such place (one, in the /* rule). */
export function signHeadersFor(network, text) {
  if (!NETWORKS.includes(network)) throw new Error("network: mainnet or testnet");
  if (network === "mainnet") return text;
  const at = " https://robinhood.daybreak-rpc.network ";
  const parts = text.split(at);
  if (parts.length !== 2) throw new Error("_headers: the Robinhood mainnet providers are not in connect-src exactly once");
  return parts.join(` https://robinhood.daybreak-rpc.network ${TESTNET_CONNECT.join(" ")} `);
}

/** The networks a build is for (card signpage-pool-flow): SIGN_HOST's, and the testnet build's (Solana devnet, Base
 *  Sepolia, Robinhood testnet). The wallet's pool/network.ts reads it as __SIGN_NETWORK__, folded at build time. */
export const NETWORKS = Object.freeze(["mainnet", "testnet"]);

/** One entry bundled by the page's Vite (rolldown) setup into one ES module file named `name`: { bytes, modules,
 *  chunks, imports } (imports: the static and dynamic imports the chunk still makes at runtime, none when self-contained). */
async function bundleOne(pkg, network, input, name) {
  const { build } = await import("vite");
  const out = mkdtempSync(join(tmpdir(), "ct-signpage-app-"));
  try {
    const res = await build({
      configFile: false,
      root: pkg,
      logLevel: "warn",
      publicDir: false,
      define: { __SIGN_NETWORK__: JSON.stringify(network) },
      build: {
        outDir: out,
        emptyOutDir: true,
        target: "es2023",
        minify: true,
        modulePreload: false,
        copyPublicDir: false,
        rolldownOptions: {
          input,
          output: { format: "es", entryFileNames: name, codeSplitting: false },
        },
      },
    });
    const bytes = readFileSync(join(out, name));
    const chunks = [res].flat().flatMap((r) => r.output).filter((o) => o.type === "chunk");
    const modules = chunks[0] ? [...chunks[0].moduleIds] : [];
    const imports = chunks.flatMap((c) => [...(c.imports ?? []), ...(c.dynamicImports ?? [])]);
    return { bytes, modules, chunks: chunks.length, imports };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** A fresh bundle for `network` (SIGN_HOST's, mainnet, unless named): { js, html, worker, thread, walk } as bytes, text,
 *  bytes, bytes and bytes, app.js's module ids and number of chunks, and the walk Worker's (walkModules, walkChunks,
 *  walkImports: what it would import at runtime, none). */
export async function bundle(pkg = PKG, { network = "mainnet", repo = REPO } = {}) {
  if (!NETWORKS.includes(network)) throw new Error("network: mainnet or testnet");
  const above = outsideTsconfigs(repo);
  if (above.length) throw new Error(`a tsconfig.json above the repository root would change the build, which reads only the repository's: ${above.join(", ")}: move it away`);
  const app = await bundleOne(pkg, network, join(pkg, "src/main.ts"), "app.js");
  const walk = await bundleOne(pkg, network, join(pkg, WALK_ENTRY), WALK_FILE);
  // chunks: how many the build made (one, codeSplitting off), so a reader of `modules` knows it read them all
  return {
    js: app.bytes, html: page(sha384(app.bytes)), worker: proverWorkerSource(), thread: proverThreadSource(), walk: walk.bytes,
    modules: app.modules, chunks: app.chunks, walkModules: walk.modules, walkChunks: walk.chunks, walkImports: walk.imports,
  };
}

/** Problems with the walk Worker's bytes (empty = fine): it must run as one file under its own policy (script-src 'self',
 *  no 'unsafe-eval'), so it may import, export, eval, make a Function or importScripts nothing. Read on the minified text,
 *  beside the bundler's own import list (bundle().walkImports). */
export function walkSourceProblems(bytes) {
  const t = bytes.toString("utf8");
  const p = [];
  if (/(?:^|[;}\n])\s*import\s*(?:[\w$*{]|["'`])/.test(t)) p.push("walk-worker.js has a static import");
  if (/\bimport\s*\(/.test(t)) p.push("walk-worker.js has a dynamic import");
  if (/(?:^|[;}\n])\s*export\s*(?:[{*]|default\b|const\b|let\b|var\b|function\b|class\b)/.test(t)) p.push("walk-worker.js exports");
  if (/\beval\s*\(/.test(t)) p.push("walk-worker.js calls eval");
  if (/\bFunction\s*\(/.test(t)) p.push("walk-worker.js makes a Function");
  if (/\bimportScripts\s*\(/.test(t)) p.push("walk-worker.js calls importScripts");
  return p;
}

/** A test file, a test helper, or Node's own test runner, by module id. */
const TEST_PATH = /(^|[\\/])(test|tests|__tests__|fixtures)[\\/]|\.(test|spec|e2e)\.[cm]?[jt]sx?$|^node:test$/;
/** The package's dev-only packages (its devDependencies: the fake store, the browser driver, the bundler...): none of
 *  them may be in the bundle, by module id. */
const DEV_ONLY = Object.keys(JSON.parse(readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), "package.json"), "utf8")).devDependencies ?? {});
const devOnly = (id) => DEV_ONLY.some((name) => id.split(/[\\/]/).join("/").includes(`/node_modules/${name}/`));
/** A source line that puts a wallet into READY: an arm record made armed (`state: "READY"`, `to: "READY"`). */
const ARMS = /\b(state|to)\s*:\s*["']READY["']/;

/**
 * Problems with a bundle's module list: a module on a test path, or a source module (outside node_modules) whose text
 * puts a wallet into READY. `read` gives a module's source text (the file on disk for a real build).
 */
export function bundleModuleProblems(modules, read = (id) => readFileSync(id.split("?")[0], "utf8")) {
  const p = [];
  if (!modules.length) p.push("the bundle's module list is empty: the build gave none to check");
  for (const id of modules) {
    if (TEST_PATH.test(id) || devOnly(id)) p.push(`the bundle carries a test path: ${id}`);
    else if (!/[\\/]node_modules[\\/]/.test(id) && !id.startsWith("\0") && /\.[cm]?[jt]sx?$/.test(id.split("?")[0]) && ARMS.test(read(id))) {
      p.push(`the bundle carries a module that puts a wallet into READY: ${id}`);
    }
  }
  return p;
}

/** Problems with a fresh bundle's walk Worker (empty = fine): one chunk, no import left at runtime, no test path, none
 *  of the bundled-text refusals of walkSourceProblems. */
export function walkBundleProblems({ walk, walkModules, walkChunks, walkImports }) {
  const p = [];
  if (walkChunks !== 1) p.push(`walk-worker.js is ${walkChunks} chunks, not one file`);
  if (walkImports.length) p.push(`walk-worker.js imports at runtime: ${walkImports.join(", ")}`);
  p.push(...bundleModuleProblems(walkModules).map((l) => `walk-worker.js: ${l}`));
  p.push(...walkSourceProblems(walk));
  return p;
}

/** Problems with the committed files (in `committed`, the package by default) against a fresh build (empty = they match). */
export async function check(pkg = PKG, committed = pkg) {
  const fresh = await bundle(pkg);
  const p = [];
  let js = null;
  try {
    js = readFileSync(join(committed, "public/app.js"));
  } catch {}
  if (!js || !js.equals(fresh.js)) p.push("public/app.js is not the build of src/main.ts: run node packages/signpage/scripts/build-app.mjs");
  if (readFileSync(join(committed, "index.html"), "utf8") !== fresh.html) p.push("index.html is not the page around public/app.js with its sha384");
  let worker = null;
  try {
    worker = readFileSync(join(committed, WORKER));
  } catch {}
  if (!worker || !worker.equals(fresh.worker)) p.push(`${WORKER} is not the kit's prover worker build: run node packages/signpage/scripts/build-app.mjs`);
  let thread = null;
  try {
    thread = readFileSync(join(committed, THREAD));
  } catch {}
  if (!thread || !thread.equals(fresh.thread)) p.push(`${THREAD} is not the kit's prover thread build: run node packages/signpage/scripts/build-app.mjs`);
  let walk = null;
  try {
    walk = readFileSync(join(committed, WALK));
  } catch {}
  if (!walk || !walk.equals(fresh.walk)) p.push(`${WALK} is not the build of packages/wallet/src/restore/walk-worker.ts: run node packages/signpage/scripts/build-app.mjs`);
  p.push(...bundleModuleProblems(fresh.modules));
  p.push(...walkBundleProblems(fresh));
  return p;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const p = await check();
    for (const l of p) console.error(`build-app: ${l}`);
    if (!p.length) console.log(`build-app: public/app.js, index.html, ${WORKER}, ${THREAD} and ${WALK} match a fresh build`);
    process.exit(p.length ? 1 : 0);
  }
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    if (i < 0) return undefined;
    const v = process.argv[i + 1];
    if (!v || v.startsWith("--")) {
      console.error(`build-app: ${name} needs a folder`);
      process.exit(2);
    }
    return v;
  };
  const out = arg("--out");
  const pkg = arg("--pkg") ?? PKG;
  // --network testnet: the testnet build (Solana devnet, Base Sepolia, Robinhood testnet), for a devnet browser run
  // into --out only (card app-a2-e2e); never the package's own public/, which SIGN_HOST's deploy reads
  const network = arg("--network") ?? "mainnet";
  if (network !== "mainnet" && !out) {
    console.error("build-app: --network testnet needs --out");
    process.exit(2);
  }
  const b = await bundle(pkg, { network });
  const { js, html, worker, thread, walk } = b;
  // the release build refuses a walk Worker that is not one self-contained file, before anything is written
  const wp = walkBundleProblems(b);
  if (wp.length) {
    for (const l of wp) console.error(`build-app: ${l}`);
    process.exit(1);
  }
  const files = outputFiles({ js, html, worker, thread, walk }, Boolean(out));
  // a testnet build's folder is served by its run's own server: it gets its policy beside it (signHeadersFor), since
  // SIGN_HOST's public/_headers names no testnet EVM provider
  if (network === "testnet") files._headers = signHeadersFor("testnet", readFileSync(join(pkg, "public/_headers"), "utf8"));
  const dir = out ?? pkg;
  // each file is written beside itself and renamed into place, so a reader in another process (node --test runs test
  // files at once, each building) reads a whole file, never a half-written one; every build of one tree is the same bytes
  for (const [rel, bytes] of Object.entries(files)) {
    const to = join(dir, rel);
    mkdirSync(dirname(to), { recursive: true });
    const tmp = `${to}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, to);
  }
  console.log(`build-app: ${out ? "app.js" : "public/app.js"} ${js.length} bytes, ${sha384(js)}${out ? ` (in ${out})` : ""}`);
  console.log(`build-app: ${WORKER} ${worker.length} bytes, sha256 ${sha256(worker)}`);
  console.log(`build-app: ${THREAD} ${thread.length} bytes, sha256 ${sha256(thread)}`);
  console.log(`build-app: ${out ? WALK_FILE : WALK} ${walk.length} bytes, sha256 ${sha256(walk)}`);
}
