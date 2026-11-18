// node --test scripts/live-checks/restore-shows-a-note-on-a-planned-index.test.mjs: the live check replays its recorded
// answers (restore-shows-a-note-on-a-planned-index.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST
// as served before the card: FAIL. Planted on the good one: another /app.js, no pin, each fact taken away: each FAIL.
// Planted in a bundle: the refusal gone, a skip that writes TAKEN or skips a quoted index, a plan that names a skipped
// index, a host that marks after its ask or not at all, a mark handed to fewer hosts, a step 5 read (the vault's) past
// the skipping reader, a used id skipped by nothing, a skip that opens the seed for an index with no PLANNED note: each
// FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./restore-shows-a-note-on-a-planned-index.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./restore-shows-a-note-on-a-planned-index.answers.json", import.meta.url), "utf8"));
const NO_STORE = "BAD the note store can mark a deposit index TAKEN on a restore's read, or names an index read used again: an address can go dead or be reused";
const NO_MARKS = "BAD an address or a quote leaves before its index is marked quoted: a restore can mark it dead";
const NO_SKIP = "BAD restore step 5 does not skip an index whose id reads used on every path (the pools' and the vault's): the page names a used id again";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST before the card: FAIL, each path named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_STORE, NO_MARKS, NO_SKIP]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, store: false }).lines, [NO_STORE]);
  assert.deepEqual(judge({ ...g, marks: false }).lines, [NO_MARKS]);
  assert.deepEqual(judge({ ...g, skip: false }).lines, [NO_SKIP]);
  assert.deepEqual(judge({ ...g, skip: undefined, take: true }).lines, [NO_SKIP], "the old take is not a skip");
});

test("planted in a bundle: each rule broken in place FAILs", () => {
  const js = [
    "if(r===`TAKEN`&&s.ref.kind===`deposit`&&jN(await e.get(`meta`,`owed/quoted-deposits`)).has(qN(s.ref)))throw Error(`quoted`)",
    "var MN=`owed/skipped-deposits`,NN=jN",
    "skipUsed(t,n){return UN(t,`scope`),WN(n,`deposit index`),a(async()=>{let r=qN({kind:`deposit`,s:t,i:n}),a=(await f()).find(e=>qN(e.ref)===r);if(a===void 0||a.state!==`PLANNED`||jN(await e.get(`meta`,`owed/quoted-deposits`)).has(r)||ON(await e.get(`meta`,`owed/found-deposits`)).has(r)||NN(await e.get(`meta`,`owed/skipped-deposits`)).has(r))return a;if(i)throw Error(`the note store is closed`);return await e.update(`meta`,MN,e=>Object.fromEntries([...NN(e),r].map(e=>[e,!0]))),await u(a),a})}",
    "planDeposit(t,n){return UN(t,`scope`),a(async()=>{let r=await f(),i=ON(await e.get(`meta`,DN)),a=NN(await e.get(`meta`,MN)),o=r.filter(e=>e.ref.kind===`deposit`&&e.scope===t&&e.state===`PLANNED`&&!i.has(qN(e.ref))&&!a.has(qN(e.ref)));return o})}",
    "if(!s)return;if(await e.quoted(o,s.deposit.index),a())return void(r={error:`not_allowed`});let c=e.refund===void 0?null:1",
    "if(!u)return;if(await e.quoted(s.scope,u.record.index),a())return void(r={error:`not_allowed`});if(!l)return void(r={result:{chain:o,address:u.wallet,asset:1}})",
    "p=(e,t)=>navigator.locks.request($a,{mode:`shared`},async()=>{let n=await MP(await y9());try{await n.markQuoted(e,t)}finally{n.close()}})",
    "m=CN({scope:M9,quoted:p,x:1}),k=sV({pools:P9,quoted:p,x:1}),q={a:CN({quoted:p,y:1}),b:sV({quoted:p})}",
    "var B5=(e,t,n)=>async(r,i)=>{let a=await n(r,i);return a===`used`&&i!==void 0&&await e.skip(t,i),a}",
    "x=await G(c,r.scope,{},B5(s,r.scope,h),1),y=await G(c,r.scope,{},B5(s,r.scope,f),1),z=await G(c,t.scope,{},B5(o,t.scope,m),{first:o.lane})",
    "skip:async(t,n)=>{let r=await AP(await e.store());try{if(!(await r.list()).some(e=>e.state===`PLANNED`&&e.ref.kind===`deposit`&&e.ref.s===t&&e.ref.i===n))return}finally{r.close()}await y(async()=>{let r=await AP(await e.store());try{await r.skipUsed(t,n)}finally{r.close()}})}",
  ].join(";");
  const at = (s) => facts("", s);
  assert.deepEqual([at(js).store, at(js).marks, at(js).skip], [true, true, true]);
  assert.equal(at(js.replace("if(r===`TAKEN`&&s.ref.kind===`deposit`&&jN(await e.get(`meta`,`owed/quoted-deposits`)).has(qN(s.ref)))throw", "if(0)throw")).store, false, "the move refuses nothing");
  assert.equal(at(js.replace("return await e.update(`meta`,MN,e=>Object.fromEntries([...NN(e),r].map(e=>[e,!0]))),await u(a),a})}", "return l(a.id,`PLANNED`,`TAKEN`)})}")).store, false, "a skip that writes TAKEN");
  assert.equal(at(js.replace("return await e.update(`meta`,MN,", "return await e.update(`meta`,DN,")).store, false, "a skip written to another set");
  assert.equal(at(js.replace("||jN(await e.get(`meta`,`owed/quoted-deposits`)).has(r)||ON", "||ON")).store, false, "a skip past the quoted check");
  assert.equal(at(js.replace("&&!a.has(qN(e.ref)))", ")")).store, false, "a plan that names a skipped index");
  assert.equal(at(js.replace("if(await e.quoted(o,s.deposit.index),a())return void(r={error:`not_allowed`});", "")).marks, false, "deposit.quote marks nothing");
  assert.equal(at(js.replace("if(await e.quoted(s.scope,u.record.index),a())return void(r={error:`not_allowed`});", "")).marks, false, "pool.address marks nothing");
  assert.equal(at(js.replace("b:sV({quoted:p})", "b:sV({})")).marks, false, "a host handed no mark");
  assert.equal(at(js.replace("{mode:`shared`}", "{mode:`exclusive`}")).marks, false, "a mark outside the seed lock's shared hold");
  assert.equal(at(js.replace("B5(o,t.scope,m)", "m")).skip, false, "the vault's read past the skipping reader");
  assert.equal(at(js.replace("&&await e.skip(t,i)", "")).skip, false, "a used id skipped by nothing");
  assert.equal(at(js.replace("await r.skipUsed(t,n)", "await r.takeUnquoted(t,n)")).skip, false, "own.skip that takes");
  assert.equal(at(js.replace("try{if(!(await r.list()).some(e=>e.state===`PLANNED`&&e.ref.kind===`deposit`&&e.ref.s===t&&e.ref.i===n))return}finally{r.close()}", "")).skip, false, "own.skip that opens the seed for every used id");
});
