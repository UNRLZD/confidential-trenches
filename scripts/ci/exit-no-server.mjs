#!/usr/bin/env node
// Card exit-pages-rpcs: the exit tool works from the 12 words and public data alone, with no server of ours in its
// path (vault paper 2.12, docs/plan1/vault.md l.926-928). This gate fails when packages/exit/ reaches one:
//   node scripts/ci/exit-no-server.mjs [root]      (exit 1 and one line per refusal)
// It reads every file git lists under packages/exit/ (tracked, and untracked but not ignored) and refuses:
//  - our domain, unrealized.trade, anywhere in a file's text (code, comment, test or data, any case), but inside the
//    release mirror's address, https://confidential.unrealized.trade/assets/zk/ exactly: the static host where
//    each setup file sits under its own sha256, read only as a second door to bytes the tool checks against the kit's
//    pins (packages/exit/src/setup.ts). The helper's host, the app's and every other address of ours are refused;
//  - in a script file (the TypeScript parser, so a comment or a plain string is never taken for an import), an import
//    from the kit (@blindfill/kit or @blindfill/kit/core, by import, export from, import type, import() or require())
//    of a name the kit's helper module exports (every export of packages/kit/src/helper/), and a kit import whose names
//    cannot be read: import * as, export * from, a bare import(), require().
// A reach into the helper's own code (apps/helper/) is check:imports' (.dependency-cruiser.cjs, exit-kit-entries-only).
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const EXIT_DIR = "packages/exit/";
export const MIRROR = "https://confidential.unrealized.trade/assets/zk/";
const OURS = /unrealized\.trade/gi;
const KIT = new Set(["@blindfill/kit", "@blindfill/kit/core"]);
const SCRIPT = { ".js": ts.ScriptKind.JS, ".cjs": ts.ScriptKind.JS, ".mjs": ts.ScriptKind.JS, ".jsx": ts.ScriptKind.JSX, ".ts": ts.ScriptKind.TS, ".cts": ts.ScriptKind.TS, ".mts": ts.ScriptKind.TS, ".tsx": ts.ScriptKind.TSX };

/** Every name the kit's helper module exports (packages/kit/src/helper/*.ts). */
export function helperExports(root) {
  const dir = `${root}/packages/kit/src/helper`;
  const names = new Set();
  for (const f of readdirSync(dir).filter((f) => /\.(ts|mts|js|mjs)$/.test(f))) {
    const src = ts.createSourceFile(f, readFileSync(`${dir}/${f}`, "utf8"), ts.ScriptTarget.Latest, false, SCRIPT[posix.extname(f)] ?? ts.ScriptKind.TS);
    for (const s of src.statements) {
      const exported = ts.canHaveModifiers(s) && ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements) names.add(e.name.text);
      if (!exported) continue;
      if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) ts.isIdentifier(d.name) && names.add(d.name.text);
      else if (s.name && ts.isIdentifier(s.name)) names.add(s.name.text);
    }
  }
  if (names.size === 0) throw new Error(`no export read in ${dir}`);
  return names;
}

/** The refusals in one file's text: [line, what]. */
export function refusals(file, text, helper) {
  const out = [];
  const lineAt = (i) => text.slice(0, i).split("\n").length;
  for (const m of text.matchAll(OURS)) {
    // inside the mirror's address: the match sits where the mirror's own "unrealized.trade" does
    const start = m.index - MIRROR.indexOf("unrealized.trade");
    if (start >= 0 && text.startsWith(MIRROR, start)) continue;
    const from = Math.max(text.lastIndexOf("\n", m.index) + 1, m.index - 40);
    out.push([lineAt(m.index), `our server's address (${JSON.stringify(text.slice(from, m.index + 16 + 30).split("\n")[0])}): only the mirror ${MIRROR} is allowed`]);
  }
  const kind = SCRIPT[posix.extname(file)];
  if (kind !== undefined) {
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const at = (n) => lineAt(n.getStart(src));
    const named = (n, mod, names) => {
      for (const name of names) if (helper.has(name)) out.push([at(n), `imports ${name} from ${mod}: the helper's, a server of ours`]);
    };
    const visit = (n) => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && KIT.has(n.moduleSpecifier.text)) {
        const mod = n.moduleSpecifier.text;
        if (ts.isImportDeclaration(n)) {
          const b = n.importClause?.namedBindings;
          if (b && ts.isNamespaceImport(b)) out.push([at(n), `import * from ${mod}: every name, the helper's among them, cannot be checked`]);
          if (b && ts.isNamedImports(b)) named(n, mod, b.elements.map((e) => (e.propertyName ?? e.name).text));
          if (n.importClause?.name) out.push([at(n), `a default import from ${mod}: not checkable`]);
        } else if (!n.exportClause || ts.isNamespaceExport(n.exportClause)) out.push([at(n), `export * from ${mod}: every name, the helper's among them, cannot be checked`]);
        else named(n, mod, n.exportClause.elements.map((e) => (e.propertyName ?? e.name).text));
      }
      if (ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteralLike(n.arguments[0]) && KIT.has(n.arguments[0].text)) {
        const dyn = n.expression.kind === ts.SyntaxKind.ImportKeyword;
        const req = ts.isIdentifier(n.expression) && n.expression.text === "require";
        if (dyn || req) out.push([at(n), `${dyn ? "import()" : "require()"} of ${n.arguments[0].text}: its names cannot be checked`]);
      }
      if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal) && KIT.has(n.argument.literal.text)) {
        const q = n.qualifier;
        const first = q === undefined ? undefined : ts.isIdentifier(q) ? q.text : q.left.getText(src);
        if (first === undefined) out.push([at(n), `import("${n.argument.literal.text}") as a type: not checkable`]);
        else named(n, n.argument.literal.text, [first]);
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

export function exitNoServer(root) {
  const files = execFileSync("git", ["ls-files", "-z", "-c", "-o", "--exclude-standard", "--", EXIT_DIR], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const helper = helperExports(root);
  const out = [];
  let read = 0;
  for (const f of [...new Set(files)]) {
    let text;
    try {
      text = readFileSync(`${root}/${f}`, "utf8");
    } catch (e) {
      out.push(`${f}: could not be read (${String(e?.message ?? e).split("\n")[0]}), so it is refused`);
      continue;
    }
    read++;
    for (const [line, what] of refusals(f, text, helper)) out.push(`${f}:${line}: ${what}`);
  }
  return { refusals: out, read };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = exitNoServer(process.argv[2] ?? process.cwd());
  for (const x of r.refusals) console.error(`exit-no-server: REFUSED: ${x}`);
  if (r.refusals.length) process.exit(1);
  console.log(`exit-no-server: OK (${r.read} file(s) under ${EXIT_DIR} read)`);
}
