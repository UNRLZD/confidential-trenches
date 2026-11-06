// The signer guard's reader (card signer-guard-parser; reviewer L3 of pool-restore-wired): an EVM pool deposit or sell
// signs on a precommitment anyone who sees it pending can take first, so every device file that can sign one must
// pick its note through the wallet's evmNextNote (card precommit-taken-recover, test/pool-kinds.test.ts). A guard that
// matches names can be walked past by a rename, an alias or a `.call`, and flags the kit index's re-exports by their
// bare name. This one reads code: the TypeScript compiler binds every name to its declaration, through aliased and
// namespace imports and `export *` re-exports, so a file is held by what it reaches, never by how it spells it. It
// fails closed: a form it cannot follow is refused, never passed.
//
// The rules, outside what EXEMPT lets a file do (each file only what it needs):
// - A signer is every value a SIGNER_DEFS file exports, but the ones NON_SIGNERS names. It may only be called (direct,
//   or through .call, .apply, or a .bind called at once) or re-exported; any other mention (held, handed on, returned,
//   destructured) refuses. A call needs a call of the wallet's own evmNextNote in the same function body.
// - A pool deposit or sell encoded: a string built of literals that holds deposit(uint256,uint256), its selector
//   e2bbb158 or the EIP-712 Sell type, that selector as a number, functionName "deposit" (viem), the ABI entry
//   { type: "function", name: "deposit" }, or an ethers-style encoder called on "deposit". It needs evmNextNote in the
//   same function body, as a call does.
// - A module that exports a signer, seen by its symbol or by its type (a namespace import, an import()'s value): only
//   `ns.x`, `ns["x"]` or `{ x, y: z } = ns` of it is read; any other use, a computed key or a `...rest` refuses. An
//   import() of such a module, an import() of a specifier that is not a string, and import.meta.glob refuse.
// - The curve: noble's secp256k1 exports, and anything of @noble/curves/abstract/, are used only as SECP_MEMBERS
//   (no signing); signing with the curve is only in the files that do today.
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
/** What each file may do, and only that: `define` (a signer file: it builds and composes signers, so its own mentions
 *  and calls of them are not held), `calls` (signers it may call with no evmNextNote), `curve` (it signs with noble's
 *  secp256k1), `sellType` (it holds the EIP-712 Sell type). */
type Exempt = { define?: true; calls?: readonly string[]; curve?: true; sellType?: true };
export const EXEMPT: Readonly<Record<string, Exempt>> = {
  "packages/kit/src/trade/evm/sell.ts": { define: true },
  "packages/kit/src/trade/evm/sell-unpinned.ts": { define: true, curve: true, sellType: true }, // sell-unpinned.ts:434, 463
  "packages/kit/src/trade/evm/quoted.ts": { define: true },
  "packages/signpage/src/rules/pool.ts": { define: true, curve: true }, // rules/pool.ts:853, 1020: a withdraw, an onward send
  "packages/kit/src/trade/evm/buy-unpinned.ts": { curve: true }, // a buy's signature, buy-unpinned.ts:612
  // a quote's simulation: a sim sell built and its call data encoded, signed by its caller on the note the caller names
  "packages/kit/src/checks/evm/quote.ts": { calls: ["evmPoolBuildSimSellUnpinned", "evmSellCallData"] },
  // the helper (a server file, never on the page): its sender key signs its own relay sends, and it checks a sell's
  // signature against the Sell digest (evmSellDigest), so it holds the type; it signs no sell
  "apps/helper/src/pool/evm.ts": { curve: true, sellType: true },
};
/** The wallet's note pick, and the name it is exported by. */
export const NEXT_NOTE = { file: "packages/wallet/src/pool/evm-restore.ts", name: "evmNextNote" };
/** The curve's members a file may use without signing: a public key, a key's check, a point read from bytes. */
const SECP_MEMBERS = [["getPublicKey"], ["utils", "isValidSecretKey"], ["Point", "fromBytes"]];
const DEPOSIT_SIG = "deposit(uint256,uint256)";
const DEPOSIT_SELECTOR = "e2bbb158";
/** The EIP-712 Sell type (sell-unpinned.ts), spaces dropped: a sell's digest built by hand starts from it. */
const SELL_TYPE = "sell(addresstoken,uint256amount,addresstarget";
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
const encodes = (t: string) => t.includes(DEPOSIT_SIG) || t.includes(DEPOSIT_SELECTOR);
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
/** The function body (or the file) a node runs in. */
const bodyOf = (n: ts.Node): ts.Node => {
  for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p) && "body" in p && p.body) return p;
  return n.getSourceFile();
};

/**
 * Reads `roots` (absolute paths: the build's entry and any other files to hold) and everything they import into one
 * TypeScript program, and returns the guard. `defs` are the repo paths whose exports are the signers (`nonSigners`
 * aside); `virtual` adds files by absolute path and text, read as if on disk.
 */
export function signerGuard(entry: string, roots: readonly string[], defs: readonly string[] = SIGNER_DEFS, virtual: ReadonlyMap<string, string> = new Map(), nonSigners: Readonly<Record<string, readonly string[]>> = NON_SIGNERS): Guard {
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
  /** A name declared by noble's secp256k1 module or by @noble/curves/abstract/. */
  const curveDecl = (s: ts.Symbol | undefined): boolean => {
    const d = s && real(s).declarations?.[0];
    return /[\\/]node_modules[\\/]@noble[\\/]curves[\\/](?:secp256k1\.|abstract[\\/])/.test(d?.getSourceFile().fileName ?? "");
  };
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
  /** The function bodies of `sf` that call the wallet's evmNextNote, by any name, directly or via .call/.apply. */
  const pickCache = new Map<string, Set<ts.Node>>();
  const picks = (sf: ts.SourceFile): Set<ts.Node> => {
    const hit = pickCache.get(sf.fileName);
    if (hit) return hit;
    const out = new Set<ts.Node>();
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        let c = strip(n.expression);
        if (ts.isPropertyAccessExpression(c) && (c.name.text === "call" || c.name.text === "apply")) c = strip(c.expression);
        if (valueOf(c, NEXT)) out.add(bodyOf(n));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    pickCache.set(sf.fileName, out);
    return out;
  };

  const siteCache = new Map<string, Site[]>();
  const sites = (path: string): Site[] => {
    const hit = siteCache.get(path);
    if (hit) return hit;
    const sf = file(path);
    const ex: Exempt = EXEMPT[rel(path)] ?? {};
    const picked = picks(sf);
    const out: Site[] = [];
    const at = (n: ts.Node, what: string, ok: boolean) => out.push({ path: rel(path), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, what, ok });
    // a call, or an encoding, needs evmNextNote called in its own function body
    const needsPick = (n: ts.Node, what: string) => at(n, picked.has(bodyOf(n)) ? what : `${what}, with no evmNextNote in its function`, picked.has(bodyOf(n)));
    /** A mention of signer `h` at `ref`: a call (held to evmNextNote), or anything else (refused). */
    const signer = (ref: ts.Node, h: string) => {
      if (ex.define) return at(ref, `defines with ${h}`, true);
      if (!callOf(ref)) return at(ref, `holds or hands on ${h} (a signer is only called or re-exported)`, false);
      if (ex.calls?.includes(h.slice(h.indexOf("#") + 1))) return at(ref, `calls ${h} (exempt)`, true);
      needsPick(ref, `calls ${h}`);
    };
    /** A use of `ref`, a module value that exports a signer: only a member read, or a plain destructuring. */
    const namespace = (ref: ts.Node, m: string) => {
      const e = outer(ref);
      const p = e.parent;
      if (p && ts.isPropertyAccessExpression(p) && p.expression === e) return;
      if (p && ts.isElementAccessExpression(p) && p.expression === e && ts.isStringLiteralLike(p.argumentExpression)) return;
      if (p && ts.isVariableDeclaration(p) && p.initializer === e && ts.isObjectBindingPattern(p.name) && p.name.elements.every((b) => !b.dotDotDotToken && (!b.propertyName || ts.isIdentifier(b.propertyName) || ts.isStringLiteral(b.propertyName)))) return;
      at(ref, `uses whole, or by a computed key, a module that exports ${m}`, false);
    };
    const curve = (ref: ts.Identifier) => {
      if (ex.curve) return at(ref, "uses the curve (exempt)", true);
      const members: string[] = [];
      let e: ts.Node = outer(ref);
      while (e.parent && ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e) {
        members.push(e.parent.name.text);
        e = outer(e.parent);
      }
      const ok = ref.text === "secp256k1" && SECP_MEMBERS.some((m) => m.length <= members.length && m.every((x, i) => x === members[i]));
      at(ref, `uses the curve: ${[ref.text, ...members].join(".")}`, ok);
    };
    const visit = (n: ts.Node): void => {
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
          else if (!memberName) {
            if (curveDecl(s)) curve(n);
            const m = moduleSigner(s) ?? moduleSigner(checker.getTypeAtLocation(n).getSymbol());
            if (m) namespace(n, m);
          }
        }
      }
      if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && !inType(n)) {
        const h = holds(symbolOf(n), signers);
        if (h) signer(n, h);
      }
      // a call of a value whose type is a signer's own (a signer held in an array, or returned): read by its type
      if (ts.isCallExpression(n) && n.expression.kind !== ts.SyntaxKind.ImportKeyword) {
        let c = strip(n.expression);
        if (ts.isPropertyAccessExpression(c) && (c.name.text === "call" || c.name.text === "apply")) c = strip(c.expression);
        const t = checker.getTypeAtLocation(c).getSymbol();
        const h = t && signers.get(t);
        if (h && !valueOf(c, signers)) {
          if (ex.define) at(n, `defines with ${h}`, true);
          else if (ex.calls?.includes(h.slice(h.indexOf("#") + 1))) at(n, `calls ${h} (exempt)`, true);
          else needsPick(n, `calls a value of the type of ${h}`);
        }
      }
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = n.arguments[0];
        if (!spec || !ts.isStringLiteralLike(spec)) at(n, "imports a module it names at run time", false);
        else {
          const m = moduleSigner(checker.getSymbolAtLocation(spec));
          if (m) at(n, `imports at run time a module that exports ${m}`, false);
        }
      }
      if (ts.isPropertyAccessExpression(n) && n.name.text === "glob" && ts.isMetaProperty(strip(n.expression))) at(n, "import.meta.glob: modules the guard cannot read", false);
      if ((ts.isStringLiteralLike(n) || ts.isBinaryExpression(n)) && !inModuleDecl(n)) {
        const s = literal(n as ts.Expression);
        const top = !(n.parent && ts.isBinaryExpression(n.parent) && literal(n.parent) !== null);
        if (s !== null && top) {
          const t = norm(s);
          if (encodes(t)) needsPick(n, `encodes the deposit: ${JSON.stringify(s)}`);
          if (t.includes(SELL_TYPE)) {
            if (ex.sellType) at(n, "holds the EIP-712 Sell type (exempt)", true);
            else needsPick(n, "holds the EIP-712 Sell type");
          }
        }
      }
      if (ts.isTemplateExpression(n)) {
        const t = norm([n.head.text, ...n.templateSpans.map((x) => x.literal.text)].join(""));
        if (encodes(t) || t.includes(SELL_TYPE)) needsPick(n, "encodes the deposit or the Sell type in a template");
      }
      // the selector as a number, in any base (0xe2bbb158 = 3803951448)
      const num = ts.isNumericLiteral(n) ? Number(n.getText(sf).replace(/_/g, "")) : ts.isBigIntLiteral(n) ? Number(BigInt(n.getText(sf).replace(/_/g, "").slice(0, -1))) : NaN;
      if (num === 0xe2bbb158) needsPick(n, "encodes the deposit selector");
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
