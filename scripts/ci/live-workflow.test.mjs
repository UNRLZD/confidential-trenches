// node --test scripts/ci/live-workflow.test.mjs: the shape of the live runs (scripts/ci/live-workflow.mjs) holds on the
// repository as it is, refuses each planted failure, and the plan (scripts/ci/live-plan.mjs) reads the deploys' own lists.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileProblems, liveProblems, planProblems, problems } from "./live-workflow.mjs";
import { HOSTS, ROOT, commitProblem, enginesFor, planFor, reachesLauncher } from "./live-plan.mjs";

const LIVE = readFileSync(path.join(ROOT, ".github/workflows/live.yml"), "utf8");
const CHROME = readFileSync(path.join(ROOT, ".github/actions/chrome/action.yml"), "utf8");
const COMMIT = "0123456789012345678901234567890123456789";
const has = (list, re) => list.some((l) => re.test(l));

test("the repository passes: every action pinned, no secret, every live run a check that exists", async () => {
  assert.deepEqual(await problems(), []);
});

test("live.yml and the action are clean on their own", () => {
  assert.deepEqual(fileProblems(".github/workflows/live.yml", LIVE), []);
  assert.deepEqual(fileProblems(".github/actions/chrome/action.yml", CHROME), []);
  assert.deepEqual(liveProblems(LIVE), []);
});

test("planted: an action pinned by a tag, a branch or a short sha is refused", () => {
  for (const ref of ["v4", "main", "3d3c42e"]) {
    const bad = LIVE.replace(/actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1/, `actions/checkout@${ref}`);
    assert.ok(has(fileProblems(".github/workflows/live.yml", bad), /checkout@.*is not pinned by a full commit sha/), ref);
  }
  assert.ok(has(fileProblems(".github/actions/chrome/action.yml", `${CHROME}\n    - uses: actions/cache@v6\n`), /not pinned/), "an action file's step");
});

test("planted: a step that reads a secret is refused, in a workflow and in an action", () => {
  const bad = LIVE.replace("ARGS: ${{ matrix.args }}", "ARGS: ${{ matrix.args }}\n          KEY2: ${{ secrets.ONECLICK_JWT }}");
  assert.ok(has(fileProblems(".github/workflows/live.yml", bad), /reads a secret/));
  assert.ok(has(fileProblems(".github/actions/chrome/action.yml", `${CHROME}\n# x\n    - run: echo \${{ secrets['X'] }}\n`), /reads a secret/));
  // the word in a comment is no read
  assert.deepEqual(fileProblems(".github/workflows/live.yml", `${LIVE}\n# reads no secrets\n`), []);
});

test("planted: a permissions block that widens, a job that widens, and none at the top are refused", () => {
  assert.ok(has(fileProblems(".github/workflows/live.yml", LIVE.replace("permissions:\n  contents: read", "permissions:\n  contents: write")), /not exactly contents: read/));
  assert.ok(has(fileProblems(".github/workflows/live.yml", LIVE.replace("  check:\n", "  check:\n    permissions:\n      contents: read\n      id-token: write\n")), /not exactly contents: read/));
  assert.ok(has(fileProblems(".github/workflows/live.yml", LIVE.replace("permissions:\n  contents: read\n", "")), /no top-level permissions block/));
  assert.ok(has(fileProblems(".github/workflows/live.yml", LIVE.replace("permissions:\n  contents: read", "permissions: write-all")), /not exactly contents: read/));
});

test("planted: a host input that drops a host, or no commit input, is refused", () => {
  assert.ok(has(liveProblems(LIVE.replace("options: [app, sign, helper]", "options: [app, sign]")), /host input's options/));
  assert.ok(has(liveProblems(LIVE.replace("options: [app, sign, helper]", "options: [app, sign, helper, other]")), /host input's options/));
  assert.ok(has(liveProblems(LIVE.replace("        required: true\n        type: string", "        required: false\n        type: string")), /no required commit input/));
  assert.ok(has(liveProblems(LIVE.replace("  workflow_dispatch:", "  workflow_call:")), /no workflow_dispatch/));
});

test("planted: a run that names a check that does not exist, an artifact step that skips a failed run, a verdict that skips one", () => {
  assert.ok(has(liveProblems(LIVE.replace("pnpm --filter signpage run test:e2e", "node scripts/live-checks/no-such-check.mjs")), /no-such-check, which is no file/));
  assert.ok(has(liveProblems(LIVE.replace("        if: always()\n        with:\n          name: live-", "        with:\n          name: live-")), /artifact step does not run `if: always\(\)`/));
  assert.ok(has(liveProblems(LIVE.replace("    if: always() && needs.plan.result != 'skipped'", "    if: needs.plan.result != 'skipped'")), /live job does not run `if: always\(\)`/));
  assert.ok(has(liveProblems(LIVE.replace('node "scripts/live-checks/$KEY.mjs" $ARGS', "node scripts/live-checks/app-shell.mjs")), /does not run the check its matrix names/));
  assert.ok(has(liveProblems(LIVE.replace("  browser-e2e:", "  other-e2e:")), /no browser-e2e job/));
});

test("planted: a step that installs Playwright's own Chromium is refused", () => {
  assert.ok(has(liveProblems(LIVE.replace("--with-deps $ENGINES", "--with-deps chromium firefox")), /installs Playwright's own Chromium/));
});

// a copy of the repository files the plan reads, to plant a failure in
function fixture(edit) {
  const root = mkdtempSync(path.join(tmpdir(), "live-plan-"));
  for (const f of ["scripts/ci/live-plan.mjs", "scripts/browsers.mjs", "scripts/ci/helper-live-checks.mjs"]) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    cpSync(path.join(ROOT, f), path.join(root, f));
  }
  mkdirSync(path.join(root, "scripts/live-checks"), { recursive: true });
  for (const k of ["helper-host-health", "helper-rpc-proxy", "market-data-evm"]) for (const e of [".mjs", ".test.mjs", ".answers.json"]) cpSync(path.join(ROOT, "scripts/live-checks", k + e), path.join(root, "scripts/live-checks", k + e));
  writeFileSync(path.join(root, "scripts/ci/helper-live-checks.mjs"), `export const LIVE_CHECKS = ["helper-host-health", "helper-rpc-proxy", "market-data-evm"]; export const SKIPPED = {}; export const liveRuns = (k) => ["scripts/live-checks/" + k + ".mjs"];\n`);
  edit(root);
  return root;
}

test("planted: a deploy that lists a check with no file, a check without its test, a check that reads the environment", async () => {
  const gone = fixture((r) => writeFileSync(path.join(r, "scripts/ci/helper-live-checks.mjs"), `export const LIVE_CHECKS = ["no-such-check"]; export const liveRuns = (k) => ["scripts/live-checks/" + k + ".mjs"];\n`));
  const noTest = fixture((r) => rmSync(path.join(r, "scripts/live-checks/helper-rpc-proxy.test.mjs")));
  const env = fixture((r) => writeFileSync(path.join(r, "scripts/live-checks/helper-rpc-proxy.mjs"), "const k = process.env.ONECLICK_JWT;\n"));
  try {
    assert.ok(has(await planProblems("helper", gone), /no-such-check, which is no file/));
    assert.ok(has(await planProblems("helper", noTest), /helper-rpc-proxy has no scripts\/live-checks\/helper-rpc-proxy\.test\.mjs/));
    assert.ok(has(await planProblems("helper", env), /helper-rpc-proxy reads the environment/));
    assert.deepEqual(await planProblems("helper", fixture(() => {})), []);
  } finally {
    for (const r of [gone, noTest, env]) rmSync(r, { recursive: true, force: true });
  }
});

test("the plan reads each deploy's own list: every check it prints runs, as its own job, or is listed skipped", async () => {
  const app = await import("../../apps/terminal/scripts/deploy.mjs");
  const sign = await import("../../packages/signpage/scripts/deploy.mjs");
  const helper = await import("../../scripts/ci/helper-live-checks.mjs");
  for (const [host, mod] of [["app", app], ["sign", sign], ["helper", helper]]) {
    const plan = await planFor(host, { commit: COMMIT });
    const skipped = Object.keys(mod.SKIPPED ?? {});
    assert.deepEqual([...new Set(plan.include.map((e) => e.key))].sort(), mod.LIVE_CHECKS.filter((k) => !skipped.includes(k)).sort(), host);
    assert.deepEqual(plan.skipped.map((s) => s.key).sort(), skipped.sort(), host);
    assert.deepEqual(plan.include.map((e) => `scripts/live-checks/${e.key}.mjs${e.args ? ` ${e.args}` : ""}`).sort(), mod.LIVE_CHECKS.filter((k) => !skipped.includes(k)).flatMap((k) => mod.liveRuns(k, { commit: COMMIT })).sort(), host);
    assert.equal(new Set(plan.include.map((e) => e.id)).size, plan.include.length, `${host}: ids are unique`);
  }
});

test("the signing page's ten checks (signpage-shell runs four ways) and every app check, with the network a testnet build names", async () => {
  const sign = await planFor("sign", { commit: COMMIT });
  assert.equal(new Set(sign.include.map((e) => e.key)).size, 10);
  assert.deepEqual(sign.include.filter((e) => e.key === "signpage-shell").map((e) => e.args).sort(), ["--engine chromium --live --width desktop", "--engine chromium --live --width phone", "--engine firefox --live --width desktop", "--engine firefox --live --width phone"]);
  const app = await planFor("app", { commit: COMMIT });
  assert.equal(app.include.length, (await import("../../apps/terminal/scripts/deploy.mjs")).LIVE_CHECKS.length, "each app check is one job");
  assert.ok(app.include.some((e) => e.key === "app-verify-mount" && e.args === "--network mainnet"));
  assert.ok((await planFor("app", { commit: COMMIT, network: "testnet" })).include.some((e) => e.args === "--network testnet"));
});

test("the helper's skipped checks are the ones the runner cannot run, with the reason the check itself gives", async () => {
  const { SKIPPED } = await import("../../scripts/ci/helper-live-checks.mjs");
  const proxy = await import("../live-checks/helper-proxy.mjs");
  const fee = await import("../live-checks/relayer-withdraw-fee.mjs");
  assert.equal(SKIPPED["helper-proxy"].reason, "needs-secret");
  assert.ok(proxy.ENV_KEYS.length > 0 && proxy.ENV_KEYS.every((k) => SKIPPED["helper-proxy"].detail.includes(k)), "it names every key the check reads");
  assert.equal(SKIPPED["relayer-withdraw-fee"].reason, "needs-relayer");
  assert.deepEqual(fee.RELEASE_RELAYER, { mainnet: null, testnet: null }, "the release names a relayer now: run the check, drop the skip");
  assert.deepEqual(Object.keys(SKIPPED).sort(), ["helper-proxy", "relayer-withdraw-fee"], "a new skip needs a reason this test checks");
  const plan = await planFor("helper", { commit: COMMIT });
  assert.deepEqual(plan.skipped.map((s) => `skipped-${s.reason}: ${s.key}`).sort(), ["skipped-needs-relayer: relayer-withdraw-fee", "skipped-needs-secret: helper-proxy"]);
  assert.ok(!plan.include.some((e) => SKIPPED[e.key]), "a skipped check is never in the matrix");
});

test("a job gets Chrome when its check reaches the launcher, and Firefox or WebKit only where its arguments name them", async () => {
  assert.equal(reachesLauncher(ROOT, "scripts/live-checks/signpage-shell.mjs"), true);
  assert.equal(reachesLauncher(ROOT, "scripts/live-checks/signpage-prover-threads.mjs"), true, "through signpage-prover-host's imports");
  assert.equal(reachesLauncher(ROOT, "scripts/live-checks/signpage-release.mjs"), false);
  assert.equal(reachesLauncher(ROOT, "scripts/live-checks/helper-host-health.mjs"), false);
  assert.deepEqual(enginesFor("--engine firefox --live --width phone"), ["firefox"]);
  assert.deepEqual(enginesFor("--engines chromium,firefox,webkit"), ["firefox", "webkit"]);
  assert.deepEqual(enginesFor("--browser webkit"), ["webkit"]);
  assert.deepEqual(enginesFor("--engine chromium --live"), []);
  assert.deepEqual(enginesFor(""), []);
  const sign = await planFor("sign", { commit: COMMIT });
  assert.ok(sign.include.filter((e) => e.chrome).length >= 6);
  assert.ok(sign.include.filter((e) => ["signpage-skeleton", "signpage-release", "signpage-withdraw-form", "app-harness-signin-e2e"].includes(e.key)).every((e) => !e.chrome));
});

test("a plan refuses a commit that is not 40 hex, an unknown host, a network that is neither, an argument a job would split wrongly", async () => {
  await assert.rejects(planFor("app", { commit: "abc123" }), /full 40-hex sha/);
  await assert.rejects(planFor("app", { commit: `${COMMIT}; id` }), /full 40-hex sha/);
  await assert.rejects(planFor("nowhere", { commit: COMMIT }), /host must be one of/);
  await assert.rejects(planFor("app", { commit: COMMIT, network: "regtest" }), /network must be/);
  assert.deepEqual(Object.keys(HOSTS), ["app", "sign", "helper"]);
});

test("the helper's commit is held to what it reports; a Pages host reports none", async () => {
  assert.equal(commitProblem("helper", COMMIT, COMMIT), null);
  assert.match(commitProblem("helper", COMMIT, "f".repeat(40)), /not \(yet\) the deploy/);
  assert.match(commitProblem("helper", COMMIT, null), /reports commit none/);
  assert.equal(commitProblem("sign", COMMIT, null), null);
  assert.equal(commitProblem("app", COMMIT, null), null);
});
