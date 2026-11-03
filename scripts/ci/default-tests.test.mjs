// default-tests.mjs: a package's default test script reaches no browser, no Rust build and no key. The repository passes
// and the scan reaches the files that matter; each planted case (a launch in a test, in a module it imports at the top
// level, a playwright import, cargo in the script or in a spawn, a key read with no default) fails, next to its twin that
// passes (a comment, a function a test never calls, a default, an env opt-in skip, PASSKEY_SRC).
//   node --test scripts/ci/default-tests.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, guarded, problems, stripComments } from "./default-tests.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("this repository's default test scripts reach no browser, no Rust build and no key, and the scan reaches the tests", () => {
  const r = check(ROOT);
  assert.deepEqual(r.problems, []);
  for (const f of [
    "packages/kit/test/prove-e2e.test.ts", // guarded by KIT_PROVER_E2E, so its launch is no hit
    "apps/terminal/test/harness/hosts.test.mjs",
    "apps/helper/deploy/image-layout.test.mjs",
    "packages/signpage/scripts/deploy.mjs", // imported by a test; it imports live checks that define browser launches
    "packages/wallet/test/passkey.test.ts",
  ]) assert.ok(r.files.includes(f), `the scan did not reach ${f}`);
  assert.ok(r.files.length > 200, `only ${r.files.length} files read`);
});

// a workspace of one package, `a`, whose test script and files the case sets
function tree(script, files) {
  const dir = mkdtempSync(path.join(tmpdir(), "default-tests-"));
  const put = (f, s) => {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), s);
  };
  put("package.json", JSON.stringify({ name: "root", private: true }));
  put("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  put("packages/a/package.json", JSON.stringify({ name: "a", scripts: { test: script, other: "node --test other.test.mjs" } }));
  for (const [f, s] of Object.entries(files)) put(path.join("packages/a", f), s);
  return dir;
}
const run = (script, files) => {
  const dir = tree(script, files);
  try {
    return problems(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const TEST = 'import { test } from "node:test";\n';
const GUARD = '{ skip: process.env.RUN_BROWSER === "1" ? false : "RUN_BROWSER=1 runs it" }';

test("a browser launch in a default test fails; the same launch behind an env opt-in skip, or in a comment, does not", () => {
  const launch = (opts) => `${TEST}test("x", ${opts}async () => { const b = await launchBrowser("chromium"); });\n`;
  assert.match(run("node --test t.test.mjs", { "t.test.mjs": launch("") })[0], /^packages\/a test: packages\/a\/t\.test\.mjs:2: a browser launch: launchBrowser$/);
  assert.deepEqual(run("node --test t.test.mjs", { "t.test.mjs": launch(`${GUARD}, `) }), []);
  assert.deepEqual(run("node --test t.test.mjs", { "t.test.mjs": launch("{ skip: process.env.RUN_BROWSER !== '1' }, ") }), []);
  assert.deepEqual(run("node --test t.test.mjs", { "t.test.mjs": launch("{ skip: !process.env.RUN_BROWSER }, ") }), []);
  // an opt-out is no opt-in
  assert.equal(run("node --test t.test.mjs", { "t.test.mjs": launch("{ skip: process.env.CI }, ") }).length, 1);
  assert.deepEqual(run("node --test t.test.mjs", { "t.test.mjs": `${TEST}// await launchBrowser("chromium")\n/* launchDiskProfile() */\ntest("x", () => {});\n` }), []);
});

test("the opt-in covers its own test only", () => {
  const two = `${TEST}test("a", ${GUARD}, async () => { await launchBrowser("chromium"); });\ntest("b", async () => { await launchBrowser("chromium"); });\n`;
  const found = run("node --test t.test.mjs", { "t.test.mjs": two });
  assert.equal(found.length, 1);
  assert.match(found[0], /t\.test\.mjs:3:/);
});

test("playwright in a default test fails", () => {
  assert.equal(run("node --test t.test.mjs", { "t.test.mjs": `${TEST}import { chromium } from "playwright";\ntest("x", () => {});\n` }).length, 1);
  assert.equal(run('node --test t.test.mjs && node -e "require(\'playwright\')"', { "t.test.mjs": `${TEST}test("x", () => {});\n` }).length, 1);
});

test("a Rust build tool in the script, or in a test, fails", () => {
  assert.match(run("cargo test", {})[0], /^packages\/a test script: a Rust build tool: cargo$/);
  assert.match(run("node --test t.test.mjs && cargo +1.96.0 test --locked", { "t.test.mjs": TEST })[0], /script: a Rust build tool/);
  assert.match(run("node --test t.test.mjs", { "t.test.mjs": `${TEST}import { spawnSync } from "node:child_process";\ntest("x", () => { spawnSync("cargo-near", ["near", "build"]); });\n` })[0], /t\.test\.mjs:3: a Rust build tool: cargo-near/);
  assert.match(run("node --test t.test.mjs", { "t.test.mjs": `${TEST}test("x", () => { spawnSync("rustc", ["--version"]); });\n` })[0], /rustc/);
  assert.deepEqual(run("node --test t.test.mjs", { "t.test.mjs": `${TEST}// run cargo test elsewhere\ntest("x", () => {});\n` }), []);
});

test("a key read with no default fails; a default, a discarded name and PASSKEY_SRC do not", () => {
  const key = (read) => ({ "t.test.mjs": `${TEST}test("x", () => { const k = ${read}; });\n` });
  assert.match(run("node --test t.test.mjs", key("process.env.ONECLICK_API_KEY"))[0], /a key read with no default: process\.env\.ONECLICK_API_KEY/);
  assert.equal(run("node --test t.test.mjs", key('process.env["JUP_JWT"]')).length, 1);
  assert.equal(run("node --test t.test.mjs", key("process.env.HCLOUD_TOKEN")).length, 1);
  assert.equal(run("node --test t.test.mjs", { "t.test.mjs": `${TEST}const { RELAY_API_KEY } = process.env;\ntest("x", () => {});\n` }).length, 1);
  assert.deepEqual(run("node --test t.test.mjs", key('process.env.ONECLICK_API_KEY ?? "test-key"')), []);
  assert.deepEqual(run("node --test t.test.mjs", key('process.env.ONECLICK_API_KEY || "test-key"')), []);
  assert.deepEqual(run("node --test t.test.mjs", { "t.test.mjs": `${TEST}const { RELAY_API_KEY = "x" } = process.env;\nconst { HCLOUD_TOKEN: _, ...env } = process.env;\ntest("x", () => {});\n` }), []);
  assert.deepEqual(run("node --test t.test.mjs", key("process.env.PASSKEY_SRC")), []);
  assert.deepEqual(run("node --test t.test.mjs", { "t.test.mjs": `${TEST}test("x", { skip: !process.env.JUP_API_KEY }, () => { const k = process.env.JUP_API_KEY; });\n` }), []);
});

test("a module a test imports runs its top level and its test calls, not the functions it only defines", () => {
  const t = `${TEST}import "./top.mjs";\ntest("x", () => {});\n`;
  assert.match(run("node --test t.test.mjs", { "t.test.mjs": t, "top.mjs": 'const b = await launchBrowser("chromium");\n' })[0], /top\.mjs:1 \(imported from packages\/a\/t\.test\.mjs\): a browser launch/);
  const defined = 'export async function open() { return launchBrowser("chromium"); }\n';
  assert.deepEqual(run("node --test t.test.mjs", { "t.test.mjs": `${TEST}import { open } from "./helper.mjs";\ntest("x", () => {});\n`, "helper.mjs": defined }), []);
  // two hops, a dynamic import, require and new URL are followed
  assert.equal(run("node --test t.test.mjs", { "t.test.mjs": `${TEST}await import("./h1.mjs");\ntest("x", () => {});\n`, "h1.mjs": 'export * from "./h2.mjs";\n', "h2.mjs": 'process.env.RELAY_API_KEY;\n' }).length, 1);
  assert.equal(run("node --test t.test.mjs", { "t.test.mjs": `${TEST}const m = await import(String(new URL("./h3.mjs", import.meta.url)));\ntest("x", () => {});\n`, "h3.mjs": 'spawnSync("cargo");\n' }).length, 1);
  // a test file itself is read whole, a function in it included
  assert.equal(run("node --test t.test.mjs", { "t.test.mjs": `${TEST}function open() { return launchBrowser("chromium"); }\ntest("x", () => open());\n` }).length, 1);
});

test("the files come from the script's globs and from a script it calls", () => {
  const bad = `${TEST}test("x", () => { launchBrowser("chromium"); });\n`;
  assert.equal(run('node --test "test/*.test.mjs"', { "test/one.test.mjs": bad, "test/two.test.mjs": TEST }).length, 1);
  assert.deepEqual(run('node --test "test/*.test.mjs"', { "elsewhere.test.mjs": bad, "test/two.test.mjs": TEST }), []);
  assert.equal(run("pnpm run other", { "other.test.mjs": bad }).length, 1);
  assert.equal(run("tsc -p tsconfig.json && node --test x.test.mjs y.test.mjs", { "x.test.mjs": TEST, "y.test.mjs": bad }).length, 1);
  assert.deepEqual(run("node --test t.test.mjs", { "t.test.mjs": TEST, "e2e.mjs": bad }), []);
});

test("the repository's real prove-e2e test fails once its opt-in skip is taken away", () => {
  const real = readFileSync(path.join(ROOT, "packages/kit/test/prove-e2e.test.ts"), "utf8");
  const skip = /skip: process\.env\.KIT_PROVER_E2E === "1" \? false : "[^"]*"/;
  assert.match(real, skip);
  assert.deepEqual(run("node --test t.test.ts", { "t.test.ts": real.replace("../../../scripts/browsers.mjs", "../../scripts/browsers.mjs") }), []);
  const found = run("node --test t.test.ts", { "t.test.ts": real.replace(skip, "skip: false") });
  assert.ok(found.some((p) => /a browser launch: launchBrowser/.test(p)), found.join("\n"));
});

test("comments are blanked without moving a line, and a // in a string stays", () => {
  const src = 'const u = "http://x"; // cargo\n/* rustc\nrustup */ const k = 1;\n';
  const out = stripComments(src);
  assert.equal(out.length, src.length);
  assert.equal(out.split("\n").length, src.split("\n").length);
  assert.ok(out.includes('"http://x"') && !/cargo|rustc|rustup/.test(out));
});

test("a hit is guarded by the nearest test call only", () => {
  const t = `test("a", { skip: process.env.X === "1" ? false : "x" }, () => { HIT });\ntest("b", () => { HIT });\n`;
  assert.equal(guarded(t, t.indexOf("HIT") + 3), true);
  assert.equal(guarded(t, t.lastIndexOf("HIT") + 3), false);
});

test("the committed planted browser launch fails the gate", () => {
  const found = problems(path.join(ROOT, "scripts/ci/fixtures/default-tests/browser-launch"));
  assert.deepEqual(found, ["packages/planted test: packages/planted/launch.mjs:8: a browser launch: launchBrowser"]);
});
