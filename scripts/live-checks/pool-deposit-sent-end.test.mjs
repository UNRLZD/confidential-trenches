// node --test scripts/live-checks/pool-deposit-sent-end.test.mjs: the live check replays its recorded answers
// (pool-deposit-sent-end.answers.json). good: this card's build with the delta reviews of 09542dc6 and bce5cde5 folded:
// PASS. badc3c: the card's build at c3cb08c8, bad095: the card's build at 09542dc6, bad37a: the card's build at 37abecea, bad: the card's build before the first fold
// (6f20021b), bad5a9: main 5a9e5d8c's build,
// and liveBefore: SIGN_HOST before this card's deploy: each FAIL, each path named. Planted on the good one: another /app.js, no pin, each mark taken away: each FAIL. Planted in
// the bundle's own excerpt (pool-deposit-sent-end.excerpt.txt, cut from this build's public/app.js): each mutant the
// review's finding 7 found the old marks blind to, and each rule of the fold, taken away: the fact it rests on FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, WHY } from "./pool-deposit-sent-end.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pool-deposit-sent-end.answers.json", import.meta.url), "utf8"));
const EXCERPT = readFileSync(new URL("./pool-deposit-sent-end.excerpt.txt", import.meta.url), "utf8");
const MARKS = Object.keys(WHY);
const bad = (...ks) => ks.map((k) => `BAD ${WHY[k]}`);

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: the card's build before the review fold (6f20021b): FAIL on every rule the fold added", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, bad(...MARKS.filter((k) => k !== "solLeft")));
});

test("recorded bad answer: the card's build at 37abecea, before the delta review fold: FAIL on every rule that fold added", () => {
  const v = judge(ANSWERS.bad37a);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, bad("solEnd", "solKind", "evmEnd", "solRung", "evmRung", "loops", "windows", "waits", "stopWait"));
});

test("recorded bad answer: the card's build at c3cb08c8, before the fold of the delta review of bce5cde5: FAIL on every rule that fold added", () => {
  const v = judge(ANSWERS.badc3c);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, bad("solEnd", "evmEnd", "loops", "windows", "stopWait"));
});

test("recorded bad answer: the card's build at 09542dc6, before the fold of its delta review's five Lows: FAIL on every rule that fold added", () => {
  const v = judge(ANSWERS.bad095);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, bad("solEnd", "evmEnd", "evmLeft", "loops", "windows", "waits", "stopWait"));
});

for (const k of ["bad5a9", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, each path named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, bad(...MARKS));
  });
}

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const k of MARKS) assert.deepEqual(judge({ ...g, [k]: k === "loops" ? 1 : false }).lines, bad(k), k);
  assert.equal(judge(null).ok, false);
});

test("the facts read from this build's excerpt: every mark", () => {
  const f = facts("", EXCERPT);
  for (const k of MARKS) assert.equal(k === "loops" ? f.loops === 2 : f[k], true, k);
});

// [what, [text in the excerpt, its replacement], ..., the fact that must turn false]
const PLANTED = [
  // review 7's mutants
  ["the Solana hand-off removed", [["e.left?.({notes:n,landed:c>0,whole:p===0})", "void 0"]], "solLeft"],
  ["the EVM hand-off removed", [["e.left?.({notes:t,landed:c>0,whole:f})", "void 0"]], "evmLeft"],
  ["the Solana heights read on RPC 0 only", [["t(e.rpcs[0]),t(e.rpcs[1])])", "t(e.rpcs[0]),t(e.rpcs[0])])"]], "solFinals"],
  ["failedOnBoth on one RPC", [["n[t]||r.every(e=>e[t])", "n[t]||r.some(e=>e[t])"]], "solEnd"],
  ["the mark read at confirmed", [["await GP(e,i,`finalized`,n?.[t])", "await GP(e,i,`confirmed`,n?.[t])"]], "solMark"],
  ["noteEnd's leaf check removed", [["?(nF(e),await eF(t,n,r.precommitment,f),`landed`)", "?`landed`"]], "solEnd"],
  ["a mark at another value read as landed", [["f.value===o?(nF(e),await eF", "f.value!==null?(nF(e),await eF"]], "solEnd"],
  ["bothLanded on one RPC", [["t.some((e,t)=>n.every(e=>e[t]))", "t.some((e,t)=>n.some(e=>e[t]))"]], "solEnd"],
  // the fold's rules
  ["every send dead read as dead (review 1)", [["d.every(Boolean)?`expired`:null", "d.every(Boolean)?`dead`:null"]], "solEnd"],
  ["the note followed by its captured sends only (review 1)", [["let c=s?.sends?.length?s.sends:r.sends;", "let c=r.sends;"]], "solEnd"],
  ["the mark read with no slot pin (review 2)", [["f=await qP(e,r.precommitment,[l[0].slot,l[1].slot],i)", "f=await qP(e,r.precommitment)"]], "solEnd"],
  ["the account read drops minContextSlot (review 2)", [["...r===void 0?{}:{minContextSlot:r}", "...{}"]], "solMark"],
  ["the heights read with no slot (review 2)", [["slot:zP(t?.absoluteSlot)", "slot:0"]], "solFinals"],
  ["part_filled with an open send read as the end (review 3, Solana)", [["u.stage===`part_filled`&&(e===null||e.notes.length===0)", "u.stage===`part_filled`"]], "solKind"],
  ["the Solana kind's throw path drops the hand-off (review 5)", [["u=null;try{u=await aF(l,n)}finally{try{", "u=await aF(l,n);{try{"]], "solKind"],
  ["the pass never started (review 1)", [["f&&e.settle?.(),d||(u=FP)", "d||(u=FP)"]], "loops"],
  ["no stop at sign out (review 4)", [["if(o[n]!==null)continue;if(e.signal?.aborted)return null;let t=await tF", "if(o[n]!==null)continue;let t=await tF"]], "loops"],
  ["a give-up on a clock back in (fold review 5)", [["d||(u=FP),await n(u),s+=u,d&&", "d||(u=FP);if(s+u>36e5)return null;await n(u),s+=u,d&&"]], "loops"],
  ["no backoff (review 4)", [["d&&(u=Math.min(u*2,IP))", "d&&(u=u)"]], "loops"],
  ["filled without the whole ask sent (S9)", [["return e.signal?.aborted?null:t.whole&&o.length>0", "return e.signal?.aborted?null:o.length>0"]], "loops"],
  ["the hand-off keeps settled sends (S12)", [["let t=new Set(d().map(e=>e.hash))", "let t=new Set(l.map(e=>e.hash))"]], "solLeft"],
  ["EVM: the round read before U's nonce (E1)", [["let s=await bI(e.rpcs,async(e,n)=>gI(await e(`eth_getTransactionCount`,[t.u,`finalized`]),`rpc ${n} finalized nonce`));nF(e);let c=await e.round(e.signal),", "let c=await e.round(e.signal);nF(e);let s=await bI(e.rpcs,async(e,n)=>gI(await e(`eth_getTransactionCount`,[t.u,`finalized`]),`rpc ${n} finalized nonce`)),"]], "evmEnd"],
  ["EVM: the first send's nonce (E8)", [["(i?.evmSends??[]).reduce((e,t)=>t.nonce>e?t.nonce:e,t.nonce)", "(i?.evmSends?.[0]?.nonce??t.nonce)"]], "evmEnd"],
  ["EVM: a Deposited not final read as an end (E4)", [["l.block>c.finalBlock?null:", ""]], "evmEnd"],
  ["EVM: a Deposited at another value read as landed (E5)", [["l.value===t.value?`landed`:`dead`}", "`landed`}"]], "evmEnd"],
  ["EVM: every send dead read as dead (review 1)", [["s[0]>a&&s[1]>a?`expired`:null", "s[0]>a&&s[1]>a?`dead`:null"]], "evmEnd"],
  ["EVM: the store read before the keys are zeroed (review 6)", [["finally{n.fill(0);for(let e of r)e.fill(0);let i=p;", "finally{let i=p;"]], "evmLeft"],
  ["EVM: part_filled with an open note read as the end (review 3)", [["e.stage===`part_filled`&&(a===null||a.notes.length===0)", "e.stage===`part_filled`"]], "evmKind"],
  // the delta review's fold
  ["a Solana rung's landing posted as filled (fold review 1)", [["e.landed?.(a),`landed`}", "e.landed?.(a),n&&e.progress?.(`filled`),`landed`}"]], "solRung"],
  ["an EVM note's landing posted as filled (fold review 1)", [["l.note.leaf.value);continue}", "l.note.leaf.value),e.progress?.(`filled`);continue}"]], "evmRung"],
  ["the Solana kind posts only part_filled after its answer (fold review 1)", [["i?n?r?.progress(u.stage):", "i?n?u.stage===`part_filled`&&r?.progress(u.stage):"]], "solKind"],
  ["the EVM kind posts no end after its answer (fold review 1)", [["i?o?r?.progress(e.stage):", "i?o?void 0:"]], "evmKind"],
  ["the Solana record read through the note store (fold review 6)", [["s=(await e.records()).find(", "s=(await (await e.notes()).list()).find("]], "solEnd"],
  ["the EVM record read through the note store (fold review 6)", [["i=(await e.records()).find(", "i=(await (await e.notes()).list()).find("]], "evmEnd"],
  // the delta review of 09542dc6's five Lows
  ["a Solana read that may land counted so past its window (low 1)", [["t===null&&s-l[n]<12e4&&(d=!1)", "t===null&&(d=!1)"]], "loops"],
  ["an EVM read that may land counted so past its window (low 1)", [["t===null&&i-o[n]<15e5&&(c=!1)", "t===null&&(c=!1)"]], "loops"],
  ["no new window for a note the pass sends anew (low 1)", [["e=>void(e!==c[n]&&(c[n]=e,l[n]=s))", "e=>void 0"]], "loops"],
  ["no new window for an EVM note the pass sends anew (low 1)", [["e=>void(e!==a[n]&&(a[n]=e,o[n]=i))", "e=>void 0"]], "loops"],
  ["the Solana window stretched to ten minutes (low 1)", [["s-l[n]<12e4&&", "s-l[n]<6e5&&"]], "windows"],
  ["the EVM per-note stop removed (low 4)", [["if(r[n]!==null)continue;if(e.signal?.aborted)return null;", "if(r[n]!==null)continue;"]], "loops"],
  ["no stop before the Solana heights (low 4)", [["a(c[c.length-1].signature),nF(e);let l=await YP(e)", "a(c[c.length-1].signature);let l=await YP(e)"]], "solEnd"],
  ["no stop before U's nonce (low 4)", [["o!==void 0&&n(o.hash),nF(e);let s=await bI(", "o!==void 0&&n(o.hash);let s=await bI("]], "evmEnd"],
  ["the stop helper never stops (low 4)", [["function nF(e){if(e.signal?.aborted)throw Error(`signed out`)}", "function nF(e){}"]], "evmEnd"],
  ["the wait's timer not cleared at sign out (low 4)", [["clearTimeout(i),", ""]], "waits"],
  ["the Solana reads' wait not given the sign out (low 4)", [["let n=e.wait??(t=>LP(t,e.signal)),r=async", "let n=e.wait??(t=>LP(t)),r=async"]], "waits"],
  ["an EVM hand-off whose store read fails hands no note (low 5)", [["catch{t=[...u.values()]}", "catch{}"]], "evmLeft"],
  // the delta review of bce5cde5: a wait inside a note's reads not ended in the stop (M1); a new send that starts no new
  // window, or only the follower's own kick starting one (info)
  ["the Solana end's wait inside a note's reads not ended in the stop (review 2 M1)", [["r=async t=>{await n(t),nF(e)}", "r=async t=>{await n(t)}"]], "stopWait"],
  ["the Solana end's reads given the bare wait (review 2 M1)", [["await tF(e,i,a,u,r,", "await tF(e,i,a,u,n,"]], "stopWait"],
  ["the Solana end hands the follower no newest send (review 2)", [["a(c[c.length-1].signature),nF(e);", "nF(e);"]], "solEnd"],
  ["the EVM end hands the follower no newest send (review 2)", [["o!==void 0&&n(o.hash),nF(e);", "nF(e);"]], "evmEnd"],
  ["only the Solana follower's own kick starts a new window (review 2)", [["e=>void(e!==c[n]&&(c[n]=e,l[n]=s))", "e=>void 0"], ["t===`expired`?f=!0:", "t===`expired`?(f=!0,l[n]=s):"]], "loops"],
  ["only the EVM follower's own kick starts a new window (review 2)", [["e=>void(e!==a[n]&&(a[n]=e,o[n]=i))", "e=>void 0"], ["t===`expired`?l=!0:", "t===`expired`?(l=!0,o[n]=i):"]], "loops"],
];

for (const [what, pairs, k] of PLANTED) {
  test(`planted in the excerpt: ${what}: ${k} FAILs`, () => {
    let out = EXCERPT;
    for (const [from, to] of pairs) {
      assert.equal(out.split(from).length, 2, `planted: ${from} is not in the excerpt once`);
      out = out.split(from).join(to);
    }
    const f = facts("", out);
    assert.equal(k === "loops" ? f.loops === 2 : f[k], false, `${what} still holds ${k}`);
  });
}
