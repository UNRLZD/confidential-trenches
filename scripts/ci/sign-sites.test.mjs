// The sign-site census (card signers-own-bytes, review 4 M2): the tree's census is SIGN_SITES, and every way of adding
// a signature the list does not name is refused.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { census, check, readTrees, scan, SIGN_SITES } from "./sign-sites.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TREE = readTrees(ROOT);
const exists = (t) => existsSync(path.join(ROOT, t));

test("the tree's sign sites are SIGN_SITES, thirteen, each with a proof test that exists", () => {
  assert.deepEqual(check(TREE, SIGN_SITES, exists), []);
  assert.equal(Object.keys(SIGN_SITES).length, 13);
  assert.deepEqual(census(TREE).sites, Object.fromEntries(Object.entries(SIGN_SITES).map(([k, v]) => [k, v.n])));
});

const NEW = "packages/wallet/src/extra.ts";
const ED = 'import { ed25519 } from "@noble/curves/ed25519.js";\n';
const SECP = 'import { secp256k1 } from "@noble/curves/secp256k1.js";\n';
const plant = (files) => check({ ...TREE, ...files }, SIGN_SITES, exists);

test("planted: a fourteenth sign site anywhere, in any shape, fails until SIGN_SITES names it", () => {
  const cases = [
    ["a fourteenth ed25519 sign", { [NEW]: `${ED}export function signMore(d: Uint8Array, k: Uint8Array) {\n  return ed25519.sign(d, k);\n}\n` }, /extra\.ts:signMore: a sign site with no entry/],
    ["a secp256k1 sign in the kit", { "packages/kit/src/extra.ts": `${SECP}export const s = (d: Uint8Array, k: Uint8Array) => secp256k1.sign(d, k);\n` }, /kit\/src\/extra\.ts:s: a sign site with no entry/],
    ["a sign in the exit tool", { "packages/exit/src/extra.ts": `${ED}function quiet(d: Uint8Array, k: Uint8Array) { return ed25519.sign(d, k); }\n` }, /exit\/src\/extra\.ts:quiet: a sign site/],
    ["an aliased import", { [NEW]: 'import { ed25519 as e } from "@noble/curves/ed25519.js";\nexport function a(d: Uint8Array, k: Uint8Array) { return e.sign(d, k); }\n' }, /extra\.ts:a: a sign site/],
    ["a bracketed sign", { [NEW]: `${ED}export function b(d: Uint8Array, k: Uint8Array) { return ed25519["sign"](d, k); }\n` }, /extra\.ts:b: a sign site/],
    ["an optional call", { [NEW]: `${ED}export function o(d: Uint8Array, k: Uint8Array) { return ed25519?.sign(d, k); }\n` }, /extra\.ts:o: a sign site/],
    ["signAsync", { [NEW]: `${ED}export async function as(d: Uint8Array, k: Uint8Array) { return ed25519.signAsync(d, k); }\n` }, /extra\.ts:as: a sign site/],
    ["a destructured sign", { [NEW]: `${ED}const { sign } = ed25519;\nexport const d = sign;\n` }, /extra\.ts:<module>: a sign site|extra\.ts:sign: a sign site/],
    ["sign handed on unread", { [NEW]: `${ED}export const s = ed25519.sign;\n` }, /extra\.ts:s: a sign site/],
    ["the curve handed on whole", { [NEW]: `${ED}export const curve = ed25519;\n` }, /the curve ed25519 is handed on as a value/],
    ["the curve re-exported", { [NEW]: `${ED}export { ed25519 };\n` }, /the curve ed25519 is handed on as a value/],
    ["a namespace import", { [NEW]: 'import * as curves from "@noble/curves/ed25519.js";\nexport const n = (d: Uint8Array, k: Uint8Array) => curves.ed25519.sign(d, k);\n' }, /a namespace import of @noble\/curves/],
    ["a curve loaded at run time", { [NEW]: 'export const r = () => import("@noble/curves/ed25519.js");\n' }, /loads @noble\/curves at run time/],
    ["another signing library", { [NEW]: 'import nacl from "tweetnacl";\nexport const t = nacl;\n' }, /another signing library, tweetnacl/],
    ["WebCrypto's sign", { [NEW]: "export const w = (k: CryptoKey, d: Uint8Array) => crypto.subtle.sign(\"Ed25519\", k, d);\n" }, /signs with WebCrypto or node:crypto/],
    ["node:crypto's sign", { [NEW]: 'import { sign } from "node:crypto";\nexport const x = sign;\n' }, /signs with WebCrypto or node:crypto/],
  ];
  for (const [name, files, want] of cases) {
    const out = plant(files);
    assert.ok(out.some((l) => want.test(l)), `${name}: ${JSON.stringify(out)}`);
  }
});

test("planted: a second signature in a listed site, a listed site gone, or a proof test that does not exist fails", () => {
  const f = "packages/wallet/src/deposit/delegate.ts";
  const two = TREE[f].replace("  const signature = ed25519.sign(sha256(signable), secretKey);", "  const signature = ed25519.sign(sha256(signable), secretKey);\n  void ed25519.sign(signable, secretKey);");
  assert.notEqual(two, TREE[f]);
  assert.ok(plant({ [f]: two }).some((l) => /delegate\.ts:signDelegateAction: 2 signatures, SIGN_SITES says 1/.test(l)));
  const none = TREE[f].replace("ed25519.sign(sha256(signable), secretKey)", "new Uint8Array(64)");
  assert.ok(plant({ [f]: none }).some((l) => /delegate\.ts:signDelegateAction: listed in SIGN_SITES but signs nothing/.test(l)));
  assert.ok(check(TREE, SIGN_SITES, () => false).some((l) => /its proof test .* does not exist/.test(l)));
});

test("a curve named in a comment, a string, a template's text or a regex is no use; a template's code is", () => {
  const text = `${ED}// ed25519.sign(x)\nconst a = "ed25519.sign(x)";\nconst b = \`ed25519 \${1}\`;\nconst c = /ed25519.sign/;\nexport const k = (m: Uint8Array) => ed25519.getPublicKey(m);\nexport const t = (d: Uint8Array, s: Uint8Array) => \`\${ed25519.sign(d, s)}\`;\n`;
  const { sites, refused } = census({ [NEW]: text });
  assert.deepEqual(refused, []);
  assert.deepEqual(sites, { [`${NEW}:t`]: 1 });
  const { code, bare } = scan(text);
  assert.equal(code.length, text.length);
  assert.equal(bare.length, text.length);
});
