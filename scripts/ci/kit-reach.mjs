#!/usr/bin/env node
// The second half of the deep-import rule. .dependency-cruiser.cjs checks the imports it resolves; this reads the
// reach forms it never sees. Run at the repo root, after depcruise (package.json's check:imports):
//   node scripts/ci/kit-reach.mjs
// It reads every file git lists here (tracked, and untracked but not ignored) and refuses:
//  - a path with a node_modules folder in it: only the root install makes them, and it is ignored, never committed;
//  - a symlink outside packages/ and contracts/ whose target lands in them;
//  - in a file outside packages/ and contracts/, a reach form whose path lands in packages/ or contracts/ (from the
//    file's folder, or from the repo root when it starts with "/"), other than the kit's entry, or that names a package
//    of packages/ or contracts/ other than by the kit's bare name. The reach forms, found by the TypeScript parser, so
//    a plain string, a regex or a comment is never taken for one:
//      new URL(<path>, <base>) on any base, import.meta.glob(<path or array>), require.resolve(<path>),
//      import.meta.resolve(<path>), import(<path>), require(<path>), an import("<path>") type, and an
//      import("<path>") in a comment (a JSDoc type);
//      the script of new Worker(<path>), new SharedWorker(<path>), importScripts(<path>, ...) (bare or as self's or any
//      object's, every argument) and
//      serviceWorker.register(<path>) (navigator's or any other object's);
//      in a stylesheet or a <style> block, @import "<path>" and url(<path>), outside its comments: /* */, and // to
//      the end of the line in SCSS, Sass, Less and Stylus (a .scss, .sass, .less or .styl file, or a <style lang=...>
//      of one), never inside a string or an unquoted url(...);
//      in .vue, .svelte, .astro and .html files, the script forms in their <script> blocks and .astro frontmatter, and
//      there also the module of every import and export declaration (import x from "<path>", import "<path>", import
//      type, export * from "<path>", export { x } from "<path>", import x = require(<path>)), which depcruise does not
//      read in these files (in a plain script file it does, so they are its own there);
//      in those pages, the src and href of <link>, <script>, <img>, <source>, <iframe> and <embed>, and the data of
//      <object> (not <a>, which only links), and every address of a <script type="importmap">, in its "imports" and in
//      each of its "scopes": a value with a scheme or "//" is a URL, not a path, and one starting with "/" lands from
//      the repo root and from the page's folder, refused when either lands in packages/ or contracts/; an import map
//      that is not JSON is not checkable;
//    a glob whose first folder is a pattern ("**/…", "{packages,apps}/…") can match them, so it is refused too;
//  - a reach form whose path is not a static string, or is a template that starts with ${: it cannot be checked. A
//    template is checked up to its first ${. A new URL is not checkable so only on import.meta.url (or
//    import.meta["url"]): on any other base (location.href, a variable holding import.meta.url, an API's base) only a
//    static path is read, since app code builds its API URLs from variables. A root path ("/…") of a new URL is read
//    only on a base made from the page's own address (import.meta.url, location, document: location.origin,
//    window.location.href, document.baseURI, String(import.meta.url)): on any other base it is a route of that base
//    (an API's "/contracts/abi"), not a file here. A worker's or a service worker's script
//    is read only when it is a static path too: in new Worker(new URL(...)) the inner new URL is read on its own.
//  - a file it cannot read (one nested deeper than the parser's stack, say): refused by its name, and every other file
//    is still read.
// Any other string is not a reach (a config's "packages/*" glob, a route "/contracts/abi"), so it is not read. A path
// spelled to dodge it (joined from parts at run time) is not a static string, so where a form must be static (above)
// it is refused as not checkable. Left to the hand read, as disguises this check does not read: a URL made under
// another name (new globalThis.URL(...), the URL class held in a variable), a path written with backslashes, and a
// percent-encoded path.
import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const INSIDE = /^(packages|contracts)(\/|$)/;
const KIT_ENTRY = /^packages\/kit\/(src\/index(\.ts)?|dist\/index(\.js|\.d\.ts)?)$/;
const SCRIPT = { ".js": ts.ScriptKind.JS, ".cjs": ts.ScriptKind.JS, ".mjs": ts.ScriptKind.JS, ".jsx": ts.ScriptKind.JSX, ".ts": ts.ScriptKind.TS, ".cts": ts.ScriptKind.TS, ".mts": ts.ScriptKind.TS, ".tsx": ts.ScriptKind.TSX };
const STYLE = /\.(css|scss|sass|less|pcss|styl)$/;
const LINE_COMMENT_STYLE = /\.(scss|sass|less|styl)$/;
const MARKUP = /\.(vue|svelte|astro|html?)$/;
const GLOB_CHARS = /[*?[\]{}()!@+]/;

// where a path lands, as a repo path, when that is in packages/ or contracts/ and not the kit's entry; else null. A
// glob keeps its ? (a pattern, not a query); a negated one ("!…") only takes files away; one whose first folder is a
// pattern ("**/…", "{packages,apps}/…") can match packages/ and contracts/.
export function lands(file, s, glob = false) {
  const path = glob ? s : s.split(/[?#]/)[0];
  if (!path || (glob && path.startsWith("!"))) return null;
  const p = path.startsWith("/") ? posix.normalize(path).slice(1) : posix.join(posix.dirname(file), path); // a browser reads "/../x" as "/x"
  const [first, ...rest] = p.split("/");
  if (glob && GLOB_CHARS.test(first) && (rest.length || first.includes("**"))) return p;
  return INSIDE.test(p) && !KIT_ENTRY.test(p) ? p.replace(/\/$/, "") : null;
}

// the static text of a path argument (a template up to its first ${), or null when it has none
function staticText(n) {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text || null;
  return null;
}
const isImportMeta = (n) => ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword && n.name.text === "meta";
// import.meta.url or import.meta["url"]
const isImportMetaUrl = (n) =>
  (ts.isPropertyAccessExpression(n) && isImportMeta(n.expression) && n.name.text === "url") ||
  (ts.isElementAccessExpression(n) && isImportMeta(n.expression) && (ts.isStringLiteral(n.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(n.argumentExpression)) && n.argumentExpression.text === "url");
// serviceWorker, or <x>.serviceWorker
const isServiceWorker = (n) => (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && (ts.isIdentifier(n) ? n.text : n.name.text) === "serviceWorker";
// a base made from the page's own address: import.meta.url, location or document anywhere in it (location.origin,
// window.location.href, document.baseURI, String(import.meta.url)); a property named document (config.document) is not
const onPage = (base) => {
  const stack = [base];
  while (stack.length) {
    const n = stack.pop();
    if (isImportMetaUrl(n) || (ts.isIdentifier(n) && (n.text === "location" || n.text === "document"))) return true;
    if (ts.isPropertyAccessExpression(n)) {
      if (n.name.text === "location") return true;
      stack.push(n.expression);
      continue;
    }
    ts.forEachChild(n, (c) => {
      stack.push(c);
    });
  }
  return false;
};
const COMMENT_IMPORT = /\bimport\s*\(\s*(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;

// the reach forms of a script: { at, form, s (null: not checkable), snippet, glob }. decl: also the module of every
// import and export declaration (a page's script, which depcruise does not read)
function scriptForms(text, kind, base, decl = false) {
  const sf = ts.createSourceFile("f", text, ts.ScriptTarget.Latest, false, kind);
  const out = [];
  const literals = []; // where strings, regexes and JSX text sit, so a // or /* in them is not a comment
  // staticOnly: a path that is not static is not read (not refused as not checkable); relativeOnly: a root path is not
  // read (a route of another base)
  const push = (form, arg, glob = false, staticOnly = false, relativeOnly = false) => {
    for (const a of glob && ts.isArrayLiteralExpression(arg) ? arg.elements : [arg]) {
      const s = staticText(a);
      if (s === null && staticOnly) continue;
      if (relativeOnly && s?.startsWith("/")) continue;
      out.push({ at: base + a.getStart(sf), form, s, snippet: a.getText(sf).replace(/\s+/g, " ").slice(0, 60), glob });
    }
  };
  // an explicit stack, not recursion: valid code nests deeper than the call stack (a 2000-call chain, an 8000-term sum)
  const stack = [sf];
  while (stack.length) {
    const n = stack.pop();
    const k = n.kind;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isRegularExpressionLiteral(n) || ts.isJsxText(n) || k === ts.SyntaxKind.TemplateHead || k === ts.SyntaxKind.TemplateMiddle || k === ts.SyntaxKind.TemplateTail)
      literals.push([n.getStart(sf), n.end]);
    if (ts.isCallExpression(n) && n.arguments.length) {
      const e = n.expression;
      if (e.kind === ts.SyntaxKind.ImportKeyword) push("import()", n.arguments[0]);
      else if (ts.isIdentifier(e) && e.text === "require") push("require()", n.arguments[0]);
      else if ((ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "") === "importScripts") for (const a of n.arguments) push("importScripts()", a, false, true);
      else if (ts.isPropertyAccessExpression(e)) {
        const name = e.name.text;
        if (ts.isIdentifier(e.expression) && e.expression.text === "require" && name === "resolve") push("require.resolve()", n.arguments[0]);
        else if (isImportMeta(e.expression) && (name === "glob" || name === "resolve")) push(`import.meta.${name}()`, n.arguments[0], name === "glob");
        else if (name === "register" && isServiceWorker(e.expression)) push("serviceWorker.register()", n.arguments[0], false, true);
      }
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.arguments?.length) {
      const c = n.expression.text;
      // on import.meta.url a path that is not static is not checkable; on any other base only a static path is read
      // a root path only on a base made from the page's own address
      if (c === "URL" && n.arguments.length >= 2) {
        const meta = isImportMetaUrl(n.arguments[1]);
        push("new URL()", n.arguments[0], false, !meta, !meta && !onPage(n.arguments[1]));
      }
      else if (c === "Worker" || c === "SharedWorker") push(`new ${c}()`, n.arguments[0], false, true);
    }
    if (decl && (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier)
      push(ts.isImportDeclaration(n) ? "an import" : "an export from", n.moduleSpecifier);
    if (decl && ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) push("an import = require()", n.moduleReference.expression);
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) push("an import() type", n.argument.literal);
    ts.forEachChild(n, (c) => {
      stack.push(c); // (a callback that returns a value would stop forEachChild)
    });
  }
  // the comments: every // or /* outside a literal
  literals.sort((a, b) => a[0] - b[0]);
  let li = 0;
  for (let i = 0; i < text.length; i++) {
    while (li < literals.length && literals[li][1] <= i) li++;
    if (li < literals.length && literals[li][0] <= i) {
      i = literals[li][1] - 1;
      continue;
    }
    if (text[i] !== "/" || (text[i + 1] !== "/" && text[i + 1] !== "*")) continue;
    const end = text[i + 1] === "/" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2);
    const stop = end === -1 ? text.length : end;
    for (const m of text.slice(i, stop).matchAll(COMMENT_IMPORT))
      out.push({ at: base + i + m.index, form: "a comment import()", s: m[2], snippet: m[0] });
    i = stop;
  }
  return out;
}

// a stylesheet with its comments blanked (newlines kept, so lines and offsets hold): /* */, and with line, // to the
// end of the line; a string and an unquoted url(...) body are copied as they are, so a "//" or "/*" in them starts none
const URL_BODY = /url\(\s*[^"'\s)][^)\n]*/iy;
function blankStyleComments(text, line) {
  let out = "";
  let i = 0;
  const blank = (j) => {
    out += text.slice(i, j).replace(/[^\n]/g, " ");
    i = j;
  };
  const copy = (j) => {
    out += text.slice(i, j);
    i = j;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      copy(Math.min(j + 1, text.length));
      continue;
    }
    if (text.startsWith("/*", i)) {
      const e = text.indexOf("*/", i + 2);
      blank(e === -1 ? text.length : e + 2);
      continue;
    }
    if (line && text.startsWith("//", i)) {
      const e = text.indexOf("\n", i);
      blank(e === -1 ? text.length : e);
      continue;
    }
    URL_BODY.lastIndex = i;
    const u = !/\w/.test(text[i - 1] ?? "") && URL_BODY.exec(text);
    copy(u ? i + u[0].length : i + 1);
  }
  return out;
}

// the reach forms of a stylesheet: @import "<path>" and url(<path>), quoted or not, outside its comments
function styleForms(text, base, line) {
  const t = blankStyleComments(text, line);
  const out = [];
  for (const m of t.matchAll(/@import\s+(["'])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) out.push({ at: base + m.index, form: "a CSS @import", s: m[2], snippet: m[0] });
  for (const m of t.matchAll(/\burl\(\s*(?:(["'])((?:(?!\1)[^\\\n]|\\.)*)\1|([^"'\s)][^\s)]*))\s*\)/g))
    out.push({ at: base + m.index, form: "a CSS url()", s: m[2] ?? m[3], snippet: m[0] });
  return out;
}

// the src and href of the tags that load what they name, in a page: <link>, <script>, <img>, <source>, <iframe>,
// <embed>, and the data of <object> (an <a> only links). Their names in any case in .html; in .vue, .svelte and .astro
// a capitalized name is a component, not one of them. A value with a scheme ("https:", "data:") or "//" is a URL, not a
// path; a bound one (:src) is not read.
const LOAD_TAG = /<(link|script|img|source|iframe|embed|object)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const URL_LIKE = /^([a-z][a-z\d+.-]*:|\/\/)/i;
function attrForms(file, text) {
  const out = [];
  for (const m of text.matchAll(LOAD_TAG)) {
    if (!/\.html?$/.test(file) && /^[A-Z]/.test(m[1])) continue;
    const base = m.index + 1 + m[1].length;
    for (const a of m[2].matchAll(ATTR)) {
      const name = a[1].toLowerCase();
      const v = (a[2] ?? a[3] ?? a[4])?.trim();
      if ((name !== "src" && name !== "href" && (name !== "data" || m[1].toLowerCase() !== "object")) || !v || URL_LIKE.test(v)) continue;
      out.push({ at: base + a.index, form: `an HTML ${name}`, s: v, snippet: a[0], both: true });
    }
  }
  return out;
}

// every address of an import map (the body of a <script type="importmap">): the values of its "imports" and of each
// of its "scopes", each a path from the page's folder (or the root, for "/…"); a URL is not a path. A map a browser
// cannot parse as JSON is not checkable.
function importMapForms(body, base) {
  let map;
  try {
    map = JSON.parse(body);
  } catch {
    return [{ at: base, s: null, why: `an import map that is not JSON (${body.trim().replace(/\s+/g, " ").slice(0, 60)}): not checkable` }];
  }
  const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
  const out = [];
  for (const m of [obj(map).imports, ...Object.values(obj(obj(map).scopes))])
    for (const [k, v] of Object.entries(obj(m))) {
      const s = typeof v === "string" ? v.trim() : "";
      if (!s || URL_LIKE.test(s)) continue;
      const i = body.indexOf(JSON.stringify(v).slice(1, -1));
      out.push({ at: base + Math.max(i, 0), form: "an import map address", s, snippet: `"${k}": "${v}"`.slice(0, 60), both: true });
    }
  return out;
}
const isImportMap = (attrs) => [...attrs.matchAll(ATTR)].some((a) => a[1].toLowerCase() === "type" && (a[2] ?? a[3] ?? a[4] ?? "").trim().toLowerCase() === "importmap");

function forms(file, text) {
  const ext = posix.extname(file);
  if (SCRIPT[ext] !== undefined) return scriptForms(text, SCRIPT[ext], 0);
  if (STYLE.test(file)) return styleForms(text, 0, LINE_COMMENT_STYLE.test(file));
  if (!MARKUP.test(file)) return [];
  const out = attrForms(file, text);
  const front = ext === ".astro" && text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (front) out.push(...scriptForms(front[1], ts.ScriptKind.TS, front[0].indexOf("\n") + 1, true));
  for (const m of text.matchAll(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
    const base = m.index + m[0].indexOf(">") + 1;
    const line = /\blang\s*=\s*["']?(scss|sass|less|stylus|styl)\b/i.test(m[2]);
    if (m[1].toLowerCase() === "script" && isImportMap(m[2])) {
      out.push(...importMapForms(m[3], base));
      continue;
    }
    out.push(...(m[1].toLowerCase() === "script" ? scriptForms(m[3], ts.ScriptKind.TS, base, true) : styleForms(m[3], base, line)));
  }
  return out;
}

// every finding in one file's text: [line, finding]
export function reaches(file, text, names = [], kitName = null) {
  const out = [];
  const lineAt = (i) => text.slice(0, i).split("\n").length;
  for (const { at, form, s, snippet, glob, both, why } of forms(file, text)) {
    if (s === null) {
      out.push([lineAt(at), why ?? `${form} with a first argument that is not a static string (${snippet}): not checkable`]);
      continue;
    }
    // a page's "/" value: from the repo root, and from the page's folder (a dev server's root)
    const p = lands(file, s, glob) ?? (both && s.startsWith("/") ? lands(file, `.${s}`) : null);
    if (p) out.push([lineAt(at), `"${s}" reaches ${p}`]);
    for (const n of names)
      if (s.startsWith(`${n}/`) || (s === n && n !== kitName)) out.push([lineAt(at), `"${s}" names ${n}${n === kitName ? " past its entry" : ""}`]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

export function kitReach(root) {
  const files = execFileSync("git", ["ls-files", "-z", "-c", "-o", "--exclude-standard"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const unique = [...new Set(files)];
  const refusals = [];
  // the package names of packages/ and contracts/, and which one is the kit
  const names = [];
  let kitName = null;
  for (const f of unique.filter((f) => INSIDE.test(f) && posix.basename(f) === "package.json" && !/(^|\/)node_modules\//.test(f))) {
    try {
      const name = JSON.parse(readFileSync(`${root}/${f}`, "utf8")).name;
      if (typeof name !== "string" || !name) continue;
      names.push(name);
      if (f === "packages/kit/package.json") kitName = name;
    } catch {}
  }
  let read = 0;
  for (const f of unique) {
    if (/(^|\/)node_modules(\/|$)/.test(f)) {
      refusals.push(`${f}: a node_modules path in git`);
      continue;
    }
    if (INSIDE.test(f)) continue;
    // a file that cannot be read is refused by its name, and the others are still read
    try {
      const st = lstatSync(`${root}/${f}`, { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) {
        const target = readlinkSync(`${root}/${f}`);
        const p = target.startsWith("/") ? null : lands(f, target);
        const abs = target.startsWith("/") ? posix.relative(root, target) : null;
        const hit = p ?? (abs && INSIDE.test(abs) && !KIT_ENTRY.test(abs) ? abs : null);
        if (hit) refusals.push(`${f}: a symlink to "${target}", which reaches ${hit}`);
        continue;
      }
      if (!st?.isFile() || !(SCRIPT[posix.extname(f)] !== undefined || STYLE.test(f) || MARKUP.test(f))) continue;
      read++;
      for (const [line, what] of reaches(f, readFileSync(`${root}/${f}`, "utf8"), names, kitName)) refusals.push(`${f}:${line}: ${what}`);
    } catch (e) {
      refusals.push(`${f}: could not be read (${String(e?.message ?? e).split("\n")[0]}), so it is refused`);
    }
  }
  return { refusals, read };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let r;
  try {
    r = kitReach(process.cwd());
  } catch (e) {
    console.error(`kit-reach: REFUSED: could not read the files here: ${String(e?.message ?? e).split("\n")[0]}`);
    process.exit(1);
  }
  for (const x of r.refusals) console.error(`kit-reach: REFUSED: ${x}`);
  if (r.refusals.length) process.exit(1);
  console.log(`kit-reach: OK (${r.read} code file(s) outside packages/ and contracts/ read)`);
}
