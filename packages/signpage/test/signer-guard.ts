// The signer guard's reader (card signer-guard-parser; reviewer L3 of pool-restore-wired): an EVM pool deposit or sell
// signs on a precommitment anyone who sees it pending can take first, so every device file that can sign one must
// pick its note through the wallet's evmNextNote (card precommit-taken-recover, test/pool-kinds.test.ts). A guard that
// matches names can be walked past by a rename, an alias or a `.call`, and flags the kit index's re-exports by their
// bare name. This one reads code: the TypeScript compiler binds every name to its declaration, through aliased and
// namespace imports and `export *` re-exports, so a file is held by what it reaches, never by how it spells it.
//
// A file reaches a signer when, outside an import or export declaration and outside a type, it names a value that
// is a signer: the signer itself (an identifier, `ns.x`, `ns["x"]`, `{ x: y } = ns`, so a call, `.call`, `.apply`,
// `.bind` or a callback alike), a const or let whose value is one (a re-assignment, in any file), an object property
// that holds one, or a whole namespace that exports one. It encodes a pool deposit when a string it builds (literals
// joined by `+` too, spaces ignored) holds deposit(uint256,uint256) or its selector e2bbb158, a number is that
// selector, an object names functionName "deposit" (viem) or is the ABI entry { type: "function", name: "deposit" },
// or an ethers-style encoder (encodeFunctionData, getFunction...) is called on "deposit". It is guarded when it calls
// the wallet's own evmNextNote, by any name or through `.call`/`.apply`: a local function of that name, or the word in
// a comment, guards nothing.
import ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ROOT = new URL("../../../", import.meta.url).pathname;
/** The files that define the EVM sell builders and signers: the kit's and the rule's, and quoted.ts, whose
 *  evmQuotedSell builds the sell a signer signs on the precommitment its fields name. */
export const SIGNER_DEFS = ["packages/kit/src/trade/evm/sell.ts", "packages/kit/src/trade/evm/sell-unpinned.ts", "packages/kit/src/trade/evm/quoted.ts", "packages/signpage/src/rules/pool.ts"];
/** The wallet's note pick, and the name it is exported by. */
export const NEXT_NOTE = { file: "packages/wallet/src/pool/evm-restore.ts", name: "evmNextNote" };
// a signer is a value its file exports under a builder or signer name; a predicate (`Is` before a capital, as
// evmIsQuotedSell, which only reads quoted.ts's record) builds and signs nothing and is not one
const SIGNER_NAME = /^(?:\w*(?:Build|Sign|Quoted)\w*Sell\w*|signEvmSell\w*)$/;
const PREDICATE = /(?:^is|[a-z0-9]Is)[A-Z]/;
const DEPOSIT_SIG = "deposit(uint256,uint256)";
const DEPOSIT_SELECTOR = "e2bbb158";
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

export type Site = { path: string; line: number; what: string };
export type Guard = {
  /** The signers, as "<repo path>#<name>". */
  signers: string[];
  /** Every repo file reachable from `entry` by its static and dynamic imports and re-exports (node_modules aside). */
  graph: string[];
  /** Import specifiers in the read files that bind to no module: a name through one could not be resolved. */
  unresolved: string[];
  /** The files that reach a signer or encode a deposit, and do not call evmNextNote: absolute paths. */
  unguarded: (files: readonly string[]) => string[];
  /** Every signing or encoding site in `file`. */
  sites: (file: string) => Site[];
};

const rel = (p: string) => (p.startsWith(ROOT) ? p.slice(ROOT.length) : p);
const strip = (e: ts.Expression): ts.Expression => {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) || ts.isExpressionWithTypeArguments(e)) e = e.expression;
    else return e;
  }
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
const holdsDeposit = (s: string): boolean => {
  const t = s.replace(/\s+/g, "").toLowerCase();
  return t.includes(DEPOSIT_SIG) || t.includes(DEPOSIT_SELECTOR);
};
/** True when `n` sits in a type, where a name signs nothing (`typeof x`, an annotation, `implements`). */
const inType = (n: ts.Node): boolean => {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isExpressionWithTypeArguments(p)) {
      const h = p.parent;
      if (ts.isHeritageClause(h) && (h.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(h.parent))) return true;
      continue; // `class X extends y` and an instantiation `x<T>` are values
    }
    if (ts.isTypeNode(p)) return true;
    if (ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p)) return true;
  }
  return false;
};
/** True when `n` is a name inside an import or export declaration: binding a name signs nothing. */
const inModuleDecl = (n: ts.Node): boolean => {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportEqualsDeclaration(p)) return true;
    if (ts.isExportAssignment(p)) return ts.isIdentifier(strip(p.expression)); // `export default x` re-exports x
    if (ts.isStatement(p)) return false;
  }
  return false;
};

/**
 * Reads `roots` (absolute paths: the build's entry and any other files to hold) and everything they import into one
 * TypeScript program, and returns the guard. `defs` are the repo paths whose exports name the signers.
 */
export function signerGuard(entry: string, roots: readonly string[], defs: readonly string[] = SIGNER_DEFS): Guard {
  const program = ts.createProgram([entry, ...roots], OPTIONS);
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
    for (const [name, s] of exportsOf(join(ROOT, d))) {
      if (SIGNER_NAME.test(name) && !PREDICATE.test(name) && s.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable)) signers.set(s, `${d}#${name}`);
    }
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
        // `{ x: y } = expr`: the property x of expr's value
        const pattern = d.parent;
        const owner = pattern.parent;
        const key = d.propertyName ?? d.name;
        if (ts.isObjectBindingPattern(pattern) && ts.isVariableDeclaration(owner) && owner.initializer && (ts.isIdentifier(key) || ts.isStringLiteral(key))) {
          const prop = checker.getPropertyOfType(checker.getTypeAtLocation(owner.initializer), key.text);
          const h = holds(prop, set, seen);
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
    // f.bind(...) is f
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "bind") return valueOf(e.expression.expression, set, seen);
    return holds(symbolOf(e), set, seen);
  };
  /** A module (a namespace import, or `import()`'s value) that exports a signer. */
  const moduleSigner = (s: ts.Symbol | undefined): string | null => {
    if (!s) return null;
    s = real(s);
    if (!(s.flags & ts.SymbolFlags.ValueModule)) return null;
    for (const x of checker.getExportsOfModule(s)) if (signers.has(real(x))) return signers.get(real(x))!;
    return null;
  };

  const siteCache = new Map<string, Site[]>();
  const guardCache = new Map<string, boolean>();
  const sites = (path: string): Site[] => {
    const hit = siteCache.get(path);
    if (hit) return hit;
    const sf = file(path);
    const out: Site[] = [];
    const at = (n: ts.Node, what: string) => out.push({ path: rel(path), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, what });
    const visit = (n: ts.Node): void => {
      // a declaration's own name (function f, const f, a parameter) names what it declares, never what it holds
      const declares = ts.isIdentifier(n) && n.parent && (ts.isFunctionDeclaration(n.parent) || ts.isVariableDeclaration(n.parent) || ts.isParameter(n.parent) || ts.isFunctionExpression(n.parent) || ts.isClassDeclaration(n.parent) || ts.isMethodDeclaration(n.parent)) && (n.parent as ts.NamedDeclaration).name === n;
      if (ts.isIdentifier(n) && !declares && !inModuleDecl(n) && !inType(n)) {
        const p = n.parent;
        const isName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isBindingElement(p) && p.propertyName === n);
        if (ts.isShorthandPropertyAssignment(p) && p.name === n) {
          const h = holds(checker.getShorthandAssignmentValueSymbol(p), signers);
          if (h) at(n, `names ${h}`);
        } else if (ts.isBindingElement(p) && (p.propertyName ?? p.name) === n) {
          // `{ x } = ns` or `{ x: y } = ns`: x of the value destructured
          const owner = p.parent.parent;
          if (ts.isObjectBindingPattern(p.parent) && ts.isVariableDeclaration(owner) && owner.initializer) {
            const h = holds(checker.getPropertyOfType(checker.getTypeAtLocation(owner.initializer), n.text), signers);
            if (h) at(n, `takes ${h}`);
          }
        } else if (!isName || ts.isPropertyAccessExpression(p)) {
          const s = checker.getSymbolAtLocation(n);
          const h = holds(s, signers);
          if (h) at(n, `names ${h}`);
          else if (!isName) {
            // a whole namespace that exports a signer, used other than `ns.x` or `ns["x"]` of a name that is not one
            const m = moduleSigner(s);
            // `{ a, b: c } = ns` takes names one by one (each read above); a `...rest` takes them all
            const destructured = ts.isVariableDeclaration(p) && p.initializer === n && ts.isObjectBindingPattern(p.name) && p.name.elements.every((e) => !e.dotDotDotToken);
            const member = destructured || (ts.isPropertyAccessExpression(p) && p.expression === n) || (ts.isElementAccessExpression(p) && p.expression === n && ts.isStringLiteralLike(p.argumentExpression));
            if (m && !member) at(n, `passes a namespace that exports ${m}`);
          }
        }
      }
      if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && !inType(n)) {
        const h = holds(symbolOf(n), signers);
        if (h) at(n, `names ${h}`);
      }
      if ((ts.isStringLiteralLike(n) || ts.isBinaryExpression(n)) && !inModuleDecl(n)) {
        const s = literal(n as ts.Expression);
        const top = !(n.parent && ts.isBinaryExpression(n.parent) && literal(n.parent) !== null);
        if (s !== null && top && holdsDeposit(s)) at(n, `encodes the deposit: ${JSON.stringify(s)}`);
      }
      if (ts.isTemplateExpression(n) && holdsDeposit([n.head.text, ...n.templateSpans.map((t) => t.literal.text)].join(""))) at(n, "encodes the deposit in a template");
      if ((ts.isNumericLiteral(n) || ts.isBigIntLiteral(n)) && /^0x0*e2bbb158n?$/i.test(n.getText(sf).replace(/_/g, ""))) at(n, "encodes the deposit selector");
      if (ts.isObjectLiteralExpression(n)) {
        const prop = (k: string) => {
          const a = n.properties.find((q) => ts.isPropertyAssignment(q) && (ts.isIdentifier(q.name) || ts.isStringLiteral(q.name)) && q.name.text === k) as ts.PropertyAssignment | undefined;
          return a ? literal(a.initializer) : null;
        };
        if (prop("functionName")?.toLowerCase() === "deposit") at(n, 'encodes functionName "deposit"');
        if (prop("name")?.toLowerCase() === "deposit" && prop("type") === "function") at(n, "holds the deposit's ABI entry");
      }
      if (ts.isCallExpression(n) && n.arguments.length) {
        const c = strip(n.expression);
        const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : null;
        if (name && ENCODERS.has(name) && literal(n.arguments[0]!)?.trim().toLowerCase() === "deposit") at(n, `encodes the deposit with ${name}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    siteCache.set(path, out);
    return out;
  };
  /** True when `path` calls the wallet's evmNextNote, by any name, directly or through .call/.apply. */
  const guarded = (path: string): boolean => {
    const hit = guardCache.get(path);
    if (hit !== undefined) return hit;
    let yes = false;
    const visit = (n: ts.Node): void => {
      if (yes) return;
      if (ts.isCallExpression(n)) {
        let c = strip(n.expression);
        if (ts.isPropertyAccessExpression(c) && (c.name.text === "call" || c.name.text === "apply")) c = strip(c.expression);
        if (valueOf(c, NEXT)) yes = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(file(path));
    guardCache.set(path, yes);
    return yes;
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
  // from npm that ships no types (poseidon-lite's subpaths) is read as untyped, and signs no EVM pool transaction; a
  // style sheet or a picture the terminal's bundler takes is no code.
  const ASSET = /\.(css|svg|png|jpe?g|webp|gif|woff2?|txt|html)$/i;
  const ours = (spec: string) => (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@blindfill/")) && !ASSET.test(spec);
  const read = new Set<string>([entry, ...roots]);
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
    unguarded: (files) => files.filter((f) => sites(f).length > 0 && !guarded(f)),
  };
}
