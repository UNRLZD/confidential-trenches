// Writes prover-worker.js, the one file SIGN_HOST serves as its prover worker (vault.md 2.14, row V2.4):
//   1. a licence line;
//   2. snarkjs 0.7.5's browser build (build/snarkjs.min.js of the npm package the lockfile pins), byte for byte, refused
//      unless its size and sha256 are SNARKJS_BUILD's (vault.md 2.14's 710,896 B);
//   3. worker.js, with the setup files' pins (ZK_SETUP_FILES, zk/setup-files.ts) put in for its PINS.
// The page creates the worker from this file only through the Trusted Types policy `prover-worker` (client.ts).
//   node packages/kit/src/prover/build.mjs <out dir>     prints the file's path, size, sha256 and sha384
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZK_SETUP_FILES } from "../zk/setup-files.ts";

export const PROVER_WORKER_FILE = "prover-worker.js";

/** snarkjs's browser build as npm ships snarkjs@0.7.5 (read 2026-10-26, proofs/g1-phone-prover/pins/snarkjs.txt). */
export const SNARKJS_BUILD = Object.freeze({
  version: "0.7.5",
  bytes: 710896,
  sha256: "3bf5b5123047ed9187baa7d4c11285019f09fbed88a28693984ed9dd0508466a",
});

const HERE = dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER = "/*@PINS@*/ null";

/** The snarkjs.min.js of the kit's installed snarkjs. */
export function snarkjsBuildPath() {
  const main = createRequire(import.meta.url).resolve("snarkjs"); // build/main.cjs
  return join(dirname(main), "snarkjs.min.js");
}

const sha = (alg, b) => createHash(alg).update(b).digest(alg === "sha384" ? "base64" : "hex");

/** The worker file's bytes; throws when snarkjs.min.js is not the pinned build. */
export function proverWorkerSource({ snarkjsPath = snarkjsBuildPath() } = {}) {
  const sj = readFileSync(snarkjsPath);
  if (sj.length !== SNARKJS_BUILD.bytes) throw new Error(`snarkjs.min.js is ${sj.length} B, pinned ${SNARKJS_BUILD.bytes} B`);
  const got = sha("sha256", sj);
  if (got !== SNARKJS_BUILD.sha256) throw new Error(`snarkjs.min.js sha256 ${got}, pinned ${SNARKJS_BUILD.sha256}`);

  const body = readFileSync(join(HERE, "worker.js"), "utf8");
  if (body.split(PLACEHOLDER).length !== 2) throw new Error("worker.js must hold the pins placeholder exactly once");
  const pins = Object.fromEntries(Object.entries(ZK_SETUP_FILES).map(([name, p]) => [name, { bytes: p.bytes, sha256: p.sha256 }]));
  const head =
    `// Blindfill prover worker. snarkjs ${SNARKJS_BUILD.version} (https://github.com/iden3/snarkjs, GPL-3.0), its ` +
    `build/snarkjs.min.js unchanged, then @blindfill/kit's packages/kit/src/prover/worker.js (Apache-2.0).\n`;
  return Buffer.concat([
    Buffer.from(head),
    sj,
    Buffer.from("\n;\n"),
    Buffer.from(body.replace(PLACEHOLDER, () => JSON.stringify(pins))),
  ]);
}

/** Writes <out>/prover-worker.js and returns its path, size, sha256 (hex) and sha384 (base64, as SRI writes it). */
export function buildProverWorker(out, opts) {
  const src = proverWorkerSource(opts);
  mkdirSync(out, { recursive: true });
  const file = join(out, PROVER_WORKER_FILE);
  writeFileSync(file, src);
  return { file, bytes: src.length, sha256: sha("sha256", src), sha384: sha("sha384", src) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error("usage: node packages/kit/src/prover/build.mjs <out dir>");
    process.exit(2);
  }
  console.log(JSON.stringify(buildProverWorker(resolve(process.argv[2]))));
}
