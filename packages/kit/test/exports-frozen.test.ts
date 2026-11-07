// Card kit-oneclick-pins-frozen, review info 4 (the writable 1Click pins were one case of every kit pin): every export
// of every module under src/ (the entry, src/index.ts, and each file the signing page and the wallet import by path)
// that is a plain object or an array is frozen at every level, so nothing running beside the kit can change a value
// another part of it checks against. Before this card, a write to VAULT_CONSTANTS.MAX_RELAY_FEE_BPS made
// vaultRelayFeeWithinBackstop(9000n, 10000n) true, HELPER_FETCH_INIT's credentials could be set to "include", and the
// signing page's SIGNPAGE_PARAM_SCHEMAS and SIGNPAGE_RESULT_SCHEMAS could be swapped. A RegExp is never counted frozen:
// RegExp.prototype.compile rewrites a frozen one's matcher (the delta review of 75516003). The three the kit exports are
// named in MUTABLE with that reason, and no source file tests against one: a reader builds its own copy
// (`new RegExp(P.source, P.flags)`), which this test holds. A planted copy of a module without one export's deepFreeze
// line (a load hook on a ?plant=<NAME> address, no file written) fails the walk, naming that export alone.
//   node --test test/exports-frozen.test.ts      (from packages/kit)
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as KIT from "../src/index.ts";
import { deepFreeze } from "../src/freeze.ts";

const SWAPPABLE = "a frozen RegExp's matcher can be rewritten by RegExp.prototype.compile; no source tests against it, a reader builds its own copy";
/** Exports that stay writable, each with its reason. */
const MUTABLE: Record<string, string> = {
  HELPER_SALT_PATTERN: SWAPPABLE,
  HELPER_TOKEN_HASH_PATTERN: SWAPPABLE,
  SIGNPAGE_ROUTE_OUT: SWAPPABLE,
};

/** Every path under `ns`'s exports that a write could change: an object or array not frozen, any RegExp, or a Map, Set
 *  or typed array (frozen, still writable). */
function writable(ns: Record<string, unknown>, seen = new Set<object>(), prefix = ""): string[] {
  const out: string[] = [];
  const walk = (v: unknown, at: string): void => {
    if (v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (v instanceof Map || v instanceof Set || ArrayBuffer.isView(v)) return void out.push(`${at}: a ${v.constructor.name} stays writable when frozen`);
    if (v instanceof RegExp) out.push(`${at}: a RegExp's matcher stays rewritable when frozen`);
    else if (!Object.isFrozen(v)) out.push(at);
    for (const k of Reflect.ownKeys(v)) walk((v as Record<PropertyKey, unknown>)[k], `${at}.${String(k)}`);
  };
  for (const [k, v] of Object.entries(ns)) if (!Object.hasOwn(MUTABLE, k)) walk(v, `${prefix}${k}`);
  return out;
}

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") && !p.endsWith(".d.ts") ? [p] : [];
  });

test("every plain object and array any module under src/ exports is frozen at every level", async () => {
  const seen = new Set<object>();
  const found: string[] = [];
  const all = files(SRC);
  assert.ok(all.length > 30, `${all.length} modules`);
  for (const f of all) {
    const ns = (await import(pathToFileURL(f).href)) as Record<string, unknown>;
    found.push(...writable(ns, seen, `${path.relative(SRC, f)}: `));
  }
  assert.deepEqual(found, []);
  // the walk reaches the pins it is for, the signing page's deep imports among them
  for (const k of ["VAULT_CONSTANTS", "HELPER_FETCH_INIT", "HELPER_CORS", "ONECLICK_SIGNING_KEYS", "ZK_SETUP_FILES"]) assert.ok(Object.isFrozen((KIT as Record<string, unknown>)[k]), k);
  const S = await import("../src/signpage/schema.ts");
  const N = await import("../src/near/networks.ts");
  for (const v of [S.SIGNPAGE_PARAM_SCHEMAS, S.SIGNPAGE_RESULT_SCHEMAS, N.NEAR_RPC_URLS]) assert.ok(Object.isFrozen(v));
  assert.throws(() => { (S.SIGNPAGE_PARAM_SCHEMAS as Record<string, unknown>).buy = () => true; }, TypeError);
  assert.throws(() => { (S.SIGNPAGE_RESULT_SCHEMAS as Record<string, unknown>).state = () => true; }, TypeError);
});

test("MUTABLE names only RegExps the kit exports, each frozen, and no source file tests against one: readers copy it", async () => {
  const exported: Record<string, unknown> = { ...KIT, ...(await import("../src/signpage/schema.ts")) };
  for (const k of Object.keys(MUTABLE)) assert.ok(exported[k] instanceof RegExp && Object.isFrozen(exported[k]), k);
  // why: compile swaps a frozen RegExp's matcher (it throws only after, on lastIndex), and a copy made before keeps its own
  const pin = Object.freeze(/^[0-9a-f]{32}$/);
  const copy = new RegExp(pin.source, pin.flags);
  assert.throws(() => (RegExp.prototype as unknown as { compile(this: RegExp, p: string): void }).compile.call(pin, "^"), TypeError);
  assert.equal(pin.test("not-a-salt"), true);
  assert.equal(copy.test("not-a-salt"), false);
  // every use of a MUTABLE name in the source (every package's src/ and apps/*/src/), comments left out, is its
  // definition, its deepFreeze line, an import or export list, or `.source` / `.flags` for a copy
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const trees = ["packages", "apps"].flatMap((d) => readdirSync(path.join(root, d)).map((p) => path.join(root, d, p, "src")));
  const reads: string[] = [];
  for (const t of trees) {
    let list: string[];
    try { list = filesAny(t); } catch { continue; }
    for (const f of list) for (const k of mutableReads(readFileSync(f, "utf8"))) reads.push(`${path.relative(root, f)}: ${k}`);
  }
  assert.deepEqual(reads, []);
});

/** The MUTABLE names `text` uses other than as allowed above. An import or export list is allowed only when it names
 *  each one as itself: `import { SIGNPAGE_ROUTE_OUT as ROUTE_BOUND }` would let ROUTE_BOUND.test(...) through the
 *  strip below, so an alias is a use (card oneclick-fee-path-own-key, from the delta review of kit-oneclick-pins-frozen). */
function mutableReads(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
  const text = code.replace(/\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}(?:\s*from\s*["'][^"']+["'])?/g, "");
  return Object.keys(MUTABLE).filter((k) => {
    if (new RegExp(`\\b${k}\\s+as\\b`).test(code)) return true;
    const rest = text.replace(new RegExp(`export const ${k} =|deepFreeze\\(${k}\\);|\\b${k}\\.(?:source|flags)\\b`, "g"), "");
    return new RegExp(`\\b${k}\\b`).test(rest);
  });
}

test("planted: an aliased import or export of a MUTABLE name is a use, so a test against the alias cannot hide", () => {
  const aliased = 'import { SIGNPAGE_ROUTE_OUT as ROUTE_BOUND } from "@blindfill/kit";\nexport const bound = (u: string) => ROUTE_BOUND.test(u);\n';
  assert.deepEqual(mutableReads(aliased), ["SIGNPAGE_ROUTE_OUT"]);
  assert.deepEqual(mutableReads('export { HELPER_SALT_PATTERN as SALT } from "./v1.ts";\n'), ["HELPER_SALT_PATTERN"]);
  assert.deepEqual(mutableReads('import {\n  HELPER_TOKEN_HASH_PATTERN as H,\n} from "@blindfill/kit";\n'), ["HELPER_TOKEN_HASH_PATTERN"]);
  // what stays allowed: a plain list, the definition and its freeze line, and a copy from .source and .flags
  const allowed = 'import { SIGNPAGE_ROUTE_OUT, type X } from "@blindfill/kit";\nconst own = new RegExp(SIGNPAGE_ROUTE_OUT.source, SIGNPAGE_ROUTE_OUT.flags);\n' +
    'export const HELPER_SALT_PATTERN = /^x$/;\ndeepFreeze(HELPER_SALT_PATTERN);\n// SIGNPAGE_ROUTE_OUT as a word in a comment\n';
  assert.deepEqual(mutableReads(allowed), []);
  assert.deepEqual(mutableReads("const ok = SIGNPAGE_ROUTE_OUT.test(u);\n"), ["SIGNPAGE_ROUTE_OUT"]);
});

/** Every .ts, .tsx, .js and .mjs file under `dir`, with node_modules left out. */
function filesAny(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    if (f === "node_modules") return [];
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? filesAny(p) : /\.(?:tsx?|m?js)$/.test(p) ? [p] : [];
  });
}

test("the review's writes throw and change nothing: the vault's relay fee backstop and the helper's fetch options", () => {
  const vault = KIT.VAULT_CONSTANTS as unknown as Record<string, unknown>;
  assert.equal(KIT.vaultRelayFeeWithinBackstop(9000n, 10000n), false);
  assert.throws(() => { vault.MAX_RELAY_FEE_BPS = 10_000; }, TypeError);
  assert.equal(KIT.vaultRelayFeeWithinBackstop(9000n, 10000n), false);
  const init = KIT.HELPER_FETCH_INIT as unknown as Record<string, unknown>;
  assert.throws(() => { init.credentials = "include"; }, TypeError);
  assert.throws(() => { init.mode = "no-cors"; }, TypeError);
  assert.equal(KIT.HELPER_FETCH_INIT.credentials, "omit");
  assert.throws(() => (KIT.HELPER_CORS.origins as unknown as string[]).push("https://evil.test"), TypeError);
  assert.throws(() => { (KIT.HELPER_SALT_PATTERN as unknown as { lastIndex: number }).lastIndex = 5; }, TypeError);
});

test("deepFreeze freezes every level and returns what it was given, under a part frozen only at its top too", () => {
  const v = { a: [1, { b: 2 }], c: { d: [3] } };
  assert.equal(deepFreeze(v), v);
  assert.deepEqual(writable({ v }), []);
  const shallow = Object.freeze({ rows: [{ id: "x" }] });
  assert.deepEqual(writable({ shallow }), ["shallow.rows", "shallow.rows.0"]);
  deepFreeze(shallow);
  assert.deepEqual(writable({ shallow }), []);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(deepFreeze(cycle), cycle);
  assert.ok(Object.isFrozen(cycle));
  assert.deepEqual(writable({ W: { a: Object.freeze([1]), b: { c: 1 } }, S: new Set(), R: Object.freeze(/x/) }),
    ["W", "W.b", "S: a Set stays writable when frozen", "R: a RegExp's matcher stays rewritable when frozen"]);
  assert.equal(deepFreeze(1), 1);
  assert.equal(deepFreeze(null), null);
});

registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    const name = new URL(url).searchParams.get("plant");
    if (name === null) return r;
    const line = `\ndeepFreeze(${name});\n`;
    const src = String(r.source);
    if (src.split(line).length !== 2) throw new Error(`${url}: ${name}'s freeze line moved; update this test`);
    return { ...r, source: src.replace(line, "\n") };
  },
});

test("planted: a module with one export's freeze removed fails the walk, which names that export alone", async () => {
  const helper = "../src/helper/v1.ts?plant=HELPER_FETCH_INIT"; // a variable: the type check reads no ?plant= module
  const ns = (await import(helper)) as Record<string, unknown>;
  assert.deepEqual(writable(ns), ["HELPER_FETCH_INIT"]);
  assert.doesNotThrow(() => { (ns.HELPER_FETCH_INIT as Record<string, unknown>).credentials = "include"; });
  const schema = "../src/signpage/schema.ts?plant=SIGNPAGE_PARAM_SCHEMAS";
  const s = (await import(schema)) as Record<string, unknown>;
  assert.deepEqual(writable(s), ["SIGNPAGE_PARAM_SCHEMAS"]);
});
