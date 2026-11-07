// node --test scripts/live-checks/oneclick-fee-path-own-key.test.mjs: the live check replays its recorded answers
// (oneclick-fee-path-own-key.answers.json, its _note says where each was read). good: this card's SIGN_HOST build, both
// fee tables read by path only after Object.hasOwn, in the function that refuses an unknown path: PASS. bad: SIGN_HOST as
// served on 7 Nov 02:15Z (release-68), both read through the prototype chain: FAIL. Planted on good: another /app.js, no
// pin, a table missing or never read, a read without its own-key check, its typeof or the refusal: each FAIL. Planted
// bundles (the review of e93dea74): an unguarded arrow after the guarded function, a read by a member key, and the guard
// without its typeof; (the delta review of c88a3eeb) an unguarded method body in a class or an object literal, and a
// typeof chained with the wrong operator; (r3, on a real parse) a private, quoted or computed method, a parameter with
// parentheses, the key shadowed (for-let, catch, a block's let) or assigned, a guard in a dead inner arrow, unused, with
// the wrong polarity or after the read: each FAIL; (the r4 delta review of 15750e7c) the key redeclared by a var or a
// for-var, a second table of the same name in another scope, a read in a parameter default, and a hasOwnProperty taken
// from an object the caller passes in: each FAIL; (the r5 delta review of 388efb26) Object bound locally, as a parameter, a
// const in the body or an outer arrow's parameter: each FAIL; and the text scan's false FAILs (a typeof or an arrow between, a
// ternary guard, "function" in the message, a block after a call, the guard split over two ifs): each PASS. facts() reads a minified bundle of either shape. And the check's tables are the kit's exports, so neither can change alone.
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
  assert.deepEqual(A.good.reads.map((r) => [r.table, r.owns, r.typed, r.scoped, r.refuses]), [["ONECLICK_FEE_BPS", true, true, true, true], ["ONECLICK_PAIR_FEE_BPS", true, true, true, true]]);
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
  assert.deepEqual(with_((a) => { a.reads[0].typed = false; }), [`BAD ONECLICK_FEE_BPS's read ${A.good.reads[0].name}[e] is not behind typeof e == "string": a key object can answer one name to the check and another to the read`]);
  assert.deepEqual(with_((a) => { a.reads[0].scoped = false; }), [`BAD ONECLICK_FEE_BPS's read ${A.good.reads[0].name}[e] does not read its function's own parameter e: a key shadowed or assigned after the check is not the key it checked`]);
  assert.deepEqual(with_((a) => { delete a.reads[0].scoped; }).length, 1, "an answer without scoped is no pass");
  assert.deepEqual(with_((a) => { a.reads[0].refuses = false; }), [`BAD ONECLICK_FEE_BPS's read ${A.good.reads[0].name}[e] is behind a guard whose refusal does not name "${REFUSAL}"`]);
  assert.equal(judge(null).ok, false);
});

test("facts reads a minified bundle: either table's literal in any spacing or quotes, frozen or not, each read in its own function", () => {
  const index = '<script type="module" src="/app.js" integrity="sha384-x"></script>';
  const tables = `var a=Object.freeze( { keyless : 1 , "partner" : 1 } ),b={keyless:20,partner:20};`;
  const guarded = `function f(e,t){return typeof e==\`string\`&&Object.hasOwn(a,e)&&Object.hasOwn(b,e)||W(\`request\`,\`${REFUSAL} \${typeof e==\`string\`?e:typeof e}\`),t?a[e]:b[e]}`;
  const f = facts(index, tables + guarded);
  assert.deepEqual(f.tables, { ONECLICK_FEE_BPS: ["a"], ONECLICK_PAIR_FEE_BPS: ["b"] });
  assert.deepEqual(f.reads.map((r) => [r.name, r.key, r.owns, r.typed, r.refuses]), [["a", "e", true, true, true], ["b", "e", true, true, true]]);
  const verdict = (js) => judge({ ...facts(index, js), sha384: "sha384-x" });
  assert.equal(verdict(tables + guarded).ok, true);
  // planted (the review of e93dea74): each passed the check before, each FAILs now
  // an unguarded arrow after the guarded function: an arrow is a function start, so the guard above it is not its own
  assert.equal(verdict(`${tables}${guarded};const z=(e,t)=>t?a[e]:b[e]`).ok, false);
  // reads come per table: a's in the guarded function then in z, then b's the same
  assert.deepEqual(facts(index, `${tables}${guarded};const z=(e,t)=>t?a[e]:b[e]`).reads.map((r) => [r.name, r.owns]), [["a", true], ["a", false], ["b", true], ["b", false]]);
  // a read by a member key, minified opts.path
  const member = facts(index, `${tables}${guarded}function z(e,n){return n.s?a[n.path]:b[ n.path ]}`).reads;
  assert.deepEqual(member.map((r) => [r.key.trim(), r.owns]), [["e", true], ["n.path", false], ["e", true], ["n.path", false]]);
  assert.equal(verdict(`${tables}${guarded}function z(e,n){return n.s?a[n.path]:b[n.path]}`).ok, false);
  // a member key is never the checked key: a getter can answer the check one name and the read another
  assert.equal(verdict(`${tables}function z(e,n){return typeof n.path==\`string\`&&Object.hasOwn(a,n.path)&&Object.hasOwn(b,n.path)||W(\`${REFUSAL}\`),n.s?a[n.path]:b[n.path]}`).ok, false);
  // the guard without its typeof: a typeof elsewhere in the function, as in the refusal's message, is not the guard's
  assert.equal(verdict(tables + guarded.replace("typeof e==`string`&&", "")).ok, false);
  assert.deepEqual(facts(index, tables + guarded.replace("typeof e==`string`&&", "")).reads.map((r) => [r.owns, r.typed]), [[true, false], [true, false]]);
  // planted (the delta review of c88a3eeb): an unguarded method body after the guarded function, in a class or an object
  // literal: a method head is a function start, so the guard above it is not its own
  for (const m of [`class Zq{m(e,t){return t?a[e]:b[e]}}`, `var Zo={m(e,t){return t?a[e]:b[e]}};`, `var Zo={x:1,get m(){return a[e]}};`, `class Zq{static async m(e){return a[e]}}`]) {
    assert.equal(verdict(`${tables}${guarded}${m}`).ok, false, m);
  }
  // control blocks are not function starts: an if or a for in the guarded function keeps its guard
  assert.equal(verdict(`${tables}function f(e,t){if(typeof e!=="string"||!Object.hasOwn(a,e)||!Object.hasOwn(b,e))W("${REFUSAL}");if(t){return a[e]}for(;;){return b[e]}}`).ok, true);
  // unpaired operators: == must chain with &&, != with || and a negation; either other pairing guards nothing
  assert.equal(verdict(tables + guarded.replace("typeof e==`string`&&", "typeof e==`string`||")).ok, false);
  assert.equal(verdict(tables + guarded.replace("typeof e==`string`&&Object.hasOwn(", "typeof e!=`string`&&Object.hasOwn(")).ok, false);
  assert.equal(verdict(tables + guarded.replace("typeof e==`string`&&Object.hasOwn(", "typeof e!=`string`||Object.hasOwn(")).ok, false);
  assert.equal(verdict(tables + guarded.replace("typeof e==`string`&&", "`string`===typeof e&&")).ok, true);
  // planted (the r3 review of b3a35fa1), read from a real parse: each FAILs
  const GUARD = `typeof e==\`string\`&&Object.hasOwn(a,e)&&Object.hasOwn(b,e)||W(\`request\`,\`${REFUSAL}\`)`;
  const FAILS = {
    private_method: `${guarded}class Zq{#m(e,t){return t?a[e]:b[e]}}`,
    param_with_parentheses: `${guarded}class Zq{m(e,t=Math.max(1,2)){return t?a[e]:b[e]}}`,
    quoted_method_name: `${guarded}var Zo={"m-x"(e,t){return t?a[e]:b[e]}};`,
    computed_method_name: `${guarded}var Zo={[Symbol.iterator](e,t){return t?a[e]:b[e]}};`,
    for_let_shadow: `function f(e,t,n){${GUARD};let r=0;for(let e of t)r+=a[e]+b[e];return r}`,
    key_reassigned: `function f(e,t,n){${GUARD};e=n.path;return t?a[e]:b[e]}`,
    dead_inner_arrow: `function f(e,t,n){const g=()=>${GUARD};return t?a[e]:b[e]}`,
    guard_unused: `function f(e,t,n){typeof e==\`string\`&&Object.hasOwn(a,e)&&Object.hasOwn(b,e);n||W(\`${REFUSAL}\`);return t?a[e]:b[e]}`,
    polarity_and: `function f(e,t,n){return typeof e==\`string\`&&Object.hasOwn(a,e)&&Object.hasOwn(b,e)&&W(\`${REFUSAL}\`),t?a[e]:b[e]}`,
    catch_param_shadow: `function f(e,t,n){${GUARD};try{n()}catch(e){return a[e]+b[e]}return 0}`,
    block_let_shadow: `function f(e,t,n){${GUARD};{let e=n.path;return a[e]+b[e]}}`,
    guard_after_read: `function f(e,t){const r=t?a[e]:b[e];${GUARD};return r}`,
  };
  for (const [name, js] of Object.entries(FAILS)) assert.equal(verdict(tables + js).ok, false, name);
  // planted (the r4 delta review of 15750e7c), read from a real parse: each FAILs (the list names any that PASS)
  const FAILS_R4 = {
    N5_var_redeclares_key: `function f(e,t,n){${GUARD};var e=n.path;return t?a[e]:b[e]}`,
    N6_for_var_of_key: `function f(e,t,n){${GUARD};let r=0;for(var e of t)r+=a[e]+b[e];return r}`,
    N7_second_table_same_name: `${guarded}function Zm(){var a={keyless:1,partner:1};return e=>a[e]}`,
    N8_read_in_default_param: `function f(e,t,n=a[e]+b[e]){${GUARD};return n}`,
    N9_any_hasOwnProperty_call: `function f(e,t,n){return typeof e==\`string\`&&n.hasOwnProperty.call(a,e)&&n.hasOwnProperty.call(b,e)||W(\`${REFUSAL}\`),t?a[e]:b[e]}`,
  };
  assert.deepEqual(Object.keys(FAILS_R4).filter((name) => verdict(tables + FAILS_R4[name]).ok), []);
  // planted (the r5 delta review of 388efb26): Object bound locally, as a parameter, a const in the body or an enclosing
  // arrow's parameter, is not the realm's Object, so its hasOwn or prototype guards nothing: each FAILs
  const OWN = (o) => `typeof e==\`string\`&&${o("a")}&&${o("b")}||W(\`${REFUSAL}\`),t?a[e]:b[e]`;
  const FAILS_R5 = {
    F1_Object_param_hasOwn: `function f(e,t,Object){return ${OWN((T) => `Object.hasOwn(${T},e)`)}}`,
    F2_Object_param_prototype: `function f(e,t,Object){return ${OWN((T) => `Object.prototype.hasOwnProperty.call(${T},e)`)}}`,
    F3_Object_const_in_body: `function f(e,t,n){const Object=n;return ${OWN((T) => `Object.hasOwn(${T},e)`)}}`,
    F4_Object_outer_arrow: `var f=(Object=>function(e,t,n){return ${OWN((T) => `Object.prototype.hasOwnProperty.call(${T},e)`)}})(Zf);`,
  };
  assert.deepEqual(Object.keys(FAILS_R5).filter((name) => verdict(tables + FAILS_R5[name]).ok), []);
  // and correct bundles PASS, the false FAILs of the text scan among them
  const PASSES = {
    typeof_function_between: `function f(e,t,n){${GUARD};return typeof n==\`function\`&&n(),t?a[e]:b[e]}`,
    arrow_between: `function f(e,t,n){${GUARD};return El.some(r=>r===t)?a[e]:b[e]}`,
    ternary_guard: `function f(e,t,n){return typeof e!=\`string\`||!Object.hasOwn(a,e)||!Object.hasOwn(b,e)?W(\`${REFUSAL}\`):t?a[e]:b[e]}`,
    word_function_in_message: `function f(e,t,n){return typeof e==\`string\`&&Object.hasOwn(a,e)&&Object.hasOwn(b,e)||W(\`request\`,\`${REFUSAL} (the fee function)\`),t?a[e]:b[e]}`,
    method_call_then_block: `function f(e,t,n){${GUARD};if(t){Al(e);return a[e]}return b[e]}`,
    split_ifs: `function f(e,t,n){if(typeof e!=\`string\`)W(\`${REFUSAL}\`);if(!Object.hasOwn(a,e)||!Object.hasOwn(b,e))W(\`${REFUSAL}\`);return t?a[e]:b[e]}`,
    guarded_method: `class Zq{m(e,t){${GUARD};return t?a[e]:b[e]}}`,
    prototype_hasOwnProperty_call: `function f(e,t){return typeof e==\`string\`&&Object.prototype.hasOwnProperty.call(a,e)&&Object.prototype.hasOwnProperty.call(b,e)||W(\`${REFUSAL}\`),t?a[e]:b[e]}`,
    empty_literal_hasOwnProperty_call: `function f(e,t){return typeof e==\`string\`&&{}.hasOwnProperty.call(a,e)&&{}.hasOwnProperty.call(b,e)||W(\`${REFUSAL}\`),t?a[e]:b[e]}`,
  };
  for (const [name, js] of Object.entries(PASSES)) assert.equal(verdict(tables + js).ok, true, name);
  // a function of another binding named like the table reads that binding, not the table: no read
  assert.deepEqual(facts(index, `${tables}function z(a,e){return a[e]}`).reads, []);
  // the source's own form passes: typeof path !== "string" || !Object.hasOwn(...)
  assert.equal(verdict(`${tables}function f(e,t){if(typeof e!=="string"||!Object.hasOwn(a,e)||!Object.hasOwn(b,e))W("${REFUSAL}");return t?a[e]:b[e]}`).ok, true);
  // the check in another function, or on another key, or on the other table, guards nothing (an optional-chain read too)
  const apart = `var a=Object.freeze({keyless:1,partner:1}),b=Object.freeze({keyless:20,partner:20});` +
    `function g(e){Object.hasOwn(a,e)&&Object.hasOwn(b,e)||W(\`${REFUSAL}\`)}function f(e,n){return n?a[e]:Object.hasOwn(a,e)&&b[e]}`;
  assert.deepEqual(facts(index, apart).reads.map((r) => [r.name, r.owns]), [["a", false], ["b", false]]);
  assert.deepEqual(facts(index, `${tables}function z(e){return a?.[e]}`).reads.map((r) => [r.key, r.owns]), [["e", false]]);
  // a literal key (a.keyless, a["keyless"]) is not a read by path; x.a[e] is another object's
  assert.deepEqual(facts(index, `var a={keyless:1,partner:1},b={keyless:20,partner:20};x=a.keyless+b["partner"]+o.a[e];`).reads, []);
  // a table with other values is not the pin
  assert.deepEqual(facts(index, `var a={keyless:1,partner:20};`).tables, { ONECLICK_FEE_BPS: [], ONECLICK_PAIR_FEE_BPS: [] });
});

test("the check's tables are the kit's: TABLES equal the kit's ONECLICK_FEE_BPS and ONECLICK_PAIR_FEE_BPS", () => {
  assert.deepEqual({ ...TABLES.ONECLICK_FEE_BPS }, { ...KIT.ONECLICK_FEE_BPS });
  assert.deepEqual({ ...TABLES.ONECLICK_PAIR_FEE_BPS }, { ...KIT.ONECLICK_PAIR_FEE_BPS });
});
