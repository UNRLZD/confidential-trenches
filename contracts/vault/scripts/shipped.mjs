#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Whether a vault wasm is the one the mainnet deploy ships (card vault-sandbox-shipped-bytes): the reproducible build
// deploy.mjs --build-only --flavor mainnet makes, which tests/harness/run.sh --reproducible builds and every CI sandbox
// shard loads. Its NEP-330 metadata names the commit it was built at, so no sha256 committed in the repo can be it
// (vault-build.yml); the wasm must instead carry the metadata of a reproducible mainnet build of HEAD (deploy.mjs
// metadataProblems: this repository at HEAD, the image Cargo.toml pins by digest, the mainnet container command) and,
// when one is given, be that sha256 (CI's build job's). A host build (cargo near build non-reproducible-wasm) carries
// no build_info and is refused by name.
//   node contracts/vault/scripts/shipped.mjs <wasm> [<sha256>]   prints the wasm's size and sha256, exit 0 when it is
//                                                                the shipped build of HEAD, else REFUSED: and why
//                                                                on stderr, exit 1
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPRODUCIBLE, metadataProblems } from "./deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// What keeps `wasm` from being the vault the mainnet deploy ships, built at `commit`: [] when it is. With `sha`, the
// wasm must also be those bytes.
export function shippedProblems(wasm, { commit, sha }) {
  const p = metadataProblems(wasm, { commit, flavor: "mainnet" });
  if (sha !== undefined && sha256(wasm) !== sha) p.push(`its sha256 ${sha256(wasm)} is not ${sha}, the one the build job built`);
  return p;
}

// The line run.sh prints for the vault wasm a run loads, and whether the run may go on with it. `commit` defaults to
// this checkout's HEAD.
export function shippedLine(file, { commit, sha } = {}) {
  const wasm = readFileSync(file);
  commit ??= execFileSync("git", ["-C", HERE, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const what = `vault wasm ${file} ${wasm.length} B sha256 ${sha256(wasm)}`;
  const p = shippedProblems(wasm, { commit, sha });
  if (p.length) return [false, `REFUSED: ${what} is not the vault the mainnet deploy ships: ${p.join("; ")}`];
  return [true, `${what}: the vault the mainnet deploy ships, the reproducible mainnet build of ${commit} (${REPRODUCIBLE.image}@${REPRODUCIBLE.image_digest})`];
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [file, sha] = process.argv.slice(2);
  if (!file) {
    console.error("usage: node contracts/vault/scripts/shipped.mjs <wasm> [<sha256>]");
    process.exit(2);
  }
  const [ok, line] = shippedLine(file, { sha });
  (ok ? console.log : console.error)(line);
  process.exit(ok ? 0 : 1);
}
