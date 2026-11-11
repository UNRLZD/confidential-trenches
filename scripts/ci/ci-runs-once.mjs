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
// Caches: GitHub scopes a cache to the ref whose run saved it, and only main's are read by every pull request and queue
// group, so a cache a push run used to save on main is saved there by .github/workflows/ci-cache.yml (push to main, no
// test, never read as CI), each only when main lacks its key; the vault sandbox's by ci.yml's nightly. cacheProblems
// holds every cache ci.yml saves outside the nightly's jobs saved there with the same path and key, the test-vault job's
// steps up to its registry fetch equal (rust-cache keys on the job id, the toolchains and the env), no test run there,
// and that workflow on push to main and by hand alone.
//   node scripts/ci/ci-runs-once.mjs [<ci.yml> [<ci-cache.yml>]]   exit 0 when ci.yml has no push trigger and keeps
//                                                 pull_request, merge_group and workflow_dispatch, and ci-cache.yml
//                                                 saves its caches on main; 1 otherwise
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

/** The jobs of a workflow: { id: body }. */
export function jobs(yml) {
  const out = {};
  const body = String(yml).split(/^jobs:\n/m)[1] ?? "";
  for (const part of body.split(/^(?= {2}[a-z][\w-]*:\n)/m)) {
    const m = /^ {2}([a-z][\w-]*):\n/.exec(part);
    if (m) out[m[1]] = part;
  }
  return out;
}

/** A job's steps, each its text from its `- ` line (comment lines dropped, so a comment never makes two steps differ). */
export const steps = (job) => String(job).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").split(/^(?= {6}- )/m).slice(1).map((x) => `${x.trimEnd()}\n`);

/** A cache step's { uses, path, key, lookup } (path: its lines, trimmed), or null when the step is no actions/cache one. */
export function cacheStep(step) {
  const uses = /uses: actions\/cache(\/restore|\/save)?@/.exec(step);
  if (!uses) return null;
  const lines = step.split("\n");
  const at = lines.findIndex((l) => /^ {10}path:/.test(l));
  let p = "";
  if (at >= 0) {
    const inline = lines[at].replace(/^ {10}path:\s*/, "");
    if (inline && inline !== "|") p = inline;
    else for (let i = at + 1; i < lines.length && /^ {12}\S/.test(lines[i]); i++) p += `${p ? "\n" : ""}${lines[i].trim()}`;
  }
  return { uses: uses[1] ?? "", path: p, key: /^ {10}key: (.*)$/m.exec(step)?.[1] ?? "", lookup: /^ {10}lookup-only: true$/m.test(step) };
}

// the jobs ci.yml's nightly runs on main, whose caches it saves there itself (vault-sandbox-*, test-mutants, the alarm)
const NIGHTLY = (id) => /^vault-sandbox/.test(id) || id === "test-mutants" || id === "venue-table-alarm";
// a run line that runs a test: cargo test without --no-run, node --test, forge test, a pnpm or npm script, run.sh
const RUNS_A_TEST = (l) => (/\bcargo\b.*\btest\b/.test(l) && !/--no-run\b/.test(l)) || /node\s+--test|forge\s+test|\bpnpm\b|\bnpm\b|run\.sh/.test(l);

/** Why ci-cache.yml does not keep main's caches as ci.yml's push run did (empty = none). */
export function cacheProblems(ciYml, cacheYml) {
  const p = [];
  const t = triggers(cacheYml);
  if (!t) return ["ci-cache.yml has no `on:` block in the form this gate reads"];
  const keys = Object.keys(t).sort().join(",");
  if (keys !== "push,workflow_dispatch" || !/^\nbranches: \[main\]$/.test(t.push ?? "")) p.push(`ci-cache.yml runs on ${keys || "nothing"}${t.push !== undefined ? ` (push: ${t.push.trim() || "any branch"})` : ""}: it runs on a push to main and by hand alone, so it saves into main's scope and never stands in a pull request's or the queue's way`);
  if (/^name: ci$/m.test(cacheYml)) p.push("ci-cache.yml is named ci: a reader of ci.yml's runs could take it for one");
  const want = [];
  for (const [id, job] of Object.entries(jobs(ciYml))) {
    if (NIGHTLY(id)) continue;
    for (const s of steps(job)) {
      const c = cacheStep(s);
      if (c && c.uses !== "/restore") want.push({ id, ...c });
    }
  }
  const have = Object.values(jobs(cacheYml)).flatMap((j) => steps(j).map(cacheStep).filter((c) => c && c.uses === "/save"));
  for (const w of want) if (!have.some((h) => h.key === w.key && h.path === w.path)) p.push(`ci.yml's ${w.id} saves ${w.key} (${w.path}), and ci-cache.yml does not save it with that key and path: a pull request reads it cold until a run on main saves it`);
  // the test-vault job: rust-cache keys on the job id, so ci-cache.yml's job of that id has ci.yml's steps through its fetch
  const ciVault = steps(jobs(ciYml)["test-vault"] ?? "");
  const upTo = ciVault.findIndex((s) => /cargo \+\S+ fetch/.test(s));
  if (upTo < 0) p.push("ci.yml's test-vault has no registry fetch this gate reads");
  else if (steps(jobs(cacheYml)["test-vault"] ?? "").slice(0, upTo + 1).join("") !== ciVault.slice(0, upTo + 1).join("")) p.push("ci-cache.yml's test-vault job does not have ci.yml's test-vault steps through its fetch, as written: rust-cache keys on the job id, the toolchains and the env, so its save would be another key");
  for (const [id, job] of Object.entries(jobs(cacheYml))) {
    for (const line of job.split("\n")) if (!/^\s*#/.test(line) && RUNS_A_TEST(line)) p.push(`ci-cache.yml's ${id} runs a test (${line.trim()}): it saves caches, and a test there would be a second run read nowhere`);
    for (const s of steps(job)) {
      const c = cacheStep(s);
      if (c?.uses === "/save" && !/^(?: {6}- | {8})if: steps\.[\w-]+\.outputs\.cache-hit != 'true'(?: && steps\.[\w-]+\.outputs\.cache-hit != 'true')*$/m.test(s)) p.push(`ci-cache.yml's ${id} saves ${c.key} on every run, not only when main lacks it`);
    }
  }
  return p;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? path.join(ROOT, ".github/workflows/ci.yml");
  const cacheFile = process.argv[3] ?? path.join(ROOT, ".github/workflows/ci-cache.yml");
  const ci = readFileSync(file, "utf8");
  const p = [...triggerProblems(ci), ...cacheProblems(ci, readFileSync(cacheFile, "utf8"))];
  for (const l of p) console.log(`ci-runs-once: ${l}`);
  console.log(p.length ? `ci-runs-once: FAIL ${p.length} problems` : "ci-runs-once: PASS ci.yml runs once per merged commit (the queue's run), on pull requests, nightly and by hand; ci-cache.yml saves main's caches");
  process.exit(p.length ? 1 : 0);
}
