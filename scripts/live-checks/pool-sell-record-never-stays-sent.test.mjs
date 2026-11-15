// node --test scripts/live-checks/pool-sell-record-never-stays-sent.test.mjs: the live check replays its recorded answers
// (pool-sell-record-never-stays-sent.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST as served on
// 15 Nov 15:35Z (origin/main 23eab91ab's bundle, the same sha384): FAIL, each fact named. Planted on the good one: another
// /app.js, no pin, each mark taken away: each FAIL. Planted in the bundle's own excerpt
// (pool-sell-record-never-stays-sent.excerpt.txt, cut from this card's public/app.js): the rebuilt leg left on its
// signature, its write not awaited, the hook not passed on or not called before the rebuilt attempt; the dead settle
// behind a once-a-load flag, after the settles that wait, or on no settle at all; a rent back's sleep not stopped after
// its wait, its try not stopped before the step, a step's sign out read as a fault, W's key derived after a sign out, a
// resumed list's wait not cut by the signal, or the list not stopped: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./pool-sell-record-never-stays-sent.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-sell-record-never-stays-sent.answers.json", import.meta.url), "utf8"));
const NO_REBUILT = "BAD a sale built again after WrongAccount keeps its leg sent on the failed signature: a page closed before the rebuilt sale signs leaves the record sent for good";
const NO_EVERY = "BAD the dead sell records are settled once a load: a record another tab left when it died stays open until a reload";
const NO_STOPS = "BAD a rent back runs on past a sign out: its throttle waits are not cut, or it reads or signs after it";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST as served before this card: FAIL, each fact named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_REBUILT, NO_EVERY, NO_STOPS]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = A.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, rebuilt: false }).lines, [NO_REBUILT]);
  assert.deepEqual(judge({ ...g, everyRead: false }).lines, [NO_EVERY]);
  assert.deepEqual(judge({ ...g, stops: false }).lines, [NO_STOPS]);
  assert.equal(judge(null).ok, false);
});

test("planted in the bundle's excerpt: each break in place FAILs", () => {
  const js = readFileSync(new URL("./pool-sell-record-never-stays-sent.excerpt.txt", import.meta.url), "utf8");
  const f = facts(A.good.index, js);
  assert.equal(f.rebuilt, true, "the excerpt holds the rebuilt leg");
  assert.equal(f.everyRead, true, "the excerpt holds the dead settle at every read");
  assert.equal(f.stops, true, "the excerpt holds the rent back's stop");
  for (const [what, from, to, key] of [
    ["the rebuilt leg left on its signature", "x(e,{tx:null,stage:`pending`})", "x(e,{stage:`sent`})", "rebuilt"],
    ["the rebuilt leg's write not awaited", "m.txs=b(),await f.put(", "m.txs=b(),f.put(", "rebuilt"],
    ["the record's earlier writes not awaited first", "rebuilt:async e=>{await h,", "rebuilt:async e=>{", "rebuilt"],
    ["the leg's host not passing the hook on", "rebuilt:async()=>{await r.rebuilt?.(a),await o.rebuilt?.()}", "rebuilt:async()=>{await o.rebuilt?.()}", "rebuilt"],
    ["the hook not called before the rebuilt attempt", "return c;await e.rebuilt?.(),YL(e.rpcs),s++}", "return c;YL(e.rpcs),s++}", "rebuilt"],
    ["the dead settle once a load, behind a flag", "Sn&&await wB(e.store(),CB,`the wallet store`).then(e=>MW(TB(e,CB),Sn)).catch(()=>{}),Pt)", "Sn&&!Dn&&(await MW(await e.store(),Sn),Dn=!0),Pt)", "everyRead"],
    ["the dead settle's store unbounded", ".then(e=>MW(TB(e,CB),Sn))", ".then(e=>MW(e,Sn))", "everyRead"],
    ["the dead settle's failure not swallowed", ".then(e=>MW(TB(e,CB),Sn)).catch(()=>{}),Pt)", ".then(e=>MW(TB(e,CB),Sn)),Pt)", "everyRead"],
    ["a settle that reads no lock (a live request settled as dead)", "let r=new Set(((await t.query()).held??[])", "let r=new Set(([])", "everyRead"],
    ["the once flag kept beside the read's settle", "SW=Error(", "Sn&&!Dn&&(await MW(await e.store(),Sn),Dn=!0);SW=Error(", "everyRead"],
    ["a rent back's sleep not stopped after its wait", "else if(!await n.nap(e))throw bW;if(r())throw SW}", "else if(!await n.nap(e))throw bW}", "stops"],
    ["a rent back's sleep not stopped before its wait", "f=async e=>{if(r())throw SW;if(!n)", "f=async e=>{if(!n)", "stops"],
    ["a try's step run after a sign out", "FL.firstMs),r())throw SW;try{", "FL.firstMs),!1)throw SW;try{", "stops"],
    ["a step's sign out read as a fault to try again", "if(t===bW||t===xW||t===SW)throw t;", "if(t===bW||t===xW)throw t;", "stops"],
    ["W's key derived after a sign out", "o=async()=>{if(r())throw SW;let e=", "o=async()=>{let e=", "stops"],
    ["the rent back's sign out off the host's signal", "e.stopped?.()===!0||e.signal?.aborted===!0,i=[]", "e.stopped?.()===!0,i=[]", "stops"],
    ["a resumed list's wait not cut by the signal", "c=t=>GL(e.wait,t,e.signal)", "c=t=>e.wait(t)", "stops"],
    ["a resumed list not stopped at the sign out", "for(let d of v){if(l())return!0;", "for(let d of v){", "stops"],
    ["the wait that ignores an aborted signal", "return n?.aborted?Promise.resolve():new Promise(", "return new Promise(", "stops"],
  ]) {
    assert.ok(js.includes(from), `${what}: the excerpt holds ${from}`);
    const g = facts(A.good.index, js.replace(from, to));
    assert.equal(g[key], false, what);
  }
});
