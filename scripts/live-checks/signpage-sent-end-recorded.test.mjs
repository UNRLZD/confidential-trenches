// node --test scripts/live-checks/signpage-sent-end-recorded.test.mjs: the live check's verdict replays recorded answers
// (signpage-sent-end-recorded.answers.json), each facts() over a tree's index.html and app.js:
//   good: this card's branch, built with packages/signpage/scripts/build-app.mjs --out: the index pins the bundle, and it
//         writes the op at sent with its legs, asks it at the sent answer, tells only the buy's own tx, ends that op alone,
//         settles a dead tab's op as the run would (its lock, its marks, its pace), and frees a note on both RPCs: PASS;
//   bad:  main 2d870021c's sign sources built the same way: none of this card's marks: FAIL on each.
// Planted from those: each mark alone missing, a near miss of each mark's minified shape, and an index that pins another
// bundle or none.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { facts, judge } from "./signpage-sent-end-recorded.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-sent-end-recorded.answers.json"), "utf8"));
const MARKS = ["sent", "asked", "round", "legs", "end", "settle", "lock", "marks", "two"];
const mut = (f) => {
  const a = structuredClone(ANSWERS.good);
  f(a);
  return judge(a);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: the branch's build: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: main 2d870021c's build: FAIL, naming each missing mark", () => {
  const r = judge(ANSWERS.bad);
  for (const m of MARKS.filter((x) => x !== "two")) fails(r, new RegExp(`^BAD ${m}:`));
});

test("planted: each mark alone, and the index's pin", () => {
  for (const m of MARKS) fails(mut((a) => (a[m] = false)), new RegExp(`^BAD ${m}:`));
  fails(mut((a) => (a.sha384 = ANSWERS.bad.sha384)), /not the one index\.html pins/);
  fails(mut((a) => (a.index = "<html></html>")), /pins no \/app\.js/);
});

// the build's own minified shapes (read from the good build), and a near miss of each
const INDEX = '<script src="/app.js" integrity="x"></script>';
const SENT = "if(s===`sent`){if(u.length===0||`error`in r)return;let i=r.result.txs.map(e=>$Q(e)),a=i.every(e=>e!==null)?u.map((e,t)=>({...e,...i[t]})):u;await e.put(`ops`,t,{kind:`buy`,stage:s,txs:a,created_ms:n.createdMs,chain:`solana`});return}";
const ASKED = "e!==null&&e.result.stage===`sent`&&u(e.result.txs.map(e=>({chain:e.chain,hash:e.hash})))";
const AT = "let a={result:{stage:`sent`,txs:t.map(e=>({...e,...Ut.get(e.hash)}))}};for(let e of t)Ut.delete(e.hash)";
const ROUND = "!l&&!ne&&V[0]&&V[1])try{e.sendAt?.(R,Yo(i).message.blockhash,a,{id:t.noteId,attempt:t.attempt,pieces:c.map(e=>e.r.noteId),program:j.program,feePayer:j.feePayer,wallet:t.wallet.address,nullifier:BigInt(t.publicSignals[1]).toString(),context:t.binding.context.toString()})}catch{}if(!l&&!ne&&V[0]&&V[1]&&(ne=!0,m(R),await e.sent?.(R))";
const END = "a=i!==void 0&&i.kind===`buy`&&i.stage===`sent`;if(i!==void 0&&(!a||`error`in r))return;let o=n.price===null?null:QQ(n.spend,n.spendDecimals,n.price),s=`error`in r?`refused`:r.result.stage;if(s===`sent`?a:!e_e.has(s))return;let c=new Set(a&&Array.isArray(i.txs)?i.txs.flatMap(e=>e?.leg===!0&&typeof e.hash==`string`?[e.hash]:[]):[]),l=`error`in r?[]:r.result.txs.map(e=>({chain:e.chain,hash:e.hash,...s===`sent`||c.has(e.hash)?{leg:!0}:{}})),u=l.length===0&&a&&Array.isArray(i.txs)?i.txs:l;";
const FILL_LEGS = "let n=i.txs.filter(e=>e.leg===!0),a=i.kind===`buy`?(n.length>0?n:i.txs.slice(0,1)).map(e=>e.hash):i.txs.map(e=>e.hash)";
const SETTLE = "if(s?.kind!==`buy`||s.chain!==`solana`||s.stage!==`sent`||!Array.isArray(s.txs)||s.txs.length===0)continue;let c=s.txs,l=c.map(e=>typeof e==`object`&&e&&typeof e.hash==`string`?$Q(e):null);if(l.some(e=>e===null))continue;let u=a(),d=r.reads?.get(o);if(d!==void 0&&u-d.first>=r_e&&u-d.last<6e4||r.locks&&await r.locks.request(qU(o),{mode:`exclusive`,ifAvailable:!0},async e=>e===null))continue;r.reads?.set(o,{first:d?.first??u,last:u});let f=await Promise.all(c.map((e,n)=>nW(t,{sig:e.hash,lvbh:l[n].lvbh,blockhash:l[n].blockhash})));if(f.some(e=>e===`unknown`))continue;let p=await Promise.all(f.map((e,t)=>i_e(e,l[t].note,n).catch(()=>null)));if(p.some(e=>e===null))continue;let m=sG(p),h=!1;await e.update(`ops`,o,e=>{let t=e;return t?.kind!==`buy`||t.stage!==`sent`?e:(h=!0,{...c.reduce((e,t,n)=>iW(e,t.hash,f[n]),t),stage:m})})";
const LEG_END = "async function i_e(e,t,n){if(e===`not_landed`)return`not_landed`;if(e===`filled`)return aG(await n.note(t.id),t.attempt,()=>n.owner(t));let r=await Promise.all([t.id,...t.pieces].map(async e=>(await n.note(e))?.state));return r.some(e=>e===`SPENT`)?`not_landed`:r.some(e=>e===void 0||e===`RESERVED`)?null:`refused`}";
const PAST = "var r_e=uW+13e3";
const LIFE = "var uW=9e4,dW=1";
const LEGS = "function sG(e){let t=e.filter(e=>e!==null);return t.length===0?null:t.length===e.length&&t.every(e=>e===`filled`)?`filled`:t.includes(`sent`)||t.includes(`signed`)?`sent`:t.some(e=>e===`filled`||e===`part_filled`)?`part_filled`:t.every(e=>e===`refused`)?`refused`:`not_landed`}";
const TRADE_LOCK = "var qU=e=>`ct-wallet/trade/${e}`";
const HOLD = "Gn&&Gn.request(qU(n.id),{mode:`exclusive`},()=>g).catch(()=>{})";
const TWO = "l=c===null?void 0:BigInt(Math.min(c[0].height,c[1].height))";
const ALL = { SENT, ASKED, AT, ROUND, END, FILL_LEGS, SETTLE, LEG_END, PAST, LIFE, LEGS, TRADE_LOCK, HOLD, TWO };

test("facts() reads each mark from the minified code as the build writes it", () => {
  const all = facts(INDEX, Object.values(ALL).join(";"));
  assert.deepEqual(MARKS.map((m) => all[m]), MARKS.map(() => true));
});

test("planted near misses: each mark's shape one step off is no mark", () => {
  // [mark, part of ALL it changes, the near miss]
  const near = [
    // a sent put with no transaction check (a sent op with none would be refused by trade.ts as a trade-box one)
    ["sent", "SENT", SENT.replace("if(u.length===0||`error`in r)return;", "")],
    // the run's fields never kept beside the sent op
    ["sent", "SENT", SENT.replace("a=i.every(e=>e!==null)?u.map((e,t)=>({...e,...i[t]})):u;", "a=u;")],
    // the sent answer seen but no write asked with its transactions, or the run's fields not carried into the op
    ["asked", "ASKED", ASKED.replace("&&u(e.result.txs.map(", "&&u(e.result.map(")],
    ["asked", "AT", AT.replace("...Ut.get(e.hash)", "...e")],
    // review 1: a first round's release told sent (the round flag off either guard), or sendAt with no notes
    ["round", "ROUND", ROUND.replace("if(!l&&!ne&&", "if(!ne&&")],
    ["round", "ROUND", ROUND.replace("!l&&!ne&&V[0]&&V[1])try{", "!ne&&V[0]&&V[1])try{")],
    ["round", "ROUND", ROUND.replace(",{id:t.noteId,attempt:t.attempt,pieces:c.map(e=>e.r.noteId),program:j.program,feePayer:j.feePayer,wallet:t.wallet.address,nullifier:BigInt(t.publicSignals[1]).toString(),context:t.binding.context.toString()})", ")")],
    // review 2: no leg mark on a sent tx, the end's legs dropped, or the fill reads the first tx only
    ["legs", "END", END.replace("...s===`sent`||c.has(e.hash)?{leg:!0}:{}", "...c.has(e.hash)?{leg:!0}:{}")],
    ["legs", "END", END.replace("i.txs.flatMap(e=>e?.leg===!0&&typeof e.hash==`string`?[e.hash]:[])", "[]")],
    ["legs", "FILL_LEGS", FILL_LEGS.replace("(n.length>0?n:i.txs.slice(0,1))", "i.txs.slice(0,1)")],
    // an op already there written over by any answer, or sent's txs dropped at an end with none
    ["end", "END", END.replace("(!a||`error`in r)", "!a")],
    ["end", "END", END.replace("u=l.length===0&&a&&Array.isArray(i.txs)?i.txs:l;", "u=l;")],
    // an unknown read ending the op, an end written over, another chain's op read, a leg not known ending it
    ["settle", "SETTLE", SETTLE.replace("if(f.some(e=>e===`unknown`))continue;", "")],
    ["settle", "SETTLE", SETTLE.replace("t?.kind!==`buy`||t.stage!==`sent`?e:", "t?.kind!==`buy`?e:")],
    ["settle", "SETTLE", SETTLE.replace("||s.chain!==`solana`", "")],
    ["settle", "SETTLE", SETTLE.replace("if(p.some(e=>e===null))continue;", "")],
    // the stage not legsStage's, or kept as noted()'s
    ["settle", "SETTLE", SETTLE.replace(",t),stage:m})", ",t)})")],
    ["settle", "LEGS", LEGS.replace("t.every(e=>e===`refused`)?`refused`:`not_landed`", "`not_landed`")],
    // review 4: no slow pace, or one that starts before the blockhash's life and finality
    ["settle", "SETTLE", SETTLE.replace("d!==void 0&&u-d.first>=r_e&&u-d.last<6e4||", "")],
    ["settle", "PAST", PAST.replace("+13e3", "")],
    ["settle", "LIFE", LIFE.replace("9e4", "9e3")],
    // review 3: no lock probe, the page holds none, or holds another name
    ["lock", "SETTLE", SETTLE.replace("||r.locks&&await r.locks.request(qU(o),{mode:`exclusive`,ifAvailable:!0},async e=>e===null)", "")],
    ["lock", "HOLD", HOLD.replace("Gn.request(qU(n.id)", "Gn.request(qU(n.sha)")],
    ["lock", "TRADE_LOCK", TRADE_LOCK.replace("ct-wallet/trade/", "ct-wallet/trades/")],
    // review 5: a landed leg filled with no owner read, a failed one's spent note read refused, a reserved one ended
    ["marks", "LEG_END", LEG_END.replace("return aG(await n.note(t.id),t.attempt,()=>n.owner(t))", "return`filled`")],
    ["marks", "LEG_END", LEG_END.replace("r.some(e=>e===`SPENT`)?`not_landed`:", "")],
    ["marks", "LEG_END", LEG_END.replace("[t.id,...t.pieces]", "[t.id]")],
    ["marks", "LEG_END", LEG_END.replace("r.some(e=>e===void 0||e===`RESERVED`)?null:`refused`", "`refused`")],
    // the higher height: one RPC's word frees the note
    ["two", "TWO", TWO.replace("Math.min", "Math.max")],
  ];
  for (const [mark, part, js] of near) {
    assert.notEqual(js, ALL[part], `${mark} (${part}): the near miss changes the shape`);
    const f = facts(INDEX, Object.entries(ALL).map(([k, v]) => (k === part ? js : v)).join(";"));
    assert.equal(f[mark], false, `${mark} (${part}): the near miss is read as no mark`);
    for (const m of MARKS.filter((x) => x !== mark)) assert.equal(f[m], true, `${mark} (${part}): ${m} still read`);
  }
});
