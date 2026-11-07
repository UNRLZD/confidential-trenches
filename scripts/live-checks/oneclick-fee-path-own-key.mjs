#!/usr/bin/env node
// Live check of card oneclick-fee-path-own-key on SIGN_HOST (https://confidential.unrealized.trade). What it holds,
// and only that: the served /app.js is the one index.html pins (its sha384), and in it, read from a real parse of the
// bundle (rolldown's parseAst, ESTree), the device's 1Click fee by path (packages/kit/src/checks/oneclick.ts
// oneClickFeeBps) reads its two fee tables only as own keys and refuses any other path by name:
//   - the bundle declares each fee table, ONECLICK_FEE_BPS {keyless: 1, partner: 1} and ONECLICK_PAIR_FEE_BPS {keyless:
//     20, partner: 20}, as a name bound to that object literal (or Object.freeze of it);
//   - every computed read of either table's binding by a key that is not a literal, T[k], sits in a function (any kind:
//     a declaration, an expression, an arrow, a class or object method, private, quoted or computed) whose own body,
//     before the read on every path to it, holds a guard with its refusal: `G || refuse(...)`, `if (!G) refuse(...)` (one
//     if or several) or `!G ? refuse(...) : <the read>`, where G holds typeof k == "string" and Object.hasOwn(T, k) (or
//     Object.prototype.hasOwnProperty.call(T, k), or {}.hasOwnProperty.call(T, k); no other object's hasOwnProperty, and
//     no Object bound in the code around the read: a parameter, a const or an outer arrow's Object is not the realm's) and
//     the refusal's text names "no such 1Click path"; and k is that function's own parameter, never shadowed (a for-let,
//     a catch, a block's let), redeclared (a var, a for-var, a function) or assigned in it, so the key read is the key
//     checked. A guard in a nested function, a guard whose result is unused, one with the wrong polarity, or a read in a
//     parameter default (it runs before the body) guards nothing. A table's binding is matched by scope, so a second
//     table of the same name in another scope has its reads held too.
// A read through the prototype chain, as SIGN_HOST served before this card (release-68), lets a polluted
// Object.prototype.nopath = 1 name a fee for a path that does not exist, and a real dry quote on it passed the device's
// check; without the typeof, a key object whose toString answers "partner" to the checks and "nopath" to the read does
// the same. Known limits, outside what this reads: a read that does not index the table's binding, such as
// Reflect.get(T, k), a computed destructuring of T, or T passed along and indexed under another name (`const X = T;
// X[k]`); and what the refusal call does, such as a refusal deferred into a timer (that it throws is the kit's tests',
// packages/kit/test/oneclick.test.ts). Correct code it fails closed on, never open: the guard as `if (!(G)) refuse()`,
// as `if (!G) return refuse()`, or as a ternary statement `!G ? refuse() : 0` before the read; and a table bound by
// assignment to an earlier var (`var T; ... T = {...}`) rather than by its declarator.
// This file reaches no package code (the import check holds it): its test holds TABLES to the kit's own exports. The
// parser is the kit's own dev dependency, loaded through the kit's package.json as pool-sol-deploy.mjs loads snarkjs.
//   node scripts/live-checks/oneclick-fee-path-own-key.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "oneclick-fee-path-own-key";
export const SIGN = "https://confidential.unrealized.trade";
export const REFUSAL = "no such 1Click path";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { parseAst } = createRequire(path.join(REPO, "packages/kit/package.json"))("rolldown/parseAst");

/** The two fee tables the device's 1Click check reads by path, with their pinned values. */
export const TABLES = Object.freeze({
  ONECLICK_FEE_BPS: Object.freeze({ keyless: 1, partner: 1 }),
  ONECLICK_PAIR_FEE_BPS: Object.freeze({ keyless: 20, partner: 20 }),
});

// ------------------------------------------------------------------------------------------------ the tree
const isNode = (v) => v !== null && typeof v === "object" && typeof v.type === "string";
/** Every node under `node` with its ancestors (root first), depth first. */
function* walk(node, up = []) {
  yield [node, up];
  const next = [...up, node];
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) for (const x of v) { if (isNode(x)) yield* walk(x, next); }
    else if (isNode(v) && k !== "parent") yield* walk(v, next);
  }
}
const FUNCTION = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const within = (n, at) => n.start <= at.start && at.end <= n.end;
/** The names a binding pattern binds. */
function patternNames(p, out = []) {
  if (!p) return out;
  if (p.type === "Identifier") out.push(p.name);
  else if (p.type === "AssignmentPattern") patternNames(p.left, out);
  else if (p.type === "RestElement") patternNames(p.argument, out);
  else if (p.type === "ArrayPattern") for (const e of p.elements) patternNames(e, out);
  else if (p.type === "ObjectPattern") for (const q of p.properties) patternNames(q.type === "RestElement" ? q.argument : q.value, out);
  return out;
}
/** The var and function names a function body hoists (nested functions left out). */
function hoisted(body, out = new Set()) {
  for (const [n, up] of walk(body)) {
    if (up.slice(1).some((a) => FUNCTION.has(a.type))) continue; // inside a nested function
    if (n.type === "VariableDeclaration" && n.kind === "var") for (const d of n.declarations) for (const x of patternNames(d.id)) out.add(x);
    if (n.type === "FunctionDeclaration" && n !== body && n.id) out.add(n.id.name);
  }
  return out;
}
/** The names `scope` binds for the code at `child` inside it: a function's own parameters, name and hoisted names; a
 *  block's or the program's let, const, class and function declarations; a for's let or const; a catch's parameter. */
function binds(scope, child) {
  const names = new Set();
  const lexical = (list) => {
    for (const s of list) {
      if (s.type === "VariableDeclaration" && s.kind !== "var") for (const d of s.declarations) for (const x of patternNames(d.id)) names.add(x);
      if ((s.type === "ClassDeclaration" || s.type === "FunctionDeclaration") && s.id) names.add(s.id.name);
    }
  };
  if (FUNCTION.has(scope.type)) {
    for (const p of scope.params) for (const x of patternNames(p)) names.add(x);
    if (scope.type === "FunctionExpression" && scope.id) names.add(scope.id.name);
    if (scope.body.type === "BlockStatement") for (const x of hoisted(scope.body)) names.add(x);
  } else if (scope.type === "Program") {
    lexical(scope.body);
    for (const x of hoisted(scope)) names.add(x);
  } else if (scope.type === "BlockStatement" || scope.type === "StaticBlock") lexical(scope.body);
  else if (scope.type === "SwitchStatement") for (const c of scope.cases) lexical(c.consequent);
  else if (["ForStatement", "ForInStatement", "ForOfStatement"].includes(scope.type)) {
    const d = scope.type === "ForStatement" ? scope.init : scope.left;
    if (d?.type === "VariableDeclaration" && d.kind !== "var") for (const x of d.declarations) for (const y of patternNames(x.id)) names.add(y);
  } else if (scope.type === "CatchClause" && child !== scope.param) for (const x of patternNames(scope.param)) names.add(x);
  else if ((scope.type === "ClassExpression" || scope.type === "ClassDeclaration") && scope.id) names.add(scope.id.name);
  return names;
}
/** The scope among `up` (ancestors, root first) that binds `name` for `node`, or null. */
function bindingScope(name, node, up) {
  const path = [...up, node];
  for (let i = up.length - 1; i >= 0; i--) if (binds(up[i], path[i + 1]).has(name)) return up[i];
  return null;
}

// ------------------------------------------------------------------------------------------------ the tables
/** The table's literal, or Object.freeze of it, with exactly the pinned values. */
function isTable(init, values) {
  let o = init;
  if (o?.type === "CallExpression" && o.arguments.length === 1 && o.callee.type === "MemberExpression" && !o.callee.computed &&
    o.callee.object.type === "Identifier" && o.callee.object.name === "Object" && o.callee.property.name === "freeze") o = o.arguments[0];
  if (o?.type !== "ObjectExpression" || o.properties.length !== Object.keys(values).length) return false;
  return o.properties.every((p) => {
    if (p.type !== "Property" || p.computed || p.kind !== "init") return false;
    const k = p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : undefined;
    return k !== undefined && Object.hasOwn(values, k) && p.value.type === "Literal" && p.value.value === values[k];
  });
}

// ------------------------------------------------------------------------------------------------ the guard
const isRefusalText = (n) => [...walk(n)].some(([x]) => (x.type === "Literal" && typeof x.value === "string" && x.value.includes(REFUSAL)) ||
  (x.type === "TemplateElement" && String(x.value?.cooked ?? x.value?.raw ?? "").includes(REFUSAL)));
/** A refusal: a call, or a throw, of anything; `text` when its arguments name REFUSAL. */
function refusal(n) {
  if (n?.type === "CallExpression" || n?.type === "NewExpression") return { text: n.arguments.some(isRefusalText) };
  if (n?.type === "ThrowStatement") return { text: isRefusalText(n.argument) };
  if (n?.type === "ExpressionStatement") return refusal(n.expression);
  if (n?.type === "BlockStatement" && n.body.length >= 1) return refusal(n.body[0]);
  return null;
}
const flat = (n, op) => (n.type === "LogicalExpression" && n.operator === op ? [...flat(n.left, op), ...flat(n.right, op)] : [n]);
const str = (n) => (n.type === "Literal" && n.value === "string") || (n.type === "TemplateLiteral" && n.expressions.length === 0 && n.quasis[0].value.cooked === "string");
/** `typeof k <op> "string"` either way round, with op one of `ops`: k's name, or null. */
function typeofString(n, ops) {
  if (n.type !== "BinaryExpression" || !ops.includes(n.operator)) return null;
  const t = [n.left, n.right].find((x) => x.type === "UnaryExpression" && x.operator === "typeof" && x.argument.type === "Identifier");
  const o = t === n.left ? n.right : n.left;
  return t && str(o) ? t.argument.name : null;
}
const unparen = (n) => (n.type === "ParenthesizedExpression" ? unparen(n.expression) : n);
/** `Object.hasOwn(T, k)`, `Object.prototype.hasOwnProperty.call(T, k)` or `{}.hasOwnProperty.call(T, k)`: [T, k], or null.
 *  Any other object's hasOwnProperty is not the check: an object the caller passes in can answer what it likes. */
function hasOwn(n) {
  if (n.type !== "CallExpression" || n.arguments.length !== 2 || !n.arguments.every((a) => a.type === "Identifier")) return null;
  const c = n.callee;
  const own = c.type === "MemberExpression" && !c.computed && c.object.type === "Identifier" && c.object.name === "Object" && c.property.name === "hasOwn";
  const m = c.type === "MemberExpression" && !c.computed && c.property.name === "call" ? c.object : null;
  const x = m?.type === "MemberExpression" && !m.computed && m.property.name === "hasOwnProperty" ? unparen(m.object) : null;
  const proto = x !== null && ((x.type === "ObjectExpression" && x.properties.length === 0) || (x.type === "MemberExpression" && !x.computed &&
    x.object.type === "Identifier" && x.object.name === "Object" && x.property.name === "prototype"));
  return own || proto ? [n.arguments[0].name, n.arguments[1].name] : null;
}
/** What must hold when `n` is true (a conjunction), or when `n` is false (`negated`: a disjunction of negations). */
function facts_(n, negated) {
  const out = new Set();
  for (const t of flat(n, negated ? "||" : "&&")) {
    const ty = typeofString(t, negated ? ["!=", "!=="] : ["==", "==="]);
    if (ty) out.add(`typeof:${ty}`);
    const h = negated ? (t.type === "UnaryExpression" && t.operator === "!" ? hasOwn(t.argument) : null) : hasOwn(t);
    if (h) out.add(`own:${h[0]}:${h[1]}`);
  }
  return out;
}
/** The guards an expression holds before its part at `read`, and the guards in `stmt` (a statement wholly before the
 *  read). Each guard: { holds: Set, text }. */
function guardOf(expr) {
  // G || refuse(...)
  if (expr.type === "LogicalExpression" && expr.operator === "||") {
    const r = refusal(expr.right);
    if (r) return { holds: facts_(expr.left, false), text: r.text };
  }
  return null;
}
function guardsBeforeIn(expr, read, out) {
  if (!expr || !within(expr, read)) return;
  if (expr.type === "SequenceExpression") {
    for (const e of expr.expressions) {
      if (within(e, read)) return guardsBeforeIn(e, read, out);
      const g = guardOf(e);
      if (g) out.push(g);
    }
  } else if (expr.type === "ConditionalExpression") {
    const rc = refusal(expr.consequent), ra = refusal(expr.alternate);
    if (within(expr.alternate, read) && rc) out.push({ holds: facts_(expr.test, true), text: rc.text });
    if (within(expr.consequent, read) && ra) out.push({ holds: facts_(expr.test, false), text: ra.text });
    guardsBeforeIn(within(expr.alternate, read) ? expr.alternate : within(expr.consequent, read) ? expr.consequent : null, read, out);
  } else if (expr.type === "ParenthesizedExpression") guardsBeforeIn(expr.expression, read, out);
}
function guardsOfStatement(stmt, out) {
  if (stmt.type === "ExpressionStatement") {
    for (const e of stmt.expression.type === "SequenceExpression" ? stmt.expression.expressions : [stmt.expression]) {
      const g = guardOf(e);
      if (g) out.push(g);
    }
  } else if (stmt.type === "IfStatement" && !stmt.alternate) {
    const r = refusal(stmt.consequent);
    if (r) out.push({ holds: facts_(stmt.test, true), text: r.text });
  }
}
/** The guards that hold at `read` in its function `fn`: in the function's own top-level statements before the one that
 *  holds the read, and inside that statement's expression before the read. */
function guardsAt(fn, read) {
  const out = [];
  if (!within(fn.body, read)) return out; // a read in a parameter default runs before the body
  if (fn.body.type !== "BlockStatement") {
    guardsBeforeIn(fn.body, read, out);
    return out;
  }
  for (const s of fn.body.body) {
    if (within(s, read)) {
      const e = s.type === "ReturnStatement" ? s.argument : s.type === "ExpressionStatement" ? s.expression : null;
      guardsBeforeIn(e, read, out);
      break;
    }
    guardsOfStatement(s, out);
  }
  return out;
}
/** True when `name` is assigned anywhere in `fn` (nested functions that bind their own `name` left out). */
function assigned(fn, name) {
  for (const [n, up] of walk(fn.body)) {
    const target = n.type === "AssignmentExpression" ? n.left : n.type === "UpdateExpression" ? n.argument :
      (n.type === "ForInStatement" || n.type === "ForOfStatement") && n.left.type !== "VariableDeclaration" ? n.left : null;
    if (!target || !patternNames(target).includes(name)) continue;
    if (bindingScope(name, n, [fn, ...up]) === fn) return true;
  }
  return false;
}

/** What the check keeps of the reads: the index, the served bundle's sha384, per table the names it is bound to, and
 *  every computed read of a table's binding by a key that is not a literal, with what holds at the read in its own
 *  function: owns (Object.hasOwn(T, k)), typed (typeof k == "string"), scoped (k is that function's own parameter,
 *  unshadowed and unassigned) and refuses (the guard's refusal names REFUSAL). */
export function facts(index, js) {
  const ast = parseAst(js);
  const nodes = [...walk(ast)];
  const tables = {};
  const reads = [];
  for (const [table, values] of Object.entries(TABLES)) {
    const decls = nodes.filter(([n]) => n.type === "VariableDeclarator" && n.id.type === "Identifier" && isTable(n.init, values))
      .map(([n, up]) => ({ name: n.id.name, scope: bindingScope(n.id.name, n.id, [...up, n]) }));
    tables[table] = [...new Set(decls.map((d) => d.name))];
    for (const [n, up] of nodes) {
      if (n.type !== "MemberExpression" || !n.computed || n.object.type !== "Identifier") continue;
      const at = decls.some((x) => x.name === n.object.name) ? bindingScope(n.object.name, n.object, [...up, n]) : null;
      const d = decls.find((x) => x.name === n.object.name && x.scope === at);
      if (!d) continue; // another binding of that name
      const p = n.property;
      if (p.type === "Literal" || (p.type === "TemplateLiteral" && p.expressions.length === 0)) continue;
      const key = js.slice(p.start, p.end);
      const fnAt = up.findLastIndex((a) => FUNCTION.has(a.type));
      const fn = fnAt < 0 ? null : up[fnAt];
      const k = p.type === "Identifier" ? p.name : null;
      const scoped = fn !== null && k !== null && bindingScope(k, p, [...up, n]) === fn &&
        fn.params.some((q) => patternNames(q).includes(k)) && !assigned(fn, k) && !(fn.body.type === "BlockStatement" && hoisted(fn.body).has(k));
      const globalObject = bindingScope("Object", n.object, [...up, n]) === null;
      const guards = fn === null || k === null || !globalObject ? [] : guardsAt(fn, n);
      const owns = guards.filter((g) => g.holds.has(`own:${d.name}:${k}`));
      const typed = guards.filter((g) => g.holds.has(`typeof:${k}`));
      reads.push({ table, name: d.name, key, owns: owns.length > 0, typed: typed.length > 0, scoped,
        refuses: owns.length > 0 && typed.length > 0 && [...owns, ...typed].every((g) => g.text) });
    }
  }
  return { index, sha384: sha384(js), tables, reads };
}

/** The verdict on an answer { index, sha384, tables, reads }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  const reads = Array.isArray(a?.reads) ? a.reads : [];
  for (const table of Object.keys(TABLES)) {
    const names = a?.tables?.[table];
    if (!Array.isArray(names) || names.length === 0) bad(`the bundle holds no ${table} with exactly its pinned values`);
    else if (!reads.some((r) => r?.table === table)) bad(`the bundle never reads ${table} by path`);
  }
  for (const r of reads) {
    if (!r?.owns) bad(`${r?.table} is read as ${r?.name}[${r?.key}] with no Object.hasOwn(${r?.name}, ${r?.key}) first: a polluted Object.prototype can name a fee for a path that does not exist`);
    else if (!r.typed) bad(`${r.table}'s read ${r.name}[${r.key}] is not behind typeof ${r.key} == "string": a key object can answer one name to the check and another to the read`);
    else if (r.scoped !== true) bad(`${r.table}'s read ${r.name}[${r.key}] does not read its function's own parameter ${r.key}: a key shadowed or assigned after the check is not the key it checked`);
    else if (!r.refuses) bad(`${r.table}'s read ${r.name}[${r.key}] is behind a guard whose refusal does not name "${REFUSAL}"`);
  }
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  return facts(await get("/"), await get("/app.js"));
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
