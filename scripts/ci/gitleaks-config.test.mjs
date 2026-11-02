// The repo's gitleaks config (.gitleaks.toml) on planted cases: a NEAR secret key is always found; a 64-byte ed25519
// signature passes only as a "signature" field of a JSON fixture under packages/kit/test/fixtures/ (card
// wallet-1click-check); Circle's USDC account id on NEAR mainnet passes generic-api-key only as that exact value (card
// signpage-deposit-quote-wire: SIGN_HOST's bundle keeps it under `TOKEN:` without its source's gitleaks:allow). Each case is a throwaway tree scanned with `gitleaks dir` from its root, as CI scans the repo.
//   node --test scripts/ci/gitleaks-config.test.mjs      (GITLEAKS=<path> to name the binary; CI's gitleaks job does)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.gitleaks.toml');
const BIN = process.env.GITLEAKS || 'gitleaks';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf) => {
  let n = BigInt(`0x${Buffer.from(buf).toString('hex')}`), s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = `1${s}`; }
  return s;
};
// A throwaway 64-byte signature, made here: the shape of a NEAR secret key, never one.
const SIG = `ed25519:${b58(sign(null, Buffer.from('planted'), generateKeyPairSync('ed25519').privateKey))}`;
const FIXTURE = 'packages/kit/test/fixtures/planted.json';

// Scans a tree holding one file and returns the rule ids found.
function scan(path, body) {
  const root = mkdtempSync(join(tmpdir(), 'gl-cfg-'));
  try {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), body);
    const report = join(root, 'report.json');
    try {
      execFileSync(BIN, ['dir', '.', '--config', CONFIG, '--no-banner', '--redact', '--exit-code', '0', '--report-format', 'json',
        '--report-path', report], { cwd: root, stdio: 'pipe' });
    } catch (e) { throw new Error(`gitleaks did not run: ${e.message}`); }
    return JSON.parse(readFileSync(report, 'utf8')).filter((f) => f.File !== 'report.json').map((f) => f.RuleID);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('the planted value has the secret-key shape (86-88 base58 characters)', () => {
  assert.match(SIG, /^ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}$/);
});
test('a "signature" field alone on its line in a kit test fixture passes', () => {
  assert.deepEqual(scan(FIXTURE, `{\n  "answer": {\n    "signature": "${SIG}",\n    "x": 1\n  }\n}\n`), []);
  assert.deepEqual(scan(FIXTURE, `{\n  "signature": "${SIG}"\n}\n`), []);
});
for (const [what, body] of [
  ['under "secret_key"', `{\n  "secret_key": "${SIG}"\n}\n`],
  ['under "private_key"', `{\n  "private_key": "${SIG}"\n}\n`],
  ['as a bare string', `[\n  "${SIG}"\n]\n`],
  ['on the line of a signature field, under another key', `{ "signature": "x", "secret_key": "${SIG}" }\n`],
  ['beside a real signature field on one line', `{ "signature": "${SIG}", "secret_key": "${SIG}" }\n`],
  ['as a signature field that shares its line', `{"signature":"${SIG}"}\n`],
]) {
  test(`the same value ${what} in a kit test fixture is found`, () => {
    const found = scan(FIXTURE, body); // a line with two values gives two findings
    assert.ok(found.length >= 1 && found.every((id) => id === 'near-ed25519-secret-key'), JSON.stringify(found));
  });
}
for (const path of ['packages/kit/test/planted.json', 'packages/kit/src/planted.json', 'packages/wallet/test/fixtures/planted.json',
  'packages/kit/test/fixtures/deeper/planted.json', 'packages/kit/test/fixtures/planted.ts', 'x/packages/kit/test/fixtures/planted.json']) {
  test(`the same signature line in ${path} is found`, () => {
    assert.deepEqual(scan(path, `{\n  "signature": "${SIG}"\n}\n`), ['near-ed25519-secret-key']);
  });
}

// Circle's native USDC account id on NEAR mainnet (packages/kit/src/vault/shapes.ts VAULT_CONSTANTS.TOKEN), a public value,
// as a bundle writes it. A NEAR secret-key rule cannot match it in any form: that rule needs "ed25519:" and 86-88 base58
// characters, and a 64-hex id is 64 characters with "0" in it, outside base58.
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const OTHER = createHash('sha256').update('planted').digest('hex'); // a throwaway 64-hex, never a key
const BUNDLE = 'packages/signpage/public/app.js';
test("Circle's USDC account id on NEAR mainnet under TOKEN: in a bundle passes", () => {
  assert.deepEqual(scan(BUNDLE, `const c={TOKEN:\`${USDC}\`,MAX_TREE_DEPTH:32};\n`), []);
});
for (const [what, value] of [['another 64-hex', OTHER], ['the USDC id with a character more', `${USDC}x`], ['the USDC id with its last character changed', `${USDC.slice(0, -1)}b`]]) {
  test(`${what} under TOKEN: in a bundle is found`, () => {
    assert.deepEqual(scan(BUNDLE, `const c={TOKEN:\`${value}\`,MAX_TREE_DEPTH:32};\n`), ['generic-api-key']);
  });
}
test('a NEAR secret key is still found in the bundle beside the USDC id', () => {
  assert.deepEqual(scan(BUNDLE, `const c={TOKEN:\`${USDC}\`};\nconst k=\`${SIG}\`;\n`), ['near-ed25519-secret-key']);
});
