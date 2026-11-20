// node --test scripts/live-checks/evm-load-reads-name-no-w-to-the-public-seat.test.mjs: the live check replays its
// recorded answers (evm-load-reads-name-no-w-to-the-public-seat.answers.json). good: this card's build: PASS. bad:
// SIGN_HOST as served before this card: FAIL, every mark named. Planted on the good one: another /app.js, no pin, each
// mark taken away: each FAIL; and the good build's lines (evm-load-reads-name-no-w-to-the-public-seat.excerpt.txt, cut
// from its public/app.js) with one rule changed: each FAIL on that rule's mark alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, MARKS } from "./evm-load-reads-name-no-w-to-the-public-seat.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./evm-load-reads-name-no-w-to-the-public-seat.answers.json", import.meta.url), "utf8"));
const ALL = Object.keys(MARKS).map((k) => `BAD the served bundle has no ${k}`);

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer (SIGN_HOST before this card): FAIL, every mark named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const [i, k] of Object.keys(MARKS).entries()) assert.deepEqual(judge({ ...g, carries: { ...g.carries, [k]: false } }).lines, [ALL[i]]);
  assert.equal(judge(null).ok, false);
});

const JS = readFileSync(new URL("./evm-load-reads-name-no-w-to-the-public-seat.excerpt.txt", import.meta.url), "utf8");
test("the good build's lines carry every mark; each with its rule changed FAILs on that mark alone", () => {
  assert.deepEqual(Object.values(facts("", JS).carries), Object.keys(MARKS).map(() => true));
  const planted = [
    // the state read's pass never idle, or idle whatever the tap; the flag not handed to the pass
    ["Fe(e,!Cn.acted());", "Fe(e);", 0],
    ["Fe(e,!Cn.acted());", "Fe(e,!1);", 0],
    ["...i?{idle:o}:{}})", "})", 0],
    // the idle return after a W is drawn, gone, or its balance read on the pool's RPCs
    ["if(e.idle!==void 0)return await Vhe(e,e.idle,f);", "", 1],
    ["await t(`eth_getBalance`,[i.w,`latest`],e.signal)", "await e.rpcs[0](`eth_getBalance`,[i.w,`latest`],e.signal)", 1],
    // no row, another state, or the page never asks for the reads
    ["state:`RETURNING`", "state:`READY`", 2],
    ["Tme(f7.evmReturning(),e=>i.get(e))", "Tme([],e=>i.get(e))", 2],
    ["evmReturning:()=>[...Pe.values()]", "evmReturning:()=>[]", 2],
  ];
  for (const [from, to, i] of planted) {
    assert.ok(JS.includes(from), from);
    const js = JS.replace(from, to);
    const lines = judge({ ...facts("", js), index: `<script type="module" src="/app.js" integrity="${facts("", js).sha384}"></script>` }).lines;
    assert.deepEqual(lines, [ALL[i]], `${from} -> ${to}`);
  }
});
