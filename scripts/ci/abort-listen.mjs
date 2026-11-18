// Every wait on an abort reads the signal first. An aborted signal never fires its event again, so a listener added
// after the abort waits forever: deposit-moveout's R11-BUDGET2 fake subscribed to its budget only after an await, the
// budget ended inside that await on a starved runner, and the wallet run held a heavy slot 49 min (card
// aborted-signal-waits-end-at-once). A production wait of that shape holds a user's flow until its own bound, if any.
//
// What it refuses, in every file of SCOPE: a call `X.addEventListener("abort", ...)` with no check of the same X before
// it, where a check is a read of `X.aborted` or a call of `X.throwIfAborted()` (`?.` and `!` aside) that:
//   - sits in the listener's own function, or in the function a `new Promise(executor)` runs the listener's executor
//     in (an executor runs at once), never in a nested function, which may run at any time or never;
//   - always runs before it: not inside an if's branch, a catch or finally, a case, a loop's body or a ?: branch the
//     listener is not in (the condition of an if, a loop or a ?: counts, and so does an operand of && or ||);
//   - has no await or yield after it that ends before the listener;
//   - when the listener sits in a loop the check is outside of, that loop holds no await or yield (its next turn
//     listens after one with no check).
// untilAborted(signal) (packages/kit/src/abort.ts) is the shape for a plain wait on an abort, a fake's above all.
//   node scripts/ci/abort-listen.mjs    lists each refusal, exit 1 on any
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SCOPE = [
  "packages/kit/src/**",
  "packages/kit/test/**",
  "packages/wallet/src/**",
  "packages/wallet/test/**",
  "packages/signpage/src/**",
  "packages/signpage/test/**",
  "packages/signpage/scripts/**",
  "apps/helper/src/**",
  "apps/helper/test/**",
  "scripts/ci/**",
];
const KIND = { ".js": ts.ScriptKind.JS, ".cjs": ts.ScriptKind.JS, ".mjs": ts.ScriptKind.JS, ".jsx": ts.ScriptKind.JSX, ".ts": ts.ScriptKind.TS, ".cts": ts.ScriptKind.TS, ".mts": ts.ScriptKind.TS, ".tsx": ts.ScriptKind.TSX };


const fnLike = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);
const loop = (n) => ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n);
/** A function `new Promise(f)` runs at once: what runs in it before the listener runs as the caller's own code. */
const executor = (f) => ts.isNewExpression(f.parent) && f.parent.arguments?.[0] === f && f.parent.expression.getText() === "Promise";
/** The signal an expression names, `?.` and `!` aside. */
const named = (e) => {
  let x = e;
  while (ts.isNonNullExpression(x) || ts.isParenthesizedExpression(x)) x = x.expression;
  return x.getText().replace(/\s+/g, "").replace(/\?\./g, ".").replace(/!(?=\.|$)/g, "");
};
/** `child` is a branch of `parent` that may not run when parent runs. */
function branch(parent, child) {
  if (ts.isIfStatement(parent)) return child === parent.thenStatement || child === parent.elseStatement;
  if (ts.isConditionalExpression(parent)) return child === parent.whenTrue || child === parent.whenFalse;
  if (ts.isTryStatement(parent)) return child === parent.catchClause || child === parent.finallyBlock;
  if (loop(parent)) return child === parent.statement;
  return ts.isCaseBlock(parent);
}
/** The nearest function holding `n`, or the source file. */
const fnOf = (n) => {
  for (let p = n.parent; p; p = p.parent) if (fnLike(p)) return p;
  return n.getSourceFile();
};

/** Every listener of SCOPE's rule the text refuses: [{ line, text, why }]. */
export function findings(text, file = "f.ts") {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, KIND[path.extname(file)] ?? ts.ScriptKind.TS);
  const checks = [];
  const waits = [];
  const listeners = [];
  const visit = (n) => {
    if (ts.isAwaitExpression(n) || ts.isYieldExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier)) waits.push(n);
    if (ts.isPropertyAccessExpression(n) && n.name.text === "aborted") checks.push({ node: n, signal: named(n.expression) });
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const m = n.expression.name.text;
      if (m === "throwIfAborted") checks.push({ node: n, signal: named(n.expression.expression) });
      const a = n.arguments[0];
      if (m === "addEventListener" && a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && a.text === "abort") listeners.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const out = [];
  for (const call of listeners) {
    const signal = named(call.expression.expression);
    // the functions whose code runs, in order, up to the listener: its own, and each one that runs it as an executor
    const scopes = [];
    for (let f = fnOf(call); ; f = fnOf(f)) {
      scopes.push(f);
      if (ts.isSourceFile(f) || !executor(f)) break;
    }
    const inScope = (n) => scopes.includes(fnOf(n));
    const up = new Set();
    for (let p = call; p; p = p.parent) up.add(p);
    // a check that always runs before the listener: the last one in its code before it
    let check = null;
    for (const c of checks) {
      if (c.signal !== signal || c.node.end > call.getStart() || !inScope(c.node)) continue;
      let child = c.node;
      let ok = true;
      for (let p = child.parent; p && !up.has(p); child = p, p = p.parent) if (branch(p, child) || fnLike(p)) ok = false;
      if (ok && !branch(child.parent, child) && (check === null || c.node.end > check.end)) check = c.node;
    }
    const at = sf.getLineAndCharacterOfPosition(call.getStart()).line + 1;
    const say = (why) => out.push({ line: at, text: call.getText().split("\n")[0].slice(0, 120), why });
    if (check === null) {
      say(`no check of ${signal}.aborted before it`);
      continue;
    }
    const between = waits.find((w) => inScope(w) && w.getStart() >= check.end && w.end <= call.getStart());
    if (between) {
      say(`an await after the check of ${signal}.aborted (line ${sf.getLineAndCharacterOfPosition(between.getStart()).line + 1}) ends before it`);
      continue;
    }
    // a loop the listener sits in and the check does not: its next turn listens after the loop's await
    for (let p = call.parent; p && !(check.pos >= p.pos && check.end <= p.end); p = p.parent) {
      if (!loop(p) || !inScope(p)) continue;
      if (waits.some((w) => inScope(w) && w.pos >= p.pos && w.end <= p.end)) {
        say(`the loop at line ${sf.getLineAndCharacterOfPosition(p.getStart()).line + 1} awaits, and its next turn listens with no check of ${signal}.aborted`);
        break;
      }
    }
  }
  return out;
}

export function scan(root = ROOT) {
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SCOPE.map((g) => `:(glob)${g}`)], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "" && Object.hasOwn(KIND, path.extname(f)) && !f.split("/").includes("node_modules"));
  const out = {};
  for (const f of [...new Set(files)]) {
    let text;
    try {
      text = readFileSync(path.join(root, f), "utf8");
    } catch {
      continue; // listed by git, deleted in the tree
    }
    if (!text.includes("abort")) continue;
    const found = findings(text, f);
    if (found.length > 0) out[f] = found;
  }
  return out;
}

/** What the rule refuses: every file with a listener on an abort that reads no check first. No file is let off. */
export function refusals(found) {
  return Object.entries(found).map(([f, list]) => `${f}: ${list.length} listener(s) on an abort with no check first: ${list.map((x) => `line ${x.line}, ${x.why}`).join("; ")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = scan();
  for (const [f, list] of Object.entries(found)) for (const x of list) console.log(`${f}:${x.line}  ${x.why}  ${x.text}`);
  const bad = refusals(found);
  if (bad.length > 0) {
    console.error(`\n${bad.join("\n")}\n\nRead the signal first (if (signal.aborted) ...; or signal.throwIfAborted()), with no await between, or wait with untilAborted(signal).`);
    process.exit(1);
  }
}
