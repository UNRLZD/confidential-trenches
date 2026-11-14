// node --test scripts/live-checks/every-lamport-can-move.test.mjs: the live check replays its recorded answers
// (every-lamport-can-move.answers.json). good: since card pool-amounts-are-standard-sizes that card's build (every size
// that enters or leaves the pool a rung, no finishing sizes, no transfer, no ride): PASS; liveBefore, SIGN_HOST before
// it: FAIL on its rules alone (RUNG). Before it good was this card's build. bad: main fe1ad9879's build, before this card:
// FAIL, every mark named. t1: the card's T1 build (14a602c12), before the least finish, the sale's one deposit and the
// ride: FAIL on every mark but the queue's. before1d: the card's 1d3b96d9c build, before its
// review: FAIL on the sweep's note, the ride's take, the ride's booking, the rule's fee payer and the own coins' tokens.
// Planted on the good one: another /app.js, no pin, each mark taken away: each FAIL; and the good build's lines
// (every-lamport-can-move.excerpt.txt, cut from its app.js) with one rule changed: each FAIL on that rule's mark alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, MARKS } from "./every-lamport-can-move.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./every-lamport-can-move.answers.json", import.meta.url), "utf8"));
const ALL = Object.keys(MARKS).map((k) => `BAD the served bundle has no ${k}`);
// card pool-amounts-are-standard-sizes's rules: no finishing sizes, a release a rung, a note's chunk, a withdraw's whole
// note, the partial sell's rung note, the sweep's rung note and its rule, W's rest kept with no ride: no build before
// it carries them
const RUNG = [0, 1, 2, 4, 7, 8, 9, 10];
const rung = (list) => [...new Set([...list, ...RUNG])].sort((a, b) => a - b).map((i) => ALL[i]);

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer (main fe1ad9879's build): FAIL, every mark named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL);
});

test("recorded answer t1 (14a602c12's build): FAIL on every mark but the queue's", () => {
  const v = judge(ANSWERS.t1);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL.filter((_, i) => i !== 3));
});

test("recorded answer liveBefore (SIGN_HOST before card pool-amounts-are-standard-sizes): FAIL on that card's rules alone", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, RUNG.map((i) => ALL[i]));
});

test("recorded answer before1d (1d3b96d9c's build): FAIL on the marks its review changed and card pool-amounts-are-standard-sizes's", () => {
  const v = judge(ANSWERS.before1d);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, rung([8, 12, 13, 14]));
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const [i, k] of Object.keys(MARKS).entries()) assert.deepEqual(judge({ ...g, carries: { ...g.carries, [k]: false } }).lines, [ALL[i]]);
  assert.equal(judge(null).ok, false);
});

const JS = readFileSync(new URL("./every-lamport-can-move.excerpt.txt", import.meta.url), "utf8");
test("the good build's lines carry every mark; each with its rule changed FAILs on that mark alone", () => {
  assert.deepEqual(Object.values(facts("", JS).carries), Object.keys(MARKS).map(() => true));
  const planted = [
    // the piece rule's constants and the pool holding it (card pool-amounts-are-standard-sizes: no finishing sizes)
    ["VC=5000000n,", "VC=3000000n,", 0],
    [",least:UC})", "})", 0],
    ["pieces:iE", "pieces:void 0", 0],
    ["UC=2950240n;", "UC=2600000n;", 0],
    // a release size is a rung, the sizes a release may take the rungs alone
    ["return typeof t==`bigint`&&FC(e.ladder,t)}", "return typeof t==`bigint`&&(FC(e.ladder,t)||t%e.grid===0n)}", 1],
    ["function qC(e,t){return LC(e.ladder,t)}", "function qC(e,t){return[...LC(e.ladder,t),e.floor+e.grid]}", 1],
    // a note's chunk
    ["if(r===0n||r>=e.floor)return", "if(r>=0n)return", 2],
    ["return n}return t}", "return n}return null}", 2],
    ["if(t<e.floor)return t>=e.least?t:null;for", "for", 2],
    ["return t>=e.least?t:null;for", "return t>=0n?t:null;for", 2],
    // the queue's chunk
    ["return e.pieces===void 0?RC(e.ladder,t):JC(e.pieces,t)", "return RC(e.ladder,t)", 3],
    // the withdraw's parts: a whole note only as its own chunk or under the floor
    ["(YD(i,e.value)===e.value||e.value<i.floor)&&o.push([a,a])", "o.push([a,a])", 4],
    ["||e.value<i.floor)&&o.push([a,a])", ")&&o.push([a,a])", 4],
    ["e.value-n>=i.floor?qC(i,e.value-n):[]", "e.value-n>=0n?qC(i,e.value-n):[]", 4],
    // a full sell's deposit refused, the full sell built bare
    ["if(_.full&&b.program===l.program)return X(`deposit_full`);", "", 5],
    ["{full:!0,fee:n,rent:N}),{wire:i,value:0n}}", "{full:!1,fee:n,rent:N}),{wire:i,value:0n}}", 6],
    // a partial sell's note: the rules' note, a rung
    ["return C===QA(h-s)?", "return C===h-s?", 7],
    ["e<=0n?0n:PD(iE,e).note}", "e<=0n?0n:e}", 7],
    // the sweep's note: the largest rung whose remainder is 0 or at least what W keeps, its deposit alone
    ["if(i===0n||i>=t)return{value:r,under:i}", "if(!0)return{value:r,under:i}", 8],
    ["let r=QA(n);", "let r=n;", 8],
    ["[PY(t.program,t.pool,c.address,b,A,F)]", "[PY(t.program,t.pool,c.address,b,A,N)]", 8],
    ["[PY(t.program,t.pool,c.address,b,A,F)]", "[PY(t.program,t.pool,c.address,b,A,F),EY(c.address,m.solana.feePayer,N-F)]", 8],
    // the sweep's rule: the deposit alone, its value the sweep's note, a rung
    ["if(l.ixs.length!==1)return X(`instructions`);", "if(l.ixs.length>2)return X(`instructions`);", 9],
    ["return u===dj(", "return u>=dj(", 9],
    ["-d,sk(i,d)).value?", "-d,0n).value?", 9],
    ["!jD(iE,u)||u<1000000n||", "u<1000000n||", 9],
    ["r-5000n-lj(i,n,a)-d,", "r-lj(i,n,a)-d,", 9],
    // W's rest under the floor kept and listed, the floor end straight after
    ["F<E&&R===0n&&t.unlisted?.(),", "", 10],
    ["&&t.read?.(R),F<E)return{end:", "&&t.read?.(R),F<E&&p===0)return{end:", 10],
    // the ride's piece
    ["if(KC(e,t)&&YC(e,i.value-t)&&n(t))", "if(KC(e,t)&&n(t))", 11],
    ["t<r.chunk||", "t>r.chunk||", 11],
    // a tap's ride taken once due, let go only when the run held nothing
    ["e()<a&&!s()?!1:", "e()<a?!1:", 12],
    ["s=()=>r!==void 0&&e()>=r;", "s=()=>r!==void 0;", 12],
    ["ride(e){r=r===void 0?e:Math.max(r,e)}", "ride(e){r=e}", 12],
    ["takeRide(){return s()?r:void 0}", "takeRide(){return r}", 12],
    ["n===void 0?{}:{ride:!0,held:()=>void(r=!0)}", "{}", 12],
    ["return n!==void 0&&!r&&(kt.rode(n)", "return n!==void 0&&(kt.rode(n)", 12],
    ["E=!0,n.held?.();continue}", "E=!0;continue}", 12],
    ["i.floor===!0||(a===void 0", "i.floor===!1||(a===void 0", 12],
    // a tap's ride booked at a drawn time, kept on the device, read back capped
    ["let t=G2(Date.now());", "let t=Date.now();", 13],
    ["kt.ride(t),Promise", "Promise", 13],
    ["var iJ=6e5,", "var iJ=0,", 13],
    ["aJ=36e5,", "aJ=864e5,", 13],
    ["$Y=QY;", "$Y=()=>0;", 13],
    ["iJ+eX(aJ-iJ+1)", "iJ+Math.floor(Math.random()*(aJ-iJ+1))", 13],
    ["kt.ride(Math.min(t,Date.now()+aJ))", "kt.ride(t)", 13],
    ["e>=t?void 0:t)", "!1?void 0:t)", 13],
    ["e.state===`UNSPENT`)&&At()", "e.state===`UNSPENT`)", 13],
    ["_(b.stage,b.txs,b.pending,b.arrived),At()", "_(b.stage,b.txs,b.pending,b.arrived)", 13],
    // tokens keep W whole only on W's own coins' accounts
    ["e.some(e=>e.tokens===!0&&t(e.address))", "e.some(e=>e.tokens===!0)", 14],
    ["r=e=>t.bare===!0||n.has(e)", "r=e=>t.bare===!0", 14],
    ["r=e=>t.bare===!0||n.has(e)", "r=e=>n.has(e)", 14],
    ["zY(y.ok.keep,r)", "zY(y.ok.keep,()=>!1)", 14],
    ["zY(d.plan.keep,r)", "zY(d.plan.keep,()=>!1)", 14],
  ];
  for (const [from, to, i] of planted) {
    assert.ok(JS.includes(from), `the excerpt holds ${from}`);
    const c = facts("", JS.replace(from, to)).carries;
    assert.deepEqual(Object.keys(MARKS).filter((k) => !c[k]), [Object.keys(MARKS)[i]], `${from} -> ${to}`);
  }
});
