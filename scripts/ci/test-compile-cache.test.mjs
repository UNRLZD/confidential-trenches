// Card readme-run-fits-an-agent-timeout: every package's test run keeps node's compile cache, in each file's process and
// in a node process a test starts. A run is about 700 file processes, each compiling and type-stripping the modules the
// others did (read on node 24.22.3: a small helper file 0.46 CPU-s without the cache, 0.20 with it warm), and the
// README's agent steps must finish inside an agent's timeout on a 4-core runner. Planted file, run with each package's
// own node --test flags from its package.json, in that package's folder: the file's process and a child it forks name the
// cache folder under the workspace's node_modules/.cache, and the folder holds the file once the run ends.
//   node --test scripts/ci/test-compile-cache.test.mjs
import assert from "node:assert/strict";
import { existsSync, globSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../group-run.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE = path.join(ROOT, "node_modules", ".cache", "node-compile-cache");
// a run started from inside a node --test file is a run of its own: NODE_TEST_CONTEXT would make it report to this one,
// and a cache this run was given (NODE_COMPILE_CACHE) would hide whether the package's flags turn one on
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT" && k !== "NODE_COMPILE_CACHE" && k !== "NODE_DISABLE_COMPILE_CACHE"));

const PLANT = `import { test } from "node:test";
import assert from "node:assert/strict";
import { getCompileCacheDir } from "node:module";
import { execFileSync } from "node:child_process";
test("the cache", () => {
  const child = execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:module').getCompileCacheDir() ?? 'none')"], { encoding: "utf8" });
  console.log("cache-dir " + (getCompileCacheDir() ?? "none") + " child " + child);
});
`;

/** Each workspace package with a test script: its folder and the flags of its node --test, as package.json has them. */
function packages() {
  const globs = [...readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8").matchAll(/^\s+-\s+["']?([^"'\s]+)["']?\s*$/gm)].map((m) => m[1]);
  const out = [];
  for (const pkg of globs.flatMap((g) => globSync(`${g}/package.json`, { cwd: ROOT })).sort()) {
    const script = JSON.parse(readFileSync(path.join(ROOT, pkg), "utf8")).scripts?.test;
    if (typeof script !== "string") continue;
    const w = script.split("&&").map((s) => s.trim().split(/\s+/)).find((x) => x[0] === "node" && x.includes("--test"));
    assert.ok(w, `${pkg}: no node --test in its test script`);
    out.push({ dir: path.dirname(pkg), flags: w.slice(w.indexOf("--test") + 1).filter((x) => x.startsWith("-")) });
  }
  return out;
}

test("every package's test run keeps node's compile cache under node_modules/.cache, in each file's process and a process it starts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "test-compile-cache-"));
  try {
    writeFileSync(path.join(dir, "cache.test.mjs"), PLANT);
    const pkgs = packages();
    assert.ok(pkgs.length >= 7, `the workspace's test scripts, read: ${pkgs.map((p) => p.dir)}`);
    const runs = await Promise.all(pkgs.map(async (p) => ({ ...p, r: await run(process.execPath, ["--test", ...p.flags, path.join(dir, "cache.test.mjs")], { cwd: path.join(ROOT, p.dir), env: ENV, timeoutMs: 60_000 }) })));
    for (const { dir: d, r } of runs) {
      const out = r.stdout + r.stderr;
      assert.equal(r.status, 0, `${d}\n${out}`);
      const m = /cache-dir (\S+) child (\S+)/.exec(out);
      assert.ok(m, `${d}: the planted file printed nothing\n${out}`);
      // node names the folder of the running version inside the one given (v24: <given>/<version and flags hash>)
      assert.ok(m[1].startsWith(CACHE), `${d}: the file's process keeps no cache under ${CACHE}: ${m[1]}`);
      assert.ok(m[2].startsWith(CACHE), `${d}: a process the file starts keeps no cache under ${CACHE}: ${m[2]}`);
    }
    assert.ok(existsSync(CACHE) && readdirSync(CACHE).length > 0, "the cache folder holds the runs' modules");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cache the caller names is kept, and NODE_DISABLE_COMPILE_CACHE turns it off", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "test-compile-cache-"));
  try {
    writeFileSync(path.join(dir, "cache.test.mjs"), PLANT);
    const { flags } = packages().find((p) => p.dir === "packages/wallet");
    const mine = path.join(dir, "mine");
    const named = await run(process.execPath, ["--test", ...flags, path.join(dir, "cache.test.mjs")], { cwd: path.join(ROOT, "packages/wallet"), env: { ...ENV, NODE_COMPILE_CACHE: mine }, timeoutMs: 60_000 });
    const n = /cache-dir (\S+) child (\S+)/.exec(named.stdout + named.stderr);
    assert.ok(n && n[1].startsWith(mine) && n[2].startsWith(mine), `the caller's cache: ${named.stdout}${named.stderr}`);
    const off = await run(process.execPath, ["--test", ...flags, path.join(dir, "cache.test.mjs")], { cwd: path.join(ROOT, "packages/wallet"), env: { ...ENV, NODE_DISABLE_COMPILE_CACHE: "1" }, timeoutMs: 60_000 });
    assert.match(off.stdout + off.stderr, /cache-dir none child none/, `turned off: ${off.stdout}${off.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
