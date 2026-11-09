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
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { SIGN_BUILD_OUTPUTS } from './sign-build-inputs.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CI = join(ROOT, '.github/workflows/ci.yml');
const RULES = readFileSync(join(ROOT, '.gitleaks.toml'), 'utf8');
const BIN = resolve(process.env.GITLEAKS
  || execFileSync('bash', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).trim());
const RULE = 'near-ed25519-secret-key';
// the binary's sha256 as the install step records it (steps.gitleaks-bin.outputs.sha256)
const BIN_SHA256 = createHash('sha256').update(readFileSync(realpathSync(BIN))).digest('hex');
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
      if (BUNDLE_SCAN(step)) buildOutputs(co.repo); // CI's build step, which calls no gitleaks: the four outputs
      beforeStep(step, runnerTemp);
      const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step], {
        cwd: co.repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, RUNNER_TEMP: runnerTemp, GITLEAKS_SHA256: BIN_SHA256 },
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
/** The four built files, as the build step leaves them (each one line with no secret), where none is there yet. */
function buildOutputs(repo) {
  for (const f of SIGN_BUILD_OUTPUTS) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    if (!existsSync(join(repo, f))) writeFileSync(join(repo, f), '// built\n');
  }
}
const IGNORED = SIGN_BUILD_OUTPUTS.map((f) => `/${f}\n`).join('');
test("the gitleaks job builds the signing page's bundle, then scans it with main's rules", () => {
  const yml = readFileSync(CI, 'utf8');
  const job = yml.slice(yml.indexOf('\n  gitleaks:\n'), yml.indexOf('\n  deep-import:\n'));
  const install = job.indexOf('run: pnpm install --frozen-lockfile');
  const build = job.indexOf('run: node packages/signpage/scripts/build-app.mjs');
  const bundle = job.search(/"\$RUNNER_TEMP\/gitleaks" dir packages\/signpage --config "\$rules\/\.gitleaks\.toml"/);
  assert.ok(install > 0 && build > install && bundle > build, 'install, then the build, then the bundle scan');
  const [step] = scanSteps(yml).filter(BUNDLE_SCAN);
  assert.equal(scanSteps(yml).filter(BUNDLE_SCAN).length, 1);
  assert.match(step, /^echo "\$GITLEAKS_SHA256  \$RUNNER_TEMP\/gitleaks" \| sha256sum --strict -c -$/m, 'the binary is checked first');
  assert.match(step, /git show origin\/main:\.gitleaks\.toml > "\$rules\/\.gitleaks\.toml"/, "main's rules, read again");
  assert.match(job, /GITLEAKS_SHA256: \$\{\{ steps\.gitleaks-bin\.outputs\.sha256 \}\}/);
});

// the bundle appears only after the tree scan, as CI's build step makes it: the tree scan never sees it, the bundle scan must
function built(text, tamper = () => {}, pr = []) {
  const co = checkout({ pr, main: [{ '.gitignore': IGNORED }] });
  const beforeStep = (step, runnerTemp) => {
    if (!BUNDLE_SCAN(step)) return;
    tamper(runnerTemp);
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

// delta review P3-3: a gitleaks or rules file swapped in $RUNNER_TEMP by a later step (the build) is not the bundle scan's:
// it runs only the gitleaks whose sha256 the install step recorded, and reads main's rules again on its own
const allowAll = `[extend]\nuseDefault = true\n[[allowlists]]\ndescription = "planted"\npaths = ['''.*''']\n`;
test("a gitleaks binary the build swapped fails the bundle scan on its sha256, though it would pass the bundle", () => {
  const r = built(leak(), (rt) => {
    unlinkSync(join(rt, 'gitleaks'));
    writeFileSync(join(rt, 'gitleaks'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(rt, 'gitleaks'), 0o755);
  });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /gitleaks: FAILED/, r.out);
});

test("rules the build rewrote to allow everything are not the bundle scan's: main's rules find the secret", () => {
  fails(built(leak(), (rt) => {
    writeFileSync(join(rt, 'rules', '.gitleaks.toml'), allowAll);
    writeFileSync(join(rt, 'rules', '.gitleaksignore'), 'packages/signpage/public/app.js:near-ed25519-secret-key:1\n');
  }));
});

// delta review 2: gitleaks dir reads the scanned folder's own .gitleaksignore. The bundle scan reads a folder of its own
// holding the four built files alone, so a pull request that adds packages/signpage/.gitleaksignore naming the bundle's
// finding does not silence it
test("a pull request that adds packages/signpage/.gitleaksignore naming the bundle's finding does not silence the bundle scan", () => {
  fails(built(leak(), () => {}, [{ 'packages/signpage/.gitleaksignore': `packages/signpage/public/app.js:${RULE}:1\n` }]));
});

test("the bundle scan copies exactly SIGN_BUILD_OUTPUTS into a folder of its own and scans from there", () => {
  const [step] = scanSteps(readFileSync(CI, 'utf8')).filter(BUNDLE_SCAN);
  assert.match(step, /^scan="\$\(mktemp -d\)"$/m);
  assert.equal(/^for f in (.+); do$/m.exec(step)?.[1], SIGN_BUILD_OUTPUTS.join(' '));
  assert.match(step, /cp -- "\$f" "\$scan\/\$f"/);
  assert.ok(step.indexOf('cd "$scan"') < step.indexOf('"$RUNNER_TEMP/gitleaks" dir packages/signpage'), 'the scan runs in its own folder');
});
