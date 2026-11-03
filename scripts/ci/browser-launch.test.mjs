// browser-launch.mjs and scripts/browsers.mjs: the real tree passes, every planted way to start a browser outside the
// launcher or to turn a sandbox off fails, and the launcher refuses the same options itself.
//   node --test --test-timeout=60000 scripts/ci/browser-launch.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { LAUNCHER, problems, trackedFiles } from "./browser-launch.mjs";
import { launchBrowser, launchDiskProfile } from "../browsers.mjs";

const file = (path, text) => ({ path, text });

test("this repository passes: no browser starts outside the launcher and no file turns a sandbox off", () => {
  const files = trackedFiles();
  assert.ok(files.some((f) => f.path === LAUNCHER), `${LAUNCHER} is tracked`);
  assert.ok(files.length > 100);
  assert.deepEqual(problems(files), []);
});

// each way a check could start, attach to or reach a browser without the launcher
const LAUNCHES = {
  "chromium.launch()": 'const browser = await chromium.launch();',
  "launch with options": 'const b = await pw.chromium.launch({ args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });',
  "a launch through a name": "const browser = await pw[engine].launch();",
  "a launch spread over two lines": "const browser = await chromium\n  .launch();",
  "firefox.launch": "await firefox.launch({ headless: false });",
  "a bracket launch": 'await chromium["launch"]({});',
  "launchPersistentContext": "const ctx = await chromium.launchPersistentContext(profile);",
  "a user's own profile": 'await chromium.launchPersistentContext("/Users/me/Library/Application Support/Google/Chrome");',
  "connectOverCDP": 'const b = await chromium.connectOverCDP("http://127.0.0.1:9222");',
  "launchServer": "const server = await chromium.launchServer();",
};

for (const [name, text] of Object.entries(LAUNCHES)) {
  test(`planted: ${name} outside the launcher fails, and the same line in the launcher passes`, () => {
    for (const p of ["apps/terminal/test/x/run.mjs", "scripts/live-checks/y.mjs", "packages/kit/test/z.test.ts", "scripts/browsers.test.mjs"]) {
      const found = problems([file(p, `// fine\n${text}\n`)]);
      assert.ok(found.length >= 1 && found.every((l) => l.startsWith(`${p}:`) && l.includes(`a browser starts only in ${LAUNCHER}`)), `${p}: ${found}`);
    }
    assert.deepEqual(problems([file(LAUNCHER, `${text}\n`)]), []);
  });
}

test("a problem names its file and its line", () => {
  assert.deepEqual(problems([file("a/b.mjs", "ok\nok\nawait chromium.launch();\n")]), [`a/b.mjs:3: a browser launch; a browser starts only in ${LAUNCHER}`]);
});

// each way to turn a sandbox off: refused in every tracked file, the launcher included
const SANDBOX_OFF = {
  "chromiumSandbox: false": "const options = { headless: true, chromiumSandbox: false };",
  "chromiumSandbox:false with no space": "{chromiumSandbox:false}",
  "chromiumSandbox : false": "chromiumSandbox : false,",
  "--no-sandbox in a launch arg": 'args: ["--no-sandbox"]',
  "--no-sandbox in a workflow": "        run: google-chrome --headless --no-sandbox --dump-dom about:blank",
  "--no-sandbox in a doc": "Run it with `--no-sandbox` if the sandbox fails.",
  "--disable-setuid-sandbox": 'args: ["--disable-setuid-sandbox"]',
  "ignoreDefaultArgs": "ignoreDefaultArgs: true",
  "ignoreDefaultArgs naming one flag": 'ignoreDefaultArgs: ["--enable-automation"]',
};

for (const [name, text] of Object.entries(SANDBOX_OFF)) {
  test(`planted: ${name} fails in a check, a workflow, a doc and the launcher`, () => {
    for (const p of ["apps/terminal/test/x/run.mjs", ".github/workflows/ci.yml", "docs/security.md", "package.json", LAUNCHER]) {
      const found = problems([file(p, `before\n${text}\n`)]);
      assert.equal(found.length, 1, `${p}: ${found}`);
      assert.ok(found[0].startsWith(`${p}:2: `));
    }
  });
}

test("the sandbox on, a similar word and the launcher's own calls pass", () => {
  for (const text of [
    "const b = await chromium.launchPersistentContext(dir, { chromiumSandbox: true });",
    "chromiumSandbox: true",
    "the chromiumSandbox option defaults to false in Playwright",
    "net.connect(sitePort, '127.0.0.1')",
    "const relaunched = relaunch(x); // no .launch call here: relaunch(",
    "const { launchBrowser } = await import('./browsers.mjs'); await launchBrowser('chromium');",
    "async function launch({ harness, site }) {}",
  ]) {
    const outside = problems([file("scripts/live-checks/ok.mjs", `${text}\n`)]);
    const bad = text.includes("launchPersistentContext(");
    assert.deepEqual(outside.map((l) => l.replace(/^[^:]+:\d+: /, "")), bad ? [`launchPersistentContext; a browser starts only in ${LAUNCHER}`] : [], text);
  }
  assert.deepEqual(problems([file(LAUNCHER, "await type.launchPersistentContext(dir, { chromiumSandbox: true });\n")]), []);
});

test("this gate and its test are the only files that may name the refused words", () => {
  const planted = "await chromium.launch({ chromiumSandbox: false, args: ['--no-sandbox'] });";
  assert.deepEqual(problems([file("scripts/ci/browser-launch.test.mjs", planted), file("scripts/ci/browser-launch.mjs", planted)]), []);
  assert.ok(problems([file("scripts/ci/another-gate.test.mjs", planted)]).length >= 3);
});

test("trackedFiles reads text files only", () => {
  const files = trackedFiles();
  assert.ok(files.every((f) => !f.text.includes("\0")));
  assert.ok(files.some((f) => f.path === "package.json"));
});

// ------------------------------------------------------------------------------------------------ the launcher
test("the launcher refuses every option that picks a build, a profile or a sandbox, before it starts anything", async () => {
  for (const options of [
    { channel: "chromium" },
    { channel: "chrome-beta" },
    { executablePath: "/tmp/chrome" },
    { chromiumSandbox: true },
    { chromiumSandbox: false },
    { ignoreDefaultArgs: true },
    { userDataDir: "/Users/me/Library/Application Support/Google/Chrome" },
    { env: { X: "1" } },
    { proxy: { server: "http://x" } },
  ]) {
    await assert.rejects(launchBrowser("chromium", options), /launch option \w+ is refused/, JSON.stringify(options));
    await assert.rejects(launchDiskProfile(options), /launch option \w+ is refused/, JSON.stringify(options));
    await assert.rejects(launchBrowser("firefox", options), /launch option \w+ is refused/, JSON.stringify(options));
  }
});

test("the launcher refuses an arg that turns a sandbox off, and an engine it does not know", async () => {
  for (const flag of ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu-sandbox", "--disable-seccomp-filter-sandbox", "--disable-namespace-sandbox"]) {
    await assert.rejects(launchBrowser("chromium", { args: ["--lang=en", flag] }), /weakens the sandbox/, flag);
    await assert.rejects(launchDiskProfile({ args: [flag] }), /weakens the sandbox/, flag);
  }
  await assert.rejects(launchBrowser("edge"), /engine edge is not one of/);
});
