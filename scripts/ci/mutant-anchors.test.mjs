// Card mutants-anchor-exactly-once: the mutant anchor gate (scripts/ci/mutant-anchors.mjs). A planted sweep whose
// mutant's anchor is missing from its file, and one whose anchor is in it twice, are refused, each naming the mutant and
// the file; a mutant whose anchor is found once passes; a sweep file the gate has no reader for is refused; a sequential
// sweep's later anchor is counted in the text the earlier edits planted. Then the gate on this tree: every mutant of
// every nightly sweep changes the code it names (the stale ones KNOWN_STALE lists apart).
//   node --test scripts/ci/mutant-anchors.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { anchorRefusals, KNOWN_STALE, mutantAnchors, NOT_SWEPT, SWEEPS } from "./mutant-anchors.mjs";
import { mutantCommands } from "./test-shards.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// a tree with one sweep file at `rel` (a path SWEEPS reads) planting into src.ts, tracked by git as the gate lists them
function plant(rel, list) {
  const dir = mkdtempSync(path.join(tmpdir(), "mutant-anchors-"));
  const src = path.join(dir, "src.ts");
  writeFileSync(src, "const a = 1;\nconst b = 2;\nconst b = 2;\n");
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), `const SRC = ${JSON.stringify(src)};\nexport const MUTANTS = ${JSON.stringify(list, null, 1).replace(/\n\]$/, "\n];")}\nthrow new Error("the runner is never run");\n`);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "--", rel], { cwd: dir });
  return dir;
}

// evm-pool-buy-mutants.mjs's shape: [find, replacement, test name] on its SRC
const BUY = "packages/kit/test/evm-pool-buy-mutants.mjs";

test("a mutant whose anchor is missing from its file is refused, naming the mutant and the file", async () => {
  const dir = plant(BUY, [["const gone = 3;", "", "M1 a line that moved away"]]);
  try {
    const { refusals, plants } = await mutantAnchors(dir);
    assert.equal(plants, 1);
    assert.deepEqual(refusals, [`${BUY}: mutant "M1 a line that moved away const gone = 3;": its anchor is in src.ts 0 times, not once: "const gone = 3;"`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mutant whose anchor is in its file twice is refused, naming the mutant and the file", async () => {
  const dir = plant(BUY, [["const b = 2;", "const b = 3;", "M2 one of two places"]]);
  try {
    const { refusals } = await mutantAnchors(dir);
    assert.deepEqual(refusals, [`${BUY}: mutant "M2 one of two places const b = 2;": its anchor is in src.ts 2 times, not once: "const b = 2;"`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mutant whose anchor is found once passes, beside the refused ones", async () => {
  const dir = plant(BUY, [["const a = 1;", "const a = 0;", "M3 the one place"], ["const gone = 3;", "", "M1 moved"]]);
  try {
    const { refusals, plants } = await mutantAnchors(dir);
    assert.equal(plants, 2);
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /"M1 moved const gone = 3;"/);
    assert.doesNotMatch(refusals.join("\n"), /M3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sweep file the gate has no reader for is refused, so a new sweep is read from its first commit", async () => {
  const dir = plant("packages/kit/test/new-thing-mutants.mjs", [["const a = 1;", "", "N1"]]);
  try {
    const { refusals } = await mutantAnchors(dir);
    assert.deepEqual(refusals, ["packages/kit/test/new-thing-mutants.mjs: a sweep file this gate has no reader for: add it to SWEEPS in scripts/ci/mutant-anchors.mjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sequential sweep's later anchor is counted in the text its earlier edits planted", () => {
  const text = "x = 1;\ny = 2;\n";
  const read = () => text;
  // the second anchor exists only once the first edit is planted: passes
  assert.deepEqual(anchorRefusals("s.mjs", [{ name: "S1", file: "/f.ts", finds: ["x = 1;", "x = 9;"], seq: ["x = 9;", "x = 8;"] }], read), []);
  // the second anchor was in the source but the first edit removed it: refused, as its runner would not find it
  assert.deepEqual(anchorRefusals("s.mjs", [{ name: "S2", file: "/f.ts", finds: ["x = 1;\ny = 2;", "y = 2;"], seq: ["x = 1;", "y = 3;"] }], read), [
    's.mjs: mutant "S2": its anchor is in f.ts 0 times, not once: "y = 2;"',
  ]);
});

test("the gate on this tree: every mutant of every nightly sweep has its anchor exactly once in its file", async () => {
  const { refusals, plants, listed } = await mutantAnchors(ROOT);
  assert.deepEqual(refusals, []);
  assert.ok(plants > 1000, `${plants} plants read`);
  // what KNOWN_STALE lets through is only the anchors it names, in the file it names them for
  for (const r of listed) assert.ok(Object.keys(KNOWN_STALE).some((f) => r.line.startsWith(`${f}: `) && KNOWN_STALE[f].anchors.has(r.anchor)), r.line);
});

test("every sweep file the nightly sweeps run has a reader, and every sweep file set apart is one no command runs", () => {
  const shards = JSON.stringify(mutantCommands(ROOT));
  for (const f of Object.keys(NOT_SWEPT)) assert.ok(!shards.includes(path.basename(f)), `${f} is run by the nightly sweeps: give it a reader in SWEEPS`);
  for (const f of Object.keys(NOT_SWEPT)) assert.ok(!Object.hasOwn(SWEEPS, f), f);
});
