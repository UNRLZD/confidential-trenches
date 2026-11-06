// Card kit-oneclick-pins-frozen (the wallet-deposit-quote review, Low 2: a push into each pin succeeded at runtime):
// every pin the 1Click check reads is deep-frozen, so nothing running beside the check can add a signing key or a USDC
// asset or change a fee. Every export of src/checks/oneclick.ts and src/checks/oneclick-keys.ts that is not a function
// or a primitive must be frozen at every level, so a pin added later without its freeze fails here too; a push, an
// index or property write, a new property, a delete and a defineProperty on each pin throw (an ES module is strict
// code). Then each pin's freeze is removed one at a time in a planted copy of its source (a load hook on a ?plant=
// address, so no file is written): the walk names exactly that pin.
//   node --test test/oneclick-pins-frozen.test.ts      (from packages/kit)
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import * as ONECLICK from "../src/checks/oneclick.ts";
import * as KEYS from "../src/checks/oneclick-keys.ts";

/** Every path under `ns`'s exports that is an object or array not frozen, or a collection freezing cannot hold. */
function unfrozen(ns: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (v: unknown, at: string): void => {
    if (v === null || (typeof v !== "object" && typeof v !== "function")) return;
    if (typeof v === "function") return; // a function or class is code, not a pin
    if (v instanceof Map || v instanceof Set || ArrayBuffer.isView(v)) {
      out.push(`${at}: a ${v.constructor.name} stays writable when frozen`);
      return;
    }
    if (!Object.isFrozen(v)) out.push(at);
    for (const k of Reflect.ownKeys(v)) walk((v as Record<PropertyKey, unknown>)[k], `${at}.${String(k)}`);
  };
  for (const [k, v] of Object.entries(ns)) walk(v, k);
  return out;
}

const PINS = {
  ONECLICK_SIGNING_KEYS: ONECLICK.ONECLICK_SIGNING_KEYS,
  ONECLICK_USDC_ASSETS: ONECLICK.ONECLICK_USDC_ASSETS,
  ONECLICK_FEE_BPS: ONECLICK.ONECLICK_FEE_BPS,
  ONECLICK_PAIR_FEE_BPS: ONECLICK.ONECLICK_PAIR_FEE_BPS,
} as const;

test("every export of the 1Click check that is not code or a primitive is frozen at every level", () => {
  assert.deepEqual(unfrozen(ONECLICK as Record<string, unknown>), []);
  assert.deepEqual(unfrozen(KEYS as Record<string, unknown>), []);
  // the check reads the one key set: oneclick.ts re-exports oneclick-keys.ts's, never a copy of it
  assert.equal(ONECLICK.ONECLICK_SIGNING_KEYS, KEYS.ONECLICK_SIGNING_KEYS);
  // the walk covers every object export: the four pins, and nothing else of the module is a non-code object
  const objects = Object.entries(ONECLICK).filter(([, v]) => typeof v === "object" && v !== null).map(([k]) => k).sort();
  assert.deepEqual(objects, Object.keys(PINS).sort());
});

test("a push or an index write into the key set or the USDC assets throws, and the pin is unchanged", () => {
  for (const name of ["ONECLICK_SIGNING_KEYS", "ONECLICK_USDC_ASSETS"] as const) {
    const pin = PINS[name] as string[];
    const before = [...pin];
    assert.throws(() => pin.push("ed25519:11111111111111111111111111111111"), TypeError, `${name}.push`);
    assert.throws(() => pin.unshift("x"), TypeError, `${name}.unshift`);
    assert.throws(() => pin.splice(0, 1, "x"), TypeError, `${name}.splice`);
    assert.throws(() => { pin[0] = "x"; }, TypeError, `${name}[0] =`);
    assert.throws(() => { pin[pin.length] = "x"; }, TypeError, `${name}[length] =`);
    assert.throws(() => { pin.length = 0; }, TypeError, `${name}.length =`);
    assert.throws(() => Object.defineProperty(pin, "0", { value: "x" }), TypeError, `defineProperty(${name})`);
    assert.deepEqual([...pin], before);
  }
});

test("a write, a new path, a delete or a defineProperty on either fee table throws, and the fee is unchanged", () => {
  for (const name of ["ONECLICK_FEE_BPS", "ONECLICK_PAIR_FEE_BPS"] as const) {
    const pin = PINS[name] as unknown as Record<string, number>;
    const before = { ...pin };
    assert.throws(() => { pin.partner = 0; }, TypeError, `${name}.partner =`);
    assert.throws(() => { pin.keyless = 0; }, TypeError, `${name}.keyless =`);
    assert.throws(() => { pin.harness = 0; }, TypeError, `${name}.harness =`);
    assert.throws(() => { delete pin.partner; }, TypeError, `delete ${name}.partner`);
    assert.throws(() => Object.defineProperty(pin, "partner", { value: 0 }), TypeError, `defineProperty(${name})`);
    assert.deepEqual({ ...pin }, before);
  }
  // the check still reads the pinned fees
  const [near, sol] = ONECLICK.ONECLICK_USDC_ASSETS as [string, string];
  assert.equal(ONECLICK.oneClickFeeBps("partner", sol, near), 1);
  assert.equal(ONECLICK.oneClickFeeBps("partner", "nep141:wrap.near", near), 20);
});

// The planted copies: each removes one pin's Object.freeze from its source line, which must be found exactly once.
const PLANTS = {
  ONECLICK_SIGNING_KEYS: { file: "oneclick-keys.ts", line: "export const ONECLICK_SIGNING_KEYS: readonly string[] = Object.freeze([" },
  ONECLICK_USDC_ASSETS: { file: "oneclick.ts", line: "export const ONECLICK_USDC_ASSETS: readonly string[] = Object.freeze([" },
  ONECLICK_FEE_BPS: { file: "oneclick.ts", line: "export const ONECLICK_FEE_BPS = Object.freeze({" },
  ONECLICK_PAIR_FEE_BPS: { file: "oneclick.ts", line: "export const ONECLICK_PAIR_FEE_BPS = Object.freeze({" },
} as const;
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    const plant = new URL(url).searchParams.get("plant") as keyof typeof PLANTS | null;
    if (!plant) return r;
    const { line } = PLANTS[plant];
    const src = String(r.source);
    if (src.split(line).length !== 2) throw new Error(`${url}: the line of ${plant} moved; update this test's PLANTS`);
    return { ...r, source: src.replace(line, line.replace("Object.freeze(", "(")) };
  },
});

test("planted: each pin with its freeze removed fails the walk, which names that pin alone", async () => {
  for (const [pin, { file }] of Object.entries(PLANTS)) {
    const ns = (await import(`../src/checks/${file}?plant=${pin}`)) as Record<string, unknown>;
    assert.deepEqual(unfrozen(ns), [pin], `${pin} planted unfrozen in ${file}`);
    // and the write the review made succeeds on the plant: the push it guards against
    const v = ns[pin] as string[] | Record<string, number>;
    if (Array.isArray(v)) assert.doesNotThrow(() => v.push("x"));
    else assert.doesNotThrow(() => { v.partner = 0; });
  }
});

test("the walk itself: a Set, a Map, a nested writable object or a writable array is named", () => {
  const nested = Object.freeze({ a: Object.freeze([1]), b: { c: 1 } });
  assert.deepEqual(unfrozen({ S: new Set([1]), M: new Map(), N: nested, A: [1], f: () => 1, n: 1, s: "x" }),
    ["S: a Set stays writable when frozen", "M: a Map stays writable when frozen", "N.b", "A"]);
});
