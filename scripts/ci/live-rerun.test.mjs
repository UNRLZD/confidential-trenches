// node --test scripts/ci/live-rerun.test.mjs: a live check that ends INCONCLUSIVE runs again after a pause, up to the
// bound, and nothing else does (scripts/ci/live-rerun.mjs, card live-inconclusive-rerun). The cases every runner must hold
// are the gate's (scripts/ci/live-workflow.mjs RERUN_CASES); these hold the pause, the names and the process run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, RETRY, classify, rpcAnswer } from "../live-checks/provider-answer.mjs";
import { INCONCLUSIVE, RERUN, noAnswerHosts, pauseMs, rerun, runCheck } from "./live-rerun.mjs";

test("the code run again is provider-answer.mjs's INCONCLUSIVE, and the bound is three runs", () => {
  assert.equal(INCONCLUSIVE, EXIT.INCONCLUSIVE);
  assert.equal(RERUN.runs, 3);
});

test("the pause is equal jitter: half of min(cap, base * 2^n) and a random part of the other half", () => {
  assert.equal(pauseMs(0, RERUN, () => 0), 15_000);
  assert.equal(pauseMs(0, RERUN, () => 0.999999), 30_000);
  assert.equal(pauseMs(1, RERUN, () => 0), 30_000);
  assert.equal(pauseMs(1, RERUN, () => 0.5), 45_000);
  assert.equal(pauseMs(5, RERUN, () => 0), 60_000, "capped at 120 s");
  for (let i = 0; i < 200; i++) {
    const ms = pauseMs(1);
    assert.ok(ms >= 30_000 && ms <= 60_000, String(ms));
  }
});

test("the providers named are the hosts in provider-answer.mjs's own no-answer words, each once", async () => {
  const rate = classify("mainnet.base.org", 429, "").noAnswer;
  const limit = classify("api.mainnet-beta.solana.com", 200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limit" } })).noAnswer;
  const state = classify("robinhood.drpc.org:8545", 200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 27, message: "Unknown state. First available state is 1" } })).noAnswer;
  RETRY.ms = 0;
  const down = (await rpcAnswer("https://solana-rpc.publicnode.com/", "getBalance", [], { fetchFn: async () => { throw Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } }); } })).noAnswer;
  for (const n of [rate, limit, state, down]) assert.equal(typeof n, "string");
  const out = [`--- base ${rate}`, `[https://api.mainnet-beta.solana.com] payer's balance: no answer: ${limit}`, `INCONCLUSIVE robinhood: ${state}`, `--- solana ${down}`, `--- base ${rate}`, "live-check k: INCONCLUSIVE (2 of 4 answered)"].join("\n");
  assert.deepEqual(noAnswerHosts(out), ["api.mainnet-beta.solana.com", "mainnet.base.org", "robinhood.drpc.org:8545", "solana-rpc.publicnode.com"]);
  assert.deepEqual(noAnswerHosts("live-check k: PASS (every provider answered)\nBAD x: 0.1 != 0.2"), []);
});

test("a check that is still INCONCLUSIVE at the bound exits 3, and its last line names the providers; never a pass", async () => {
  const lines = [];
  const pauses = [];
  const r = await rerun("k", [], { run: async () => ({ code: 3, output: "--- base mainnet.base.org HTTP 429: 429 Too Many Requests" }), sleep: async (ms) => void pauses.push(ms), say: (l) => lines.push(l), random: () => 0 });
  assert.deepEqual(r, { code: 3, runs: 3, stopped: false });
  assert.deepEqual(pauses, [15_000, 30_000]);
  assert.equal(lines.at(-1), "live-rerun k: INCONCLUSIVE after 3 runs, never a pass; no answer from: mainnet.base.org");
  assert.match(lines[0], /^live-rerun k: run 1 of 3 INCONCLUSIVE \(no answer from: mainnet\.base\.org\); run again in 15 s$/);
  const mute = [];
  await rerun("k", [], { run: async () => 3, sleep: async () => {}, say: (l) => mute.push(l) });
  assert.match(mute.at(-1), /no answer from: none named in its output/);
});

test("the process run: a check that is INCONCLUSIVE once and then passes ends 0; its output is kept for the names", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "live-rerun-"));
  try {
    mkdirSync(path.join(root, "scripts/live-checks"), { recursive: true });
    const seen = path.join(root, "seen");
    writeFileSync(
      path.join(root, "scripts/live-checks/flaky.mjs"),
      `import { existsSync, writeFileSync } from "node:fs";\nif (!existsSync(${JSON.stringify(seen)})) { writeFileSync(${JSON.stringify(seen)}, "1"); console.log("--- rpc.example.org HTTP 429: 429 Too Many Requests"); console.log("live-check flaky: INCONCLUSIVE"); process.exit(3); }\nconsole.log("live-check flaky: PASS", process.argv.slice(2).join(" "));\n`,
    );
    writeFileSync(path.join(root, "scripts/live-checks/fail.mjs"), 'console.error("live-check fail: FAIL"); process.exit(1);\n');
    const lines = [];
    const runs = [];
    const r = await rerun("flaky", ["--host", "app"], { run: async (k, a) => { const x = await runCheck(k, a, root); runs.push(x); return x; }, sleep: async () => {}, say: (l) => lines.push(l) });
    assert.equal(r.code, 0);
    assert.deepEqual(runs.map((x) => x.code), [3, 0]);
    assert.match(runs[0].output, /rpc\.example\.org HTTP 429/);
    assert.match(runs[1].output, /PASS --host app/, "the args reach the check");
    assert.match(lines.at(-1), /run 2 of 3 ended exit 0 PASS; runs before it were INCONCLUSIVE \(no answer from: rpc\.example\.org\)/);
    const f = await rerun("fail", [], { run: (k, a) => runCheck(k, a, root), sleep: async () => assert.fail("a FAIL is never run again"), say: () => {} });
    assert.deepEqual(f, { code: 1, runs: 1, stopped: false });
    assert.equal((await runCheck("missing", [], root)).code, 1, "a check file that is not there is node's own exit 1, never run again");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// review of 9eaf059a, P3-1: a provider named by its address or host:port is named too, as provider-answer.mjs words it
test("a provider at an IPv4 address, an IPv6 one or a bare host:port is named", () => {
  const out = [
    `--- solana ${classify("127.0.0.1:8899", 429, "").noAnswer}`,
    `--- base ${classify("[::1]:8545", 200, "").noAnswer}`,
    "--- near localhost:3030: no answer (ECONNREFUSED)",
    "live-check k: INCONCLUSIVE (0 of 3 answered)",
  ].join("\n");
  assert.deepEqual(noAnswerHosts(out), ["127.0.0.1:8899", "[::1]:8545", "localhost:3030"]);
  assert.deepEqual(noAnswerHosts("run 2 of 3: no answer (x)\nlive-rerun k: run 1 of 3 INCONCLUSIVE (no answer from: a.example.org)"), [], "the runner's own words and a bare word name no provider");
});

const RUNNER = fileURLToPath(new URL("./live-rerun.mjs", import.meta.url));

// review of 9eaf059a, P2-2: a dispatch of a commit older than the runner. The runner comes from the workflow's own ref
// (.live-runner) and runs the check of the folder it is started in, the deployed commit's.
test("an old commit's check runs under the workflow's runner: the check is the working folder's, the runner found", () => {
  const old = mkdtempSync(path.join(tmpdir(), "live-rerun-old-"));
  try {
    mkdirSync(path.join(old, "scripts/live-checks"), { recursive: true });
    writeFileSync(path.join(old, "scripts/live-checks/old-check.mjs"), 'console.log("live-check old-check: PASS", process.argv.slice(2).join(" "));\n');
    const log = path.join(old, "run.log");
    const r = spawnSync(process.execPath, [RUNNER, "--log", log, "old-check", "--host", "app"], { cwd: old, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(log, "utf8"), /live-check old-check: PASS --host app/);
    const fail = spawnSync(process.execPath, [RUNNER, "--log", log, "no-such"], { cwd: old, encoding: "utf8" });
    assert.equal(fail.status, 2);
    assert.match(fail.stderr + readFileSync(log, "utf8"), /no such check: no-such in /);
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
});

// review of 9eaf059a, P2-1 and P3-1: the runner writes the job's log itself from one combined pipe, so no pipefail or
// tee stands between the check's exit and the job's, and a check's stdout and stderr keep their order
test("the runner writes the log itself, the check's stdout and stderr in order, and exits with the check's code", () => {
  const root = mkdtempSync(path.join(tmpdir(), "live-rerun-log-"));
  try {
    mkdirSync(path.join(root, "scripts/live-checks"), { recursive: true });
    const lines = Array.from({ length: 40 }, (_, i) => `${i % 2 ? "process.stderr" : "process.stdout"}.write("line ${i}\\n");`).join("\n");
    writeFileSync(path.join(root, "scripts/live-checks/both.mjs"), `${lines}\nprocess.exitCode = 1;\n`);
    const log = path.join(root, "run.log");
    const r = spawnSync(process.execPath, [RUNNER, "--log", log, "both"], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 1, "a FAIL is the job's exit, with no pipe after it");
    const got = readFileSync(log, "utf8").split("\n").filter((l) => /^line \d+$/.test(l));
    assert.deepEqual(got, Array.from({ length: 40 }, (_, i) => `line ${i}`));
    assert.match(readFileSync(log, "utf8"), /live-rerun both: exit 1 FAIL, never run again/);
    assert.match(r.stdout, /line 39/, "the job's console shows it too");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
