// node --test scripts/live-checks/signpage-sent-end-recorded.test.mjs: the live check's verdict replays recorded answers
// (signpage-sent-end-recorded.answers.json), each facts() over a tree's index.html and app.js:
//   good: this card's branch, built with packages/signpage/scripts/build-app.mjs --out: the index pins the bundle, and it
//         writes the op at sent, asks it at the sent answer, ends that op alone, and frees a note on both RPCs: PASS;
//   bad:  main 2d870021c's sign sources built the same way: no sent write, no ask, no end onto sent: FAIL on each.
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
  fails(r, /^BAD sent:/);
  fails(r, /^BAD asked:/);
  fails(r, /^BAD end:/);
  fails(r, /^BAD settle:/);
});

test("planted: each mark alone, and the index's pin", () => {
  fails(mut((a) => (a.sent = false)), /^BAD sent:/);
  fails(mut((a) => (a.asked = false)), /^BAD asked:/);
  fails(mut((a) => (a.end = false)), /^BAD end:/);
  fails(mut((a) => (a.settle = false)), /^BAD settle:/);
  fails(mut((a) => (a.two = false)), /^BAD two:/);
  fails(mut((a) => (a.sha384 = ANSWERS.bad.sha384)), /not the one index\.html pins/);
  fails(mut((a) => (a.index = "<html></html>")), /pins no \/app\.js/);
});

// the build's own minified shapes (read from the good build), and a near miss of each
const INDEX = '<script src="/app.js" integrity="x"></script>';
const SENT = "if(s===`sent`){if(l.length===0||`error`in r)return;let i=r.result.txs.map(e=>$Q(e)),a=i.every(e=>e!==null)?l.map((e,t)=>({...e,...i[t]})):l;await e.put(`ops`,t,{kind:`buy`,stage:s,txs:a,created_ms:n.createdMs,chain:`solana`});return}";
const ASKED = "e!==null&&e.result.stage===`sent`&&u(e.result.txs.map(e=>({chain:e.chain,hash:e.hash})))";
const AT = "let a={result:{stage:`sent`,txs:t.map(e=>({...e,...Ut.get(e.hash)}))}};for(let e of t)Ut.delete(e.hash)";
const TOLD = "try{e.sendAt?.(R,ts(i).message.blockhash,a)}catch{}";
const END = "a=i!==void 0&&i.kind===`buy`&&i.stage===`sent`;if(i!==void 0&&(!a||`error`in r))return;let o=n.price===null?null:QQ(n.spend,n.spendDecimals,n.price),s=`error`in r?`refused`:r.result.stage;if(s===`sent`?a:!Xge.has(s))return;let c=`error`in r?[]:r.result.txs.map(e=>({chain:e.chain,hash:e.hash})),l=c.length===0&&a&&Array.isArray(i.txs)?i.txs:c;";
const SETTLE = "if(a?.kind!==`buy`||a.chain!==`solana`||a.stage!==`sent`||!Array.isArray(a.txs)||a.txs.length===0)continue;let o=a.txs,s=o.map(e=>typeof e==`object`&&e&&typeof e.hash==`string`?$Q(e):null);if(s.some(e=>e===null))continue;let c=await Promise.all(o.map((e,n)=>nW(t,{sig:e.hash,lvbh:s[n].lvbh,blockhash:s[n].blockhash})));if(c.some(e=>e===`unknown`))continue;let l=!1;await e.update(`ops`,i,e=>{let t=e;return t?.kind!==`buy`||t.stage!==`sent`?e:(l=!0,o.reduce((e,t,n)=>iW(e,t.hash,c[n]),t))})";
const TWO = "l=c===null?void 0:BigInt(Math.min(c[0].height,c[1].height))";
const ALL = { SENT, ASKED, AT, TOLD, END, SETTLE, TWO };

test("facts() reads each mark from the minified code as the build writes it", () => {
  const all = facts(INDEX, Object.values(ALL).join(";"));
  assert.deepEqual([all.sent, all.asked, all.end, all.settle, all.two], [true, true, true, true, true]);
});

test("planted near misses: each mark's shape one step off is no mark", () => {
  // [mark, part of ALL it changes, the near miss]
  const near = [
    // a sent put with no transaction check (a sent op with none would be refused by trade.ts as a trade-box one)
    ["sent", "SENT", SENT.replace("if(l.length===0||`error`in r)return;", "")],
    // the blockhash fields never kept beside the sent op
    ["sent", "SENT", SENT.replace("a=i.every(e=>e!==null)?l.map((e,t)=>({...e,...i[t]})):l;", "a=l;")],
    // the sent answer seen but no write asked with its transactions
    ["asked", "ASKED", ASKED.replace("&&u(e.result.txs.map(", "&&u(e.result.map(")],
    // the run's blockhash not carried into the op
    ["asked", "AT", AT.replace("...Ut.get(e.hash)", "...e")],
    // the run tells no blockhash from its signed bytes
    ["asked", "TOLD", TOLD.replace("ts(i).message.blockhash", "R")],
    // an op already there written over by any answer, or sent's txs dropped at an end with none
    ["end", "END", END.replace("(!a||`error`in r)", "!a")],
    ["end", "END", END.replace("l=c.length===0&&a&&Array.isArray(i.txs)?i.txs:c;", "l=c;")],
    // an unknown read ending the op, an end written over, or another chain's op read
    ["settle", "SETTLE", SETTLE.replace("if(c.some(e=>e===`unknown`))continue;", "")],
    ["settle", "SETTLE", SETTLE.replace("t?.kind!==`buy`||t.stage!==`sent`?e:", "t?.kind!==`buy`?e:")],
    ["settle", "SETTLE", SETTLE.replace("||a.chain!==`solana`", "")],
    // the higher height: one RPC's word frees the note
    ["two", "TWO", TWO.replace("Math.min", "Math.max")],
  ];
  for (const [mark, part, js] of near) {
    const f = facts(INDEX, Object.entries(ALL).map(([k, v]) => (k === part ? js : v)).join(";"));
    assert.equal(f[mark], false, `${mark} (${part}): the near miss is read as no mark`);
    for (const m of ["sent", "asked", "end", "settle", "two"].filter((x) => x !== mark)) assert.equal(f[m], true, `${mark} (${part}): ${m} still read`);
  }
});
