// node --test scripts/ci/live-workflow.test.mjs: the shape of the live runs (scripts/ci/live-workflow.mjs) holds on the
// repository as it is, refuses each planted failure, and the plan (scripts/ci/live-plan.mjs) reads the deploys' own lists.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BUDGET_READS, SUMMARY_LINES, budgetProblems, fileProblems, liveProblems, planProblems, problems } from "./live-workflow.mjs";
import { HOSTS, ROOT, commitProblem, enginesFor, keysOf, listOf, missingFor, planFor, reachesLauncher, usagesOf } from "./live-plan.mjs";

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
  assert.ok(has(liveProblems(LIVE.replace('node .live-runner/scripts/ci/live-rerun.mjs --log "$out/$ID.log" "$KEY" $ARGS', "node scripts/live-checks/app-shell.mjs")), /single-check step is not the one the gate holds: it must run the check its matrix names/));
  assert.ok(has(liveProblems(LIVE.replace("  browser-e2e:", "  other-e2e:")), /no browser-e2e job/));
});

test("planted (card jupiter-build-budget-503): a summary grep that drops a verdict line, an INCONCLUSIVE one included, or no grep at all, is refused", () => {
  const grep = "grep -E '^(BAD|WARN)|PASS|FAIL|INCONCLUSIVE|ERROR|[Ee]rror' \"$log\"";
  assert.ok(LIVE.includes(grep), "live.yml's summary grep as the card left it");
  const without = liveProblems(LIVE.replace(grep, "grep -E '^(BAD|WARN)|PASS|FAIL|ERROR|[Ee]rror' \"$log\""));
  assert.deepEqual(without.filter((l) => /summary grep drops/.test(l)).map((l) => /drops the line "(.*)"$/.exec(l)[1]), SUMMARY_LINES.filter((l) => l.includes("INCONCLUSIVE")), "the verdict line and the line that says why");
  assert.ok(has(liveProblems(LIVE.replace(grep, "grep -E '^BAD' \"$log\"")), /summary grep drops the line "live-check k: PASS/));
  assert.ok(has(liveProblems(LIVE.replace(grep, "cat \"$log\"")), /summary has no grep -E/));
});

test("planted: a step that installs Playwright's own Chromium is refused", () => {
  assert.ok(has(liveProblems(LIVE.replace("--with-deps $ENGINES", "--with-deps chromium firefox")), /installs Playwright's own Chromium/));
});

// card live-inconclusive-rerun: the gate's own module, read at test time so a base without it fails these tests alone
const gate = () => import("./live-workflow.mjs");

test("live-inconclusive-rerun: both runners hold every rerun case, and live.yml runs a single check through live-rerun.mjs", async () => {
  const { rerunProblems, RERUN_CASES } = await gate();
  assert.deepEqual(await rerunProblems(), []);
  assert.ok(LIVE.includes('          node .live-runner/scripts/ci/live-rerun.mjs --log "$out/$ID.log" "$KEY" $ARGS\n'), "the single-check step");
  assert.deepEqual(RERUN_CASES.map((c) => c.codes.join(",")), ["0", "3,0", "3", "3,1", "1", "2"]);
});

test("planted (live-inconclusive-rerun): a single-check step that runs the check itself, read once, is refused", () => {
  const direct = LIVE.replace('node .live-runner/scripts/ci/live-rerun.mjs --log "$out/$ID.log" "$KEY" $ARGS', 'node "scripts/live-checks/$KEY.mjs" $ARGS 2>&1 | tee "$out/$ID.log"');
  assert.notEqual(direct, LIVE);
  assert.ok(has(liveProblems(direct), /single-check step is not the one the gate holds/));
});

// stand-in runners that each break one rule, on the single-check path; the group path is planted in live-serial.test.mjs
const STANDIN = (single) => ({ single, group: async (keys, o) => ({ ok: (await single(keys[0], o)).code === 0 }) });
const loop = (decide) => async (key, o) => {
  let code;
  for (let n = 1; ; n++) {
    const r = await o.run(key, []);
    code = typeof r === "number" ? r : r.code;
    const next = decide(code, n);
    if (next === "stop") return { code };
    if (next === "pass") return { code: 0 };
    await o.sleep(next);
  }
};

test("planted (live-inconclusive-rerun): exit 3 then exit 0 must pass: a runner that never reruns is refused", async () => {
  const { rerunProblems } = await gate();
  const p = await rerunProblems(STANDIN(loop(() => "stop")));
  assert.ok(has(p, /a single check\): exit 3 then exit 0 passes on the rerun: was red, want a pass/), p.join("\n"));
  assert.ok(has(p, /exit 3 throughout is red at the bound and names the providers: ran 1 times, want 3/));
});

test("planted (live-inconclusive-rerun): exit 3 throughout must stay red and name the providers", async () => {
  const { rerunProblems } = await gate();
  // passes once the bound is spent
  const lenient = await rerunProblems(STANDIN(loop((c, n) => (c !== 3 ? "stop" : n >= 3 ? "pass" : 30_000))));
  assert.ok(has(lenient, /exit 3 throughout is red at the bound and names the providers: passed, want red/), lenient.join("\n"));
  // red, but names no provider
  const mute = await rerunProblems(STANDIN(loop((c, n) => (c !== 3 || n >= 3 ? "stop" : 30_000))));
  assert.ok(has(mute, /does not name the providers that did not answer \(rpc-a\.example\.org, rpc-b\.example\.org\)/), mute.join("\n"));
  // no bound
  const endless = await rerunProblems(STANDIN(loop((c, n) => (c !== 3 || n > 8 ? "stop" : 30_000))));
  assert.ok(has(endless, /exit 3 throughout is red at the bound and names the providers: ran 9 times, want 3/), endless.join("\n"));
  // no pause, or a short one
  const eager = await rerunProblems(STANDIN(loop((c, n) => (c !== 3 || n >= 3 ? "stop" : 1000))));
  assert.ok(has(eager, /a pause of 1000 ms, under half the base/), eager.join("\n"));
});

test("planted (live-inconclusive-rerun): exit 1 and exit 2 must never run again", async () => {
  const { rerunProblems } = await gate();
  const p = await rerunProblems(STANDIN(loop((c, n) => (c === 0 || n >= 3 ? "stop" : 30_000))));
  assert.ok(has(p, /exit 1 \(FAIL\) is never run again: ran 3 times, want 1/), p.join("\n"));
  assert.ok(has(p, /exit 2 \(ERROR\) is never run again: ran 3 times, want 1/), p.join("\n"));
  assert.ok(has(p, /exit 3 then exit 1 is red and not run again: ran 3 times, want 2/), p.join("\n"));
});

test("planted (live-inconclusive-rerun): a bound or a pause out of reason is refused", async () => {
  const { rerunProblems } = await gate();
  const { RERUN } = await import("./live-rerun.mjs");
  assert.ok(has(await rerunProblems(undefined, { ...RERUN, runs: 1 }), /RERUN\.runs is 1, want 2 to 5/));
  assert.ok(has(await rerunProblems(undefined, { ...RERUN, runs: 50 }), /RERUN\.runs is 50, want 2 to 5/));
  assert.ok(has(await rerunProblems(undefined, { ...RERUN, baseMs: 1000 }), /is not 10 s or more/));
  assert.ok(has(await rerunProblems(undefined, { ...RERUN, capMs: 3_600_000 }), /capped at 5 min or less/));
});

// a list file that prints `checks` with --live-runs, as the real ones do
const listFile = (checks) => `console.log(JSON.stringify({ checks: ${JSON.stringify(checks)}, runs: Object.fromEntries(${JSON.stringify(checks)}.map((k) => [k, ["scripts/live-checks/" + k + ".mjs"]])) }));\n`;

// a copy of the repository files the plan reads, to plant a failure in
function fixture(edit) {
  const root = mkdtempSync(path.join(tmpdir(), "live-plan-"));
  for (const f of ["scripts/ci/live-plan.mjs", "scripts/ci/live-after.mjs", "scripts/browsers.mjs", "scripts/ci/helper-live-checks.mjs"]) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    cpSync(path.join(ROOT, f), path.join(root, f));
  }
  mkdirSync(path.join(root, "scripts/live-checks"), { recursive: true });
  for (const k of ["helper-host-health", "helper-rpc-proxy", "market-data-evm"]) for (const e of [".mjs", ".test.mjs", ".answers.json"]) cpSync(path.join(ROOT, "scripts/live-checks", k + e), path.join(root, "scripts/live-checks", k + e));
  writeFileSync(path.join(root, "scripts/ci/helper-live-checks.mjs"), listFile(["helper-host-health", "helper-rpc-proxy", "market-data-evm"]));
  edit(root);
  return root;
}

test("planted: a deploy that lists a check with no file, a check without its test, a check that reads the environment", async () => {
  const gone = fixture((r) => writeFileSync(path.join(r, "scripts/ci/helper-live-checks.mjs"), listFile(["no-such-check"])));
  const noTest = fixture((r) => rmSync(path.join(r, "scripts/live-checks/helper-rpc-proxy.test.mjs")));
  const env = fixture((r) => writeFileSync(path.join(r, "scripts/live-checks/helper-rpc-proxy.mjs"), "//   node scripts/live-checks/helper-rpc-proxy.mjs [--base <url>]\nconst k = process.env.ONECLICK_JWT;\n"));
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
  for (const host of Object.keys(HOSTS)) {
    const list = listOf(host, ROOT, { commit: COMMIT, network: "mainnet" });
    const plan = await planFor(host, { commit: COMMIT });
    const skipped = Object.keys(list.skipped);
    const ran = list.checks.filter((k) => !skipped.includes(k) && list.runs[k].length);
    assert.deepEqual([...new Set(plan.include.flatMap(keysOf))].sort(), ran.sort(), host);
    assert.deepEqual(list.checks.filter((k) => !ran.includes(k) && !skipped.includes(k)).filter((k) => !list.notApplicable[k]), [], `${host}: a check with no run says why`);
    assert.deepEqual(plan.skipped.map((s) => s.key).sort(), [...skipped, ...Object.keys(list.notApplicable)].sort(), host);
    assert.deepEqual(plan.include.flatMap((e) => keysOf(e).map((k) => `scripts/live-checks/${k}.mjs${e.args ? ` ${e.args}` : ""}`)).sort(), list.checks.filter((k) => !skipped.includes(k)).flatMap((k) => list.runs[k]).sort(), host);
    assert.equal(new Set(plan.include.map((e) => e.id)).size, plan.include.length, `${host}: ids are unique`);
  }
});

test("each host's jobs are its listed checks' runs, counted from its list, and the network a testnet build names", async () => {
  for (const host of Object.keys(HOSTS)) {
    const list = listOf(host, ROOT, { commit: COMMIT, network: "mainnet" });
    assert.ok(list.checks.length > 0, `${host} lists checks`);
    assert.equal(new Set(list.checks).size, list.checks.length, `${host} lists no check twice`);
  }
  const sign = await planFor("sign", { commit: COMMIT });
  const signList = listOf("sign", ROOT, { commit: COMMIT, network: "mainnet" });
  assert.equal(new Set(sign.include.map((e) => e.key)).size, signList.checks.length, "each listed sign check has a job");
  assert.equal(sign.include.length, signList.checks.flatMap((k) => signList.runs[k]).length, "one job for each run of each sign check");
  assert.deepEqual(sign.include.filter((e) => e.key === "signpage-shell").map((e) => e.args).sort(), ["--engine chromium --live --width desktop", "--engine chromium --live --width phone", "--engine firefox --live --width desktop", "--engine firefox --live --width phone"]);
  assert.ok(sign.include.some((e) => e.key === "page-evm-rpc-csp" && !e.chrome && e.args === "--host sign"), "page-evm-rpc-csp reads SIGN_HOST alone after every sign deploy");
  const app = await planFor("app", { commit: COMMIT });
  const appList = listOf("app", ROOT, { commit: COMMIT, network: "mainnet" });
  assert.equal(app.include.length, appList.checks.length, "each app check is one job");
  assert.equal(app.include.length, appList.checks.flatMap((k) => appList.runs[k]).length, "one job for each run of each app check");
  assert.ok(app.include.some((e) => e.key === "page-evm-rpc-csp" && !e.chrome && e.args === "--host app"), "page-evm-rpc-csp reads APP_HOST alone after every app deploy");
  assert.ok(app.include.some((e) => e.key === "app-verify-mount" && e.args === "--network mainnet"));
  assert.ok((await planFor("app", { commit: COMMIT, network: "testnet" })).include.some((e) => e.key === "app-verify-mount" && e.args === "--network testnet"));
});

test("the helper's skipped checks are the ones the runner cannot run, with the reason the check itself gives", async () => {
  const { SKIPPED } = await import("./helper-live-checks.mjs");
  const proxy = await import("../live-checks/helper-proxy.mjs");
  const fee = await import("../live-checks/relayer-withdraw-fee.mjs");
  assert.equal(SKIPPED["helper-proxy"].reason, "needs-secret");
  assert.ok(proxy.ENV_KEYS.length > 0 && proxy.ENV_KEYS.every((k) => SKIPPED["helper-proxy"].detail.includes(k)), "it names every key the check reads");
  // relayer-withdraw-fee ran skipped (needs-relayer) while the release named no withdrawal relayer; it reads relay.ts's
  // pairs now (card wallet-mainnet-relayer-pins), so it runs after every helper deploy, and a null pin FAILs it.
  assert.ok(fee.RELEASE_RELAYER.mainnet !== null && fee.RELEASE_RELAYER.testnet !== null, "the release names both withdrawal relayers: the check runs");
  assert.equal(SKIPPED["relayer-withdraw-fee"], undefined);
  assert.deepEqual(Object.keys(SKIPPED).sort(), ["helper-proxy"], "a new skip needs a reason this test checks");
  const plan = await planFor("helper", { commit: COMMIT });
  const na = [
    ...(existsSync(path.join(ROOT, "scripts/live-checks/pool-sol-deploy.mainnet.json")) ? [] : ["skipped-not-applicable: helper-pool-senders"]),
    ...(existsSync(path.join(ROOT, "contracts/vault/deployments/mainnet-v1.json")) ? [] : ["skipped-not-applicable: helper-bind-relayer-mainnet"]),
  ];
  assert.deepEqual(plan.skipped.map((s) => `skipped-${s.reason}: ${s.key}`).sort(), ["skipped-needs-secret: helper-proxy", ...na].sort());
  assert.ok(!plan.include.some((e) => keysOf(e).some((k) => SKIPPED[k])), "a skipped check is never in the matrix");
  assert.ok(plan.include.some((e) => keysOf(e).includes("relayer-withdraw-fee") && !e.chrome), "relayer-withdraw-fee runs on HELPER_HOST");
  for (const key of ["solana-jupiter-build", "wallet-per-buy", "helper-usdc-pending-pause"]) assert.ok(plan.include.some((e) => keysOf(e).includes(key) && !e.chrome), `${key} runs on HELPER_HOST (card live-checks-listed)`);
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
  assert.ok(sign.include.filter((e) => ["signpage-skeleton", "signpage-release", "signpage-withdraw-form", "signpage-withdraw-own-spend", "signpage-buy-own-spend", "signpage-sent-read-back", "signpage-error-after-timeout", "app-harness-signin-e2e"].includes(e.key)).every((e) => !e.chrome));
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

// card live-plan-args: every run gives what its check's usage needs, and helper-pool-senders gets its pool from the
// pools' deploy records (live.yml runs 41676189548 and 41685034036 exited 2 on a bare helper-pool-senders)

test("a check's usage line says the flags it needs: outside [...], with a value where one follows", () => {
  const text = (k, ...forms) => forms.map((f) => `//   node scripts/live-checks/${k}.mjs ${f}`).join("\n");
  assert.deepEqual(usagesOf(text("x", "--pool <address> [--base <url>] [--record <file>]"), "x"), [[{ flag: "--pool", value: true }]]);
  assert.deepEqual(usagesOf(text("x", "[--url <url>] [--record <file>]     PASS exit 0, FAIL exit 1"), "x"), [[]]);
  assert.deepEqual(usagesOf(text("x", "[--chain near --tx <hash> [--x <y>]] [--a <b>]"), "x"), [[]], "nested brackets are optional too");
  assert.deepEqual(usagesOf(text("x", "--engine webkit|chromium [--width phone]", "--engine chromium --live [--record <f>]"), "x"), [[{ flag: "--engine", value: true }], [{ flag: "--engine", value: true }, { flag: "--live", value: false }]]);
  assert.deepEqual(usagesOf(text("x", "--harness [--build <dir>] ...   the hosts' real names --not-a-flag"), "x"), [[{ flag: "--harness", value: false }]], "a line's note is not its usage");
  assert.deepEqual(usagesOf(text("x.sweep", "--network testnet"), "x"), [], "another check's usage is not this one's");
  const pool = [[{ flag: "--pool", value: true }]];
  assert.deepEqual(missingFor(pool, ""), [{ flag: "--pool", value: true }]);
  assert.deepEqual(missingFor(pool, "--pool"), [{ flag: "--pool", value: true }], "a flag without its value");
  assert.deepEqual(missingFor(pool, "--pool --base x"), [{ flag: "--pool", value: true }]);
  assert.deepEqual(missingFor(pool, "--pool 92YuYhb4Cj2UM3JxFAWB2kyHcdaPkWCnoNkoUAZZK2cr"), []);
  assert.deepEqual(missingFor([[{ flag: "--host", value: true }], [{ flag: "--release", value: true }]], "--release release-3"), [], "any one form met is enough");
  assert.deepEqual(missingFor([[]], ""), []);
});

test("the real lists pass: every run of every check, on both networks, gives what its usage needs", async () => {
  for (const host of Object.keys(HOSTS)) for (const network of ["mainnet", "testnet"]) {
    const plan = await planFor(host, { commit: COMMIT, network });
    for (const e of plan.include) {
      for (const k of keysOf(e)) {
        const forms = usagesOf(readFileSync(path.join(ROOT, "scripts/live-checks", `${k}.mjs`), "utf8"), k);
        assert.ok(forms.length, `${k} has a usage line`);
        assert.deepEqual(missingFor(forms, e.args), [], `${host} ${network} ${e.id}`);
      }
    }
  }
});

// a list that gives `runs` for one check, in a copy of the files the plan reads
const runsFile = (runs) => `console.log(JSON.stringify({ checks: ["helper-pool-senders"], runs: { "helper-pool-senders": ${JSON.stringify(runs)} } }));\n`;
const withPoolCheck = (r) => cpSync(path.join(ROOT, "scripts/live-checks/helper-pool-senders.mjs"), path.join(r, "scripts/live-checks/helper-pool-senders.mjs"));

test("planted: a check that needs --pool listed bare, or with --pool and no value, and a check with no usage line, fail the plan and the gate", async () => {
  const bare = fixture((r) => {
    withPoolCheck(r);
    writeFileSync(path.join(r, "scripts/ci/helper-live-checks.mjs"), runsFile(["scripts/live-checks/helper-pool-senders.mjs"]));
  });
  const noValue = fixture((r) => {
    withPoolCheck(r);
    writeFileSync(path.join(r, "scripts/ci/helper-live-checks.mjs"), runsFile(["scripts/live-checks/helper-pool-senders.mjs --pool --base https://x"]));
  });
  const noUsage = fixture((r) => writeFileSync(path.join(r, "scripts/live-checks/helper-rpc-proxy.mjs"), "console.log('PASS');\n"));
  const good = fixture((r) => {
    withPoolCheck(r);
    writeFileSync(path.join(r, "scripts/ci/helper-live-checks.mjs"), runsFile(["scripts/live-checks/helper-pool-senders.mjs --pool 92YuYhb4Cj2UM3JxFAWB2kyHcdaPkWCnoNkoUAZZK2cr"]));
  });
  try {
    await assert.rejects(planFor("helper", { commit: COMMIT, root: bare }), /runs helper-pool-senders without --pool <value>, which its usage needs/);
    assert.ok(has(await planProblems("helper", bare), /helper: .*runs helper-pool-senders without --pool/));
    await assert.rejects(planFor("helper", { commit: COMMIT, root: noValue }), /without --pool <value>/);
    await assert.rejects(planFor("helper", { commit: COMMIT, root: noUsage }), /helper-rpc-proxy\.mjs has no usage line/);
    assert.deepEqual((await planFor("helper", { commit: COMMIT, root: good })).include.map((e) => e.args), ["--pool 92YuYhb4Cj2UM3JxFAWB2kyHcdaPkWCnoNkoUAZZK2cr"]);
  } finally {
    for (const r of [bare, noValue, noUsage, good]) rmSync(r, { recursive: true, force: true });
  }
});

test("the helper's list gives helper-pool-senders the pool each cluster's deploy record names, read from the record's file", async () => {
  const { POOL_SOLANA_CLUSTERS, liveList, poolRecord, poolSenderPlan } = await import("./helper-live-checks.mjs");
  const env = /export const POOL_SOLANA_ENV = \{([^}]*)\}/.exec(readFileSync(path.join(ROOT, "apps/helper/src/pool/solana.ts"), "utf8"))?.[1];
  assert.ok(env, "apps/helper/src/pool/solana.ts has POOL_SOLANA_ENV");
  assert.deepEqual([...env.matchAll(/^\s*"?([a-z-]+)"?:/gm)].map((m) => m[1]), POOL_SOLANA_CLUSTERS, "one run for each cluster the helper may serve");
  // the repository: each record's pool, read here from the file, is the run's; a cluster with none is not applicable
  const list = liveList({ commit: COMMIT });
  for (const c of POOL_SOLANA_CLUSTERS) {
    const f = path.join(ROOT, poolRecord(c));
    if (existsSync(f)) assert.ok(list.runs["helper-pool-senders"].includes(`scripts/live-checks/helper-pool-senders.mjs --pool ${JSON.parse(readFileSync(f, "utf8")).pool}`), c);
    else assert.match(list.notApplicable["helper-pool-senders"], new RegExp(`no Solana ${c} pool is deployed: ${poolRecord(c).replace(/[.]/g, "\\.")} does not exist`));
  }
  // planted records under a copy of the repository
  const root = mkdtempSync(path.join(tmpdir(), "pool-records-"));
  const rec = (c, body) => {
    mkdirSync(path.join(root, "scripts/live-checks"), { recursive: true });
    writeFileSync(path.join(root, poolRecord(c)), typeof body === "string" ? body : JSON.stringify(body));
  };
  try {
    assert.deepEqual(poolSenderPlan(root), { runs: [], notApplicable: "no Solana mainnet pool is deployed: scripts/live-checks/pool-sol-deploy.mainnet.json does not exist; no Solana devnet pool is deployed: scripts/live-checks/pool-sol-deploy.devnet.json does not exist" });
    rec("devnet", { cluster: "devnet", pool: "92YuYhb4Cj2UM3JxFAWB2kyHcdaPkWCnoNkoUAZZK2cr" });
    assert.deepEqual(poolSenderPlan(root), { runs: ["scripts/live-checks/helper-pool-senders.mjs --pool 92YuYhb4Cj2UM3JxFAWB2kyHcdaPkWCnoNkoUAZZK2cr"], notApplicable: "no Solana mainnet pool is deployed: scripts/live-checks/pool-sol-deploy.mainnet.json does not exist" });
    rec("mainnet", { cluster: "mainnet", pool: "D7DSrQdqBZQEKxVXZpwVzdMrpyjfoZ8Vz13kGeMTKfef" });
    assert.deepEqual(poolSenderPlan(root).runs.length, 2);
    assert.equal(poolSenderPlan(root).notApplicable, null);
    rec("mainnet", { cluster: "devnet", pool: "D7DSrQdqBZQEKxVXZpwVzdMrpyjfoZ8Vz13kGeMTKfef" });
    assert.throws(() => poolSenderPlan(root), /pool-sol-deploy\.mainnet\.json names cluster devnet, not mainnet/);
    rec("mainnet", { cluster: "mainnet", pool: "not a pool" });
    assert.throws(() => poolSenderPlan(root), /names no pool address/);
    rec("mainnet", "{");
    assert.throws(() => poolSenderPlan(root), /is not JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the plan runs helper-pool-senders on each cluster with a record and lists the rest not applicable; with no record it runs nothing and says why", async () => {
  const { LIVE_CHECKS } = await import("./helper-live-checks.mjs");
  const real = (edit) =>
    fixture((r) => {
      cpSync(path.join(ROOT, "scripts/ci/helper-live-checks.mjs"), path.join(r, "scripts/ci/helper-live-checks.mjs"));
      cpSync(path.join(ROOT, "scripts/live-checks/pool-redeploys.mjs"), path.join(r, "scripts/live-checks/pool-redeploys.mjs"));
      for (const k of LIVE_CHECKS) cpSync(path.join(ROOT, "scripts/live-checks", `${k}.mjs`), path.join(r, "scripts/live-checks", `${k}.mjs`));
      edit(r);
    });
  const none = real(() => {});
  const devnet = real((r) => writeFileSync(path.join(r, "scripts/live-checks/pool-sol-deploy.devnet.json"), JSON.stringify({ cluster: "devnet", pool: "92YuYhb4Cj2UM3JxFAWB2kyHcdaPkWCnoNkoUAZZK2cr" })));
  try {
    const a = await planFor("helper", { commit: COMMIT, root: none });
    assert.ok(!a.include.some((e) => e.key === "helper-pool-senders"), "no pool: no run, so nothing crashes on a missing --pool");
    assert.match(a.skipped.find((s) => s.key === "helper-pool-senders" && s.reason === "not-applicable")?.detail ?? "", /no Solana mainnet pool .* no Solana devnet pool/);
    const b = await planFor("helper", { commit: COMMIT, root: devnet });
    assert.deepEqual(b.include.filter((e) => e.key === "helper-pool-senders").map((e) => e.args), ["--pool 92YuYhb4Cj2UM3JxFAWB2kyHcdaPkWCnoNkoUAZZK2cr"]);
    assert.deepEqual(b.skipped.filter((s) => s.key === "helper-pool-senders").map((s) => s.detail), ["no Solana mainnet pool is deployed: scripts/live-checks/pool-sol-deploy.mainnet.json does not exist"]);
    assert.deepEqual(b.skipped.map((s) => s.key).sort(), ["helper-bind-relayer-mainnet", "helper-pool-senders", "helper-proxy"], "the whole skips stay skipped");
  } finally {
    for (const r of [none, devnet]) rmSync(r, { recursive: true, force: true });
  }
});

// card helper-bind-relayer-mainnet: the mainnet deposit carry exists only once the mainnet vault's record does
// (deploy/bind-relayer-key.sh refuses before it), so its check runs on no deploy until then, never failing one
test("the plan runs helper-bind-relayer-mainnet once contracts/vault/deployments/mainnet-v1.json exists; before it, no run and the reason", async () => {
  const { LIVE_CHECKS, bindMainnetPlan } = await import("./helper-live-checks.mjs");
  const real = (edit) =>
    fixture((r) => {
      cpSync(path.join(ROOT, "scripts/ci/helper-live-checks.mjs"), path.join(r, "scripts/ci/helper-live-checks.mjs"));
      cpSync(path.join(ROOT, "scripts/live-checks/pool-redeploys.mjs"), path.join(r, "scripts/live-checks/pool-redeploys.mjs"));
      for (const k of LIVE_CHECKS) cpSync(path.join(ROOT, "scripts/live-checks", `${k}.mjs`), path.join(r, "scripts/live-checks", `${k}.mjs`));
      edit(r);
    });
  const before = real(() => {});
  const after = real((r) => {
    mkdirSync(path.join(r, "contracts/vault/deployments"), { recursive: true });
    writeFileSync(path.join(r, "contracts/vault/deployments/mainnet-v1.json"), JSON.stringify({ network: "mainnet", account_id: "vault.confidential.unrlzd.near" }));
  });
  try {
    const reason = "the mainnet vault is not deployed: contracts/vault/deployments/mainnet-v1.json does not exist";
    assert.deepEqual(bindMainnetPlan(before), { runs: [], notApplicable: reason });
    const a = await planFor("helper", { commit: COMMIT, root: before });
    assert.ok(!a.include.some((e) => keysOf(e).includes("helper-bind-relayer-mainnet")), "no mainnet vault: no run, so no deploy fails on it");
    assert.deepEqual(a.skipped.filter((s) => s.key === "helper-bind-relayer-mainnet"), [{ key: "helper-bind-relayer-mainnet", reason: "not-applicable", detail: reason }]);
    assert.deepEqual(bindMainnetPlan(after), { runs: ["scripts/live-checks/helper-bind-relayer-mainnet.mjs --commit {commit}"], notApplicable: null });
    const b = await planFor("helper", { commit: COMMIT, root: after });
    // review FIX 1: the health answer names no vault, so the check pins the deployed commit and reads that commit's pin
    assert.deepEqual(b.include.filter((e) => e.key === "helper-bind-relayer-mainnet").map((e) => e.args), [`--commit ${COMMIT}`], "one run, after every helper deploy, pinned to the deployed commit");
    assert.ok(!b.skipped.some((s) => s.key === "helper-bind-relayer-mainnet"));
  } finally {
    for (const r of [before, after]) rmSync(r, { recursive: true, force: true });
  }
});

test("planted: a plan job that also runs on a pull request is refused", () => {
  assert.deepEqual(liveProblems(LIVE).filter((l) => /plan job runs/.test(l)), []);
  assert.ok(has(liveProblems(LIVE.replace("    if: github.event_name == 'workflow_dispatch'\n", "    if: github.event_name == 'workflow_dispatch' || github.head_ref == 'card/x'\n")), /plan job runs on something other than a dispatch/));
});

test("helper-evm-sender-2 runs on the PrivacyPoolSimple each EVM network's deploy record names, read from where the deploy writes it; helper-pool-senders' own list stays Solana's", async () => {
  const { POOL_EVM_NETWORKS, evmPoolRecord, evmPools, poolSenderPlan } = await import("./helper-live-checks.mjs");
  // card helper-evm-sender-2: one run for each EVM network a pool deploys to, its record where the deploy writes it
  const deploy = await import("../live-checks/pool-evm-deploy.mjs");
  assert.deepEqual([...POOL_EVM_NETWORKS].sort(), [...Object.keys(deploy.CHAINS), ...Object.keys(deploy.MAINNETS)].sort(), "each network pool-evm-deploy.mjs deploys a pool to");
  // a testnet's newest pool set (card pool-evm-buy-pays-revert's), a mainnet's deploy record: pool-evm-deploy.mjs poolFile
  for (const n of POOL_EVM_NETWORKS) assert.equal(evmPoolRecord(n), path.relative(ROOT, deploy.poolFile(n)), n);
  for (const n of POOL_EVM_NETWORKS) {
    const f = path.join(ROOT, evmPoolRecord(n));
    assert.equal(evmPools()[n], existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).contracts.PrivacyPoolSimple.address.toLowerCase() : null, n);
  }
  // one owner: helper-pool-senders' plan names no EVM pool (the duplicate runs this card first added)
  assert.ok(!poolSenderPlan().runs.some((r) => /--pool 0x/.test(r)), "no EVM pool in helper-pool-senders' plan");
  const root = mkdtempSync(path.join(tmpdir(), "evm-pool-records-"));
  const evm = (n, body) => {
    mkdirSync(path.dirname(path.join(root, evmPoolRecord(n, root))), { recursive: true });
    writeFileSync(path.join(root, evmPoolRecord(n, root)), typeof body === "string" ? body : JSON.stringify(body));
  };
  try {
    assert.deepEqual(evmPools(root), Object.fromEntries(POOL_EVM_NETWORKS.map((n) => [n, null])));
    const B = "0xB239A38AF69B68E6C5C305DF64985F283B5D5FE5";
    for (const n of POOL_EVM_NETWORKS) evm(n, { chain: n, contracts: { PrivacyPoolSimple: { address: B } } });
    assert.deepEqual(evmPools(root), Object.fromEntries(POOL_EVM_NETWORKS.map((n) => [n, B.toLowerCase()])));
    evm("base", { chain: "base-sepolia", contracts: { PrivacyPoolSimple: { address: B } } });
    assert.throws(() => evmPools(root), /contracts\/pool-evm\/deployments\/base\.json names chain base-sepolia, not base/);
    evm("base", { chain: "base", contracts: { PrivacyPool: { address: B } } });
    assert.throws(() => evmPools(root), /deployments\/base\.json names no PrivacyPoolSimple address/);
    evm("base", { chain: "base", contracts: { PrivacyPoolSimple: { address: "0x1234" } } });
    assert.throws(() => evmPools(root), /names no PrivacyPoolSimple address/);
    evm("base", { chain: "base", contracts: { PrivacyPoolSimple: { address: B } } });
    evm("robinhood-testnet", "{");
    assert.throws(() => evmPools(root), /pool-evm-deploy\.robinhood-testnet\.json is not JSON/);
    // a pool set redeployed by a later card (pool-redeploys.mjs POOL_REDEPLOYS) is the testnet's pool, over the first set's
    evm("robinhood-testnet", { chain: "robinhood-testnet", contracts: { PrivacyPoolSimple: { address: B } } });
    const R = "0x00000000000000000000000000000000000000aa";
    writeFileSync(path.join(root, "scripts/live-checks/pool-evm-buy-pays-revert.robinhood-testnet.json"), JSON.stringify({ chain: "robinhood-testnet", contracts: { PrivacyPoolSimple: { address: R } } }));
    assert.equal(evmPoolRecord("robinhood-testnet", root), "scripts/live-checks/pool-evm-buy-pays-revert.robinhood-testnet.json");
    assert.equal(evmPools(root)["robinhood-testnet"], R);
    assert.equal(evmPools(root)["base-sepolia"], B.toLowerCase());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- card helper-live-jup-serial: the checks that spend the helper's Jupiter budget run one after another in one job ----

const BUDGET_KEYS = ["helper-token-page-cold", "market-data-solana-token", "helper-page-jup-429", "solana-legs-share-wait", "solana-mint-supply-moves", "solana-jupiter-build"];

test("the helper's plan runs the six checks that spend the Jupiter budget as ONE matrix entry, in order, and every other check as its own", async () => {
  const plan = await planFor("helper", { commit: COMMIT });
  const groups = plan.include.filter((e) => e.group !== "");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, "jupiter-budget");
  assert.equal(groups[0].key, "");
  assert.equal(groups[0].args, "");
  assert.deepEqual(keysOf(groups[0]), BUDGET_KEYS);
  assert.equal(groups[0].chrome, false);
  assert.match(groups[0].name, /^jupiter-budget \(6 checks, one after another\)$/);
  for (const k of BUDGET_KEYS) assert.ok(!plan.include.some((e) => e.group === "" && e.key === k), `${k} has no job of its own`);
  assert.ok(plan.include.every((e) => typeof e.group === "string"), "every entry says its group, '' for none, so the workflow's if reads one value");
  assert.ok(plan.include.some((e) => e.key === "app-console-429" && e.group === ""), "app-console-429 reads a listed token's page, no Jupiter call: its own job");
  // the other hosts have no group
  for (const host of ["app", "sign"]) assert.ok((await planFor(host, { commit: COMMIT })).include.every((e) => e.group === ""), host);
});

test("the real helper plan has no budget check outside the group, and every check that reads a Jupiter route is found by BUDGET_READS", async () => {
  const plan = await planFor("helper", { commit: COMMIT });
  assert.deepEqual(budgetProblems("helper", plan), []);
  const list = listOf("helper", ROOT, { commit: COMMIT, network: "mainnet" });
  const found = list.checks.filter((k) => !list.skipped[k] && BUDGET_READS.test(readFileSync(path.join(ROOT, "scripts/live-checks", `${k}.mjs`), "utf8"))).sort();
  assert.deepEqual(found, [...BUDGET_KEYS, ...Object.keys(list.budgetExempt)].sort(), "the group and the exempt are exactly the checks that name a Jupiter route");
  assert.deepEqual(Object.keys(list.budgetExempt), ["app-console-429"]);
});

// a list with a serial group and an exempt list, for the fixtures below
const budgetList = (checks, { serial = {}, budgetExempt = {} } = {}) =>
  `console.log(JSON.stringify({ checks: ${JSON.stringify(checks)}, serial: ${JSON.stringify(serial)}, budgetExempt: ${JSON.stringify(budgetExempt)}, runs: Object.fromEntries(${JSON.stringify(checks)}.map((k) => [k, ["scripts/live-checks/" + k + ".mjs"]])) }));\n`;

// a root whose helper list is `list`, with two checks that name the helper's Jupiter proxy and one that does not
function budgetFixture(list) {
  return fixture((r) => {
    for (const k of ["jup-a", "jup-b", "calm"]) {
      const text = k === "calm" ? "" : `const r = await fetch("/v1/proxy/jupiter/swap/v2/build");\n`;
      writeFileSync(path.join(r, `scripts/live-checks/${k}.mjs`), `//   node scripts/live-checks/${k}.mjs [--base <url>]\n${text}`);
      writeFileSync(path.join(r, `scripts/live-checks/${k}.test.mjs`), "");
      writeFileSync(path.join(r, `scripts/live-checks/${k}.answers.json`), "{}");
    }
    writeFileSync(path.join(r, "scripts/ci/helper-live-checks.mjs"), list);
  });
}

test("planted: two checks that spend the Jupiter budget in separate jobs are refused; in one serial group they pass", async () => {
  const apart = budgetFixture(budgetList(["jup-a", "jup-b", "calm"]));
  const together = budgetFixture(budgetList(["jup-a", "jup-b", "calm"], { serial: { "jupiter-budget": ["jup-a", "jup-b"] } }));
  try {
    const bad = await planProblems("helper", apart);
    assert.ok(has(bad, /jup-a reads the helper's Jupiter budget .* in a job of its own/), bad.join("\n"));
    assert.ok(has(bad, /jup-b reads the helper's Jupiter budget .* in a job of its own/), bad.join("\n"));
    assert.ok(!has(bad, /calm reads/), "a check that names no Jupiter route is no budget check");
    assert.equal((await planFor("helper", { commit: COMMIT, root: apart })).include.length, 3, "apart, three jobs: the plan itself would run them in parallel");
    assert.deepEqual(await planProblems("helper", together), []);
    const one = await planFor("helper", { commit: COMMIT, root: together });
    assert.deepEqual(one.include.map((e) => [e.id, e.group]), [["jupiter-budget", "jup-a jup-b"], ["calm", ""]], "the two are ONE entry");
  } finally {
    for (const r of [apart, together]) rmSync(r, { recursive: true, force: true });
  }
});

test("planted: one budget check left out of the group is refused by name, and the exempt list is no way round it", async () => {
  const roots = [];
  const root = (opts) => {
    const r = budgetFixture(budgetList(["jup-a", "jup-b", "calm"], opts));
    roots.push(r);
    return r;
  };
  try {
    const left = await planProblems("helper", root({ serial: { "jupiter-budget": ["jup-a", "calm"] } }));
    assert.ok(has(left, /jup-b reads the helper's Jupiter budget/) && !has(left, /jup-a reads/), left.join("\n"));
    const reason = "it opens a listed token's page, which makes no Jupiter call";
    assert.deepEqual(await planProblems("helper", root({ serial: { "jupiter-budget": ["jup-a", "calm"] }, budgetExempt: { "jup-b": reason } })), [], "an exempt check with its reason");
    assert.ok(has(await planProblems("helper", root({ serial: { "jupiter-budget": ["jup-a", "calm"] }, budgetExempt: { "jup-b": "short" } })), /jup-b is exempt from the Jupiter budget group with no reason/));
    assert.ok(has(await planProblems("helper", root({ serial: { "jupiter-budget": ["jup-a", "jup-b"] }, budgetExempt: { "jup-b": reason } })), /jup-b is both in a serial group and exempt from it/));
    assert.ok(has(await planProblems("helper", root({ serial: { "jupiter-budget": ["jup-a", "jup-b"] }, budgetExempt: { "no-such": reason } })), /no-such is exempt from the Jupiter budget group but is no listed check/));
  } finally {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  }
});

test("planted: a serial group the job cannot run fails the plan: one member, an unlisted or skipped one, a repeat, two groups, a name that is a check, arguments", async () => {
  const roots = [];
  const plan = async (opts, list = ["jup-a", "jup-b", "calm"]) => {
    const r = budgetFixture(budgetList(list, opts));
    roots.push(r);
    return planFor("helper", { commit: COMMIT, root: r });
  };
  try {
    await assert.rejects(plan({ serial: { g: ["jup-a"] } }), /serial group g: needs two or more different checks/);
    await assert.rejects(plan({ serial: { g: ["jup-a", "jup-a"] } }), /needs two or more different checks/);
    await assert.rejects(plan({ serial: { g: ["jup-a", "no-such"] } }), /no-such is not a listed check/);
    await assert.rejects(plan({ serial: { g: ["jup-a", "jup-b"], h: ["jup-b", "calm"] } }), /jup-b is in two serial groups, g and h/);
    await assert.rejects(plan({ serial: { calm: ["jup-a", "jup-b"] } }), /the id is no name a job can take, or is a check's key/);
    await assert.rejects(plan({ serial: { "Bad Name": ["jup-a", "jup-b"] } }), /the id is no name a job can take/);
    // a member runs once and with no arguments: the entry carries keys alone
    const runsOf = (a, b) => `console.log(JSON.stringify({ checks: ["jup-a", "jup-b"], serial: { g: ["jup-a", "jup-b"] }, runs: { "jup-a": ${JSON.stringify(a)}, "jup-b": ${JSON.stringify(b)} } }));\n`;
    const bare = (k) => `scripts/live-checks/${k}.mjs`;
    for (const [list, want] of [
      [runsOf([`${bare("jup-a")} --base https://x.example`], [bare("jup-b")]), /jup-a runs with arguments/],
      [runsOf([bare("jup-a"), `${bare("jup-a")} --base https://x.example`], [bare("jup-b")]), /jup-a has 2 runs/],
    ]) {
      const r = budgetFixture(list);
      roots.push(r);
      await assert.rejects(planFor("helper", { commit: COMMIT, root: r }), want);
    }
  } finally {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  }
});

test("planted: live.yml that runs a serial group's checks as one single check, drops the group step, or lets both steps run, is refused", () => {
  assert.deepEqual(liveProblems(LIVE), []);
  assert.ok(has(liveProblems(LIVE.replace("        if: matrix.group != ''\n", "")), /serial step is not the one the gate holds: it must run a serial group's checks/), "no `if` on the group step: every job would run it");
  assert.ok(has(liveProblems(LIVE.replace("        if: matrix.group == ''\n", "")), /single-check step is not the one the gate holds: .* on `if: matrix\.group == ''`/), "no `if` on the single step: a group job would run no-key twice");
  assert.ok(has(liveProblems(LIVE.replace('node .live-runner/scripts/ci/live-serial.mjs --log "$out/$ID.log" $GROUP', "node scripts/live-checks/$GROUP.mjs")), /serial step is not the one the gate holds/), "a group run as one check");
  assert.ok(has(liveProblems(LIVE.replace("GROUP: ${{ matrix.group }}", "GROUP: ${{ matrix.key }}")), /serial step is not the one the gate holds/), "the group is not the matrix's");
  assert.ok(has(liveProblems(LIVE.replace("timeout-minutes: ${{ matrix.group != '' && 45 || 20 }}", "timeout-minutes: 20")), /a serial group's job has no longer limit/), "a group of about 11 minutes of checks cannot be held to 20");
});

test("planted (card live-runs-one-per-host): a live.yml whose dispatched runs do not share one queue per host is refused: no concurrency block, a group that names the commit or the run, a group shared by every host, cancel-in-progress true", () => {
  const conc = /^concurrency:\n(?: {2}.*\n)+/m;
  assert.ok(conc.test(LIVE), "live.yml has a top-level concurrency block");
  const at = (block) => liveProblems(LIVE.replace(conc, block));
  assert.ok(has(at(""), /no top-level concurrency/), "missing");
  const group = (g) => at(`concurrency:\n  group: ${g}\n  cancel-in-progress: \${{ github.event_name == 'pull_request' }}\n`);
  assert.ok(has(group("live-${{ github.workflow }}-${{ github.ref }}-${{ inputs.host }}-${{ inputs.commit }}"), /concurrency group/), "main's group before this card: one run per commit, so two runs on one host read it at once");
  assert.ok(has(group("live-${{ inputs.host }}-${{ github.run_id }}"), /concurrency group/), "a group per run");
  assert.ok(has(group("live"), /concurrency group/), "one group for every host");
  assert.deepEqual(group("live-${{ inputs.host || github.ref }}"), []);
  const cancel = (c) => at(`concurrency:\n  group: live-\${{ inputs.host || github.ref }}\n  cancel-in-progress: ${c}\n`);
  assert.ok(has(cancel("true"), /cancel-in-progress/), "a second run cancels the first");
  assert.ok(has(cancel("${{ github.event_name == 'workflow_dispatch' }}"), /cancel-in-progress/), "true on a dispatch");
  assert.deepEqual(cancel("false"), []);
});

// review of 9eaf059a, P2-1: wiring that turns a red check job green. Each planted edit is refused.
const RUN_LINE = 'node .live-runner/scripts/ci/live-rerun.mjs --log "$out/$ID.log" "$KEY" $ARGS';
const SERIAL_LINE = 'node .live-runner/scripts/ci/live-serial.mjs --log "$out/$ID.log" $GROUP';
const plant = (from, to) => {
  const out = LIVE.replace(from, to);
  assert.notEqual(out, LIVE, `the plant's anchor is in live.yml: ${from}`);
  return liveProblems(out);
};

test("planted (review P2-1): six ways to turn a red check job green are each refused", () => {
  const single = /single-check step is not the one the gate holds/;
  assert.ok(has(plant(RUN_LINE, `${RUN_LINE} 2>&1 | tee "$out/$ID.log" || true`), single), "| tee … || true");
  assert.ok(has(plant(RUN_LINE, `${RUN_LINE}; exit 0`), single), "; exit 0");
  assert.ok(has(plant(RUN_LINE, `${RUN_LINE.replace(' --log "$out/$ID.log"', "")} 2>&1 | tee "$out/$ID.log"`), single), "a tee with no pipefail");
  assert.ok(has(plant(`          ${RUN_LINE}`, `          node "scripts/live-checks/$KEY.mjs" $ARGS || true; exit 0\n          ${RUN_LINE}`), single), "a direct run before the runner");
  assert.ok(has(plant(SERIAL_LINE, `${SERIAL_LINE} || true`), /serial step is not the one the gate holds/), "|| true on the serial line");
  assert.ok(has(plant("  check:\n    needs: plan\n", "  check:\n    needs: plan\n    continue-on-error: true\n"), /continue-on-error/), "continue-on-error on the check job");
  assert.ok(has(plant(`        run: |\n          out="$RUNNER_TEMP/live"\n          mkdir -p "$out"\n          export TMPDIR="$out"\n          # shellcheck disable=SC2086\n          ${RUN_LINE}`, `        continue-on-error: true\n        run: |\n          out="$RUNNER_TEMP/live"\n          mkdir -p "$out"\n          export TMPDIR="$out"\n          # shellcheck disable=SC2086\n          ${RUN_LINE}`), /continue-on-error/), "continue-on-error on the step");
  assert.ok(has(plant("permissions:\n  contents: read\n", "permissions:\n  contents: read\n\ndefaults:\n  run:\n    shell: \"sh -c 'sh {0}; exit 0'\"\n"), /a shell or defaults key/), "a shell template that swallows the exit");
  assert.ok(has(plant(`        run: |\n          out="$RUNNER_TEMP/live"`, `        shell: bash {0}\n        run: |\n          out="$RUNNER_TEMP/live"`), /a shell or defaults key/), "a step shell with no -e");
  assert.ok(has(plant('if [ "$CHECKS" != success ]; then echo "a check job ended $CHECKS"; exit 1; fi', 'echo "a check job ended $CHECKS"'), /live job does not fail when a check job did not succeed/), "the verdict that stops reading the check jobs");
  assert.ok(has(plant("      - uses: actions/upload-artifact@", '      - run: node "scripts/live-checks/$KEY.mjs" $ARGS || true\n      - uses: actions/upload-artifact@'), /runs a live check outside the two runner steps/), "a check run in a step of its own");
});

// review of 9eaf059a, P2-2: the runner comes from the workflow's own commit; only the check comes from the deployed one
test("planted (review P2-2): a runner taken from the deployed commit, or a runner checkout that lacks a file, is refused", async () => {
  const { RUNNER_FILES } = await gate();
  assert.deepEqual(RUNNER_FILES, ["scripts/ci/jup-idle.mjs", "scripts/ci/live-rerun.mjs", "scripts/ci/live-serial.mjs", "scripts/live-checks/helper-token-page-cold.mjs", "scripts/net-window.mjs"]);
  const checkout = /runner checkout is not the one the gate holds/;
  assert.ok(has(plant(RUN_LINE, RUN_LINE.replace(".live-runner/", "")), /single-check step is not the one the gate holds/), "the deployed commit's runner");
  assert.ok(has(plant(SERIAL_LINE, SERIAL_LINE.replace(".live-runner/", "")), /serial step is not the one the gate holds/), "the deployed commit's serial runner");
  assert.ok(has(plant("          ref: ${{ github.workflow_sha }}\n", "          ref: ${{ inputs.commit }}\n"), checkout), "the runner checked out at the deployed commit");
  assert.ok(has(plant("            scripts/ci/jup-idle.mjs\n", ""), checkout), "a file the runners import left out");
  assert.ok(has(plant("          path: .live-runner\n", "          path: runner\n"), checkout), "another folder");
  assert.ok(has(plant("          sparse-checkout-cone-mode: false\n", ""), checkout), "cone mode, which reads the patterns as folders");
});

// delta re-check of 9b2c8b10, P3-a/b/c: the runner folder is written by the held checkout alone, and nothing reaches
// into node or the job's environment to set a check's exit
test("planted (re-check P3-a, P3-b): a second checkout into .live-runner, or any other line naming it, is refused", () => {
  const named = /names \.live-runner outside the held runner checkout and runner lines/;
  const second = "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          ref: ${{ inputs.commit }}\n          path: .live-runner\n          persist-credentials: false\n";
  assert.ok(has(plant("      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0\n      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: 24\n      - run: pnpm install --frozen-lockfile\n      - name: Google Chrome", `${second}      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0\n      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: 24\n      - run: pnpm install --frozen-lockfile\n      - name: Google Chrome`), named), "a second checkout over the runners");
  assert.ok(has(plant("      - name: Google Chrome stable, and its sandbox comes up\n        if: matrix.chrome", "      - run: printf 'process.exit(0)' > .live-runner/scripts/ci/live-rerun.mjs\n      - name: Google Chrome stable, and its sandbox comes up\n        if: matrix.chrome"), named), "a step that writes a runner");
  assert.ok(has(plant(`          ${RUN_LINE}`, `          ${RUN_LINE}`.replace("node .live-runner", "node ./.live-runner")), named), "the runner line spelled another way");
});

test("planted (re-check P3-c): NODE_OPTIONS, or a write to GITHUB_ENV or GITHUB_PATH, is refused", () => {
  const env = /NODE_OPTIONS, GITHUB_ENV or GITHUB_PATH/;
  assert.ok(has(plant("          KEY: ${{ matrix.key }}\n", "          KEY: ${{ matrix.key }}\n          NODE_OPTIONS: --import ./pass.mjs\n"), env), "NODE_OPTIONS on the step");
  assert.ok(has(plant("  check:\n    needs: plan\n", "  check:\n    needs: plan\n    env:\n      NODE_OPTIONS: --require ./pass.cjs\n"), env), "NODE_OPTIONS on the job");
  assert.ok(has(plant("      - name: Google Chrome stable, and its sandbox comes up\n        if: matrix.chrome", "      - run: echo \"NODE_OPTIONS=--import ./pass.mjs\" >> \"$GITHUB_ENV\"\n      - name: Google Chrome stable, and its sandbox comes up\n        if: matrix.chrome"), env), "a GITHUB_ENV write");
  assert.ok(has(plant("      - name: Google Chrome stable, and its sandbox comes up\n        if: matrix.chrome", "      - run: echo \"$PWD/fake-node\" >> $GITHUB_PATH\n      - name: Google Chrome stable, and its sandbox comes up\n        if: matrix.chrome"), env), "a GITHUB_PATH write, a node of its own first");
});
