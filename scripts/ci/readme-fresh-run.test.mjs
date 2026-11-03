// readme-fresh-run.mjs: the README's AI-agent steps run on a clean machine. The judging is exact on pnpm's output
// lines, and each planted failure (a failing step, a failing summary, a package with no summary, a step over the time
// limit, a connection off this machine) fails the run, next to its passing twin.
//   node --test scripts/ci/readme-fresh-run.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agentSteps } from "./readme-commands.mjs";
import { cleanEnv, problems, substitute, summaries } from "./readme-fresh-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const RUNNER = path.join(HERE, "readme-fresh-run.mjs");

test("the real README names a clone, an install and a test run, as the AI-agent steps", () => {
  const steps = agentSteps(readFileSync(path.join(ROOT, "README.md"), "utf8"));
  assert.match(steps[0], /^git clone https:\/\/github\.com\/\S+$/);
  assert.ok(steps.some((s) => /^pnpm install\b/.test(s)));
  assert.ok(steps.some((s) => /^pnpm -r .*\brun test$/.test(s)));
});

test("the steps are read from the README, and a README without them is refused", () => {
  const md = (body) => `# R\n\n### For AI agents and scripts\n\nText.\n\n${body}\n\n### Next\n`;
  assert.deepEqual(agentSteps(md("```sh\ngit clone https://x/y\n\n# a comment\ncd y\n```")), ["git clone https://x/y", "cd y"]);
  assert.throws(() => agentSteps("# R\n\n## Other\n```sh\nls\n```\n"), /no "For AI agents and scripts" heading/);
  assert.throws(() => agentSteps(md("No block here.")), /no fenced block/);
  assert.throws(() => agentSteps(md("```sh\n```")), /holds no command/);
});

test("a clone of the README's URL becomes a clone of the commit under test", () => {
  assert.equal(substitute("git clone https://github.com/UNRLZD/confidential-trenches", "/w/checkout"), 'git clone -q "/w/checkout" "confidential-trenches"');
  assert.equal(substitute("git clone https://x/y.git here", "/w/checkout"), 'git clone -q "/w/checkout" "here"');
  assert.equal(substitute("pnpm install --frozen-lockfile", "/w/checkout"), "pnpm install --frozen-lockfile");
});

test("the machine has no key and no Rust", () => {
  const has = (f) => f === "/home/r/.cargo/bin/cargo";
  const env = cleanEnv({ PATH: "/usr/bin:/home/r/.cargo/bin:/bin", HOME: "/home/r", ONECLICK_API_KEY: "k", GITHUB_TOKEN: "t", JUP_JWT: "j", RELAYER_PASSWORD: "p", NODE_ENV: "x" }, has);
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "NODE_ENV", "PATH"]);
});

test("pnpm's prefixed summary lines are read, and a skipped test is not a failure", () => {
  const out = [
    "packages/kit test: ℹ tests 40",
    "packages/kit test: ℹ fail 0",
    "packages/kit test: ℹ skipped 1",
    "apps/helper test: ℹ fail 0",
    "apps/helper test: ℹ fail 0",
    "ℹ fail 0",
  ].join("\n");
  assert.deepEqual(summaries(out), [
    { pkg: "packages/kit", fail: 0 },
    { pkg: "apps/helper", fail: 0 },
    { pkg: "apps/helper", fail: 0 },
    { pkg: null, fail: 0 },
  ]);
});

const GOOD = { failedStep: null, output: "packages/a test: ℹ fail 0\napps/b test: ℹ fail 0\n", expected: ["packages/a", "apps/b"], seconds: 300, maxSeconds: 900 };
test("a run with a summary of fail 0 for every package with tests, in time, passes", () => {
  assert.deepEqual(problems(GOOD), []);
});

test("each planted failure fails the run", () => {
  assert.match(problems({ ...GOOD, failedStep: "pnpm install --frozen-lockfile (exit 1)" })[0], /step failed: pnpm install/);
  assert.match(problems({ ...GOOD, output: "packages/a test: ℹ fail 0\napps/b test: ℹ fail 2\n" })[0], /apps\/b: 2 failing/);
  assert.match(problems({ ...GOOD, output: "packages/a test: ℹ fail 0\n" })[0], /apps\/b: no test summary/);
  assert.match(problems({ ...GOOD, output: "all good\n" }).join("\n"), /no test summary/);
  assert.match(problems({ ...GOOD, seconds: 901 })[0], /wall time 15m01s is over the 15m00s limit/);
  assert.match(problems({ ...GOOD, output: GOOD.output + "ℹ fail 1\n" })[0], /a test run: 1 failing/);
});

// ---- the runner itself, on a README of its own and a throwaway git checkout
function fixture(steps) {
  const dir = mkdtempSync(path.join(tmpdir(), "readme-fresh-run-test-"));
  const repo = path.join(dir, "checkout");
  mkdirSync(repo);
  writeFileSync(path.join(repo, "marker.txt"), "x");
  const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "marker.txt");
  git("commit", "-q", "-m", "Card x: y");
  writeFileSync(path.join(dir, "README.md"), `# R\n\n### For AI agents and scripts\n\n\`\`\`sh\n${steps.join("\n")}\n\`\`\`\n`);
  return { dir, repo, readme: path.join(dir, "README.md") };
}
const runner = (f, ...extra) =>
  spawnSync("node", [RUNNER, "--readme", f.readme, "--checkout", f.repo, "--workdir", path.join(f.dir, "w"), ...extra], {
    encoding: "utf8",
    env: { ...process.env, ONECLICK_API_KEY: "must-not-reach-a-step" },
  });
const SAY = (line) => `printf '%s\\n' '${line}'`;
const withFixture = (steps, body) => {
  const f = fixture(steps);
  try {
    body(f);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
};

test("the runner clones the checkout, follows cd, and passes a run whose summaries read fail 0", () => {
  withFixture(["git clone https://github.com/x/fixture", "cd fixture", "test -f marker.txt", SAY("packages/a test: ℹ fail 0")], (f) => {
    const r = runner(f);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /readme-fresh-run: PASS/);
    assert.match(r.stdout, /wall time \d+m\d\ds \(limit 15m00s\)/);
  });
});

test("a failing README step fails the run and stops it there", () => {
  withFixture([SAY("before"), 'node -e "process.exit(3)"', SAY("after ℹ fail 0")], (f) => {
    const r = runner(f);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL step failed: node -e "process.exit\(3\)" \(exit 3\)/);
    assert.doesNotMatch(r.stdout, /^after/m);
  });
});

test("a summary with a failure fails the run", () => {
  withFixture([SAY("ℹ fail 2")], (f) => {
    const r = runner(f);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL a test run: 2 failing/);
  });
});

test("a step past the time limit is killed and fails the run", () => {
  withFixture(["sleep 20"], (f) => {
    const t0 = Date.now();
    const r = runner(f, "--max-minutes", "0.02");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /killed at the time limit/);
    assert.ok(Date.now() - t0 < 15_000, "the step was not killed");
  });
});

test("a step other than the clone and the install cannot reach a host off this machine", () => {
  withFixture(["node -e \"fetch('http://192.0.2.1/').catch((e) => { console.log(e.cause.message); process.exit(1); })\""], (f) => {
    const r = runner(f);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /no-network: a connection to 192\.0\.2\.1 was refused/);
  });
});

test("a step sees no key from the machine's environment", () => {
  withFixture([`node -e "if (process.env.ONECLICK_API_KEY) process.exit(7); console.log('ℹ fail 0')"`], (f) => {
    assert.equal(runner(f).status, 0);
  });
});

const FIXTURES = path.join(HERE, "fixtures/readme-fresh-run");
test("the committed planted READMEs fail the run: a failing step, and a vendor host the no-network preload refuses", () => {
  const run = (name) => spawnSync("node", [RUNNER, "--readme", path.join(FIXTURES, name), "--checkout", ROOT, "--workdir", mkdtempSync(path.join(tmpdir(), "rfr-planted-"))], { encoding: "utf8" });
  const failing = run("failing-step.md");
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /FAIL step failed: false \(exit 1\)/);
  assert.doesNotMatch(failing.stdout, /never reached/);
  const vendor = run("vendor-fetch.md");
  assert.equal(vendor.status, 1);
  assert.match(vendor.stdout, /no-network: a connection to api\.jup\.ag was refused/);
});
