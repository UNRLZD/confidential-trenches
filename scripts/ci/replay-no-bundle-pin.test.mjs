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
import { copyChange } from "../live-checks/planted-build.mjs";
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
// the review's P2 cases on bae3416a: the answers bound to another name (106 replays name them A; 11 more P, FC, RUN, REC,
// RAW, R or M), one level of alias or destructuring, and a pin through a path that ends in .app, .index, .integrity or
// .bytes rather than .sha384
const PLANTED_REVIEW = [
  'assert.equal(rec.app.sha384, A.good.app.sha384, "the bundle as recorded");',
  "const good = answers.good;\n  assert.equal(rec.app.sha384, good.app.sha384);",
  "const { good: g } = A;\n  assert.equal(rec.app.sha384, g.app.sha384);",
  "assert.deepEqual(rec.app, answers.good.app);",
  "assert.equal(rec.index.integrity, answers.good.index.integrity);",
  "assert.deepStrictEqual(rec.bytes, RUN.good.bytes);",
  "const app = A.good.app;\n  assert.deepEqual(rec.app, app);",
];
// the review's P3 case: a comment or a string that quotes the old pin is no pin
const QUOTED = [
  "// was: assert.equal(rec.app.sha384, answers.good.app.sha384)",
  "/* was: assert.equal(rec.app.sha384, A.good.app.sha384) */",
  'const note = "assert.equal(rec.app.sha384, answers.good.app.sha384)";',
  "const note = `rec.app.sha384 === ${1} answers.good.app.sha384`;",
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

// each replay binds its recorded answers as the repo's do: by a path, or through a const naming the path
const HEAD = [
  'const answers = JSON.parse(readFileSync(path.join(HERE, "x-card.answers.json"), "utf8"));',
  'const ANSWERS = JSON.parse(readFileSync(new URL("./x-card.answers.json", import.meta.url), "utf8"));',
  'const A = JSON.parse(readFileSync(new URL("./x-card.answers.json", import.meta.url), "utf8"));',
  'const FILE = path.join(HERE, "x-card.answers.json");',
  'const RUN = JSON.parse(readFileSync(FILE, "utf8"));',
].join("\n");
const inTest = (line) => `${HEAD}\ntest("x", async () => {\n  ${line}\n});\n`;

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
  for (const line of PLANTED) assert.equal(bundlePins(inTest(line)).length, 1, line);
  for (const line of PASSES) assert.deepEqual(bundlePins(inTest(line)), [], line);
});

test("review P2: a pin through answers named A or RUN, an alias or destructuring of them, or a path ending in .app, .index, .integrity or .bytes is refused", () => {
  for (const line of PLANTED_REVIEW) assert.equal(bundlePins(inTest(line)).length, 1, line);
  // a name that is not the parsed answers is no record: the same comparison against it passes
  assert.deepEqual(bundlePins(inTest("assert.deepEqual(rec.app, other.good.app);")), [], "an unbound name");
  assert.deepEqual(bundlePins(`const B = JSON.parse(readFileSync("x-card.deployment.json", "utf8"));\ntest("x", () => {\n  assert.deepEqual(rec.app, B.good.app);\n});\n`), [], "a parsed file that is not answers.json");
});

test("review P3: a comment or a string that quotes the old pin is not refused; the same pin as code below it is, at its own line", () => {
  for (const line of QUOTED) assert.deepEqual(bundlePins(inTest(line)), [], line);
  const r = bundlePins(inTest(`${QUOTED[0]}\n  ${PLANTED[0]}`));
  assert.deepEqual(r.map(([line]) => line), [8]);
});

test("review P3-2: copyChange never changes words that a pattern mark's match covers", () => {
  const js = "x(`Sign out now`,`Hold on please`);y(`Keep the words`);";
  assert.equal(copyChange(js), "x(`SIGN OUT NOW`,`Hold on please`);y(`Keep the words`);");
  assert.equal(copyChange(js, [/x\(`[^`]*`,`[^`]*`\)/]), "x(`Sign out now`,`Hold on please`);y(`KEEP THE WORDS`);");
  assert.equal(copyChange(js, [/Sign out/, "Hold on"]), "x(`Sign out now`,`Hold on please`);y(`KEEP THE WORDS`);");
  assert.throws(() => copyChange(js, [/.+/]), /holds no words to change/);
});

test("a planted byte-pinning replay is refused by file and line, exit 1; the same replay judged by the live rule passes", () => {
  const replay = (body) => `import assert from "node:assert/strict";\nimport { test } from "node:test";\n${HEAD.split("\n")[0]}\ntest("the committed build in this tree passes", async () => {\n  const rec = await probe(SIGN_ORIGIN, localFetch);\n${body}\n});\n`;
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
