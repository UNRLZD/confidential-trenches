#!/usr/bin/env node
// Live check of card kit-entry-signpage-api: the kit's public entry and the signing page's messages, as GitHub serves
// them. It reads packages/kit/package.json and packages/kit/src/index.ts at a ref (main, or the freeze tag kit-v1), and
// every file index.ts re-exports (followed through each file's own relative `export ... from`), and checks:
//   - the exports map's keys are exactly ".", "./core" and "./package.json", "." and "./core" point at
//     ./src/index.ts and ./src/core.ts (types and default), with no build;
//   - SIGNPAGE_KINDS, and the keys of SignpageParams and SignpageResults, are exactly the fifteen kinds of wallet.md §7
//     item 4 (pinned below, as the public repo carries no papers);
//   - SIGNPAGE_EVENTS holds only the handshake events ready, state and progress;
//   - OrderRecord, and ORDER_RECORD_FIELDS, are exactly the twelve fields of the order record (wallet.md §7 item 3 in
//     markets.md H5.1's shape, decided 2026-11-01 00:35Z), its `variants` holds 1 to 3 signed variants, and
//     OrderTrigger is exactly H5.1's trigger.
//   node scripts/live-checks/kit-entry-signpage-api.mjs [--ref <branch or tag> | --root <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --root reads the same paths from a local tree instead of GitHub (a branch before it merges).
// --record writes every file the run read ({ path: { status, body } }) to <file>, so the check's test can replay it.
import "../net-window.mjs";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const KEY = "kit-entry-signpage-api";
export const REPO = "UNRLZD/confidential-trenches";

// wallet.md §7 item 4 (research main ffcba5e, wallet.md:1132-1135)
export const KINDS = [
  "deposit.quote", "deposit.confirm", "arm", "buy", "hop", "orders.set", "orders.cancel", "return",
  "withdraw.open", "signin.open", "backup.open", "export.open", "signout", "restore", "state",
];
// app.md §7 ask P1 (app.md:1669-1672): the only names allowed beside the kinds
export const EVENTS = ["ready", "state", "progress"];
// wallet.md §7 item 3 (wallet.md:1129-1131) in markets.md H5.1's shape (markets.md:2059-2073; O4, markets.md:3446)
export const ORDER_FIELDS = [
  "v", "order_id", "group_id", "chain", "wallet", "token", "amount", "min_out", "trigger", "nonce_ref", "variants",
  "expires_at",
];
export const TRIGGER_FIELDS = ["kind", "pool", "venue", "direction", "price", "quote_asset"];
export const VARIANT_COUNTS = [1, 2, 3];
const EXPORTS = {
  ".": { types: "./src/index.ts", default: "./src/index.ts" },
  "./core": { types: "./src/core.ts", default: "./src/core.ts" },
  "./package.json": "./package.json",
};
const MAX_FILES = 50;

// reads one repo path at the ref: { status, body }
export function github(ref, fetchFn = fetch) {
  return async (p) => {
    const r = await fetchFn(`https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(ref)}/${p}`, { cache: "no-store" });
    return { status: r.status, body: r.ok ? await r.text() : "" };
  };
}

const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));
const show = (a) => (a ? `[${a.join(", ")}]` : "none");
const diff = (got, want) => {
  if (!got) return "not found";
  const missing = want.filter((x) => !got.includes(x));
  const extra = got.filter((x) => !want.includes(x));
  return [missing.length && `missing ${missing.join(", ")}`, extra.length && `extra ${extra.join(", ")}`].filter(Boolean).join("; ") || `duplicates in ${show(got)}`;
};

// the relative re-exports of one file, as repo paths: "./signpage/messages" -> packages/kit/src/signpage/messages.ts
function reExports(sf, from) {
  const out = [];
  for (const s of sf.statements) {
    if (!ts.isExportDeclaration(s) || !s.moduleSpecifier || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    const spec = s.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;
    const p = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)).replace(/\.(js|ts)$/, "");
    out.push(`${p}.ts`);
  }
  return out;
}

const unwrap = (e) => {
  while (e && (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e))) e = e.expression;
  return e;
};
const exported = (s) => s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const nameOf = (n) => (ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null);

// the lengths a type allows when it is a tuple of strings or a union of them; null for anything else (string[] too)
function tupleLengths(t) {
  const parts = t && ts.isUnionTypeNode(t) ? t.types : [t];
  const out = [];
  for (const p of parts) {
    if (!p || !ts.isTupleTypeNode(p) || !p.elements.every((e) => e.kind === ts.SyntaxKind.StringKeyword)) return null;
    out.push(p.elements.length);
  }
  return out.sort((a, b) => a - b);
}

// every exported const array of string literals, and every exported interface's member names, across the files
function shapes(files) {
  const arrays = new Map();
  const interfaces = new Map();
  const variants = new Map();
  for (const [p, text] of files) {
    const sf = ts.createSourceFile(p, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    for (const s of sf.statements) {
      if (ts.isVariableStatement(s) && exported(s)) {
        for (const d of s.declarationList.declarations) {
          const e = unwrap(d.initializer);
          if (ts.isIdentifier(d.name) && e && ts.isArrayLiteralExpression(e)) {
            arrays.set(d.name.text, e.elements.map((x) => (ts.isStringLiteral(x) ? x.text : `<${x.getText(sf)}>`)));
          }
        }
      }
      if (ts.isInterfaceDeclaration(s) && exported(s)) {
        interfaces.set(s.name.text, s.members.map((m) => (m.name ? nameOf(m.name) ?? `<${m.name.getText(sf)}>` : "<index>")));
        const v = s.members.find((m) => m.name && nameOf(m.name) === "variants");
        if (v) variants.set(s.name.text, tupleLengths(v.type));
      }
    }
  }
  return { arrays, interfaces, variants };
}

export async function check({ read }) {
  const lines = [];
  const say = (ok, text) => (lines.push(`${ok ? "ok " : "BAD"} ${text}`), ok);
  const got = async (p) => {
    const r = await read(p);
    if (r.status !== 200) throw new Error(`${p}: HTTP ${r.status}`);
    return r.body;
  };

  const pkg = JSON.parse(await got("packages/kit/package.json"));
  const ex = pkg.exports ?? {};
  const keysOk = sameSet(Object.keys(ex), Object.keys(EXPORTS));
  const targetsOk = Object.entries(EXPORTS).every(([k, v]) => JSON.stringify(ex[k]) === JSON.stringify(v));
  const noBuild = !("main" in pkg) && !("module" in pkg) && !("types" in pkg) && !("browser" in pkg);
  const a = say(keysOk && targetsOk && noBuild, `exports keys ${show(Object.keys(ex))}${keysOk ? "" : ` (want ${show(Object.keys(EXPORTS))})`}; ` +
    `${targetsOk ? "pointing at src/" : `targets ${JSON.stringify(ex)}`}; ${noBuild ? "no build fields" : "a main/module/types/browser field"}`);

  const files = new Map();
  const queue = ["packages/kit/src/index.ts"];
  while (queue.length) {
    const p = queue.shift();
    if (files.has(p)) continue;
    if (files.size >= MAX_FILES) throw new Error(`more than ${MAX_FILES} files re-exported from index.ts`);
    const text = await got(p);
    files.set(p, text);
    queue.push(...reExports(ts.createSourceFile(p, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS), p));
  }
  const { arrays, interfaces, variants } = shapes(files);

  const kinds = arrays.get("SIGNPAGE_KINDS");
  const params = interfaces.get("SignpageParams");
  const results = interfaces.get("SignpageResults");
  const kOk = !!kinds && sameSet(kinds, KINDS);
  const pOk = !!params && sameSet(params, KINDS);
  const rOk = !!results && sameSet(results, KINDS);
  const b = say(kOk && pOk && rOk, `the kinds: SIGNPAGE_KINDS ${kOk ? "is the fifteen" : diff(kinds, KINDS)}; SignpageParams ${pOk ? "is the fifteen" : diff(params, KINDS)}; ` +
    `SignpageResults ${rOk ? "is the fifteen" : diff(results, KINDS)}`);

  const events = arrays.get("SIGNPAGE_EVENTS") ?? [];
  const eOk = new Set(events).size === events.length && events.every((x) => EVENTS.includes(x));
  const c = say(eOk, `the events ${show(events)}${eOk ? " are handshake names only" : ` hold a name outside ${show(EVENTS)}`}`);

  const rec = interfaces.get("OrderRecord");
  const fields = arrays.get("ORDER_RECORD_FIELDS");
  const oOk = !!rec && sameSet(rec, ORDER_FIELDS);
  const fOk = !!fields && sameSet(fields, ORDER_FIELDS);
  const d = say(oOk && fOk, `the order record: OrderRecord ${oOk ? "has the twelve fields" : diff(rec, ORDER_FIELDS)}; ORDER_RECORD_FIELDS ${fOk ? "is the twelve" : diff(fields, ORDER_FIELDS)}`);
  const counts = variants.get("OrderRecord");
  const vOk = !!counts && JSON.stringify(counts) === JSON.stringify(VARIANT_COUNTS);
  const e = say(vOk, `variants ${counts ? `holds ${counts.join(", ")} signed variants` : "is not a tuple of strings"}${vOk ? "" : ` (want ${VARIANT_COUNTS.join(", ")})`}`);
  const trig = interfaces.get("OrderTrigger");
  const tOk = !!trig && sameSet(trig, TRIGGER_FIELDS);
  const f = say(tOk, `OrderTrigger ${tOk ? "is H5.1's trigger" : diff(trig, TRIGGER_FIELDS)}`);

  lines.push(`    read ${[...files.keys()].join(", ")}`);
  return { ok: a && b && c && d && e && f, lines };
}

// reads one path from a local tree: { status, body }
export function local(root) {
  return async (p) => {
    try {
      return { status: 200, body: readFileSync(path.join(root, p), "utf8") };
    } catch {
      return { status: 404, body: "" };
    }
  };
}

// a reader that keeps every answer it reads: { path: { status, body } }
export function recorder(read) {
  const answers = {};
  return {
    answers,
    read: async (p) => {
      const r = await read(p);
      answers[p] = r;
      return r;
    },
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const root = opt("--root");
    const ref = root ? `local ${path.resolve(root)}` : opt("--ref", "main");
    const rec = recorder(root ? local(root) : github(ref));
    const r = await check({ read: rec.read });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify({ ref, read_at: new Date().toISOString(), files: rec.answers }, null, 1) + "\n");
    console.log(`live-check ${KEY}: ref ${ref}`);
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
