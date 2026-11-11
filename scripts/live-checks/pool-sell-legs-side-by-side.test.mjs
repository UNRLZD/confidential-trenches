// node --test scripts/live-checks/pool-sell-legs-side-by-side.test.mjs: the live check replays its recorded answers
// (pool-sell-legs-side-by-side.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST as served on 11 Nov
// (a leg's whole sale after its turn, the finder read at the tap): FAIL, each fact named. Planted on the good one:
// another /app.js, no pin, each mark taken away: each FAIL. Planted in the bundle's own excerpt
// (pool-sell-legs-side-by-side.excerpt.txt, cut from this card's public/app.js): the turn not awaited, a sign out not
// checked after it, the tap's spent waits not checked after it, the blockhash read before it, the finder read for every
// sale, the seed read with no W, the seed copy not zeroed, a W no record names left unread, read whatever its record,
// or the finder asked for every W; the sale's reads unshared, shared past 4 s, shared on a failed read, never forgotten after a wait, or naming a W's read: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./pool-sell-legs-side-by-side.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-sell-legs-side-by-side.answers.json", import.meta.url), "utf8"));
const NO_TURN = "BAD a sale of several wallets reads a later leg's sale only after the leg before it sent: each leg's reads wait out every sale before it";
const NO_LISTED = "BAD a sale reads the finder at the tap: its list of wallets waits on a read the last whole positions pass already made";
const NO_YOUNG = "BAD each leg of a sale asks its market and blockhash again: the legs draw the providers' share with reads that are the same for each";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST as served before this card: FAIL, each fact named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_TURN, NO_LISTED, NO_YOUNG]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, turn: false }).lines, [NO_TURN]);
  assert.deepEqual(judge({ ...g, listed: false }).lines, [NO_LISTED]);
  assert.deepEqual(judge({ ...g, young: false }).lines, [NO_YOUNG]);
  assert.equal(judge(null).ok, false);
});

test("planted in the bundle's excerpt: each break in place FAILs", () => {
  const js = readFileSync(new URL("./pool-sell-legs-side-by-side.excerpt.txt", import.meta.url), "utf8");
  const f = facts(A.good.index, js);
  assert.equal(f.turn, true, "the excerpt holds the turn");
  assert.equal(f.listed, true, "the excerpt holds the listing");
  assert.equal(f.young, true, "the excerpt holds the young reads");
  for (const [what, from, to, key] of [
    ["the turn not awaited", "(await T,e.stopped?.())", "(e.stopped?.())", "turn"],
    ["no sign out checked after the turn", "(await T,e.stopped?.())", "(await T,!1)", "turn"],
    ["the tap's waits not checked after the turn", "if(a.spent?.())return{error:`down`}", "", "turn"],
    ["the blockhash read whatever the turn", "if(T){D=", "{D=", "turn"],
    ["the finder for every sale", "let r=t?", "let r=!1?", "listed"],
    ["the seed copy not zeroed", "finally{s.fill(0)}", "finally{}", "listed"],
    ["an unrecorded W never read (review of 55d4c6eb, P2-A)", "l.failed.length===0&&u.size>0&&(d=", "!1&&(d=", "listed"],
    ["every W read through the finder, recorded or not", "!Object.hasOwn(o,e)&&!r.has(e)", "!0", "listed"],
    ["the finder asked for every W, not the unrecorded ones only", "{only:u,together:!0}", "{together:!0}", "listed"],
    ["the seed read with no W", "if(t.length===0)return a=[];", "", "listed"],
    ["the sale's reads unshared", "rpcs:nR(tR(e.rpcs,aR(t.token)),iR(t.token),rU,", "rpcs:(tR(e.rpcs,aR(t.token)),iR(t.token),rU,", "young"],
    ["shared past 4 s", "rU=4e3", "rU=6e4", "young"],
    ["shared at any age", "if(l&&c-l.at<n)return l.read", "if(l)return l.read", "young"],
    ["a failed read kept", "u.catch(()=>{a.get(s)===d&&a.delete(s)})", "u.catch(()=>{})", "young"],
    ["a W's read shared (every getMultipleAccounts)", "t===`getMultipleAccounts`&&Array.isArray(n[0])&&n[0].includes(e)", "t===`getMultipleAccounts`", "young"],
    ["nothing forgotten after a wait", "rR(e.rpcs),e.stopped", "e.stopped", "young"],
  ]) {
    const bad = js.replace(from, to);
    assert.notEqual(bad, js, what);
    assert.equal(facts(A.good.index, bad)[key], false, what);
  }
});
