// node --test scripts/live-checks/restore-check-bounded.test.mjs: card restore-check-bounded's live check, replayed on
// wallet-restore-transfer-rpcs.answers.json (a real run, 6 Nov 02:59-03:01Z from the Mac). Run 42146750370's job was
// cancelled at 20 min with no line. Good: the recorded run passes, each network's line printed as it ends with its
// calls, time and refusals' words. Bad: the same run with the Base W's eth_getLogs pages never answered, or answered
// HTTP 429 on and on, fails at the network's deadline, naming the call it is stuck on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHECK } from "./restore-check-bounded.mjs";
import { JOBS, NETWORK_DEADLINE_MS, check, replayer } from "./wallet-restore-transfer-rpcs.mjs";

const A = JSON.parse(readFileSync(new URL("./wallet-restore-transfer-rpcs.answers.json", import.meta.url), "utf8"));
const BASE = JOBS.filter((j) => j.network === "base");

test("the entry runs wallet-restore-transfer-rpcs, each network bounded under the CI job's 10 min", () => {
  assert.equal(CHECK, "wallet-restore-transfer-rpcs");
  assert.ok(NETWORK_DEADLINE_MS > 0 && NETWORK_DEADLINE_MS <= 6 * 60_000, `${NETWORK_DEADLINE_MS}`);
});

test("the recorded good run passes, every network's line printed as it ends with its calls, its time and its refusals' words", { timeout: 60_000 }, async () => {
  const printed = [];
  const r = await check(replayer(A.good), { wait: false, onLine: (ok, l) => printed.push([ok, l]) });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, JOBS.length);
  assert.deepEqual(printed.map(([, l]) => l).sort(), [...r.lines].sort());
  assert.ok(printed.every(([ok]) => ok));
  for (const l of r.lines) assert.match(l, /; \d+ calls in \d+\.\d s(, \d+ refused: .+ x\d+)?\)/, l);
  // the helper's Base route met its 1,000-block cap in the recorded run: its refusals' words are on its line, each kind
  // with its count, "; " between kinds (the run recorded 6 Nov 08:47Z met a spare's 1,024-block words behind the route too)
  assert.match(r.lines[1], /^base: .*, \d+ refused: RPC error -32602: invalid params x\d+(; .+ x\d+)*\)$/);
});

test("the bad run, a Base page no provider answers, fails at its deadline, naming the call: method, range, host and try", { timeout: 30_000 }, async () => {
  const replay = replayer(A.good);
  const printed = [];
  const t0 = performance.now();
  const r = await check((network, url, method, params) => (method === "eth_getLogs" ? new Promise(() => {}) : replay(network, url, method, params)), { wait: false, jobs: BASE, deadlineMs: 2_000, onLine: (ok, l) => printed.push([ok, l]) });
  assert.ok(performance.now() - t0 < 10_000);
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /^base: no end in 2\.0 s \(\d+ calls\): stuck on eth_getLogs \d+\.\.\d+ \(10000 blocks\) on api\.confidential\.unrealized\.trade, try 1, no answer in \d+\.\d s$/);
  assert.deepEqual(printed, [[false, r.lines[0]]]);
});

test("the bad run, a Base page throttled past the deadline, fails then, naming the refused call, the Retry-After it named and the time waited", { timeout: 30_000 }, async () => {
  const replay = replayer(A.good);
  const r = await check((network, url, method, params) => (method === "eth_getLogs" ? Promise.resolve({ error: "HTTP 429", name: "Error", afterMs: 9_000 }) : replay(network, url, method, params)), { wait: true, jobs: BASE, deadlineMs: 6_000 });
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /^base: no end in 6\.0 s \(\d+ calls\): stuck on eth_getLogs \d+\.\.\d+ \(10000 blocks\) on api\.confidential\.unrealized\.trade, try \d+, refused \(HTTP 429\), Retry-After 9\.0 s, \d+\.\d s waited since$/);
});
