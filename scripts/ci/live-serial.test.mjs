// node --test scripts/ci/live-serial.test.mjs: a serial group's checks run one after another, each once the helper's budget is
// idle, every one whatever an earlier one ended with, none twice (scripts/ci/live-serial.mjs, card helper-live-jup-serial).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCheck, serial } from "./live-serial.mjs";

const IDLE = { idle: true, probes: 1, waitedMs: 5, why: "ok" };

test("every member runs in the order given, each after an idle read, and none runs twice", async () => {
  const events = [];
  const r = await serial(["a", "b", "c"], {
    idle: async () => (events.push("idle"), IDLE),
    run: async (k) => (events.push(`run ${k}`), 0),
    say: () => {},
  });
  assert.deepEqual(events, ["idle", "run a", "idle", "run b", "idle", "run c"], "the gate before each member, never two members at once");
  assert.deepEqual(r, { ok: true, failed: [], notRun: [] });
});

test("a failing member does not stop the rest, is not run again, and the group is red", async () => {
  const ran = [];
  const out = [];
  const r = await serial(["a", "b", "c"], { idle: async () => IDLE, run: async (k) => (ran.push(k), k === "b" ? 1 : 0), say: (l) => out.push(l) });
  assert.deepEqual(ran, ["a", "b", "c"], "b ran once, no retry, and c still ran");
  assert.deepEqual(r, { ok: false, failed: ["b"], notRun: [] });
  assert.equal(out.at(-1), "live-serial: FAIL b");
  const crashed = await serial(["a"], { idle: async () => IDLE, run: async () => 2, say: () => {} });
  assert.equal(crashed.ok, false, "an error exit (2) is a failure too");
});

test("a budget that is not idle in time stops the group there: the member is not run, and it and the rest are named", async () => {
  const ran = [];
  const out = [];
  let n = 0;
  const r = await serial(["a", "b", "c"], {
    idle: async () => (++n === 2 ? { idle: false, probes: 36, waitedMs: 179_000, why: "the page's Jupiter row was not read for it (src chain)" } : IDLE),
    run: async (k) => (ran.push(k), 0),
    say: (l) => out.push(l),
  });
  assert.deepEqual(ran, ["a"]);
  assert.deepEqual(r, { ok: false, failed: ["b"], notRun: ["b", "c"] });
  assert.ok(out.some((l) => /^BAD the helper's Jupiter budget was not idle in 179000 ms \(36 probes\) before b: /.test(l)));
  assert.equal(out.at(-1), "live-serial: FAIL b (not run: b, c)");
});

test("runCheck runs scripts/live-checks/<key>.mjs as the job runs a single check and returns its exit code", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "live-serial-"));
  try {
    mkdirSync(path.join(root, "scripts/live-checks"), { recursive: true });
    writeFileSync(path.join(root, "scripts/live-checks/pass.mjs"), 'console.log("live-check pass: PASS");\n');
    writeFileSync(path.join(root, "scripts/live-checks/fail.mjs"), 'console.log("live-check fail: FAIL"); process.exit(1);\n');
    assert.equal((await runCheck("pass", root)).code, 0);
    assert.equal((await runCheck("fail", root)).code, 1);
    assert.match((await runCheck("pass", root)).output, /live-check pass: PASS/, "the output is kept, for the providers a rerun names");
    assert.equal((await runCheck("missing", root)).code, 1, "a check file that is not there is a failure (node's own exit 1)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// card live-inconclusive-rerun: a member that ends INCONCLUSIVE (exit 3) runs again after a pause, once the budget is idle
const NO = "--- solana api.mainnet-beta.solana.com HTTP 429: 429 Too Many Requests";

test("an INCONCLUSIVE member runs again after a pause, each run once the budget is idle, and then passes", async () => {
  const events = [];
  let n = 0;
  const r = await serial(["a", "b"], {
    idle: async () => (events.push("idle"), IDLE),
    run: async (k) => (events.push(`run ${k}`), k === "a" && ++n === 1 ? { code: 3, output: NO } : { code: 0, output: "" }),
    sleep: async (ms) => void events.push(`pause ${ms}`),
    random: () => 0,
    say: () => {},
  });
  assert.deepEqual(events, ["idle", "run a", "pause 15000", "idle", "run a", "idle", "run b"]);
  assert.deepEqual(r, { ok: true, failed: [], notRun: [] });
});

test("a member INCONCLUSIVE at the bound is red and named; a FAIL or an ERROR member is never run again", async () => {
  const out = [];
  const ran = [];
  const r = await serial(["a", "b", "c"], {
    idle: async () => IDLE,
    run: async (k) => (ran.push(k), k === "a" ? { code: 3, output: NO } : k === "b" ? 1 : 2),
    sleep: async () => {},
    say: (l) => out.push(l),
  });
  assert.deepEqual(ran, ["a", "a", "a", "b", "c"]);
  assert.deepEqual(r, { ok: false, failed: ["a", "b", "c"], notRun: [] });
  assert.ok(out.includes("live-rerun a: INCONCLUSIVE after 3 runs, never a pass; no answer from: api.mainnet-beta.solana.com"), out.join("\n"));
  assert.equal(out.at(-1), "live-serial: FAIL a, b, c");
});

test("a budget that is not idle before a rerun stops the group there: the member is red, the rest named not run", async () => {
  const out = [];
  let n = 0;
  const r = await serial(["a", "b"], {
    idle: async () => (++n === 2 ? { idle: false, probes: 36, waitedMs: 179_000, why: "busy" } : IDLE),
    run: async () => ({ code: 3, output: NO }),
    sleep: async () => {},
    say: (l) => out.push(l),
  });
  assert.deepEqual(r, { ok: false, failed: ["a"], notRun: ["b"] });
  assert.ok(out.includes("BAD the helper's Jupiter budget was not idle in 179000 ms (36 probes) before a run 2: busy"), out.join("\n"));
});

// review of 9eaf059a, P2-2: the serial runner comes from the workflow's own ref and runs the checks of the folder it is
// started in (the deployed commit's), writing the job's log itself
test("an old commit's serial group runs under the workflow's runner: its checks are the root's, the log the runner's", async () => {
  const { main } = await import("./live-serial.mjs");
  const old = mkdtempSync(path.join(tmpdir(), "live-serial-old-"));
  try {
    mkdirSync(path.join(old, "scripts/live-checks"), { recursive: true });
    writeFileSync(path.join(old, "scripts/live-checks/old-a.mjs"), 'console.log("live-check old-a: PASS");\n');
    writeFileSync(path.join(old, "scripts/live-checks/old-b.mjs"), 'console.error("live-check old-b: FAIL"); process.exit(1);\n');
    const log = path.join(old, "group.log");
    assert.equal(await main(["--log", log, "old-a"], { root: old, idle: async () => IDLE }), 0);
    assert.match(readFileSync(log, "utf8"), /live-check old-a: PASS[\s\S]*live-serial: PASS 1 checks/);
    assert.equal(await main(["--log", log, "old-a", "old-b"], { root: old, idle: async () => IDLE }), 1);
    assert.match(readFileSync(log, "utf8"), /live-check old-b: FAIL[\s\S]*live-serial: FAIL old-b/);
    assert.equal(await main(["--log", log, "old-c"], { root: old, idle: async () => IDLE }), 2);
    assert.match(readFileSync(log, "utf8"), /no such check: old-c in /);
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
});
