// node --test scripts/live-checks/pool-sell-legs-side-by-side.test.mjs: the live check replays its recorded answers
// (pool-sell-legs-side-by-side.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST as served on 11 Nov
// (a leg's whole sale after its turn, the finder read at the tap): FAIL, each fact named. Planted on the good one:
// another /app.js, no pin, each mark taken away: each FAIL. Planted in the bundle's own excerpt
// (pool-sell-legs-side-by-side.excerpt.txt, cut from this card's public/app.js): the turn not awaited, a sign out not
// checked after it, the tap's spent waits not checked after it, the blockhash read before it, the finder read for every
// sale, the seed read with no W, the seed copy not zeroed: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./pool-sell-legs-side-by-side.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-sell-legs-side-by-side.answers.json", import.meta.url), "utf8"));
const NO_TURN = "BAD a sale of several wallets reads a later leg's sale only after the leg before it sent: each leg's reads wait out every sale before it";
const NO_LISTED = "BAD a sale reads the finder at the tap: its list of wallets waits on a read the last whole positions pass already made";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST as served before this card: FAIL, each fact named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_TURN, NO_LISTED]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, turn: false }).lines, [NO_TURN]);
  assert.deepEqual(judge({ ...g, listed: false }).lines, [NO_LISTED]);
  assert.equal(judge(null).ok, false);
});

test("planted in the bundle's excerpt: each break in place FAILs", () => {
  const js = readFileSync(new URL("./pool-sell-legs-side-by-side.excerpt.txt", import.meta.url), "utf8");
  const f = facts(A.good.index, js);
  assert.equal(f.turn, true, "the excerpt holds the turn");
  assert.equal(f.listed, true, "the excerpt holds the listing");
  for (const [what, from, to, key] of [
    ["the turn not awaited", "(await T,e.stopped?.())", "(e.stopped?.())", "turn"],
    ["no sign out checked after the turn", "(await T,e.stopped?.())", "(await T,!1)", "turn"],
    ["the tap's waits not checked after the turn", "if(a.spent?.())return{error:`down`}", "", "turn"],
    ["the blockhash read whatever the turn", "if(T){D=", "{D=", "turn"],
    ["the finder for every sale", "let r=t?", "let r=!1?", "listed"],
    ["the seed copy not zeroed", "finally{i.fill(0)}", "finally{}", "listed"],
    ["the seed read with no W", "if(t.length===0)return a=[];", "", "listed"],
  ]) {
    const bad = js.replace(from, to);
    assert.notEqual(bad, js, what);
    assert.equal(facts(A.good.index, bad)[key], false, what);
  }
});
