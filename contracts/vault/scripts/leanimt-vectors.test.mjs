// node --test contracts/vault/scripts/leanimt-vectors.test.mjs (root script test:vault-scripts, run by CI's test job):
// VT-P01's fixture is recomputed from @zk-kit/lean-imt and the kit's VaultTree on every CI run (`--check --fast`), so
// a hand-edited fixture cannot agree with a wrong src/tree.rs; and the check refuses planted copies with one root
// changed, in a sequence's checkpoints and in the depth-32 boundary.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "leanimt-vectors.mjs");
const FIXTURE = path.join(HERE, "../tests/fixtures/leanimt-vectors.json");

function check(args) {
  return spawnSync(process.execPath, [SCRIPT, "--check", "--fast", ...args], { encoding: "utf8" });
}

/** A copy of the fixture with `edit` applied, in a fresh temp dir. */
function planted(edit) {
  const dir = mkdtempSync(path.join(tmpdir(), "leanimt-"));
  const file = path.join(dir, "leanimt-vectors.json");
  const f = JSON.parse(readFileSync(FIXTURE, "utf8"));
  edit(f);
  writeFileSync(file, `${JSON.stringify(f, null, 1)}\n`);
  return { file, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A different field element of the same length. */
const bump = (dec) => (dec.endsWith("1") ? `${dec.slice(0, -1)}2` : `${dec.slice(0, -1)}1`);

test("the committed fixture equals a fresh run of @zk-kit/lean-imt and VaultTree (fast)", () => {
  const r = check([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /leanimt-vectors: equal \(fast\): boundary, seed 1: 5000, seed 2: 3958, .*seed 9: 2402 in /);
  console.log(r.stdout.trim());
});

test("a fixture with one sequence root changed is refused", () => {
  const p = planted((f) => {
    f.sequences[0].checkpoints["2"] = bump(f.sequences[0].checkpoints["2"]);
  });
  try {
    const r = check(["--fixture", p.file]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /seed 1: the root at size 2/);
  } finally {
    p.done();
  }
});

test("a fixture with a depth-32 boundary root changed is refused", () => {
  const p = planted((f) => {
    f.boundary.last_leaf.root = bump(f.boundary.last_leaf.root);
  });
  try {
    const r = check(["--fixture", p.file]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /boundary/);
  } finally {
    p.done();
  }
});
