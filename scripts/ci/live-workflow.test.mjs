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
  assert.ok(has(liveProblems(LIVE.replace('node "scripts/live-checks/$KEY.mjs" $ARGS', "node scripts/live-checks/app-shell.mjs")), /does not run the check its matrix names/));
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

// a list file that prints `checks` with --live-runs, as the real ones do
const listFile = (checks) => `console.log(JSON.stringify({ checks: ${JSON.stringify(checks)}, runs: Object.fromEntries(${JSON.stringify(checks)}.map((k) => [k, ["scripts/live-checks/" + k + ".mjs"]])) }));\n`;

// a copy of the repository files the plan reads, to plant a failure in
function fixture(edit) {
  const root = mkdtempSync(path.join(tmpdir(), "live-plan-"));
  for (const f of ["scripts/ci/live-plan.mjs", "scripts/browsers.mjs", "scripts/ci/helper-live-checks.mjs"]) {
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

test("the signing page's forty-five checks (signpage-shell runs four ways, wallet-near-prepay-taken, pool-deposit-sent-end, solana-release-reads-paced, solana-written-accounts-whole, solana-legs-checked and hosts-main-on-top the newest) and every app check, with the network a testnet build names", async () => {
  const sign = await planFor("sign", { commit: COMMIT });
  assert.equal(new Set(sign.include.map((e) => e.key)).size, 45);
  assert.ok(sign.include.some((e) => e.key === "wallet-near-prepay-taken" && !e.chrome && e.args === ""), "wallet-near-prepay-taken runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "solana-release-reads-paced" && !e.chrome && e.args === ""), "solana-release-reads-paced runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "pool-deposit-sent-end" && !e.chrome && e.args === ""), "pool-deposit-sent-end runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "solana-written-accounts-whole" && !e.chrome && e.args === ""), "solana-written-accounts-whole runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "solana-legs-checked" && !e.chrome && e.args === ""), "solana-legs-checked runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "page-evm-rpc-csp" && !e.chrome && e.args === "--host sign"), "page-evm-rpc-csp reads SIGN_HOST alone after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "oneclick-fee-path-own-key" && !e.chrome && e.args === ""), "oneclick-fee-path-own-key runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "hosts-main-on-top" && !e.chrome && e.args === ""), "hosts-main-on-top (SIGN_HOST's DNS: no child, no wildcard) runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "signpage-withdraw-handoff" && !e.chrome && e.args === ""), "signpage-withdraw-handoff runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "wallet-deposit-follow" && !e.chrome && e.args === ""), "wallet-deposit-follow runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "kit-oneclick-pins-frozen" && !e.chrome && e.args === ""), "kit-oneclick-pins-frozen runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "pool-deposits" && !e.chrome && e.args === ""), "pool-deposits runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "pool-answer-unknown" && !e.chrome && e.args === ""), "pool-answer-unknown runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "kit-frame-version" && !e.chrome && e.args === ""), "kit-frame-version runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "kit-deposit-assets-dry" && e.chrome && e.args === ""), "kit-deposit-assets-dry runs after every sign deploy, in Chrome");
  assert.ok(sign.include.some((e) => e.key === "kit-deposit-calls" && !e.chrome && e.args === ""), "kit-deposit-calls runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "evm-pool-sync-wide-pages" && !e.chrome && e.args === ""), "evm-pool-sync-wide-pages runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "pool-restore-wired" && e.chrome && e.args === ""), "pool-restore-wired runs after every sign deploy, in Chrome");
  assert.ok(sign.include.some((e) => e.key === "pool-read-down" && !e.chrome && e.args === ""), "pool-read-down runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "sol-buy-rent-back" && !e.chrome && e.args === ""), "sol-buy-rent-back runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "pool-ready-no-flicker" && !e.chrome && e.args === ""), "pool-ready-no-flicker runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "signpage-pool-mainnet" && e.chrome && e.args === ""), "signpage-pool-mainnet runs after every sign deploy, in Chrome");
  assert.ok(sign.include.some((e) => e.key === "signpage-pool-pins" && !e.chrome && e.args === ""), "signpage-pool-pins runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "kit-renewal-read-bounded" && e.args === ""), "kit-renewal-read-bounded runs after every sign deploy");
  assert.deepEqual(sign.include.filter((e) => e.key === "signpage-shell").map((e) => e.args).sort(), ["--engine chromium --live --width desktop", "--engine chromium --live --width phone", "--engine firefox --live --width desktop", "--engine firefox --live --width phone"]);
  const app = await planFor("app", { commit: COMMIT });
  assert.equal(app.include.length, listOf("app", ROOT, { commit: COMMIT, network: "mainnet" }).checks.length, "each app check is one job");
  assert.equal(app.include.length, 34, "the app's thirty-four checks, app-deposit-mount, page-evm-rpc-csp and evm-sell-hook-intrablock the newest");
  assert.ok(app.include.some((e) => e.key === "app-deposit-mount" && e.chrome && e.args === ""), "app-deposit-mount runs on APP_HOST in Chrome");
  assert.ok(app.include.some((e) => e.key === "page-evm-rpc-csp" && !e.chrome && e.args === "--host app"), "page-evm-rpc-csp reads APP_HOST alone after every app deploy");
  assert.ok(app.include.some((e) => e.key === "rh-cold-quote" && e.args === ""), "rh-cold-quote runs after every app deploy");
  assert.ok(app.include.some((e) => e.key === "token-page-fills-after" && e.chrome && e.args === ""), "token-page-fills-after runs after every app deploy, in Chrome");
  assert.ok(app.include.some((e) => e.key === "app-chart-live"), "app-chart-live runs after every app deploy");
  assert.ok(app.include.some((e) => e.key === "evm-quote-warm-round" && e.args === ""), "evm-quote-warm-round runs after every app deploy");
  assert.ok(app.include.some((e) => e.key === "evm-sell-hook-intrablock" && !e.chrome && e.args === ""), "evm-sell-hook-intrablock runs after every app deploy");
  assert.ok(app.include.some((e) => e.key === "balances-per-chain" && e.chrome && e.args === ""), "balances-per-chain runs on APP_HOST in Chrome");
  assert.ok(app.include.some((e) => e.key === "app-export-every-wallet" && e.chrome && e.args === ""), "app-export-every-wallet runs on APP_HOST in Chrome");
  assert.ok(app.include.some((e) => e.key === "app-verify-mount" && e.args === "--network mainnet"));
  assert.ok((await planFor("app", { commit: COMMIT, network: "testnet" })).include.some((e) => e.args === "--network testnet"));
});

test("the helper's skipped checks are the ones the runner cannot run, with the reason the check itself gives", async () => {
  const { SKIPPED } = await import("./helper-live-checks.mjs");
  const proxy = await import("../live-checks/helper-proxy.mjs");
  const fee = await import("../live-checks/relayer-withdraw-fee.mjs");
  assert.equal(SKIPPED["helper-proxy"].reason, "needs-secret");
  assert.ok(proxy.ENV_KEYS.length > 0 && proxy.ENV_KEYS.every((k) => SKIPPED["helper-proxy"].detail.includes(k)), "it names every key the check reads");
  assert.equal(SKIPPED["relayer-withdraw-fee"].reason, "needs-relayer");
  assert.deepEqual(fee.RELEASE_RELAYER, { mainnet: null, testnet: null }, "the release names a relayer now: run the check, drop the skip");
  assert.deepEqual(Object.keys(SKIPPED).sort(), ["helper-proxy", "relayer-withdraw-fee"], "a new skip needs a reason this test checks");
  const plan = await planFor("helper", { commit: COMMIT });
  const na = [
    ...(existsSync(path.join(ROOT, "scripts/live-checks/pool-sol-deploy.mainnet.json")) ? [] : ["skipped-not-applicable: helper-pool-senders"]),
    ...(existsSync(path.join(ROOT, "contracts/vault/deployments/mainnet-v1.json")) ? [] : ["skipped-not-applicable: helper-bind-relayer-mainnet"]),
  ];
  assert.deepEqual(plan.skipped.map((s) => `skipped-${s.reason}: ${s.key}`).sort(), ["skipped-needs-relayer: relayer-withdraw-fee", "skipped-needs-secret: helper-proxy", ...na].sort());
  assert.ok(!plan.include.some((e) => keysOf(e).some((k) => SKIPPED[k])), "a skipped check is never in the matrix");
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
  assert.deepEqual(missingFor(pool, "--pool 2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr"), []);
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
    writeFileSync(path.join(r, "scripts/ci/helper-live-checks.mjs"), runsFile(["scripts/live-checks/helper-pool-senders.mjs --pool 2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr"]));
  });
  try {
    await assert.rejects(planFor("helper", { commit: COMMIT, root: bare }), /runs helper-pool-senders without --pool <value>, which its usage needs/);
    assert.ok(has(await planProblems("helper", bare), /helper: .*runs helper-pool-senders without --pool/));
    await assert.rejects(planFor("helper", { commit: COMMIT, root: noValue }), /without --pool <value>/);
    await assert.rejects(planFor("helper", { commit: COMMIT, root: noUsage }), /helper-rpc-proxy\.mjs has no usage line/);
    assert.deepEqual((await planFor("helper", { commit: COMMIT, root: good })).include.map((e) => e.args), ["--pool 2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr"]);
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
    rec("devnet", { cluster: "devnet", pool: "2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr" });
    assert.deepEqual(poolSenderPlan(root), { runs: ["scripts/live-checks/helper-pool-senders.mjs --pool 2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr"], notApplicable: "no Solana mainnet pool is deployed: scripts/live-checks/pool-sol-deploy.mainnet.json does not exist" });
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
  const devnet = real((r) => writeFileSync(path.join(r, "scripts/live-checks/pool-sol-deploy.devnet.json"), JSON.stringify({ cluster: "devnet", pool: "2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr" })));
  try {
    const a = await planFor("helper", { commit: COMMIT, root: none });
    assert.ok(!a.include.some((e) => e.key === "helper-pool-senders"), "no pool: no run, so nothing crashes on a missing --pool");
    assert.match(a.skipped.find((s) => s.key === "helper-pool-senders" && s.reason === "not-applicable")?.detail ?? "", /no Solana mainnet pool .* no Solana devnet pool/);
    const b = await planFor("helper", { commit: COMMIT, root: devnet });
    assert.deepEqual(b.include.filter((e) => e.key === "helper-pool-senders").map((e) => e.args), ["--pool 2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr"]);
    assert.deepEqual(b.skipped.filter((s) => s.key === "helper-pool-senders").map((s) => s.detail), ["no Solana mainnet pool is deployed: scripts/live-checks/pool-sol-deploy.mainnet.json does not exist"]);
    assert.deepEqual(b.skipped.map((s) => s.key).sort(), ["helper-bind-relayer-mainnet", "helper-pool-senders", "helper-proxy", "relayer-withdraw-fee"], "the whole skips stay skipped");
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
  assert.ok(has(liveProblems(LIVE.replace("        if: matrix.group != ''\n", "")), /does not run a serial group's checks with scripts\/ci\/live-serial\.mjs/), "no `if` on the group step: every job would run it");
  assert.ok(has(liveProblems(LIVE.replace("        if: matrix.group == ''\n", "")), /single-check step does not run `if: matrix\.group == ''`/), "no `if` on the single step: a group job would run no-key twice");
  assert.ok(has(liveProblems(LIVE.replace("node scripts/ci/live-serial.mjs $GROUP", "node scripts/live-checks/$GROUP.mjs")), /does not run a serial group's checks/), "a group run as one check");
  assert.ok(has(liveProblems(LIVE.replace("GROUP: ${{ matrix.group }}", "GROUP: ${{ matrix.key }}")), /does not run a serial group's checks/), "the group is not the matrix's");
  assert.ok(has(liveProblems(LIVE.replace("timeout-minutes: ${{ matrix.group != '' && 45 || 20 }}", "timeout-minutes: 20")), /a serial group's job has no longer limit/), "a group of about 11 minutes of checks cannot be held to 20");
});
