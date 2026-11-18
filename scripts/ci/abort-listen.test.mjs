// Every listener on an abort in SCOPE reads its signal first (LISTED holds what an open pull request still changes),
// and the rule refuses its planted cases and passes the shapes that read the signal first.
//   node --test scripts/ci/abort-listen.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { LISTED, findings, refusals, scan, stale } from "./abort-listen.mjs";

test("the tree's listeners on an abort each read their signal first (past LISTED)", () => {
  assert.deepEqual(refusals(scan()), []);
});

test("each LISTED entry has a count and the reason it is still there, and none lists more than its file holds", () => {
  for (const [f, v] of Object.entries(LISTED)) assert.ok(Number.isInteger(v.count) && v.count > 0 && typeof v.why === "string" && v.why.length > 0, f);
  assert.deepEqual(stale(scan()), []);
});

const REFUSED = {
  "a test fake that only listens": "const hangs = (s) => new Promise((_, no) => s.addEventListener('abort', () => no(s.reason)));",
  "optional chaining, init's signal": "const f = async (_u, init) => new Promise((_, no) => init?.signal?.addEventListener('abort', () => no(init.signal.reason), { once: true }));",
  "a sleep that ends on the signal": "const sleep = (ms, signal) => new Promise((ok) => { const t = setTimeout(ok, ms); signal.addEventListener('abort', () => (clearTimeout(t), ok()), { once: true }); });",
  "a forward into a controller": "function both(signal) { const ac = new AbortController(); const stop = () => ac.abort(signal.reason); signal?.addEventListener('abort', stop, { once: true }); return ac; }",
  "R11-BUDGET2: the check, then an await, then the listener": "const stall = async (signal) => {\n  if (signal.aborted) throw signal.reason;\n  await ops.put('ops', 'op3', {});\n  await new Promise((_, no) => signal.addEventListener('abort', () => no(signal.reason), { once: true }));\n};",
  "a loop's check, then an await, then the listener (main.ts's carry loop)": "async function loop(signal) {\n  while (!signal.aborted) {\n    await pass();\n    await new Promise((ok) => { const t = setTimeout(ok, 1000); signal.addEventListener('abort', () => (clearTimeout(t), ok()), { once: true }); });\n  }\n}",
  "a check before a loop whose turns await": "async function f(signal) {\n  signal.throwIfAborted();\n  for (const x of xs) {\n    await read(x);\n    const ac = new AbortController();\n    signal.addEventListener('abort', () => ac.abort(), { once: true });\n  }\n}",
  "a check of another signal": "const w = (a, b) => new Promise((_, no) => { if (a.aborted) return no(a.reason); b.addEventListener('abort', () => no(b.reason)); });",
  "a check only on a catch's path (pace.ts's shared turn)": "async function turn(signal) {\n  let wait;\n  try {\n    wait = await lock();\n  } catch {\n    if (signal?.aborted) throw signal.reason;\n  }\n  await new Promise((res, rej) => { const k = setTimeout(res, wait); signal?.addEventListener('abort', () => rej(signal.reason), { once: true }); });\n}",
  "a check in an if's branch the listener is not in": "function f(s, x) { if (x) { if (s.aborted) return; } s.addEventListener('abort', g); }",
  "a check in a nested callback, which may run later or never": "function f(s) { const fire = () => c.abort(s.aborted ? s.reason : null); s.addEventListener('abort', fire); }",
  "a listener in a callback run later (follow.ts's adopt)": "function follow(deps) {\n  deps.signal?.throwIfAborted();\n  const adopt = (id) => { waiters.add(id); deps.signal?.addEventListener('abort', leave, { once: true }); };\n  return run(adopt);\n}",
  "a check in the other branch of ?:": "const p = x ? s.aborted : s.addEventListener('abort', f);",
  "a template literal event name": "s.addEventListener(`abort`, f);",
};

const ALLOWED = {
  "untilAborted": "const hangs = (s) => untilAborted(s);",
  "the check first in the executor": "const sleep = (ms, signal) => new Promise((ok) => { if (signal?.aborted) return ok(); const t = setTimeout(ok, ms); signal?.addEventListener('abort', () => (clearTimeout(t), ok()), { once: true }); });",
  "throwIfAborted, then the executor (pace.ts:154)": "async function turn(p, signal) {\n  signal?.throwIfAborted();\n  const w = take(p);\n  if (w <= 0) return;\n  await new Promise((res, rej) => { const k = setTimeout(res, w); signal?.addEventListener('abort', () => rej(signal.reason), { once: true }); });\n}",
  "if aborted, else listen": "function f(signal) { const stop = new AbortController(); if (signal?.aborted) stop.abort(signal.reason); else signal?.addEventListener('abort', () => stop.abort(), { once: true }); }",
  "?: on the same signal": "const late = new Promise((ok) => (deadline.aborted ? ok(null) : deadline.addEventListener('abort', () => ok(null), { once: true })));",
  "either of two signals checked (pool-testnet.ts eitherStop)": "function either(signal, session) {\n  if (signal.aborted || session.aborted) return fire();\n  signal.addEventListener('abort', fire, { once: true });\n  session.addEventListener('abort', fire, { once: true });\n}",
  "a loop's condition checks it each turn": "async function f(stop) {\n  for (let k = 0; k < 3 && !stop.aborted; k++) {\n    const ended = new Promise((r) => stop.addEventListener('abort', () => r('ended'), { once: true }));\n    await Promise.race([ended, warm()]);\n  }\n}",
  "the await that holds the listener itself": "async function f(signal) {\n  if (signal.aborted) throw signal.reason;\n  return await Promise.race([go(), new Promise((_, no) => signal.addEventListener('abort', () => no(signal.reason), { once: true }))]);\n}",
  "non-null and optional forms name one signal": "const f = (init) => new Promise((_, no) => { if (init?.signal?.aborted) return no(init.signal.reason); init!.signal!.addEventListener('abort', () => no(init!.signal!.reason)); });",
  "another event": "s.addEventListener('message', f); w.addEventListener('error', g);",
  "a listener named only in a string or a comment": "const mutant = 'signal?.addEventListener(\"abort\", done, { once: true });';\n// s.addEventListener('abort', f) was the old form",
  "removeEventListener": "s.removeEventListener('abort', f);",
};

for (const [name, text] of Object.entries(REFUSED)) {
  test(`refused: ${name}`, () => {
    assert.equal(findings(text, "planted.ts").length, 1, JSON.stringify(findings(text, "planted.ts")));
    assert.equal(refusals({ "planted.ts": findings(text, "planted.ts") }, {}).length, 1);
  });
}
for (const [name, text] of Object.entries(ALLOWED)) {
  test(`passed: ${name}`, () => assert.deepEqual(findings(text, "planted.ts"), []));
}

test("a .mjs file is read as JavaScript", () => {
  assert.equal(findings("export const f = (s) => new Promise((r) => s.addEventListener('abort', r));", "planted.mjs").length, 1);
});

test("LISTED lets a file hold its count and no more", () => {
  const two = [{ line: 1, text: "", why: "" }, { line: 2, text: "", why: "" }];
  assert.deepEqual(refusals({ "a.ts": two }, { "a.ts": { count: 2, why: "x" } }), []);
  assert.equal(refusals({ "a.ts": [...two, two[0]] }, { "a.ts": { count: 2, why: "x" } }).length, 1);
});
