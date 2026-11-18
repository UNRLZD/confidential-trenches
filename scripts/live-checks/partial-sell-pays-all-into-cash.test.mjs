// node --test scripts/live-checks/partial-sell-pays-all-into-cash.test.mjs: the live check replays its recorded answers
// (partial-sell-pays-all-into-cash.answers.json). good: this card's build: PASS. bad: SIGN_HOST as served before this
// card (main 22cc5238a's line): FAIL, every mark named. liveBefore: SIGN_HOST before card
// pool-amounts-are-standard-sizes (its keep sweep's note on the grid, off the ladder): FAIL on that rule alone. Planted on the good one: another /app.js, no pin, each mark taken
// away: each FAIL; and the good build's lines (partial-sell-pays-all-into-cash.excerpt.txt, cut from its app.js) with
// one rule changed: each FAIL on that rule's mark alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, MARKS } from "./partial-sell-pays-all-into-cash.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./partial-sell-pays-all-into-cash.answers.json", import.meta.url), "utf8"));
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

test("recorded answer liveBefore (SIGN_HOST before card pool-amounts-are-standard-sizes, the keep sweep's note on the grid): FAIL on the keep sweep's rule alone", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [ALL[2]]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const [i, k] of Object.keys(MARKS).entries()) assert.deepEqual(judge({ ...g, carries: { ...g.carries, [k]: false } }).lines, [ALL[i]]);
  assert.equal(judge(null).ok, false);
});

const JS = readFileSync(new URL("./partial-sell-pays-all-into-cash.excerpt.txt", import.meta.url), "utf8");
test("the good build's lines carry every mark; each with its rule changed FAILs on that mark alone", () => {
  assert.deepEqual(Object.values(facts("", JS).carries), Object.keys(MARKS).map(() => true));
  const planted = [
    // a partial fill runs no keep sweep (the bug): the rent back only on a full sell, on one verdict path
    ["t===`filled`&&(n.back=ge?Je:Ye)", "t===`filled`&&!ge&&(n.back=Ye)", 0],
    // the keep sweep keeps nothing for W's next sale, or sweeps under the floor, or is checked with no hold
    ["-aF(i,f,y.held)-t.keep,", "-aF(i,f,y.held),", 1],
    ["if(x<S)return a(`floor`", "if(x<0n)return a(`floor`", 1],
    ["y.held,t.keep);", "y.held,0n);", 1],
    // the keep sweep's rule (card pool-amounts-are-standard-sizes): a transfer beside the deposit, a smaller rung than
    // the largest, no hold, a value off the ladder, the note a grid note again
    ["if(c.ixs.length!==1)return $(`instructions`);let l=", "let l=", 2],
    ["l===JP(r-5000n-aF(i,n,a)-o)?", "l<=JP(r-5000n-aF(i,n,a)-o)?", 2],
    ["l===JP(r-5000n-aF(i,n,a)-o)?", "l===JP(r-5000n-aF(i,n,a))?", 2],
    ["!jD(qP,l)||", "", 2],
    ["let n=t<e.floor?0n:wD(e.ladder,t)[0]??0n;", "let n=t<e.floor?0n:t-t%e.grid;", 2],
    // the preview counts the deposit back alone, the sweep's note left out
    ["return{out:o+c(i),minOut:o+c(a)", "return{out:o,minOut:o", 3],
  ];
  for (const [from, to, i] of planted) {
    assert.ok(JS.includes(from), from);
    const v = judge(facts("", JS.replaceAll(from, to)));
    assert.ok(v.lines.includes(ALL[i]), `${from} -> ${to}: ${v.lines.join("; ")}`);
    assert.deepEqual(v.lines.filter((l) => l.startsWith("BAD the served bundle")), [ALL[i]], `${from} -> ${to}`);
  }
});

// card second-places-held-by-tests: the choice made once (pool-sell.ts onFill) and taken by both verdict paths, as the
// build at b441f3d3b minifies it (the keep sweep and the rent back inlined into the choice); the old shape above passes too
const ONCE = "let Ge=[{chain:`solana`,hash:Be}],Ke=ge+_e,qe=he?t=>wK(t,r.address,!1,m,async()=>UG(e)):t=>wK(t,r.address,!1,m,async n=>void await zG(e,n));e.kept?.drop(Be).catch(()=>{}),t===`filled`&&(n.back=qe),{stage:t,txs:Ge};l===`dropped`&&(n.rebuild=!0),l===`filled`&&(n.back=qe),l!==`pending`";
test("the choice made once and taken by both verdict paths carries the mark; one path without it, two names, or no choice FAILs", () => {
  const mark = MARKS[Object.keys(MARKS)[0]];
  assert.equal(mark.test(ONCE), true);
  for (const [from, to] of [
    ["l===`filled`&&(n.back=qe)", "l===`filled`&&!1"], // the note-settled path runs nothing after a fill
    ["l===`filled`&&(n.back=qe)", "l===`filled`&&(n.back=Ye)"], // the two paths take different after-runs
    ["qe=he?t=>wK(t,r.address,!1,m,async()=>UG(e)):", "qe="], // no choice: the rent back whatever W still holds
  ]) {
    assert.ok(ONCE.includes(from), from);
    assert.equal(mark.test(ONCE.replace(from, to)), false, `${from} -> ${to}`);
  }
});
