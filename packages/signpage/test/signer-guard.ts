// The signer guard's reader (card signer-guard-parser; reviewer L3 of pool-restore-wired): an EVM pool deposit or sell
// signs on a precommitment anyone who sees it pending can take first, so every device file that can sign one must
// pick its note through the wallet's evmNextNote (card precommit-taken-recover, test/pool-kinds.test.ts). A guard that
// matches names can be walked past by a rename, an alias or a `.call`, and flags the kit index's re-exports by their
// bare name. This one reads code: the TypeScript compiler binds every name to its declaration, through aliased and
// namespace imports and `export *` re-exports, so a file is held by what it reaches, never by how it spells it. A form
// it cannot follow is refused, never passed.
//
// The rules, outside what EXEMPT lets a file or a function do (each only what it needs):
// - A signer is every value a SIGNER_DEFS file exports, but the ones NON_SIGNERS names. In every file, the signer files
//   included, it may only be called (direct, or through .call, .apply, or a .bind called at once) or re-exported; any
//   other mention (held, handed on, returned, destructured, put on globalThis) refuses. A call outside the signer files
//   needs a pick: a call of the wallet's own evmNextNote that runs before it on every path (see "a pick" below).
// - A pool deposit or sell encoded: a string built of literals that holds deposit(uint256,uint256), its selector
//   e2bbb158, the EIP-712 Sell type or its hash (the kit's and the helper's), the selector or a hash as a number or as
//   an array of byte literals, functionName "deposit" (viem), the ABI entry { type: "function", name: "deposit" }, or an
//   ethers-style encoder called on "deposit". It needs a pick, as a call does.
// - A module that exports a signer, seen by its symbol or by its type (a namespace import, an import()'s value): only
//   `ns.x`, `ns["x"]` or `{ x, y: z } = ns` of it is read; any other use, a computed key or a `...rest` refuses. An
//   import() of such a module, an import() the program cannot bind to a module, and import.meta.glob refuse.
// - The packages that sign a secp256k1 digest (PINNED: noble's secp256k1 and abstract/weierstrass, @scure/bip32): a
//   file imports only their named roots, and a value of their signing types (the curve's ECDSA and its Point, an
//   HDKey) is only read by the members PINNED names for that type (none signs), called, kept under its own type or
//   handed on as its own type. A cast, a computed key, a `new`, or a hand-on to another type refuses. A module that
//   exports a PINNED root, the package itself or a module of ours that re-exports it, is held as a signer's module is
//   (a literal member read only), each name read off it held as a named import is (a pinned package's export only if
//   its names hold it: no schnorr), and an import() of one refuses. Signing with them is only in the top-level functions
//   EXEMPT names (a function nested in another, whatever its name, is not one).
// - Code from text: eval, Function (by name, or a callee of the type Function, as `.constructor` gives), setTimeout or
//   setInterval given a string, node:vm, and a call off globalThis, window or self through a cast refuse. The page's
//   CSP blocks them too; the guard does not rest on it.
// - A device file never imports the helper (apps/helper/): a server file, whose sender key signs its own sends.
// - A pick: a call of evmNextNote, by any name, in an expression or a const/let statement that comes before the site in
//   a block the site sits in (its own function's, or an enclosing one's; a callback made after the pick runs after it),
//   and not under an if, a loop, a try, a `?:`, the right of `&&`/`||`/`??`, a `?.` or a function of its own. A pick
//   at the module's top level runs once, at load: it counts for top-level code only, never for a function, a class
//   element or a decorator (a static one, run once at load, is then a false refusal, which fails safe). A function
//   declaration (hoisted, so callable before) takes no pick from above it. This proves a pick runs first; it does not
//   prove the pick's note is the one the site signs, nor one pick per sign (one pick before a loop of signs passes),
//   which is the flow's own test. A pick in a try or in a case clause does not count: a false refusal, which fails
//   safe.
//
// What a reader of code cannot tell, and the guard does not claim (the signing page's own run-time checks, its CSP and
// review hold these):
// - a signature computed by hand from bigint arithmetic (the curve's constants from Point.CURVE() are free);
// - a value typed `any` reached with computed names: a signer or a signing package handed over where no rule above
//   sees it, or the AsyncFunction constructor read through Object.getPrototypeOf (typed `any`), which the page's CSP
//   (no unsafe-eval) blocks at run time;
// - code loaded from a URL at run time (a worker, a script tag), which the page's CSP and its pinned worker hash hold.
import ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ROOT = new URL("../../../", import.meta.url).pathname;
/** The files that define the EVM sell builders and signers: the kit's and the rule's, and quoted.ts, whose
 *  evmQuotedSell builds the sell a signer signs on the precommitment its fields name. */
export const SIGNER_DEFS = ["packages/kit/src/trade/evm/sell.ts", "packages/kit/src/trade/evm/sell-unpinned.ts", "packages/kit/src/trade/evm/quoted.ts", "packages/signpage/src/rules/pool.ts"];
/** Values the SIGNER_DEFS files export that build and sign no pool sell: constants, an error, predicates, reads of a
 *  route or a fee, and the rule's other kinds (Solana, an EVM buy or withdraw, an onward send), which sign on no
 *  precommitment of a sell or a deposit. Every other export is a signer, so a new one is held until it is named here. */
export const NON_SIGNERS: Readonly<Record<string, readonly string[]>> = {
  "packages/kit/src/trade/evm/sell.ts": ["EVM_POOL_SELL_DEADLINE_MAX_S", "EVM_POOL_SELL_DEADLINE_MIN_S", "EvmPoolSellError", "EVM_SELL_SIM"],
  "packages/kit/src/trade/evm/sell-unpinned.ts": ["evmHookListed", "evmSellRouteCheck", "evmSellRouteOf", "evmPoolSellFeeMax", "EVM_POOL_SELL_DEADLINE_MIN_S", "EVM_POOL_SELL_DEADLINE_MAX_S", "EvmPoolSellError", "EVM_SELL_SIM", "EVM_POOL_SELL_GAS", "evmPoolSellTip", "EVM_7702_AUTH_GAS"],
  "packages/kit/src/trade/evm/quoted.ts": ["evmQuotedBuy", "evmIsQuotedBuy", "evmIsQuotedSell"],
  "packages/signpage/src/rules/pool.ts": [
    "poolTokenAddress", "tokenDecimalsOf", "checkPoolRequest", "checkSolanaDeposit", "checkSolanaWithdraw", "checkSolanaOnwardSend", "checkSolanaBuy", "checkSolanaSell",
    "solanaDepositRents", "checkSolanaSweep", "checkSolanaTeardownFrames", "signSolana", "checkEvmBuy", "checkEvmWithdraw", "checkEvmSell", "checkEvmSellSim", "checkEvmAuthorization",
    "signEvmBuy", "evmWithdrawDigest", "signEvmWithdraw", "checkEvmOnwardSend", "evmOnwardSendDigest", "signEvmOnwardSend", "poolUnits", "drawPool", "POOL_KINDS", "POOL_CHAINS",
    "SOLANA_POOL_TAG_DEPOSIT", "SOLANA_POOL_DEPOSIT_LEN", "POOL_MAX_SLIPPAGE_BPS", "SOLANA_POOL_CU_LIMIT_MAX", "SOLANA_POOL_TX_FEE_MAX", "SOLANA_RENT_PER_BYTE_MAX", "SOLANA_POOL_SELL_RESERVE_MAX",
    "PoolRuleRefused", "SOL_KEY", "EVM_ADDRESS", "POOL_ASSET_DECIMALS_OF", "SOLANA_RESERVED_KEYS", "SOLANA_POOL_MIN_DEPOSIT", "solanaWithdrawMinPart", "withdrawNoteFloor", "solanaSweepFloor",
    "EVM_ONWARD_GAS", "EVM_ONWARD_GAS_MAX",
  ],
};
/** What each file may do, and only that: `define` (a signer file: it calls its own signers with no pick), `calls`
 *  (signers it may call with no pick), `curve` (the functions that sign with a PINNED package), `sellType` (the
 *  declarations that hold the EIP-712 Sell type). A function is the nearest named function, method or const a site
 *  sits in. */
export type Exempt = { define?: true; calls?: readonly string[]; curve?: readonly string[]; sellType?: readonly string[] };
export const EXEMPT: Readonly<Record<string, Exempt>> = {
  "packages/kit/src/trade/evm/sell.ts": { define: true },
  // a sell's signature and W's EIP-7702 authorization (sell-unpinned.ts:434, 463); the Sell digest (:411)
  "packages/kit/src/trade/evm/sell-unpinned.ts": { define: true, curve: ["signDigest", "evmPoolSignSellAuthorizationUnpinned"], sellType: ["sellDigest"] },
  "packages/kit/src/trade/evm/quoted.ts": { define: true },
  "packages/signpage/src/rules/pool.ts": { define: true, curve: ["signEvmWithdraw", "signEvmOnwardSend"] }, // rules/pool.ts:853, 1020
  "packages/kit/src/trade/evm/buy-unpinned.ts": { curve: ["evmPoolSignBuyUnpinned"] }, // a buy's signature, buy-unpinned.ts:612
  // a quote's simulation: a sim sell built and its call data encoded, signed by its caller on the note the caller names
  "packages/kit/src/checks/evm/quote.ts": { calls: ["evmPoolBuildSimSellUnpinned", "evmSellCallData"] },
  // the helper (a server file, never on the page): its sender key signs its own relay sends (signEvmTx, signEvmTx4),
  // and it checks a sell's signature against the Sell digest (evmSellDigest reads SELL_TYPE); it signs no sell
  "apps/helper/src/pool/evm.ts": { curve: ["signEvmTx", "signEvmTx4"], sellType: ["SELL_TYPE"] },
};
/** The wallet's note pick, and the name it is exported by. */
export const NEXT_NOTE = { file: "packages/wallet/src/pool/evm-restore.ts", name: "evmNextNote" };
/** The npm packages the device holds that sign a secp256k1 digest. `roots`: the files a name may be imported from, and
 *  `names` the ones it may be; `types`: the types in `typeFiles` that sign or make a signature (noble's ECDSA; the
 *  curve's Point, whose BASE.multiply and scalar field make one by hand; bip32's HDKey, a class and its keys), each with
 *  the members a value of it may use. These sign nothing: a public key, a key's checks, a signer's key recovered (the
 *  helper's check), a point read from bytes and back and the curve's constants, and the HD path's steps with their wipe
 *  (wallet/derive/keys.ts:180-195); `sign`, `keygen`, `Signature`, `BASE`, `Fn`, `multiply`, `derive` and the rest
 *  refuse. A `device` type is held in device files only: the helper (a server file, which no device file may import)
 *  checks Groth16 proofs with bn254's points, of the same Weierstrass type. */
const PINNED = [
  {
    pkg: "@noble/curves",
    roots: /[\\/]@noble[\\/]curves[\\/](?:src[\\/])?(?:secp256k1\.|abstract[\\/])/,
    names: ["secp256k1"],
    typeFiles: /[\\/]@noble[\\/]curves[\\/](?:src[\\/])?abstract[\\/]weierstrass\.(?:d\.ts|ts|js)$/,
    types: {
      ECDSA: { members: ["getPublicKey", "utils", "Point", "recoverPublicKey"] },
      WeierstrassPointCons: { members: ["fromBytes", "fromHex", "CURVE"], device: true },
      WeierstrassPoint: { members: ["toBytes", "toHex", "equals"], device: true },
    },
  },
  {
    pkg: "@scure/bip32",
    roots: /[\\/]@scure[\\/]bip32[\\/]/,
    names: ["HDKey"],
    typeFiles: /[\\/]@scure[\\/]bip32[\\/]/,
    types: { HDKey: { members: ["fromMasterSeed", "deriveChild", "privateKey", "publicKey", "wipePrivateData"] } },
  },
] as const;
const DEPOSIT_SIG = "deposit(uint256,uint256)";
const DEPOSIT_SELECTOR = "e2bbb158";
/** The EIP-712 Sell type (sell-unpinned.ts), spaces dropped: a sell's digest built by hand starts from it. */
const SELL_TYPE = "sell(addresstoken,uint256amount,addresstarget";
/** keccak256 of the Sell type: the 11-field one SellDelegate checks (the kit's sell-unpinned.ts:411, the helper's
 *  pool/evm.ts SELL_TYPE) and the 10-field one before pool-review-3 put feeRecipient after feeCap. */
const SELL_TYPEHASHES = ["7964e18e540efb8e58098ce102bf5d1c94cc5fd69638a343b633d8b9d3767aa7", "de872827292ed3a7dbdb9c7287df9155f2f39cbd08f39dad7bed050e60ccc0ce"];
/** A TypeScript lib file: where eval, Function, globalThis and the timers are declared. */
const LIB = /[\\/]typescript[\\/]lib[\\/]lib\.[^\\/]*\.d\.ts$/;
/** ethers- and web3-style encoders whose first argument names the function. */
const ENCODERS = new Set(["encodeFunctionData", "encodeFunctionCall", "encodeFunctionSignature", "getFunction", "getSighash", "getSelector", "toFunctionSelector"]);

const OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  noEmit: true,
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  jsx: ts.JsxEmit.Preserve,
  skipLibCheck: true,
  types: [],
};

/** The signing page's build entry, read from the build itself (scripts/build-app.mjs, its `input:`), so the guard reads
 *  what the page bundles, never a hand list. */
export function buildEntry(script = join(ROOT, "packages/signpage/scripts/build-app.mjs")): string {
  const sf = ts.createSourceFile(script, readFileSync(script, "utf8"), ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    // input: join(pkg, "src/main.ts"), pkg the package folder
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "input") {
      const v = n.initializer;
      if (ts.isCallExpression(v) && v.expression.getText(sf) === "join" && v.arguments.length === 2 && v.arguments[0]!.getText(sf) === "pkg" && ts.isStringLiteral(v.arguments[1]!)) {
        found.push(join(dirname(dirname(script)), v.arguments[1].text));
      } else found.push(`unread: ${v.getText(sf)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (found.length !== 1 || found[0]!.startsWith("unread")) throw new Error(`build-app.mjs: expected one input: join(pkg, "<entry>"), read ${JSON.stringify(found)}`);
  return found[0]!;
}

/** A site the guard read: `ok` false refuses its file. */
export type Site = { path: string; line: number; what: string; ok: boolean };
export type Guard = {
  /** The signers, as "<repo path>#<name>". */
  signers: string[];
  /** Every repo file reachable from `entry` by its static and dynamic imports and re-exports (node_modules aside). */
  graph: string[];
  /** Import specifiers of ours in the read files that bind to no module: a name through one could not be resolved. */
  unresolved: string[];
  /** The files with a site that refuses: absolute paths. */
  unguarded: (files: readonly string[]) => string[];
  /** Every site the guard reads in `file`: a signer reached, a deposit or sell encoded, a namespace or the curve used. */
  sites: (file: string) => Site[];
};

const rel = (p: string) => (p.startsWith(ROOT) ? p.slice(ROOT.length) : p);
const isWrap = (e: ts.Node): e is ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression | ts.NonNullExpression | ts.TypeAssertion | ts.ExpressionWithTypeArguments =>
  ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) || ts.isExpressionWithTypeArguments(e);
const strip = (e: ts.Expression): ts.Expression => {
  while (isWrap(e)) e = e.expression;
  return e;
};
/** The outermost expression `e` stands for, through parentheses and casts. */
const outer = (e: ts.Node): ts.Node => {
  while (e.parent && isWrap(e.parent)) e = e.parent;
  return e;
};
/** A string built of literals (joined by `+`), or null. */
const literal = (e: ts.Expression): string | null => {
  e = strip(e);
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = literal(e.left);
    const b = a === null ? null : literal(e.right);
    return a === null || b === null ? null : a + b;
  }
  return null;
};
const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
/** What a text (spaces dropped, lower case) encodes: the deposit, by its signature or selector, or a Sell type hash. */
const encoding = (t: string): string | null => (t.includes(DEPOSIT_SIG) || t.includes(DEPOSIT_SELECTOR) ? "the deposit" : SELL_TYPEHASHES.some((h) => t.includes(h)) ? "the Sell type hash" : null);
/** The hex of a list of byte literals (0..255), as `[0xe2, 0xbb, ...]` or `Uint8Array.of(...)` writes them, or null. */
const bytesHex = (xs: readonly ts.Node[], sf: ts.SourceFile): string | null => {
  if (xs.length < 4) return null;
  let out = "";
  for (const x of xs) {
    if (!ts.isNumericLiteral(x)) return null;
    const v = Number(x.getText(sf).replace(/_/g, ""));
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    out += v.toString(16).padStart(2, "0");
  }
  return out;
};
/** True when `n` sits in a type, where a name signs nothing (`typeof x`, an annotation, `implements`). */
const inType = (n: ts.Node): boolean => {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isExpressionWithTypeArguments(p)) {
      const h = p.parent;
      if (ts.isHeritageClause(h) && (h.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(h.parent))) return true;
      continue; // `class X extends y` and an instantiation `x<T>` are values
    }
    if (ts.isTypeNode(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p)) return true;
  }
  return false;
};
/** True when `n` is a name inside an import or export declaration, or `export default x`: a binding or a re-export. */
const inModuleDecl = (n: ts.Node): boolean => {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportEqualsDeclaration(p)) return true;
    if (ts.isExportAssignment(p)) return strip(p.expression) === n;
    if (ts.isStatement(p)) return false;
  }
  return false;
};
/** The name of the top-level declaration of its file that `n` sits in: a function, a class, or the const or let that
 *  holds `n`; null for any other statement. A function nested in it, whatever its name, is that declaration's. */
const topName = (n: ts.Node): string | null => {
  let c: ts.Node = n;
  while (c.parent && !ts.isSourceFile(c.parent)) c = c.parent;
  if ((ts.isFunctionDeclaration(c) || ts.isClassDeclaration(c)) && c.name) return c.name.text;
  if (ts.isVariableStatement(c)) for (const d of c.declarationList.declarations) if (d.pos <= n.pos && n.end <= d.end && ts.isIdentifier(d.name)) return d.name.text;
  return null;
};
/** True when `n`, inside `stmt`, runs whenever `stmt` runs: no function, class, `?:` branch, right of a short circuit
 *  or `?.` between them. */
const always = (n: ts.Node, stmt: ts.Node): boolean => {
  for (let c = n, p = n.parent; p && c !== stmt; c = p, p = p.parent) {
    if (ts.isFunctionLike(p) || ts.isClassLike(p)) return false;
    if (ts.isConditionalExpression(p) && c !== p.condition) return false;
    if (ts.isBinaryExpression(p) && c === p.right && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(p.operatorToken.kind)) return false;
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.flags & ts.NodeFlags.OptionalChain) return false;
  }
  return true;
};

/**
 * Reads `roots` (absolute paths: the build's entry and any other files to hold) and everything they import into one
 * TypeScript program, and returns the guard. `defs` are the repo paths whose exports are the signers (`nonSigners`
 * aside); `virtual` adds files by absolute path and text, read as if on disk; `exempt` is EXEMPT, or a test's own.
 */
export function signerGuard(entry: string, roots: readonly string[], defs: readonly string[] = SIGNER_DEFS, virtual: ReadonlyMap<string, string> = new Map(), nonSigners: Readonly<Record<string, readonly string[]>> = NON_SIGNERS, exempt: Readonly<Record<string, Exempt>> = EXEMPT): Guard {
  const host = ts.createCompilerHost(OPTIONS);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (name, lang, ...rest) => (virtual.has(name) ? ts.createSourceFile(name, virtual.get(name)!, lang, true) : getSourceFile.call(host, name, lang, ...rest));
  host.fileExists = (name) => virtual.has(name) || fileExists.call(host, name);
  host.readFile = (name) => virtual.get(name) ?? readFile.call(host, name);
  const program = ts.createProgram([entry, ...roots, ...virtual.keys()], OPTIONS, host);
  const checker = program.getTypeChecker();
  const file = (p: string): ts.SourceFile => {
    const sf = program.getSourceFile(p);
    if (!sf) throw new Error(`not in the program: ${p}`);
    return sf;
  };
  const real = (s: ts.Symbol): ts.Symbol => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
  const exportsOf = (p: string): Map<string, ts.Symbol> => {
    const m = checker.getSymbolAtLocation(file(p));
    if (!m) throw new Error(`no module symbol: ${p}`);
    return new Map(checker.getExportsOfModule(m).map((s) => [s.name, real(s)]));
  };
  const signers = new Map<ts.Symbol, string>();
  for (const d of defs) {
    const not = new Set(nonSigners[d] ?? []);
    for (const [name, s] of exportsOf(join(ROOT, d))) if (s.flags & ts.SymbolFlags.Value && !not.has(name)) signers.set(s, `${d}#${name}`);
  }
  const next = exportsOf(join(ROOT, NEXT_NOTE.file)).get(NEXT_NOTE.name);
  if (!next) throw new Error(`${NEXT_NOTE.file} exports no ${NEXT_NOTE.name}`);
  const NEXT = new Map([[next, `${NEXT_NOTE.file}#${NEXT_NOTE.name}`]]);

  // which value a symbol holds: the symbol itself, or (a const, a let, a property) what it was given, followed
  const memo = new WeakMap<Map<ts.Symbol, string>, Map<ts.Symbol, string | null>>();
  const holds = (s: ts.Symbol | undefined, set: Map<ts.Symbol, string>, seen?: Set<ts.Symbol>): string | null => {
    if (!s) return null;
    s = real(s);
    if (set.has(s)) return set.get(s)!;
    if (!seen) {
      // a top-level read is kept; one inside a cycle is not (it may stop short at a symbol already on the way)
      const m = memo.get(set) ?? new Map<ts.Symbol, string | null>();
      memo.set(set, m);
      if (!m.has(s)) m.set(s, holds(s, set, new Set()));
      return m.get(s)!;
    }
    if (seen.has(s)) return null;
    seen.add(s);
    for (const d of s.declarations ?? []) {
      if (ts.isVariableDeclaration(d) && d.initializer) {
        const h = valueOf(d.initializer, set, seen);
        if (h) return h;
      }
      if (ts.isBindingElement(d)) {
        const pattern = d.parent;
        const owner = pattern.parent;
        const key = d.propertyName ?? d.name;
        if (ts.isObjectBindingPattern(pattern) && ts.isVariableDeclaration(owner) && owner.initializer && (ts.isIdentifier(key) || ts.isStringLiteral(key))) {
          const h = holds(checker.getPropertyOfType(checker.getTypeAtLocation(owner.initializer), key.text), set, seen);
          if (h) return h;
        }
      }
      if (ts.isPropertyAssignment(d)) {
        const h = valueOf(d.initializer, set, seen);
        if (h) return h;
      }
      if (ts.isShorthandPropertyAssignment(d)) {
        const h = holds(checker.getShorthandAssignmentValueSymbol(d), set, seen);
        if (h) return h;
      }
      // a let given a value later, in the file that declares it (an import cannot be assigned)
      if (ts.isVariableDeclaration(d) && !(ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const)) {
        let found: string | null = null;
        const scan = (n: ts.Node): void => {
          if (found) return;
          if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(strip(n.left)) && checker.getSymbolAtLocation(strip(n.left)) === s) found = valueOf(n.right, set, seen);
          ts.forEachChild(n, scan);
        };
        scan(d.getSourceFile());
        if (found) return found;
      }
    }
    return null;
  };
  const symbolOf = (e: ts.Expression): ts.Symbol | undefined => {
    if (ts.isIdentifier(e)) return checker.getSymbolAtLocation(e);
    if (ts.isPropertyAccessExpression(e)) return checker.getSymbolAtLocation(e.name);
    if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return checker.getPropertyOfType(checker.getTypeAtLocation(e.expression), e.argumentExpression.text);
    return undefined;
  };
  const valueOf = (e: ts.Expression, set: Map<ts.Symbol, string>, seen?: Set<ts.Symbol>): string | null => {
    e = strip(e);
    if (ts.isConditionalExpression(e)) return valueOf(e.whenTrue, set, seen) ?? valueOf(e.whenFalse, set, seen);
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.CommaToken].includes(e.operatorToken.kind)) {
      return (e.operatorToken.kind === ts.SyntaxKind.CommaToken ? null : valueOf(e.left, set, seen)) ?? valueOf(e.right, set, seen);
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "bind") return valueOf(e.expression.expression, set, seen);
    return holds(symbolOf(e), set, seen);
  };
  /** A module that exports a signer, or null. */
  const moduleSigner = (s: ts.Symbol | undefined): string | null => {
    if (!s) return null;
    s = real(s);
    if (!(s.flags & ts.SymbolFlags.ValueModule)) return null;
    for (const x of checker.getExportsOfModule(s)) if (signers.has(real(x))) return signers.get(real(x))!;
    return null;
  };
  type Pinned = (typeof PINNED)[number];
  /** A pinned type: its package, its name, the members a value of it may use, and whether only device files are held. */
  type PinnedType = { pk: Pinned; name: string; members: readonly string[]; device: boolean };
  /** The PINNED package a name is imported from, or null. */
  const rootIn = (s: ts.Symbol): Pinned | null => {
    for (const d of real(s).declarations ?? []) {
      const p = PINNED.find((x) => x.roots.test(d.getSourceFile().fileName));
      if (p) return p;
    }
    return null;
  };
  /** The pinned type `s` is, or null. */
  const typeIn = (s: ts.Symbol | undefined): PinnedType | null => {
    if (!s) return null;
    for (const d of s.declarations ?? []) {
      const pk = PINNED.find((x) => x.typeFiles.test(d.getSourceFile().fileName) && Object.hasOwn(x.types, s.name));
      if (pk) {
        const t = (pk.types as Readonly<Record<string, { members: readonly string[]; device?: true }>>)[s.name]!;
        return { pk, name: s.name, members: t.members, device: !!t.device };
      }
    }
    return null;
  };
  /** A module (a namespace, an import()'s value, a module of ours that re-exports one) that exports a PINNED root:
   *  its package, or null. */
  const modulePinned = (s: ts.Symbol | undefined): string | null => {
    if (!s) return null;
    s = real(s);
    if (!(s.flags & ts.SymbolFlags.ValueModule)) return null;
    for (const x of checker.getExportsOfModule(s)) {
      const pk = rootIn(x);
      if (pk) return pk.pkg;
    }
    return null;
  };
  const typeMemo = new Map<ts.Type, PinnedType | null>();
  /** The pinned type a type is (a union or an intersection: any of its parts), or null. */
  const pinnedType = (t: ts.Type): PinnedType | null => {
    const hit = typeMemo.get(t);
    if (hit !== undefined) return hit;
    typeMemo.set(t, null);
    let p = typeIn(t.getSymbol()) ?? typeIn(t.aliasSymbol);
    if (!p && t.isUnionOrIntersection()) for (const u of t.types) if ((p = pinnedType(u))) break;
    typeMemo.set(t, p);
    return p;
  };
  /** A name declared in a TypeScript lib file (eval, Function, globalThis, the timers), not one of ours. */
  const fromLib = (s: ts.Symbol | undefined): boolean => !!s && (real(s).declarations ?? []).some((d) => LIB.test(d.getSourceFile().fileName));
  /** The call `ref` is the callee of: direct, through .call/.apply, or a .bind called at once; null when it is not. */
  const callOf = (ref: ts.Node): ts.CallExpression | null => {
    const e = outer(ref);
    const p = e.parent;
    if (p && ts.isCallExpression(p) && p.expression === e) return p;
    if (p && ts.isPropertyAccessExpression(p) && p.expression === e) {
      const pe = outer(p);
      const c = pe.parent;
      if (c && ts.isCallExpression(c) && c.expression === pe) {
        if (p.name.text === "call" || p.name.text === "apply") return c;
        if (p.name.text === "bind") {
          const ce = outer(c);
          const cc = ce.parent;
          if (cc && ts.isCallExpression(cc) && cc.expression === ce) return cc;
        }
      }
    }
    return null;
  };
  /** The statements of `sf` holding a call of the wallet's evmNextNote (by any name, directly or via .call/.apply)
   *  that runs whenever the statement does: an expression statement or a const/let (see `always`). */
  const pickCache = new Map<string, Set<ts.Node>>();
  const picks = (sf: ts.SourceFile): Set<ts.Node> => {
    const hit = pickCache.get(sf.fileName);
    if (hit) return hit;
    const out = new Set<ts.Node>();
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        let c = strip(n.expression);
        if (ts.isPropertyAccessExpression(c) && (c.name.text === "call" || c.name.text === "apply")) c = strip(c.expression);
        if (valueOf(c, NEXT)) {
          for (let p = n.parent; p; p = p.parent) {
            if (ts.isFunctionLike(p) || ts.isClassLike(p)) break;
            if (ts.isStatement(p)) {
              if ((ts.isExpressionStatement(p) || ts.isVariableStatement(p)) && always(n, p)) out.add(p);
              break;
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    pickCache.set(sf.fileName, out);
    return out;
  };
  /** True when a pick runs before `n` on every path: a pick statement comes before `n` in a block `n` sits in, in its
   *  own function or an enclosing one (the module's own top level only for code outside any function), and no function
   *  declaration (hoisted) stands between. */
  const pickedBefore = (n: ts.Node): boolean => {
    const ps = picks(n.getSourceFile());
    if (!ps.size) return false;
    let inFunction = false;
    for (let c: ts.Node = n, p = n.parent; p; c = p, p = p.parent) {
      // a class element (a field, a method, a static block, a parameter property) or a decorator runs when its class is
      // made or used, never only at load: a function for the cutoff (a static one, run once at load, then refuses:
      // a false refusal, which fails safe)
      if (ts.isFunctionLike(p) || ts.isClassElement(p) || ts.isDecorator(p)) inFunction = true;
      // a pick at module load runs once: it counts for the module's own code, never for a function it holds
      if ((ts.isSourceFile(p) || ts.isModuleBlock(p)) && inFunction) return false;
      if (!(ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p))) continue;
      const i = p.statements.indexOf(c as ts.Statement);
      if (i < 0) continue;
      if (ts.isFunctionDeclaration(c)) return false;
      for (let j = 0; j < i; j++) if (ps.has(p.statements[j]!)) return true;
    }
    return false;
  };

  const siteCache = new Map<string, Site[]>();
  const sites = (path: string): Site[] => {
    const hit = siteCache.get(path);
    if (hit) return hit;
    const sf = file(path);
    const ex: Exempt = exempt[rel(path)] ?? {};
    const device = !rel(path).startsWith("apps/helper/");
    const out: Site[] = [];
    const at = (n: ts.Node, what: string, ok: boolean): void => {
      out.push({ path: rel(path), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, what, ok });
    };
    // a call, or an encoding, needs a pick that runs before it
    const needsPick = (n: ts.Node, what: string) => {
      const ok = pickedBefore(n);
      at(n, ok ? what : `${what}, with no evmNextNote run before it`, ok);
    };
    /** A mention of signer `h` at `ref`: a call (held to a pick but in its own file), or anything else (refused). */
    const signer = (ref: ts.Node, h: string) => {
      if (!callOf(ref)) return at(ref, `holds or hands on ${h} (a signer is only called or re-exported)`, false);
      if (ex.define) return at(ref, `calls ${h} (a signer file)`, true);
      if (ex.calls?.includes(h.slice(h.indexOf("#") + 1))) return at(ref, `calls ${h} (exempt)`, true);
      needsPick(ref, `calls ${h}`);
    };
    /** A use of `ref`, a module value that exports a signer: only a member read, or a plain destructuring. */
    /** `mod`, when set, is a module that exports a PINNED root: each name read off it is held as a named import is
     *  (a root of a pinned package only if its `names` hold it; a name it does not export refuses). */
    const namespace = (ref: ts.Node, m: string, mod?: ts.Symbol) => {
      const e = outer(ref);
      const p = e.parent;
      const read = (k: string, at_: ts.Node) => {
        if (!mod) return;
        const x = checker.getExportsOfModule(real(mod)).find((y) => y.name === k);
        const pk = x && rootIn(x);
        if (!x) at(at_, `reads ${k} off a module that exports ${m}, which exports no ${k}`, false);
        else if (pk && !(pk.names as readonly string[]).includes(real(x).name)) at(at_, `reads ${real(x).name} of ${pk.pkg} off a namespace (a device file imports only ${pk.names.join(", ")})`, false);
      };
      if (p && ts.isPropertyAccessExpression(p) && p.expression === e) return read(p.name.text, p);
      if (p && ts.isElementAccessExpression(p) && p.expression === e && ts.isStringLiteralLike(p.argumentExpression)) return read(p.argumentExpression.text, p);
      if (p && ts.isVariableDeclaration(p) && p.initializer === e && ts.isObjectBindingPattern(p.name) && p.name.elements.every((b) => !b.dotDotDotToken && (!b.propertyName || ts.isIdentifier(b.propertyName) || ts.isStringLiteral(b.propertyName)))) {
        for (const b of p.name.elements) read(((b.propertyName ?? b.name) as ts.Identifier | ts.StringLiteral).text, b);
        return;
      }
      at(ref, `uses whole, or by a computed key, a module that exports ${m}`, false);
    };
    /** Where `e`, a value of PINNED package `pk`, goes: a member `pk` names, a call, kept or handed on under its own
     *  type, or dropped; anything else refuses. */
    const pinnedUse = (e: ts.Expression, pt: PinnedType): void => {
      const pk = { pkg: pt.pk.pkg, members: pt.members };
      const said = `${pk.pkg} (${e.getText(sf).slice(0, 48)})`;
      for (let x: ts.Node = e; ; ) {
        const o = outer(x);
        if (o !== x && !pinnedType(checker.getTypeAtLocation(o))) return at(o, `casts a value of ${said} to another type`, false);
        const p = o.parent;
        if (ts.isPropertyAccessExpression(p) && p.expression === o) {
          if (!pk.members.includes(p.name.text)) at(p, `uses ${pk.pkg}: .${p.name.text} of its ${pt.name} (a device file uses only ${pk.members.join(", ")})`, false);
          return;
        }
        if (ts.isElementAccessExpression(p) && p.expression === o) {
          const k = ts.isStringLiteralLike(p.argumentExpression) ? p.argumentExpression.text : null;
          if (k === null || !pk.members.includes(k)) at(p, `uses ${pk.pkg} by a key ${k === null ? "it computes" : JSON.stringify(k)}`, false);
          return;
        }
        if (ts.isCallExpression(p) && p.expression === o) return;
        if (ts.isNewExpression(p) && p.expression === o) return at(p, `constructs ${said}`, false);
        if (ts.isExpressionStatement(p) || ts.isVoidExpression(p) || (ts.isConditionalExpression(p) && p.condition === o)) return;
        if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === o) return; // written to: the right is read
        const flows = ts.isConditionalExpression(p) || ts.isAwaitExpression(p) || (ts.isBinaryExpression(p) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind));
        if (flows && pinnedType(checker.getTypeAtLocation(p))) {
          x = p;
          continue;
        }
        // kept or handed on: the type it lands in must be its own
        let into: ts.Type | undefined;
        if (ts.isVariableDeclaration(p) && p.initializer === o && !ts.isIdentifier(p.name)) {
          // `{ a, b: c } = v`: each a member `pk` names; a `...rest`, an array pattern or a computed key refuses
          const named = ts.isObjectBindingPattern(p.name) && p.name.elements.every((e) => !e.dotDotDotToken && pk.members.includes(((e.propertyName ?? e.name) as ts.Identifier).text ?? ""));
          if (!named) at(p.name, `destructures ${said} past the members it may use`, false);
          return;
        }
        if (ts.isVariableDeclaration(p) && p.initializer === o) into = checker.getTypeAtLocation(p.name);
        else if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === o) into = checker.getTypeAtLocation(p.left);
        else if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(o as ts.Expression)) into = checker.getContextualType(o as ts.Expression);
        else if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === o)) into = checker.getContextualType(o as ts.Expression) ?? checker.getTypeAtLocation(o);
        if (into && pinnedType(into)) return;
        return at(o, `hands a value of ${said} on as another type`, false);
      }
    };
    /** A value expression at `n`: a value of a PINNED package's type, held to `pinnedUse` outside the functions EXEMPT
     *  lets sign with it. */
    const pinnedAt = (n: ts.Expression) => {
      const pk = pinnedType(checker.getTypeAtLocation(n));
      if (!pk || (pk.device && !device)) return;
      const fn = topName(n) ?? "";
      if (ex.curve?.includes(fn)) return at(n, `signs with a pinned package in ${fn} (exempt)`, true);
      pinnedUse(n, pk);
    };
    /** A module specifier of this file: a device file never imports the helper; vm runs code from text. */
    const imports = (spec: ts.StringLiteralLike) => {
      const f = moduleFile(spec);
      if (device && f?.startsWith(join(ROOT, "apps/helper/"))) at(spec, `imports the helper (a server file) on the device: ${spec.text}`, false);
      if (spec.text === "vm" || spec.text === "node:vm") at(spec, "imports node:vm: code from text", false);
    };
    const visit = (n: ts.Node): void => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) imports(n.moduleSpecifier);
      const declares = ts.isIdentifier(n) && n.parent && (ts.isFunctionDeclaration(n.parent) || ts.isVariableDeclaration(n.parent) || ts.isParameter(n.parent) || ts.isFunctionExpression(n.parent) || ts.isClassDeclaration(n.parent) || ts.isMethodDeclaration(n.parent)) && (n.parent as ts.NamedDeclaration).name === n;
      if (ts.isIdentifier(n) && !declares && !inModuleDecl(n) && !inType(n)) {
        const p = n.parent;
        const memberName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isBindingElement(p) && p.propertyName === n) || (ts.isPropertyDeclaration(p) && p.name === n);
        if (ts.isShorthandPropertyAssignment(p) && p.name === n) {
          const h = holds(checker.getShorthandAssignmentValueSymbol(p), signers);
          if (h) signer(n, h);
        } else if (ts.isBindingElement(p) && (p.propertyName ?? p.name) === n) {
          // `{ x } = v` or `{ x: y } = v`: x of the value destructured
          const owner = p.parent.parent;
          if (ts.isObjectBindingPattern(p.parent) && ts.isVariableDeclaration(owner) && owner.initializer) {
            const h = holds(checker.getPropertyOfType(checker.getTypeAtLocation(owner.initializer), n.text), signers);
            if (h) signer(n, h);
          }
        } else if (!memberName || ts.isPropertyAccessExpression(p)) {
          const s = checker.getSymbolAtLocation(n);
          const h = holds(s, signers);
          if (h) signer(ts.isPropertyAccessExpression(p) && p.name === n ? p : n, h);
          else {
            if ((n.text === "eval" || n.text === "Function") && fromLib(s)) at(n, `runs code from text: ${n.text}`, false);
            if (!memberName) {
              // a name of a PINNED package: only the roots it names
              const pk = s && rootIn(s);
              if (pk && !ex.curve?.includes(topName(n) ?? "") && !(pk.names as readonly string[]).includes(real(s).name)) at(n, `imports ${real(s).name} of ${pk.pkg} (a device file imports only ${pk.names.join(", ")})`, false);
              pinnedAt(n);
              const ts_ = checker.getTypeAtLocation(n).getSymbol();
              const m = moduleSigner(s) ?? moduleSigner(ts_);
              const mp = m ? null : modulePinned(s) ? s : modulePinned(ts_) ? ts_ : null;
              if (m) namespace(n, m);
              else if (mp) namespace(n, modulePinned(mp)!, mp);
            }
          }
        }
      }
      if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isNewExpression(n) || (ts.isCallExpression(n) && n.expression.kind !== ts.SyntaxKind.ImportKeyword)) && !inType(n)) pinnedAt(n);
      if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && !inType(n)) {
        const s = symbolOf(n);
        const h = holds(s, signers);
        if (h) signer(n, h);
        else if ((n.argumentExpression.text === "eval" || n.argumentExpression.text === "Function") && fromLib(s)) at(n, `runs code from text: ${n.argumentExpression.text}`, false);
      }
      if ((ts.isCallExpression(n) && n.expression.kind !== ts.SyntaxKind.ImportKeyword) || ts.isNewExpression(n)) {
        // code from text: a callee of the type Function (`.constructor` of a function), a timer given a string, a
        // call off the global object through a cast or a computed key
        const callee = strip(n.expression);
        const ct = checker.getTypeAtLocation(callee).getSymbol();
        if (ct && (ct.name === "Function" || ct.name === "FunctionConstructor") && fromLib(ct)) at(n, "runs code from text: a callee of the type Function", false);
        const named = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : null;
        const arg = n.arguments?.[0];
        if (named && (named.text === "setTimeout" || named.text === "setInterval") && fromLib(checker.getSymbolAtLocation(named)) && arg && checker.getTypeAtLocation(arg).flags & ts.TypeFlags.StringLike) at(n, `runs code from text: ${named.text} given a string`, false);
        let c: ts.Expression = n.expression;
        let cast = false;
        for (;;) {
          if (isWrap(c)) {
            if (ts.isAsExpression(c) || ts.isTypeAssertionExpression(c)) cast = true;
            c = c.expression;
          } else if (ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c)) {
            if (ts.isElementAccessExpression(c) && !ts.isStringLiteralLike(c.argumentExpression)) cast = true;
            c = c.expression;
          } else break;
        }
        const g = ts.isIdentifier(c) ? checker.getSymbolAtLocation(c) : undefined;
        // globalThis is the checker's own symbol, with no declaration; window and self are lib.dom's
        const global = !!g && ts.isIdentifier(c) && ["globalThis", "window", "self"].includes(c.text) && (fromLib(g) || (g.name === "globalThis" && !g.declarations?.length));
        if (cast && global) at(n, `calls a value read off ${(c as ts.Identifier).text} through a cast or a computed key`, false);
      }
      // a call of a value whose type is a signer's own (a signer held in an array, or returned): read by its type
      if (ts.isCallExpression(n) && n.expression.kind !== ts.SyntaxKind.ImportKeyword) {
        let c = strip(n.expression);
        if (ts.isPropertyAccessExpression(c) && (c.name.text === "call" || c.name.text === "apply")) c = strip(c.expression);
        const t = checker.getTypeAtLocation(c).getSymbol();
        const h = t && signers.get(t);
        if (h && !valueOf(c, signers)) {
          if (ex.define) at(n, `calls ${h} (a signer file)`, true);
          else if (ex.calls?.includes(h.slice(h.indexOf("#") + 1))) at(n, `calls ${h} (exempt)`, true);
          else needsPick(n, `calls a value of the type of ${h}`);
        }
      }
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = n.arguments[0];
        if (!spec || !ts.isStringLiteralLike(spec)) at(n, "imports a module it names at run time", false);
        else {
          imports(spec);
          const ms = checker.getSymbolAtLocation(spec);
          const m = moduleSigner(ms) ?? modulePinned(ms);
          if (m) at(n, `imports at run time a module that exports ${m}`, false);
          else if (!moduleFile(spec)) at(n, `imports at run time a module the program cannot bind: ${spec.text}`, false);
        }
      }
      if (ts.isPropertyAccessExpression(n) && n.name.text === "glob" && ts.isMetaProperty(strip(n.expression))) at(n, "import.meta.glob: modules the guard cannot read", false);
      if ((ts.isStringLiteralLike(n) || ts.isBinaryExpression(n)) && !inModuleDecl(n)) {
        const s = literal(n as ts.Expression);
        const top = !(n.parent && ts.isBinaryExpression(n.parent) && literal(n.parent) !== null);
        if (s !== null && top) {
          const t = norm(s);
          const e = encoding(t);
          if (e) needsPick(n, `encodes ${e}: ${JSON.stringify(s)}`);
          if (t.includes(SELL_TYPE)) {
            const fn = topName(n) ?? "";
            if (ex.sellType?.includes(fn)) at(n, `holds the EIP-712 Sell type in ${fn} (exempt)`, true);
            else needsPick(n, "holds the EIP-712 Sell type");
          }
        }
      }
      if (ts.isTemplateExpression(n)) {
        const t = norm([n.head.text, ...n.templateSpans.map((x) => x.literal.text)].join(""));
        if (encoding(t) || t.includes(SELL_TYPE)) needsPick(n, "encodes the deposit or the Sell type in a template");
      }
      // the selector or a Sell type hash as a number, in any base (0xe2bbb158 = 3803951448)
      if (ts.isNumericLiteral(n) || ts.isBigIntLiteral(n)) {
        const text = n.getText(sf).replace(/_/g, "").replace(/n$/, "");
        let v: bigint | null = null;
        try {
          v = BigInt(text);
        } catch {
          v = Number(text) === 0xe2bbb158 ? 0xe2bbb158n : null;
        }
        if (v === 0xe2bbb158n) needsPick(n, "encodes the deposit selector");
        else if (v !== null && SELL_TYPEHASHES.some((h) => BigInt(`0x${h}`) === v)) needsPick(n, "encodes the Sell type hash as a number");
      }
      // the selector or a Sell type hash as byte literals: [0xe2, 0xbb, ...] or Uint8Array.of(0xe2, ...)
      const bytes = ts.isArrayLiteralExpression(n) ? bytesHex(n.elements, sf) : ts.isCallExpression(n) ? bytesHex(n.arguments, sf) : null;
      const byEnc = bytes && encoding(bytes);
      if (byEnc) needsPick(n, `encodes ${byEnc} as bytes`);
      if (ts.isObjectLiteralExpression(n)) {
        const prop = (k: string) => {
          const a = n.properties.find((q) => ts.isPropertyAssignment(q) && (ts.isIdentifier(q.name) || ts.isStringLiteral(q.name)) && q.name.text === k) as ts.PropertyAssignment | undefined;
          return a ? literal(a.initializer) : null;
        };
        if (prop("functionName")?.toLowerCase() === "deposit") needsPick(n, 'encodes functionName "deposit"');
        if (prop("name")?.toLowerCase() === "deposit" && prop("type") === "function") needsPick(n, "holds the deposit's ABI entry");
      }
      if (ts.isCallExpression(n) && n.arguments.length) {
        const c = strip(n.expression);
        const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : null;
        if (name && ENCODERS.has(name) && literal(n.arguments[0]!)?.trim().toLowerCase() === "deposit") needsPick(n, `encodes the deposit with ${name}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    siteCache.set(path, out);
    return out;
  };

  // the build's graph: every module the entry reaches by import, export ... from, or import()
  const unresolved: string[] = [];
  const graph = new Set<string>();
  const specifiers = (sf: ts.SourceFile): ts.StringLiteralLike[] => {
    const out: ts.StringLiteralLike[] = [];
    const visit = (n: ts.Node): void => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) out.push(n.moduleSpecifier);
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) out.push(n.arguments[0]);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  };
  const moduleFile = (spec: ts.StringLiteralLike): string | null => {
    const m = checker.getSymbolAtLocation(spec);
    const d = m?.valueDeclaration ?? m?.declarations?.[0];
    return d && ts.isSourceFile(d) ? d.fileName : null;
  };
  // a module of ours (a relative path, or a workspace package) must bind: a signer can only come from one. A package
  // from npm that ships no types (poseidon-lite's subpaths) is read as untyped, and the test pins the bundle's package
  // list; a style sheet or a picture the terminal's bundler takes is no code.
  const ASSET = /\.(css|svg|png|jpe?g|webp|gif|woff2?|txt|html)$/i;
  const ours = (spec: string) => (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@blindfill/")) && !ASSET.test(spec);
  const read = new Set<string>([entry, ...roots, ...virtual.keys()]);
  const queue = [entry];
  while (queue.length) {
    const p = queue.shift()!;
    if (graph.has(p)) continue;
    graph.add(p);
    for (const spec of specifiers(file(p))) {
      const f = moduleFile(spec);
      if (!f) {
        if (ours(spec.text)) unresolved.push(`${rel(p)}: ${spec.text}`);
        continue;
      }
      if (!/[\\/]node_modules[\\/]/.test(f) && !f.endsWith(".d.ts")) queue.push(f);
    }
  }
  for (const p of read) {
    if (graph.has(p)) continue;
    for (const spec of specifiers(file(p))) if (!moduleFile(spec) && ours(spec.text)) unresolved.push(`${rel(p)}: ${spec.text}`);
  }
  return {
    signers: [...signers.values()],
    graph: [...graph],
    unresolved,
    sites,
    unguarded: (files) => files.filter((f) => sites(f).some((s) => !s.ok)),
  };
}
