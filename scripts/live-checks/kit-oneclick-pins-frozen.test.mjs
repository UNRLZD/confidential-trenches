// node --test scripts/live-checks/kit-oneclick-pins-frozen.test.mjs: the live check replays its recorded answers
// (kit-oneclick-pins-frozen.answers.json, its _note says where each was read). good: this card's SIGN_HOST build, every
// 1Click pin frozen and only the pinned key named: PASS. bad: SIGN_HOST as served on 6 Nov 23:16Z (release-66), the four
// pins in plain literals: FAIL. badHarnessKey: the good build with a made-up key beside the pinned one, re-pinned: FAIL.
// Planted on good: another /app.js, no pin, the pinned key missing, each pin missing or with a copy not frozen: each FAIL.
// And the check's own pins are the kit's: PINNED_KEYS and PINS equal the kit's exports, so neither can change alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PINNED_KEYS, PINS, facts, judge } from "./kit-oneclick-pins-frozen.mjs";
import * as KIT from "../../packages/kit/src/index.ts";

const A = JSON.parse(readFileSync(new URL("./kit-oneclick-pins-frozen.answers.json", import.meta.url), "utf8"));
const bads = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const UNFROZEN = (name) => `BAD 1 of 1 copies of ${name} in the bundle are not frozen: code on the page could change it`;

test("recorded good answer: this card's build freezes every 1Click pin and names only the pinned key: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(A.good.keys, [...PINNED_KEYS]);
  for (const name of Object.keys(PINS)) assert.deepEqual(A.good.pins[name], { copies: 1, frozen: 1 }, name);
});

test("recorded bad answer: SIGN_HOST before this card (release-66) leaves all four pins writable: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(bads(v), Object.keys(PINS).map(UNFROZEN));
});

test("recorded bad answer: a build that ships a harness key beside the pinned one: FAIL, naming the key", () => {
  const v = judge(A.badHarnessKey);
  assert.equal(v.ok, false);
  assert.equal(bads(v).length, 2, v.lines.join("\n"));
  assert.match(bads(v)[0], /^BAD the bundle names the 1Click key ed25519:5Mbn3Ajg8a4x3tgXqLqgdx2GvnyLRB3exyzi9apAYVt8, which the release does not pin/);
  // and the key set is no longer exactly the pinned one
  assert.equal(bads(v)[1], "BAD the bundle holds no ONECLICK_SIGNING_KEYS with exactly its pinned values");
});

test("planted on good: another app.js, no pin, the pinned key missing, a pin missing or a copy unfrozen: each FAIL", () => {
  const with_ = (f) => { const a = structuredClone(A.good); f(a); return bads(judge(a)); };
  assert.deepEqual(with_((a) => { a.sha384 = "sha384-x"; }), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(with_((a) => { a.index = "<!doctype html>"; }), ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(with_((a) => { a.keys = []; }), [`BAD the bundle does not name the pinned 1Click key ${PINNED_KEYS[0]}`]);
  for (const name of Object.keys(PINS)) {
    assert.deepEqual(with_((a) => { a.pins[name] = { copies: 0, frozen: 0 }; }), [`BAD the bundle holds no ${name} with exactly its pinned values`], name);
    assert.deepEqual(with_((a) => { delete a.pins[name]; }), [`BAD the bundle holds no ${name} with exactly its pinned values`], name);
    assert.deepEqual(with_((a) => { a.pins[name] = { copies: 2, frozen: 1 }; }), [`BAD 1 of 2 copies of ${name} in the bundle are not frozen: code on the page could change it`], name);
  }
  assert.equal(judge(null).ok, false);
});

test("facts reads a minified bundle: quotes and spacing of any kind, a frozen copy and a plain one, a longer fee or key", () => {
  const index = '<script type="module" src="/app.js" integrity="sha384-x"></script>';
  const [k] = PINNED_KEYS;
  const [a0, a1, a2] = PINS.ONECLICK_USDC_ASSETS;
  const js = `var a=Object.freeze([\`${k}\`]),b=Object.freeze( { keyless : 1 , partner : 1 } ),c=Object.freeze({keyless:20,partner:20}),` +
    `d=Object.freeze(["${a0}", '${a1}',"${a2}"]),e={keyless:20,partner:20},f={keyless:1,partner:10},g="${k}xy";`;
  const f = facts(index, js);
  assert.deepEqual(f.keys, [k]); // a string run on past 44 base58 characters is not a key
  assert.deepEqual(f.pins, {
    ONECLICK_SIGNING_KEYS: { copies: 1, frozen: 1 },
    ONECLICK_USDC_ASSETS: { copies: 1, frozen: 1 },
    ONECLICK_FEE_BPS: { copies: 1, frozen: 1 },
    ONECLICK_PAIR_FEE_BPS: { copies: 2, frozen: 1 },
  });
  // a freeze around something else that holds the literal is not the literal's own
  assert.deepEqual(facts(index, `x=Object.freeze([\`${k}\`].concat([]))`).pins.ONECLICK_SIGNING_KEYS, { copies: 1, frozen: 0 });
});

test("the check's pins are the kit's: PINNED_KEYS and every value of PINS equal the kit's exports", () => {
  assert.deepEqual([...PINNED_KEYS], [...KIT.ONECLICK_SIGNING_KEYS]);
  assert.deepEqual([...PINS.ONECLICK_USDC_ASSETS], [...KIT.ONECLICK_USDC_ASSETS]);
  assert.deepEqual({ ...PINS.ONECLICK_FEE_BPS }, { ...KIT.ONECLICK_FEE_BPS });
  assert.deepEqual({ ...PINS.ONECLICK_PAIR_FEE_BPS }, { ...KIT.ONECLICK_PAIR_FEE_BPS });
});
