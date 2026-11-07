// node --test scripts/live-checks/pool-deposit-sent-end.test.mjs: the live check replays its recorded answers
// (pool-deposit-sent-end.answers.json). good: this card's SIGN_HOST build: PASS. bad: main 5a9e5d8c's build, and
// liveBefore: SIGN_HOST before this card's deploy: each FAIL, each path named. Planted on the good one: another
// /app.js, no pin, each mark taken away: each FAIL. Planted in a bundle: one RPC's height or nonce taken as the end, the
// mark read before the heights (or the round before the nonce), a Deposited above the finalized block taken as landed,
// a kind that posts nothing after its run, and reads that end before each note is decided: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./pool-deposit-sent-end.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pool-deposit-sent-end.answers.json", import.meta.url), "utf8"));
const NO_SOL_DEAD = "BAD a Solana deposit's send is read dead on one RPC's height, or before its mark: the app may hear not_landed for a deposit that lands";
const NO_SOL_KIND = "BAD a Solana deposit whose run ends past its send with no end tells the app nothing more: the app sits at sent";
const NO_EVM_DEAD = "BAD an EVM deposit's send is read dead on one RPC's nonce, or on a Deposited not final: the app may hear not_landed for a deposit that lands";
const NO_EVM_KIND = "BAD an EVM deposit whose run ends at sent tells the app nothing more: the app sits at sent";
const NO_LOOPS = "BAD a kind's reads after its run end before each open note is landed or dead: the app may hear an end that is not one";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

for (const k of ["bad", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, each path named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, [NO_SOL_DEAD, NO_SOL_KIND, NO_EVM_DEAD, NO_EVM_KIND, NO_LOOPS]);
  });
}

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, solDead: false }).lines, [NO_SOL_DEAD]);
  assert.deepEqual(judge({ ...g, solKind: false }).lines, [NO_SOL_KIND]);
  assert.deepEqual(judge({ ...g, evmDead: false }).lines, [NO_EVM_DEAD]);
  assert.deepEqual(judge({ ...g, evmKind: false }).lines, [NO_EVM_KIND]);
  assert.deepEqual(judge({ ...g, loops: 1 }).lines, [NO_LOOPS]);
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle", () => {
  // the minified shapes as this card's build spells them
  const js =
    "async function GP(e,t,n,r){let i=await zP(e),a=r.sends.map(e=>i.every(t=>t>e.last_valid_block_height)),o=a.every(Boolean)?a:await UP(e,r.sends,a),s=await LP(e,r.precommitment);return s===`one`?null:s===null?o.every(Boolean)?`dead`:null:s.value===r.sends[0].value?(await WP(t,n,r.precommitment,s),`landed`):await HP(e,r.sends)?null:`dead`}" +
    "async function KP(e,t){let n=e.wait??(e=>new Promise(t=>setTimeout(t,e))),r=AE(e.rpcs,e.pin.program),{scope:i}=_E(e.pin.program),a=t.notes.map(()=>null);for(;;){for(let[n,o]of t.notes.entries())a[n]??=await GP(e,r,i,o).catch(()=>null);if(a.every(e=>e!==null))break;await n(DP)}return t.whole&&a.length>0&&a.every(e=>e===`landed`)?`filled`:t.landed||a.includes(`landed`)?`part_filled`:`not_landed`}" +
    "try{let e=await JP(l,n),a=c,o=`stage`in e&&(e.stage===`filled`||e.stage===`part_filled`);i?o?e.stage===`part_filled`&&r?.progress(e.stage):a!==null&&(s={h:t,left:a}):i=`error`in e?{error:e.error}:{result:e}}finally{t.end?.()}})).catch(()=>{i||={error:`failed`}}).finally(a).then(()=>{let e=s;if(e!==null&&r!==null)return KP(e.h,e.left).then(e=>r.progress(e),()=>{})}),{running:!0}" +
    "async function xI(e,t){let n=await lI(e.rpcs,async(e,n)=>aI(await e(`eth_getTransactionCount`,[t.u,`finalized`]),`rpc ${n} finalized nonce`)),r=await e.round(),i=r.events.find(e=>e.kind===`deposit`&&e.precommitment===t.precommitment);return i===void 0?n[0]>t.nonce&&n[1]>t.nonce?`dead`:null:i.block>r.finalBlock?null:i.value===t.value?`landed`:`dead`}" +
    "async function SI(e,t){let n=e.wait??(e=>new Promise(t=>setTimeout(t,e))),r=t.notes.map(()=>null);for(;;){for(let[n,i]of t.notes.entries())r[n]??=await xI(e,i).catch(()=>null);if(r.every(e=>e!==null))break;await n(ZF)}return t.whole&&r.length>0&&r.every(e=>e===`landed`)?`filled`:t.landed||r.includes(`landed`)?`part_filled`:`not_landed`}" +
    "try{let e=await CI({...t,sent:s,progress:u,left:e=>void(d=e)},n),a=d,o=`stage`in e&&(e.stage===`filled`||e.stage===`part_filled`);i?o?r?.progress(e.stage):a!==null&&(l={h:t,left:a}):i=`error`in e?{error:e.error}:{result:e}}finally{t.end?.()}})).then(a,e=>{if(e instanceof uP&&!i)return o(e);i||={error:`failed`},a()}).then(()=>{let e=l;if(e!==null&&r!==null)return SI(e.h,e.left).then(e=>r.progress(e),()=>{})}),{running:!0}";
  const f = facts("", js);
  assert.deepEqual({ ...f, sha384: null }, { index: "", sha384: null, solDead: true, solKind: true, evmDead: true, evmKind: true, loops: 2 });
  // each mark changed in place, once (a mark found twice or not at all is a broken test, never a pass)
  const planted = (...pairs) => {
    let out = js;
    for (let i = 0; i < pairs.length; i += 2) {
      assert.equal(out.split(pairs[i]).length, 2, `planted: ${pairs[i]} is not in the bundle once`);
      out = out.split(pairs[i]).join(pairs[i + 1]);
    }
    return facts("", out);
  };
  // one RPC's height past the send taken as its expiry
  assert.equal(planted("i.every(t=>t>e.last_valid_block_height)", "i.some(t=>t>e.last_valid_block_height)").solDead, false, "one RPC's height");
  // the mark read before the heights (a send that lands between the reads read dead)
  assert.equal(planted("let i=await zP(e),a=r.sends.map(e=>i.every(t=>t>e.last_valid_block_height)),o=a.every(Boolean)?a:await UP(e,r.sends,a),s=await LP(e,r.precommitment);", "let s=await LP(e,r.precommitment),i=await zP(e),a=r.sends.map(e=>i.every(t=>t>e.last_valid_block_height)),o=a.every(Boolean)?a:await UP(e,r.sends,a);").solDead, false, "mark first");
  // no mark read as dead whether or not the sends are
  assert.equal(planted("s===null?o.every(Boolean)?`dead`:null:", "s===null?`dead`:").solDead, false, "no mark alone");
  // a mark on one RPC read as dead
  assert.equal(planted("return s===`one`?null:", "return s===`one`?`dead`:").solDead, false, "a mark on one RPC");
  // EVM: one RPC's finalized nonce
  assert.equal(planted("n[0]>t.nonce&&n[1]>t.nonce", "n[0]>t.nonce||n[1]>t.nonce").evmDead, false, "one RPC's nonce");
  // EVM: the round read before the nonce (a send final between the reads read dead)
  assert.equal(planted("let n=await lI(e.rpcs,async(e,n)=>aI(await e(`eth_getTransactionCount`,[t.u,`finalized`]),`rpc ${n} finalized nonce`)),r=await e.round(),", "let r=await e.round(),n=await lI(e.rpcs,async(e,n)=>aI(await e(`eth_getTransactionCount`,[t.u,`finalized`]),`rpc ${n} finalized nonce`)),").evmDead, false, "round first");
  // EVM: a Deposited above the finalized block taken as landed
  assert.equal(planted("i.block>r.finalBlock?null:", "").evmDead, false, "not final");
  // a kind that posts nothing after its run (the reads never started), or keeps no notes when its run is no end
  assert.equal(planted("KP(e.h,e.left).then(e=>r.progress(e),()=>{})", "KP(e.h,e.left)").solKind, false, "Solana: no post");
  assert.equal(planted("e.stage===`part_filled`&&r?.progress(e.stage):a!==null&&(s={h:t,left:a})", "r?.progress(e.stage):void 0").solKind, false, "Solana: no notes kept");
  assert.equal(planted("SI(e.h,e.left).then(e=>r.progress(e),()=>{})", "SI(e.h,e.left)").evmKind, false, "EVM: no post");
  assert.equal(planted("i?o?r?.progress(e.stage):a!==null&&(l={h:t,left:a}):", "i?e.stage!==`sent`&&r?.progress(e.stage):").evmKind, false, "EVM: no notes kept (main's form)");
  // reads that end on the first note decided, or that tell not_landed while one is still open
  assert.equal(planted("if(a.every(e=>e!==null))break;", "if(a.some(e=>e!==null))break;").loops, 1, "Solana: one decided");
  assert.equal(planted("if(r.every(e=>e!==null))break;await n(ZF)}", "break}").loops, 1, "EVM: no wait");
});
