// node --test scripts/live-checks/pool-answer-unknown.test.mjs: the live check replays its recorded answers
// (pool-answer-unknown.answers.json). good: this card's SIGN_HOST build: PASS. bad: main d57ecfb9's build (release-72):
// FAIL. liveBefore: SIGN_HOST before this card's deploy (release-72; its landed and paced facts read from the same
// bundle, by its sha384, after the delta review r2 added them): FAIL. Planted on the good one: another /app.js,
// no pin, each mark taken away: each FAIL. Planted in a bundle: each mark broken in place, among them the paced
// wrapper handing its slot the bare provider (B1), the slot calling the bare provider it takes (B2'), and each end
// that answers part_filled, and the no-ask pass's not_funded, read off the list in place of the landed count: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./pool-answer-unknown.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pool-answer-unknown.answers.json", import.meta.url), "utf8"));
const NO_UNREAD = "BAD a pool deposit whose read back does not check out after its send is answered failed: the app shows a deposit that may land as failed";
const NO_ONE = "BAD a pool deposit whose mark only one RPC holds is built again or stuck: a deposit that landed may be asked again";
const NO_PICK = "BAD a vault buy or sell whose provider read fails at the pick is answered failed: the app takes an outage as a no";
const NO_RECORD = "BAD a vault buy whose blockhash, mint or build read fails before signing is answered failed: the app takes an outage as a no";
const NO_LANDED = "BAD a pool deposit rung that landed with no tx named is left out of the answer: the app shows money that arrived as failed";
const NO_PACED = "BAD the kit's pacing calls the bare provider past the page's fault watch: a vault buy's provider outage answers failed";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

for (const k of ["bad", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, each path named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, [NO_UNREAD, NO_ONE, NO_PICK, NO_RECORD, NO_LANDED, NO_PACED]);
  });
}

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, unread: false }).lines, [NO_UNREAD]);
  assert.deepEqual(judge({ ...g, one: false }).lines, [NO_ONE]);
  assert.deepEqual(judge({ ...g, pick: false }).lines, [NO_PICK]);
  assert.deepEqual(judge({ ...g, record: false }).lines, [NO_RECORD]);
  assert.deepEqual(judge({ ...g, landed: false }).lines, [NO_LANDED]);
  assert.deepEqual(judge({ ...g, paced: false }).lines, [NO_PACED]);
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle", () => {
  // the minified shapes as the good bundle spells them (release-75)
  const js =
    "return t===`one`?`pending`:(await x(a,t),`taken`);" +
    "catch(e){if(!d)return u(e instanceof pm?`down`:`failed`);throw e}" +
    "if(!d)return l(g&&!_&&w===`failed`?`down`:w);" +
    "return o!==null&&s.push({chain:`solana`,hash:o}),n&&c++,e.landed?.(r),n&&e.progress?.(`filled`),`landed`}" +
    "if(t===null)return C.size===0?{stage:`filled`,txs:s}:T&&l.length===0&&c===0?{error:`not_funded`}:{stage:`not_landed`,txs:l};" +
    "if(r===`one`)return c?{stage:`part_filled`,txs:s}:{stage:`not_landed`,txs:[]};if(r!==null){k();continue}" +
    "if(t===0&&ee.i===F){ee=null;continue}return c?{stage:`part_filled`,txs:s}:await E(n)?{stage:`not_landed`,txs:[]}:{error:`not_funded`}" +
    "catch(e){if(e instanceof FN)return e.code===`not_landed`?{stage:`not_landed`,txs:l}:c?{stage:`part_filled`,txs:s}:e.code===`failed`&&d().length?{stage:`sent`,txs:d()}:{error:e.code};" +
    "if(e instanceof Qv)return c?{stage:`part_filled`,txs:s}:d().length?{stage:`sent`,txs:d()}:{error:`failed`};" +
    "if(c)return{stage:`part_filled`,txs:s};if(d().length)return{stage:`sent`,txs:d()};if(e instanceof mm)return{error:`down`};throw e}" +
    "function $p(e,t,n){let r=Qp(e,t),i=Jp();let a={t:i,started:!1},s=t=>{a.t=Jp(),a.started=!0;let c=Kp;Kp=r;try{return e(n,t)}finally{Kp=c,a.t=Jp()}};return{run:s,wait:null}}" +
    "function sm(e,t=Vp){let n=Gp.get(e)??e,r=Qp(n,t),i=(n,i)=>{if(Kp===r)return e(n,i);let a=$p(e,t,n);return a.wait?a.wait.then(()=>a.run(i)):a.run(i)};return Gp.set(i,n),i}";
  const f = facts("", js);
  assert.deepEqual({ ...f, sha384: null }, { index: "", sha384: null, unread: true, one: true, pick: true, record: true, landed: true, paced: true });
  // each mark changed in place, once (a mark found twice or not at all is a broken test, never a pass)
  const planted = (...pairs) => {
    let out = js;
    for (let i = 0; i < pairs.length; i += 2) {
      assert.equal(out.split(pairs[i]).length, 2, `planted: ${pairs[i]} is not in the bundle once`);
      out = out.split(pairs[i]).join(pairs[i + 1]);
    }
    return facts("", out);
  };
  assert.equal(planted("e.code===`failed`&&d().length?{stage:`sent`,txs:d()}:", "").unread, false);
  assert.equal(planted("t===`one`?`pending`:", "").one, false);
  assert.equal(planted("e instanceof pm?`down`:`failed`", "`failed`").pick, false);
  assert.equal(planted("g&&!_&&w===`failed`?`down`:w", "g&&!_?`down`:w").record, false);
  // the count, never the signing flag or the list (card pool-answer-unknown, delta review r2): a part_filled on another
  // name, or with no count bumped, FAILs
  assert.equal(planted("if(c)return{stage:`part_filled`", "if(g)return{stage:`part_filled`").landed, false);
  assert.equal(planted("if(c)return{stage:`part_filled`", "if(s.length)return{stage:`part_filled`").landed, false);
  assert.equal(planted("n&&c++,", "").landed, false);
  assert.equal(planted("txs:s};if(d()", "txs:[]};if(d()").landed, false);
  // every other end that answers part_filled, each on the list in place of the count, and the no-ask pass's not_funded
  // with the count left out or on the list (delta review r2, item 2): FAIL
  assert.equal(planted("if(r===`one`)return c?", "if(r===`one`)return s.length?").landed, false, "the mark on one RPC");
  assert.equal(planted("continue}return c?", "continue}return s.length?").landed, false, "the second note left short");
  assert.equal(planted("txs:l}:c?{stage:`part_filled`", "txs:l}:s.length?{stage:`part_filled`").landed, false, "the read back's refusal");
  assert.equal(planted("if(e instanceof Qv)return c?", "if(e instanceof Qv)return s.length?").landed, false, "the kit's refusal");
  assert.equal(planted("&&c===0?{error:`not_funded`}", "?{error:`not_funded`}").landed, false, "the no-ask pass, no count");
  assert.equal(planted("&&c===0?{error:`not_funded`}", "&&s.length===0?{error:`not_funded`}").landed, false, "the no-ask pass, on the list");
  // the slot calls the bare provider (d57ecfb9: try{return n(...)} with no queue marked), or the paced wrapper never
  // sees its own slot: FAIL
  assert.equal(planted("let c=Kp;Kp=r;try{return e(n,t)}finally{Kp=c,", "try{return e(n,t)}finally{").paced, false);
  assert.equal(planted("{if(Kp===r)return e(n,i);let a", "{let a").paced, false);
  // B1: the paced wrapper hands rpcSlot the bare provider under the wrapper it was given, the guard kept: FAIL
  assert.equal(planted("i=(n,i)=>{if(Kp===r)return e(n,i);let a=$p(e,t,n);", "i=(m,i)=>{if(Kp===r)return e(m,i);let a=$p(n,t,m);").paced, false, "B1");
  // B2': rpcSlot calls the bare provider it takes at its top (as 4c38ff10 minified it), the queue mark kept: FAIL
  assert.equal(planted("function $p(e,t,n){let r=Qp(e,t),i=Jp();", "function $p(e,t,n){let r=Qp(e,t),b=Gp.get(e)??e,i=Jp();", "try{return e(n,t)}", "try{return b(n,t)}").paced, false, "B2'");
});
