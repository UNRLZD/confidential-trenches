// On a pull request, ci.yml runs money-gate, verify-gate, vault-sandbox's rule, pr-paths' rule and quote-speed as the base commit has them, so a pull
// request cannot change the gate that judges it; on a merge queue group, as main has them, from main (the merge base of
// main and the group's head) to the group's head. This test finds every ci.yml step that runs a gate from
// "$RUNNER_TEMP", replays its whole run block in a temp clone as a pull request and as a group, and checks that each
// gate's job runs on both, that each gate loads (no ERR_MODULE_NOT_FOUND), runs as the base has it (the head's tampered
// copy never runs) and judges the head's checkout (the head's own record and live check).
//   node --test scripts/ci/base-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
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
    // the group's parent: main itself for the first entry (a test of a later entry passes its own in extra)
    else if (/merge_group\.base_sha/.test(v)) out[k] = base;
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

const git = (cwd, args, env) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: env && { ...process.env, ...env } }).trim();

// a temp clone at ROOT's HEAD (the base) with one commit on top (the head): the head names card base-gate-probe, adds
// that card's live check and a "Money path: no" record, and tampers both gates so a head copy that ran would show it.
// The clone runs no auto maintenance (maintenance.auto=false in its own config): a commit or a merge ends with
// `git maintenance run --auto --detach` (git 2.50 and 2.56), a process that outlives the command, and git 2.56's default
// tasks (CI's runner) write a commit-graph when 100 commits are not in one, as on CI's checkout of all of main's history
// with none; it wrote into the clone while t.after removed it (merge queue run 43665465254: rmSync ENOTEMPTY). env: the
// planted case's git config for the commit.
function prClone(env) {
  const dir = mkdtempSync(path.join(tmpdir(), "base-gate-"));
  const repo = path.join(dir, "repo");
  const base = git(ROOT, ["rev-parse", "HEAD"]);
  git(dir, ["clone", "--quiet", "--shared", "--no-checkout", "-c", "maintenance.auto=false", ROOT, repo]);
  git(repo, ["checkout", "--quiet", "--detach", base]);
  writeFileSync(path.join(repo, `scripts/live-checks/${PROBE}.mjs`), "// probe\n");
  writeFileSync(path.join(repo, `scripts/live-checks/${PROBE}.md`), `CARD ${PROBE} / live: PASS\nMoney path: no\n`);
  for (const g of ["money-gate", "verify-gate", "vault-sandbox", "quote-speed", "pr-paths"]) {
    const f = path.join(repo, `scripts/ci/${g}.mjs`);
    const text = readFileSync(f, "utf8");
    writeFileSync(f, text.startsWith("#!") ? text.replace(/\n/, `\n${TAMPER}`) : TAMPER + text);
  }
  git(repo, ["add", "--", "scripts/live-checks", "scripts/ci"]);
  git(repo, ["-c", "user.name=ci", "-c", "user.email=ci@example.invalid", "commit", "--quiet", "--no-verify", "-m", `Card ${PROBE}: probe`], env);
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

// runs the lines as GitHub runs a step's run block (bash -e), in the checkout, with a fresh RUNNER_TEMP and the step's
// own GITHUB_OUTPUT file, as GitHub gives every step
function replay(pr, lines, env, event = "pull_request", extra = {}) {
  const runnerTemp = mkdtempSync(path.join(pr.dir, "runner-temp-"));
  const output = path.join(runnerTemp, "github-output");
  writeFileSync(output, "");
  const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", lines.join("\n")], {
    cwd: pr.repo,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output, ...prEnv(env, pr.base, pr.head, event), ...extra },
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
  // card ci-pr-light: the head touches scripts/ci/vault-sandbox.mjs, a file every test job reads, so every job runs;
  // a group decides nothing (each gated job reads the rule's output only on pull_request)
  "pr-paths": /^test_mutants=true$|^a merge_group run runs every job$/m,
};

test("ci.yml runs money-gate, verify-gate, vault-sandbox's rule, pr-paths' rule and quote-speed from the base on a pull request", () => {
  const steps = baseGateSteps(readFileSync(CI, "utf8"));
  assert.deepEqual(steps.map((s) => s.gate).sort(), ["money-gate", "pr-paths", "quote-speed", "vault-sandbox", "verify-gate"], JSON.stringify(steps, null, 2));
});

// card ci-runs-once-per-change: the vault sandbox's plan runs on the queue's group alone (its rule judges the group as a
// pull request from main), so a pull request replays every other base gate; scripts/ci/ci-runs-once.mjs holds the fast
// gates on pull requests
const QUEUE_ONLY = ["vault-sandbox-plan"];
for (const [event, clone] of [["pull_request", prClone], ["merge_group", groupClone]])
  test(`each base gate runs on ${event}, loads with every file it imports and judges the head's checkout, never the head's own copy`, (t) => {
    const pr = clone();
    t.after(() => rmSync(pr.dir, { recursive: true, force: true }));
    for (const step of baseGateSteps(readFileSync(CI, "utf8"))) {
      if (event === "pull_request" && QUEUE_ONLY.includes(step.job)) {
        assert.equal(jobRuns(step.jobIf, event), false, `${step.job} runs on pull_request (if: ${step.jobIf})`);
        continue;
      }
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

// planted (review P1): git reads a rev "origin/main" as refs/tags/origin/main before refs/remotes/origin/main, and the
// checkout fetches every tag, so a pushed tag of that name on the pull request's own commit would pick its tampered gates
test("planted: a tag named origin/main on the pull request's own commit never picks the gate that judges its group", (t) => {
  const pr = groupClone();
  t.after(() => rmSync(pr.dir, { recursive: true, force: true }));
  git(pr.repo, ["tag", "origin/main", `${pr.head}^2`]);
  for (const step of baseGateSteps(readFileSync(CI, "utf8"))) {
    const { status, out } = replay(pr, step.run, step.env, "merge_group");
    const what = `merge_group ${step.job}: ${step.run.join(" / ")}\n${out}`;
    assert.doesNotMatch(out, /TAMPERED/, `the tag picked the pull request's own gate: ${what}`);
    assert.match(out, EXPECT[step.gate], what);
    assert.equal(status, 0, what);
  }
});

test("planted: a group into a branch other than main runs no gate and fails", (t) => {
  const pr = groupClone();
  t.after(() => rmSync(pr.dir, { recursive: true, force: true }));
  git(pr.repo, ["update-ref", "refs/remotes/origin/other", `${pr.head}^2`]);
  for (const step of baseGateSteps(readFileSync(CI, "utf8"))) {
    const { status, out } = replay(pr, step.run, step.env, "merge_group", { MQ_BASE_REF: "refs/heads/other" });
    const what = `merge_group ${step.job}: ${step.run.join(" / ")}\n${out}`;
    assert.doesNotMatch(out, /TAMPERED|PASS|run=/, what);
    assert.notEqual(status, 0, what);
  }
});

// the required checks of main's ruleset, as ci.yml's header names them (the one list in the repo; the ruleset itself
// is GitHub's, read only with a token): GitHub reads a skipped job as passed, so each must run on a merge queue group
export function requiredChecks(yml) {
  const header = yml.split(/\n(?!#)/)[0].replace(/\n# ?/g, " ");
  const m = /required checks of main's ruleset \([^)]*\): ([a-z0-9, -]+)\./.exec(header);
  return m ? m[1].split(/,\s*/) : [];
}
test("ci.yml runs on merge_group, and every required check's job runs on it", () => {
  const yml = readFileSync(CI, "utf8");
  const REQUIRED = requiredChecks(yml);
  assert.deepEqual(REQUIRED, ["gitleaks", "deep-import", "verify-gate", "money-gate", "test", "vault-sandbox"]);
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

// Card quote-speed-measures-its-own-change: a group decides whether to measure the quote on the queued pull request's own
// files, its head against base_sha (the group's parent, which holds the entries ahead), while the gate and CHECK still
// come from main. PR 979's group (run 44246114264, helper only) re-measured PR 978's quote files, which 978's own group
// had measured, and lost its round to a noisy RPC. Here main's CHECK is a stub that prints MEASURED and writes a passing
// record, so no test reaches a network, and both entries tamper their own quote-speed.mjs, so a step that took the gate
// from either shows TAMPERED.
const STUB_CHECK = `import { writeFileSync } from "node:fs";
export const check = (r) => ({ ok: r?.ok === true, lines: ["stub check"] });
if (import.meta.url === \`file://\${process.argv[1]}\`) {
  console.log("MEASURED");
  writeFileSync(process.argv[process.argv.indexOf("--record") + 1], JSON.stringify({ ok: true }));
}
`;
// main (ROOT's HEAD with the stub CHECK) and two queued pull requests merged onto it as the queue merges them, the first
// touching `ahead`, the second `own`: { dir, repo, base: main, parent: the first entry's group head, head: the second's }
function queuedGroup(ahead, own) {
  const dir = mkdtempSync(path.join(tmpdir(), "base-gate-queue-"));
  const repo = path.join(dir, "repo");
  const id = ["-c", "user.name=ci", "-c", "user.email=ci@example.invalid"];
  git(dir, ["clone", "--quiet", "--shared", "--no-checkout", "-c", "maintenance.auto=false", ROOT, repo]);
  git(repo, ["checkout", "--quiet", "--detach", git(ROOT, ["rev-parse", "HEAD"])]);
  writeFileSync(path.join(repo, "scripts/live-checks/evm-quote-warm-round.mjs"), STUB_CHECK);
  git(repo, ["add", "--", "scripts/live-checks/evm-quote-warm-round.mjs"]);
  git(repo, [...id, "commit", "--quiet", "--no-verify", "-m", "Card main: stub check"]);
  const main = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", main]);
  const heads = [];
  for (const [n, files] of [["ahead", ahead], ["own", own]]) {
    git(repo, ["checkout", "--quiet", "-b", n, main]);
    for (const f of files) writeFileSync(path.join(repo, f), `${readFileSync(path.join(repo, f), "utf8")}// ${n}\n`);
    const gate = path.join(repo, "scripts/ci/quote-speed.mjs");
    writeFileSync(gate, readFileSync(gate, "utf8").replace(/\n/, `\n${TAMPER}`));
    git(repo, ["add", "--", ...files, "scripts/ci/quote-speed.mjs"]);
    git(repo, [...id, "commit", "--quiet", "--no-verify", "-m", `Card ${n}: change`]);
    git(repo, ["checkout", "--quiet", "--detach", heads.at(-1) ?? main]);
    git(repo, [...id, "merge", "--quiet", "--no-ff", "-m", `Card ${n}: merge (#${heads.length + 1})`, n]);
    heads.push(git(repo, ["rev-parse", "HEAD"]));
  }
  return { dir, repo, base: main, parent: heads[0], head: heads[1] };
}
const QUOTE_A = "packages/kit/src/trade/evm/buy-unpinned.ts";
const QUOTE_B = "packages/kit/src/checks/evm/pool-index.ts";
const HELPER = "apps/helper/src/data/evm/swaps.ts";
const quoteStep = () => baseGateSteps(readFileSync(CI, "utf8")).find((s) => s.gate === "quote-speed");

test("planted: a group whose own change is helper only, queued behind a quote change, skips the measure", (t) => {
  const g = queuedGroup([QUOTE_A, QUOTE_B], [HELPER]);
  t.after(() => rmSync(g.dir, { recursive: true, force: true }));
  const step = quoteStep();
  const { status, out } = replay(g, step.run, step.env, "merge_group", { MQ_BASE_SHA: g.parent });
  assert.doesNotMatch(out, /TAMPERED/, out);
  assert.doesNotMatch(out, /MEASURED/, `the entry ahead's quote change was measured again in this group:\n${out}`);
  assert.match(out, /quote-speed: PASS \(skip: none of \d+ changed file\(s\)/, out);
  assert.equal(status, 0, out);
});

test("planted: a group whose own change touches the quote measures it, on its own quote files alone, with main's gate", (t) => {
  const g = queuedGroup([QUOTE_A, HELPER], [QUOTE_B]);
  t.after(() => rmSync(g.dir, { recursive: true, force: true }));
  const step = quoteStep();
  const { status, out } = replay(g, step.run, step.env, "merge_group", { MQ_BASE_SHA: g.parent });
  assert.doesNotMatch(out, /TAMPERED/, out);
  assert.match(out, /MEASURED/, out);
  assert.match(out, new RegExp(`quote-speed: 1 changed file\\(s\\) the quote reads: ${QUOTE_B}\\n`), out);
  assert.match(out, /quote-speed: PASS \(try 1 of 2\)/, out);
  assert.equal(status, 0, out);
});

test("planted: a group whose head is not one merge onto the base_sha it names, or names none, stops before any gate", (t) => {
  const g = queuedGroup([QUOTE_A], [HELPER]);
  t.after(() => rmSync(g.dir, { recursive: true, force: true }));
  const step = quoteStep();
  for (const parent of [g.base, g.head, ""]) {
    const { status, out } = replay(g, step.run, step.env, "merge_group", { MQ_BASE_SHA: parent });
    assert.doesNotMatch(out, /TAMPERED|MEASURED|PASS/, `base_sha ${parent}: ${out}`);
    assert.match(out, /is not one merge onto its parent/, `base_sha ${parent}: ${out}`);
    assert.notEqual(status, 0, out);
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

// planted (card ci-queue-races-gone): a commit-graph due on every commit, as git 2.56 finds on CI's checkout, starts no
// process that writes into the clone after git returns; with auto maintenance on, git 2.50 and 2.56 write it from a
// detached process some 50 ms later (run 43665465254: rmSync ENOTEMPTY in t.after)
test("planted: a commit-graph due on the clone's commit leaves no process writing into it after git returns", async (t) => {
  const due = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "maintenance.commit-graph.enabled", GIT_CONFIG_VALUE_0: "true", GIT_CONFIG_KEY_1: "maintenance.commit-graph.auto", GIT_CONFIG_VALUE_1: "-1" };
  const pr = prClone(due);
  t.after(() => rmSync(pr.dir, { recursive: true, force: true }));
  const files = (dir) => readdirSync(dir, { recursive: true }).sort().map((f) => {
    const s = statSync(path.join(dir, f), { throwIfNoEntry: false });
    return `${f} ${s?.size}:${s?.mtimeMs}`;
  });
  const before = files(path.join(pr.repo, ".git"));
  await sleep(1000);
  assert.deepEqual(files(path.join(pr.repo, ".git")), before, "a process wrote into the clone after git returned");
});
