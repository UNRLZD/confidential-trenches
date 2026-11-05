// node --test scripts/live-checks/kit-renewal-read-bounded.test.mjs: the live check's verdict replays recorded answers
// (kit-renewal-read-bounded.answers.json), each read on 2026-11-05 by kit-renewal-read-bounded.mjs collect():
//   good: this card's checkout (--local): the signing page's committed bundle holds the age rule at the sign point and at
//         each leg's signature, renews 5 s before the limit, and the page names and keeps only the kept signatures: PASS;
//   bad:  SIGN_HOST as deployed before this card (its /app.js is main 582c8ac's bundle), read over https: none: FAIL.
// Planted from the good answer: one marker lost, a script the host did not answer, a page naming no script, no answer.
// The markers themselves are run over the bundle's own minified lines, after this card and before it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, MARKERS, scriptsOf } from "./kit-renewal-read-bounded.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "kit-renewal-read-bounded.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the bundle holds every part of the age rule: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(new Set(ANSWERS.good.js.flatMap((f) => f.found)), new Set(Object.keys(MARKERS)));
});

test("recorded bad answer: SIGN_HOST before this card holds none of it: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => /^BAD sign: the scripts lack the age rule, the signing margin, the sign point's timed re-read, with a fresh blockhash, the rule before each signer, the rule when the signer answers, the page names only kept signatures, the page frees an unsigned leg$/.test(l)), r.lines.join("\n"));
});

test("planted: each marker lost alone fails, naming it", () => {
  for (const name of Object.keys(MARKERS)) {
    const r = mut((rec) => void (rec.js[0].found = rec.js[0].found.filter((m) => m !== name)));
    assert.equal(r.ok, false, name);
    assert.ok(bad(r.lines).some((l) => l === `BAD sign: the scripts lack ${name}`), r.lines.join("\n"));
  }
});

test("planted: a script the host did not answer, a page naming no script, a page not answering, no answer: each fails", () => {
  assert.equal(mut((rec) => void (rec.js[0].status = 404)).ok, false);
  assert.equal(mut((rec) => void (rec.js = [])).ok, false);
  assert.equal(mut((rec) => void (rec.pageStatus = 503)).ok, false);
  assert.equal(mut((rec) => void (rec.js[0].found = "the age rule")).ok, false);
  assert.equal(judge({}).ok, false);
  assert.equal(judge(null).ok, false);
});

test("the markers match the bundle's own minified lines and not the bundle before this card", () => {
  // as the bundler wrote them (packages/signpage/public/app.js after this card)
  const after = [
    "function Cp(e,t){let n=t-e;return n>=0&&n<=2e4?null:`checks: the reference is ${Number.isFinite(n)?Math.round(n):0} ms old at the signature, past the ${tp} ms limit`}",
    "tp=2e4,np=(e,t)=>t-e>15e3,rp=e=>{}",
    "if(f.length&&np(c,i())){c=i();let[e,r]=await Promise.all([s(),mp(t.providers).catch(e=>Error(`renewal: ${a(e)}`))]),o=r instanceof Error?r.message:Cp(c,i());if(o||r instanceof Error){for(let e of f)e.p.rec.refused=o??`renewal: no blockhash`;return{legs:[],at:c}}n.blockhash=r,f=await d(e,f.map(e=>e.i),r)}return{legs:f.map(e=>e.p),at:c}}",
    "T=(await Promise.all(ee.map(async e=>{let t=w()??await Tp(a,e.leg.wallet,e.assembled,w);return typeof t==`string`?(e.rec.refused=t,null):{p:e,tx:{wire:t}}})))",
    "i=await e.sign(t,n.message,{lastValidBlockHeight:n.lastValidBlockHeight})}let a=r();if(a)return a;if(!e.dry&&(!(i instanceof Uint8Array)||i.length!==64))throw Error(`x`)",
    "_=await t(n,{...e.deps,sign:(e,t,n)=>p.sign(e,t,n),onSigned:e=>{h.splice(0,h.length,...e.map(e=>({chain:`solana`,hash:e.signature})))},onProgress:g})",
    "let c=n?.legs[r];if(i.inflight.txs.length===0||n&&c&&c.signature===void 0)return wv(e,t,a.id);",
  ].join("");
  for (const [name, re] of Object.entries(MARKERS)) assert.match(after, re, name);
  // before (main 582c8ac's bundle): no age rule, renewal past 20 s only, the sign point re-reading the price alone,
  // every leg signed in one set with its signature checked as soon as the signer answers, the page naming each
  // signature its signer gave, and a mark kept for any leg with a tx in it
  const before = [
    "f=await d(l,e.flatMap((e,t)=>o[t]?[t]:[]));return f.length&&i()-c>2e4&&(f=await d(await s(),f.map(e=>e.i))),f.map(e=>e.p)}",
    "C=f()-p>2e4?await kp(S,a,l):S",
    "C.map(e=>({wallet:e.leg.wallet,tx:e.assembled})));C.forEach((e,t)=>{e.rec.signature=R.encode(w",
    "r=await e.sign(t,n.message,{lastValidBlockHeight:n.lastValidBlockHeight}),!(r instanceof Uint8Array)||r.length!==64||!xr.verify(r,n.message,R.deco",
    "sign:async(e,t,n)=>{let r=await p.sign(e,t,n);return g===null&&h.push({chain:`solana`,hash:R.encode(r)}),r},onProgress:_})",
    "if(i.inflight.txs.length===0)return bv(e,t,a.id);if(c&&Lv(c))return b",
  ].join("");
  for (const [name, re] of Object.entries(MARKERS)) assert.doesNotMatch(before, re, name);
  // the rule without its lower bound (the review's LOW 4) is not the age rule
  assert.doesNotMatch("function Sp(e,t){let n=t-e;return n<=2e4?null:`checks: the reference is ${n} ms`}", MARKERS["the age rule"]);
});

test("the committed bundle holds every marker", () => {
  const js = readFileSync(path.join(HERE, "../../packages/signpage/public/app.js"), "utf8");
  for (const [name, re] of Object.entries(MARKERS)) assert.match(js, re, name);
});

test("the page's scripts: the src of each script tag", () => {
  assert.deepEqual(scriptsOf('<script type="module" src="/app.js" integrity="sha384-x"></script>'), ["/app.js"]);
});
