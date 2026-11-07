// node --test scripts/live-checks/pool-deposit-sent-end.test.mjs: the live check replays its recorded answers
// (pool-deposit-sent-end.answers.json). good: this card's build with the delta review of 09542dc6 folded: PASS. bad095:
// the card's build at 09542dc6, bad37a: the card's build at 37abecea, bad: the card's build before the first fold
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
  assert.deepEqual(v.lines, bad("solEnd", "solKind", "evmEnd", "solRung", "evmRung", "loops", "windows", "waits"));
});

test("recorded bad answer: the card's build at 09542dc6, before the fold of its delta review's five Lows: FAIL on every rule that fold added", () => {
  const v = judge(ANSWERS.bad095);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, bad("solEnd", "evmEnd", "evmLeft", "loops", "windows", "waits"));
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
  ["the mark read at confirmed", [["await LP(e,i,`finalized`,n?.[t])", "await LP(e,i,`confirmed`,n?.[t])"]], "solMark"],
  ["noteEnd's leaf check removed", [["?(JP(e),await KP(t,n,r.precommitment,d),`landed`)", "?`landed`"]], "solEnd"],
  ["a mark at another value read as landed", [["d.value===a?(JP(e),await KP", "d.value!==null?(JP(e),await KP"]], "solEnd"],
  ["bothLanded on one RPC", [["t.some((e,t)=>n.every(e=>e[t]))", "t.some((e,t)=>n.some(e=>e[t]))"]], "solEnd"],
  // the fold's rules
  ["every send dead read as dead (review 1)", [["u.every(Boolean)?`expired`:null", "u.every(Boolean)?`dead`:null"]], "solEnd"],
  ["the note followed by its captured sends only (review 1)", [["let s=o?.sends?.length?o.sends:r.sends;", "let s=r.sends;"]], "solEnd"],
  ["the mark read with no slot pin (review 2)", [["d=await zP(e,r.precommitment,[c[0].slot,c[1].slot],i)", "d=await zP(e,r.precommitment)"]], "solEnd"],
  ["the account read drops minContextSlot (review 2)", [["...r===void 0?{}:{minContextSlot:r}", "...{}"]], "solMark"],
  ["the heights read with no slot (review 2)", [["slot:jP(t?.absoluteSlot)", "slot:0"]], "solFinals"],
  ["part_filled with an open send read as the end (review 3, Solana)", [["u.stage===`part_filled`&&(e===null||e.notes.length===0)", "u.stage===`part_filled`"]], "solKind"],
  ["the Solana kind's throw path drops the hand-off (review 5)", [["u=null;try{u=await ZP(l,n)}finally{try{", "u=await ZP(l,n);{try{"]], "solKind"],
  ["the pass never started (review 1)", [["u&&e.settle?.(),l||(c=DP)", "l||(c=DP)"]], "loops"],
  ["no stop at sign out (review 4)", [["if(a[c]!==null)continue;if(e.signal?.aborted)return null;let t=await qP", "if(a[c]!==null)continue;let t=await qP"]], "loops"],
  ["a give-up on a clock back in (fold review 5)", [["l||(c=DP),await n(c),o+=c,l&&", "l||(c=DP);if(o+c>36e5)return null;await n(c),o+=c,l&&"]], "loops"],
  ["no backoff (review 4)", [["l&&(c=Math.min(c*2,OP))", "l&&(c=c)"]], "loops"],
  ["filled without the whole ask sent (S9)", [["return e.signal?.aborted?null:t.whole&&a.length>0", "return e.signal?.aborted?null:a.length>0"]], "loops"],
  ["the hand-off keeps settled sends (S12)", [["let t=new Set(d().map(e=>e.hash))", "let t=new Set(l.map(e=>e.hash))"]], "solLeft"],
  ["EVM: the round read before U's nonce (E1)", [["let a=await fI(e.rpcs,async(e,n)=>cI(await e(`eth_getTransactionCount`,[t.u,`finalized`]),`rpc ${n} finalized nonce`));JP(e);let o=await e.round(),", "let o=await e.round();JP(e);let a=await fI(e.rpcs,async(e,n)=>cI(await e(`eth_getTransactionCount`,[t.u,`finalized`]),`rpc ${n} finalized nonce`)),"]], "evmEnd"],
  ["EVM: the first send's nonce (E8)", [["(r?.evmSends??[]).reduce((e,t)=>t.nonce>e?t.nonce:e,t.nonce)", "(r?.evmSends?.[0]?.nonce??t.nonce)"]], "evmEnd"],
  ["EVM: a Deposited not final read as an end (E4)", [["s.block>o.finalBlock?null:", ""]], "evmEnd"],
  ["EVM: a Deposited at another value read as landed (E5)", [["s.value===t.value?`landed`:`dead`}", "`landed`}"]], "evmEnd"],
  ["EVM: every send dead read as dead (review 1)", [["a[0]>i&&a[1]>i?`expired`:null", "a[0]>i&&a[1]>i?`dead`:null"]], "evmEnd"],
  ["EVM: the store read before the keys are zeroed (review 6)", [["finally{n.fill(0);for(let e of r)e.fill(0);let i=p;", "finally{let i=p;"]], "evmLeft"],
  ["EVM: part_filled with an open note read as the end (review 3)", [["e.stage===`part_filled`&&(a===null||a.notes.length===0)", "e.stage===`part_filled`"]], "evmKind"],
  // the delta review's fold
  ["a Solana rung's landing posted as filled (fold review 1)", [["e.landed?.(a),`landed`}", "e.landed?.(a),n&&e.progress?.(`filled`),`landed`}"]], "solRung"],
  ["an EVM note's landing posted as filled (fold review 1)", [["l.note.leaf.value);continue}", "l.note.leaf.value),e.progress?.(`filled`);continue}"]], "evmRung"],
  ["the Solana kind posts only part_filled after its answer (fold review 1)", [["i?n?r?.progress(u.stage):", "i?n?u.stage===`part_filled`&&r?.progress(u.stage):"]], "solKind"],
  ["the EVM kind posts no end after its answer (fold review 1)", [["i?o?r?.progress(e.stage):", "i?o?void 0:"]], "evmKind"],
  ["the Solana record read through the note store (fold review 6)", [["o=(await e.records()).find(", "o=(await (await e.notes()).list()).find("]], "solEnd"],
  ["the EVM record read through the note store (fold review 6)", [["r=(await e.records()).find(", "r=(await (await e.notes()).list()).find("]], "evmEnd"],
  // the delta review of 09542dc6's five Lows
  ["a Solana read that may land counted so past its window (low 1)", [["t===null&&o-s[c]<12e4&&(l=!1)", "t===null&&(l=!1)"]], "loops"],
  ["an EVM read that may land counted so past its window (low 1)", [["t===null&&i-a[n]<15e5&&(s=!1)", "t===null&&(s=!1)"]], "loops"],
  ["no new window for a note the pass sends anew (low 1)", [["t===`expired`?(u=!0,s[c]=o):", "t===`expired`?u=!0:"]], "loops"],
  ["the Solana window stretched to ten minutes (low 1)", [["o-s[c]<12e4&&", "o-s[c]<6e5&&"]], "windows"],
  ["the EVM per-note stop removed (low 4)", [["if(r[n]!==null)continue;if(e.signal?.aborted)return null;", "if(r[n]!==null)continue;"]], "loops"],
  ["no stop before the Solana heights (low 4)", [["r.sends;JP(e);let c=await VP(e)", "r.sends;let c=await VP(e)"]], "solEnd"],
  ["no stop before U's nonce (low 4)", [["t.nonce);JP(e);let a=await fI(", "t.nonce);let a=await fI("]], "evmEnd"],
  ["the stop helper never stops (low 4)", [["function JP(e){if(e.signal?.aborted)throw Error(`signed out`)}", "function JP(e){}"]], "evmEnd"],
  ["the wait's timer not cleared at sign out (low 4)", [["clearTimeout(i),", ""]], "waits"],
  ["the Solana reads' wait not given the sign out (low 4)", [["let n=e.wait??(t=>kP(t,e.signal)),r=ME(", "let n=e.wait??(t=>kP(t)),r=ME("]], "waits"],
  ["an EVM hand-off whose store read fails hands no note (low 5)", [["catch{t=[...u.values()]}", "catch{}"]], "evmLeft"],
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
