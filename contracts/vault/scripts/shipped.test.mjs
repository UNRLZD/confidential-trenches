// SPDX-License-Identifier: Apache-2.0
// contracts/vault/scripts/shipped.mjs: the check every CI sandbox shard runs on the vault wasm it loads (card
// vault-sandbox-shipped-bytes). The good wasm is one whose NEP-330 metadata is a reproducible mainnet build of the
// commit, as near-sdk 5.29.1 serialises it (deploy.test.mjs meta); each refusal is planted.
//   node --test contracts/vault/scripts/shipped.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CONTRACT_PATH, REPO, REPRODUCIBLE } from "./deploy.mjs";
import { shippedLine, shippedProblems } from "./shipped.mjs";

const SCRIPT = fileURLToPath(new URL("./shipped.mjs", import.meta.url));
const C = "c".repeat(40);
const meta = ({ commit = C, flavor = "mainnet", ...over } = {}) => ({
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
// run.sh's host build: near-sdk's metadata with no build_info (cargo near build non-reproducible-wasm)
const HOST = { version: "0.1.0", standards: [{ standard: "nep330", version: "1.3.0" }] };
// a minimal module with one custom section holding `text`
const module = (text) => {
  const body = Buffer.concat([Buffer.from([4]), Buffer.from("meta"), Buffer.from(text)]);
  const len = [];
  for (let n = body.length; ; n >>= 7) {
    if (n < 128) {
      len.push(n);
      break;
    }
    len.push((n & 127) | 128);
  }
  return Buffer.concat([Buffer.from("\0asm\x01\0\0\0", "latin1"), Buffer.from([0, ...len]), body]);
};
const sha = (b) => createHash("sha256").update(b).digest("hex");

test("the shipped vault: a reproducible mainnet build of the commit, and the sha256 when one is given", () => {
  const w = module(JSON.stringify(meta()));
  assert.deepEqual(shippedProblems(w, { commit: C }), []);
  assert.deepEqual(shippedProblems(w, { commit: C, sha: sha(w) }), []);
});

test("planted: a host build, another commit, image, flavor or sha256 is not the shipped vault", () => {
  const hp = shippedProblems(module(JSON.stringify(HOST)), { commit: C });
  assert.equal(hp.length, 5);
  assert.match(hp.join("; "), /build_info\.build_environment is null/);
  assert.deepEqual(shippedProblems(module("no metadata at all"), { commit: C }), ["the wasm holds no single NEP-330 contract_source_metadata"]);
  const other = shippedProblems(module(JSON.stringify(meta({ commit: "d".repeat(40) }))), { commit: C });
  assert.equal(other.length, 2);
  assert.match(other[0], /link is .*tree\/d{40}/);
  const image = meta();
  image.build_info.build_environment = REPRODUCIBLE.image;
  assert.equal(shippedProblems(module(JSON.stringify(image)), { commit: C }).length, 1);
  assert.match(shippedProblems(module(JSON.stringify(meta({ flavor: "testnet" }))), { commit: C })[0], /build_command is .*"testnet"\]/);
  const w = module(JSON.stringify(meta()));
  assert.deepEqual(shippedProblems(w, { commit: C, sha: "0".repeat(64) }), [`its sha256 ${sha(w)} is not ${"0".repeat(64)}, the one the build job built`]);
});

test("the line run.sh prints names the wasm, its size and sha256, and REFUSED: for any other", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vault-shipped-"));
  try {
    const good = path.join(dir, "blindfill_vault.wasm");
    const w = module(JSON.stringify(meta()));
    writeFileSync(good, w);
    assert.deepEqual(shippedLine(good, { commit: C, sha: sha(w) }),
      [true, `vault wasm ${good} ${w.length} B sha256 ${sha(w)}: the vault the mainnet deploy ships, the reproducible mainnet build of ${C} (${REPRODUCIBLE.image}@${REPRODUCIBLE.image_digest})`]);
    const bad = path.join(dir, "host.wasm");
    const h = module(JSON.stringify(HOST));
    writeFileSync(bad, h);
    const [ok, line] = shippedLine(bad, { commit: C });
    assert.equal(ok, false);
    assert.ok(line.startsWith(`REFUSED: vault wasm ${bad} ${h.length} B sha256 ${sha(h)} is not the vault the mainnet deploy ships: `), line);
    // the command line, against this checkout's HEAD: a host build exits 1 with the REFUSED: line on stderr, a
    // reproducible build of HEAD with its sha256 exits 0
    const r = spawnSync(process.execPath, [SCRIPT, bad], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^REFUSED: vault wasm .*host\.wasm .* is not the vault the mainnet deploy ships: /);
    const head = execFileSync("git", ["-C", path.dirname(SCRIPT), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const mine = path.join(dir, "head.wasm");
    writeFileSync(mine, module(JSON.stringify(meta({ commit: head }))));
    const r2 = spawnSync(process.execPath, [SCRIPT, mine, sha(readFileSync(mine))], { encoding: "utf8" });
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, new RegExp(`the reproducible mainnet build of ${head} `));
    const r3 = spawnSync(process.execPath, [SCRIPT, mine, "0".repeat(64)], { encoding: "utf8" });
    assert.equal(r3.status, 1);
    assert.match(r3.stderr, /the one the build job built/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
