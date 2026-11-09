// node --test scripts/live-checks/solana-release-reads-paced.test.mjs: the live check replays its recorded answers
// (solana-release-reads-paced.answers.json). good: this card's SIGN_HOST build: PASS. bad: main 5a9e5d8c's build
// (release-83): FAIL, each path named. Planted on the good one: another /app.js, no pin, each mark taken away: each
// FAIL. Planted in a bundle: each mark broken in place, among them the reference reading the page's own pair, one
// provider of either pair left unpaced, the timed read pacing the provider under it (its wait then counted against
// its timeout), each of the three reads called bare, and the price read timed over its wait, sending a try past its
// bound or failing with another error than its NoAnswer: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./solana-release-reads-paced.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./solana-release-reads-paced.answers.json", import.meta.url), "utf8"));
const NO_RELEASE = "BAD the release's reference reads on a pair outside the trade's pace: a release under load can trip a provider's limit and be refused as down";
const NO_PAIR = "BAD the page's Solana pair is made unpaced: pool buy, sell, withdraw and settle reads skip the provider's queue";
const NO_TIMED = "BAD the kit's reference, rent or tx-end reads skip the provider's queue or count their wait against their timeout: a read behind a full pace is refused as down";
const NO_PRICE = "BAD the page's price read counts its wait for a turn against its try's bound: behind a full pace it fails as no answer";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: main 5a9e5d8c's build (release-83): FAIL, each path named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_RELEASE, NO_PAIR, NO_TIMED, NO_PRICE]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, release: false }).lines, [NO_RELEASE]);
  assert.deepEqual(judge({ ...g, pair: false }).lines, [NO_PAIR]);
  assert.deepEqual(judge({ ...g, timed: false }).lines, [NO_TIMED]);
  assert.deepEqual(judge({ ...g, price: false }).lines, [NO_PRICE]);
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle", () => {
  // the minified shapes as the good bundle spells them (the build with the pool-usd fold)
  const js =
    "var hO=`https://ct-api.unrealized.trade`;" +
    "function Cm(e,t=rm){let n=sm.get(e)??e,r=mm(n,t),i=(n,i)=>{if(cm===r)return e(n,i);let a=hm(e,t,n);return a.wait?a.wait.then(()=>a.run(i)):a.run(i)},a=n.url===void 0?i:Object.assign(i,{url:n.url});return sm.set(a,n),a}" +
    "function wm(e,t,n){let r=Sm(e,(r,i)=>{let a,o;try{o=typeof t==`function`?t():t,a=Promise.resolve(e(r,i))}catch(e){return Promise.reject(e)}return Em(a,o,n)}),i=sm.get(e)??e,a=(i.url===void 0?om.get(i):am.get(fm(i.url)))?.limits.values().next().value;return a?Cm(r,a):r}" +
    "Ly=e=>e instanceof Fy||e instanceof jm&&e.fault===`timeout`;async function zy(e,t,n,r,i){for(let a=1;;a++){if(i.stopped)return X(`${r}: not asked again, the read has ended`);" +
    "let o=wm(e,()=>{if(i.stopped)throw Error(`${r}: not asked again, the read ended before its turn`);let e=i.end-Date.now();if(e<=0)throw new Fy(`${r}: no turn inside the read's bound`);return Math.min(My,e)},e=>new Fy(`${r}: no answer in ${e} ms`));try{return await Promise.resolve().then(()=>o(t,n))}catch(e){}}}" +
    "t Promise.all(e.map(async e=>{try{let r=wm(e,n),i=(e,t)=>Promise.resolve().then(()=>r(e,t)),a=Xm(await i(`getLatestBlockhash`,[{commitment:`finalized`}]));" +
    "a=t=>Promise.all(e.map(e=>Promise.resolve().then(()=>wm(e,Dg)(`getMultipleAccounts`,[t,{encoding:`base64`,commitment:`confirmed`}])).then(e=>p_(e,t.length),()=>null)));" +
    "let t=(await Promise.resolve().then(()=>wm(e,Wv)(`getAccountInfo`,[dv,{encoding:`base64`,commitment:`confirmed`}])))?.value;" +
    "var GM=`https://ct-api.unrealized.trade`,KM=`https://solana-rpc.publicnode.com`;function qM(){return{helper:GM,providers:[Cm(hk(KM)),Cm(gk(GM))],reference:(e,t)=>_k(t,e),paths:Vm({helper:Rm(GM)})}}" +
    "var pI=yE.mainnet,mI=`mainnet`,BV=`${GM}/v1/rpc/solana-marks`,hI=()=>{let e=Cm(hk(KM)),t=Cm(jV(BV));return[yh(e,(n,r)=>(n===`getProgramAccounts`?t:e)(n,r)),Cm(gk(GM))]}";
  const f = facts("", js);
  assert.deepEqual({ ...f, sha384: null }, { index: "", sha384: null, release: true, pair: true, timed: true, price: true });
  // each mark changed in place, once (a mark found twice or not at all is a broken test, never a pass)
  const planted = (...pairs) => {
    let out = js;
    for (let i = 0; i < pairs.length; i += 2) {
      assert.equal(out.split(pairs[i]).length, 2, `planted: ${pairs[i]} is not in the bundle once`);
      out = out.split(pairs[i]).join(pairs[i + 1]);
    }
    return facts("", out);
  };
  // the release's reference on the page's own pair (5a9e5d8c: reference:t=>vk(e,t)), or its arguments crossed: FAIL
  assert.equal(planted("reference:(e,t)=>_k(t,e)", "reference:t=>_k(e,t)").release, false);
  assert.equal(planted("reference:(e,t)=>_k(t,e)", "reference:(e,t)=>_k(e,t)").release, false);
  // either provider of the release's pair unpaced, or provider A not PublicNode: FAIL
  assert.equal(planted("providers:[Cm(hk(KM)),", "providers:[hk(KM),").release, false);
  assert.equal(planted("Cm(gk(GM))],reference", "gk(GM)],reference").release, false);
  assert.equal(planted("KM=`https://solana-rpc.publicnode.com`", "KM=`https://api.mainnet-beta.solana.com`").release, false);
  // either provider of the page's pair unpaced, the marks route unpaced, or the scan not sent to it: FAIL
  assert.equal(planted("let e=Cm(hk(KM)),", "let e=hk(KM),").pair, false);
  assert.equal(planted("Cm(gk(GM))]}", "gk(GM)]}").pair, false);
  assert.equal(planted("t=Cm(jV(BV));", "t=jV(BV);").pair, false);
  assert.equal(planted("(n===`getProgramAccounts`?t:e)", "(e)").pair, false);
  assert.equal(planted("BV=`${GM}/v1/rpc/solana-marks`", "BV=`${GM}/v1/rpc/solana`").pair, false);
  // the timed read pacing the provider under it, so its wait counts against its timeout: FAIL
  assert.equal(planted("return a?Cm(r,a):r}", "return a?Cm(e,a):r}").timed, false);
  // the provider called after a turn (a microtask), not inside it, so a paced provider would queue twice: FAIL
  assert.equal(planted("a=Promise.resolve(e(r,i))}", "a=Promise.resolve().then(()=>e(r,i))}").timed, false);
  // the bound taken when the wrapper is made, not at the turn, or the caller's late error dropped: FAIL
  assert.equal(planted("o=typeof t==`function`?t():t,", "o=t,").timed, false);
  assert.equal(planted("return Em(a,o,n)}", "return Em(a,o)}").timed, false);
  // no queue looked up: FAIL
  assert.equal(planted("?.limits.values().next().value;", ";").timed, false);
  // each read called bare, the timed read left out: FAIL
  assert.equal(planted("wm(e,Dg)(`getMultipleAccounts`", "e(`getMultipleAccounts`").timed, false, "the reference");
  assert.equal(planted("wm(e,Wv)(`getAccountInfo`", "e(`getAccountInfo`").timed, false, "the rent");
  assert.equal(planted("let r=wm(e,n),", "let r=e,").timed, false, "the tx end");
  // the price read: its try timed over the wait (the provider called bare under a plain timeout), a turn past the read's
  // bound still sent, its timeout another error than the read's NoAnswer, or slow() not asking NoAnswer again: FAIL
  assert.equal(planted("try{return await Promise.resolve().then(()=>o(t,n))}", "try{return await Promise.resolve().then(()=>e(t,n))}").price, false);
  assert.equal(planted("if(e<=0)throw new Fy(`${r}: no turn inside the read's bound`);return Math.min(My,e)", "return Math.max(1,Math.min(My,e))").price, false);
  assert.equal(planted("e=>new Fy(`${r}: no answer in ${e} ms`)", "e=>Error(`${r}: no answer in ${e} ms`)").price, false);
  assert.equal(planted("Ly=e=>e instanceof Fy||", "Ly=e=>").price, false);
  assert.equal(planted("{if(i.stopped)throw Error(`${r}: not asked again, the read ended before its turn`);let e=", "{let e=").price, false, "a turn after the read ended still sent");
  // the paced wrapper calling past its own slot (no guard): no paced wrapper found, every fact FAILs
  const unguarded = planted("{if(cm===r)return e(n,i);let a", "{let a");
  assert.deepEqual([unguarded.release, unguarded.pair, unguarded.timed, unguarded.price], [false, false, false, false]);
});
