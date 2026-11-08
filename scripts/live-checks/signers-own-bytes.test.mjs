// node --test scripts/live-checks/signers-own-bytes.test.mjs: the live check replays its recorded answers
// (signers-own-bytes.answers.json, its _note says where each was read). good: this card's SIGN_HOST build: PASS. bad:
// SIGN_HOST as served before the card, whose Solana signer signs any wire handed to it: FAIL, every mark named. planted:
// the good build with one line changed each (A-J): the gate bypassed, the registry keeping the caller's array or not
// comparing the length or the height, the signer handed the caller's message (review 1 M1), a leg registered before its
// verdict, the teardown checking the live wires instead of its copies, never registering its frames or never refusing
// a frame its simulation changed (review 5 F6), the rent back checking and signing the frames' wires (main 53921971's
// shape, review 5 F5): each FAIL. Planted on good: another /app.js, no pin, each mark missing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MARKS, facts, judge } from "./signers-own-bytes.mjs";

const A = JSON.parse(readFileSync(new URL("./signers-own-bytes.answers.json", import.meta.url), "utf8"));
const bads = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const no = (k) => `BAD the served bundle does not carry: ${k}`;
const [REGISTRY, GATE, COPY, LEG, TEARDOWN, RENT] = MARKS;

test("recorded good answer: this card's build carries every line: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST before card signers-own-bytes carries none of them: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(bads(v), MARKS.map(no));
});

test("recorded planted bundles A-J: each FAIL on the line it breaks", () => {
  const p = A.planted;
  assert.deepEqual(bads(judge(p["A the gate bypassed: no copy, the caller's wire"])), [no(GATE), no(COPY)]);
  // the registry's own mark gone, no name to find the rest by: every line FAILs
  for (const k of ["B the registry keeps the caller's array, no copy", "C the length not compared", "D the height not compared"]) assert.deepEqual(bads(judge(p[k])), MARKS.map(no), k);
  assert.deepEqual(bads(judge(p["E the signer handed the caller's message"])), [no(COPY)]);
  assert.deepEqual(bads(judge(p["F a leg registered before its verdict"])), [no(LEG)]);
  // the rent back is found through the checked teardown's own name: a teardown that is not this card's leaves it unread
  assert.deepEqual(bads(judge(p["G the teardown checks the live wires, not its copies"])), [no(TEARDOWN), no(RENT)]);
  assert.deepEqual(bads(judge(p["H the teardown's frames never registered"])), [no(TEARDOWN)]);
  assert.deepEqual(bads(judge(p["I the rent back checks and signs the frames' wires (main 53921971's shape)"])), [no(RENT)]);
  assert.deepEqual(bads(judge(p["J the teardown never refuses a frame its simulation changed"])), [no(TEARDOWN), no(RENT)]);
});

test("planted on good: another app.js, no pin, each mark missing: each FAIL", () => {
  const with_ = (f) => { const a = structuredClone(A.good); f(a); return bads(judge(a)); };
  assert.deepEqual(with_((a) => { a.sha384 = "sha384-x"; }), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(with_((a) => { a.index = "<!doctype html>"; }), ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const k of MARKS) assert.deepEqual(with_((a) => { a.carries[k] = false; }), [no(k)], k);
  assert.equal(judge(null).ok, false);
});

test("facts reads each line by the bundle's shape, with the registry's own names, not its words alone", () => {
  const reg = "var T=new WeakMap;function E(e,t){T.set(e,Object.freeze({wire:Uint8Array.from(t),lastValidBlockHeight:e.lastValidBlockHeight}))}function D(e){let t=T.get(e);return t===void 0||!(e.wire instanceof Uint8Array)||t.wire.length!==e.wire.length||!e.wire.every((e,n)=>e===t.wire[n])||!Object.is(t.lastValidBlockHeight,e.lastValidBlockHeight)?null:{wire:Uint8Array.from(t.wire),lastValidBlockHeight:t.lastValidBlockHeight}}";
  const signer = "async function S(e,t,n,r){let i=D(n);if(i===null)throw Error(`the wire is not one this flow built and checked`);let{wire:a,lastValidBlockHeight:o}=i,s=a.subarray(65);if(a[0]!==1)throw Error(`x`);let c;if(e.dry){c=new Uint8Array(64)}else{c=await e.sign(t,s.slice(),{lastValidBlockHeight:o})}let l=r();if(l)return l;if(!e.dry&&(!(c instanceof Uint8Array)||c.length!==64||!V.verify(c,s,Z.decode(t))))throw Error(`the signature for ${t} does not verify`);return a.set(c,1),{wire:a,lastValidBlockHeight:o}}";
  const leg = ",l.ok?(E(i,s),{leg:t,rec:n,assembled:i,checked:s,";
  const td = "async function J(e,t,n,r,i,a){let o=async(t,o)=>{let s=K(e,t,i),c=s.map(e=>Uint8Array.from(e.wire)),l={accounts:n,wallet:r,simulations:await a(s),...o===void 0?{}:{unclaimed:o}};return s.forEach((e,t)=>{let n=e.wire,r=c[t];n instanceof Uint8Array&&n.length===r.length&&n.every((e,t)=>e===r[t])||Y(`teardown frame ${t} changed while it simulated`)}),{plan:t,frames:s,wires:c,reads:l,verdict:X(c,e,l)}},s=await o(t);return s}let d=await B(n.providers),{frames:f,wires:p,verdict:m}=await J(i,u,l,[o[0]?.lamports??0n,s[0]?.lamports??0n],d,e=>Promise.all(e.map(e=>F(t=>w(t,e.wire,i,a).catch(()=>null),n.providers))));if(!m.ok||f.length===0)return{verdict:m,frames:f.length};f.forEach((e,t)=>E(e,p[t]));let h=await G(n,f.map(e=>({wallet:i,tx:e})));";
  const rent = "let c=await BP(o),l=await J(s.address,r,n,[t[0][0]?.lamports??0n,t[1][0]?.lamports??0n],{blockhash:c.blockhash,lastValidBlockHeight:c.lastHeight},async e=>{let t=[];for(let n of e)t.push(await OR(o,e=>Mg(e,n.wire,s.address,i)));return t});return KE(l.wires,p,l.reads),{keep:l.plan.keep,signed:await a(l.wires),last:c.lastHeight,unclaimed:l.reads.unclaimed}});";
  const all = reg + signer + leg + td + rent;
  assert.deepEqual(Object.values(facts("", all).carries), MARKS.map(() => true));
  // the words of the refusal with no registry around them: nothing carried
  assert.deepEqual(Object.values(facts("", "throw Error(`the wire is not one this flow built and checked`)").carries), MARKS.map(() => false));
  // the signer calling another lookup than the registry's: the gate and the copy are not this registry's
  const c = facts("", all.replace("let i=D(n);", "let i=Q(n);")).carries;
  assert.deepEqual([c[REGISTRY], c[GATE], c[COPY]], [true, false, false]);
  // the signature put in the caller's wire, or verified against another message: the copy line FAILs
  assert.equal(facts("", all.replace("return a.set(c,1),{wire:a,", "return n.wire.set(c,1),{wire:n.wire,")).carries[COPY], false);
  assert.equal(facts("", all.replace("!V.verify(c,s,", "!V.verify(c,n.message,")).carries[COPY], false);
  // the teardown checking the frames instead of its copies, signing frames whose copies it never returned, or registering
  // before its checks: the teardown line FAILs
  for (const [from, to] of [["verdict:X(c,e,l)", "verdict:X(s.map(e=>e.wire),e,l)"], ["c=s.map(e=>Uint8Array.from(e.wire)),", "c=s.map(e=>e.wire),"], ["f.forEach((e,t)=>E(e,p[t]));", ""], ["if(!m.ok||f.length===0)return{verdict:m,frames:f.length};f.forEach((e,t)=>E(e,p[t]));", "f.forEach((e,t)=>E(e,p[t]));if(!m.ok||f.length===0)return{verdict:m,frames:f.length};"], ["return s.forEach((e,t)=>{let n=e.wire,r=c[t];n instanceof Uint8Array&&n.length===r.length&&n.every((e,t)=>e===r[t])||Y(`teardown frame ${t} changed while it simulated`)}),{plan:", "return{plan:"], ["n.length===r.length&&", ""], ["n.every((e,t)=>e===r[t])", "n.every((e,t)=>e===e)"]]) {
    assert.ok(all.includes(from), from);
    assert.equal(facts("", all.replace(from, to)).carries[TEARDOWN], false, to);
  }
  // the rent back checking or signing the frames' own wires (main 53921971's shape), or not checking again: its line FAILs
  for (const [from, to] of [["return KE(l.wires,p,l.reads),{keep:l.plan.keep,signed:await a(l.wires),", "return KE(l.frames.map(e=>e.wire),p,l.reads),{keep:l.plan.keep,signed:await a(l.frames.map(e=>e.wire)),"], ["signed:await a(l.wires),", "signed:await a(l.frames.map(e=>e.wire)),"], ["return KE(l.wires,p,l.reads),{", "return{"], ["l=await J(", "l=await Q("]]) {
    assert.ok(all.includes(from), from);
    const c = facts("", all.replace(from, to)).carries;
    assert.equal(c[RENT], false, to);
    assert.equal(c[TEARDOWN], true, to);
  }
});
