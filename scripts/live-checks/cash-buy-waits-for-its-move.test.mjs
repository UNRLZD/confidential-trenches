// node --test scripts/live-checks/cash-buy-waits-for-its-move.test.mjs: the live check's verdict replays recorded
// answers (cash-buy-waits-for-its-move.answers.json), each facts() over a tree's index.html and app.js:
//   good: this card's branch, built with packages/signpage/scripts/build-app.mjs: the index pins the bundle, and the
//         bundle's tap waits on the move's landing and its notes' proofs: PASS;
//   bad:  SIGN_HOST as served on 15 Nov 2026 16:4xZ before the card (release 153): the 180 s clock: FAIL on every mark.
// Planted from the minified code the build writes: each mark broken alone FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { facts, judge, SAYS } from "./cash-buy-waits-for-its-move.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "cash-buy-waits-for-its-move.answers.json"), "utf8"));
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: the branch's build: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST before the card: FAIL on every mark", () => {
  const r = judge(ANSWERS.bad);
  for (const k of Object.keys(SAYS)) fails(r, new RegExp(`^BAD ${k}:`));
});

test("planted on the good answer: each mark alone, and the index's pin", () => {
  for (const k of Object.keys(SAYS)) fails(judge({ ...ANSWERS.good, [k]: false }), new RegExp(`^BAD ${k}:`));
  fails(judge({ ...ANSWERS.good, sha384: ANSWERS.bad.sha384 }), /not the one index\.html pins/);
  fails(judge({ ...ANSWERS.good, index: "<html></html>" }), /pins no \/app\.js/);
});

// the minified code as this card's build writes it (packages/signpage/scripts/build-app.mjs at the branch)
const WAIT =
  "e!==null&&c(`move`,{move:p,stage:e.landed?`landed`:`stopped`,...e.error===void 0?{}:{error:e.error}});let t=0,o=new Map;for(;e?.landed===!0&&!l.signal?.aborted&&await l.tapMax(a,i)<n.amount&&(t=await l.proving(a,o).catch(()=>!1)?0:t+1,!(t>=2));)await l.wait(FK);let o=l.last(),s=o>=n.amount?`ready`:l.signal?.aborted||e===null?`signed_out`:e.landed?`settled`:`stopped`,u=s===`settled`?`one tap spends ${o} of the ${n.amount} asked, with nothing more landing or proving`:void 0";
const STOPS = "let e=`the quote's deadline passed with nothing delivered`;d(t,PK(t,null,`end`,{stage:a.stage,error:e}));if(t.length===0)return{landed:!1,error:`no part of this move is on its way`}";
const COMING = "coming:e=>t.filter(t=>t.chain===e&&t.reached===null).reduce((e,t)=>e+t.lamports,0n)";
const WIRED =
  "t.has(n.scope)&&!a.has(n.id)&&(n.state===`INCOMING`||r?.has(n.id)===!0||n.state===`HELD`?o=!0:i!==void 0&&i.open&&n.state===`UNSPENT`&&n.leaf!==void 0&&NE(Dq[i.chain].pieces,n.leaf.value)!==null&&(i.seen.has(n.id)||i.seen.set(n.id,i.now),i.now<i.seen.get(n.id)+Dq[i.chain].epochMs+1e4&&(o=!0)));return o}need:(e,t)=>f().need(e,t),moved:e=>f().landing(e),proving:async(e,t)=>{if(!x7)return!1;let n=await x7.readyWith(L9),r=S2.filter(t=>t.chain===e),i=new Set(r.map(e=>e.id)),a=r.some(e=>n.open.has(e.id));return Oq(n.value,new Set(r.map(e=>e.scope)),(n.ready??[]).filter(e=>i.has(e.poolId)),n.making,{chain:e,open:a,seen:t,now:Date.now()})}";
const all = (o = {}) => facts("", [o.wait ?? WAIT, o.stops ?? STOPS, o.coming ?? COMING, o.wired ?? WIRED, o.more ?? ""].join(";"));

test("facts() reads each mark from the minified code as the build writes it, and misses each when it is broken", () => {
  assert.deepEqual(Object.fromEntries(Object.keys(SAYS).map((k) => [k, all()[k]])), { wait: true, stops: true, coming: true, wired: true });
  const broken = {
    wait: [
      // no landing line before the proofs' wait, no proving read, two idle reads no longer the end
      { wait: WAIT.replace("stage:e.landed?`landed`:`stopped`", "stage:`landed`") },
      { wait: WAIT.replace("await l.proving(a,o).catch(()=>!1)?0:t+1", "0") },
      { wait: WAIT.replace("!(t>=2)", "!0") },
      { wait: WAIT.replace("with nothing more landing or proving", "short") },
      // the build before the card: its fixed clock from the tap, said
      { more: "error:`one tap spends ${s} of the ${n.amount} asked after ${1800} ms`" },
      { more: "stage:a?`ready`:`wait_over`" },
    ],
    stops: [
      { stops: STOPS.replace("the quote's deadline passed with nothing delivered", "late") },
      { stops: STOPS.replace("no part of this move is on its way", "none") },
    ],
    coming: [
      { coming: COMING.replace("&&t.reached===null", "") },
      // the build before the card: a move dropped from coming by its age
      { coming: "coming:n=>t.filter(t=>t.chain===n&&e.now()-t.since<=18e4).reduce((e,t)=>e+t.lamports,0n)" },
      { more: "coming:n=>t.filter(t=>t.chain===n&&e.now()-t.since<=18e4)" },
    ],
    wired: [
      { wired: WIRED.replace("moved:e=>f().landing(e),", "") },
      { wired: WIRED.replace("n.state===`INCOMING`||", "") },
      // a landed note waiting for its epoch turn dropped, its queue's open state or its piece rule not read,
      // no bound by the epoch, or the page giving no turn
      { wired: WIRED.replace("&&i.open&&n.state===`UNSPENT`", "&&n.state===`UNSPENT`") },
      { wired: WIRED.replace("&&NE(Dq[i.chain].pieces,n.leaf.value)!==null", "") },
      { wired: WIRED.replace("+Dq[i.chain].epochMs+1e4", "+1e4") },
      { wired: WIRED.replace(",{chain:e,open:a,seen:t,now:Date.now()})", ")") },
    ],
  };
  for (const [k, list] of Object.entries(broken)) {
    for (const o of list) {
      const f = all(o);
      assert.equal(f[k], false, `${k} misses: ${JSON.stringify(o)}`);
      fails(judge({ ...ANSWERS.good, ...f, index: ANSWERS.good.index, sha384: ANSWERS.good.sha384 }), new RegExp(`^BAD ${k}:`));
    }
  }
});

test("facts() over SIGN_HOST's bundle before the card misses every mark (its 180 s clock, its coming by age)", () => {
  const before = "for(;!l.signal?.aborted&&l.now()<t&&await l.tapMax(a,i)<n.amount;)await l.wait(FK);coming:n=>t.filter(t=>t.chain===n&&e.now()-t.since<=18e4).reduce((e,t)=>e+t.lamports,0n)";
  const f = facts("", before);
  assert.deepEqual([f.wait, f.stops, f.coming, f.wired], [false, false, false, false]);
});
