// node --test scripts/live-checks/signpage-withdraw-own-spend.test.mjs: the live check replays its recorded answers
// (signpage-withdraw-own-spend.answers.json). good: SIGN_HOST's release-73, read live, the paper's seven stores at
// version 1, owed/<op id> a meta key, the reader hiding it: PASS; goodBefore, the build before it: PASS. bad: SIGN_HOST
// before the deploy, no owed key rule and a reader listing every meta key: FAIL. Planted on the good one: another
// /app.js, no pin, a store past the seven, an open past version 1, no owed key rule, a reader listing owed keys, a seed
// re-read on an owed send's write: each FAIL. readers: the reader's text of release-73's bundle (!(a||b)) and of
// 358d8f4f's (!a&&!b) both read as hiding owed/ keys (card signpage-check-shapes-on-build), and a reader that lists
// them, planted in each shape, does not.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, readerFilter } from "./signpage-withdraw-own-spend.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./signpage-withdraw-own-spend.answers.json", import.meta.url), "utf8"));

test("recorded good answer: seven stores at version 1, owed/<op id> in meta and hidden from the reader: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("recorded good answer from before release-73: PASS", () => {
  const v = judge(ANSWERS.goodBefore);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST before the deploy: FAIL, its three missing facts named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.equal(v.lines.length, 3, v.lines.join("\n"));
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.ok(judge({ ...g, sha384: "sha384-other" }).lines.includes("BAD SIGN_HOST's served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD SIGN_HOST's index.html pins no /app.js"));
  for (const k of ["opensV1", "owedKey", "readerHidesOwed", "seedMovedSkipsOwed"]) assert.equal(judge({ ...g, [k]: false }).ok, false, k);
  assert.equal(judge({ ...g, stores: null }).ok, false);
  assert.equal(judge({ ...g, stores: g.stores.replace(/\]$/, ",`owed`]") }).ok, false, "a store past the seven");
});

test("the facts read from a bundle, quoted either way", () => {
  const reader = "the reader opens meta/status, meta/deposit/<scope> and ops only, not ${e}/${t}`)},async keys(e){return(await F(o().getAllKeys())).map(String).filter(t=>!(e===`meta`&&(t===jo||t.startsWith(`owed/`))))},close:a}";
  const js = `var a=[\`notes\`,\`wallets\`,\`quotes\`,\`orders\`,\`ops\`,\`counters\`,\`meta\`],k=/^owed\\/[^/]{1,200}$/;function o(e,t){return e.open(t,1)}${reader};m=e=>!(typeof e.key==\`string\`&&e.key.startsWith(\`owed/\`));`;
  const f = facts('<script src="/app.js" integrity="x"></script>', js);
  assert.equal(f.stores, "[`notes`,`wallets`,`quotes`,`orders`,`ops`,`counters`,`meta`]");
  assert.deepEqual([f.opensV1, f.owedKey, f.readerHidesOwed, f.seedMovedSkipsOwed], [true, true, true, true]);
  assert.equal(facts("", js.replace("e.open(t,1)", "e.open(t,2)")).opensV1, false);
  assert.equal(facts("", js.replaceAll("`owed/`", '"owed/"')).readerHidesOwed, true);
  assert.equal(facts("", js.replace("the reader opens", "the store opens")).readerHidesOwed, false, "no reader found: not read as hiding");
  assert.equal(facts("", js.replace(/m=e=>.*$/, "")).seedMovedSkipsOwed, false);
  assert.equal(facts("", '["notes","wallets","quotes","orders","ops","counters","meta","owed"]').stores?.includes('"owed"'), true);
});

test("the reader's filter in both minified shapes: release-73's !(a||b) and 358d8f4f's !a&&!b hide owed/ keys", () => {
  for (const [name, text] of Object.entries(ANSWERS.readers)) {
    assert.equal(facts("", text).readerHidesOwed, true, name);
  }
  assert.match(readerFilter(ANSWERS.readers["release-73"]).body, /^!\(e===`meta`&&\(/);
  assert.match(readerFilter(ANSWERS.readers["358d8f4f"]).body, /^e!==`meta`\|\|/);
});

test("planted readers that list owed/ keys, in each shape: not read as hiding them", () => {
  const r73 = ANSWERS.readers["release-73"];
  const old = ANSWERS.readers["358d8f4f"];
  const lists = [
    ["!(a||b) without owed/", r73.replace("||t.startsWith(`owed/`)", "")],
    ["!a&&!b without owed/", old.replace("&&!t.startsWith(`owed/`)", "")],
    ["!(a||b) with owed/ kept, not hidden", r73.replace("t.startsWith(`owed/`)", "!t.startsWith(`owed/`)")],
    ["!a&&!b with owed/ un-negated", old.replace("!t.startsWith(`owed/`)", "t.startsWith(`owed/`)")],
    ["!(a||b) hiding owed/ outside meta only", r73.replace("e===`meta`", "e!==`meta`")],
    ["!a&&!b behind ||!0", old.replace("filter(t=>e!==`meta`||", "filter(t=>!0||e!==`meta`||")],
    ["a ternary that lists owed/", r73.replace(/filter\(t=>[^]*\)\},close/, "filter(t=>e===`meta`?t!==jo:!0)},close")],
    ["a filter that lists nothing", r73.replace(/filter\(t=>[^]*\)\},close/, "filter(t=>!1)},close")],
    ["a form the check does not read", r73.replace("t.startsWith(`owed/`)", "/^owed\\//.test(t)")],
  ];
  for (const [name, text] of lists) assert.equal(facts("", text).readerHidesOwed, false, name);
  assert.equal(facts("", r73.replace(/filter\(t=>[^]*\)\},close/, "filter(t=>e===`meta`?!t.startsWith(`owed/`):!0)},close")).readerHidesOwed, true, "a ternary that hides owed/");
});
