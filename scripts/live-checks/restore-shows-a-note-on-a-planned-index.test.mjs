// node --test scripts/live-checks/restore-shows-a-note-on-a-planned-index.test.mjs: the live check replays its recorded
// answers (restore-shows-a-note-on-a-planned-index.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST
// as served before the card: FAIL. Planted on the good one: another /app.js, no pin, each mark taken away: each FAIL.
// Planted in a bundle: the refusal gone, a quoted index taken, a host that marks after its ask or not at all, a mark
// handed to fewer hosts, a take that skips the quoted check: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./restore-shows-a-note-on-a-planned-index.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./restore-shows-a-note-on-a-planned-index.answers.json", import.meta.url), "utf8"));
const NO_STORE = "BAD the note store can mark a quoted deposit index TAKEN: an address the user was shown can go dead";
const NO_MARKS = "BAD an address or a quote leaves before its index is marked quoted: a restore can mark it dead";
const NO_TAKE = "BAD restore step 5 leaves an index whose id reads used PLANNED unread: the page names a used id again";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST before the card: FAIL, each path named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_STORE, NO_MARKS, NO_TAKE]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, store: false }).lines, [NO_STORE]);
  assert.deepEqual(judge({ ...g, marks: false }).lines, [NO_MARKS]);
  assert.deepEqual(judge({ ...g, take: false }).lines, [NO_TAKE]);
});

test("planted in a bundle: each mark broken in place FAILs", () => {
  const js = [
    "if(r===`TAKEN`&&s.ref.kind===`deposit`&&VN(await e.get(`meta`,`owed/quoted-deposits`)).has(tP(s.ref)))throw Error(`quoted`)",
    "takeUnquoted(t,n){return ZN(t,`scope`),QN(n,`deposit index`),a(async()=>{let r=tP({kind:`deposit`,s:t,i:n}),i=(await f()).find(e=>tP(e.ref)===r);return i===void 0||i.state!==`PLANNED`||VN(await e.get(`meta`,`owed/quoted-deposits`)).has(r)?i:1})}",
    "if(!s)return;if(await e.quoted(o,s.deposit.index),a())return void(r={error:`not_allowed`});let c=e.refund===void 0?null:1",
    "if(!u)return;if(await e.quoted(s.scope,u.record.index),a())return void(r={error:`not_allowed`});if(!l)return void(r={result:{chain:o,address:u.wallet,asset:1}})",
    "p=(e,t)=>navigator.locks.request($a,{mode:`shared`},async()=>{let n=await MP(await y9());try{await n.markQuoted(e,t)}finally{n.close()}})",
    "m=CN({scope:M9,quoted:p,x:1}),k=sV({pools:P9,quoted:p,x:1}),q={a:CN({quoted:p,y:1}),b:sV({quoted:p})}",
    "h=(e,t)=>async(n,r)=>{let i=await t(n,r);return i===`used`&&r!==void 0&&await s.take(e,r),i}",
    "take:(t,n)=>y(async()=>{let r=await MP(await e.store());try{await r.takeUnquoted(t,n)}finally{r.close()}})",
  ].join(";");
  const at = (s) => facts("", s);
  assert.deepEqual([at(js).store, at(js).marks, at(js).take], [true, true, true]);
  assert.equal(at(js.replace("if(r===`TAKEN`&&s.ref.kind===`deposit`&&VN(await e.get(`meta`,`owed/quoted-deposits`)).has(tP(s.ref)))throw", "if(0)throw")).store, false, "the move refuses nothing");
  assert.equal(at(js.replace("||VN(await e.get(`meta`,`owed/quoted-deposits`)).has(r)?i:1", "?i:1")).store, false, "a take that skips the quoted check");
  assert.equal(at(js.replace("if(await e.quoted(o,s.deposit.index),a())return void(r={error:`not_allowed`});", "")).marks, false, "deposit.quote marks nothing");
  assert.equal(at(js.replace("if(await e.quoted(s.scope,u.record.index),a())return void(r={error:`not_allowed`});", "")).marks, false, "pool.address marks nothing");
  assert.equal(at(js.replace("b:sV({quoted:p})", "b:sV({})")).marks, false, "a host handed no mark");
  assert.equal(at(js.replace("{mode:`shared`}", "{mode:`exclusive`}")).marks, false, "a mark outside the seed lock's shared hold");
  assert.equal(at(js.replace("&&await s.take(e,r)", "")).take, false, "a used id taken by nothing");
  assert.equal(at(js.replace("await r.takeUnquoted(t,n)", "await r.move(t,`PLANNED`,`TAKEN`)")).take, false, "a take past the quoted check");
});
