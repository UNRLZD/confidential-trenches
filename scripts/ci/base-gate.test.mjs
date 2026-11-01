// On a pull request, ci.yml runs money-gate and verify-gate as the base commit has them, so a pull request cannot
// change the gate that judges it. This test finds every ci.yml step that runs a gate from "$RUNNER_TEMP", replays its
// "$RUNNER_TEMP" lines in a temp clone and checks that each gate loads (no ERR_MODULE_NOT_FOUND), runs as the base
// has it (the head's tampered copy never runs) and judges the head's checkout (the head's own record and live check).
//   node --test scripts/ci/base-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CI = path.join(ROOT, ".github/workflows/ci.yml");
const PROBE = "base-gate-probe";
const TAMPER = 'console.log("TAMPERED"); process.exit(0);\n';

// the steps of ci.yml that run a gate from "$RUNNER_TEMP": { job, gate, env, lines }
export function baseGateSteps(yml) {
  const steps = [];
  let job = null;
  let cur = null;
  const flush = () => {
    if (cur && /\bnode\s+"\$RUNNER_TEMP\//.test(cur.run.join("\n"))) {
      const lines = cur.run.filter((l) => l.includes("$RUNNER_TEMP")).map((l) => l.trim().replace(/\s*;;$/, ""));
      const gate = lines.map((l) => /^node\s+"\$RUNNER_TEMP\/(?:\S*\/)?([a-z-]+)\.mjs"/.exec(l)?.[1]).find(Boolean);
      steps.push({ job, gate, env: cur.env, lines });
    }
    cur = null;
  };
  let block = null; // "env" or "run" while inside one, with the indent its lines must exceed
  for (const raw of yml.split(/\r?\n/)) {
    const j = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(raw);
    if (j) {
      flush();
      job = j[1];
      continue;
    }
    if (/^ {6}- /.test(raw)) {
      flush();
      cur = { env: {}, run: [] };
      block = null;
    }
    if (!cur) continue;
    const indent = raw.match(/^ */)[0].length;
    const body = raw.replace(/^ {6}- /, "        ");
    if (block && raw.trim() && indent <= block.indent) block = null;
    const key = /^( *)(env|run):\s*(\|)?\s*(.*)$/.exec(body);
    if (!block && key) {
      if (key[2] === "env") block = { kind: "env", indent: key[1].length };
      else if (key[3]) block = { kind: "run", indent: key[1].length };
      else cur.run.push(key[4]);
      continue;
    }
    if (block?.kind === "env") {
      const kv = /^\s*([A-Z_][A-Z0-9_]*):\s*(.*)$/.exec(raw);
      if (kv) cur.env[kv[1]] = kv[2].trim();
    } else if (block?.kind === "run") cur.run.push(raw);
  }
  flush();
  return steps;
}

// a step's env as a pull request from base to head sets it
function prEnv(env, base, head) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/pull_request\.base\.sha/.test(v)) out[k] = base;
    else if (/pull_request\.head\.sha/.test(v)) out[k] = head;
    else if (/github\.event_name/.test(v)) out[k] = "pull_request";
    else out[k] = "";
  }
  return out;
}

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// a temp clone at ROOT's HEAD (the base) with one commit on top (the head): the head names card base-gate-probe, adds
// that card's live check and a "Money path: no" record, and tampers both gates so a head copy that ran would show it
function prClone() {
  const dir = mkdtempSync(path.join(tmpdir(), "base-gate-"));
  const repo = path.join(dir, "repo");
  const base = git(ROOT, ["rev-parse", "HEAD"]);
  git(dir, ["clone", "--quiet", "--shared", "--no-checkout", ROOT, repo]);
  git(repo, ["checkout", "--quiet", "--detach", base]);
  writeFileSync(path.join(repo, `scripts/live-checks/${PROBE}.mjs`), "// probe\n");
  writeFileSync(path.join(repo, `scripts/live-checks/${PROBE}.md`), `CARD ${PROBE} / live: PASS\nMoney path: no\n`);
  for (const g of ["money-gate", "verify-gate"]) {
    const f = path.join(repo, `scripts/ci/${g}.mjs`);
    const text = readFileSync(f, "utf8");
    writeFileSync(f, text.startsWith("#!") ? text.replace(/\n/, `\n${TAMPER}`) : TAMPER + text);
  }
  git(repo, ["add", "--", "scripts/live-checks", "scripts/ci"]);
  git(repo, ["-c", "user.name=ci", "-c", "user.email=ci@example.invalid", "commit", "--quiet", "--no-verify", "-m", `Card ${PROBE}: probe`]);
  return { dir, repo, base, head: git(repo, ["rev-parse", "HEAD"]) };
}

// runs the lines as GitHub runs a step's run block (bash -e), in the checkout, with a fresh RUNNER_TEMP
function replay(pr, lines, env) {
  const runnerTemp = mkdtempSync(path.join(pr.dir, "runner-temp-"));
  const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", lines.join("\n")], {
    cwd: pr.repo,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RUNNER_TEMP: runnerTemp, ...prEnv(env, pr.base, pr.head) },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const EXPECT = {
  "money-gate": /money-gate: PASS \(1 record\(s\) read, 0 tx read\(s\)\)/,
  "verify-gate": new RegExp(`verify-gate: PASS \\(cards: ${PROBE}\\)`),
};

test("ci.yml runs money-gate and verify-gate from the base on a pull request", () => {
  const steps = baseGateSteps(readFileSync(CI, "utf8"));
  assert.deepEqual(steps.map((s) => s.gate).sort(), ["money-gate", "verify-gate"], JSON.stringify(steps, null, 2));
});

test("each base gate loads with every file it imports and judges the head's checkout", (t) => {
  const pr = prClone();
  t.after(() => rmSync(pr.dir, { recursive: true, force: true }));
  for (const step of baseGateSteps(readFileSync(CI, "utf8"))) {
    const { status, out } = replay(pr, step.lines, step.env);
    const what = `${step.job}: ${step.lines.join(" / ")}\n${out}`;
    assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND/, what);
    assert.doesNotMatch(out, /TAMPERED/, `the head's gate ran, not the base's: ${what}`);
    assert.match(out, EXPECT[step.gate], what);
    assert.equal(status, 0, what);
  }
});

// planted case: 03cb57f's step copied the base's money-gate.mjs alone, so its import of ../net-window.mjs failed
test("planted: the old single-file copy of money-gate.mjs fails to load", (t) => {
  const pr = prClone();
  t.after(() => rmSync(pr.dir, { recursive: true, force: true }));
  const old = [
    'git show "$PR_BASE:scripts/ci/money-gate.mjs" > "$RUNNER_TEMP/money-gate.mjs"',
    'node "$RUNNER_TEMP/money-gate.mjs" "$PR_BASE" "$PR_HEAD"',
  ];
  const env = { PR_BASE: "${{ github.event.pull_request.base.sha }}", PR_HEAD: "${{ github.event.pull_request.head.sha }}" };
  const { status, out } = replay(pr, old, env);
  assert.match(out, /ERR_MODULE_NOT_FOUND/, out);
  assert.notEqual(status, 0);
});
