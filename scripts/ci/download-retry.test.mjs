// The download-retry gate (download-retry.mjs) on planted workflows: a curl without curl's own retry, a wget, an apt-get
// with no Acquire::Retries, a rustup, cargo or git install outside scripts/ci/retry.sh, and a foundry-toolchain step with
// no second run are each refused by file and line; the repo's own workflows pass. And retry.sh itself: three tries, a
// pause between them, the last try's exit code.
//   node --test scripts/ci/download-retry.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadRetry, refusals, withoutHeldRetries } from "./download-retry.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(ROOT, "scripts/ci/download-retry.mjs");
const RETRY = join(ROOT, "scripts/ci/retry.sh");
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
  // not dead rules: the curls, the rustup installs and the foundry pair are there, and each is held
  assert.ok(ci.split(`curl -sSfL ${FLAGS}`).length - 1 >= 4);
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
  assert.equal(r.filter((x) => x.includes("a curl without")).length, 4, r.join("\n"));
  assert.equal(r.filter((x) => x.includes("rustup toolchain install not run through")).length, 4, r.join("\n"));
  assert.equal(r.filter((x) => x.includes("git submodule update not run through")).length, 1, r.join("\n"));
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
