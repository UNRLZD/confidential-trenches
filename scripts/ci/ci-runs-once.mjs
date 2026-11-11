// A merge runs the full checks once (card main-ci-runs-once). Main's ruleset (26292755: pull_request and merge_queue
// rules, no bypass actor, read 11 Nov 11:3xZ) lets a commit onto main only through the merge queue, and the queue lands
// the very commit its group's ci.yml run tested (merge_group, head_sha = the commit main then points to: b04a2352's run
// 43008967616). A push trigger ran every job again on that commit, so ci.yml has none, and a reader of a commit's CI
// takes its runs by sha:
//   - a full run is the merge queue's on main's queue (event merge_group, branch gh-readonly-queue/main/...), a push to
//     main's (the commits from before this card) or one by hand on main (workflow_dispatch). A scheduled run is not one:
//     it checks the vault sandbox alone and skips every other job;
//   - a commit may be deployed or read green only once one full run on it passed. One that failed or was cancelled is
//     named with the rerun that redoes it, one still going is waited for, and a commit with no full run at all (one the
//     queue did not test, which the ruleset leaves no way to make) is named with the run by hand that gives it one.
// The queue can land a group once the required jobs pass, while the run's other jobs still go: that run is still the
// commit's one run, and a reader waits for its end, so a job that fails after main moved is read as red on that commit.
//   node scripts/ci/ci-runs-once.mjs [<ci.yml>]    exit 0 when ci.yml has no push trigger and keeps pull_request,
//                                                 merge_group and workflow_dispatch; 1 otherwise
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const REPO_SLUG = "UNRLZD/confidential-trenches";

/** The `on:` block's triggers, by name: { name: body }, or null when ci.yml has no block form `on:` this reads. */
export function triggers(yml) {
  const block = /^on:\n((?:(?: {2}.*| *#.*|)\n)+)/m.exec(String(yml))?.[1];
  if (block === undefined) return null;
  const out = {};
  let name = null;
  for (const line of block.split("\n")) {
    const m = /^ {2}([A-Za-z_]+):(.*)$/.exec(line);
    if (m) out[(name = m[1])] = m[2].trim();
    else if (name && /^ {4}/.test(line)) out[name] += `\n${line.trim()}`;
  }
  return out;
}

/** Why ci.yml's triggers break the rule (empty = none). */
export function triggerProblems(yml) {
  const t = triggers(yml);
  if (!t) return ["ci.yml has no `on:` block in the form this gate reads (one trigger per line, two-space indented)"];
  const p = [];
  if ((String(yml).match(/^["']?on["']?[ \t]*:/gm) ?? []).length !== 1) p.push("ci.yml names its triggers a second way");
  if ("push" in t) p.push("ci.yml runs on push: a merged commit's queue run is its one full run, and a push run on the same commit runs every job again");
  if (!("merge_group" in t) || !/types: \[checks_requested\]/.test(t.merge_group)) p.push("ci.yml does not run on merge_group checks_requested: no commit on main would have a full run");
  if (!("pull_request" in t) || !/branches: \[main\]/.test(t.pull_request)) p.push("ci.yml does not run on pull requests into main");
  if (!("workflow_dispatch" in t)) p.push("ci.yml has no workflow_dispatch: a commit with no full run could not be given one");
  for (const k of Object.keys(t)) if (!["pull_request", "merge_group", "schedule", "workflow_dispatch", "push"].includes(k)) p.push(`ci.yml runs on ${k}, which this rule does not know`);
  return p;
}

/** Whether a ci.yml run (gh run list --json event,headBranch,...) is a commit's full run (see the header). */
export const fullRun = (r) =>
  (r?.event === "merge_group" && /^gh-readonly-queue\/main\//.test(r?.headBranch ?? "")) || ((r?.event === "push" || r?.event === "workflow_dispatch") && r?.headBranch === "main");

/** The gh call that lists a commit's ci.yml runs, newest first. */
export const runsArgs = (sha, slug = REPO_SLUG) => ["run", "list", "-R", slug, "--workflow", "ci.yml", "--commit", sha, "-L", "50", "--json", "headSha,headBranch,event,status,conclusion,databaseId"];

/** Why commit `sha`'s CI does not let it go (empty = one full run on it passed). `runs` is gh's answer to runsArgs. */
export function ciProblems(sha, runs, slug = REPO_SLUG) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) return [`${sha || "(no commit)"} is not a full commit sha: its ci.yml runs are read by the full sha`];
  if (!Array.isArray(runs)) return [`gh did not read ci.yml's runs on ${sha}`];
  const full = runs.filter((r) => r?.headSha === sha && fullRun(r));
  if (full.some((r) => r.status === "completed" && r.conclusion === "success")) return [];
  const last = full[0];
  const what = (r) => `${r.event === "merge_group" ? "merge queue" : r.event === "push" ? "push" : "by-hand"} run of ci.yml (${r.databaseId})`;
  if (!last) return [`${sha} has no full ci.yml run (the merge queue's, a push to main's or one by hand${runs.some((r) => r?.headSha === sha) ? "; a scheduled run checks the vault sandbox alone" : ""}): give it one with gh workflow run ci.yml --ref main -R ${slug}, and go once it passes`];
  if (last.status !== "completed") return [`${sha}'s ${what(last)} is ${last.status}: wait for it to pass`];
  return [`${sha}'s ${what(last)} ended ${last.conclusion}: rerun it (gh run rerun ${last.databaseId} -R ${slug}) and go once it passes`];
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? path.join(ROOT, ".github/workflows/ci.yml");
  const p = triggerProblems(readFileSync(file, "utf8"));
  for (const l of p) console.log(`ci-runs-once: ${l}`);
  console.log(p.length ? `ci-runs-once: FAIL ${p.length} problems` : "ci-runs-once: PASS ci.yml runs once per merged commit (the queue's run), on pull requests, nightly and by hand");
  process.exit(p.length ? 1 : 0);
}
