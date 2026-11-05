// node --test scripts/live-checks/signpage-withdraw-own-spend.test.mjs: the live check replays its recorded answers
// (signpage-withdraw-own-spend.answers.json). good: this card's build, the paper's seven stores at version 1, owed/<op id>
// a meta key, the reader hiding it: PASS. bad: SIGN_HOST before the deploy, no owed key rule and a reader listing every
// meta key: FAIL. Planted on the good one: another /app.js, no pin, a store past the seven, an open past version 1, no
// owed key rule, a reader listing owed keys, a seed re-read on an owed send's write: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./signpage-withdraw-own-spend.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./signpage-withdraw-own-spend.answers.json", import.meta.url), "utf8"));

test("recorded good answer: seven stores at version 1, owed/<op id> in meta and hidden from the reader: PASS", () => {
  const v = judge(ANSWERS.good);
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
  const js = 'var a=[`notes`,`wallets`,`quotes`,`orders`,`ops`,`counters`,`meta`],k=/^owed\\/[^/]{1,200}$/;function o(e,t){return e.open(t,1)}x.filter(t=>!t.startsWith(`owed/`));m=e=>!(typeof e.key==`string`&&e.key.startsWith(`owed/`));';
  const f = facts('<script src="/app.js" integrity="x"></script>', js);
  assert.equal(f.stores, "[`notes`,`wallets`,`quotes`,`orders`,`ops`,`counters`,`meta`]");
  assert.deepEqual([f.opensV1, f.owedKey, f.readerHidesOwed, f.seedMovedSkipsOwed], [true, true, true, true]);
  assert.equal(facts("", js.replace("e.open(t,1)", "e.open(t,2)")).opensV1, false);
  assert.equal(facts("", js.replace('`owed/`', '"owed/"')).readerHidesOwed, true);
  assert.equal(facts("", js.replace(/x\.filter[^;]*;/, "")).readerHidesOwed, false, "the seed-move test's .key.startsWith is not the reader's");
  assert.equal(facts("", js.replace(/m=e=>.*$/, "")).seedMovedSkipsOwed, false);
  assert.equal(facts("", '["notes","wallets","quotes","orders","ops","counters","meta","owed"]').stores?.includes('"owed"'), true);
});
