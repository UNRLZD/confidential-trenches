// The sign-in hint (card app-header-first-paint-auth, src/screens/signin/hint.ts): APP_HOST's own record of the last
// sign-in state the signing page's snapshot said, "in" or "out" and nothing else, read before the first paint so the
// header draws its loading state at the shape it will land in (none: the reserved "in" box); written only when a
// snapshot holds a state, so a wrong hint is corrected for the next load.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { firstShape, HINT_KEY, hintOf, readHint, shapeOf, writeHint } from "../src/screens/signin/hint.ts";

const state = (signed_in: boolean) => ({ release: "signpage-v1", api: 1, signed_in, way: "passkey", code_saved: true, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] }) as unknown as SignpageState;
const snap = (s: SignpageState | null, status: SignpageClientSnapshot["status"] = "ready"): SignpageClientSnapshot => ({ status, release: "signpage-v1", state: s, stale: false });

/** A Storage stand-in: a Map, or one whose every call throws (storage blocked). */
function store(init: Record<string, string> = {}, broken = false) {
  const m = new Map(Object.entries(init));
  const writes: string[] = [];
  const s = {
    getItem: (k: string) => {
      if (broken) throw new Error("blocked");
      return m.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error("blocked");
      writes.push(`${k}=${v}`);
      m.set(k, v);
    },
  };
  return { s, m, writes };
}

test("readHint: in or out as stored; anything else, nothing, or storage that throws is no hint", () => {
  assert.equal(readHint(store({ [HINT_KEY]: "in" }).s), "in");
  assert.equal(readHint(store({ [HINT_KEY]: "out" }).s), "out");
  for (const v of ["", "IN", "1", "true", '{"signed_in":true}']) assert.equal(readHint(store({ [HINT_KEY]: v }).s), null, v);
  assert.equal(readHint(store().s), null);
  assert.equal(readHint(store({}, true).s), null);
  assert.equal(readHint(null), null);
});

test("firstShape: the stored hint; with none, in (the reserved box, so a signed-in load moves nothing)", () => {
  assert.equal(firstShape("in"), "in");
  assert.equal(firstShape("out"), "out");
  assert.equal(firstShape(null), "in");
});

test("hintOf: the snapshot's own state, in or out; nothing while it holds no state (connecting, or down with nothing known)", () => {
  assert.equal(hintOf(snap(state(true))), "in");
  assert.equal(hintOf(snap(state(false))), "out");
  assert.equal(hintOf({ ...snap(state(true), "down"), stale: true }), "in");
  assert.equal(hintOf(snap(null, "connecting")), null);
  assert.equal(hintOf(snap(null, "down")), null);
});

test("writeHint: stores in or out under the one key, only when it changes; storage that throws is ignored", () => {
  const a = store();
  writeHint("in", a.s);
  writeHint("in", a.s);
  assert.deepEqual(a.writes, [`${HINT_KEY}=in`]);
  writeHint("out", a.s);
  assert.deepEqual(a.writes, [`${HINT_KEY}=in`, `${HINT_KEY}=out`]);
  assert.deepEqual([...a.m.keys()], [HINT_KEY]);
  assert.doesNotThrow(() => writeHint("in", store({}, true).s));
  assert.doesNotThrow(() => writeHint("in", null));
});

test("shapeOf: the first render's shape while loading; signed in, in; signed out, the first render's (an in box keeps its room)", () => {
  assert.equal(shapeOf("loading", "in"), "in");
  assert.equal(shapeOf("loading", "out"), "out");
  assert.equal(shapeOf("out", "out"), "out");
  // a stale "in" hint that lands signed out keeps its box for this load: Sign in lands inside it, nothing moves
  assert.equal(shapeOf("out", "in"), "in");
  // a stale "out" hint that lands signed in grows to the signed-in box
  assert.equal(shapeOf("empty", "out"), "in");
  assert.equal(shapeOf("balance", "out"), "in");
  assert.equal(shapeOf("balance", "in"), "in");
});
