// On a pull request, ci.yml runs money-gate, verify-gate, vault-sandbox's rule and quote-speed as the base commit has them, so a pull
// request cannot change the gate that judges it; on a merge queue group, as main has them, from main (the merge base of
// main and the group's head) to the group's head. This test finds every ci.yml step that runs a gate from
// "$RUNNER_TEMP", replays its whole run block in a temp clone as a pull request and as a group, and checks that each
// gate's job runs on both, that each gate loads (no ERR_MODULE_NOT_FOUND), runs as the base has it (the head's tampered
// copy never runs) and judges the head's checkout (the head's own record and live check).
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

// the steps of ci.yml that run a gate from "$RUNNER_TEMP": { job, jobIf, gate, env, lines, run }; lines are its
// "$RUNNER_TEMP" lines, run its whole run block
export function baseGateSteps(yml) {
  const steps = [];
  let job = null;
  let cur = null;
  const ifs = new Map(); // each job's own if:
  const flush = () => {
    if (cur && /\bnode\s+"\$RUNNER_TEMP\//.test(cur.run.join("\n"))) {
      const lines = cur.run.filter((l) => l.includes("$RUNNER_TEMP")).map((l) => l.trim().replace(/\s*;;$/, ""));
      const gate = lines.map((l) => /^node\s+"\$RUNNER_TEMP\/(?:\S*\/)?([a-z-]+)\.mjs"/.exec(l)?.[1]).find(Boolean);
      steps.push({ job, jobIf: ifs.get(job) ?? "", gate, env: cur.env, lines, run: cur.run });
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
    const jobIf = /^ {4}if: (.*)$/.exec(raw);
    if (jobIf && job) ifs.set(job, jobIf[1].trim());
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

// a step's env as a pull request from base to head sets it, or as a merge queue group whose head is head (its main is
// the clone's origin/main, the base)
function prEnv(env, base, head, event = "pull_request") {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/github\.event_name/.test(v)) out[k] = event;
    else if (event === "pull_request") out[k] = /pull_request\.base\.sha/.test(v) ? base : /pull_request\.head\.sha/.test(v) ? head : "";
    else if (/merge_group\.head_sha|\|\| github\.sha/.test(v)) out[k] = head;
    else if (/merge_group\.base_ref/.test(v)) out[k] = "refs/heads/main";
    else out[k] = "";
  }
  return out;
}

// a job's if: as GitHub reads it for an event (the shapes ci.yml uses: event_name compares, always(), && and ||)
export function jobRuns(jobIf, event) {
  if (!jobIf) return true;
  const js = jobIf
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/github\.event_name/g, JSON.stringify(event))
    .replace(/always\(\)/g, "true")
    .replace(/'([^']*)'/g, (_, x) => JSON.stringify(x))
    .replace(/([!=])=/g, "$1==");
  if (!/^(?:\s|"[a-z_]*"|true|===|!==|&&|\|\||\(|\))*$/.test(js)) throw new Error(`a job if this test cannot read: ${jobIf}`);
  return Function(`return (${js});`)();
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
  for (const g of ["money-gate", "verify-gate", "vault-sandbox", "quote-speed"]) {
    const f = path.join(repo, `scripts/ci/${g}.mjs`);
    const text = readFileSync(f, "utf8");
    writeFileSync(f, text.startsWith("#!") ? text.replace(/\n/, `\n${TAMPER}`) : TAMPER + text);
  }
  git(repo, ["add", "--", "scripts/live-checks", "scripts/ci"]);
  git(repo, ["-c", "user.name=ci", "-c", "user.email=ci@example.invalid", "commit", "--quiet", "--no-verify", "-m", `Card ${PROBE}: probe`]);
  return { dir, repo, base, head: git(repo, ["rev-parse", "HEAD"]) };
}

// the pull request's clone, its head merged as GitHub's queue merges it (a merge commit on main, merge method MERGE),
// and origin/main at the base: { dir, repo, base, head }, head the group's head
function groupClone() {
  const pr = prClone();
  git(pr.repo, ["update-ref", "refs/remotes/origin/main", pr.base]);
  git(pr.repo, ["checkout", "--quiet", "--detach", pr.base]);
  git(pr.repo, ["-c", "user.name=ci", "-c", "user.email=ci@example.invalid", "merge", "--quiet", "--no-ff", "-m", `Card ${PROBE}: merge (#1)`, pr.head]);
  return { ...pr, head: git(pr.repo, ["rev-parse", "HEAD"]) };
}

// runs the lines as GitHub runs a step's run block (bash -e), in the checkout, with a fresh RUNNER_TEMP
function replay(pr, lines, env, event = "pull_request") {
  const runnerTemp = mkdtempSync(path.join(pr.dir, "runner-temp-"));
  const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", lines.join("\n")], {
    cwd: pr.repo,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RUNNER_TEMP: runnerTemp, ...prEnv(env, pr.base, pr.head, event) },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const EXPECT = {
  "money-gate": /money-gate: PASS \(1 record\(s\) read, 0 tx read\(s\)\)/,
  "verify-gate": new RegExp(`verify-gate: PASS \\(cards: ${PROBE}\\)`),
  // the head touches scripts/ci/vault-sandbox.mjs, a file of the rule's own PATHS
  "vault-sandbox": /run=true: \d+ changed file\(s\) the suite reads/,
  // the head touches no file of the quote, so the base's gate decides on the head's change without a run
  "quote-speed": /quote-speed: PASS \(skip: none of \d+ changed file\(s\)/,
};

test("ci.yml runs money-gate, verify-gate, vault-sandbox's rule and quote-speed from the base on a pull request", () => {
  const steps = baseGateSteps(readFileSync(CI, "utf8"));
  assert.deepEqual(steps.map((s) => s.gate).sort(), ["money-gate", "quote-speed", "vault-sandbox", "verify-gate"], JSON.stringify(steps, null, 2));
});

for (const [event, clone] of [["pull_request", prClone], ["merge_group", groupClone]])
  test(`each base gate runs on ${event}, loads with every file it imports and judges the head's checkout, never the head's own copy`, (t) => {
    const pr = clone();
    t.after(() => rmSync(pr.dir, { recursive: true, force: true }));
    for (const step of baseGateSteps(readFileSync(CI, "utf8"))) {
      assert.ok(jobRuns(step.jobIf, event), `${step.job} does not run on ${event} (if: ${step.jobIf}): a skipped required check passes`);
      const { status, out } = replay(pr, step.run, step.env, event);
      const what = `${event} ${step.job}: ${step.run.join(" / ")}\n${out}`;
      assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND/, what);
      assert.doesNotMatch(out, /TAMPERED/, `the head's gate ran, not the base's: ${what}`);
      assert.match(out, EXPECT[step.gate], what);
      assert.equal(status, 0, what);
    }
  });

test("a job that runs only on pull_request is read as skipped on merge_group, and != 'schedule' as run", () => {
  assert.equal(jobRuns("github.event_name == 'pull_request'", "merge_group"), false);
  assert.equal(jobRuns("github.event_name == 'pull_request' || github.event_name == 'merge_group'", "merge_group"), true);
  assert.equal(jobRuns("always() && github.event_name != 'schedule'", "merge_group"), true);
  assert.throws(() => jobRuns("needs.plan.outputs.run == 'true'", "merge_group"));
});

// the required checks of main's ruleset (ci.yml's header names them): GitHub reads a skipped job as passed, so each
// must run on a merge queue group as on a pull request
const REQUIRED = ["gitleaks", "deep-import", "verify-gate", "money-gate", "test", "vault-sandbox"];
test("ci.yml runs on merge_group, and every required check's job runs on it", () => {
  const yml = readFileSync(CI, "utf8");
  assert.match(yml, /^on:\n(?: {2}.*\n|#.*\n)*? {2}merge_group:\n {4}types: \[checks_requested\]\n/m);
  for (const job of REQUIRED) {
    const body = yml.split(new RegExp(`\n  ${job}:\n`))[1];
    assert.ok(body, `ci.yml has no job ${job}`);
    const jobIf = /^ {4}if: (.*)$/m.exec(body.split(/\n  [a-z][a-z0-9-]*:\n/)[0])?.[1] ?? "";
    assert.ok(jobRuns(jobIf, "merge_group"), `${job} does not run on merge_group (if: ${jobIf})`);
  }
});

// planted: a group step that runs its gate from merge_group.base_sha, the group's parent commit, which is the queue
// entry ahead (not main) for every pull request but the first, runs that entry's copy of the gate
test("planted: a group judged from base_sha, the queue entry ahead, runs that entry's gate, not main's", (t) => {
  const pr = groupClone();
  t.after(() => rmSync(pr.dir, { recursive: true, force: true }));
  // the second pull request, queued behind the first (whose own copy of the gate is tampered): its group's parent
  // commit, base_sha, is the first entry's group head
  const id = ["-c", "user.name=ci", "-c", "user.email=ci@example.invalid"];
  git(pr.repo, ["checkout", "--quiet", "-b", "second", pr.base]);
  writeFileSync(path.join(pr.repo, "second.txt"), "2\n");
  git(pr.repo, ["add", "--", "second.txt"]);
  git(pr.repo, [...id, "commit", "--quiet", "--no-verify", "-m", "Card second: two"]);
  git(pr.repo, ["checkout", "--quiet", "--detach", pr.head]);
  git(pr.repo, [...id, "merge", "--quiet", "--no-ff", "-m", "Card second: merge (#2)", "second"]);
  const bad = ['mkdir -p "$RUNNER_TEMP/base"', 'git archive "$MQ_BASE" scripts | tar -x -f - -C "$RUNNER_TEMP/base"', 'node "$RUNNER_TEMP/base/scripts/ci/verify-gate.mjs" --group "$MQ_BASE" "$MQ_HEAD"'];
  const runnerTemp = mkdtempSync(path.join(pr.dir, "runner-temp-"));
  const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", bad.join("\n")], {
    cwd: pr.repo,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RUNNER_TEMP: runnerTemp, MQ_BASE: pr.head, MQ_HEAD: git(pr.repo, ["rev-parse", "HEAD"]) },
  });
  assert.match(`${r.stdout}${r.stderr}`, /TAMPERED/);
  const verify = baseGateSteps(readFileSync(CI, "utf8")).find((s) => s.gate === "verify-gate");
  assert.doesNotMatch(verify.run.join("\n"), /base_sha|MQ_BASE\b/, "the group's main is the merge base of main and its head");
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
