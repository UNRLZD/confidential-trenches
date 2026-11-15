// node --test scripts/live-checks/evm-cash-move-brings-its-fee.test.mjs: the live check's verdict replays recorded answers
// (evm-cash-move-brings-its-fee.answers.json), each facts() over a tree's index.html and app.js:
//   good: card cash-buys-spend-every-note-evm's branch (it re-recorded this answer: the move planned over every Cash
//         note, the tap sized on the rungs its parts land), built with packages/signpage/scripts/build-app.mjs --out:
//         the index pins the bundle, the tap asks the page's size on Base and Robinhood, the size is the tap's plan over
//         notes that pay their own fees, the mover lands it as rungs with their gas, and the dry prices it above
//         tap_max: PASS;
//   bad:  SIGN_HOST as served on 15 Nov 2026 before the card: none of them: FAIL.
// Planted from the minified code the build writes: each mark broken alone, and card you-receive-on-every-chain's own
// form (its size asked on Solana only, an EVM ask moved as its rung) FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { facts, judge, SAYS } from "./evm-cash-move-brings-its-fee.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "evm-cash-move-brings-its-fee.answers.json"), "utf8"));
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
const TAP = "o=e=>a===`solana`?n.amount-e:null,s={error:`failed`};let c=t(),l=await c.any(a)?await c.tapMax(a,i).catch(()=>null):n.amount,u=l!==null&&l<n.amount&&c.short?await c.short(a,i,n.amount).catch(()=>null):null,d=l!==null&&l<n.amount?u??o(l):null";
// card cash-buys-spend-every-note-evm's build (the same script at its branch): the move planned over every Cash note, the
// tap sized on the rungs the parts land, the Max and the Fee from that same plan
const SIZING =
  "function Fle(e,t){return e<=0n?[]:P1(KE(_D,e).notes,t)}function P1(e,t){let n=t*Nle;return e.filter(e=>n<e).map((e,t)=>({noteId:`move#${t}`,chunk:e,fee:n}))}function F1(e,t,n,r){if(t<=0n||n<0n)return null;let{pieces:i,bound:a}=A1(e),o=e=>{let o=r===void 0?null:r(e*_D.min);if(r!==void 0&&o===null)return null;let s=o===null?Fle(e*_D.min,n):P1(o,n),c=[...i,...s];try{let e=rP({kind:`pool.buy`,chain:`base`,token:null,amount:t,slippageBps:0,decimals:0},o,s);return e.amount===t?e:null}catch(e){return null}}}";
const MOVE =
  "function HK(e,t,n,r){let i=LK[r];if(e<=0n||t<0n||e>=1n<<127n)return null;let a=(e+i-1n)/i*i,o=KE(RK[r],a).notes.length,s=a+BigInt(o)*t,c=VK(s,n,r);return c===null?null:{left:s,notes:o,usdc:c}}function KK(e,t,n,r){let i=t>LK[r]?t-LK[r]:0n;return{of:n=>{let a=HK(n,i,e,r);return a===null||a.left<t?null:{usdc:a.usdc,least:a.left}},step:LK[r],min:LK[r],leastIn:n??0n}}function qK(e,t,n,r,i,a){let o=KK(n,r,i,a),s=r>LK[a]?r-LK[a]:0n};m=n===`solana`?YK(l,c,r-a,GK(s,d,f)):typeof d==`bigint`?qK(l,c,s,d,f,n).parts(r):null";
// (card buy-quote-before-any-note's build: no rungs, so no wait on the fee, when Cash holds nothing a move can use; round
// 2: one plan read per dry, and the epoch fee read only for a plan that moves something)
const DRY =
  "s=i!==null&&typeof o==`bigint`&&i>o&&n.fee!==void 0&&n.moved!==void 0,c=s?(async()=>{let e=n.fee();e.catch(()=>{});let r=n.rungs?await n.rungs().catch(()=>null):void 0;if(r===null)return null;let a=await e,o=a===null?null:P1(t.ready,i,a,r),s=o===null?null:await n.moved(o.short).catch(()=>null);return o===null||s===null||s<0n?null:{plan:o.plan,cost:M1(o.plan)+s}})().catch(()=>null):Promise.resolve(null);_=(e,n)=>{let r,i=()=>r??=g(e),a=async()=>(await i().catch(()=>null))?.top===0n?null:await x7?.evmFeeNow(e)??null;return bue(e,n,{trading:()=>!1,quote:()=>{},fee:a,rungs:async()=>(e=>e===null||e.top===0n?null:e.rungs)(await i()),moved:async e=>(await i())?.cost(e)??null})}";
const MAX =
  "withCash:async(e,t)=>{let n=a().catch(()=>null),r=await i(),o=fK(e,Ko.ETH);if(r===null||o===null)return null;if(r.top===0n)return yq(o,Ko.ETH);let s=await n;if(s===null)return null;let c=gue(t,s,e=>r.parts(e)!==null,o+r.top,r.rungs);return yq(c>o?c:o,Ko.ETH)}";
const all = (o = {}) => facts("", [o.tap ?? TAP, o.sizing ?? SIZING, o.move ?? MOVE, o.dry ?? DRY, o.max ?? MAX].join(";"));

test("facts() reads each mark from the minified code as the build writes it, and misses each when it is broken", () => {
  assert.deepEqual(Object.fromEntries(Object.keys(SAYS).map((k) => [k, all()[k]])), { tap: true, sizing: true, move: true, dry: true, max: true });
  const broken = {
    tap: [
      // card you-receive-on-every-chain's form: the size asked on Solana alone, an EVM ask moved as its rung
      TAP.replace("l<n.amount&&c.short", "l<n.amount&&a===`solana`&&c.short").replace("?n.amount-e:null", "?n.amount-e:HK(a,n.amount)?n.amount:null"),
      TAP.replace("?n.amount-e:null", "?n.amount-e:HK(a,n.amount)?n.amount:null"),
      TAP.replace("c.short(a,i,n.amount)", "c.short(a,i,n.amount-l)"),
      TAP.replace("&&c.short?await c.short", "&&0?await 0"),
    ],
    sizing: [
      SIZING.replace("let n=t*Nle", "let n=t"),
      SIZING.replace("fee:n}", "fee:t}"),
      SIZING.replace("return e.amount===t?e:null", "return e"),
      SIZING.replace("filter(e=>n<e)", "filter(e=>1)"),
      // card cash-buys-spend-every-note-evm: the size read on one move's split, not the rungs Cash's parts land
      SIZING.replace("P1(o,n),c=", "Fle(e*_D.min,n),c="),
      SIZING.replace("if(r!==void 0&&o===null)return null;", ""),
    ],
    move: [
      MOVE.replace("s=a+BigInt(o)*t", "s=a+t"),
      MOVE.replace("a=(e+i-1n)/i*i", "a=e"),
      MOVE.replace("let a=HK(n,i,e,r)", "let a=XX(n,i,e,r)"),
      MOVE.replace("a.left<t?null", "!1?null"),
      MOVE.replace("step:LK[r]", "step:1n"),
      MOVE.replace("let o=KK(n,r,i,a)", "let o=GK(n,r,i)"),
      // the mover's Base and Robinhood branch planning nothing
      MOVE.replace("typeof d==`bigint`?qK(l,c,s,d,f,n).parts(r):null", "null"),
    ],
    dry: [
      DRY.replace("&&n.moved!==void 0", ""),
      DRY.replace("cost:M1(o.plan)+s", "cost:s"),
      DRY.replace("await x7?.evmFeeNow(e)", "await x7?.relayFee(e)"),
      DRY.replace("rungs:async()=>(e=>e===null||e.top===0n?null:e.rungs)(await i()),", ""),
      // rungs given whatever Cash holds (card buy-quote-before-any-note: a fresh account's dry waited on the fee)
      DRY.replace("(e=>e===null||e.top===0n?null:e.rungs)(await i())", "(await i())?.rungs??null"),
      DRY.replace("?.cost(e)??null", "?.top??null"),
      // round 2: the epoch fee read whatever Cash holds (a fresh account's dry loaded the chain's RPC for nothing), or
      // a plan read per dep (three reads of Cash, its fee, floor and least for one dry)
      DRY.replace("(await i().catch(()=>null))?.top===0n?null:", ""),
      DRY.replace("i=()=>r??=g(e)", "i=()=>g(e)"),
      // round 1's form: each dep its own plan, the fee read at once
      DRY.slice(0, DRY.indexOf("_=(e,n)")) + "quote:()=>{},fee:()=>x7?.evmFeeNow(e)??Promise.resolve(null),rungs:async()=>(e=>e===null||e.top===0n?null:e.rungs)(await g(e)),moved:async t=>(await g(e))?.cost(t)??null",
    ],
    // Cash's largest note alone (before card cash-buys-spend-every-note-evm), no epoch fee read, Cash's check dropped,
    // the size read on one move's split, another bound
    max: [
      MAX.replace("a().catch(()=>null)", "Promise.resolve(null)"),
      MAX.replace("e=>r.parts(e)!==null", "e=>!0"),
      MAX.replace(",r.rungs)", ")"),
      MAX.replace("o+r.top", "o+zK(r,l)"),
      // with no Cash a move can use, a Max other than tap_max
      MAX.replace("if(r.top===0n)return yq(o,Ko.ETH);", "if(r.top===0n)return yq(o+1n,Ko.ETH);"),
      // round 2: a plan of its own, not the dry's one read
      MAX.replace("r=await i()", "r=await g(e)"),
      // round 1's form: the epoch fee read at once, the plan read again
      "withCash:async(t,n)=>{let r=x7?.evmFeeNow(e).catch(()=>null)??Promise.resolve(null),i=await g(e),a=pK(t,Po.ETH);if(i===null||a===null)return null;if(i.top===0n)return _q(a,Po.ETH);let o=await r;if(o===null)return null;let s=pue(n,o,e=>i.parts(e)!==null,a+i.top,i.rungs);return _q(s>a?s:a,Po.ETH)}",
      "withCash:async(t,n)=>{let[a,o,s,c]=await Promise.all([r.available(),r.fee(),A.floor(e),x7?.evmFeeNow(e).catch(()=>null)??null]),l=i.get(e),u=bK(t,Qo.ETH);if(s===null||c===null||l==null||u===null)return null;let d=s>vD.min?s-vD.min:0n,f=M1(n,c,t=>{let n=UK(t,d,l,e);return n!==null&&n.usdc+o<=a},u+(a>o?zK(a-o,l):0n));return $K(f>u?f:u,Qo.ETH)}",
    ],
  };
  for (const [k, list] of Object.entries(broken)) for (const b of list) assert.equal(all({ [k]: b })[k], false, `${k}: ${b.slice(0, 100)}`);
});
