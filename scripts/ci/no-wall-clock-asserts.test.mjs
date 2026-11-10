// The tracked unit tests read no real elapsed time outside a poll's condition or a console call (LISTED lists what is
// still to convert, and no file may read more than it lists), and the rule refuses its planted cases.
//   node --test scripts/ci/no-wall-clock-asserts.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { LISTED, findings, refusals, scan, stale } from "./no-wall-clock-asserts.mjs";

test("the tracked unit tests read nothing past LISTED", () => {
  assert.deepEqual(refusals(scan()), []);
});

test("each LISTED entry has a count and the reason it is still there", () => {
  for (const [f, v] of Object.entries(LISTED)) assert.ok(Number.isInteger(v.count) && v.count > 0 && typeof v.why === "string" && v.why.length > 0, f);
});

const REFUSED = {
  "the elapsed time in the assert": "const t0 = performance.now();\nawait run();\nassert.ok(performance.now() - t0 < 2_000, 'fast');",
  "Date.now in the assert": "const t = Date.now();\nawait run();\nassert.ok(Date.now() - t < 30_000);",
  "held in a variable first (main ff43356d)": "const t = performance.now();\nawait run();\nconst ms = performance.now() - t;\nassert.ok(ms < 2_000, `the next trade took ${ms} ms`);",
  "rounded": "const t = performance.now();\nconst ms = Math.round(performance.now() - t);\nassert.ok(ms < 500);",
  "pushed per call": "const ms = [];\nfor (const x of xs) { const t0 = performance.now(); await f(x); ms.push(performance.now() - t0); }\nassert.ok(Math.max(...ms) < 100);",
  "set as a property in a callback": "const t0 = Date.now();\nvoid p.then((a) => (h.done = { status: a.status, ms: Date.now() - t0 }));\nawait settle();\nassert.ok(h.done.ms < 1_000);",
  "two reads of the clock": "const start = performance.now();\nawait run();\nconst end = performance.now();\nassert.ok(end - start >= 1_000, 'it waited');",
  "a wait measured, no assert in sight": "const t0 = performance.now();\nawait sleepy();\nreturn performance.now() - t0;",
  "inside a for body, not its header": "for (const x of xs) {\n  const t = performance.now();\n  await f(x);\n  assert.ok(performance.now() - t < 50);\n}",
  "less a lower-case value": "const at = Date.now();\nconst ageMs = Date.now() - at;",
};

const ALLOWED = {
  "an injected clock": "let now = 0;\nconst clock = () => now;\nconst s = sender({ clock, sleep: async (ms) => { slept.push(ms); now += ms; } });\nawait s.send(tx);\nassert.deepEqual(slept, [100]);",
  "mock timers": "t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });\nconst p = run();\nt.mock.timers.tick(1_000);\nassert.equal(await p, 'timed out');",
  "work counted": "const calls = [];\nawait quote(stub(calls));\nassert.equal(calls.length, 1, 'served from the cache');",
  "a timestamp in the past": "const stale = { final: 1000, ms: () => Date.now() - 60_000 };\nconst fresh = { ms: () => Date.now() - FINAL_AGE_MAX_MS + 2_000 };\nconst nanos = BigInt(Date.now() - (p.ageMs ?? 1_000)) * 1_000_000n;",
  "a poll's cap in a while condition": "const t0 = Date.now();\nwhile (!fs.existsSync(f) && Date.now() - t0 < CAP_MS) spin(1);",
  "a poll's cap in a for header": "for (const t0 = Date.now(); !peers.every((t) => existsSync(t)) && Date.now() - t0 < 5_000; ) await tick();",
  "printed only": "const t = performance.now();\nawait run();\nconsole.log(`took ${Math.round(performance.now() - t)} ms`);\nconsole.log('ms', performance.now() - t);",
  "a message only": "const t = performance.now();\nassert.equal(v.ok, true, `refused after ${Math.round(performance.now() - t)} ms`);",
  "in a comment": "// assert.ok(performance.now() - t0 < 2_000) was the old form\nassert.equal(n, 0);",
  "the test's own timeout": "test('a crowd', { timeout: 300_000 }, async () => { assert.equal((await quote()).accepted, true); });",
};

test("refuses every planted real elapsed time", () => {
  for (const [name, src] of Object.entries(REFUSED)) assert.ok(findings(src).length > 0, name);
});

test("lets every allowed form through", () => {
  for (const [name, src] of Object.entries(ALLOWED)) assert.deepEqual(findings(src), [], name);
});

test("a file outside LISTED with one is refused, a file over its count is refused, and a count above what is there is only noted", () => {
  const one = { "a.test.ts": [{ line: 3, text: "" }] };
  assert.equal(refusals(one, {}).length, 1);
  assert.equal(refusals(one, { "a.test.ts": { count: 1 } }).length, 0);
  assert.equal(refusals({ "a.test.ts": [{ line: 3, text: "" }, { line: 9, text: "" }] }, { "a.test.ts": { count: 1 } }).length, 1);
  assert.deepEqual(refusals({}, { "a.test.ts": { count: 1 } }), []);
  assert.deepEqual(stale({}, { "a.test.ts": { count: 1 } }), ["a.test.ts: 0 of 1"]);
});
