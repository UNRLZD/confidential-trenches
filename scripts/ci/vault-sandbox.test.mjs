// SPDX-License-Identifier: Apache-2.0
// scripts/ci/vault-sandbox.mjs: the rule that decides when CI runs the vault's sandbox suite, and its shards. Each
// failure the rule must refuse is planted here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PATHS, ROOT, SHARDS, closure, decide, matches, namedPaths, shardArgs, shardProblems, suiteReads, targets, uncovered } from "./vault-sandbox.mjs";

// What is wrong with ci.yml's vault-sandbox-plan decide step: on a pull request it must run main's copy of the rule
// (extracted from the base into $RUNNER_TEMP/base), never the head's, which the pull request could edit to skip.
function planStepProblems(ci) {
  const job = ci.split(/\n  vault-sandbox-plan:\n/)[1]?.split(/\n  [a-z-]+:\n/)[0];
  if (!job) return ["ci.yml has no vault-sandbox-plan job"];
  const pr = job.match(/\n\s*pull_request\)\n([\s\S]*?);;/)?.[1];
  if (!pr) return ["the decide step has no pull_request arm"];
  const p = [];
  if (!pr.includes('git archive "$BASE" scripts | tar -x -f - -C "$RUNNER_TEMP/base"')) p.push("the pull_request arm does not extract the base's scripts");
  if (!pr.includes('node "$RUNNER_TEMP/base/scripts/ci/vault-sandbox.mjs" decide "$EVENT" "$BASE" "$HEAD"')) p.push("the pull_request arm does not run the base's rule");
  if (/node\s+(\.\/)?scripts\/ci\/vault-sandbox\.mjs/.test(pr)) p.push("the pull_request arm runs the head's rule");
  if (/run=false/.test(pr)) p.push("the pull_request arm can skip on its own");
  return p;
}

test("every file the sandbox suite reads is one the rule runs the suite for", () => {
  const reads = suiteReads();
  assert.ok(reads.includes("contracts/vault/src/lib.rs"));
  for (const f of ["contracts/vault/scripts/deploy.mjs", "scripts/live-checks/vault-testnet-t01.mjs", "apps/helper/src/bind/send.ts", "apps/helper/test/bind-send/carry.ts", "packages/kit/zk/withdraw.vkey", "packages/kit/src/vault/shapes.ts", "packages/kit/test/vectors/vault-v1.json",
    // the kit's entry exports the NEAR pair rule from this file, which imports nothing (covered by packages/kit/src/)
    "packages/kit/src/near/networks.ts",
    // relayer_withdraw.rs: the withdraw relayer's CLI, the send it drives (through its imports) and the fixture
    "apps/helper/test/withdraw-send/carry.ts", "apps/helper/src/withdraw/send.ts", "apps/helper/src/withdraw/checks.ts", "apps/helper/src/withdraw/fee.ts", "contracts/vault/tests/fixtures/withdraw-spends.json"]) {
    assert.ok(reads.includes(f), `the suite reads ${f}, and suiteReads did not find it`);
  }
  assert.deepEqual(uncovered(reads), []);
});

test("planted: a file the suite reads but the rule misses fails", () => {
  const reads = suiteReads();
  for (const gone of ["apps/helper/src/token-status/", "packages/kit/zk/", "scripts/net-window.mjs", "packages/kit/test/vectors/", "apps/helper/src/withdraw/", "apps/helper/test/withdraw-send/"]) {
    const missed = uncovered(reads, PATHS.filter((p) => p !== gone));
    assert.ok(missed.length > 0 && missed.every((f) => f.startsWith(gone)), `without ${gone} the rule still covers ${missed}`);
  }
});

test("planted: a test that starts reading a new file is followed by suiteReads", () => {
  const root = mkdtempSync(path.join(tmpdir(), "vault-sandbox-"));
  try {
    const put = (f, text) => {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), text);
    };
    put("contracts/vault/tests/new.rs", 'let s = repo().join("apps/helper/test/new-send/run.ts");');
    put("apps/helper/test/new-send/run.ts", 'import { x } from "../../src/new/x.ts";\nimport { k } from "@blindfill/kit";');
    put("apps/helper/src/new/x.ts", "export const x = 1;");
    put("packages/kit/package.json", JSON.stringify({ name: "@blindfill/kit", exports: { ".": { default: "./src/index.ts" } } }));
    put("packages/kit/src/index.ts", 'export * from "./vault/shapes.ts";');
    put("packages/kit/src/vault/shapes.ts", "export const k = 1;");
    const files = ["contracts/vault/tests/new.rs", "apps/helper/test/new-send/run.ts", "apps/helper/src/new/x.ts", "packages/kit/package.json", "packages/kit/src/index.ts", "packages/kit/src/vault/shapes.ts"];
    const reads = suiteReads(root, files);
    for (const f of files.filter((f) => !f.endsWith("package.json"))) assert.ok(reads.includes(f), `${f} not followed: ${reads}`);
    assert.deepEqual(uncovered(reads), ["apps/helper/src/new/x.ts", "apps/helper/test/new-send/run.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("include_str! paths count from the file's own directory, joins from the crate", () => {
  const files = ["packages/kit/test/vectors/vault-v1.json", "contracts/vault/scripts/deploy.mjs"];
  assert.deepEqual([...namedPaths('include_str!("../../../packages/kit/test/vectors/vault-v1.json")', files, "contracts/vault/tests")], [files[0]]);
  assert.deepEqual([...namedPaths('join("scripts/deploy.mjs")', files, "contracts/vault/tests")], [files[1]]);
  assert.deepEqual(closure(".", ["no/such/file.mjs"], []), []);
});

test("the decision: a pull request or push runs the suite only when it touches what the suite reads", () => {
  assert.equal(decide("pull_request", ["contracts/vault/src/withdraw.rs"])[0], true);
  assert.equal(decide("push", ["apps/helper/src/bind/send.ts", "README.md"])[0], true);
  assert.equal(decide("pull_request", [".github/workflows/ci.yml"])[0], true);
  assert.equal(decide("pull_request", ["scripts/ci/vault-sandbox.mjs"])[0], true);
  const [run, why] = decide("pull_request", ["apps/terminal/src/App.tsx", "README.md"]);
  assert.equal(run, false);
  assert.match(why, /none of the 2 changed file\(s\)/);
  // unknown changes, and the nightly and manual runs, always run it
  assert.equal(decide("pull_request", null)[0], true);
  assert.equal(decide("schedule", [])[0], true);
  assert.equal(decide("workflow_dispatch", [])[0], true);
  assert.equal(matches("packages/kit/src/index.ts"), true);
  assert.equal(matches("packages/wallet/src/index.ts"), false);
});

test("on a pull request the plan step runs main's rule, never the head's", () => {
  const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.deepEqual(planStepProblems(ci), []);
});

test("planted: a plan step that runs the head's rule on a pull request fails", () => {
  const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  // each plant changes the plan job only (verify-gate and money-gate hold the same lines)
  const at = ci.indexOf("\n  vault-sandbox-plan:\n");
  const plant = (a, b) => ci.slice(0, at) + ci.slice(at).replace(a, b);
  const head = plant('node "$RUNNER_TEMP/base/scripts/ci/vault-sandbox.mjs" decide', "node scripts/ci/vault-sandbox.mjs decide");
  assert.notEqual(head, ci);
  assert.deepEqual(planStepProblems(head), ["the pull_request arm does not run the base's rule", "the pull_request arm runs the head's rule"]);
  const noBase = plant('git archive "$BASE" scripts', 'git archive "$HEAD" scripts');
  assert.ok(planStepProblems(noBase).includes("the pull_request arm does not extract the base's scripts"));
  const skips = plant('echo "run=true" >> "$GITHUB_OUTPUT"', 'echo "run=false" >> "$GITHUB_OUTPUT"');
  assert.ok(planStepProblems(skips).includes("the pull_request arm can skip on its own"));
});

test("a copy of the rule outside the checkout reads the change in its working directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vault-sandbox-base-"));
  try {
    copyFileSync(path.join(ROOT, "scripts/ci/vault-sandbox.mjs"), path.join(dir, "vault-sandbox.mjs"));
    const repo = path.join(dir, "repo");
    mkdirSync(repo);
    const git = (...a) => execFileSync("git", ["-c", "user.name=ci", "-c", "user.email=ci@example.invalid", ...a], { cwd: repo, encoding: "utf8" }).trim();
    const commit = (f) => {
      mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
      writeFileSync(path.join(repo, f), "x\n");
      git("add", "--", f);
      git("commit", "--quiet", "--no-verify", "-m", f);
      return git("rev-parse", "HEAD");
    };
    git("init", "--quiet");
    const c0 = commit("README.md");
    const c1 = commit("contracts/vault/src/lib.rs");
    const c2 = commit("apps/terminal/src/App.tsx");
    const decide = (a, b) => execFileSync("node", [path.join(dir, "vault-sandbox.mjs"), "decide", "pull_request", a, b], { cwd: repo, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "" } });
    assert.match(decide(c0, c1), /^run=true: 1 changed file\(s\) the suite reads, first contracts\/vault\/src\/lib\.rs/);
    assert.match(decide(c1, c2), /^run=false: none of the 1 changed file\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every test target is in exactly one shard", () => {
  const all = targets();
  assert.ok(all.includes("lib") && all.includes("s04") && all.includes("relayer_send"), String(all));
  assert.deepEqual(shardProblems(SHARDS, all), []);
  assert.deepEqual(shardArgs(4).slice(0, 3), ["--no-fail-fast", "--lib", "--test"]);
  assert.throws(() => shardArgs(SHARDS.length + 1), /no shard/);
});

test("planted: a test target in no shard, in two, or gone fails", () => {
  const all = targets();
  assert.deepEqual(shardProblems(SHARDS, [...all, "s99"]), ["s99 is in no shard, so CI never runs it"]);
  assert.deepEqual(shardProblems([...SHARDS, ["s04"]], all), [`s04 is in shard 2 and shard ${SHARDS.length + 1}`]);
  assert.deepEqual(shardProblems(SHARDS, all.filter((t) => t !== "smoke")), ["smoke is in a shard but is no test target"]);
});

// What is wrong with ci.yml's sandbox build and caches: the shards must run on the wasm vault-sandbox-build built, its
// vault the shipped one (run.sh --reproducible, every run, unconditional and never cached: its bytes name the commit,
// so a cached one is another commit's), whose sha256 the build hands each shard to check; no cache key may name the
// commit (a key per commit fills the repo's 10 GB and evicts every cache), the shards must read the build's rust-cache
// entry (same env and inputs, else they always build cold), and the matrix must run every shard SHARDS lists.
const jobText = (ci, name) => ci.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z-]+:\n/)[0];
const block = (text, head) => {
  const at = text.indexOf(head);
  if (at < 0) return null;
  const lines = text.slice(at).split("\n").slice(1);
  const indent = (l) => l.match(/^ */)[0].length;
  const own = indent(text.slice(0, at).split("\n").pop() + head.trimEnd()) + 2;
  const out = [];
  for (const l of lines) {
    if (l.trim() && indent(l) < own) break;
    if (l.trim() && !l.trim().startsWith("#")) out.push(l);
  }
  return out;
};
function cacheProblems(ci, shards = SHARDS) {
  const p = [];
  for (const l of ci.split("\n").filter((l) => /^\s*(key|restore-keys):/.test(l) || /^\s+[a-z-]+-\$\{\{/.test(l))) {
    if (l.includes("github.sha")) p.push(`a cache key names the commit: ${l.trim()}`);
  }
  const build = jobText(ci, "vault-sandbox-build");
  const shard = jobText(ci, "vault-sandbox-shard");
  if (!build || !shard) return [...p, "ci.yml has no vault-sandbox-build or vault-sandbox-shard job"];
  // a cache step (actions/cache, or its restore) whose path holds the built wasm
  const cached = [...build.matchAll(/- (?:id: \S+\n\s+)?uses: actions\/cache(?:\/restore)?@[\s\S]*?\n\s+path: ([^\n]*)/g)].some((m) => m[1].includes("vault-wasm"));
  if (cached) p.push("the vault wasm is cached, and its bytes name the commit it was built at: a cached one is another commit's");
  const step = build.match(/- name: the four wasm[^\n]*\n((?: {8,}[^\n]*\n)*)/)?.[1] ?? "";
  if (!/run: RETRY_FINAL=3 bash scripts\/ci\/retry\.sh bash scripts\/ci\/fresh-dir\.sh "\$RUNNER_TEMP\/vault-wasm" contracts\/vault\/tests\/harness\/run\.sh --reproducible --build-only "\$RUNNER_TEMP\/vault-wasm"\n/.test(step)) {
    p.push("vault-sandbox-build does not build the shipped vault (run.sh --reproducible --build-only, retried into an emptied dir with RETRY_FINAL=3)");
  }
  if (/^\s+if:/m.test(step)) p.push("vault-sandbox-build's wasm build runs only on a condition, so a run can ship the shards no wasm of its commit");
  if (!/\n    outputs:\n      vault_sha256: \$\{\{ steps\.shipped\.outputs\.sha256 \}\}\n/.test(build) || !/- name: [^\n]*\n\s+id: shipped\n\s+run: \|\n\s+node contracts\/vault\/scripts\/shipped\.mjs "\$RUNNER_TEMP\/vault-wasm\/blindfill_vault\.wasm"\n\s+echo "sha256=\$\(sha256sum "\$RUNNER_TEMP\/vault-wasm\/blindfill_vault\.wasm" \| cut -d' ' -f1\)" \| tee -a "\$GITHUB_OUTPUT"\n/.test(build)) {
    p.push("vault-sandbox-build does not check the shipped vault and hand its sha256 to the shards");
  }
  if (!shard.includes("VAULT_WASM_SHA256: ${{ needs.vault-sandbox-build.outputs.vault_sha256 }}")) p.push("a shard does not check its vault wasm against the build job's sha256");
  if (!shard.includes('VAULT_WASM_DIR="$RUNNER_TEMP/vault-wasm" contracts/vault/tests/harness/run.sh')) p.push("a shard does not run on the built wasm");
  if (/--build-only/.test(shard)) p.push("a shard builds wasm");
  // a target that starts deploy.mjs gets its cargo-near builds: the shards install the build job's sha256-checked one
  const install = (t) => t.match(/- name: install cargo-near\n[\s\S]*?cargo \+1\.96\.0 near --version\n/)?.[0]?.replace(/\n\s*if: .*/, "");
  const deploys = shards.flat().filter((x) => x !== "lib" && targets().includes(x) && readFileSync(path.join(ROOT, `contracts/vault/tests/${x}.rs`), "utf8").includes('join("scripts/deploy.mjs")'));
  if (deploys.length && (!install(shard) || install(shard) !== install(build) || !shard.includes("--target wasm32-unknown-unknown"))) {
    p.push(`${deploys.join(", ")} start contracts/vault/scripts/deploy.mjs, which builds with cargo-near, and the shards do not install it`);
  }
  if (JSON.stringify(block(build, "    env:")) !== JSON.stringify(block(shard, "    env:"))) p.push("the build and the shards hold different env, so the shards miss the build's rust-cache entry");
  // the rust-cache step's inputs, up to the next step, but for save-if
  const rc = (t) => {
    const at = t.indexOf("Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0 # v2.9.3\n");
    if (at < 0) return null;
    const rest = t.slice(at).split("\n").slice(1);
    const end = rest.findIndex((l) => /^ {0,6}\S/.test(l));
    return rest.slice(0, end < 0 ? rest.length : end).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("save-if:"));
  };
  if (!rc(build) || JSON.stringify(rc(build)) !== JSON.stringify(rc(shard))) p.push("the shards do not read the build's rust-cache entry");
  if (!/save-if: "false"/.test(shard)) p.push("a shard saves the rust-cache entry");
  const matrix = shard.match(/shard: \[([0-9, ]*)\]/)?.[1];
  const want = shards.map((_, i) => i + 1).join(", ");
  if (matrix !== want) p.push(`the matrix runs shards [${matrix}], and SHARDS has [${want}]`);
  return p;
}

test("the shards run on the shipped vault built once, and on caches keyed on their inputs", () => {
  const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.deepEqual(cacheProblems(ci), []);
});

test("planted: a commit in a key, a cached or host-built vault, a shard that builds, skips the sha256 or misses the cache, a dropped shard fail", () => {
  const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const at = (job) => ci.indexOf(`\n  ${job}:\n`);
  const plant = (job, a, b) => {
    const out = ci.slice(0, at(job)) + ci.slice(at(job)).replace(a, b);
    assert.notEqual(out, ci, `the plant ${a} -> ${b} changed nothing`);
    return out;
  };
  assert.deepEqual(cacheProblems(plant("pool-solana", "svm-tests/Cargo.lock') }}\n", "svm-tests/Cargo.lock') }}-${{ github.sha }}\n")),
    ["a cache key names the commit: key: pool-solana-rustc-1.96.0-1.97.1-agave-4.4.0-${{ hashFiles('contracts/pool-solana/Cargo.lock', 'contracts/pool-solana/svm-tests/Cargo.lock') }}-${{ github.sha }}"]);
  // the wasm cache this card removed, put back as it was
  assert.deepEqual(cacheProblems(plant("vault-sandbox-build", "      - uses: actions/setup-node", "      - id: wasm\n        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0\n        with:\n          path: ${{ runner.temp }}/vault-wasm\n          key: vault-wasm-rustc-1.96.0-cargo-near-0.22.0-${{ hashFiles('contracts/vault/**') }}\n      - uses: actions/setup-node")),
    ["the vault wasm is cached, and its bytes name the commit it was built at: a cached one is another commit's"]);
  // the host build of the vault, as before this card
  assert.deepEqual(cacheProblems(plant("vault-sandbox-build", "run.sh --reproducible --build-only", "run.sh --build-only")),
    ["vault-sandbox-build does not build the shipped vault (run.sh --reproducible --build-only, retried into an emptied dir with RETRY_FINAL=3)"]);
  assert.deepEqual(cacheProblems(plant("vault-sandbox-build", "run: RETRY_FINAL=3 bash scripts/ci/retry.sh bash scripts/ci/fresh-dir.sh", "run: bash scripts/ci/retry.sh bash scripts/ci/fresh-dir.sh")),
    ["vault-sandbox-build does not build the shipped vault (run.sh --reproducible --build-only, retried into an emptied dir with RETRY_FINAL=3)"]);
  assert.deepEqual(cacheProblems(plant("vault-sandbox-build", "      - name: the four wasm, built once for every shard, and the pinned two\n", "      - name: the four wasm, built once for every shard, and the pinned two\n        if: steps.wasm.outputs.cache-hit != 'true'\n")),
    ["vault-sandbox-build's wasm build runs only on a condition, so a run can ship the shards no wasm of its commit"]);
  assert.deepEqual(cacheProblems(plant("vault-sandbox-build", "      vault_sha256: ${{ steps.shipped.outputs.sha256 }}\n", "")),
    ["vault-sandbox-build does not check the shipped vault and hand its sha256 to the shards"]);
  assert.deepEqual(cacheProblems(plant("vault-sandbox-build", 'node contracts/vault/scripts/shipped.mjs "$RUNNER_TEMP/vault-wasm/blindfill_vault.wasm"\n', "true\n")),
    ["vault-sandbox-build does not check the shipped vault and hand its sha256 to the shards"]);
  assert.deepEqual(cacheProblems(plant("vault-sandbox-shard", "          VAULT_WASM_SHA256: ${{ needs.vault-sandbox-build.outputs.vault_sha256 }}\n", "")),
    ["a shard does not check its vault wasm against the build job's sha256"]);
  assert.deepEqual(cacheProblems(plant("vault-sandbox-build", "cargo-near-v0.22.0/", "cargo-near-v0.23.0/")),
    ["s17, s20 start contracts/vault/scripts/deploy.mjs, which builds with cargo-near, and the shards do not install it"]);
  assert.deepEqual(cacheProblems(plant("vault-sandbox-shard", 'VAULT_WASM_DIR="$RUNNER_TEMP/vault-wasm" contracts', "contracts")),
    ["a shard does not run on the built wasm"]);
  assert.deepEqual(cacheProblems(plant("vault-sandbox-shard", "      - uses: actions/download-artifact", "      - run: contracts/vault/tests/harness/run.sh --build-only x\n      - uses: actions/download-artifact")),
    ["a shard builds wasm"]);
  const noNear = ci.slice(0, at("vault-sandbox-shard")) + ci.slice(at("vault-sandbox-shard")).replace(/      - name: install cargo-near\n[\s\S]*?near --version\n/, "");
  assert.notEqual(noNear, ci);
  assert.deepEqual(cacheProblems(noNear), ["s17, s20 start contracts/vault/scripts/deploy.mjs, which builds with cargo-near, and the shards do not install it"]);
  assert.deepEqual(cacheProblems(plant("vault-sandbox-shard", "rustup toolchain install 1.96.0 --profile minimal --target wasm32-unknown-unknown", "rustup toolchain install 1.96.0 --profile minimal")),
    ["s17, s20 start contracts/vault/scripts/deploy.mjs, which builds with cargo-near, and the shards do not install it"]);
  assert.deepEqual(cacheProblems(plant("vault-sandbox-shard", 'CARGO_PROFILE_DEV_DEBUG: "0"', 'CARGO_PROFILE_DEV_DEBUG: "1"')),
    ["the build and the shards hold different env, so the shards miss the build's rust-cache entry"]);
  assert.deepEqual(cacheProblems(plant("vault-sandbox-shard", "shared-key: vault-sandbox", "shared-key: vault-sandbox-shard")),
    ["the shards do not read the build's rust-cache entry"]);
  assert.deepEqual(cacheProblems(plant("vault-sandbox-shard", 'save-if: "false"', 'save-if: "true"')), ["a shard saves the rust-cache entry"]);
  assert.deepEqual(cacheProblems(plant("vault-sandbox-shard", "shard: [1, 2, 3, 4]", "shard: [1, 2, 3]")),
    ["the matrix runs shards [1, 2, 3], and SHARDS has [1, 2, 3, 4]"]);
  assert.deepEqual(cacheProblems(ci, [...SHARDS, ["s99"]]), ["the matrix runs shards [1, 2, 3, 4], and SHARDS has [1, 2, 3, 4, 5]"]);
});

// What is wrong with run.sh's vault: on the shards' prebuilt path it must need the build job's sha256 and check the
// vault wasm before any test, and --reproducible must build it as the mainnet deploy does.
function runShProblems(sh) {
  const p = [];
  if (!sh.includes('[ -n "${VAULT_WASM_SHA256:-}" ] || {')) p.push("run.sh loads a prebuilt vault without the build job's sha256");
  if (!/\n  VAULT_WASM=\$\(prebuilt blindfill_vault\)\n  shipped_check "\$VAULT_WASM" "\$VAULT_WASM_SHA256"\n/.test(sh)) p.push("run.sh does not check the prebuilt vault wasm against the shipped build and the sha256");
  if (!/\n  node "\$V\/scripts\/deploy\.mjs" --build-only --flavor mainnet --build-dir "\$d" >&2 \|\| exit \$\?\n/.test(sh)) p.push("run.sh --reproducible does not build the vault as the mainnet deploy does (deploy.mjs --build-only --flavor mainnet)");
  if (!/\n    VAULT_WASM=\$\(shipped_build\)\n    shipped_check "\$VAULT_WASM"\n/.test(sh)) p.push("run.sh --reproducible does not check the vault it built");
  if (!/\n  node "\$V\/scripts\/shipped\.mjs" "\$@" >&2\n/.test(sh)) p.push("run.sh's check is not contracts/vault/scripts/shipped.mjs");
  if (sh.indexOf("shipped_check \"$VAULT_WASM\" \"$VAULT_WASM_SHA256\"") > sh.indexOf("cargo $TC test")) p.push("run.sh checks the vault after the tests");
  return p;
}

test("run.sh checks the vault wasm a shard loads, and --reproducible builds the shipped one", () => {
  assert.deepEqual(runShProblems(readFileSync(path.join(ROOT, "contracts/vault/tests/harness/run.sh"), "utf8")), []);
});

test("planted: a run.sh that loads any vault, or builds it otherwise, fails", () => {
  const sh = readFileSync(path.join(ROOT, "contracts/vault/tests/harness/run.sh"), "utf8");
  const plant = (a, b) => {
    const out = sh.replace(a, b);
    assert.notEqual(out, sh, `the plant ${a} changed nothing`);
    return runShProblems(out);
  };
  assert.deepEqual(plant('  shipped_check "$VAULT_WASM" "$VAULT_WASM_SHA256"\n', ""), ["run.sh does not check the prebuilt vault wasm against the shipped build and the sha256"]);
  assert.deepEqual(plant('[ -n "${VAULT_WASM_SHA256:-}" ] || {', "true || {"), ["run.sh loads a prebuilt vault without the build job's sha256"]);
  assert.deepEqual(plant("--build-only --flavor mainnet --build-dir", "--build-only --flavor testnet --build-dir"), ["run.sh --reproducible does not build the vault as the mainnet deploy does (deploy.mjs --build-only --flavor mainnet)"]);
  assert.deepEqual(plant('    VAULT_WASM=$(shipped_build)\n    shipped_check "$VAULT_WASM"\n', '    VAULT_WASM=$(shipped_build)\n'), ["run.sh --reproducible does not check the vault it built"]);
  assert.deepEqual(plant('node "$V/scripts/shipped.mjs" "$@"', 'node "$V/scripts/shipped.mjs" "$1"'), ["run.sh's check is not contracts/vault/scripts/shipped.mjs"]);
});
