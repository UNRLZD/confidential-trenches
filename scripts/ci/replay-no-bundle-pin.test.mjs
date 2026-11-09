// The replay pin gate (replay-no-bundle-pin.mjs) on planted trees: a live check's replay that asserts the tree's bundle
// hash equal to a recorded one is refused, by file and line; a replay that judges the tree's build with the live rule,
// and recorded hashes compared with each other or used as a lookup key, pass; the repo's own replays pass.
//   node --test scripts/ci/replay-no-bundle-pin.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bundlePins, replayNoBundlePin } from "./replay-no-bundle-pin.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(ROOT, "scripts/ci/replay-no-bundle-pin.mjs");

// the pin PR #501 failed on (wallet-restore-id-reader.test.mjs at a70ea92b, line 187), and its kin
const PLANTED = [
  'assert.equal(rec.app.sha384, answers.good.app.sha384, "the bundle as recorded");',
  "assert.strictEqual(answers.good.sha384, (await read(localFetch)).sha384);",
  'assert.deepEqual(rec.app.sha384, ANSWERS["good"].app.sha384);',
  'assert.equal(rec.app.sha384, "sha384-1aGrtaUQWiKVzeAuTm2zzYpXpF0xmqXly2/JVa4pbGHalP+gNp+xnwQuH3VpjtYN");',
  "assert.ok(rec.app.sha384 === answers.good.app.sha384);",
];
// what the repo's replays do and must keep doing (each from a live-checks test on main a70ea92b)
const PASSES = [
  'assert.equal(judge(rec).pass, true, judge(rec).lines.join("\\n"));',
  'assert.notEqual(ANSWERS.mutant.sha384, ANSWERS.good.sha384, "another bundle than this card\'s");',
  'assert.equal(ANSWERS.bad.sha384, "sha384-mKDl+6Ec+mdtOuvuzY/rIwJaYOf61XWAJGXN1BRdzleanUyVMUPlG2/wAkkI0Isr");',
  'assert.equal(r.get(ANSWERS.good.sha384), "release-107");',
  "css.app.css.sha384 = answers.bad.app.css.sha384;",
  'assert.notEqual(copy.app.sha384, (await treeRecord()).app.sha384, "another bundle than the tree\'s");',
];

const tree = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "replay-no-bundle-pin-"));
  mkdirSync(join(dir, "scripts/live-checks"), { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, "scripts/live-checks", f), text);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
};
const run = (dir) => {
  const r = spawnSync(process.execPath, [GATE, dir], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

test("the repo's own live-check replays pass", () => {
  const r = replayNoBundlePin(ROOT);
  assert.deepEqual(r.refusals, []);
  assert.ok(r.read > 100, String(r.read));
});

test("each planted pin of a bundle's hash to a recorded one is refused; each judged or recorded-only comparison passes", () => {
  for (const line of PLANTED) assert.equal(bundlePins(`test("x", async () => {\n  ${line}\n});\n`).length, 1, line);
  for (const line of PASSES) assert.deepEqual(bundlePins(`test("x", async () => {\n  ${line}\n});\n`), [], line);
});

test("a planted byte-pinning replay is refused by file and line, exit 1; the same replay judged by the live rule passes", () => {
  const replay = (body) => `import assert from "node:assert/strict";\nimport { test } from "node:test";\n\ntest("the committed build in this tree passes", async () => {\n  const rec = await probe(SIGN_ORIGIN, localFetch);\n${body}\n});\n`;
  const bad = tree({ "x-card.test.mjs": replay(`  assert.equal(judge(rec).pass, true);\n  ${PLANTED[0]}`) });
  const good = tree({ "x-card.test.mjs": replay("  assert.equal(judge(rec).pass, true);") });
  try {
    const r = run(bad);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^replay-no-bundle-pin: REFUSED: scripts\/live-checks\/x-card\.test\.mjs:7: assert\.equal\(rec\.app\.sha384, answers\.good\.app\.sha384\) pins a bundle's hash to a recorded one/m);
    const g = run(good);
    assert.equal(g.code, 0, g.out);
    assert.match(g.out, /^replay-no-bundle-pin: OK \(1 live-check test file\(s\) read\)/m);
  } finally {
    rmSync(bad, { recursive: true, force: true });
    rmSync(good, { recursive: true, force: true });
  }
});
