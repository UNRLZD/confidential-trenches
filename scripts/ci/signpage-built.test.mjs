// node --test scripts/ci/signpage-built.test.mjs: signBuilt() builds the signing page only where its last build's stamp
// does not name the build's inputs and outputs as they are (card readme-run-fits-an-agent-timeout): an input or output
// changed, added or removed, another node, or no stamp builds; the same state builds nothing; a build that fails writes
// no stamp, and one whose inputs changed while it ran writes none either. The real tree's build reads its inputs as it
// found them, so its stamp holds for the next process.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
// (the stamp's two failure modes were each planted in signpage-built.mjs: a stamp that ignores the outputs fails the
// first test, one written after a build whose inputs changed fails the second)
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildState, buildUnlessStamped, signBuilt, STAMP, SIGN_PKG } from "../signpage-built.mjs";

const INPUTS = ["src", "pub", "lock.yaml", "absent.json"];
const OUTPUTS = ["pub/app.js", "index.html"];

/** A tree with two input folders, an input file, a missing input, and its two outputs (one inside an input folder). */
function tree() {
  const root = mkdtempSync(path.join(tmpdir(), "signpage-built-"));
  mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  mkdirSync(path.join(root, "pub"));
  writeFileSync(path.join(root, "src", "main.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, "src", "deep", "b.ts"), "export const b = 2;\n");
  writeFileSync(path.join(root, "pub", "_headers"), "/*\n");
  writeFileSync(path.join(root, "lock.yaml"), "lockfileVersion: 9\n");
  return root;
}

test("a build runs where no stamp names the tree's state, and not again until an input, an output or the node changes", () => {
  const root = tree();
  const stamp = path.join(root, "cache", "stamp.json");
  let builds = 0;
  // the stand-in build writes both outputs, as build-app.mjs does
  const build = () => {
    builds++;
    writeFileSync(path.join(root, "pub", "app.js"), `app ${builds}\n`);
    writeFileSync(path.join(root, "index.html"), `<p>${builds}</p>\n`);
  };
  const run = () => buildUnlessStamped({ root, build, stamp, inputs: INPUTS, outputs: OUTPUTS });
  const later = (f) => utimesSync(path.join(root, f), new Date(), new Date(Date.now() + 5_000));
  try {
    assert.equal(run(), true, "no stamp: built");
    assert.equal(run(), false, "the stamped state: not built");
    assert.equal(run(), false);
    // an output is not an input: the state's inputs leave pub/app.js out, its outputs name it
    const s = buildState(root, INPUTS, OUTPUTS);
    assert.ok(!s.inputs.includes("pub/app.js") && s.outputs.includes("pub/app.js ") && s.inputs.includes("absent.json missing"), s.inputs);
    const cases = [
      ["an input changed in place", () => writeFileSync(path.join(root, "src", "main.ts"), "export const a = 9;\n")],
      ["an input touched, its bytes the same", () => later("src/deep/b.ts")],
      ["an input added", () => writeFileSync(path.join(root, "src", "deep", "c.ts"), "export const c = 3;\n")],
      ["an input removed", () => unlinkSync(path.join(root, "src", "deep", "c.ts"))],
      ["a missing input made", () => writeFileSync(path.join(root, "absent.json"), "{}\n")],
      ["an input file outside a folder changed", () => writeFileSync(path.join(root, "lock.yaml"), "lockfileVersion: 10\n")],
      ["an output written over", () => writeFileSync(path.join(root, "pub", "app.js"), "a test's own app.js\n")],
      ["an output removed", () => unlinkSync(path.join(root, "index.html"))],
      ["the stamp removed", () => unlinkSync(stamp)],
      ["another node's stamp", () => writeFileSync(stamp, JSON.stringify({ ...JSON.parse(readFileSync(stamp, "utf8")), node: "v0.0.0" }))],
      ["a stamp that is not JSON", () => writeFileSync(stamp, "{")],
    ];
    for (const [name, change] of cases) {
      change();
      const n = builds;
      assert.equal(run(), true, `${name}: built`);
      assert.equal(builds, n + 1, name);
      assert.equal(run(), false, `${name}: then stamped`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a build that throws leaves no stamp, and one whose inputs changed while it ran leaves none either", () => {
  const root = tree();
  const stamp = path.join(root, "stamp.json");
  try {
    const failed = () => {
      throw new Error("the signing page's build failed");
    };
    assert.throws(() => buildUnlessStamped({ root, build: failed, stamp, inputs: INPUTS, outputs: OUTPUTS }), /build failed/);
    assert.throws(() => readFileSync(stamp), /ENOENT/);
    // an input written during the build: the outputs may be of the old one, so the next process builds again
    const racing = () => writeFileSync(path.join(root, "src", "main.ts"), "export const a = 'during';\n");
    assert.equal(buildUnlessStamped({ root, build: racing, stamp, inputs: INPUTS, outputs: OUTPUTS }), true);
    assert.throws(() => readFileSync(stamp), /ENOENT/);
    let builds = 0;
    assert.equal(buildUnlessStamped({ root, build: () => builds++, stamp, inputs: INPUTS, outputs: OUTPUTS }), true);
    assert.equal(buildUnlessStamped({ root, build: () => builds++, stamp, inputs: INPUTS, outputs: OUTPUTS }), false);
    assert.equal(builds, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real tree: the build changes none of its inputs, so its stamp names the tree as the next process finds it", () => {
  assert.equal(signBuilt(), SIGN_PKG);
  const stamp = JSON.parse(readFileSync(STAMP, "utf8"));
  const now = buildState();
  assert.equal(stamp.inputs, now.inputs);
  assert.equal(stamp.outputs, now.outputs);
  assert.ok(now.outputs.split("\n").every((l) => !l.endsWith(" missing")), now.outputs);
  assert.equal(buildUnlessStamped({ build: () => assert.fail("built again on a stamped tree") }), false);
});
