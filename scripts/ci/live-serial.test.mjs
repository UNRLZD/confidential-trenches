// node --test scripts/ci/live-serial.test.mjs: a serial group's checks run one after another, each once the helper's budget is
// idle, every one whatever an earlier one ended with, none twice (scripts/ci/live-serial.mjs, card helper-live-jup-serial).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RELEASES, releasedLine, runCheck, serial } from "./live-serial.mjs";

// the fields every test reads; results are held by their own tests
const shape = ({ ok, failed, notRun }) => ({ ok, failed, notRun });

const IDLE = { idle: true, probes: 1, waitedMs: 5, why: "ok" };

test("every member runs in the order given, each after an idle read, and none runs twice", async () => {
  const events = [];
  const r = await serial(["a", "b", "c"], {
    idle: async () => (events.push("idle"), IDLE),
    run: async (k) => (events.push(`run ${k}`), 0),
    say: () => {},
  });
  assert.deepEqual(events, ["idle", "run a", "idle", "run b", "idle", "run c"], "the gate before each member, never two members at once");
  assert.deepEqual(shape(r), { ok: true, failed: [], notRun: [] });
  assert.deepEqual(r.results.map((x) => [x.key, x.verdict]), [["a", "pass"], ["b", "pass"], ["c", "pass"]]);
});

test("a failing member does not stop the rest, is not run again, and the group is red", async () => {
  const ran = [];
  const out = [];
  const r = await serial(["a", "b", "c"], { idle: async () => IDLE, run: async (k) => (ran.push(k), k === "b" ? 1 : 0), say: (l) => out.push(l) });
  assert.deepEqual(ran, ["a", "b", "c"], "b ran once, no retry, and c still ran");
  assert.deepEqual(shape(r), { ok: false, failed: ["b"], notRun: [] });
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
  assert.deepEqual(shape(r), { ok: false, failed: ["b"], notRun: ["b", "c"] });
  assert.deepEqual(r.results.map((x) => [x.key, x.verdict]), [["a", "pass"], ["b", "not_run"], ["c", "not_run"]]);
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
  assert.deepEqual(shape(r), { ok: true, failed: [], notRun: [] });
});

// card live-run-red-means-the-build: INCONCLUSIVE at the bound is its own result, named with its reason, never red
test("a member INCONCLUSIVE at the bound is inconclusive and named, the group not red for it; a FAIL or an ERROR member is never run again and red", async () => {
  const out = [];
  const ran = [];
  const r = await serial(["a", "b", "c"], {
    idle: async () => IDLE,
    run: async (k) => (ran.push(k), k === "a" ? { code: 3, output: NO } : k === "b" ? 1 : 2),
    sleep: async () => {},
    say: (l) => out.push(l),
  });
  assert.deepEqual(ran, ["a", "a", "a", "b", "c"]);
  assert.deepEqual(shape(r), { ok: false, failed: ["b", "c"], notRun: [] });
  assert.deepEqual(r.inconclusive, ["a"]);
  assert.ok(out.includes("live-rerun a: INCONCLUSIVE after 3 runs, never a pass; no answer from: api.mainnet-beta.solana.com"), out.join("\n"));
  assert.equal(out.at(-1), "live-serial: FAIL b, c (inconclusive: a: after 3 runs: no verdict line in its output; no answer from: api.mainnet-beta.solana.com)");
  // alone, the group passes and names it
  const solo = [];
  const s1 = await serial(["a"], { idle: async () => IDLE, run: async () => ({ code: 3, output: NO }), sleep: async () => {}, say: (l) => solo.push(l) });
  assert.equal(s1.ok, true);
  assert.deepEqual(s1.results, [{ key: "a", verdict: "inconclusive", reason: "after 3 runs: no verdict line in its output; no answer from: api.mainnet-beta.solana.com", runs: 3 }]);
  assert.match(solo.at(-1), /^live-serial: PASS 1 checks, one after another \(inconclusive: a: after 3 runs/);
  // a member's own INCONCLUSIVE (exit 2 with its verdict line) runs once and is inconclusive; any other exit 2 is red
  const own = await serial(["a", "b"], { idle: async () => IDLE, run: async (k) => ({ code: 2, output: `--  no burn landed\nlive-check ${k}: ${k === "a" ? "INCONCLUSIVE (x)" : "ERROR: HTTP 500"}` }), sleep: async () => assert.fail("never run again"), say: () => {} });
  assert.deepEqual(own.results.map((x) => [x.key, x.verdict, x.reason]), [["a", "inconclusive", "no burn landed"], ["b", "error", "live-check b: ERROR: HTTP 500"]]);
  assert.deepEqual(own.failed, ["b"]);
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
  assert.deepEqual(shape(r), { ok: false, failed: ["a"], notRun: ["b"] });
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
    // card live-run-red-means-the-build: the job's verdict file beside its log
    assert.deepEqual(JSON.parse(readFileSync(path.join(old, "group.verdict.json"), "utf8")).results.map((x) => [x.key, x.verdict]), [["old-a", "pass"], ["old-b", "fail"]]);
    assert.equal(await main(["--log", log, "old-c"], { root: old, idle: async () => IDLE }), 2);
    assert.match(readFileSync(log, "utf8"), /no such check: old-c in /);
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
});

// card live-run-red-means-the-build: a member done with the budget lets the next start while it reads on to its deadline
test("a released member gets its deadline, the next member starts once it prints its released line, and the group waits for it", async () => {
  const events = [];
  const written = [];
  let finish;
  const ending = new Promise((r) => (finish = r));
  let t = 1_000_000;
  const r = await serial(["slow", "b", "c"], {
    idle: async () => (events.push("idle"), IDLE),
    releases: { slow: { flag: "--until", withinMs: 60_000 } },
    now: () => t,
    write: (b) => written.push(String(b)),
    run: async (k, args, write) => {
      events.push(`run ${k} ${args.join(" ")}`.trim());
      if (k !== "slow") {
        if (k === "c") finish();
        return { code: 0, output: "" };
      }
      write("before\n");
      write(`${releasedLine("slow")}\nafter 1\n`);
      write("after 2\n");
      await ending;
      events.push("slow ends");
      return { code: 0, output: `before\n${releasedLine("slow")}\nafter 1\nafter 2\nlive-check slow: PASS` };
    },
    say: (l) => events.push(l),
  });
  assert.deepEqual(events.filter((e) => /^(run|idle|slow ends)/.test(e)), ["idle", "run slow --until 1060000", "idle", "run b", "idle", "run c", "slow ends"]);
  assert.deepEqual(shape(r), { ok: true, failed: [], notRun: [] });
  assert.deepEqual(r.results.map((x) => [x.key, x.verdict, x.runs]), [["slow", "pass", 1], ["b", "pass", 1], ["c", "pass", 1]]);
  assert.deepEqual(written, ["before\n", `${releasedLine("slow")}\n`, "after 1\nafter 2\n"], "what it prints after the line is held to its end, whole");
  assert.ok(events.indexOf("=== slow: its output since it was done with the budget") > events.indexOf("slow ends"));
});

test("a released member that ends INCONCLUSIVE is never run again and is named; one that FAILs or never releases still holds the group", async () => {
  const inc = await serial(["solana-mint-supply-moves", "b"], {
    idle: async () => IDLE,
    run: async (k, args, write) => {
      if (k === "b") return 0;
      assert.equal(args[0], "--burn-until");
      assert.match(args[1], /^\d{13}$/);
      write?.(`${releasedLine(k)}\n`);
      return { code: 2, output: `--  no burn landed between two reads: the run proves nothing either way\nlive-check ${k}: INCONCLUSIVE (x)` };
    },
    sleep: async () => assert.fail("a released member is never run again"),
    say: () => {},
  });
  assert.equal(inc.ok, true);
  assert.deepEqual(inc.results[0], { key: "solana-mint-supply-moves", verdict: "inconclusive", reason: "no burn landed between two reads: the run proves nothing either way", runs: 1 });
  const order = [];
  const fail = await serial(["solana-mint-supply-moves", "b"], {
    idle: async () => IDLE,
    run: async (k) => (order.push(k), k === "b" ? 0 : { code: 1, output: `live-check ${k}: FAIL (supply never moved)` }),
    say: () => {},
  });
  assert.deepEqual(order, ["solana-mint-supply-moves", "b"], "one that never prints its line holds its turn to its end");
  assert.deepEqual(shape(fail), { ok: false, failed: ["solana-mint-supply-moves"], notRun: [] });
  assert.deepEqual(RELEASES["solana-mint-supply-moves"], { flag: "--burn-until", withinMs: 390_000 });
});

test("the process run: the supply check, released, reads on while the next check runs; the log keeps their lines apart", async () => {
  const { main } = await import("./live-serial.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "live-serial-release-"));
  try {
    mkdirSync(path.join(root, "scripts/live-checks"), { recursive: true });
    const marks = path.join(root, "marks");
    const K = "solana-mint-supply-moves";
    writeFileSync(path.join(root, `scripts/live-checks/${K}.mjs`), [
      'import { appendFileSync } from "node:fs";',
      `const until = Number(process.argv[process.argv.indexOf("--burn-until") + 1]);`,
      `if (!(until > Date.now())) { console.log("live-check ${K}: ERROR: no deadline"); process.exit(2); }`,
      `console.log("dry builds made"); console.log("live-check ${K}: budget released");`,
      `await new Promise((r) => setTimeout(r, 400));`,
      `appendFileSync(${JSON.stringify(marks)}, "supply ends\\n");`,
      `console.log("--  no burn landed between two reads: the run proves nothing either way"); console.log("live-check ${K}: INCONCLUSIVE (x)"); process.exit(2);`,
    ].join("\n"));
    writeFileSync(path.join(root, "scripts/live-checks/next.mjs"), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marks)}, "next runs\\n");\nconsole.log("live-check next: PASS");\n`);
    const log = path.join(root, "group.log");
    assert.equal(await main(["--log", log, K, "next"], { root, idle: async () => IDLE }), 0, "an inconclusive member is no red");
    assert.equal(readFileSync(marks, "utf8"), "next runs\nsupply ends\n", "the next check ran while the supply check read on");
    const text = readFileSync(log, "utf8");
    assert.match(text, new RegExp(`budget released\\n[^]*=== next: idle[^]*live-check next: PASS[^]*=== ${K}: its output since it was done with the budget\\n--  no burn landed[^]*live-check ${K}: INCONCLUSIVE`));
    assert.match(text, /^::notice title=inconclusive solana-mint-supply-moves::no burn landed between two reads: the run proves nothing either way$/m);
    assert.match(text, /live-serial: PASS 2 checks, one after another \(inconclusive: solana-mint-supply-moves: no burn landed/);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, "group.verdict.json"), "utf8")).results.map((x) => [x.key, x.verdict]), [[K, "inconclusive"], ["next", "pass"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
