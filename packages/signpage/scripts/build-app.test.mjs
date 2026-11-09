// node --test packages/signpage/scripts/build-app.test.mjs: the committed public/app.js and index.html are a fresh
// build of src/main.ts, and the page runs that one script only, under its sha384 (Integrity-Policy, public/_headers);
// the committed public/prover-worker.js is the kit's prover worker build (packages/kit/src/prover/build.mjs), byte for
// byte; and the deploy build's copies of the six setup files and their licences are the pinned files (copyServed).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundle, bundleModuleProblems, check, copyServed, outputFiles, outsideTsconfigs, SERVED, sha384 } from "./build-app.mjs";
import { SIGN_BUILD_OUTPUTS } from "../../../scripts/ci/sign-build-inputs.mjs";
import { proverThreadSource, proverWorkerSource } from "../../kit/src/prover/build.mjs";
import { ZK_SETUP_FILES } from "../../kit/src/zk/setup-files.ts";
import { BUILD_COMMAND, runBuild, signBuilt } from "../../../scripts/signpage-built.mjs";

const PKG = signBuilt(); // the page's build, made from this tree's sources first (card signpage-generated-merge-free)

test("public/app.js and index.html match a fresh build", async () => {
  assert.deepEqual(await check(), []);
});

test("index.html runs one script, /app.js, with its sha384, and nothing inline", () => {
  const html = readFileSync(join(PKG, "index.html"), "utf8");
  const tags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(tags.length, 1);
  assert.match(tags[0][1], /\ssrc="\/app\.js"/);
  assert.equal(tags[0][2], "");
  assert.equal(/\sintegrity="([^"]+)"/.exec(tags[0][1])[1], sha384(readFileSync(join(PKG, "public/app.js"))));
  assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=/i);
});

test("a hand-edited bundle or a stale integrity is caught", async () => {
  // committed copies with a hand-edited bundle, then with the bundle right and the page's integrity stale
  const d = mkdtempSync(join(tmpdir(), "ct-signpage-build-test-"));
  mkdirSync(join(d, "public"));
  const js = readFileSync(join(PKG, "public/app.js"), "utf8");
  writeFileSync(join(d, "public/app.js"), js.replace("confidential.unrealized.trade", "sign.evil.test"));
  cpSync(join(PKG, "index.html"), join(d, "index.html"));
  cpSync(join(PKG, "public/prover-worker.js"), join(d, "public/prover-worker.js"));
  cpSync(join(PKG, "public/prover-thread.js"), join(d, "public/prover-thread.js"));
  assert.match((await check(PKG, d)).join("\n"), /public\/app\.js is not the build/);
  writeFileSync(join(d, "public/app.js"), js);
  writeFileSync(join(d, "index.html"), readFileSync(join(PKG, "index.html"), "utf8").replace(/sha384-[^"]+/, sha384(Buffer.from("x"))));
  assert.deepEqual(await check(PKG, d), ["index.html is not the page around public/app.js with its sha384"]);
  rmSync(d, { recursive: true, force: true });
});

test("public/prover-worker.js is the kit's prover worker build, byte for byte", () => {
  assert.ok(readFileSync(join(PKG, "public/prover-worker.js")).equals(proverWorkerSource()));
});

test("a stale or hand-edited prover worker is caught", async () => {
  const d = mkdtempSync(join(tmpdir(), "ct-signpage-build-test-"));
  try {
    cpSync(join(PKG, "public"), join(d, "public"), { recursive: true });
    cpSync(join(PKG, "index.html"), join(d, "index.html"));
    const w = readFileSync(join(PKG, "public/prover-worker.js"), "utf8");
    assert.ok(w.includes(ZK_SETUP_FILES["withdraw.zkey"].sha256));
    writeFileSync(join(d, "public/prover-worker.js"), w.replace(ZK_SETUP_FILES["withdraw.zkey"].sha256, "0".repeat(64)));
    assert.deepEqual(await check(PKG, d), ["public/prover-worker.js is not the kit's prover worker build: run node packages/signpage/scripts/build-app.mjs"]);
    rmSync(join(d, "public/prover-worker.js"));
    assert.deepEqual(await check(PKG, d), ["public/prover-worker.js is not the kit's prover worker build: run node packages/signpage/scripts/build-app.mjs"]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("public/prover-thread.js is the kit's prover thread build, byte for byte (card signpage-prover-threads)", () => {
  assert.ok(readFileSync(join(PKG, "public/prover-thread.js")).equals(proverThreadSource()));
});

test("a stale or hand-edited prover thread file is caught", async () => {
  const d = mkdtempSync(join(tmpdir(), "ct-signpage-build-test-"));
  try {
    cpSync(join(PKG, "public"), join(d, "public"), { recursive: true });
    cpSync(join(PKG, "index.html"), join(d, "index.html"));
    const t = readFileSync(join(PKG, "public/prover-thread.js"), "utf8");
    writeFileSync(join(d, "public/prover-thread.js"), t.replace("const MAXMEM = 32767;", "const MAXMEM = 32766;"));
    const want = ["public/prover-thread.js is not the kit's prover thread build: run node packages/signpage/scripts/build-app.mjs"];
    assert.deepEqual(await check(PKG, d), want);
    rmSync(join(d, "public/prover-thread.js"));
    assert.deepEqual(await check(PKG, d), want);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("the deploy build serves the six setup files at /assets/zk/<sha256>.<ext> and the licence texts, as pinned", () => {
  const zk = SERVED.filter((s) => s.to.startsWith("assets/zk/"));
  assert.equal(zk.length, 6);
  for (const [name, pin] of Object.entries(ZK_SETUP_FILES)) {
    assert.ok(zk.some((s) => s.to === `assets/zk/${pin.sha256}.${name.split(".").pop()}` && s.bytes === pin.bytes && s.sha256 === pin.sha256), name);
  }
  assert.deepEqual(SERVED.filter((s) => !s.to.startsWith("assets/zk/")).map((s) => s.to), [
    "licenses/GPL-3.0.txt",
    "licenses/LGPL-3.0.txt",
    "licenses/Apache-2.0.txt",
    "licenses/zk-NOTICE.txt",
  ]);
  const d = mkdtempSync(join(tmpdir(), "ct-signpage-served-"));
  try {
    copyServed(d);
    for (const s of SERVED) assert.ok(readFileSync(join(d, s.to)).equals(readFileSync(s.from)), s.to);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("copyServed refuses a setup file whose size or sha256 is not its pin, and writes nothing", () => {
  const d = mkdtempSync(join(tmpdir(), "ct-signpage-served-"));
  const src = mkdtempSync(join(tmpdir(), "ct-signpage-kit-"));
  try {
    const name = "commitment.zkey";
    const pin = ZK_SETUP_FILES[name];
    const real = readFileSync(join(PKG, "..", "kit", "zk", name));
    const flipped = Buffer.from(real);
    flipped[flipped.length >> 1] ^= 1;
    for (const [what, body, want] of [
      ["one byte changed", flipped, new RegExp(`${name}: sha256 [0-9a-f]{64}, pinned ${pin.sha256}`)],
      ["one byte short", real.subarray(1), new RegExp(`${name}: ${pin.bytes - 1} B, pinned ${pin.bytes} B`)],
    ]) {
      writeFileSync(join(src, name), body);
      const list = SERVED.map((s) => (s.to.endsWith(`${pin.sha256}.zkey`) ? { ...s, from: join(src, name) } : s));
      assert.throws(() => copyServed(d, list), want, what);
      assert.deepEqual(readdirSync(d), [], what);
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("no test path marks a wallet as armed: the shipped bundle's modules hold no test file, helper or package, and none puts a wallet into READY", async () => {
  const { modules } = await bundle();
  assert.ok(modules.some((m) => m.endsWith("wallet/src/arming/records.ts")), "the arm records are in the bundle, so the check reads them");
  assert.deepEqual(bundleModuleProblems(modules), []);
});

test("planted: a test file, a fixture, a test-only package, Node's test runner, a module that arms a wallet, or no module list fails the release build", () => {
  const src = (text) => () => text;
  const clean = "/r/packages/signpage/src/trade.ts";
  for (const id of ["/r/packages/signpage/test/trade.test.ts", "/r/packages/kit/test/fixtures/solana-pool-buy.json.ts", "/r/packages/signpage/src/arm.test.ts", "/r/node_modules/.pnpm/fake-indexeddb@6.2.6/node_modules/fake-indexeddb/build/esm/index.js", "/r/node_modules/.pnpm/vite@8.3.5/node_modules/vite/dist/client/env.mjs", "node:test"]) {
    assert.match(bundleModuleProblems([clean, id], src("")).join("\n"), /carries a test path/, id);
  }
  assert.match(bundleModuleProblems([clean, "/r/packages/signpage/src/arm-hook.ts"], (id) => (id === clean ? "" : 'await store.put("wallets", { ...rec, state: "READY" });')).join("\n"), /puts a wallet into READY: \/r\/packages\/signpage\/src\/arm-hook\.ts/);
  assert.match(bundleModuleProblems([clean], src("moveArmRecord(s, k, 'ARMING', to: 'READY')")).join("\n"), /puts a wallet into READY/);
  assert.deepEqual(bundleModuleProblems([clean], src('settleArm(store, key, op, { from: "READY", to: "IN_POSITION" })')), [], "moving a READY wallet on is not arming one");
  assert.match(bundleModuleProblems([]).join("\n"), /module list is empty/);
  // a runtime dependency is no test path: only the package's devDependencies are
  assert.deepEqual(bundleModuleProblems([clean, "/r/node_modules/.pnpm/@noble+curves@2.4.0/node_modules/@noble/curves/esm/ed25519.js"], src("")), []);
});

// card signpage-generated-merge-free: the four files are build output, made by every reader from the sources first
test("signBuilt leaves the four output files in the package as a fresh build; a failed build names the command that makes it", async () => {
  assert.equal(signBuilt(), PKG);
  assert.deepEqual(await check(), []);
  const d = mkdtempSync(join(tmpdir(), "ct-signpage-built-"));
  try {
    writeFileSync(join(d, "fail.mjs"), 'console.error("vite: planted failure"); process.exit(1);\n');
    assert.throws(() => runBuild(join(d, "fail.mjs")), (e) => e.message.includes(BUILD_COMMAND) && e.message.includes("vite: planted failure"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// review P1(b): the bundler applies the nearest tsconfig.json above a module, so one above the repository root (the
// reviewer's plant: useDefineForClassFields false, app.js changed) would change the release build unseen; bundle()
// refuses to build while one is there
test("planted: a tsconfig.json above the repository root refuses the build before anything is bundled", async () => {
  const d = mkdtempSync(join(tmpdir(), "ct-signpage-above-"));
  try {
    mkdirSync(join(d, "repo"));
    writeFileSync(join(d, "tsconfig.json"), JSON.stringify({ compilerOptions: { useDefineForClassFields: false } }));
    assert.deepEqual(outsideTsconfigs(join(d, "repo")), [join(d, "tsconfig.json")]);
    await assert.rejects(bundle(PKG, { repo: join(d, "repo") }), /tsconfig\.json above the repository root[\s\S]*useDefineForClassFields|tsconfig\.json above the repository root/);
    rmSync(join(d, "tsconfig.json"));
    assert.deepEqual(outsideTsconfigs(join(d, "repo")), []);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  assert.deepEqual(outsideTsconfigs(), [], "none above this checkout");
});

// review of 31f81cbd (P3): the files a build writes are exactly SIGN_BUILD_OUTPUTS, the set CI's bundle scan copies and
// scans and .gitignore ignores, in the package and, by the same names, in the served layout the deploy uploads: a fifth
// output would be uploaded unscanned
test("build-app writes exactly SIGN_BUILD_OUTPUTS: in the package, and by the same names in the served layout", () => {
  const b = { js: "", html: "", worker: "", thread: "" };
  assert.deepEqual(Object.keys(outputFiles(b, false)).map((f) => `packages/signpage/${f}`).sort(), [...SIGN_BUILD_OUTPUTS].sort());
  const served = SIGN_BUILD_OUTPUTS.map((f) => f.replace(/^packages\/signpage\/(public\/)?/, "")).sort();
  assert.deepEqual(Object.keys(outputFiles(b, true)).sort(), served);
  const out = mkdtempSync(join(tmpdir(), "ct-signpage-test-out-"));
  try {
    const r = spawnSync(process.execPath, [join(PKG, "scripts", "build-app.mjs"), "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.deepEqual(readdirSync(out, { recursive: true }).sort(), served);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
