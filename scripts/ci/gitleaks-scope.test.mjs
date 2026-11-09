// CI's gitleaks job judges a pull request on its own commits with main's rules (card ci-gitleaks-own-config): a secret
// that only another fetched branch holds never fails it, a secret in its own history does, and a pull request cannot
// pass its own secret with an ignore line or an allowlist of its own. This test finds the gitleaks job's scan steps in
// ci.yml (each run that calls "$RUNNER_TEMP/gitleaks" dir or git) and replays them as GitHub runs a step, in throwaway
// repos laid out as actions/checkout leaves a pull request with fetch-depth 0: every branch under refs/remotes/origin/,
// HEAD detached at the merge of the pull request into main. Each secret is a throwaway 64-byte value made here, with
// the shape of a NEAR secret key (scripts/ci/gitleaks-config.test.mjs makes its own the same way), never a key.
//   node --test scripts/ci/gitleaks-scope.test.mjs      (GITLEAKS=<path> to name the binary; CI's gitleaks job does)
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CI = join(ROOT, '.github/workflows/ci.yml');
const RULES = readFileSync(join(ROOT, '.gitleaks.toml'), 'utf8');
const BIN = resolve(process.env.GITLEAKS
  || execFileSync('bash', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).trim());
const RULE = 'near-ed25519-secret-key';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf) => {
  let n = BigInt(`0x${Buffer.from(buf).toString('hex')}`), s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = `1${s}`; }
  return s;
};
const secret = () => `ed25519:${b58(sign(null, randomBytes(8), generateKeyPairSync('ed25519').privateKey))}`;
const leak = () => `k = "${secret()}"\n`; // a finding on line 1

// the run text of each step of ci.yml's gitleaks job that calls "$RUNNER_TEMP/gitleaks" dir or git, in order
export function scanSteps(yml) {
  const steps = [];
  let inJob = false, cur = null, block = null;
  const flush = () => { if (cur && /"\$RUNNER_TEMP\/gitleaks" (dir|git)\b/.test(cur.join('\n'))) steps.push(cur.join('\n')); cur = null; };
  for (const line of yml.split(/\r?\n/)) {
    const job = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (job) { flush(); inJob = job[1] === 'gitleaks'; block = null; continue; }
    if (!inJob) continue;
    const indent = line.match(/^ */)[0].length;
    if (block !== null && (!line.trim() || indent > block)) { cur.push(line.slice(block + 2)); continue; }
    block = null;
    if (/^ {6}- /.test(line)) { flush(); cur = []; }
    const run = /^( *)(?:- )?run:\s*(.*)$/.exec(line);
    if (!run || !cur) continue;
    if (/^[|>][-+]?\s*$/.test(run[2])) block = run[1].length;
    else cur.push(run[2].replace(/^'(.*)'$/, (_, s) => s.replaceAll("''", "'")).replace(/^"(.*)"$/, '$1'));
  }
  flush();
  return steps;
}

const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A checkout laid out as a pull request's: a root commit with the repo's .gitleaks.toml, then the pull request's
// commits (origin/pr), another branch's (origin/other) and main's (origin/main) on it, in that order, and HEAD detached
// at the merge of origin/pr into origin/main (at origin/main when the pull request has none: a push to main). A commit
// is { path: text | null (deleted) }, or a function of the shas made so far ({ pr, other, main }) that returns one.
function checkout({ pr = [], other = [], main = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'gl-scope-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'work']);
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) { git(repo, ['rm', '-q', '--', path]); continue; }
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
      git(repo, ['add', '--', path]);
    }
    git(repo, ['commit', '-q', '--no-verify', '-m', 'planted']);
    return git(repo, ['rev-parse', 'HEAD']);
  };
  // packages/signpage/ is there as in every pull request: the bundle scan step reads it (its build is a step of its own)
  const root = write({ '.gitleaks.toml': RULES, 'README.md': 'planted\n', 'packages/signpage/README.md': 'planted\n' });
  const shas = { pr: [], other: [], main: [] };
  for (const [name, commits] of [['pr', pr], ['other', other], ['main', main]]) {
    git(repo, ['checkout', '-q', '--detach', root]);
    for (const c of commits) shas[name].push(write(typeof c === 'function' ? c(shas) : c));
    git(repo, ['update-ref', `refs/remotes/origin/${name}`, 'HEAD']);
  }
  git(repo, ['checkout', '-q', '--detach', 'origin/main']);
  if (pr.length) git(repo, ['merge', '-q', '--no-ff', '--no-edit', '--no-verify', 'origin/pr']);
  git(repo, ['update-ref', '-d', 'refs/heads/work']);
  return { dir, repo, shas };
}

// runs the scan steps in order as GitHub runs a step (bash -eo pipefail), stopping at the first that fails
// (beforeStep runs before each step, as a step of CI's that calls no gitleaks would: the bundle's build)
function scan(co, beforeStep = () => {}) {
  const steps = scanSteps(readFileSync(CI, 'utf8'));
  const runnerTemp = join(co.dir, 'runner-temp');
  mkdirSync(runnerTemp);
  symlinkSync(BIN, join(runnerTemp, 'gitleaks'));
  let out = '';
  try {
    for (const step of steps) {
      beforeStep(step);
      const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step], {
        cwd: co.repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, RUNNER_TEMP: runnerTemp },
      });
      out += `${r.stdout}\n${r.stderr}`;
      if (r.status !== 0) return { status: r.status, out };
    }
    return { status: 0, out };
  } finally { rmSync(co.dir, { recursive: true, force: true }); }
}

const fails = (r) => {
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /leaks found: [1-9]/, r.out); // failed on a finding, not on a broken step
};
const passes = (r) => assert.equal(r.status, 0, r.out);

test('ci.yml has a tree scan and a history scan in its gitleaks job', () => {
  const steps = scanSteps(readFileSync(CI, 'utf8')).join('\n');
  assert.match(steps, /"\$RUNNER_TEMP\/gitleaks" dir /);
  assert.match(steps, /"\$RUNNER_TEMP\/gitleaks" git /);
});

test("a secret on another branch only does not fail this pull request", () => {
  passes(scan(checkout({ pr: [{ 'ok.txt': 'fine\n' }], other: [{ 'leak.txt': leak() }, { 'leak.txt': null }] })));
});

test("a secret on another branch that only that branch ignores does not fail this pull request", () => {
  passes(scan(checkout({
    pr: [{ 'ok.txt': 'fine\n' }],
    other: [{ 'leak.txt': leak() }, (s) => ({ 'leak.txt': null, '.gitleaksignore': `${s.other[0]}:leak.txt:${RULE}:1\n` })],
  })));
});

test("a secret in this pull request's history fails it, though its tree no longer holds it", () => {
  fails(scan(checkout({ pr: [{ 'leak.txt': leak() }, { 'leak.txt': null }] })));
});

test("on main, a secret in main's history fails it", () => {
  fails(scan(checkout({ main: [{ 'leak.txt': leak() }, { 'leak.txt': null }] })));
});

test('a pull request that adds its own ignore lines for its own secret fails', () => {
  fails(scan(checkout({
    pr: [{ 'leak.txt': leak() }, (s) => ({ '.gitleaksignore': `${s.pr[0]}:leak.txt:${RULE}:1\nleak.txt:${RULE}:1\n` })],
  })));
});

test("a pull request that adds its own ignore line for a secret only its history holds fails", () => {
  fails(scan(checkout({
    pr: [{ 'leak.txt': leak() }, (s) => ({ 'leak.txt': null, '.gitleaksignore': `${s.pr[0]}:leak.txt:${RULE}:1\n` })],
  })));
});

test('a pull request that adds its own allowlist to .gitleaks.toml for its own secret fails', () => {
  fails(scan(checkout({
    pr: [{ 'leak.txt': leak(), '.gitleaks.toml': `${RULES}\n[[allowlists]]\ndescription = "planted"\npaths = ['''^leak\\.txt$''']\n` }],
  })));
});

test("a pull request whose secret main's ignore covers passes", () => {
  passes(scan(checkout({
    pr: [{ 'leak.txt': leak() }, { 'leak.txt': null }],
    main: [(s) => ({ '.gitleaksignore': `${s.pr[0]}:leak.txt:${RULE}:1\n` })],
  })));
});

// review P3-1 (card signpage-generated-merge-free): the signing page's bundle is build output, ignored and never
// committed, so the tree scan (which runs before pnpm install) never reads it: a step after the install builds it and the
// next scans packages/signpage with main's rules, the built files included though .gitignore names them
const BUNDLE_SCAN = (step) => /"\$RUNNER_TEMP\/gitleaks" dir packages\/signpage /.test(step);
test("the gitleaks job builds the signing page's bundle, then scans it with main's rules", () => {
  const yml = readFileSync(CI, 'utf8');
  const job = yml.slice(yml.indexOf('\n  gitleaks:\n'), yml.indexOf('\n  deep-import:\n'));
  const install = job.indexOf('run: pnpm install --frozen-lockfile');
  const build = job.indexOf('run: node packages/signpage/scripts/build-app.mjs');
  const bundle = job.search(/"\$RUNNER_TEMP\/gitleaks" dir packages\/signpage --config "\$RUNNER_TEMP\/rules\/\.gitleaks\.toml"/);
  assert.ok(install > 0 && build > install && bundle > build, 'install, then the build, then the bundle scan');
  assert.equal(scanSteps(yml).filter(BUNDLE_SCAN).length, 1);
});

// the bundle appears only after the tree scan, as CI's build step makes it: the tree scan never sees it, the bundle scan must
function built(text) {
  const co = checkout({ main: [{ '.gitignore': '/packages/signpage/public/app.js\n' }] });
  const beforeStep = (step) => {
    if (!BUNDLE_SCAN(step)) return;
    mkdirSync(join(co.repo, 'packages/signpage/public'), { recursive: true });
    writeFileSync(join(co.repo, 'packages/signpage/public/app.js'), text);
    assert.equal(git(co.repo, ['status', '--porcelain', '--', 'packages/signpage']), '', 'the planted bundle is ignored');
  };
  return scan(co, beforeStep);
}

test("a secret in the built bundle, ignored and untracked, fails the bundle scan", () => {
  fails(built(leak()));
});

test("the bundle scan passes a built bundle with no secret", () => {
  passes(built('export const ok = 1;\n'));
});
