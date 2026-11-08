// The sign-site census (card signers-own-bytes, reviews 4 M2 and 5 F2): the tree's census is SIGN_SITES, and every way
// of adding a signature the list does not name is refused. Each plant is written into a real copy of the four source
// trees (packages/exit/src included) and the gate reads that copy from disk, as it reads the repo.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { census, check, readTrees, SIGN_SITES, TREES } from "./sign-sites.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exists = (t) => existsSync(path.join(ROOT, t));
const TMP = mkdtempSync(path.join(os.tmpdir(), "sign-sites-"));
for (const t of TREES) cpSync(path.join(ROOT, t), path.join(TMP, t), { recursive: true, verbatimSymlinks: true });
after(() => rmSync(TMP, { recursive: true, force: true }));

/** Writes `files` into the copy, reads the copy from disk through the gate, then puts the copy back as it was. */
function plant(files, links = {}) {
  const undo = [];
  for (const [f, text] of Object.entries(files)) {
    const abs = path.join(TMP, f);
    undo.push(existsSync(abs) ? [abs, readFileSync(abs, "utf8")] : [abs, null]);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  for (const [f, target] of Object.entries(links)) {
    const abs = path.join(TMP, f);
    undo.push([abs, null]);
    symlinkSync(target, abs);
  }
  try {
    return check(readTrees(TMP), SIGN_SITES, exists);
  } finally {
    for (const [abs, text] of undo.reverse()) text === null ? rmSync(abs, { recursive: true, force: true }) : writeFileSync(abs, text);
  }
}
const refuses = (name, files, want, links) => {
  const out = plant(files, links);
  assert.ok(out.some((l) => want.test(l)), `${name}: ${JSON.stringify(out)}`);
};

test("the tree's sign sites are SIGN_SITES, each with a proof test that exists; the copy reads the same", () => {
  const tree = readTrees(ROOT);
  assert.deepEqual(check(tree, SIGN_SITES, exists), []);
  assert.equal(Object.keys(SIGN_SITES).length, 17);
  assert.deepEqual(census(tree).sites, Object.fromEntries(Object.entries(SIGN_SITES).map(([k, v]) => [k, v.n])));
  assert.ok(Object.keys(tree).some((f) => f.startsWith("packages/exit/src/")));
  assert.deepEqual(plant({}), []);
  assert.equal(execFileSync(process.execPath, [path.join(ROOT, "scripts/ci/sign-sites.mjs"), ROOT], { encoding: "utf8" }).trim(), "sign-sites: OK (17 sign sites, each with its proof test)");
});

const W = "packages/wallet/src";
const NEW = `${W}/extra.ts`;
const ED = 'import { ed25519 } from "@noble/curves/ed25519.js";\n';
const SECP = 'import { secp256k1 } from "@noble/curves/secp256k1.js";\n';
const D = "packages/wallet/src/deposit/delegate.ts";
const DELEGATE = readFileSync(path.join(ROOT, D), "utf8");
const SITE = /a sign site with no entry/;

test("planted: a new sign site anywhere, in any shape, on any receiver, fails until SIGN_SITES names it", () => {
  const cases = [
    ["a new ed25519 sign", { [NEW]: `${ED}export function signMore(d: Uint8Array, k: Uint8Array) {\n  return ed25519.sign(d, k);\n}\n` }, /extra\.ts:signMore: a sign site with no entry/],
    ["a secp256k1 sign in the kit", { "packages/kit/src/extra.ts": `${SECP}export const s = (d: Uint8Array, k: Uint8Array) => secp256k1.sign(d, k);\n` }, /kit\/src\/extra\.ts:s: a sign site with no entry/],
    ["a sign in the exit tool", { "packages/exit/src/extra.ts": `${ED}function quiet(d: Uint8Array, k: Uint8Array) { return ed25519.sign(d, k); }\n` }, /exit\/src\/extra\.ts:quiet: a sign site/],
    ["a sign in a test-named file under src", { [`${W}/extra.test.ts`]: `${ED}export const t = (d: Uint8Array, k: Uint8Array) => ed25519.sign(d, k);\n` }, /extra\.test\.ts:t: a sign site/],
    ["a sign in a .jsx file", { "packages/signpage/src/extra.jsx": `${ED}export const X = (d, k) => <b>{ed25519.sign(d, k)}</b>;\n` }, /extra\.jsx:X: a sign site/],
    ["an aliased import", { [NEW]: 'import { ed25519 as e } from "@noble/curves/ed25519.js";\nexport function a(d: Uint8Array, k: Uint8Array) { return e.sign(d, k); }\n' }, /extra\.ts:a: a sign site/],
    ["a bracketed sign", { [NEW]: `${ED}export function b(d: Uint8Array, k: Uint8Array) { return ed25519["sign"](d, k); }\n` }, /extra\.ts:b: a sign site/],
    ["an optional call", { [NEW]: `${ED}export function o(d: Uint8Array, k: Uint8Array) { return ed25519?.sign(d, k); }\n` }, /extra\.ts:o: a sign site/],
    ["signAsync", { [NEW]: `${ED}export async function as(d: Uint8Array, k: Uint8Array) { return ed25519.signAsync(d, k); }\n` }, /extra\.ts:as: a sign site/],
    ["a destructured sign", { [NEW]: `${ED}const { sign } = ed25519;\nexport const d = sign;\n` }, /extra\.ts:<statement at line 2>: a sign site/],
    ["sign handed on unread", { [NEW]: `${ED}export const s = ed25519.sign;\n` }, /extra\.ts:s: a sign site/],
    ["the second declaration of one statement", { [NEW]: `${ED}export const a = 1, b = (d: Uint8Array, k: Uint8Array) => ed25519.sign(d, k);\n` }, /extra\.ts:b: a sign site/],
    ["a sign handed to a signer object", { [NEW]: "export const run = (signer: { sign(m: Uint8Array): Uint8Array }, m: Uint8Array) => signer.sign(m);\n" }, /extra\.ts:run: a sign site/],
  ];
  for (const [name, files, want] of cases) refuses(name, files, want);
});

test("planted: a curve, a signing library or WebCrypto reached any other way is refused outright", () => {
  const cases = [
    ["the curve handed on whole", { [NEW]: `${ED}export const curve = ed25519;\n` }, /the curve ed25519 handed on as a value/],
    ["the curve re-exported", { [NEW]: `${ED}export { ed25519 };\n` }, /the curve ed25519 exported/],
    ["the curve as the default export", { [NEW]: `${ED}export default ed25519;\n` }, /the curve exported as the default/],
    ["a namespace import", { [NEW]: 'import * as curves from "@noble/curves/ed25519.js";\nexport const n = (d: Uint8Array, k: Uint8Array) => curves.ed25519.sign(d, k);\n' }, /a namespace import of @noble\/curves/],
    ["a curve loaded at run time", { [NEW]: 'export const r = () => import("@noble/curves/ed25519.js");\n' }, /import\(\) of @noble\/curves\/ed25519\.js \(a curve is imported by name/],
    ["a curve required", { "packages/kit/src/extra.cjs": 'module.exports = require("@noble/curves/ed25519.js");\n' }, /require\(\) of @noble\/curves\/ed25519\.js/],
    ["a require of a built name", { "packages/kit/src/extra.cjs": 'const n = "@noble/curves/ed25519.js";\nmodule.exports = require(n);\n' }, /require\(\) of a module that is not a plain string/],
    ["another signing library", { [NEW]: 'import nacl from "tweetnacl";\nexport const t = nacl;\n' }, /an import of tweetnacl, not an allowed module/],
    ["WebCrypto's sign", { [NEW]: "export const w = (k: CryptoKey, d: Uint8Array) => crypto.subtle.sign(\"Ed25519\", k, d);\n" }, /WebCrypto's subtle read other than as subtle\./],
    ["WebCrypto's subtle destructured", { [NEW]: "const { subtle } = globalThis.crypto;\nexport const w = subtle;\n" }, /WebCrypto's subtle bound by a pattern/],
    ["WebCrypto's subtle by a built key", { [NEW]: 'const k = "sub" + "tle";\nexport const w = crypto[k];\n' }, /crypto read with a computed key/],
    ["globalThis by a built key", { [NEW]: 'const k = "cry" + "pto";\nexport const w = globalThis[k];\n' }, /globalThis read with a computed key/],
    ["a let alias of subtle", { [NEW]: "let s = crypto.subtle;\nexport const w = s;\n" }, /WebCrypto's subtle read other than as subtle\./],
    ["node:crypto's sign", { [NEW]: 'import { sign } from "node:crypto";\nexport const x = sign;\n' }, /node:crypto's sign imported/],
    ["node:crypto's createSign", { [NEW]: 'import { createSign } from "node:crypto";\nexport const x = createSign;\n' }, /node:crypto's createSign imported/],
    ["node:crypto as a namespace", { [NEW]: 'import * as nc from "node:crypto";\nexport const x = nc;\n' }, /a namespace import of node:crypto/],
    ["node:crypto loaded at run time", { [NEW]: 'export const x = () => import("node:crypto");\n' }, /import\(\) of node:crypto/],
    ["a symlinked file in a tree", {}, /extra\.ts: a symlink in a source tree/, { [NEW]: "../../../../outside.ts" }],
    ["a symlinked folder in a tree", {}, /packages\/kit\/src\/more: a symlink in a source tree/, { "packages/kit/src/more": "/tmp" }],
  ];
  for (const [name, files, want, links] of cases) refuses(name, files, want, links);
});

test("planted: review 5's escapes (E1-E20, E4b, E16b, E17b) each fail the gate", () => {
  const cases = {
    "E1 re-export under another name, used in a second file": [{ [`${W}/a.ts`]: `${ED}export { ed25519 as curve };\n`, [`${W}/b.ts`]: `import { curve } from "./a.ts";\nexport function f(d: Uint8Array, k: Uint8Array) { return curve.sign(d, k); }\n` }, /a\.ts:2: the curve ed25519 exported/],
    "E2 export-from @noble/curves, used in a second file": [{ [`${W}/a.ts`]: `export { ed25519 } from "@noble/curves/ed25519.js";\n`, [`${W}/b.ts`]: `import { ed25519 } from "./a.ts";\nexport function g(d: Uint8Array, k: Uint8Array) { return ed25519.sign(d, k); }\n` }, /an export-from of the package @noble\/curves/],
    "E3 export * from @noble/curves": [{ [`${W}/a.ts`]: `export * from "@noble/curves/ed25519.js";\n`, [`${W}/b.ts`]: `import { ed25519 } from "./a.ts";\nexport function g(d: Uint8Array, k: Uint8Array) { return ed25519.sign(d, k); }\n` }, /an export-from of the package @noble\/curves/],
    "E4 an as-cast of the curve": [{ [`${W}/a.ts`]: `${ED}export function h(d: Uint8Array, k: Uint8Array) { return (ed25519 as typeof ed25519).sign(d, k); }\n` }, /a\.ts:h: a sign site/],
    "E4b an as-cast to any": [{ [`${W}/a.ts`]: `${ED}export function h(d: Uint8Array, k: Uint8Array) { return (ed25519 as any).sign(d, k); }\n` }, /a\.ts:h: a sign site/],
    "E5 a computed member from a variable": [{ [`${W}/a.ts`]: `${ED}const m = "sign" as const;\nexport function i(d: Uint8Array, k: Uint8Array) { return ed25519[m](d, k); }\n` }, /the curve ed25519 read with a computed key/],
    "E6 a unicode-escaped member name": [{ [`${W}/a.ts`]: `${ED}export function u(d: Uint8Array, k: Uint8Array) { return ed25519.\\u0073ign(d, k); }\n` }, /a\.ts:u: a sign site/],
    "E7 a string import name": [{ [`${W}/a.ts`]: `import { "ed25519" as e } from "@noble/curves/ed25519.js";\nexport function s(d: Uint8Array, k: Uint8Array) { return e.sign(d, k); }\n` }, /a\.ts:s: a sign site/],
    "E8 a dynamic import of a built specifier": [{ [`${W}/a.ts`]: `export async function j(d: Uint8Array, k: Uint8Array) { const c = await import("@noble/" + "curves/ed25519.js"); return c.ed25519.sign(d, k); }\n` }, /import\(\) of a module that is not a plain string/],
    "E9 @scure/bip32 HDKey.sign": [{ [`${W}/a.ts`]: `import { HDKey } from "@scure/bip32";\nexport function k(seed: Uint8Array, h: Uint8Array) { return HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0").sign(h); }\n` }, /a\.ts:k: a sign site/],
    "E10 WebCrypto's sign through a local alias": [{ [`${W}/a.ts`]: `export const w = (k: CryptoKey, d: Uint8Array) => { const s = crypto.subtle; return s.sign("Ed25519", k, d); };\n` }, /the subtle alias s read other than as s\./],
    "E11 WebCrypto's sign bracketed": [{ [`${W}/a.ts`]: `export const w = (k: CryptoKey, d: Uint8Array) => crypto.subtle["sign"]("Ed25519", k, d);\n` }, /WebCrypto's subtle read other than as subtle\./],
    "E12 node:crypto default import": [{ [`${W}/a.ts`]: `import nc from "node:crypto";\nexport const x = (k: Buffer, d: Buffer) => nc.sign(null, d, k);\n` }, /a default import of node:crypto/],
    "E13 ++ then / read as a regex": [{ [`${W}/a.ts`]: `${ED}let n = 0; n++ / 1; export const z = (d: Uint8Array, k: Uint8Array) => ed25519.sign(d, k);\n` }, /a\.ts:z: a sign site/],
    "E14 a regex after ) read as division, its quote opening a string": [{ [`${W}/a.ts`]: `${ED}const q = "x";\nif (q) /'/.test(q); export const z = (d: Uint8Array, k: Uint8Array) => ed25519.sign(d, k);\n` }, /a\.ts:z: a sign site/],
    "E15 a regex after ) holding a backtick": [{ [`${W}/a.ts`]: `${ED}const q = "x";\nif (q) /\`/.test(q);\nexport function z(d: Uint8Array, k: Uint8Array) {\n  return ed25519.sign(d, k);\n}\n// \`\n` }, /a\.ts:z: a sign site/],
    "E16 function(){} / 1 read as a regex": [{ [`${W}/a.ts`]: `${ED}const f = function () {} as unknown as number / 1; export const z = (d: Uint8Array, k: Uint8Array) => ed25519.sign(d, k);\n` }, /a\.ts:z: a sign site/],
    "E16b function(){} / 1, no cast": [{ [`${W}/a.ts`]: `${ED}const f = function () {} / 1; export const z = (d: Uint8Array, k: Uint8Array) => ed25519.sign(d, k);\n` }, /a\.ts:z: a sign site/],
    "E17 semicolon-free imports": [{ [`${W}/a.ts`]: `import { sha256 } from "@noble/hashes/sha2.js"\nimport { ed25519 } from "@noble/curves/ed25519.js"\nexport function f(d: Uint8Array, k: Uint8Array) { return ed25519.sign(sha256(d), k) }\n` }, /a\.ts:f: a sign site/],
    "E17b semicolon-free imports, read by member": [{ [`${W}/a.ts`]: `import { base58 } from "@scure/base"\nimport { ed25519 } from "@noble/curves/ed25519.js"\nexport function f(d: Uint8Array, k: Uint8Array) { return base58.encode(ed25519.sign(d, k)) }\n` }, /a\.ts:f: a sign site/],
    "E18 an indented export after a listed site": [{ [D]: DELEGATE.replace("  const signature = ed25519.sign(sha256(signable), secretKey);", "  const signature = anySign(sha256(signable), secretKey);").replace("// Signs U_{s,i}'s deposit call", " export function anySign(m: Uint8Array, k: Uint8Array): Uint8Array { return ed25519.sign(m, k); }\n\n// Signs U_{s,i}'s deposit call") }, /delegate\.ts:anySign: a sign site/],
    "E19 near-api-js": [{ [`${W}/a.ts`]: `import { KeyPair } from "near-api-js";\nexport const n = (s: string, m: Uint8Array) => KeyPair.fromString(s as never).sign(m);\n` }, /an import of near-api-js, not an allowed module/],
    "E20 another library re-exported": [{ [`${W}/a.ts`]: `export { default as nacl } from "tweetnacl";\n`, [`${W}/b.ts`]: `import { nacl } from "./a.ts";\nexport const t = (m: Uint8Array, k: Uint8Array) => nacl.sign.detached(m, k);\n` }, /an export-from of tweetnacl, not an allowed module/],
  };
  assert.equal(Object.keys(cases).length, 23);
  assert.ok(DELEGATE.includes("  const signature = ed25519.sign(sha256(signable), secretKey);") && DELEGATE.includes("// Signs U_{s,i}'s deposit call"));
  for (const [name, [files, want]] of Object.entries(cases)) refuses(name, files, want);
});

const HD = 'import { HDKey } from "@scure/bip32";\n';
const E = "packages/exit/src";

test("planted: review 6's escapes (G1-G7, G5b, G6b, G7b) each fail the gate, each a real signature", () => {
  const cases = {
    "G1 Reflect.get(hd, \"sign\") on an HDKey": [{ [`${W}/g.ts`]: `${HD}export const g = (seed: Uint8Array, h: Uint8Array) => { const hd = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0"); return Reflect.get(hd, "sign").call(hd, h); };\n` }, /g\.ts:2: Reflect other than Reflect\.ownKeys/],
    "G2 a built key on an HDKey's member chain": [{ [`${W}/g.ts`]: `${HD}const k = ["si", "gn"].join("") as "sign";\nexport const g = (seed: Uint8Array, h: Uint8Array) => HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0")[k](h);\n` }, /g\.ts:3: a member chain of the signer HDKey read with a computed key/],
    "G3 getOwnPropertyDescriptor(proto, \"sign\")": [{ [`${W}/g.ts`]: `${HD}export const g = (seed: Uint8Array, h: Uint8Array) => { const hd = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0"); return Object.getOwnPropertyDescriptor(Object.getPrototypeOf(hd), "sign")!.value.call(hd, h); };\n` }, /g\.ts:2: getOwnPropertyDescriptor/],
    "G4 WebCrypto through Reflect.get": [{ [`${W}/g.ts`]: `export const g = (k: CryptoKey, d: Uint8Array) => { const s = Reflect.get(crypto, "subtle"); return Reflect.get(s, "sign").call(s, "Ed25519", k, d); };\n` }, /g\.ts:1: Reflect other than Reflect\.ownKeys/],
    "G5 createRequire loads the curve, read by a built key": [{ [`${E}/g.ts`]: `import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nconst c = req("@noble/curves/ed25519.js").ed25519;\nconst k = ["si", "gn"].join("");\nexport const g = (d: Uint8Array, s: Uint8Array) => c[k](d, s);\n` }, /exit\/src\/g\.ts:2: createRequire other than createRequire\(x\)\.resolve/],
    "G5b createRequire loads node:crypto": [{ [`${E}/g.ts`]: `import { createRequire } from "node:module";\nconst nc = createRequire(import.meta.url)("node:" + "crypto");\nexport const g = (d: Uint8Array, key: unknown) => Reflect.apply(Reflect.get(nc, "si" + "gn"), nc, [null, d, key]);\n` }, /g\.ts:2: createRequire other than/],
    "G6 a relative path into node_modules": [{ [`${W}/g.ts`]: `import { ed25519 as e } from "../../../node_modules/.pnpm/@noble+curves@2.4.0/node_modules/@noble/curves/ed25519.js";\nconst k = ["si", "gn"].join("");\nexport const g = (d: Uint8Array, s: Uint8Array) => (e as any)[k](d, s);\n` }, /g\.ts:1: an import of \.\.\/\.\.\/\.\.\/node_modules\/.*, a path out of the source trees/],
    "G6b a relative path to ethers": [{ [`${W}/g.ts`]: `import { Wallet } from "../../../node_modules/.pnpm/ethers@6.13.5/node_modules/ethers/lib.esm/index.js";\nexport const g = (pk: string, m: string) => new Wallet(pk).signMessageSync(m);\n` }, /a path out of the source trees/],
    "G7 new Function holds the import and the call": [{ [`${E}/g.ts`]: `export const g = new Function("d", "s", "return import('@noble/curves/ed25519.js').then((c) => c.ed25519.sign(d, s))");\n` }, /g\.ts:1: Function: code made at run time/],
    "G7b indirect eval": [{ [`${E}/g.ts`]: `export const g = (d: Uint8Array, s: Uint8Array) => (0, eval)("import('@noble/curves/ed25519.js')").then((c: any) => Reflect.get(c.ed25519, "sign")(d, s));\n` }, /g\.ts:1: eval: code made at run time/],
  };
  for (const [name, [files, want]] of Object.entries(cases)) refuses(name, files, want);
});

test("planted: the other run-time and by-name forms fail; the trees' own uses pass", () => {
  const cases = [
    ["globalThis.eval", { [`${E}/g.ts`]: 'export const g = (c: string) => globalThis.eval(c);\n' }, /eval: code made at run time/],
    ["a Function through .constructor", { [`${E}/g.ts`]: 'export const g = (c: string) => (() => {}).constructor(c);\n' }, /a constructor called through \.constructor/],
    ["new through a bracketed constructor", { [`${E}/g.ts`]: 'export const g = (c: string) => new (async () => {})["constructor"](c);\n' }, /a constructor called through \.constructor/],
    ["getOwnPropertyDescriptors", { [`${W}/g.ts`]: "export const g = (o: object) => Object.getOwnPropertyDescriptors(o);\n" }, /getOwnPropertyDescriptors/],
    ["Reflect handed on", { [`${W}/g.ts`]: "export const R = Reflect;\n" }, /Reflect other than Reflect\.ownKeys/],
    ["createRequire through node:module's namespace", { [`${E}/g.ts`]: 'import * as m from "node:module";\nexport const r = m.createRequire(import.meta.url);\n' }, /createRequire other than/],
    ["createRequire kept, then resolved", { [`${E}/g.ts`]: 'import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\nexport const p = r.resolve("x");\n' }, /createRequire other than/],
    ["a relative path to another package", { [`${W}/g.ts`]: 'export { x } from "../../../apps/helper/src/x.ts";\n' }, /a path out of the source trees/],
    ["a relative import() out of the trees", { [`${W}/g.ts`]: 'export const g = () => import("../../../node_modules/tweetnacl/nacl.js");\n' }, /import\(\) of .*, a path out of the source trees/],
    ["a curve's member chain by a built key", { [`${W}/g.ts`]: `${ED}const k = ["si", "gn"].join("");\nexport const g = (d: Uint8Array, s: Uint8Array) => (ed25519.utils as any).constructor[k](d, s);\n` }, /a member chain of the signer ed25519 read with a computed key/],
  ];
  for (const [name, files, want] of cases) refuses(name, files, want);
  // the trees' own: Reflect.ownKeys, createRequire(x).resolve(...), a relative path from one tree into another, a
  // Function type, a property named eval: none refused
  const fine = 'import { createRequire } from "node:module";\nimport { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";\nexport const p = createRequire(import.meta.url).resolve("snarkjs");\nexport const k = (o: object) => Reflect.ownKeys(o);\nexport type F = Function;\nexport const o = { eval: 1, Function: 2 };\nexport const c = solanaCompileV0;\n';
  assert.deepEqual(plant({ "packages/signpage/src/g.ts": fine }), []);
});

test("planted: a second signature in a listed site, a listed site gone, or a proof test that does not exist fails", () => {
  const two = DELEGATE.replace("  const signature = ed25519.sign(sha256(signable), secretKey);", "  const signature = ed25519.sign(sha256(signable), secretKey);\n  void ed25519.sign(signable, secretKey);");
  assert.notEqual(two, DELEGATE);
  refuses("a second signature", { [D]: two }, /delegate\.ts:signDelegateAction: 2 sign members, SIGN_SITES says 1/);
  const none = DELEGATE.replace("ed25519.sign(sha256(signable), secretKey)", "new Uint8Array(64)");
  refuses("a listed site gone", { [D]: none }, /delegate\.ts:signDelegateAction: listed in SIGN_SITES but signs nothing/);
  assert.ok(check(readTrees(TMP), SIGN_SITES, () => false).some((l) => /its proof test .* does not exist/.test(l)));
});

test("a sign named in a comment, a string, a template's text or a regex is no site; a template's code is", () => {
  const text = `${ED}// ed25519.sign(x)\nconst a = "ed25519.sign(x)";\nconst b = \`ed25519 \${1}\`;\nconst c = /ed25519.sign/;\nexport const k = (m: Uint8Array) => ed25519.getPublicKey(m);\nexport const t = (d: Uint8Array, s: Uint8Array) => \`\${ed25519.sign(d, s)}\`;\n`;
  const { sites, refused } = census({ [NEW]: text });
  assert.deepEqual(refused, []);
  assert.deepEqual(sites, { [`${NEW}:t`]: 1 });
  assert.ok(SITE.test(plant({ [NEW]: text }).join("\n")));
});
