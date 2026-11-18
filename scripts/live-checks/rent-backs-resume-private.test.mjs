// node --test scripts/live-checks/rent-backs-resume-private.test.mjs: the live check replays its recorded answers
// (rent-backs-resume-private.answers.json). good: this card's build: PASS. bad: SIGN_HOST as served before this card:
// FAIL, every mark named. Planted on the good one: another /app.js, no pin, each mark taken away: each FAIL; and the good
// build's lines (rent-backs-resume-private.excerpt.txt, cut from its public/app.js) with one rule changed: each FAIL on
// that rule's mark alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, MARKS } from "./rent-backs-resume-private.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./rent-backs-resume-private.answers.json", import.meta.url), "utf8"));
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

const JS = readFileSync(new URL("./rent-backs-resume-private.excerpt.txt", import.meta.url), "utf8");
test("the good build's lines carry every mark; each with its rule changed FAILs on that mark alone", () => {
  assert.deepEqual(Object.values(facts("", JS).carries), Object.keys(MARKS).map(() => true));
  const planted = [
    // the idle stop gone, its ride let go, its amount write counting a pass, or no amount written
    ["if(n.idle===!0){", "if(!1){", 0],
    ["return n.held?.(),d!==null||h===null}", "return d!==null||h===null}", 0],
    ["await e.owed.put({...t,lamports:a.toString()})", "await e.owed.put({...t,lamports:a.toString(),passes:t.passes+1})", 0],
    ["a!==void 0&&t.lamports!==a.toString()&&await e.owed.put({...t,lamports:a.toString()})", "void 0", 0],
    // the schedule: a ride due before the first tap; the tap's run not owed; a later tap moving the time
    ["e()<a&&!(u()&&(l||s()))", "e()<a&&!s()", 1],
    ["e()<a&&!(u()&&(l||s()))", "e()<a&&!(u()&&s())", 1],
    ["c===void 0&&(c=t,l=!0)", "c=t,l=!0", 1],
    ["u=()=>c!==void 0&&e()>=c", "u=()=>!0", 1],
    // the run handed as passing whatever the schedule says
    ["let n=!Sn.acted(),", "let n=!1,", 2],
    ["...n?{idle:!0}:{}", "...{}", 2],
    // the flow books no tap, or every tap at a load's start
    ["Sn.act(t.kind===`pool.buy`||t.kind===`pool.sell`?void 0:u8(Date.now())),", "", 3],
    ["?void 0:u8(Date.now())", "?void 0:void 0", 3],
  ];
  for (const [from, to, i] of planted) {
    assert.ok(JS.includes(from), from);
    const lines = judge({ ...facts("", JS.replace(from, to)), index: `<script type="module" src="/app.js" integrity="${facts("", JS.replace(from, to)).sha384}"></script>` }).lines;
    assert.deepEqual(lines, [ALL[i]], `${from} -> ${to}`);
  }
});
