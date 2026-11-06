// node --test scripts/ci/live-workflow.test.mjs: the shape of the live runs (scripts/ci/live-workflow.mjs) holds on the
// repository as it is, refuses each planted failure, and the plan (scripts/ci/live-plan.mjs) reads the deploys' own lists.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileProblems, liveProblems, planProblems, problems } from "./live-workflow.mjs";
import { HOSTS, ROOT, commitProblem, enginesFor, listOf, missingFor, planFor, reachesLauncher, usagesOf } from "./live-plan.mjs";

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
    assert.deepEqual([...new Set(plan.include.map((e) => e.key))].sort(), ran.sort(), host);
    assert.deepEqual(list.checks.filter((k) => !ran.includes(k) && !skipped.includes(k)).filter((k) => !list.notApplicable[k]), [], `${host}: a check with no run says why`);
    assert.deepEqual(plan.skipped.map((s) => s.key).sort(), [...skipped, ...Object.keys(list.notApplicable)].sort(), host);
    assert.deepEqual(plan.include.map((e) => `scripts/live-checks/${e.key}.mjs${e.args ? ` ${e.args}` : ""}`).sort(), list.checks.filter((k) => !skipped.includes(k)).flatMap((k) => list.runs[k]).sort(), host);
    assert.equal(new Set(plan.include.map((e) => e.id)).size, plan.include.length, `${host}: ids are unique`);
  }
});

test("the signing page's twenty-seven checks (signpage-shell runs four ways, pool-read-down the newest) and every app check, with the network a testnet build names", async () => {
  const sign = await planFor("sign", { commit: COMMIT });
  assert.equal(new Set(sign.include.map((e) => e.key)).size, 27);
  assert.ok(sign.include.some((e) => e.key === "pool-read-down" && !e.chrome && e.args === ""), "pool-read-down runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "sol-buy-rent-back" && !e.chrome && e.args === ""), "sol-buy-rent-back runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "pool-ready-no-flicker" && !e.chrome && e.args === ""), "pool-ready-no-flicker runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "signpage-pool-mainnet" && e.chrome && e.args === ""), "signpage-pool-mainnet runs after every sign deploy, in Chrome");
  assert.ok(sign.include.some((e) => e.key === "signpage-pool-pins" && !e.chrome && e.args === ""), "signpage-pool-pins runs after every sign deploy");
  assert.ok(sign.include.some((e) => e.key === "kit-renewal-read-bounded" && e.args === ""), "kit-renewal-read-bounded runs after every sign deploy");
  assert.deepEqual(sign.include.filter((e) => e.key === "signpage-shell").map((e) => e.args).sort(), ["--engine chromium --live --width desktop", "--engine chromium --live --width phone", "--engine firefox --live --width desktop", "--engine firefox --live --width phone"]);
  const app = await planFor("app", { commit: COMMIT });
  assert.equal(app.include.length, listOf("app", ROOT, { commit: COMMIT, network: "mainnet" }).checks.length, "each app check is one job");
  assert.equal(app.include.length, 30, "the app's thirty checks, rh-cold-quote the newest");
  assert.ok(app.include.some((e) => e.key === "rh-cold-quote" && e.args === ""), "rh-cold-quote runs after every app deploy");
  assert.ok(app.include.some((e) => e.key === "app-chart-live"), "app-chart-live runs after every app deploy");
  assert.ok(app.include.some((e) => e.key === "evm-quote-warm-round" && e.args === ""), "evm-quote-warm-round runs after every app deploy");
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
  const na = existsSync(path.join(ROOT, "scripts/live-checks/pool-sol-deploy.mainnet.json")) ? [] : ["skipped-not-applicable: helper-pool-senders"];
  assert.deepEqual(plan.skipped.map((s) => `skipped-${s.reason}: ${s.key}`).sort(), ["skipped-needs-relayer: relayer-withdraw-fee", "skipped-needs-secret: helper-proxy", ...na].sort());
  assert.ok(!plan.include.some((e) => SKIPPED[e.key]), "a skipped check is never in the matrix");
  for (const key of ["solana-jupiter-build", "wallet-per-buy"]) assert.ok(plan.include.some((e) => e.key === key && !e.chrome), `${key} runs on HELPER_HOST (card live-checks-listed)`);
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
      const forms = usagesOf(readFileSync(path.join(ROOT, "scripts/live-checks", `${e.key}.mjs`), "utf8"), e.key);
      assert.ok(forms.length, `${e.key} has a usage line`);
      assert.deepEqual(missingFor(forms, e.args), [], `${host} ${network} ${e.id}`);
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
    assert.deepEqual(b.skipped.map((s) => s.key).sort(), ["helper-pool-senders", "helper-proxy", "relayer-withdraw-fee"], "the whole skips stay skipped");
  } finally {
    for (const r of [none, devnet]) rmSync(r, { recursive: true, force: true });
  }
});

test("planted: a plan job that also runs on a pull request is refused", () => {
  assert.deepEqual(liveProblems(LIVE).filter((l) => /plan job runs/.test(l)), []);
  assert.ok(has(liveProblems(LIVE.replace("    if: github.event_name == 'workflow_dispatch'\n", "    if: github.event_name == 'workflow_dispatch' || github.head_ref == 'card/x'\n")), /plan job runs on something other than a dispatch/));
});
