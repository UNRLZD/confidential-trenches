// The tracked tests in kit, signpage and wallet await no turn inside a loop past LISTED (each waits through its package's
// test/settle.ts), the three settle.ts files are one file byte for byte, and the rule refuses its planted turn loops.
//   node --test scripts/ci/turn-settle.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LISTED, ROOT, findings, refusals, scan, stale } from "./turn-settle.mjs";

test("the tracked tests await no turn in a loop past LISTED", () => {
  assert.deepEqual(refusals(scan(), LISTED, "turn loop"), []);
});

test("each LISTED entry has a count and the reason it is still there", () => {
  for (const [f, v] of Object.entries(LISTED)) assert.ok(Number.isInteger(v.count) && v.count > 0 && typeof v.why === "string" && v.why.length > 0, f);
});

test("kit's, signpage's and wallet's test/settle.ts are one file", () => {
  const [a, ...rest] = ["kit", "signpage", "wallet"].map((p) => readFileSync(path.join(ROOT, "packages", p, "test", "settle.ts"), "utf8"));
  for (const b of rest) assert.equal(b, a);
});

const REFUSED = {
  "the tap's 500 turns (run 44907577683)": "for (let i = 0; i < turns && !done; i++) await new Promise((r) => setImmediate(r));",
  "a fixed flush": "const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };",
  "a typed promise and a void": "for (let k = 0; k < 2_000 && !started; k++) await new Promise<void>((ok) => void setImmediate(ok));",
  "a braced body": "for (let i = 0; i < 50; i++) {\n  await new Promise((r) => setImmediate(r));\n  if (seen()) break;\n}",
  "a while loop": "while (!done) await new Promise((res) => setImmediate(res));",
  "microtask turns": "for (let i = 0; i < 8; i++) await Promise.resolve();",
  "a named turn": "const turn = () => new Promise((r) => setImmediate(r));\nfor (let k = 0; k < 400 && !final(); k++) await turn();",
  "a named typed turn": "const tick: () => Promise<void> = () => new Promise<void>((r) => setImmediate(r));\nwhile (calls.length < 3) await tick();",
};

const ALLOWED = {
  "the helper": 'import { settle, quiet } from "./settle.ts";\nassert.equal(await settle(() => done), true);\nawait quiet();',
  "one turn, not in a loop": "await new Promise((r) => setImmediate(r));\nassert.equal(seen, 1);",
  "a timer poll": "const tick = () => new Promise((r) => setTimeout(r, 10));\nfor (let i = 0; i < 100 && proves() === 0; i++) await tick();",
  "a loop of work": "for (const x of xs) await run(x);",
  "in a comment or a string": "// for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));\nconst s = 'for (;;) await Promise.resolve()';",
};

test("refuses every planted turn loop", () => {
  for (const [name, src] of Object.entries(REFUSED)) assert.equal(findings(src).length, 1, name);
});

test("lets every allowed form through", () => {
  for (const [name, src] of Object.entries(ALLOWED)) assert.deepEqual(findings(src), [], name);
});

test("a file outside LISTED with one is refused, a file over its count is refused, and a count above what is there is only noted", () => {
  const one = { "a.test.ts": [{ line: 3, text: "" }] };
  assert.equal(refusals(one, {}, "turn loop").length, 1);
  assert.equal(refusals(one, { "a.test.ts": { count: 1 } }, "turn loop").length, 0);
  assert.equal(refusals({ "a.test.ts": [{ line: 3, text: "" }, { line: 9, text: "" }] }, { "a.test.ts": { count: 1 } }, "turn loop").length, 1);
  assert.deepEqual(stale({}, { "a.test.ts": { count: 1 } }), ["a.test.ts: 0 of 1"]);
});
