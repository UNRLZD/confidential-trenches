#!/usr/bin/env node
// Card signers-own-bytes (review 4 M2): every place the device, the signing page, the kit or the exit tool makes a
// signature, as file:function, is one of SIGN_SITES, and each entry names the test that proves what that site signs.
// A new signature anywhere in those four source trees, with no entry, fails:
//   node scripts/ci/sign-sites.mjs [root]      (exit 1 and one line per refusal)
// It reads every source file under packages/{wallet,kit,signpage,exit}/src (test files and .d.ts skipped), comments
// out, and counts as a site each reference to sign or signAsync of a binding imported from @noble/curves (a call, a
// bracketed or optional one, a destructuring or a value handed on), under the top-level declaration it sits in. It
// refuses outright what would sign out of its sight: a curve binding handed on whole, a namespace import of
// @noble/curves, a curve loaded at run time, another signing library, and WebCrypto's or node:crypto's sign.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Each sign site, the signatures it makes (`n`) and the test that proves what it signs. */
export const SIGN_SITES = {
  "packages/wallet/src/deposit/delegate.ts:signDelegateAction": { n: 1, test: "packages/wallet/test/deposit-delegate.test.ts" },
  "packages/wallet/src/deposit/moveout.ts:signMoveTx": { n: 1, test: "packages/wallet/test/deposit-moveout-signers.test.ts" },
  "packages/wallet/src/arming/records.ts:solanaArmedSigner": { n: 1, test: "packages/wallet/test/arm-records.test.ts" },
  "packages/kit/src/trade/evm/buy-unpinned.ts:evmPoolSignBuyUnpinned": { n: 1, test: "packages/kit/test/evm-pool-buy.test.ts" },
  "packages/kit/src/trade/evm/sell-unpinned.ts:signDigest": { n: 1, test: "packages/kit/test/evm-pool-sell.test.ts" },
  "packages/kit/src/trade/evm/sell-unpinned.ts:evmPoolSignSellAuthorizationUnpinned": { n: 1, test: "packages/kit/test/evm-pool-sell.test.ts" },
  "packages/signpage/src/rules/refund.ts:signIdIntent": { n: 1, test: "packages/signpage/test/rules-refund.test.ts" },
  "packages/signpage/src/rules/refund.ts:signReturnSolana": { n: 1, test: "packages/signpage/test/rules-refund.test.ts" },
  "packages/signpage/src/rules/refund.ts:signReturnEvm": { n: 1, test: "packages/signpage/test/rules-refund.test.ts" },
  "packages/signpage/src/rules/pool.ts:signSolana": { n: 1, test: "packages/signpage/test/rules-pool.test.ts" },
  "packages/signpage/src/rules/pool.ts:signEvmWithdraw": { n: 1, test: "packages/signpage/test/rules-pool.test.ts" },
  "packages/signpage/src/rules/pool.ts:signEvmOnwardSend": { n: 1, test: "packages/signpage/test/rules-pool-onward.test.ts" },
  "packages/signpage/src/rules/pool.ts:signEvmDeposit": { n: 1, test: "packages/signpage/test/rules-pool-deposit-evm.test.ts" },
};

export const TREES = ["packages/wallet/src", "packages/kit/src", "packages/signpage/src", "packages/exit/src"];
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIP = /\.test\.|\.d\.ts$/;

/** The source files of the four trees, as { path relative to root: text }. */
export function readTrees(root) {
  const files = {};
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (SOURCE.test(e.name) && !SKIP.test(e.name)) files[r] = readFileSync(path.join(root, r), "utf8");
    }
  };
  for (const t of TREES) walk(t);
  return files;
}

// The source with comments blanked (`code`, strings kept) and also strings, template text and regex literals blanked
// (`bare`), offsets kept: imports are read in `code`, every use of a curve in `bare`, so a word in a string is no use.
export function scan(s) {
  const code = s.split("");
  const bare = s.split("");
  const blank = (arr, i) => { if (arr[i] !== "\n") arr[i] = " "; };
  const stack = []; // template depths: each entry is the brace depth at which a ${ opened
  let depth = 0;
  let prev = ""; // the last significant code character, to tell a regex from a division
  let i = 0;
  const str = (q) => { // from the opening quote at i; leaves i after the closing one
    i++;
    while (i < s.length && s[i] !== q && s[i] !== "\n") { if (s[i] === "\\") { blank(bare, i); i++; } blank(bare, i); i++; }
    i++;
  };
  const tpl = () => { // template text from i (after a backtick or a closing brace of ${}); stops at the closing backtick or a ${
    while (i < s.length) {
      if (s[i] === "\\") { blank(bare, i); blank(bare, i + 1); i += 2; continue; }
      if (s[i] === "`") { i++; prev = "`"; return; }
      if (s[i] === "$" && s[i + 1] === "{") { stack.push(depth); depth++; i += 2; prev = "{"; return; }
      blank(bare, i); i++;
    }
  };
  while (i < s.length) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") { blank(code, i); blank(bare, i); i++; } continue; }
    if (c === "/" && s[i + 1] === "*") { const e = s.indexOf("*/", i + 2); const end = e === -1 ? s.length : e + 2; for (; i < end; i++) { blank(code, i); blank(bare, i); } continue; }
    if (c === "\"" || c === "'") { str(c); prev = c; continue; }
    if (c === "`") { i++; tpl(); continue; }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /\b(?:return|typeof|case|in|of|void|delete|throw|new)$/.test(s.slice(Math.max(0, i - 8), i).trimEnd()))) {
      i++;
      let cls = false;
      while (i < s.length && s[i] !== "\n" && (cls || s[i] !== "/")) { if (s[i] === "\\") { blank(bare, i); i++; } else if (s[i] === "[") cls = true; else if (s[i] === "]") cls = false; blank(bare, i); i++; }
      i++;
      prev = "/";
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") { depth--; if (stack.length > 0 && stack.at(-1) === depth) { stack.pop(); i++; tpl(); continue; } }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { code: code.join(""), bare: bare.join("") };
}
const OTHER_LIBS = /^import\b[^;]*?from\s*["'](tweetnacl[^"']*|@noble\/ed25519[^"']*|@noble\/secp256k1[^"']*|@solana\/web3\.js[^"']*|@solana\/kit[^"']*|ethers[^"']*|viem[^"']*|elliptic[^"']*|libsodium[^"']*|@stablelib\/[^"']*)["']/gm;
const RUNTIME_CURVE = /\b(?:require|import)\s*\(\s*["'`]@noble\/curves/g;
const NATIVE_SIGN = /\bsubtle\s*\.\s*sign\b|\bcreateSign\b|(?<![\w$.])(?:crypto|nodeCrypto)\s*\.\s*sign\s*\(/g;
const NATIVE_IMPORT = /^import\s*\{[^}]*\bsign\b[^}]*\}\s*from\s*["'](?:node:)?crypto["']/gm;
const TOP = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\s*\*?\s*([\w$]+)|(?:const|let|var)\s+([\w$]+)|(?:abstract\s+)?class\s+([\w$]+))/gm;

/** The sign sites in `files` ({ path: text }) as { "path:function": n }, and what is refused outright. */
export function census(files) {
  const sites = {};
  const refused = [];
  for (const [file, text] of Object.entries(files)) {
    const { code: src, bare } = scan(text);
    const tops = [...bare.matchAll(TOP)].map((m) => ({ at: m.index, name: m[1] ?? m[2] ?? m[3] }));
    const where = (at) => tops.filter((t) => t.at <= at).at(-1)?.name ?? "<module>";
    const add = (at) => {
      const k = `${file}:${where(at)}`;
      sites[k] = (sites[k] ?? 0) + 1;
    };
    for (const m of src.matchAll(OTHER_LIBS)) refused.push(`${file}: imports another signing library, ${m[1]}`);
    const isCode = (at) => bare.slice(at, at + 2) === src.slice(at, at + 2);
    for (const m of src.matchAll(RUNTIME_CURVE)) if (isCode(m.index)) refused.push(`${file}:${where(m.index)}: loads @noble/curves at run time`);
    for (const m of [...bare.matchAll(NATIVE_SIGN), ...src.matchAll(NATIVE_IMPORT)]) refused.push(`${file}:${where(m.index)}: signs with WebCrypto or node:crypto (${m[0].trim()})`);
    const curves = [];
    for (const m of src.matchAll(/^import\s+(type\s+)?([^;]*?)\s*from\s*["']@noble\/curves[^"']*["']/gm)) {
      if (m[1]) continue;
      const clause = m[2];
      if (/\*\s*as\s+/.test(clause)) refused.push(`${file}: a namespace import of @noble/curves (${clause.trim()}): import each curve by name`);
      const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
      for (const part of named.split(",")) {
        const p = part.trim().replace(/^type\s+/, "");
        if (!p || part.trim().startsWith("type ")) continue;
        const [, local] = /^[\w$]+(?:\s+as\s+([\w$]+))?$/.exec(p) ?? [];
        curves.push(local ?? p);
      }
      const dflt = /^([\w$]+)\s*(?:,|$)/.exec(clause.trim());
      if (dflt) curves.push(dflt[1]);
    }
    for (const c of curves) {
      const e = c.replace(/\$/g, "\\$");
      // c.sign / c?.sign / c["sign"] / c.signAsync: a site, called or not
      for (const m of bare.matchAll(new RegExp(`(?<![\\w$.])${e}\\s*(?:\\?\\.\\s*|\\.\\s*)(?:sign|signAsync)(?![\\w$])`, "g"))) add(m.index);
      for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${e}\\s*(?:\\?\\.)?\\[\\s*["'\`](?:sign|signAsync)["'\`]\\s*\\]`, "g"))) if (isCode(m.index)) add(m.index);
      // { sign } = c: a site
      for (const m of bare.matchAll(new RegExp(`\\{[^{}]*\\b(?:sign|signAsync)\\b[^{}]*\\}\\s*=\\s*${e}(?![\\w$])`, "g"))) add(m.index);
      // c handed on whole (not a member read, not the import itself): refused, since what it signs is out of sight
      for (const m of bare.matchAll(new RegExp(`(?<![\\w$.])${e}(?![\\w$])(?!\\s*(?:\\?\\.|\\.|\\[|\\s+as\\b))`, "g"))) {
        const line = bare.slice(bare.lastIndexOf("\n", m.index) + 1, bare.indexOf("\n", m.index) === -1 ? undefined : bare.indexOf("\n", m.index));
        if (/^\s*import\b/.test(line)) continue;
        refused.push(`${file}:${where(m.index)}: the curve ${c} is handed on as a value`);
      }
    }
  }
  return { sites, refused };
}

/** Every refusal for `files` against SIGN_SITES (none: the census is the list). `exists` checks a listed test. */
export function check(files, list = SIGN_SITES, exists = () => true) {
  const { sites, refused } = census(files);
  const out = [...refused];
  for (const [k, n] of Object.entries(sites)) {
    if (!(k in list)) out.push(`${k}: a sign site with no entry in SIGN_SITES (add it, with the test that proves what it signs)`);
    else if (list[k].n !== n) out.push(`${k}: ${n} signatures, SIGN_SITES says ${list[k].n}`);
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
