// node --test scripts/live-checks/pool-sell-legs-side-by-side.test.mjs: the live check replays its recorded answers
// (pool-sell-legs-side-by-side.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST as served on 11 Nov
// (a leg's whole sale after its turn, the finder read at the tap): FAIL, each fact named. Planted on the good one:
// another /app.js, no pin, each mark taken away: each FAIL. Planted in the bundle's own excerpt
// (pool-sell-legs-side-by-side.excerpt.txt, cut from this card's public/app.js): the turn not awaited, a sign out not
// checked after it, the tap's spent waits not checked after it, the blockhash read before it, the finder read for every
// sale, the seed read with no W, the seed copy not zeroed, a W no record names left unread, read whatever its record,
// the finder asked for every W, its Ws read one after another, or a W it did not read given no listing (the listing
// pieces re-cut from card wallets-found-in-one-read's build: one list for a sale's first read and its fallback); the sale's reads unshared, shared past 4 s, shared on a failed read, never forgotten after a wait, or naming a W's read;
// the young reads kept at a leg's turn; a sale's wait off the tap's bound, not marking it old, or not ended at a sign
// out; the plan's wait off the bound; an old sale signed, or the plan's wait not making it old; a sale's simulation
// refused while an earlier leg is in flight not priced again, or its cause naming no provider: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./pool-sell-legs-side-by-side.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-sell-legs-side-by-side.answers.json", import.meta.url), "utf8"));
const NO_TURN = "BAD a sale of several wallets reads a later leg's sale only after the leg before it sent: each leg's reads wait out every sale before it";
const NO_LISTED = "BAD a sale reads the finder at the tap: its list of wallets waits on a read the last whole positions pass already made";
const NO_YOUNG = "BAD each leg of a sale asks its market and blockhash again: the legs draw the providers' share with reads that are the same for each";
const NO_FRESH = "BAD a sale signs on a quote read before a wait: its price is not read again, or its waits pass the tap's bound or a sign out";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST as served before this card: FAIL, each fact named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_TURN, NO_LISTED, NO_YOUNG, NO_FRESH]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, turn: false }).lines, [NO_TURN]);
  assert.deepEqual(judge({ ...g, listed: false }).lines, [NO_LISTED]);
  assert.deepEqual(judge({ ...g, young: false }).lines, [NO_YOUNG]);
  assert.deepEqual(judge({ ...g, fresh: false }).lines, [NO_FRESH]);
  assert.equal(judge(null).ok, false);
});

test("planted in the bundle's excerpt: each break in place FAILs", () => {
  const js = readFileSync(new URL("./pool-sell-legs-side-by-side.excerpt.txt", import.meta.url), "utf8");
  const f = facts(A.good.index, js);
  assert.equal(f.turn, true, "the excerpt holds the turn");
  assert.equal(f.listed, true, "the excerpt holds the listing");
  assert.equal(f.young, true, "the excerpt holds the young reads");
  assert.equal(f.fresh, true, "the excerpt holds the new price");
  for (const [what, from, to, key] of [
    ["the turn not awaited", "(await O,e.stopped?.())", "(e.stopped?.())", "turn"],
    ["no sign out checked after the turn", "(await O,e.stopped?.())", "(await O,!1)", "turn"],
    ["the tap's waits not checked after the turn", "if(o.spent?.())return{error:`down`};", "", "turn"],
    ["the young reads kept at the turn (review of 55d4c6eb..dbf63c98, P2-1)", "return{error:`down`};nR(y)}", "return{error:`down`}}", "turn"],
    ["the blockhash read whatever the turn", "if(O){A=", "{A=", "turn"],
    ["the finder for every sale", "let r=t?", "let r=!1?", "listed"],
    ["the seed copy not zeroed", "finally{o.fill(0)}", "finally{}", "listed"],
    ["an unrecorded W never read (review of 55d4c6eb, P2-A)", "o=e=>!Object.hasOwn(t,e)&&r?.has(e)!==!0", "o=e=>!1", "listed"],
    ["every W read through the finder, recorded or not", "!Object.hasOwn(t,e)&&", "", "listed"],
    ["the finder asked for every W, not the unrecorded ones only", "await Be(await u(),i,o)", "await Be(await u(),i)", "listed"],
    ["the seed read with no W", "if(a.length===0)return[];", "", "listed"],
    ["the finder's Ws read one after another (card wallets-found-in-one-read)", "BV(s,i,{together:!0})", "BV(s,i,{})", "listed"],
    ["each W the finder did not read with no listing (card wallets-found-in-one-read)", "c=e=>r?.has(e)?new Map(r.get(e)):null;", "c=e=>null;", "listed"],
    ["the sale's reads unshared", "rpcs:tR(eR(e.rpcs,iR(t.token)),rR(t.token),nU,", "rpcs:(eR(e.rpcs,iR(t.token)),rR(t.token),nU,", "young"],
    ["shared past 4 s", "nU=4e3", "nU=6e4", "young"],
    ["shared at any age", "if(l&&c-l.at<n)return l.read", "if(l)return l.read", "young"],
    ["a failed read kept", "u.catch(()=>{a.get(s)===d&&a.delete(s)})", "u.catch(()=>{})", "young"],
    ["a W's read shared (every getMultipleAccounts)", "t===`getMultipleAccounts`&&Array.isArray(n[0])&&n[0].includes(e)", "t===`getMultipleAccounts`", "young"],
    ["nothing forgotten after a leg's wait", "return{error:`failed`};nR(e.rpcs);continue}", "return{error:`failed`};continue}", "young"],
    ["a sale's wait off the tap's bound", "m=async t=>{if(!i.hold(t))return $(`failed`,`tap_bound`);", "m=async t=>{", "fresh"],
    ["a sale's wait never marking it old", "if(f&&(p=!0),await ZL(", "if(await ZL(", "fresh"],
    ["a sale's wait not ended at a sign out", "await ZL(e.wait,t,e.signal),e.stopped?.()||e.signal?.aborted)return $(`failed`,`stopped`)}", "await ZL(e.wait,t,e.signal),!1)return $(`failed`,`stopped`)}", "fresh"],
    ["the plan's wait off the tap's bound", "u=async e=>{if(!i.hold(e))return $(`failed`,`tap_bound`);", "u=async e=>{", "fresh"],
    ["an old sale signed", "if(p||a?.waited?.())return n.reprice=!0,{error:`failed`};", "", "fresh"],
    ["the plan's wait not making the sale old", "if(p||a?.waited?.())", "if(p)", "fresh"],
    ["an old sale not priced again", "n.reprice&&!e.stopped?.())nR(e.rpcs);", "!1)nR(e.rpcs);", "fresh"],
    ["a simulation refused with an earlier leg in flight not priced again", "return o?.inFlight?.()&&", "return !1&&", "fresh"],
    ["a refused simulation's cause naming no provider", "[`RPC ${", "[`${", "fresh"],
  ]) {
    const bad = js.replace(from, to);
    assert.notEqual(bad, js, what);
    assert.equal(facts(A.good.index, bad)[key], false, what);
  }
});
