// The live run's last word (card live-run-red-means-the-build): every check job's verdict file, read together. Each job's
// runner (scripts/ci/live-rerun.mjs, scripts/ci/live-serial.mjs) writes one, `<id>.verdict.json`, with each check it ran:
// its key, its result (pass, fail, inconclusive, error, not_run) and why. A check that could not judge (its providers did
// not answer, no market event in its window) is inconclusive: its job passes with a notice, and this lists it by key with
// its reason on every run, so a check that never judges is seen, never hidden. The run is red when a check FAILED or
// erred, when one was not run, or when a planned job left no verdict (it ended before its runner wrote one: a crash, a
// cancel, a timeout); never for an inconclusive one alone.
//   node scripts/ci/live-verdicts.mjs --dir <folder of verdict files> --matrix <the plan's matrix JSON> [--summary <file>]
//   exit 0 when no check failed, erred or went unrun and every job left its verdict; 1 otherwise; 2 on bad arguments.
// Every line starts `live-verdicts: `, so a run's list reads from the CLI as
//   gh run view <run id> --log | grep 'live-verdicts: '
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KNOWN = new Set(["pass", "fail", "inconclusive", "error", "not_run"]);

/** The verdicts of `ids` (the plan's job ids) from `files` ({ <id>: text | undefined }): { lines, ok, counts }. */
export function judge(ids, files) {
  const results = [];
  const missing = [];
  for (const id of ids) {
    const text = files[id];
    if (text === undefined) {
      missing.push({ id, why: "it ended before its runner wrote one (a crash, a cancel or a timeout)" });
      continue;
    }
    let got;
    try {
      got = JSON.parse(text);
    } catch {
      missing.push({ id, why: "its verdict file is not JSON" });
      continue;
    }
    const list = Array.isArray(got?.results) ? got.results : null;
    if (!list || list.length === 0) {
      missing.push({ id, why: "its verdict file names no check" });
      continue;
    }
    for (const r of list) {
      const verdict = KNOWN.has(r?.verdict) ? r.verdict : "error";
      const why = typeof r?.reason === "string" && r.reason ? r.reason : verdict === "pass" ? "" : `no reason given (${String(r?.verdict)})`;
      results.push({ id, key: typeof r?.key === "string" && r.key ? r.key : id, verdict, reason: why.replace(/\s+/g, " ").slice(0, 400) });
    }
  }
  const of = (v) => results.filter((r) => r.verdict === v);
  const counts = { passed: of("pass").length, failed: of("fail").length, inconclusive: of("inconclusive").length, errors: of("error").length, notRun: of("not_run").length, noVerdict: missing.length };
  const ok = counts.failed === 0 && counts.errors === 0 && counts.notRun === 0 && counts.noVerdict === 0;
  const lines = [`${results.length} checks in ${ids.length} jobs: ${counts.passed} passed, ${counts.failed} failed, ${counts.inconclusive} inconclusive, ${counts.errors} errors, ${counts.notRun} not run${counts.noVerdict ? `, ${counts.noVerdict} jobs with no verdict` : ""}`];
  for (const r of of("inconclusive")) lines.push(`inconclusive ${r.key}: ${r.reason}`);
  for (const r of of("fail")) lines.push(`failed ${r.key}: ${r.reason}`);
  for (const r of of("error")) lines.push(`error ${r.key}: ${r.reason}`);
  for (const r of of("not_run")) lines.push(`not run ${r.key}: ${r.reason}`);
  for (const m of missing) lines.push(`no verdict from job ${m.id}: ${m.why}`);
  lines.push(ok ? `PASS: no check judged the build bad${counts.inconclusive ? ` (${counts.inconclusive} could not judge, listed above)` : ""}` : "FAIL: a check judged the build bad, erred or did not run (listed above)");
  return { ok, counts, lines: lines.map((l) => `live-verdicts: ${l}`) };
}

/** The job ids of the plan's matrix ({ include: [{ id }] }). */
export function idsOf(matrix) {
  const m = typeof matrix === "string" ? JSON.parse(matrix) : matrix;
  const ids = (m?.include ?? []).map((e) => e?.id);
  if (ids.length === 0 || ids.some((id) => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id))) throw new Error("the matrix names no job, or a job id that is not one");
  return ids;
}

/** The verdict files under `dir` by job id (`<id>.verdict.json`, at any depth). */
export function filesIn(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const m = e.isFile() && /^([a-z0-9][a-z0-9-]*)\.verdict\.json$/.exec(e.name);
    if (m) out[m[1]] = readFileSync(path.join(e.parentPath ?? e.path, e.name), "utf8");
  }
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  let ids;
  try {
    ids = idsOf(opt("--matrix") ?? "");
    if (!opt("--dir")) throw new Error("no --dir");
  } catch (e) {
    console.log(`live-verdicts: ERROR: ${e.message}`);
    process.exit(2);
  }
  const { ok, lines } = judge(ids, filesIn(opt("--dir")));
  for (const l of lines) console.log(l);
  const summary = opt("--summary");
  if (summary) appendFileSync(summary, `### live verdicts\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`);
  process.exit(ok ? 0 : 1);
}
