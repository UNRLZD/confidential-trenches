// node --test scripts/live-checks/signers-own-bytes.test.mjs: the live check replays its recorded answers
// (signers-own-bytes.answers.json, its _note says where each was read). good: this card's SIGN_HOST build: PASS. bad:
// SIGN_HOST as served before the card, whose Solana signer signs any wire handed to it: FAIL, every mark named. planted:
// the good build with one line changed each: the gate removed (A), the registry keeping the caller's array (B) or not
// comparing the bytes (C), a leg registered before its verdict (D), the teardown's frames never registered (E): each
// FAIL. Planted on good: another /app.js, no pin, each mark missing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MARKS, facts, judge } from "./signers-own-bytes.mjs";

const A = JSON.parse(readFileSync(new URL("./signers-own-bytes.answers.json", import.meta.url), "utf8"));
const bads = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const no = (k) => `BAD the served bundle does not carry: ${k}`;
const [REGISTRY, GATE, LEG, TEARDOWN] = MARKS;

test("recorded good answer: this card's build carries every line: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST before card signers-own-bytes carries none of them: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(bads(v), MARKS.map(no));
});

test("recorded planted bundles A-E: each FAIL on the line it breaks", () => {
  const p = A.planted;
  assert.deepEqual(bads(judge(p["A the gate removed"])), [no(GATE)]);
  // the registry's own mark gone, no name to find the rest by: every line FAILs
  assert.deepEqual(bads(judge(p["B the registry keeps the caller's array, no copy"])), MARKS.map(no));
  assert.deepEqual(bads(judge(p["C the bytes not compared"])), MARKS.map(no));
  assert.deepEqual(bads(judge(p["D a leg registered before its verdict"])), [no(LEG)]);
  assert.deepEqual(bads(judge(p["E the teardown's frames never registered"])), [no(TEARDOWN)]);
});

test("planted on good: another app.js, no pin, each mark missing: each FAIL", () => {
  const with_ = (f) => { const a = structuredClone(A.good); f(a); return bads(judge(a)); };
  assert.deepEqual(with_((a) => { a.sha384 = "sha384-x"; }), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(with_((a) => { a.index = "<!doctype html>"; }), ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const k of MARKS) assert.deepEqual(with_((a) => { a.carries[k] = false; }), [no(k)], k);
  assert.equal(judge(null).ok, false);
});

test("facts reads each line by the bundle's shape, with the registry's own names, not its words alone", () => {
  const reg = "var T=new WeakMap;function E(e,t){T.set(e,Uint8Array.from(t))}function D(e){let t=T.get(e);return t!==void 0&&t.length===e.wire.length&&e.wire.every((e,n)=>e===t[n])}";
  const gate = "async function S(e,t,n,r){if(!D(n))throw Error(`the wire is not one this flow built and checked`);if(n.wire[0]!==1";
  const leg = ",l.ok?(E(i,s),{leg:t,rec:n,assembled:i,checked:s,";
  const td = "if(!h.ok||f.length===0)return{verdict:h,frames:f.length};f.forEach((e,t)=>E(e,m[t]));let g=await X(n,f.map(";
  assert.deepEqual(Object.values(facts("", reg + gate + leg + td).carries), [true, true, true, true]);
  // the gate's words calling another test, or a leg registered with another function: not this registry's
  assert.equal(facts("", reg + gate.replace("!D(n)", "!Q(n)") + leg + td).carries[GATE], false);
  assert.equal(facts("", reg + gate + leg.replace("E(i,s)", "Q(i,s)") + td).carries[LEG], false);
  assert.equal(facts("", reg + gate + leg + td.replace("E(e,m[t])", "E(e,e.wire)")).carries[TEARDOWN], false);
  assert.equal(facts("", reg + gate + leg + td).carries[REGISTRY], true);
});
