// node --test scripts/live-checks/signpage-sent-end-recorded-evm.test.mjs: the live check's verdict replays recorded
// answers (signpage-sent-end-recorded-evm.answers.json), each facts() over a tree's index.html and app.js:
//   good: this card's branch, built with packages/signpage/scripts/build-app.mjs --out: the index pins the bundle, and it
//         writes a Base or Robinhood buy's op at sent before the bytes leave, notes each leg's end onto it before W's
//         holding leaves pending, sets its stage by legsEnd, keeps it out of the trade settle, ends a dead page's rest leg
//         from the carry pass and from the RESERVED settle's freed note, and the restore writes no second row: PASS;
//   bad:  main 58f22d390's sign sources built the same way: none of this card's marks: FAIL on each.
// Planted from those: each mark alone missing, a near miss of each mark's minified shape (failing that mark alone), and
// an index that pins another bundle or none.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { facts, judge } from "./signpage-sent-end-recorded-evm.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-sent-end-recorded-evm.answers.json"), "utf8"));
const MARKS = ["sent", "end", "legs", "skip", "carry", "freed", "restore"];
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

test("recorded bad answer: main 58f22d390's build: FAIL, naming each missing mark", () => {
  const r = judge(ANSWERS.bad);
  for (const m of MARKS) fails(r, new RegExp(`^BAD ${m}:`));
});

test("planted: each mark alone, and the index's pin", () => {
  for (const m of MARKS) fails(mut((a) => (a[m] = false)), new RegExp(`^BAD ${m}:`));
  fails(mut((a) => (a.sha384 = ANSWERS.bad.sha384)), /not the one index\.html pins/);
  fails(mut((a) => (a.index = "<html></html>")), /pins no \/app\.js/);
});

// the build's own minified shapes (read from the good build), and a near miss of each
const INDEX = '<script src="/app.js" integrity="x"></script>';
const SENT = "if(m!==void 0){let t={kind:`buy`,stage:`sent`,txs:[],created_ms:Number(u()),chain:e.chain,token:_$(l),legs:O.map(e=>({w:_$(e.kind===`whole`?e.x.w:e.leg.w)}))};await e.ops(m,e=>e===void 0?t:void 0).catch(()=>{})}o=!0;let k=await Promise.all(";
const NOTE_LEG = "o$=(e,t,n,r)=>e.ops===void 0?Promise.resolve():e.ops(t,t=>T_e(t,n,r,e.price?.()??null)).catch(()=>{})";
const NOTED = "function T_e(e,t,n,r){let i=e;if(i?.kind!==`buy`||!Array.isArray(i.legs)||!Number.isInteger(t)||t<0||t>=i.legs.length)return;let a=i.legs[t]?.end;if(a!==void 0&&(a.stage!==`refused`||n.stage===`refused`))return;let o=i.legs.map((e,r)=>r===t?{...e,end:n}:e),s={...i,legs:o};if(o.some(e=>e.end===void 0))return s;let c=A$(o.map(e=>e.end));if(i.stage===`refused`&&c.stage===`not_landed`)return s;let{units:l,pool_amount:u,amount_usd:d,...f}=s;return{...f,stage:c.stage,txs:c.txs.length>0?c.txs:i.txs??[]";
const ENDED = "s=async t=>(o!==null&&await o$(e,o.id,o.leg,t),{stage:t.stage,txs:t.txs})";
const WATCH = "if(n?.end===`not_landed`&&n.release===null){let n=i();if(t.none===null&&(t.none=n),n-t.none<BigInt(f$))continue;let r=await s({stage:`not_landed`,txs:[]});return await e.unrecord(t.w,t.want.nullifier,t.want.deadlineMs).catch(()=>{}),r}if(t.none=null,n===null)continue;if(n.end===`not_landed`){let n=await s({stage:`not_landed`,txs:[]});return await e.unrecord(t.w,t.want.nullifier,t.want.deadlineMs).catch(()=>{}),n}let l=[{chain:e.chain,hash:n.release.tx}],u={...t.holding.route,tx:n.release.tx,block:n.release.block.toString()};if(t.mine!==void 0&&e.landed?.(t.mine.noteId,t.mine.attempt,t.mine.chunk,n.release.block),n.end===`filled`){let r=o===null?null:await s({stage:`filled`,txs:l,out:n.release.out.toString(),decimals:t.holding.decimals,wei:M$(n.release).toString()});return await e.record(t.w,{...t.holding,state:`filled`,received:JI(n.release.out,t.holding.decimals),route:u}).catch(()=>{}),r===null?(await e.traded?.(c$(`buy`,e.chain,n.release.tx,t.holding.mint,n.release.out,t.holding.decimals,M$(n.release),e.price?.()??null,Number(i()))).catch(()=>{}),{stage:`filled`,txs:l}):r}o!==null&&await o$(e,o.id,o.leg,{stage:`owed_back`,txs:l}),await e.record(t.w,{...t.holding,state:`withdrawn`";
const LEGS_END = "function A$(e){let t=e.flatMap(e=>e?.txs??[]),n=e.map(e=>e?.stage??`sent`);return n.every(e=>e===`filled`)?{stage:`filled`,txs:t}:n.some(e=>e===`sent`||e===`signed`)?{stage:`sent`,txs:t}:n.some(e=>e===`filled`||e===`part_filled`)?{stage:`part_filled`,txs:t}:n.some(e=>e===`owed_back`)?{stage:`owed_back`,txs:t}:n.some(e=>e===`refused`)?{stage:`refused`,txs:t}:{stage:`not_landed`,txs:t}}";
const EVM_OP = "GU=e=>e.chain===`base`||e.chain===`robinhood`;";
const DUE = "&&!GU(r)&&[`pending`,`signed`,`sent`].includes(String(r.stage))";
const SETTLE = "||GU(i)||![`pending`,`signed`,`sent`].includes(String(i.stage))";
const CARRY = "if(p.rest){let t=c[p.w],r=a$(t),i=F1(p.release);if(r!==null&&i!==null&&e.ops!==void 0){let a=await ove(e.rpcs,p.w,t,i,e.chain,n()).catch(()=>null);if(a===null&&typeof t.adapter==`string`)return[{w:p.w,end:`pending`}];if(e.signal?.aborted)return[];a!==null&&await o$({ops:e.ops},r.id,r.leg,a)}}";
const REST_END = "async function ove(e,t,n,r,i,a){let o=typeof n.hash==`string`&&/^0x[0-9a-fA-F]{64}$/.test(n.hash)?n.hash:null,s=[{chain:i,hash:r},...o===null?[]:[{chain:i,hash:o}]],c=typeof n.spend==`string`&&/^[0-9]{1,78}$/.test(n.spend)?{wei:n.spend}:{};if(n.end===`filled`)return{stage:`filled`,txs:s,...c};if(n.end===`reverted`||n.end===`unsent`)return{stage:`owed_back`,txs:s};if(o===null){let e=typeof n.signBy==`string`&&/^[0-9]{1,20}$/.test(n.signBy)?BigInt(n.signBy):null;return e!==null&&a>e?{stage:`owed_back`,txs:s}:null}if(typeof n.adapter!=`string`||!/^0x[0-9a-fA-F]{40}$/.test(n.adapter))return null;let l=await u1(e,o,t,n.adapter).catch(()=>null);if(l!==null)return l===`ok`?{stage:`filled`,txs:s,...c}:{stage:`owed_back`,txs:s};let u=typeof n.signBy==`string`&&/^[0-9]{1,20}$/.test(n.signBy)?BigInt(n.signBy):null;return u===null||a<=u+300000n?null:";
const FREED = "async function jve(e,t,n,r){let i=new Set(r.map(String));for(let r of Object.values(r0(await e.get(`meta`,m1)))){let e=a$(r);e!==null&&r.chain===n&&typeof r.nullifier==`string`&&i.has(r.nullifier)&&await o$({ops:t},e.id,e.leg,{stage:`not_landed`,txs:[]})}}";
const WBUY = "m1=`owed/wbuy-evm`";
const FREED_CALL = "o.freed.length>0){let r=await e.store();await jve(r,async(e,t)=>void await r.update(`ops`,e,t),t,(await n.list()).filter(e=>o.freed.includes(e.id)).map(e=>VD(a,e.ref).nullifierHash))";
const RESTORE = "if(i?.kind===`buy`&&i.chain===e.chain){if(Array.isArray(i.txs))for(let e of i.txs)typeof e?.hash==`string`&&t.add(e.hash.toLowerCase());if((i.stage===`sent`||i.stage===`refused`)&&Array.isArray(i.legs))for(let e of i.legs)typeof e?.w==`string`&&n.add(e.w.toLowerCase())}}let r=new Map,i=t=>{let n=r.get(t);return n===void 0&&(n=(async()=>{let n=await e.read(`eth_getBlockByNumber`,[v6(t),!1]);if(typeof n?.number!=`string`||BigInt(n.number)!==t||typeof n.timestamp!=`string`)throw Error(`restore: not the block`);return Number(BigInt(n.timestamp))*1e3})(),r.set(t,n)),n},a=0,o=async t=>{let n=!1;await e.store.update(`ops`,s$(t.chain,t.txs[0].hash),e=>e===void 0?(n=!0,t):void 0),n&&a++};for(let r of e.spends)if(!(r.token===null||r.tx===null||r.fee===null||r.out===null||r.fee>r.withdrawn)){e.signal?.throwIfAborted();try{if(!t.has(r.tx.toLowerCase())&&!n.has(r.w.toLowerCase()))";
const ALL = { SENT, NOTE_LEG, NOTED, ENDED, WATCH, LEGS_END, EVM_OP, DUE, SETTLE, CARRY, REST_END, FREED, WBUY, FREED_CALL, RESTORE };

test("facts() reads each mark from the minified code as the build writes it", () => {
  const all = facts(INDEX, Object.values(ALL).join(";"));
  assert.deepEqual(MARKS.map((m) => all[m]), MARKS.map(() => true));
});

test("planted near misses: each mark's shape one step off is that mark's miss, and no other's", () => {
  const SENDS = "o=!0;let k=await Promise.all(";
  // [mark, part of ALL it changes, the near miss, the marks that share that part and miss with it]
  const near = [
    // review 1: the op written after the sends (a page that dies while the helper holds the bytes has no op)
    ["sent", "SENT", `${SENDS}O.map(t=>H_e(e,t.data,t.r,u,d,p)));${SENT.replace(SENDS, "")}`],
    // a tx on sent before any release is read, or a sent write over an op already there
    ["sent", "SENT", SENT.replace("txs:[],created_ms", "txs:k,created_ms")],
    ["sent", "SENT", SENT.replace("e=>e===void 0?t:void 0", "e=>t")],
    // noteLeg writing no end, an end written over (a refusal over the chain's), sent's txs dropped at an end with none
    ["end", "NOTE_LEG", NOTE_LEG.replace("e.ops(t,t=>T_e(t,n,r,e.price?.()??null))", "e.ops(t,t=>void 0)"), ["carry", "freed"]],
    ["end", "NOTED", NOTED.replace("a.stage!==`refused`||", "")],
    ["end", "NOTED", NOTED.replace("txs:c.txs.length>0?c.txs:i.txs??[]", "txs:c.txs")],
    // review 2: the op noted without waiting, so W's holding can leave pending first (filled, owed_back), or the
    // record removed before the op is noted (not_landed)
    ["end", "WATCH", WATCH.replace("let r=o===null?null:await s({stage:`filled`", "let r=o===null?null:s({stage:`filled`")],
    ["end", "WATCH", WATCH.replace("o!==null&&await o$(e,o.id,o.leg,{stage:`owed_back`", "o!==null&&o$(e,o.id,o.leg,{stage:`owed_back`")],
    ["end", "WATCH", WATCH.replace("let r=await s({stage:`not_landed`,txs:[]});return await e.unrecord(", "await e.unrecord(")],
    ["end", "ENDED", ENDED.replace("await o$(", "await Zz(")],
    // the stage set while a leg has no end, a refusal moved to not_landed, or legsEnd's any-filled as filled
    ["legs", "NOTED", NOTED.replace("if(o.some(e=>e.end===void 0))return s;", "")],
    ["legs", "NOTED", NOTED.replace("if(i.stage===`refused`&&c.stage===`not_landed`)return s;", "")],
    ["legs", "LEGS_END", LEGS_END.replace("n.every(e=>e===`filled`)", "n.some(e=>e===`filled`)")],
    // Robinhood's ops not left, or either settle without the skip
    ["skip", "EVM_OP", EVM_OP.replace("e.chain===`base`||e.chain===`robinhood`", "e.chain===`base`")],
    ["skip", "DUE", DUE.replace("&&!GU(r)&&", "&&")],
    ["skip", "SETTLE", SETTLE.replace("||GU(i)||", "||")],
    // gap 3: W carried while its leg's end is unknown; the end noted by another path; a receipt read the wrong way
    ["carry", "CARRY", CARRY.replace("if(a===null&&typeof t.adapter==`string`)return[{w:p.w,end:`pending`}];", "")],
    ["carry", "CARRY", CARRY.replace("a!==null&&await o$(", "a!==null&&await Zz(")],
    ["carry", "REST_END", REST_END.replace("return l===`ok`?{stage:`filled`", "return l!==`failed`?{stage:`filled`")],
    // gap 3: owed_back with no window past signBy
    ["carry", "REST_END", REST_END.replace("+300000n", "")],
    // gap 2: another chain's record ended, a refusal written, the freed notes not passed by nullifier, another key
    ["freed", "FREED", FREED.replace("&&r.chain===n&&", "&&")],
    ["freed", "FREED", FREED.replace("{stage:`not_landed`,txs:[]}", "{stage:`refused`,txs:[]}")],
    ["freed", "FREED_CALL", FREED_CALL.replace(".nullifierHash)", ".commitment)")],
    ["freed", "WBUY", WBUY.replace("owed/wbuy-evm", "owed/wbuy")],
    // review 3: an open op's Ws not named; an ended op's Ws named; another chain's op read
    ["restore", "RESTORE", RESTORE.replace("&&!n.has(r.w.toLowerCase()))", ")")],
    ["restore", "RESTORE", RESTORE.replace("(i.stage===`sent`||i.stage===`refused`)&&", "")],
    ["restore", "RESTORE", RESTORE.replace("&&i.chain===e.chain", "")],
  ];
  for (const [mark, part, js, also = []] of near) {
    assert.notEqual(js, ALL[part], `${mark} (${part}): the near miss changes the shape`);
    const f = facts(INDEX, Object.entries(ALL).map(([k, v]) => (k === part ? js : v)).join(";"));
    assert.equal(f[mark], false, `${mark} (${part}): the near miss is read as no mark`);
    for (const m of also) assert.equal(f[m], false, `${mark} (${part}): ${m} shares the part`);
    for (const m of MARKS.filter((x) => x !== mark && !also.includes(x))) assert.equal(f[m], true, `${mark} (${part}): ${m} still read`);
  }
});
