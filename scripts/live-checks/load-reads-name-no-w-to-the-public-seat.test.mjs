// node --test scripts/live-checks/load-reads-name-no-w-to-the-public-seat.test.mjs: the live check replays its recorded
// answers (load-reads-name-no-w-to-the-public-seat.answers.json). good: this card's build: PASS. bad: SIGN_HOST as served
// before this card: FAIL, every mark named. Planted on the good one: another /app.js, no pin, each mark taken away: each
// FAIL; and the good build's lines (load-reads-name-no-w-to-the-public-seat.excerpt.txt, cut from its public/app.js) with
// one rule changed: each FAIL on that rule's mark.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, MARKS } from "./load-reads-name-no-w-to-the-public-seat.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./load-reads-name-no-w-to-the-public-seat.answers.json", import.meta.url), "utf8"));
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

const JS = readFileSync(new URL("./load-reads-name-no-w-to-the-public-seat.excerpt.txt", import.meta.url), "utf8");
test("the good build's lines carry every mark; each with its rule changed FAILs on that rule's marks", () => {
  assert.deepEqual(Object.values(facts("", JS).carries), Object.keys(MARKS).map(() => true));
  const planted = [
    // the owner on the pair whatever the tap, or on the public seat alone before it: the first two marks
    ["n=Sn.acted(),r=n?t:[t[1]],", "n=!0,r=n?t:[t[1]],", [0, 1]],
    ["r=n?t:[t[1]],", "r=n?t:[t[0]],", [0, 1]],
    // one seat's mine taken as mine, or its other not taken
    [":n?`mine`:null}", ":`mine`}", [1]],
    ["u===`other`?`other`:n?`mine`:null", "u===`other`&&n?`other`:n?`mine`:null", [1]],
    // the one-seat read on the public seat
    [":await sH(t[1],c,", ":await sH(t[0],c,", [1]],
    // the core taking one seat's spend for the pair's, two that differ, or the one-seat entry another rule
    ["if(!u||l.some(e=>!e))return null;", "if(!u)return null;", [2]],
    ["if(l.some(e=>e.sig!==u.sig||e.mine!==u.mine))", "if(!1)", [2]],
    ["return cH([e],t,n,r,i,a,void 0,o)", "return cH([e,e],t,n,r,i,a,void 0,o)", [2]],
    ["return cH(e,t,n,r,i,a,o,s)", "return cH([e[1]],t,n,r,i,a,o,s)", [2]],
    // the scan on the public seat, or one W a request
    ["await nye(o,i(`pass`)[1])", "await nye(o,i(`pass`)[0])", [3]],
    ["for(let i=0;i<e.length;i+=100){", "for(let i=0;i<e.length;i+=1){", [3]],
  ];
  for (const [from, to, marks] of planted) {
    assert.ok(JS.includes(from), from);
    const js = JS.replace(from, to);
    const lines = judge({ ...facts("", js), index: `<script type="module" src="/app.js" integrity="${facts("", js).sha384}"></script>` }).lines;
    assert.deepEqual(lines, marks.map((i) => ALL[i]), `${from} -> ${to}`);
  }
});
