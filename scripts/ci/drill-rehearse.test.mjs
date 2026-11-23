// Card vault-drill-rehearsal-mainnet-copy: the unplug drill's rehearsal record (scripts/drill/rehearse.mjs), as
// scripts/drill/rehearse.sh leaves it. A planted out dir in the shape rehearse.sh writes passes; the same run with
// unplug.sh off left out fails at servers-down and never reaches the exit; each step fails on its own planted fault (a
// stack that was never ready, no mainnet vault copy, an off that left a server running, a read on other ports, a cut
// after the exit's first line, a payout short, a vault not back at mainnet's, a request to a host of ours, no request
// written down). exit_every_kind.rs runs the cut after the deposits and before the exit command.
//   node --test scripts/ci/drill-rehearse.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build, judge } from "../drill/rehearse.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const CLI = `${ROOT}/scripts/drill/rehearse.mjs`;
const SH = `${ROOT}/scripts/drill/rehearse.sh`;
const down = JSON.parse(readFileSync(`${ROOT}/scripts/drill/servers-down.answers.json`, "utf8"));
// servers-down's recorded reads (unplug-proof.yml), planted on this rehearsal's ports
const onPorts = (r) => ({ ...r, helper: { ...r.helper, tcp: { 18190: Object.values(r.helper.tcp)[0], 18553: Object.values(r.helper.tcp)[1] } } });

const SEED = "seeded on label 123: refund_pending 5000000, move 1100000, return 1200000 (sol), U second 1300000, A second 1400000; X = x.test.near";
const CUT = "drill: cut passed before the exit command: bash rehearse.sh --cut /out";
const EXIT = ["exit: Your NEAR account for the money:", "exit: near: Send 0.0123 NEAR to a1.near to pay the fees (one-use account)", "exit: near: done: sent 10000000, left 0"];
const BAL = "x.usdc: 10000000 (want 10000000); the vault: 777 (mainnet's 777)";
const LOG = ["   Compiling blindfill-vault", "copy: blindfill.near at mainnet block 1, code hash X, 40 records read back at final, access keys []", SEED, "unplug: off, no server of the stack runs", "servers-down: PASS (127.0.0.1)", CUT, ...EXIT, BAL, "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 300.00s"].join("\n");

/** A planted out dir in rehearse.sh's shape; `over` replaces a file (null leaves it out). */
function plant(over = {}) {
  const dir = mkdtempSync(`${tmpdir()}/drill-rehearse-`);
  const files = {
    commit: "c371db5ba0000000000000000000000000000000",
    mode: "",
    ports: "18190 18553",
    health: "200",
    "stack.txt": "unplug: helper running\nunplug: caddy running",
    "cut.at": "2026-11-23T09:00:00Z",
    "unplug.txt": "unplug: docker compose stop helper caddy\nunplug: helper stopped\nunplug: caddy stopped\nunplug: off, no server of the stack runs",
    "unplug.rc": "0",
    "servers-down.json": JSON.stringify(onPorts(down.good)),
    "servers-down.txt": "ok 127.0.0.1:18553 answered nothing (refused)\nservers-down: PASS (127.0.0.1)",
    "servers-down.rc": "0",
    "exit.log": LOG,
    "exit.rc": "0",
    "requests.jsonl": [{ url: "http://127.0.0.1:3030/", ours: false }, { url: "https://raw.githubusercontent.com/x", ours: false }].map((q) => JSON.stringify(q)).join("\n"),
    ...over,
  };
  for (const [f, text] of Object.entries(files)) if (text !== null) writeFileSync(`${dir}/${f}`, `${text}\n`);
  return dir;
}

function judged(over) {
  const dir = plant(over);
  try {
    return judge(build(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const bad = (v, n) => v.lines.find((l) => l.startsWith(`BAD ${n}. `));
const swap = (log, from, to) => log.replace(from, to);
const goodLog = () => LOG;

test("a planted rehearsal in rehearse.sh's shape passes on all six steps, and the record keeps none of the build's lines", () => {
  const dir = plant();
  try {
    const r = build(dir);
    const v = judge(r);
    assert.equal(v.pass, true, v.lines.join("\n"));
    assert.equal(v.lines.filter((l) => l.startsWith("ok ")).length, 6, v.lines.join("\n"));
    assert.ok(!r.exit.lines.some((l) => l.includes("Compiling")));
    assert.match(v.lines[4], /payout account 10000000 of 10000000, vault 777 \(mainnet's 777\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unplug left on: servers-down reads the stack answering and fails, the test stops at the cut, the exit never runs", () => {
  const log = ["copy: blindfill.near at mainnet block 1, code hash X, 40 records read back at final, access keys []", SEED, "rehearse: unplug.sh off left out (--leave-on)", "servers-down: FAIL (127.0.0.1)", "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 200.00s"].join("\n");
  const v = judged({ mode: "--leave-on", "unplug.txt": "rehearse: unplug.sh off left out (--leave-on)", "unplug.rc": null, "servers-down.json": JSON.stringify(onPorts(down.back_on)), "servers-down.rc": "1", "exit.log": log, "exit.rc": "101" });
  assert.equal(v.pass, false);
  assert.match(bad(v, 3), /left out \(--leave-on\)/);
  assert.match(bad(v, 4), /^BAD 4\. servers down: FAIL on 127\.0\.0\.1:18190,18553 .*took a connection/);
  assert.match(bad(v, 5), /not after a passed cut; no done line; no balance read/);
});

test("each step fails on its own fault", () => {
  const cases = [
    [1, { health: "503" }, /health 503/],
    [1, { "stack.txt": "unplug: helper running\nunplug: caddy stopped" }, /running: helper$/],
    [2, { "exit.log": swap(goodLog(), "access keys []", "access keys [x]") }, /./],
    [2, { "exit.log": swap(goodLog(), SEED, "") }, /no seed read/],
    [3, { "unplug.rc": "1" }, /exit 1/],
    [3, { "unplug.txt": "unplug: still running after the stop: caddy" }, /no off line/],
    [4, { "servers-down.json": JSON.stringify(down.good) }, /not the stack's ports/],
    [4, { "servers-down.json": null }, /not read/],
    [4, { "servers-down.rc": "1" }, /exit 1/],
    [5, { "exit.log": swap(swap(goodLog(), `${CUT}\n`, ""), EXIT[2], `${EXIT[2]}\n${CUT}`) }, /not after a passed cut/],
    [5, { "exit.log": swap(goodLog(), BAL, "x.usdc: 8600000 (want 10000000); the vault: 2177 (mainnet's 777)") }, /payout account 8600000 of 10000000/],
    [5, { "exit.log": swap(goodLog(), BAL, "x.usdc: 10000000 (want 10000000); the vault: 778 (mainnet's 777)") }, /vault 778/],
    [5, { "exit.log": swap(goodLog(), EXIT[2], "exit: near: stopped: the fee did not arrive") }, /no done line/],
    [5, { "exit.rc": "101" }, /test exit 101/],
    [6, { "requests.jsonl": JSON.stringify({ url: "https://ct-api.unrealized.trade/v1/health", ours: true }) }, /1 to a host of ours: https:\/\/ct-api/],
    [6, { "requests.jsonl": "" }, /0 request\(s\) written down/],
  ];
  for (const [n, over, why] of cases) {
    const v = judged(over);
    assert.equal(v.pass, false, `${JSON.stringify(over).slice(0, 80)}: ${v.lines.join("\n")}`);
    assert.match(bad(v, n) ?? "", why, `${JSON.stringify(over).slice(0, 80)}: ${v.lines.join("\n")}`);
  }
  assert.equal(judge(null).pass, false);
  assert.equal(judge({}).pass, false);
});

test("the command: record writes record.json and exits 0 on PASS, --dry judges it again; a bad run exits 1", () => {
  const good = plant();
  const left = plant({ mode: "--leave-on", "unplug.rc": null, "servers-down.json": JSON.stringify(onPorts(down.back_on)), "servers-down.rc": "1", "exit.rc": "101" });
  try {
    let r = spawnSync(process.execPath, [CLI, "record", good], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^rehearse: PASS at c371db5ba/m);
    r = spawnSync(process.execPath, [CLI, "--dry", `${good}/record.json`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    r = spawnSync(process.execPath, [CLI, "record", left], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^rehearse: FAIL \(unplug left on\)/m);
    r = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
    assert.equal(r.status, 2, r.stdout + r.stderr);
  } finally {
    rmSync(good, { recursive: true, force: true });
    rmSync(left, { recursive: true, force: true });
  }
});

test("rehearse.sh refuses a bad call before it starts anything", () => {
  for (const args of [[], ["/tmp/x", "--bogus"], ["/tmp/x", "--leave-on", "more"]]) {
    const r = spawnSync("bash", [SH, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, `${args}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: rehearse\.sh/);
  }
});

test("exit_every_kind runs DRILL_CUT after the deposits and before the exit command, and stops when it fails", () => {
  const rs = readFileSync(`${ROOT}/contracts/vault/tests/exit_every_kind.rs`, "utf8");
  const [seed, cut, cmd] = [rs.indexOf('println!("seeded on label'), rs.indexOf('std::env::var("DRILL_CUT")'), rs.indexOf('join("packages/exit/test/exit-cli.ts")).arg(&rpc)')];
  assert.ok(seed > 0 && cut > seed && cmd > cut, `seed ${seed}, cut ${cut}, exit command ${cmd}`);
  assert.match(rs.slice(cut, cmd), /assert!\(ok, "drill: the cut failed/);
  assert.match(readFileSync(SH, "utf8"), /export DRILL_CUT="bash \$ROOT\/scripts\/drill\/rehearse\.sh --cut \$OUT \$LEAVE"/);
});
