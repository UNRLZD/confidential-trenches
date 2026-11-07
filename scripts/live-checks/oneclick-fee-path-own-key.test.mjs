// node --test scripts/live-checks/oneclick-fee-path-own-key.test.mjs: the live check replays its recorded answers
// (oneclick-fee-path-own-key.answers.json, its _note says where each was read). good: this card's SIGN_HOST build, both
// fee tables read by path only after Object.hasOwn, in the function that refuses an unknown path: PASS. bad: SIGN_HOST as
// served on 7 Nov 02:15Z (release-68), both read through the prototype chain: FAIL. Planted on good: another /app.js, no
// pin, a table missing or never read, a read without its own-key check or without the refusal: each FAIL. facts() reads a
// minified bundle of either shape. And the check's tables are the kit's exports, so neither can change alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, REFUSAL, TABLES } from "./oneclick-fee-path-own-key.mjs";
import * as KIT from "../../packages/kit/src/index.ts";

const A = JSON.parse(readFileSync(new URL("./oneclick-fee-path-own-key.answers.json", import.meta.url), "utf8"));
const bads = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const NO_OWN = (table, name) => `BAD ${table} is read as ${name}[e] with no Object.hasOwn(${name}, e) first: a polluted Object.prototype can name a fee for a path that does not exist`;

test("recorded good answer: this card's build reads both fee tables only as own keys and refuses an unknown path: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(A.good.reads.map((r) => [r.table, r.owns, r.refuses]), [["ONECLICK_FEE_BPS", true, true], ["ONECLICK_PAIR_FEE_BPS", true, true]]);
});

test("recorded bad answer: SIGN_HOST before this card (release-68) reads both tables through the prototype chain: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(bads(v), [NO_OWN("ONECLICK_FEE_BPS", "wl"), NO_OWN("ONECLICK_PAIR_FEE_BPS", "Tl")]);
});

test("planted on good: another app.js, no pin, a table missing or never read, a read unchecked or without the refusal: each FAIL", () => {
  const with_ = (f) => { const a = structuredClone(A.good); f(a); return bads(judge(a)); };
  assert.deepEqual(with_((a) => { a.sha384 = "sha384-x"; }), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(with_((a) => { a.index = "<!doctype html>"; }), ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const table of Object.keys(TABLES)) {
    assert.deepEqual(with_((a) => { a.tables[table] = []; }), [`BAD the bundle holds no ${table} with exactly its pinned values`], table);
    assert.deepEqual(with_((a) => { delete a.tables[table]; }), [`BAD the bundle holds no ${table} with exactly its pinned values`], table);
    assert.deepEqual(with_((a) => { a.reads = a.reads.filter((r) => r.table !== table); }), [`BAD the bundle never reads ${table} by path`], table);
  }
  assert.deepEqual(with_((a) => { a.reads[1].owns = false; }), [NO_OWN("ONECLICK_PAIR_FEE_BPS", A.good.reads[1].name)]);
  assert.deepEqual(with_((a) => { a.reads[0].refuses = false; }), [`BAD ONECLICK_FEE_BPS's read ${A.good.reads[0].name}[e] is in a function without the refusal "${REFUSAL}"`]);
  assert.equal(judge(null).ok, false);
});

test("facts reads a minified bundle: either table's literal in any spacing or quotes, frozen or not, each read in its own function", () => {
  const index = '<script type="module" src="/app.js" integrity="sha384-x"></script>';
  const fixed = `var a=Object.freeze( { keyless : 1 , "partner" : 1 } ),b={keyless:20,partner:20};` +
    `function f(e,t){return typeof e==\`string\`&&Object.hasOwn(a,e)&&Object.hasOwn(b,e)||W(\`request\`,\`${REFUSAL} \${e}\`),t?a[e]:b[e]}`;
  const f = facts(index, fixed);
  assert.deepEqual(f.tables, { ONECLICK_FEE_BPS: ["a"], ONECLICK_PAIR_FEE_BPS: ["b"] });
  assert.deepEqual(f.reads.map((r) => [r.name, r.key, r.owns, r.refuses]), [["a", "e", true, true], ["b", "e", true, true]]);
  // the check in another function, or on another key, or on the other table, guards nothing
  const apart = `var a=Object.freeze({keyless:1,partner:1}),b=Object.freeze({keyless:20,partner:20});` +
    `function g(e){Object.hasOwn(a,e)&&Object.hasOwn(b,e)||W(\`${REFUSAL}\`)}function f(e,n){return n?a[e]:Object.hasOwn(a,e)&&b[e]}`;
  assert.deepEqual(facts(index, apart).reads.map((r) => [r.name, r.owns]), [["a", false], ["b", false]]);
  // a literal key (a.keyless, a["keyless"]) is not a read by path; x.a[e] is another object's
  assert.deepEqual(facts(index, `var a={keyless:1,partner:1},b={keyless:20,partner:20};x=a.keyless+b["partner"]+o.a[e];`).reads, []);
  // a table with other values is not the pin
  assert.deepEqual(facts(index, `var a={keyless:1,partner:20};`).tables, { ONECLICK_FEE_BPS: [], ONECLICK_PAIR_FEE_BPS: [] });
});

test("the check's tables are the kit's: TABLES equal the kit's ONECLICK_FEE_BPS and ONECLICK_PAIR_FEE_BPS", () => {
  assert.deepEqual({ ...TABLES.ONECLICK_FEE_BPS }, { ...KIT.ONECLICK_FEE_BPS });
  assert.deepEqual({ ...TABLES.ONECLICK_PAIR_FEE_BPS }, { ...KIT.ONECLICK_PAIR_FEE_BPS });
});
