#!/usr/bin/env node
// Card signers-own-bytes (reviews 4 M2 and 5 F2): every place the device, the signing page, the kit or the exit tool can
// make a signature is one of SIGN_SITES, as file:statement, and each entry names the test that proves what it signs.
//   node scripts/ci/sign-sites.mjs [root]      (exit 1 and one line per refusal)
// It walks packages/{wallet,kit,signpage,exit}/src with lstat (a symlink is refused, never followed), parses every code
// file there (test-named files included) with the TypeScript parser, and reads names as the parser does, escapes
// resolved. A site is every member named sign or signAsync, on any receiver (a.sign, a?.sign, a["sign"], a[`sign`],
// const { sign } = a), counted under the top-level statement it sits in. It refuses outright:
//   - a module that is not ALLOWED (relative paths aside), in an import, an export-from, import() or require(); an
//     import() or require() whose argument is not a plain string; an export-from of any package;
//   - a default or namespace import of node:crypto, a named one other than NODE_CRYPTO, import() or require() of it;
//   - WebCrypto's subtle in any form but x.subtle.<SUBTLE> or a const alias read only as alias.<SUBTLE>: no subtle
//     binding, no subtle key, no computed key on crypto, globalThis, self or window;
//   - a namespace import of @noble/curves, or import() or require() of it; a curve binding exported, handed on whole,
//     or read with a computed key that is not a plain string.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Each sign site, the sign members it holds (`n`) and the test that proves what it signs. */
export const SIGN_SITES = {
  "packages/wallet/src/deposit/delegate.ts:signDelegateAction": { n: 1, test: "packages/wallet/test/deposit-delegate.test.ts" },
  "packages/wallet/src/deposit/moveout.ts:signMoveTx": { n: 1, test: "packages/wallet/test/deposit-moveout-signers.test.ts" },
  "packages/wallet/src/deposit/refund.ts:runRefundMove": { n: 1, test: "packages/wallet/test/deposit-refund.test.ts" },
  "packages/wallet/src/arming/records.ts:solanaArmedSigner": { n: 1, test: "packages/wallet/test/arm-records.test.ts" },
  "packages/kit/src/trade/evm/buy-unpinned.ts:evmPoolSignBuyUnpinned": { n: 1, test: "packages/kit/test/evm-pool-buy.test.ts" },
  "packages/kit/src/trade/evm/sell-unpinned.ts:signDigest": { n: 1, test: "packages/kit/test/evm-pool-sell.test.ts" },
  "packages/kit/src/trade/evm/sell-unpinned.ts:evmPoolSignSellAuthorizationUnpinned": { n: 1, test: "packages/kit/test/evm-pool-sell.test.ts" },
  "packages/kit/src/trade/solana/flow.ts:signedWire": { n: 2, test: "packages/kit/test/solana-flow.test.ts" },
  "packages/kit/src/trade/solana/flow.ts:runSolanaTrade": { n: 1, test: "packages/kit/test/solana-flow.test.ts" },
  "packages/signpage/src/trade.ts:tradeKind": { n: 1, test: "packages/signpage/test/trade.test.ts" },
  "packages/signpage/src/rules/refund.ts:signIdIntent": { n: 1, test: "packages/signpage/test/rules-refund.test.ts" },
  "packages/signpage/src/rules/refund.ts:signReturnSolana": { n: 1, test: "packages/signpage/test/rules-refund.test.ts" },
  "packages/signpage/src/rules/refund.ts:signReturnEvm": { n: 1, test: "packages/signpage/test/rules-refund.test.ts" },
  "packages/signpage/src/rules/pool.ts:signSolana": { n: 1, test: "packages/signpage/test/rules-pool.test.ts" },
  "packages/signpage/src/rules/pool.ts:signEvmWithdraw": { n: 1, test: "packages/signpage/test/rules-pool.test.ts" },
  "packages/signpage/src/rules/pool.ts:signEvmOnwardSend": { n: 1, test: "packages/signpage/test/rules-pool-onward.test.ts" },
  "packages/signpage/src/rules/pool.ts:signEvmDeposit": { n: 1, test: "packages/signpage/test/rules-pool-deposit-evm.test.ts" },
};

/** The modules the four trees may load, besides their own relative files. */
export const ALLOWED = new Set([
  "@blindfill/kit", "@blindfill/kit/core",
  "@blindfill/wallet/arming/ladder", "@blindfill/wallet/arming/records", "@blindfill/wallet/derive", "@blindfill/wallet/signin/passkey", "@blindfill/wallet/signin/words", "@blindfill/wallet/store",
  "@noble/curves/ed25519.js", "@noble/curves/secp256k1.js",
  "@noble/hashes/hkdf.js", "@noble/hashes/hmac.js", "@noble/hashes/sha2.js", "@noble/hashes/sha3.js", "@noble/hashes/utils.js",
  "@scure/base", "@scure/bip32", "@scure/bip39", "@scure/bip39/wordlists/english.js",
  "@zk-kit/lean-imt",
  "poseidon-lite/poseidon1", "poseidon-lite/poseidon2", "poseidon-lite/poseidon3", "poseidon-lite/poseidon4", "poseidon-lite/poseidon5",
  "node:crypto", "node:fs", "node:module", "node:path", "node:url",
]);
/** node:crypto's names a file may import (named only): none of them signs. */
export const NODE_CRYPTO = new Set(["createHash"]);
/** WebCrypto's subtle members a file may read: none of them signs. */
export const SUBTLE = new Set(["digest", "encrypt", "decrypt", "generateKey", "importKey", "exportKey", "deriveKey", "deriveBits", "wrapKey", "unwrapKey"]);
const GLOBALS = new Set(["crypto", "globalThis", "self", "window"]);
const CURVES = /^@noble\/curves\//;
const SIGN = new Set(["sign", "signAsync"]);

export const TREES = ["packages/wallet/src", "packages/kit/src", "packages/signpage/src", "packages/exit/src"];
const KIND = { ".ts": ts.ScriptKind.TS, ".mts": ts.ScriptKind.TS, ".cts": ts.ScriptKind.TS, ".tsx": ts.ScriptKind.TSX, ".js": ts.ScriptKind.JS, ".mjs": ts.ScriptKind.JS, ".cjs": ts.ScriptKind.JS, ".jsx": ts.ScriptKind.JSX };

/** The code files of the four trees, as { path relative to root: text }, and the symlinks found (refused). */
export function readTrees(root) {
  const files = {};
  const links = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      const r = `${rel}/${name}`;
      const st = lstatSync(path.join(root, r));
      if (st.isSymbolicLink()) links.push(r);
      else if (st.isDirectory()) walk(r);
      else if (path.extname(name) in KIND) files[r] = readFileSync(path.join(root, r), "utf8");
    }
  };
  for (const t of TREES) walk(t);
  return Object.defineProperty(files, "links", { value: links, enumerable: false });
}

const unwrap = (n) => {
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
  return n;
};
/** n, widened past the parens and casts around it. */
const outer = (n) => {
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isAsExpression(n.parent) || ts.isTypeAssertionExpression(n.parent) || ts.isNonNullExpression(n.parent) || ts.isSatisfiesExpression(n.parent))) n = n.parent;
  return n;
};
const literalKey = (n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n) ? n.text : null);
const nameOf = (n) => (n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n)) ? n.text : n && ts.isComputedPropertyName(n) ? literalKey(n.expression) : null);

/** One file's sign sites and refusals, kept per (path, text): a planted tree re-reads only what it changed. */
const memo = new Map();
function fileCensus(file, text) {
  const key = `${file}\0${text}`;
  if (memo.has(key)) return memo.get(key);
  const sites = {};
  const refused = [];
  {
    const kind = KIND[path.extname(file)] ?? ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const at = (n) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const top = (n) => {
      let decl = null;
      while (n.parent && n.parent.kind !== ts.SyntaxKind.SourceFile) {
        if (ts.isVariableDeclaration(n) && ts.isVariableStatement(n.parent.parent) && n.parent.parent.parent.kind === ts.SyntaxKind.SourceFile) decl = n;
        n = n.parent;
      }
      const d = ts.isVariableStatement(n) ? decl ?? n.declarationList.declarations[0] : n;
      return d?.name && ts.isIdentifier(d.name) ? d.name.text : ts.isExportAssignment(n) ? "default" : `<statement at line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}>`;
    };
    const add = (n) => {
      const k = `${file}:${top(n)}`;
      sites[k] = (sites[k] ?? 0) + 1;
    };
    const module = (n, spec, how) => {
      if (spec === null) return refused.push(`${at(n)}: ${how} of a module that is not a plain string`);
      if (!spec.startsWith("./") && !spec.startsWith("../") && !ALLOWED.has(spec)) refused.push(`${at(n)}: ${how} of ${spec}, not an allowed module`);
      else if (spec === "node:crypto" && how !== "an import") refused.push(`${at(n)}: ${how} of node:crypto (only a named import of ${[...NODE_CRYPTO].join(", ")})`);
      else if (CURVES.test(spec) && how !== "an import") refused.push(`${at(n)}: ${how} of ${spec} (a curve is imported by name, never loaded at run time)`);
    };
    // the const aliases of x.subtle: read only as alias.<SUBTLE>
    const subtles = new Set();
    // the curve bindings: every local name an @noble/curves import makes
    const curves = new Set();
    for (const s of sf.statements) {
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
      const spec = s.moduleSpecifier.text;
      const c = s.importClause;
      if (spec === "node:crypto" && c && !c.isTypeOnly) {
        if (c.name) refused.push(`${at(s)}: a default import of node:crypto`);
        if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) refused.push(`${at(s)}: a namespace import of node:crypto`);
        if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) if (!NODE_CRYPTO.has((e.propertyName ?? e.name).text)) refused.push(`${at(e)}: node:crypto's ${(e.propertyName ?? e.name).text} imported`);
      }
      if (!CURVES.test(spec) || !c) continue;
      if (c.name) curves.add(c.name.text);
      if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) refused.push(`${at(s)}: a namespace import of ${spec}: import each curve by name`);
      if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) curves.add(e.name.text);
    }
    const aliases = (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isVariableDeclarationList(n.parent) && (n.parent.flags & ts.NodeFlags.Const) !== 0) {
        const init = unwrap(n.initializer);
        if (ts.isPropertyAccessExpression(init) && init.name.text === "subtle") subtles.add(n.name.text);
      }
      ts.forEachChild(n, aliases);
    };
    aliases(sf);
    const visit = (n) => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
        const spec = ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : null;
        module(n, spec, ts.isImportDeclaration(n) ? "an import" : "an export-from");
        if (ts.isExportDeclaration(n) && spec !== null && !spec.startsWith("./") && !spec.startsWith("../")) refused.push(`${at(n)}: an export-from of the package ${spec}`);
      }
      if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) module(n, literalKey(n.moduleReference.expression), "an import = require");
      if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
        module(n, n.arguments.length === 1 && (ts.isStringLiteral(n.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(n.arguments[0])) ? n.arguments[0].text : null, n.expression.kind === ts.SyntaxKind.ImportKeyword ? "import()" : "require()");
      }
      // sign members, on any receiver; subtle in any form
      if (ts.isPropertyAccessExpression(n)) {
        if (SIGN.has(n.name.text)) add(n);
        if (n.name.text === "subtle") {
          const use = outer(n);
          const p = use.parent;
          const alias = p && ts.isVariableDeclaration(p) && p.initializer === use && ts.isIdentifier(p.name) && ts.isVariableDeclarationList(p.parent) && (p.parent.flags & ts.NodeFlags.Const) !== 0;
          if (!alias && !(p && ts.isPropertyAccessExpression(p) && p.expression === use && SUBTLE.has(p.name.text))) refused.push(`${at(n)}: WebCrypto's subtle read other than as subtle.<${[...SUBTLE].join("|")}>`);
        }
      }
      if (ts.isElementAccessExpression(n)) {
        const key = literalKey(unwrap(n.argumentExpression));
        if (key !== null && SIGN.has(key)) add(n);
        if (key === "subtle") refused.push(`${at(n)}: WebCrypto's subtle read with a key (read it as x.subtle.<method>)`);
        const recv = unwrap(n.expression);
        if (key === null && ts.isIdentifier(recv) && curves.has(recv.text)) refused.push(`${at(n)}: the curve ${recv.text} read with a computed key`);
        if (key === null && ((ts.isIdentifier(recv) && (GLOBALS.has(recv.text) || subtles.has(recv.text))) || (ts.isPropertyAccessExpression(recv) && GLOBALS.has(recv.name.text)))) refused.push(`${at(n)}: ${recv.getText(sf)} read with a computed key`);
      }
      if (ts.isBindingElement(n)) {
        const key = nameOf(n.propertyName ?? n.name);
        if (key !== null && SIGN.has(key)) add(n);
        if (key === "subtle") refused.push(`${at(n)}: WebCrypto's subtle bound by a pattern (read it as x.subtle.<method>)`);
      }
      // a curve binding: only ever the receiver of a member read
      if (ts.isIdentifier(n) && subtles.has(n.text) && !(ts.isVariableDeclaration(n.parent) && n.parent.name === n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
        const use = outer(n);
        const p = use.parent;
        if (!(p && ts.isPropertyAccessExpression(p) && p.expression === use && SUBTLE.has(p.name.text))) refused.push(`${at(n)}: the subtle alias ${n.text} read other than as ${n.text}.<${[...SUBTLE].join("|")}>`);
      }
      if (ts.isIdentifier(n) && curves.has(n.text) && !ts.isImportSpecifier(n.parent) && !ts.isImportClause(n.parent)) {
        const use = outer(n);
        const p = use.parent;
        const member = p && (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === use;
        const typeOnly = p && (ts.isTypeQueryNode(p) || ts.isQualifiedName(p));
        if (ts.isExportSpecifier(p)) refused.push(`${at(n)}: the curve ${n.text} exported`);
        else if (!member && !typeOnly) refused.push(`${at(n)}: the curve ${n.text} handed on as a value`);
      }
      if (ts.isExportAssignment(n) && ts.isIdentifier(unwrap(n.expression)) && curves.has(unwrap(n.expression).text)) refused.push(`${at(n)}: the curve exported as the default`);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const out = { sites, refused };
  memo.set(key, out);
  return out;
}

/** The sign sites in `files` ({ path: text }) as { "path:statement": n }, and what is refused outright. */
export function census(files) {
  const sites = {};
  const refused = (files.links ?? []).map((l) => `${l}: a symlink in a source tree (never followed)`);
  for (const [file, text] of Object.entries(files)) {
    const one = fileCensus(file, text);
    for (const [k, n] of Object.entries(one.sites)) sites[k] = (sites[k] ?? 0) + n;
    refused.push(...one.refused);
  }
  return { sites, refused };
}

/** Every refusal for `files` against `list` (none: the census is the list). `exists` checks a listed test. */
export function check(files, list = SIGN_SITES, exists = () => true) {
  const { sites, refused } = census(files);
  const out = [...refused];
  for (const [k, n] of Object.entries(sites)) {
    if (!(k in list)) out.push(`${k}: a sign site with no entry in SIGN_SITES (add it, with the test that proves what it signs)`);
    else if (list[k].n !== n) out.push(`${k}: ${n} sign members, SIGN_SITES says ${list[k].n}`);
  }
  for (const [k, v] of Object.entries(list)) {
    if (!(k in sites)) out.push(`${k}: listed in SIGN_SITES but signs nothing (take its entry out)`);
    if (!exists(v.test)) out.push(`${k}: its proof test ${v.test} does not exist`);
  }
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."));
  const out = check(readTrees(root), SIGN_SITES, (t) => existsSync(path.join(root, t)));
  for (const l of out) console.error(`sign-sites: ${l}`);
  if (out.length > 0) process.exit(1);
  console.log(`sign-sites: OK (${Object.keys(SIGN_SITES).length} sign sites, each with its proof test)`);
}
