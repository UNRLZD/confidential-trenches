// Card kit-oneclick-pins-frozen, review info 4 (the writable 1Click pins were one case of every kit pin): every export
// of the kit's entry, src/index.ts, that is a plain object, an array or a RegExp is frozen at every level, so nothing
// running beside the kit can change a value another part of it checks against. Before this card, a write to
// VAULT_CONSTANTS.MAX_RELAY_FEE_BPS made vaultRelayFeeWithinBackstop(9000n, 10000n) true, and HELPER_FETCH_INIT's
// credentials could be set to "include". An export that must stay writable is named in MUTABLE with its reason (none
// today). A planted copy of src/helper/v1.ts with HELPER_FETCH_INIT's freeze removed (a load hook on a ?plant address,
// no file written) fails the walk, naming that export alone.
//   node --test test/exports-frozen.test.ts      (from packages/kit)
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import * as KIT from "../src/index.ts";
import { deepFreeze } from "../src/freeze.ts";

/** Exports that must stay writable, each with its reason. None today. */
const MUTABLE: Record<string, string> = {};

/** Every path under `ns`'s exports that a write could change: an object, array or RegExp not frozen, a RegExp whose
 *  lastIndex a frozen copy could not keep (global or sticky), or a Map, Set or typed array (frozen, still writable). */
function writable(ns: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown, at: string): void => {
    if (v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (v instanceof Map || v instanceof Set || ArrayBuffer.isView(v)) return void out.push(`${at}: a ${v.constructor.name} stays writable when frozen`);
    if (v instanceof RegExp && (v.global || v.sticky)) out.push(`${at}: a global or sticky RegExp cannot be frozen and still match`);
    if (!Object.isFrozen(v)) out.push(at);
    for (const k of Reflect.ownKeys(v)) walk((v as Record<PropertyKey, unknown>)[k], `${at}.${String(k)}`);
  };
  for (const [k, v] of Object.entries(ns)) if (!Object.hasOwn(MUTABLE, k)) walk(v, k);
  return out;
}

test("every plain object, array and RegExp the kit's entry exports is frozen at every level", () => {
  assert.deepEqual(writable(KIT as Record<string, unknown>), []);
  for (const k of Object.keys(MUTABLE)) assert.ok(Object.hasOwn(KIT, k), `MUTABLE names ${k}, which the kit does not export`);
  // the walk reaches the pins it is for
  const objects = Object.entries(KIT).filter(([, v]) => typeof v === "object" && v !== null).map(([k]) => k);
  for (const k of ["VAULT_CONSTANTS", "HELPER_FETCH_INIT", "HELPER_CORS", "ONECLICK_SIGNING_KEYS", "ZK_SETUP_FILES"]) assert.ok(objects.includes(k), k);
});

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
  assert.equal(KIT.HELPER_SALT_PATTERN.test("0".repeat(32)), true); // a frozen RegExp without g or y still matches
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
  assert.deepEqual(writable({ W: { a: Object.freeze([1]), b: { c: 1 } }, S: new Set(), G: Object.freeze(/x/g) }),
    ["W", "W.b", "S: a Set stays writable when frozen", "G: a global or sticky RegExp cannot be frozen and still match"]);
  assert.equal(deepFreeze(1), 1);
  assert.equal(deepFreeze(null), null);
});

const LINE = "export const HELPER_FETCH_INIT = deepFreeze({ credentials: \"omit\", referrerPolicy: \"no-referrer\" } as const);";
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (new URL(url).searchParams.get("plant") !== "HELPER_FETCH_INIT") return r;
    const src = String(r.source);
    if (src.split(LINE).length !== 2) throw new Error(`${url}: HELPER_FETCH_INIT's line moved; update this test`);
    return { ...r, source: src.replace(LINE, LINE.replace("deepFreeze(", "(")) };
  },
});

test("planted: helper/v1.ts with HELPER_FETCH_INIT's freeze removed fails the walk, which names it alone", async () => {
  const planted = "../src/helper/v1.ts?plant=HELPER_FETCH_INIT"; // a variable: the type check reads no ?plant= module
  const ns = (await import(planted)) as Record<string, unknown>;
  assert.deepEqual(writable(ns), ["HELPER_FETCH_INIT"]);
  assert.doesNotThrow(() => { (ns.HELPER_FETCH_INIT as Record<string, unknown>).credentials = "include"; });
});
