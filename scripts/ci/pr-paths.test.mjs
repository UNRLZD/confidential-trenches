// Card ci-pr-light: scripts/ci/pr-paths.mjs, which of ci.yml's test jobs a pull request runs, and ci.yml's wiring of
// it. Planted pull requests on this repo's own reads: one that touches one package skips the heavy jobs it cannot
// affect, one that touches a heavy job's input runs that job, and merge_group, push and a change to a file every job
// reads run everything. In a planted repo, a test that starts reading a new file runs its job when that file changes.
//   node --test scripts/ci/pr-paths.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decide, GLOBAL, JOBS, outputs, PACKAGES, reads, workspaceDeps } from "./pr-paths.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CI = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
const HEAVY = ["test_mutants", "test_browser", "test_vault", "test_scripts", "pool_solana", "slither"];
const ALL_ON = { ...Object.fromEntries([...HEAVY, "test_wallet", "test_packages"].map((k) => [k, "true"])), tests: "", typecheck: "" };

const cache = new Map();
const readsOf = (seeds) => {
  const k = seeds.join("\n");
  if (!cache.has(k)) cache.set(k, reads(seeds));
  return cache.get(k);
};
const plan = (event, changed) => outputs(decide(event, changed, workspaceDeps(), readsOf));

test("merge_group, push, workflow_dispatch and an unread change run every job and every package", () => {
  for (const ev of ["merge_group", "push", "workflow_dispatch"]) assert.deepEqual(plan(ev, []), ALL_ON, ev);
  assert.deepEqual(plan("pull_request", null), ALL_ON, "a change whose files could not be read");
});

test("a change to a file every job reads runs everything", () => {
  for (const f of ["pnpm-lock.yaml", "package.json", ".github/workflows/ci.yml", ".github/actions/chrome/action.yml", "scripts/ci/pr-paths.mjs", "scripts/ci/test-shards.mjs"]) {
    assert.deepEqual(plan("pull_request", ["docs/architecture.md", f]), ALL_ON, f);
  }
});

test("planted: a pull request that touches only docs runs no test job and no package", () => {
  assert.deepEqual(plan("pull_request", ["docs/architecture.md", "README.md"]), {
    ...Object.fromEntries([...HEAVY, "test_wallet"].map((k) => [k, "false"])),
    test_packages: "true",
    tests: "none",
    typecheck: "none",
  });
});

test("planted: a pull request that touches one package runs it and what reads it, and skips the heavy jobs it cannot affect", () => {
  const o = plan("pull_request", ["packages/exit/src/index.ts"]);
  assert.equal(o.tests, "--filter=@blindfill/exit");
  assert.equal(o.typecheck, "--filter=@blindfill/exit");
  for (const k of [...HEAVY, "test_wallet"]) assert.equal(o[k], "false", k);
});

test("planted: a change to the kit runs every package that depends on it, and the mutant sweeps and browser runs", () => {
  const o = plan("pull_request", ["packages/kit/src/index.ts"]);
  assert.equal(o.tests, "", "every package depends on the kit");
  for (const k of ["test_mutants", "test_browser", "test_wallet"]) assert.equal(o[k], "true", k);
});

test("planted: a pull request that touches a heavy job's input runs that job", () => {
  for (const [file, job] of [
    ["contracts/pool-evm/src/PrivacyPool.sol", "slither"],
    ["contracts/pool-solana/src/lib.rs", "pool_solana"],
    ["contracts/vault/src/lib.rs", "test_vault"],
    ["contracts/vault/scripts/deploy.mjs", "test_scripts"],
    ["apps/terminal/src/main.tsx", "test_browser"],
    ["scripts/browsers.mjs", "test_browser"],
    ["apps/helper/src/env-check.ts", "test_mutants"],
  ]) assert.equal(plan("pull_request", [file])[job], "true", `${file} runs ${job}`);
});

test("every unit's seeds name tracked files, and each package's folder is its own package.json's", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n");
  for (const [name, dir] of Object.entries(PACKAGES)) {
    assert.equal(JSON.parse(readFileSync(path.join(ROOT, dir, "package.json"), "utf8")).name, name);
  }
  const pkgs = files.filter((f) => /^(packages|apps)\/[^/]+\/package\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(ROOT, f), "utf8")).name);
  assert.deepEqual(pkgs.toSorted(), Object.keys(PACKAGES).toSorted(), "a workspace package pr-paths.mjs does not know would never be selected");
  for (const [job, { pkgs: on, seeds }] of Object.entries(JOBS)) {
    for (const n of on) assert.ok(PACKAGES[n], `${job} names ${n}, no package`);
    for (const s of seeds) assert.ok(files.some((f) => f === s || (s.endsWith("/") && f.startsWith(s))), `${job}'s seed ${s} names no tracked file`);
  }
  for (const g of GLOBAL) assert.ok(files.some((f) => f === g || (g.endsWith("/") && f.startsWith(g))), `GLOBAL's ${g} names no tracked file`);
});

// a small repo laid out as this one: the kit's test reads a fixture by name, a script lists a folder, an imported
// module names a folder for its own use, and a fixture generator imports the wallet
function planted() {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-paths-"));
  const put = (f, text) => {
    mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    writeFileSync(path.join(dir, f), text);
  };
  put("packages/kit/package.json", JSON.stringify({ name: "@blindfill/kit", exports: { ".": "./src/index.ts" } }));
  put("packages/kit/src/index.ts", "export const k = 1;\n");
  put("packages/kit/test/a.test.ts", 'import { list } from "../../../scripts/lib.mjs";\nexport const t = list;\n');
  put("scripts/lib.mjs", 'import { readdirSync } from "node:fs";\nexport const list = () => readdirSync("scripts/records");\n');
  put("scripts/records/one.md", "1\n");
  put("scripts/data/old.json", "{}\n");
  put("contracts/pool-solana/src/lib.rs", "// pool\n");
  put("contracts/pool-solana/fixtures/make-spends.mjs", 'import { w } from "../../../packages/wallet/src/index.ts";\n');
  put("packages/wallet/package.json", JSON.stringify({ name: "@blindfill/wallet", exports: { ".": "./src/index.ts" } }));
  put("packages/wallet/src/index.ts", "export const w = 1;\n");
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "--quiet");
  git("add", "-A");
  const files = () => git("ls-files").split("\n").filter(Boolean);
  return { dir, put, git, files };
}

test("planted: a test that starts reading a new file runs its job when that file changes, and not before", (t) => {
  const r = planted();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const kit = () => reads(["packages/kit/"], r.dir, r.files());
  assert.ok(!kit().includes("scripts/data/new.json"));
  r.put("scripts/data/new.json", "{}\n");
  r.put("packages/kit/test/b.test.ts", 'import { readFileSync } from "node:fs";\nexport const b = readFileSync("scripts/data/new.json", "utf8");\n');
  r.git("add", "-A");
  assert.ok(kit().includes("scripts/data/new.json"), "the kit's new test reads scripts/data/new.json");
  assert.ok(!kit().includes("scripts/data/old.json"), "a file the kit never names is not read");
  // the kit's tests run on a change to that file
  const o = decide("pull_request", ["scripts/data/new.json"], { "@blindfill/kit": [] }, (s) => reads(s, r.dir, r.files()));
  assert.equal(o.packages["@blindfill/kit"][0], true);
});

test("planted: a folder counts whole only where the unit's own code lists it; an imported module adds what it names one by one", (t) => {
  const r = planted();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  // scripts/lib.mjs, imported, lists scripts/records for its own use: the kit's reads take lib.mjs, not the folder
  r.put("scripts/lib.mjs", 'import { readdirSync } from "node:fs";\nexport const list = () => readdirSync("scripts/records");\nexport const d = "scripts/data/old.json";\n');
  r.git("add", "-A");
  const kit = reads(["packages/kit/"], r.dir, r.files());
  assert.ok(kit.includes("scripts/lib.mjs"));
  assert.ok(kit.includes("scripts/data/old.json"), "a file an imported module names is read");
  assert.ok(!kit.includes("scripts/records/one.md"), "a folder an imported module lists is not the importer's read");
  // the kit's own test lists the folder: every file in it, a new one too
  r.put("packages/kit/test/c.test.ts", 'import { readdirSync } from "node:fs";\nexport const all = readdirSync("scripts/records");\n');
  r.put("scripts/records/two.md", "2\n");
  r.git("add", "-A");
  const kit2 = reads(["packages/kit/"], r.dir, r.files());
  assert.ok(kit2.includes("scripts/records/one.md") && kit2.includes("scripts/records/two.md"));
});

test("planted: a fixture generator run by hand is no seed, unless a test the job runs names it", (t) => {
  const r = planted();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const pool = () => reads(["contracts/pool-solana/src/", "contracts/pool-solana/fixtures/"], r.dir, r.files());
  assert.ok(!pool().includes("packages/wallet/src/index.ts"), "the generator's import is no read of the pool's tests");
  r.put("contracts/pool-solana/src/lib.rs", '// pool\nconst G: &str = "contracts/pool-solana/fixtures/make-spends.mjs";\n');
  r.git("add", "-A");
  assert.ok(pool().includes("contracts/pool-solana/fixtures/make-spends.mjs"), "a test that names the generator reads it");
});

// ci.yml's wiring: { name: text } of every job
function jobs(ci) {
  const body = ci.split(/\njobs:\n/)[1] ?? "";
  const out = {};
  const parts = body.split(/^ {2}([a-z0-9_-]+):\s*$/m);
  for (let i = 1; i < parts.length; i += 2) out[parts[i]] = parts[i + 1];
  return out;
}

export function wiringProblems(ci) {
  const p = [];
  const all = jobs(ci);
  const changes = all.changes;
  if (!changes) return ["ci.yml has no changes job"];
  const keys = Object.keys(ALL_ON);
  for (const k of keys) if (!new RegExp(`^ {6}${k}: \\$\\{\\{ steps\\.decide\\.outputs\\.${k} \\}\\}$`, "m").test(changes)) p.push(`the changes job does not output ${k}`);
  if (!/^ {14}node "\$RUNNER_TEMP\/base\/scripts\/ci\/pr-paths\.mjs" decide "\$EVENT" "\$BASE" "\$HEAD" ;;$/m.test(changes)) p.push("the changes job does not run main's copy of pr-paths.mjs on a pull request");
  if (/^\s*node scripts\/ci\/pr-paths\.mjs/m.test(changes)) p.push("the changes job runs the head's own pr-paths.mjs");
  const gated = { "test-wallet": "test_wallet", ...Object.fromEntries(Object.keys(JOBS).map((j) => [j, j.replaceAll("-", "_")])) };
  for (const [job, key] of Object.entries(gated)) {
    const body = all[job];
    if (!body) {
      p.push(`ci.yml has no job ${job}`);
      continue;
    }
    if (!/^ {4}needs: (?:changes|\[[^\]]*\bchanges\b[^\]]*\])$/m.test(body)) p.push(`${job} does not need changes`);
    const want = `    if: github.event_name != 'schedule' && (github.event_name != 'pull_request' || needs.changes.outputs.${key} == 'true')`;
    if (!body.split("\n").includes(want)) p.push(`${job}'s if is not the pull-request-only gate on ${key}`);
  }
  const pkgs = all["test-packages"] ?? "";
  for (const k of ["tests", "typecheck"]) {
    if (!pkgs.includes(`SELECT: \${{ github.event_name == 'pull_request' && needs.changes.outputs.${k} || '' }}`)) p.push(`test-packages reads its ${k} selector on another event than pull_request`);
  }
  return p;
}

test("ci.yml: the changes job runs main's rule, and each gated job reads its output only on pull_request", () => {
  assert.deepEqual(wiringProblems(CI), []);
});

const PLANTED = {
  "a gate on every event": ["(github.event_name != 'pull_request' || needs.changes.outputs.test_mutants == 'true')", "(needs.changes.outputs.test_mutants == 'true')", "test-mutants's if is not the pull-request-only gate"],
  "a job gated on another job's output": ["needs.changes.outputs.slither == 'true')", "needs.changes.outputs.test_vault == 'true')", "slither's if is not the pull-request-only gate"],
  "the head's own rule": ['node "$RUNNER_TEMP/base/scripts/ci/pr-paths.mjs" decide "$EVENT" "$BASE" "$HEAD" ;;', 'node scripts/ci/pr-paths.mjs decide "$EVENT" "$BASE" "$HEAD" ;;', "the changes job does not run main's copy"],
  "an output left out": ["      pool_solana: ${{ steps.decide.outputs.pool_solana }}\n", "", "the changes job does not output pool_solana"],
  "a package selector on the queue": ["SELECT: ${{ github.event_name == 'pull_request' && needs.changes.outputs.tests || '' }}", "SELECT: ${{ needs.changes.outputs.tests }}", "test-packages reads its tests selector"],
};
for (const [name, [from, to, want]] of Object.entries(PLANTED)) {
  test(`planted: ${name} fails`, () => {
    const planted = CI.replace(from, to);
    assert.notEqual(planted, CI, `the plant for "${name}" matched nothing in ci.yml`);
    const found = wiringProblems(planted);
    assert.ok(found.some((f) => f.startsWith(want)), `want "${want}", found: ${JSON.stringify(found)}`);
  });
}

test("the command line writes every output on a merge_group run, and refuses no event", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-paths-out-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, "out");
  writeFileSync(out, "");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/ci/pr-paths.mjs"), "decide", "merge_group"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: out } });
  assert.equal(r.status, 0, r.stderr);
  const got = Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  assert.deepEqual(got, ALL_ON);
  assert.equal(spawnSync(process.execPath, [path.join(ROOT, "scripts/ci/pr-paths.mjs"), "decide"], { cwd: ROOT }).status, 2);
});
