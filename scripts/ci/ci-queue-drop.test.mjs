// Card ci-pr-light: a merge queue group GitHub drops stops its CI run. ci-queue-drop.yml runs on merge_group's
// destroyed event and takes the concurrency key ci.yml's run on that group holds, with cancel-in-progress, so GitHub
// cancels that run; a merged group's run is left alone, and a rebuilt group's new run is never touched. This reads
// both workflows' concurrency keys and evaluates them, as GitHub's expressions do, on the recorded groups of pull
// request #540 (fixtures/ci-queue-drop/events.json), then plants each way the wiring can break.
//   node --test scripts/ci/ci-queue-drop.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CI = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
const DROP = readFileSync(path.join(ROOT, ".github/workflows/ci-queue-drop.yml"), "utf8");
const EV = JSON.parse(readFileSync(path.join(ROOT, "scripts/ci/fixtures/ci-queue-drop/events.json"), "utf8"));

// the workflow-level concurrency block: { group, cancel }
function concurrency(yml) {
  const block = /^concurrency:\n((?: {2}.*\n)+)/m.exec(yml)?.[1] ?? "";
  return { group: /^ {2}group: (.*)$/m.exec(block)?.[1], cancel: /^ {2}cancel-in-progress: (.*)$/m.exec(block)?.[1] };
}

// One GitHub expression (the shapes these keys use: context paths, 'strings', ==, !=, &&, ||, !, format(), true,
// false): a missing property is null, && and || give an operand, as GitHub's do.
function expr(e, ctx) {
  const get = (p) => p.split(".").reduce((o, k) => (o == null ? null : o[k] ?? null), ctx);
  const fmt = (f, ...a) => f.replace(/\{(\d+)\}/g, (_, i) => String(a[i] ?? ""));
  const js = e
    .replace(/'((?:[^']|'')*)'|\b(github(?:\.[A-Za-z_][\w-]*)+)\b|\bformat\(|([!=])=/g, (m, s, p, op) =>
      s !== undefined ? JSON.stringify(s.replaceAll("''", "'")) : p ? `get(${JSON.stringify(p)})` : op ? `${op}==` : "fmt(");
  if (!/^(?:\s|"[^"]*"|get\("[^"]*"\)|fmt\(|true|false|===|!==|&&|\|\||!|\(|\)|,)*$/.test(js)) throw new Error(`an expression this test cannot read: ${e}`);
  return Function("get", "fmt", `return (${js});`)(get, fmt);
}

// a value with ${{ }} parts, as GitHub fills it (a bare true or false is YAML's boolean)
const fill = (v, ctx) => {
  if (v === "true" || v === "false") return v === "true";
  const whole = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(v);
  if (whole) return expr(whole[1], ctx);
  return v.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, e) => String(expr(e, ctx) ?? ""));
};

// the github context of a run: ci.yml on a group's checks_requested, ci-queue-drop.yml on its destroyed
const checks = (g) => ({ github: { event_name: "merge_group", ref: g.head_ref, run_id: 101, event: { action: "checks_requested", merge_group: g } } });
const destroyed = (g, reason) => ({ github: { event_name: "merge_group", ref: g.head_ref, run_id: 202, event: { action: "destroyed", reason, merge_group: g } } });

export function dropProblems(ci, drop) {
  const p = [];
  const c = concurrency(ci);
  const d = concurrency(drop);
  if (!c.group || !d.group) return ["a workflow has no top-level concurrency group"];
  if (!/^on:\n {2}merge_group:\n {4}types: \[destroyed\]\n(?=\S|\n)/m.test(drop)) p.push("ci-queue-drop.yml does not run on merge_group's destroyed event alone");
  if (!/^permissions: \{\}$/m.test(drop)) p.push("ci-queue-drop.yml's token has permissions");
  for (const [job, body] of drop.split(/^jobs:\n/m)[1]?.split(/^ {2}(?=[a-z])/m).filter(Boolean).map((b) => [b.split(":")[0], b]) ?? []) {
    if (!/^ {4}if: \$\{\{ false \}\}$/m.test(body)) p.push(`ci-queue-drop.yml's job ${job} can start, and take a runner`);
  }
  for (const reason of ["dequeued", "invalidated"]) {
    const ctx = destroyed(EV.group1, reason);
    if (fill(d.group, ctx) !== fill(c.group, checks(EV.group1))) p.push(`a group destroyed (${reason}) takes another key than its ci.yml run's`);
    if (fill(d.cancel, ctx) !== true) p.push(`a group destroyed (${reason}) does not cancel the run in progress`);
    if (fill(d.group, ctx) === fill(c.group, checks(EV.group2))) p.push(`a group destroyed (${reason}) takes the rebuilt group's key, cancelling its new run`);
  }
  if (fill(d.group, destroyed(EV.group1, "merged")) === fill(c.group, checks(EV.group1))) p.push("a merged group's destroyed event cancels its ci.yml run");
  // the other events keep their keys: a pull request's newer push cancels its older run, main's runs never
  const pr = { github: { event_name: "pull_request", ref: "refs/pull/540/merge", run_id: 1, event: {} } };
  const main = { github: { event_name: "push", ref: "refs/heads/main", run_id: 2, event: {} } };
  if (fill(c.group, pr) !== "ci-refs/pull/540/merge" || fill(c.cancel, pr) !== true) p.push("a pull request's run no longer cancels its older run");
  if (fill(c.group, main) !== "ci-refs/heads/main" || fill(c.cancel, main) !== false) p.push("a run on main can be cancelled");
  if (fill(c.cancel, checks(EV.group1)) !== false) p.push("a group's own checks_requested run cancels another");
  return p;
}

test("a dropped group's destroyed event takes its ci.yml run's key and cancels it; merged and rebuilt groups keep theirs", () => {
  assert.deepEqual(dropProblems(CI, DROP), []);
});

test("the recorded keys, as GitHub fills them", () => {
  const c = concurrency(CI);
  const d = concurrency(DROP);
  assert.equal(fill(c.group, checks(EV.group1)), `ci-${EV.group1.head_ref}`);
  assert.equal(fill(d.group, destroyed(EV.group1, "dequeued")), `ci-${EV.group1.head_ref}`);
  assert.equal(fill(d.group, destroyed(EV.group1, "merged")), "ci-queue-merged-202");
});

const PLANTED = {
  "the drop never cancels": [DROP, "  cancel-in-progress: true", "  cancel-in-progress: false", "does not cancel the run in progress"],
  "the drop keyed on the group's sha": [DROP, "github.event.merge_group.head_ref) }}", "github.event.merge_group.head_sha) }}", "takes another key than its ci.yml run's"],
  "a merged group's run cancelled too": [DROP, "${{ github.event.reason == 'merged' && format('ci-queue-merged-{0}', github.run_id) || format('ci-{0}', github.event.merge_group.head_ref) }}", "ci-${{ github.event.merge_group.head_ref }}", "a merged group's destroyed event cancels"],
  "the drop keyed on the pull request, so a rebuild cancels the new group": [DROP, "format('ci-{0}', github.event.merge_group.head_ref)", "format('ci-{0}', 'pr-540')", "takes another key"],
  "a drop job that starts": [DROP, "    if: ${{ false }}", "    if: ${{ true }}", "can start, and take a runner"],
  "the drop on every merge_group event": [DROP, "    types: [destroyed]", "    types: [checks_requested, destroyed]", "does not run on merge_group's destroyed event alone"],
  "a drop token with permissions": [DROP, "permissions: {}", "permissions:\n  actions: write", "token has permissions"],
  "ci.yml keyed on its run": [CI, "  group: ci-${{ github.event.merge_group.head_ref || github.ref }}", "  group: ci-${{ github.run_id }}", "takes another key than its ci.yml run's"],
  "ci.yml cancelling on every event": [CI, "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}", "  cancel-in-progress: true", "a run on main can be cancelled"],
};
for (const [name, [file, from, to, want]] of Object.entries(PLANTED)) {
  test(`planted: ${name} fails`, () => {
    const planted = file.replace(from, to);
    assert.notEqual(planted, file, `the plant for "${name}" matched nothing`);
    const found = file === CI ? dropProblems(planted, DROP) : dropProblems(CI, planted);
    assert.ok(found.some((f) => f.includes(want)), `want "${want}", found: ${JSON.stringify(found)}`);
  });
}
