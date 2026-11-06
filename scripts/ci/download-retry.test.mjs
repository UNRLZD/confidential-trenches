// The download-retry gate (download-retry.mjs) on planted workflows: a curl without curl's own retry, a wget, an apt-get
// with no Acquire::Retries, a rustup, cargo or git install outside scripts/ci/retry.sh, and a foundry-toolchain step with
// no second run are each refused by file and line; the repo's own workflows pass. And retry.sh itself: three tries, a
// pause between them, the last try's exit code. Card ci-cargo-near-cached: a curl to a file, a fetch.sh or a Playwright
// install with no cache in front of it are refused, and fetch.sh itself uses a matching cached file with no request,
// refuses a bad one and fails on bad bytes. Card ci-cargo-fetch-retry: a cargo command with no retried
// `cargo fetch --locked` of its manifest before it, a fetch with no retry or no registry cache, a script that builds
// crates itself and a container build of deploy.mjs outside retry.sh are refused; fresh-dir.sh clears a dir for a retry.
//   node --test scripts/ci/download-retry.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadRetry, refusals, cacheRefusals, cargoRefusals, fetchScriptRefusals, withoutHeldRetries } from "./download-retry.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(ROOT, "scripts/ci/download-retry.mjs");
const RETRY = join(ROOT, "scripts/ci/retry.sh");
const FETCH = join(ROOT, "scripts/ci/fetch.sh");
const FLAGS = "--retry 6 --retry-all-errors";
const SHA = "908c540300062bd5a7e473851cdb4282204cee09";

const job = (steps) => `name: x\non: push\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n${steps}`;
const run = (body) => `      - name: s\n        run: |\n${body.split("\n").map((l) => `          ${l}`).join("\n")}\n`;
const foundry = (extra = "", version = "v1.7.1") => `      - ${extra}uses: foundry-rs/foundry-toolchain@${SHA} # v1.9.1\n        with:\n          version: ${version}\n`;
const PAIR = `      - id: foundry\n        continue-on-error: true\n        uses: foundry-rs/foundry-toolchain@${SHA} # v1.9.1\n        with:\n          version: v1.7.1\n      - if: steps.foundry.outcome == 'failure'\n        run: sleep 30\n      - if: steps.foundry.outcome == 'failure'\n        uses: foundry-rs/foundry-toolchain@${SHA} # v1.9.1\n        with:\n          version: v1.7.1\n`;
const what = (yml) => refusals(yml).map(([line, w]) => `${line}: ${w.split(": ")[0]}`);

test("the repo's own workflows and actions pass, and their downloads are the ones the rules read", () => {
  const r = downloadRetry(ROOT);
  assert.deepEqual(r.refusals, []);
  assert.ok(r.read >= 4, `${r.read} files read`);
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  // not dead rules: the pinned files (each through fetch.sh, whose curl carries the flags), the rustup installs and
  // the foundry pair are there, and each is held
  assert.ok(ci.split("bash scripts/ci/fetch.sh ~/.cache/ci-downloads/").length - 1 >= 4);
  assert.ok(readFileSync(FETCH, "utf8").includes(`curl -sSfL ${FLAGS} -o`));
  assert.ok(ci.split("bash scripts/ci/retry.sh rustup toolchain install").length - 1 >= 4);
  assert.match(ci, /- id: foundry\n\s+continue-on-error: true\n\s+uses: foundry-rs\/foundry-toolchain@/);
  assert.match(readFileSync(join(ROOT, ".github/actions/chrome/action.yml"), "utf8"), /Acquire::Retries=5/);
});

test("main's workflows before this card: every download without its retry is refused", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const before = ci
    .replaceAll(` ${FLAGS}`, "")
    .replaceAll("bash scripts/ci/retry.sh ", "")
    .replace(/- id: foundry\n\s+continue-on-error: true\n(\s+)uses:/, "- uses:");
  const r = what(before);
  // the curls are fetch.sh's now: its one curl without the flags is refused as a workflow's
  assert.deepEqual(fetchScriptRefusals(readFileSync(FETCH, "utf8").replaceAll(` ${FLAGS}`, "")).map(([, w]) => w.split(": ")[0]), ["a curl without --retry 6 --retry-all-errors"]);
  assert.equal(r.filter((x) => x.includes("rustup toolchain install not run through")).length, 4, r.join("\n"));
  // the EVM pool's forge-std, in test-scripts and in slither (card pool-review-3)
  assert.equal(r.filter((x) => x.includes("git submodule update not run through")).length, 2, r.join("\n"));
  assert.ok(r.some((x) => x.includes("a foundry-toolchain step without an id")), r.join("\n"));
});

test("curl: each of the three flags is needed, on any line of a continued command; a comment is not a command", () => {
  assert.deepEqual(what(job(run(`curl -sSfL ${FLAGS} -o f https://x/y`))), []);
  assert.deepEqual(what(job(run(`curl -sSfL -o f \\\n  ${FLAGS} \\\n  https://x/y\necho ok | sha256sum -c -`))), []);
  assert.deepEqual(what(job(run("# curl -sSfL https://x/y with no flags, in a comment\necho done"))), []);
  assert.deepEqual(what(job(run("curl -sSfL -o f https://x/y"))), ["9: a curl without --retry 6 --retry-all-errors"]);
  assert.deepEqual(what(job(run("curl -sSfL --retry 6 -o f https://x/y"))), ["9: a curl without --retry 6 --retry-all-errors"]);
  assert.deepEqual(what(job(run("curl -sSfL --retry 5 --retry-all-errors -o f https://x/y"))), ["9: a curl without --retry 6 --retry-all-errors"]);
  assert.deepEqual(what(job(run("curl -sSfL --retry-all-errors -o f https://x/y"))), ["9: a curl without --retry 6 --retry-all-errors"]);
  // a --retry-delay turns off curl's doubling wait (the brief's first flags: five tries in about 10 s)
  assert.deepEqual(what(job(run("curl -sSfL --retry 6 --retry-all-errors --retry-delay 2 -o f https://x/y"))), ["9: a curl with --retry-delay, which turns off curl's doubling wait"]);
  assert.deepEqual(what(job(run("curl -sSfL --retry 5 --retry-all-errors --retry-delay 2 -o f https://x/y"))), ["9: a curl without --retry 6 --retry-all-errors", "9: a curl with --retry-delay, which turns off curl's doubling wait"]);
  // a one-line run: and a curl piped into another command
  assert.deepEqual(what(job("      - run: curl -sSfL https://x/y | tar -xz\n")), ["7: a curl without --retry 6 --retry-all-errors"]);
  assert.deepEqual(what(job(run(`echo a && curl -sSfL ${FLAGS} https://x/y | tar -xz`))), []);
});

test("wget is refused; apt-get needs Acquire::Retries in its step", () => {
  assert.deepEqual(what(job(run("wget https://x/y"))), ["9: a wget, with no retry here; use curl --retry 6 --retry-all-errors"]);
  assert.deepEqual(what(job(run("sudo apt-get update\nsudo apt-get install -y z"))), ["9: an apt-get in a step that sets no Acquire::Retries", "10: an apt-get in a step that sets no Acquire::Retries"]);
  assert.deepEqual(what(job(run('APT=(-o Acquire::Retries=5)\nsudo apt-get "${APT[@]}" update'))), []);
  // or an apt.conf line the step writes
  assert.deepEqual(what(job(run(`printf 'Acquire::Retries "5";\\n' | sudo tee /etc/apt/apt.conf.d/90x\nsudo apt-get update`))), []);
  assert.deepEqual(what(job(run(`printf 'Acquire::Queue-Mode "host";\\n' | sudo tee /etc/apt/apt.conf.d/90x\nsudo apt-get update`))), ["10: an apt-get in a step that sets no Acquire::Retries"]);
  // the option set in another step does not count
  assert.deepEqual(what(job(run("A=(-o Acquire::Retries=5)") + run("sudo apt-get update"))), ["12: an apt-get in a step that sets no Acquire::Retries"]);
});

test("rustup, cargo install and git submodule update run only through scripts/ci/retry.sh", () => {
  assert.deepEqual(what(job(run("bash scripts/ci/retry.sh rustup toolchain install 1.96.0 --profile minimal"))), []);
  assert.deepEqual(what(job("      - run: bash scripts/ci/retry.sh git submodule update --init lib/x\n")), []);
  assert.deepEqual(what(job(run("rustup toolchain install 1.96.0 --profile minimal\ncargo +1.96.0 test"))), ["9: rustup toolchain install not run through scripts/ci/retry.sh"]);
  assert.deepEqual(what(job(run("rustup target add wasm32-unknown-unknown"))), ["9: rustup target add not run through scripts/ci/retry.sh"]);
  assert.deepEqual(what(job(run("cargo +1.96.0 install cargo-near --locked"))), ["9: cargo +1.96.0 install not run through scripts/ci/retry.sh"]);
  assert.deepEqual(what(job("      - run: git submodule update --init lib/x\n")), ["7: git submodule update not run through scripts/ci/retry.sh"]);
  // retry.sh on another command of the line does not cover it
  assert.deepEqual(what(job(run("bash scripts/ci/retry.sh true && rustup toolchain install 1.96.0"))), ["9: rustup toolchain install not run through scripts/ci/retry.sh"]);
  // coreutils install is not cargo install
  assert.deepEqual(what(job(run('install -m 0755 a "$HOME/.cargo/bin/cargo-near"'))), []);
});

test("foundry-toolchain: a first step that may fail, then the same action and version once more on its failure", () => {
  assert.deepEqual(what(job(PAIR)), []);
  assert.deepEqual(what(job(foundry())), ["7: a foundry-toolchain step without an id and continue-on-error"]);
  // (its second run, now with no first step, is refused too)
  assert.deepEqual(what(job(PAIR.replace("        continue-on-error: true\n", ""))), ["8: a foundry-toolchain step without an id and continue-on-error", "14: a foundry-toolchain retry with no first step before it"]);
  assert.deepEqual(what(job(PAIR.replace(/      - if: steps\.foundry\.outcome == 'failure'\n        uses:[^]*$/, ""))), ["9: a foundry-toolchain step with no second run after it (if"]);
  assert.deepEqual(what(job(PAIR.replace("- if: steps.foundry.outcome == 'failure'\n        uses", "- if: steps.other.outcome == 'failure'\n        uses"))), ["9: a foundry-toolchain step with no second run after it (if", "15: a foundry-toolchain retry with no first step before it"]);
  assert.deepEqual(what(job(PAIR.replace(/version: v1\.7\.1\n$/, "version: v1.6.0\n"))), ["15: a foundry-toolchain second run that is not the same action and version, or does not fail the job"]);
  assert.deepEqual(what(job(PAIR.replace(/(- if: steps\.foundry\.outcome == 'failure'\n)(        uses)/, "$1        continue-on-error: true\n$2"))), ["16: a foundry-toolchain second run that is not the same action and version, or does not fail the job"]);
  assert.deepEqual(what(job(foundry("if: steps.foundry.outcome == 'failure'\n        "))), ["8: a foundry-toolchain retry with no first step before it"]);
});

test("a pair holds only within one job, and only a held pair's continue-on-error is blanked for the shard rule", () => {
  // the second run in another job is no second run of this one
  const split = PAIR.replace("      - if: steps.foundry.outcome == 'failure'\n        run: sleep 30\n", "      - if: steps.foundry.outcome == 'failure'\n        run: sleep 30\n  b:\n    runs-on: ubuntu-24.04\n    steps:\n");
  assert.ok(what(job(split)).includes("9: a foundry-toolchain step with no second run after it (if"), what(job(split)).join("\n"));
  assert.doesNotMatch(withoutHeldRetries(job(split)), /# a held retry/);
  const held = withoutHeldRetries(job(PAIR));
  assert.doesNotMatch(held, /continue-on-error/);
  assert.equal(held.split("\n").length, job(PAIR).split("\n").length);
  // any other step's continue-on-error stays for the shard rule to refuse
  const other = job(PAIR + "      - continue-on-error: true\n        run: \"true\"\n");
  assert.equal(withoutHeldRetries(other).split("continue-on-error").length - 1, 1);
  assert.equal(withoutHeldRetries(job(foundry("id: foundry\n        continue-on-error: true\n        "))).split("continue-on-error").length - 1, 1);
});

test("the command line: exit 1 with one line per refusal, exit 0 on held workflows, exit 1 on none read", () => {
  const dir = mkdtempSync(join(tmpdir(), "download-retry-"));
  try {
    const cli = () => spawnSync(process.execPath, [GATE, dir], { encoding: "utf8" });
    assert.equal(cli().status, 1);
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    mkdirSync(join(dir, ".github/actions/b"), { recursive: true });
    writeFileSync(join(dir, ".github/workflows/a.yml"), job(run("curl -sSfL https://x/y")));
    writeFileSync(join(dir, ".github/actions/b/action.yml"), `runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: |\n        sudo apt-get update\n`);
    const r = cli();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /REFUSED: \.github\/workflows\/a\.yml:9: a curl without/);
    assert.match(r.stderr, /REFUSED: \.github\/actions\/b\/action\.yml:6: an apt-get/);
    writeFileSync(join(dir, ".github/workflows/a.yml"), job(run(`curl -sSfL ${FLAGS} https://x/y`) + PAIR));
    writeFileSync(join(dir, ".github/actions/b/action.yml"), `runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: sudo apt-get -o Acquire::Retries=5 update\n`);
    const ok = cli();
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /download-retry: OK \(2 workflow file\(s\) read\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Card ci-cargo-near-cached: the cache rules on planted workflows
const CACHE = "55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0";
const SUM = "9429064e30a427e96523f539cb255f3688d2345e5000d7d4e4873a8247247d1a";
const FILE = "~/.cache/ci-downloads/cargo-near-0.22.0.tgz";
const cache = (kind, { path = FILE, key = `download-cargo-near-0.22.0-${SUM}`, id = "tgz" } = {}) =>
  `      - id: ${id}\n        uses: actions/cache${kind}@${CACHE}\n        with:\n          path: ${path}\n          key: ${key}\n`;
const FETCHING = run(`bash scripts/ci/fetch.sh ${FILE} ${SUM} \\\n  https://github.com/near/cargo-near/releases/download/cargo-near-v0.22.0/x.tar.gz\ntar -xzf ${FILE}`);
const PW_PATHS = "|\n            ~/.cache/ms-playwright\n            ~/.cache/playwright-debs";
const PW = run(`debs="$HOME/.cache/playwright-debs"\nprintf 'Dir::Cache::Archives "%s/";\\n' "$debs" | sudo tee /etc/apt/apt.conf.d/90x\ntimeout -k 10 180 pnpm exec playwright install --with-deps $ENGINES`);
// each refusal as "line: what", without the command a curl or fetch.sh refusal quotes after its last ": "
const cached = (yml) => cacheRefusals(yml).map(([line, w]) => `${line}: ${/^a (curl to a file|scripts\/ci\/fetch\.sh without)/.test(w) ? w.split(": ")[0] : w}`);

test("cache: the repo's own workflows hold every pinned file and Playwright install behind a cache, main's did not", () => {
  for (const f of ["ci.yml", "vault-build.yml", "live.yml"]) assert.deepEqual(cacheRefusals(readFileSync(join(ROOT, ".github/workflows", f), "utf8")), [], f);
  // main's steps before this card, each a download on every run: refused where they stood
  const curl = (name, sum, url) => job(run(`curl -sSfL ${FLAGS} -o "$RUNNER_TEMP/${name}" \\\n  ${url}\necho "${sum}  $RUNNER_TEMP/${name}" | sha256sum -c -`));
  assert.deepEqual(cached(curl("cargo-near.tgz", SUM, "https://github.com/near/cargo-near/releases/download/cargo-near-v0.22.0/x.tar.gz")), ["9: a curl to a file"]);
  assert.deepEqual(cached(job(run("pnpm --filter terminal exec playwright install --with-deps $ENGINES"))), ["9: a playwright install of system packages with no cache step before it in its job", "9: a playwright install of system packages with no timeout on its command line: a crawling mirror holds it to the job's limit"]);
});

test("cache: a fetch.sh needs a cache before it in its job, holding its file, keyed on its sha256, and saved", () => {
  assert.deepEqual(cached(job(cache("/restore") + FETCHING + cache("/save"))), []);
  assert.deepEqual(cached(job(cache("") + FETCHING)), []);
  assert.deepEqual(cached(job(FETCHING)), [`9: a scripts/ci/fetch.sh of ${FILE} (sha256 9429064e) with no cache step before it in its job`]);
  // after it, not before
  assert.deepEqual(cached(job(FETCHING + cache(""))), [`9: a scripts/ci/fetch.sh of ${FILE} (sha256 9429064e) with no cache step before it in its job`]);
  // a key that does not name the sha256 (a bad file under a version-only key would be served forever)
  assert.deepEqual(cached(job(cache("", { key: "download-cargo-near-0.22.0" }) + FETCHING)).length, 1);
  // a path that does not hold the file
  assert.deepEqual(cached(job(cache("", { path: "~/.cache/other.tgz" }) + FETCHING)).length, 1);
  assert.deepEqual(cached(job(cache("", { path: "$HOME/.cache/ci-downloads/cargo-near-0.22.0.tgz" }) + FETCHING)), []);
  // a restore that is never saved never fills; a save of another key does not count
  assert.deepEqual(cached(job(cache("/restore") + FETCHING)), [`14: a scripts/ci/fetch.sh of ${FILE} (sha256 9429064e): its cache is an actions/cache/restore with no actions/cache/save of the same path and key after it`]);
  assert.deepEqual(cached(job(cache("/restore") + FETCHING + cache("/save", { key: "other" }))).length, 1);
  // a cache in another job is no cache of this one
  const other = `${cache("")}  b:\n    runs-on: ubuntu-24.04\n    steps:\n${FETCHING}`;
  assert.deepEqual(cached(job(other)).length, 1);
  // a fetch.sh without its three arguments
  assert.deepEqual(cached(job(cache("") + run(`bash scripts/ci/fetch.sh ${FILE} nope https://x/y`))), ["14: a scripts/ci/fetch.sh without a file, a sha256 and a url"]);
});

test("cache: a curl to a file is refused but an apt repository's key checked by its fingerprint; a curl to a pipe is not a file", () => {
  for (const flag of ["-o f", "--output f", "-O", "-sSfLo f"]) assert.deepEqual(cached(job(run(`curl -sSfL ${FLAGS} ${flag} https://x/y`))), ["9: a curl to a file"], flag);
  assert.deepEqual(cached(job(run(`curl -sSfL ${FLAGS} https://x/y | jq .`))), []);
  assert.deepEqual(cached(job(run(`curl -sSfL ${FLAGS} -o k.pub https://x/key.pub\nfpr="$(gpg --show-keys --with-colons k.pub)"`))), []);
  // the repo's one such curl is the Chrome action's key
  assert.match(readFileSync(join(ROOT, ".github/actions/chrome/action.yml"), "utf8"), /gpg --show-keys/);
});

test("cache: a Playwright install needs ms-playwright cached, and one with system packages keeps apt's .debs in it", () => {
  const ok = job(cache("/restore", { path: PW_PATHS, key: "pw" }) + PW + cache("/save", { path: PW_PATHS, key: "pw" }));
  assert.deepEqual(cached(ok), []);
  assert.deepEqual(cached(job(PW)), ["11: a playwright install of system packages with no cache step before it in its job"]);
  // the .debs dir not in the cache
  assert.deepEqual(cached(job(cache("", { path: "~/.cache/ms-playwright", key: "pw" }) + PW)).length, 1);
  // the cache holds a dir, but the step keeps no .debs in it
  assert.deepEqual(cached(ok.replace(/printf .*\n/, "")), ["17: a playwright install of system packages that does not keep apt's .debs (Dir::Cache::Archives) for its cache"]);
  assert.deepEqual(cached(job(run("timeout 180 pnpm exec playwright install-deps webkit"))).length, 1);
  // unbounded: a miss meets the mirror, and a crawl held live job 127357435385 to its 20 min limit
  assert.deepEqual(cached(ok.replace("timeout -k 10 180 pnpm", "pnpm")), ["18: a playwright install of system packages with no timeout on its command line: a crawling mirror holds it to the job's limit"]);
  // a timeout on another command of the line does not bound this one; one in a function around it does
  assert.deepEqual(cached(ok.replace("timeout -k 10 180 pnpm", "timeout 180 true; pnpm")).length, 1);
  assert.deepEqual(cached(ok.replace("timeout -k 10 180 pnpm exec playwright install --with-deps $ENGINES", "deps() { timeout 3m pnpm exec playwright install --with-deps $ENGINES; }")), []);
  // the browsers alone need ms-playwright; a dry run fetches nothing
  assert.deepEqual(cached(job(cache("", { path: "~/.cache/ms-playwright", key: "pw" }) + run("pnpm exec playwright install webkit"))), []);
  assert.deepEqual(cached(job(run("pnpm exec playwright install webkit"))).length, 1);
  assert.deepEqual(cached(job(run("pnpm exec playwright install-deps --dry-run webkit"))), []);
});

test("fetch.sh: a cached file that matches is used with no request; a bad one is refused and fetched again; bad bytes fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-sh-"));
  try {
    const good = join(dir, "good.bin");
    writeFileSync(good, "the release bytes\n");
    const sum = spawnSync("sha256sum", [good], { encoding: "utf8" }).stdout.split(" ")[0];
    const file = join(dir, "cache/sub/x.bin");
    const fetch = (url, s = sum, env = process.env) => spawnSync("bash", [FETCH, file, s, url], { encoding: "utf8", env });
    // a host that answers 504 to every try: a curl on PATH that fails at once, so the test waits out no retry
    mkdirSync(join(dir, "down"));
    writeFileSync(join(dir, "down/curl"), `#!/bin/sh\necho "curl: (22) The requested URL returned error: 504" >&2\nexit 22\n`);
    chmodSync(join(dir, "down/curl"), 0o755);
    const down = { ...process.env, PATH: `${join(dir, "down")}:${process.env.PATH}` };
    // a miss: fetched (curl reads file:// as it reads https), checked, kept at the cache's path
    let r = fetch(`file://${good}`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /fetched from file:/);
    assert.equal(readFileSync(file, "utf8"), "the release bytes\n");
    // a hit: no request (the host is down)
    r = fetch(`https://github.com/near/cargo-near/releases/download/x`, sum, down);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /from the cache, sha256/);
    // a poisoned entry: refused, fetched again, and the good bytes replace it
    writeFileSync(file, "planted\n");
    r = fetch(`file://${good}`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /::warning::fetch\.sh: the cached .* is not sha256/);
    assert.equal(readFileSync(file, "utf8"), "the release bytes\n");
    // a poisoned entry and the host down: the step fails, and nothing is left for the save
    writeFileSync(file, "planted\n");
    r = fetch(`https://github.com/near/cargo-near/releases/download/x`, sum, down);
    assert.equal(r.status, 22);
    assert.match(r.stderr, /504/);
    assert.throws(() => readFileSync(file));
    // a host that serves other bytes: refused, nothing kept
    writeFileSync(join(dir, "evil.bin"), "other bytes\n");
    r = fetch(`file://${dir}/evil.bin`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not sha256/);
    assert.throws(() => readFileSync(file));
    assert.throws(() => readFileSync(`${file}.part`));
    // not a sha256, or a missing argument
    assert.equal(fetch(`file://${good}`, "abc").status, 2);
    assert.equal(spawnSync("bash", [FETCH, file, sum], { encoding: "utf8" }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retry.sh: three tries with a pause between, and the last try's exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "retry-sh-"));
  try {
    // a sleep on PATH that only records its argument, so the test does not wait
    writeFileSync(join(dir, "sleep"), `#!/bin/sh\necho "$1" >> "${dir}/slept"\n`);
    chmodSync(join(dir, "sleep"), 0o755);
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    const slept = () => { try { return readFileSync(join(dir, "slept"), "utf8").trim().split("\n"); } catch { return []; } };
    // fails twice, then passes
    const flaky = `n=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/n"; [ $n -ge 3 ]`;
    let r = spawnSync("bash", [RETRY, "sh", "-c", flaky], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, "n"), "utf8").trim(), "3");
    assert.deepEqual(slept(), ["20", "20"]);
    assert.match(r.stderr, /retry\.sh: try 1 of 3 ended 1: sh -c/);
    // always fails: three tries, two pauses, its own exit code
    rmSync(join(dir, "slept"), { force: true });
    writeFileSync(join(dir, "n"), "");
    r = spawnSync("bash", [RETRY, "sh", "-c", `echo x >> "${dir}/n"; exit 7`], { env, encoding: "utf8" });
    assert.equal(r.status, 7);
    assert.equal(readFileSync(join(dir, "n"), "utf8").trim().split("\n").length, 3);
    assert.deepEqual(slept(), ["20", "20"]);
    // passes at once: no pause, its arguments passed as they are
    rmSync(join(dir, "slept"), { force: true });
    r = spawnSync("bash", [RETRY, "sh", "-c", 'test "$1" = "a b"', "_", "a b"], { env, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.deepEqual(slept(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Card ci-cargo-fetch-retry: the cargo rules on planted workflows
const RC = "      - uses: Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0 # v2.9.3\n";
const REG = `      - uses: actions/cache@${CACHE}\n        with:\n          path: |\n            ~/.cargo/registry/index\n            ~/.cargo/registry/cache\n            target\n          key: k\n`;
const FETCH_V = "bash scripts/ci/retry.sh cargo +1.96.0 fetch --locked --manifest-path contracts/vault/Cargo.toml";
const TEST_V = "cargo +1.96.0 test --locked --manifest-path contracts/vault/Cargo.toml";
// each refusal as "line: what", without the command it quotes after its last ": "
const cargoWhat = (yml) => cargoRefusals(yml).map(([line, w]) => `${line}: ${w.split(": ")[0]}`);

test("cargo: the repo's own workflows fetch every manifest they build with retry first", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  for (const f of ["ci.yml", "vault-build.yml", "live.yml", "readme-fresh-run.yml"]) assert.deepEqual(cargoRefusals(readFileSync(join(ROOT, ".github/workflows", f), "utf8")), [], f);
  // not a dead rule: the retried fetches are there, one per manifest a job builds
  assert.ok(ci.split("bash scripts/ci/retry.sh cargo +").length - 1 >= 9, "the retried fetches");
  assert.match(readFileSync(join(ROOT, ".github/workflows/vault-build.yml"), "utf8"), /retry\.sh bash scripts\/ci\/fresh-dir\.sh .*deploy\.mjs --build-only/);
});

test("cargo: main's workflows before this card, each cargo step without its fetch, are refused where they stood", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const before = ci.split("\n").filter((l) => !/retry\.sh cargo \+\S+ fetch /.test(l)).join("\n");
  const r = cargoWhat(before);
  assert.equal(r.filter((x) => x.includes("a cargo test of contracts/vault/Cargo.toml")).length, 2, r.join("\n")); // test-vault and the sandbox build's --no-run
  assert.equal(r.filter((x) => x.includes("harness/run.sh")).length, 2, r.join("\n"));
  assert.equal(r.filter((x) => x.includes("a cargo-build-sbf of")).length, 2, r.join("\n"));
  assert.equal(r.filter((x) => x.includes("a cargo test of contracts/pool-solana")).length, 2, r.join("\n"));
  assert.equal(r.filter((x) => x.includes("dry-run.sh")).length, 1, r.join("\n"));
  const vb = readFileSync(join(ROOT, ".github/workflows/vault-build.yml"), "utf8").replaceAll("bash scripts/ci/retry.sh bash scripts/ci/fresh-dir.sh \"$RUNNER_TEMP/vault-mainnet\" ", "").replaceAll("bash scripts/ci/retry.sh bash scripts/ci/fresh-dir.sh \"$RUNNER_TEMP/vault-records\" ", "");
  assert.equal(cargoRefusals(vb).length, 2, "the two container builds");
});

test("cargo: a build needs a retried fetch of its own manifest first, in its job; retry.sh on the build itself also holds", () => {
  assert.deepEqual(cargoWhat(job(RC + run(`${FETCH_V}\n${TEST_V}`))), []);
  assert.deepEqual(cargoWhat(job(RC + run(`bash scripts/ci/retry.sh ${TEST_V}`))), []);
  // the fetch in an earlier step, with the toolchain left out or another one
  assert.deepEqual(cargoWhat(job(RC + run("bash scripts/ci/retry.sh cargo fetch --locked --manifest-path contracts/vault/Cargo.toml") + run(TEST_V))), []);
  assert.deepEqual(cargoWhat(job(run(TEST_V))), ["9: a cargo test of contracts/vault/Cargo.toml with no scripts/ci/retry.sh cargo fetch --locked of it before it in its job"]);
  for (const sub of ["build", "check", "clippy", "run", "bench", "doc", "tree", "near build reproducible-wasm"]) {
    assert.equal(cargoWhat(job(run(`cargo +1.96.0 ${sub} --locked`))).length, 1, sub);
  }
  // the fetch comes after the build, or is for another manifest, or sits in another job: not before it
  assert.equal(cargoWhat(job(RC + run(`${TEST_V}\n${FETCH_V}`))).length, 1);
  assert.equal(cargoWhat(job(RC + run(`${FETCH_V}\ncargo +1.96.0 test --locked --manifest-path contracts/other/Cargo.toml`))).length, 1);
  const two = job(RC + run(FETCH_V)) + `  b:\n    runs-on: ubuntu-24.04\n    steps:\n${run(TEST_V)}`;
  assert.equal(cargoWhat(two).length, 1);
  // a working-directory is the manifest's folder; a path is read as the same one however it is spelt
  assert.deepEqual(cargoWhat(job(RC + run(FETCH_V) + `      - working-directory: contracts/vault\n        run: cargo test --locked\n`)), []);
  assert.equal(cargoWhat(job(RC + run(FETCH_V) + `      - working-directory: contracts/pool-solana\n        run: cargo-build-sbf --sbf-out-dir out -- --locked\n`)).length, 1);
  assert.deepEqual(cargoWhat(job(RC + run("bash scripts/ci/retry.sh cargo fetch --locked --manifest-path ./contracts//vault/Cargo.toml\n" + TEST_V))), []);
  // what reads no registry is no build: a version, a comment, a metadata read with --no-deps, a cargo install (its own rule)
  assert.deepEqual(cargoWhat(job(run("cargo +1.96.0 near --version\ncargo-build-sbf --version | sed s/a/b/\n# cargo test\ncargo metadata --no-deps --locked"))), []);
  assert.equal(cargoWhat(job(run("cargo metadata --locked"))).length, 1);
});

test("cargo: a fetch runs through retry.sh with --locked, and in a job that caches cargo's registry", () => {
  assert.deepEqual(cargoWhat(job(RC + run("cargo +1.96.0 fetch --locked --manifest-path contracts/vault/Cargo.toml"))), ["10: a cargo fetch not run through scripts/ci/retry.sh"]);
  assert.deepEqual(cargoWhat(job(RC + run("bash scripts/ci/retry.sh cargo fetch --manifest-path contracts/vault/Cargo.toml"))), ["10: a cargo fetch without --locked"]);
  assert.deepEqual(cargoWhat(job(run(FETCH_V))).map((x) => x.split(" (")[0]), ["9: a cargo fetch in a job with no cache of cargo's registry before it"]);
  assert.deepEqual(cargoWhat(job(REG + run(`${FETCH_V}\n${TEST_V}`))), []);
  // a cache of something else, a cache saved alone and a cache after the fetch are no registry cache
  assert.equal(cargoWhat(job(`      - uses: actions/cache@${CACHE}\n        with:\n          path: target\n          key: k\n` + run(FETCH_V))).length, 1);
  assert.equal(cargoWhat(job(REG.replace("actions/cache@", "actions/cache/save@") + run(FETCH_V))).length, 1);
  assert.equal(cargoWhat(job(run(FETCH_V) + RC)).length, 1);
});

test("cargo: a script that builds crates itself needs every manifest it builds fetched first", () => {
  const F3 = ["contracts/vault/Cargo.toml", "contracts/vault/tests/mock-token/Cargo.toml", "contracts/vault/tests/harness/probe/Cargo.toml"].map((m) => `bash scripts/ci/retry.sh cargo +1.96.0 fetch --locked --manifest-path ${m}`).join("\n");
  assert.deepEqual(cargoWhat(job(RC + run(`${F3}\ncontracts/vault/tests/harness/run.sh --build-only "$RUNNER_TEMP/w"`))), []);
  const some = cargoRefusals(job(RC + run(`${FETCH_V}\ncontracts/vault/tests/harness/run.sh "\${ARGS[@]}"`)));
  assert.equal(some.length, 1);
  assert.match(some[0][1], /harness\/run\.sh, which builds crates itself, with no scripts\/ci\/retry\.sh cargo fetch --locked before it in its job of: contracts\/vault\/tests\/mock-token\/Cargo\.toml, contracts\/vault\/tests\/harness\/probe\/Cargo\.toml/);
  assert.equal(cargoWhat(job(run("bash contracts/pool-solana/scripts/dry-run.sh"))).length, 1);
  assert.deepEqual(cargoWhat(job(REG + run("bash scripts/ci/retry.sh cargo fetch --locked --manifest-path contracts/pool-solana/Cargo.toml\nbash contracts/pool-solana/scripts/dry-run.sh"))), []);
});

test("cargo: deploy.mjs --build-only and --verify-records, built in cargo-near's container, run through retry.sh", () => {
  const D = "node contracts/vault/scripts/deploy.mjs";
  assert.deepEqual(cargoWhat(job(run(`bash scripts/ci/retry.sh bash scripts/ci/fresh-dir.sh "$D" ${D} --build-only --flavor mainnet --build-dir "$D"`))), []);
  assert.deepEqual(cargoWhat(job(run(`${D} --build-only --flavor mainnet 2>&1 | tee b.log`))), ["9: a deploy.mjs build in cargo-near's container, which no fetch from the runner reaches, not run through scripts/ci/retry.sh"]);
  assert.equal(cargoWhat(job(run(`${D} --verify-records --build-dir x`))).length, 1);
  // the other uses of deploy.mjs build nothing
  assert.deepEqual(cargoWhat(job(run(`${D} --network testnet --wasm w.wasm`))), []);
});

test("fresh-dir.sh: removes the dir, then runs the command and gives its exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "fresh-dir-"));
  try {
    const d = join(dir, "build");
    mkdirSync(d);
    writeFileSync(join(d, "left"), "x");
    const r = spawnSync("bash", [join(ROOT, "scripts/ci/fresh-dir.sh"), d, "bash", "-c", `test ! -e ${d}/left && exit 7`], { encoding: "utf8" });
    assert.equal(r.status, 7, r.stderr);
    // through retry.sh: a first try that leaves a file in the dir meets an empty one on its second
    writeFileSync(join(dir, "try.sh"), `n=0; [ -e "${dir}/n" ] && n=$(cat "${dir}/n"); echo $((n+1)) > "${dir}/n"; mkdir -p "$1"; [ -e "$1/left" ] && exit 9; touch "$1/left"; exit 1\n`);
    const fake = join(dir, "bin");
    mkdirSync(fake);
    writeFileSync(join(fake, "sleep"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(fake, "sleep"), 0o755);
    const t = spawnSync("bash", [RETRY, "bash", join(ROOT, "scripts/ci/fresh-dir.sh"), d, "bash", join(dir, "try.sh"), d], { encoding: "utf8", env: { ...process.env, PATH: `${fake}:${process.env.PATH}` } });
    assert.equal(t.status, 1, t.stderr);
    assert.equal(readFileSync(join(dir, "n"), "utf8").trim(), "3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
