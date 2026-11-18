// The tracked unit tests read no real elapsed time outside a poll's condition or a console call (LISTED lists what is
// still to convert, and no file may read more than it lists), and the rule refuses its planted cases.
//   node --test scripts/ci/no-wall-clock-asserts.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { LISTED, QUOTE_LISTED, SHARE_LISTED, findings, quoteFindings, refusals, scan, shareFindings, stale } from "./no-wall-clock-asserts.mjs";

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

// card ci-fresh-run-ends-with-room: a quote run on the machine's own monotonic clock flips with the machine's speed
test("the tracked tests run no quote on the real monotonic clock past QUOTE_LISTED", () => {
  assert.deepEqual(refusals(scan(undefined, quoteFindings), QUOTE_LISTED, "quote on the real monotonic clock"), []);
  for (const [f, v] of Object.entries(QUOTE_LISTED)) assert.ok(Number.isInteger(v.count) && v.count > 0 && v.why.length > 0, f);
});

test("refuses a quote on the default clock, lets a fixed clock, the test clock and quoteOnStill through", () => {
  const REFUSED_QUOTES = {
    "evmPoolBuyQuoteWith with no mono": "const v = await evmPoolBuyQuoteWith(req, [a, b], NOW);",
    "with a scan but no mono": "const v = await evmPoolBuyQuoteWith(req, [chain(p, 0), chain(p, 1)], NOW, scanner(5_000_000, logs));",
    "the attack tests' quoteOn helper (KB1, 65,000 made-up pools)": "const v1 = await quoteOn([best(t1)], t1, bestRoute(t1), scanner(5_000_000, empties(t1, EVM_QUOTE_MAX_KEYS - 6)), hints);",
    "after an onTestClock that has ended": "await onTestClock(async () => {\n  await x();\n});\nawait evmPoolBuyQuoteWith(req, [a], NOW);",
  };
  for (const [name, src] of Object.entries(REFUSED_QUOTES)) assert.equal(quoteFindings(src).length, 1, name);
  const ALLOWED_QUOTES = {
    "a fixed clock as the sixth argument": "await evmPoolBuyQuoteWith(req, [a, b], NOW, undefined, undefined, () => 0);",
    "quoteOnStill (a fixed clock, no scan bound)": "await quoteOnStill([best(t1)], t1, bestRoute(t1), scanner(5_000_000, logs));",
    "inside onTestClock": "test('x', () => onTestClock(async () => {\n  await evmPoolBuyQuoteWith(req, [a, b], NOW);\n  await quoteOn(pools, t, r);\n}));",
    "in a comment or a string": "// evmPoolBuyQuoteWith(req, [a], NOW) was the old form\nconst s = 'quoteOn(x)';",
  };
  for (const [name, src] of Object.entries(ALLOWED_QUOTES)) assert.deepEqual(quoteFindings(src), [], name);
});

// card helper-share-tests-on-a-still-clock: a caller's share or a provider's budget built on the helper's default clock
// turns its window with the machine's speed (PR 979's merge queue run 44243609488, logs-cache.test.ts)
test("the tracked helper tests build no share, budget or holds on the default clock past SHARE_LISTED", () => {
  assert.deepEqual(refusals(scan(undefined, shareFindings), SHARE_LISTED, "share on the default clock"), []);
  for (const [f, v] of Object.entries(SHARE_LISTED)) assert.ok(Number.isInteger(v.count) && v.count > 0 && v.why.length > 0, f);
});

test("refuses a share, a budget or the holds on the default clock, lets a still clock, a test clock and virtual time through", () => {
  const REFUSED_SHARES = {
    "createRpc with no deps (logs-cache.test.ts before cc4340ca1's fix)": "const r = createRpc(ENV);",
    "createRpc whose deps name no now": "const r = createRpc(ENV, { fetch: p.fetch as never, log: () => undefined });",
    "createRpc on a deps object with no now": "const deps = { fetch, log };\nconst r = createRpc(ENV, deps);",
    "a now in the env with no deps": "const r = createRpc({ ...ENV, now: \"1\" });",
    "clientWindow with no clock": "const w = clientWindow(RPC_CLIENT_MAX);",
    "upstreamBudget with no clock": "const b = upstreamBudget(() => ({ total: 2, perClient: 1 }));",
    "providerHolds with no clock": "const holds = providerHolds();",
    "after an onVirtualTime that has ended": "await onVirtualTime(0, async () => x());\nconst r = createRpc(ENV, { fetch });",
  };
  for (const [name, src] of Object.entries(REFUSED_SHARES)) assert.equal(shareFindings(src).length, 1, name);
  const ALLOWED_SHARES = {
    "a still clock in the deps": "const r = createRpc(ENV, { fetch: p.fetch as never, now: STILL, log: () => undefined });",
    "a test clock by shorthand": "let clock = 0;\nconst now = () => clock;\nconst r = createRpc(ENV, { fetch, now, sleep });",
    "a deps object that names its clock": "const deps = {\n  fetch: fetch as never,\n  now: () => clock,\n  sleep: async (ms: number) => { clock += ms; },\n};\nconst r = createRpc(BASE_ENV, w.deps);",
    "clientWindow and upstreamBudget given a clock": "const w = clientWindow(10, () => t);\nconst b = upstreamBudget(limits, STILL);",
    "providerHolds given a clock": "const holds = providerHolds(() => clock, PACE);",
    "inside onVirtualTime": "await onVirtualTime(1_000_000_000, async () => {\n  const r = createRpc(ENV, { fetch });\n  const h = providerHolds();\n});",
    "the function itself, a comment, a string": "export function createRpc(env, deps = {}) {}\n// createRpc(ENV) was the old form\nconst s = 'providerHolds()';",
  };
  for (const [name, src] of Object.entries(ALLOWED_SHARES)) assert.deepEqual(shareFindings(src), [], name);
});
