#!/usr/bin/env node
// Card held-move-replay-any-build: a live check's replay judges the tree's build with the live rule, never by its bytes.
// A replay that asserts the hash of a bundle it read equal to a recorded hash makes every signing page card re-record
// that check's good answer (PR #501 failed CI test-packages on wallet-restore-id-reader's "the bundle as recorded",
// 8 Nov 23:17Z). This gate refuses one:
//   node scripts/ci/replay-no-bundle-pin.mjs [root]      (exit 1 and one line per refusal)
// It reads every scripts/live-checks/*.test.mjs git lists (tracked, and untracked but not ignored) and refuses an
// equality that pins the build: an assert.equal, strictEqual, deepEqual or deepStrictEqual call, or an === or ==, whose
// one side is recorded and pins (a path ending in .sha384, .integrity, .app, .index or .bytes from a name bound to
// JSON.parse(readFileSync(<…answers.json…>)), or from one level of `const x = <that name>…` alias or destructuring of
// one; or a "sha384-…" literal) and whose other side is read from elsewhere (an expression naming sha384 or integrity,
// or ending in .app, .index or .bytes, that is neither). Two recorded values compared (a record against its own
// literal, or two records apart) and a hash used as a lookup key pass: neither reads the tree. Comments and string
// bodies are blanked first by the TypeScript parser (line breaks kept), so a quoted old pin is never refused; a
// "sha384-…" literal keeps its body, since it is a recorded hash.
// Risk it holds: a replay that pins the tree's bytes fails every build but the one recorded, so a card that changes
// nothing the check reads still has to re-record it.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const GLOB = "scripts/live-checks/*.test.mjs";
const PIN = /\.(?:sha384|integrity|app|index|bytes)$/;
const SRI = /^(["'`])sha384-[A-Za-z0-9+/=]*\1$/;
const PATH = /^([\w$]+)((?:\.[\w$]+|\[[^\]]+\])*)$/;
/** Whether `e` is a recorded value that pins the build, given `roots` (each recorded name or alias: the answers path it
 *  stands for). */
const isRecorded = (e, roots) => {
  if (SRI.test(e)) return true;
  const m = PATH.exec(e);
  return !!m && roots.has(m[1]) && PIN.test(roots.get(m[1]) + m[2]);
};
const readsBuild = (e) => /sha384|integrity/.test(e) || PIN.test(e);
const pinsWith = (roots) => (a, b) =>
  (isRecorded(a, roots) && !isRecorded(b, roots) && readsBuild(b)) || (isRecorded(b, roots) && !isRecorded(a, roots) && readsBuild(a));

const parse = (text) => ts.createSourceFile("x.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const unwrap = (n) => (n && (ts.isAwaitExpression(n) || ts.isParenthesizedExpression(n)) ? unwrap(n.expression) : n);

/** Each name bound to the parsed answers (`const A = JSON.parse(readFileSync(<…answers.json…>))`, the path read
 *  directly or through one const naming it), and one level of alias (`const good = A.good`) or destructuring
 *  (`const { good, bad: b } = A`) of one: name -> the answers path it stands for. */
export function recordedRoots(text, sf = parse(text)) {
  const decls = [];
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer) decls.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const consts = new Map(decls.filter((d) => ts.isIdentifier(d.name)).map((d) => [d.name.text, d.initializer.getText(sf)]));
  const roots = new Map();
  for (const d of decls) {
    const init = unwrap(d.initializer);
    if (!ts.isIdentifier(d.name) || !ts.isCallExpression(init) || init.expression.getText(sf) !== "JSON.parse") continue;
    const read = unwrap(init.arguments[0]);
    if (!read || !ts.isCallExpression(read) || !/^(?:fs\.)?readFileSync$/.test(read.expression.getText(sf)) || !read.arguments[0]) continue;
    const arg = read.arguments[0];
    const named = arg.getText(sf) + (ts.isIdentifier(arg) ? ` ${consts.get(arg.text) ?? ""}` : "");
    if (/answers\.json/.test(named)) roots.set(d.name.text, d.name.text);
  }
  const parsed = new Map(roots);
  for (const d of decls) {
    const m = PATH.exec(unwrap(d.initializer).getText(sf));
    if (!m || !parsed.has(m[1])) continue;
    if (ts.isIdentifier(d.name)) { if (!parsed.has(d.name.text)) roots.set(d.name.text, m[0]); }
    else if (ts.isObjectBindingPattern(d.name))
      for (const el of d.name.elements) {
        if (!ts.isIdentifier(el.name) || el.dotDotDotToken) continue;
        const key = el.propertyName ? el.propertyName.getText(sf) : el.name.text;
        roots.set(el.name.text, `${m[0]}.${key}`);
      }
  }
  return roots;
}

/** `text` with every comment and every string, template and regex body blanked to spaces, line breaks kept, read by the
 *  TypeScript parser; a "sha384-…" string keeps its body (it is a recorded hash). */
export function blanked(text, sf = parse(text)) {
  const out = text.split("");
  const blank = (from, to) => { for (let i = from; i < to; i++) if (out[i] !== "\n" && out[i] !== "\r") out[i] = " "; };
  const seen = new Set();
  const comments = (ranges) => { for (const r of ranges ?? []) if (!seen.has(r.pos)) { seen.add(r.pos); blank(r.pos, r.end); } };
  const visit = (n) => {
    comments(ts.getLeadingCommentRanges(text, n.pos));
    comments(ts.getTrailingCommentRanges(text, n.end));
    const at = n.getStart(sf);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) { if (!SRI.test(n.getText(sf))) blank(at + 1, n.end - 1); }
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n)) blank(at + 1, n.end - 2);
    else if (ts.isTemplateTail(n)) blank(at + 1, n.end - 1);
    else if (ts.isRegularExpressionLiteral(n)) blank(at + 1, n.getText(sf).lastIndexOf("/") + at);
    for (const c of n.getChildren(sf)) visit(c); // every token too, the closing brace and the end of file included
  };
  visit(sf);
  return out.join("");
}

/** The top-level arguments of the call whose "(" is at `open` in `text` (strings, templates and nesting skipped). */
function argsAt(text, open) {
  const out = [];
  let depth = 0, start = open + 1, quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (--depth === 0) {
        out.push(text.slice(start, i));
        return out.map((s) => s.trim());
      }
    } else if (c === "," && depth === 1) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return out.map((s) => s.trim());
}

/** The pinning equalities in one test file's text: [line number, the statement's text, comments and strings blanked]. */
export function bundlePins(source) {
  const sf = parse(source);
  const pins = pinsWith(recordedRoots(source, sf));
  const text = blanked(source, sf);
  const out = [];
  const lineOf = (at) => text.slice(0, at).split("\n").length;
  for (const m of text.matchAll(/\bassert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(/g)) {
    const [a = "", b = ""] = argsAt(text, m.index + m[0].length - 1);
    if (pins(a, b)) out.push([lineOf(m.index), `${m[0]}${a}, ${b})`]);
  }
  // a bare === or == between two operands of names, dots, brackets and strings
  const operand = String.raw`(?:[\w$.]+(?:\[[^\]\n]*\])*|"[^"\n]*"|'[^'\n]*')`;
  for (const m of text.matchAll(new RegExp(String.raw`(${operand})\s*===?\s*(${operand})`, "g")))
    if (pins(m[1], m[2])) out.push([lineOf(m.index), m[0]]);
  return out;
}

export function replayNoBundlePin(root) {
  const files = execFileSync("git", ["ls-files", "-z", "-c", "-o", "--exclude-standard", "--", GLOB], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const refusals = [];
  for (const f of [...new Set(files)])
    for (const [line, at] of bundlePins(readFileSync(`${root}/${f}`, "utf8")))
      refusals.push(`${f}:${line}: ${at} pins a bundle's hash to a recorded one: judge the tree's build with the live rule instead`);
  return { refusals, read: new Set(files).size };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = replayNoBundlePin(process.argv[2] ?? process.cwd());
  for (const x of r.refusals) console.error(`replay-no-bundle-pin: REFUSED: ${x}`);
  if (r.refusals.length) process.exit(1);
  console.log(`replay-no-bundle-pin: OK (${r.read} live-check test file(s) read)`);
}
