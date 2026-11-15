// node --test scripts/live-checks/evm-cash-move-brings-its-fee.test.mjs: the live check's verdict replays recorded answers
// (evm-cash-move-brings-its-fee.answers.json), each facts() over a tree's index.html and app.js:
//   good: this card's branch, built with packages/signpage/scripts/build-app.mjs --out: the index pins the bundle, the
//         tap asks the page's size on Base and Robinhood, the size is the tap's plan over notes that pay their own
//         fees, the mover lands it as rungs with their gas, and the dry prices it above tap_max: PASS;
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
const SIZING =
  "function k1(e,t){if(e<=0n)return[];let n=t*D1;return qE(vD,e).notes.filter(e=>n<e).map((e,t)=>({noteId:`move#${t}`,chunk:e,fee:n}))}function A1(e,t,n){let a=e=>{try{let e=rP({kind:`pool.buy`,chain:`base`,token:null,amount:t,slippageBps:0,decimals:0},o,s);return e.amount===t?e:null}catch(e){return null}}}";
const MOVE =
  "function UK(e,t,n,r){let i=LK[r];if(e<=0n||t<0n||e>=1n<<127n)return null;let a=(e+i-1n)/i*i,o=qE(RK[r],a).notes.length,s=a+BigInt(o)*t,c=VK(s,n,r);return c===null?null:{left:s,notes:o,usdc:c}};if(n!==`solana`){let t=s===null?null:await e.floor?.(n).catch(()=>null),i=s===null||typeof t!=`bigint`?null:UK(r,t>LK[n]?t-LK[n]:0n,s,n);c=i?.left??r,d=i?.usdc??null}";
const DRY =
  "s=i!==null&&typeof o==`bigint`&&i>o&&n.fee!==void 0&&n.moved!==void 0,c=s?(async()=>{let e=await n.fee(),r=e===null?null:A1(t.ready,i,e),a=r===null?null:await n.moved(r.short);return r===null||a===null||a<0n?null:{plan:r.plan,cost:E1(r.plan)+a}})():null;quote:()=>{},fee:()=>x7?.evmFeeNow(e)??Promise.resolve(null),moved:async t=>{}";
const all = (o = {}) => facts("", [o.tap ?? TAP, o.sizing ?? SIZING, o.move ?? MOVE, o.dry ?? DRY].join(";"));

test("facts() reads each mark from the minified code as the build writes it, and misses each when it is broken", () => {
  assert.deepEqual(Object.fromEntries(Object.keys(SAYS).map((k) => [k, all()[k]])), { tap: true, sizing: true, move: true, dry: true });
  const broken = {
    tap: [
      // card you-receive-on-every-chain's form: the size asked on Solana alone, an EVM ask moved as its rung
      TAP.replace("l<n.amount&&c.short", "l<n.amount&&a===`solana`&&c.short").replace("?n.amount-e:null", "?n.amount-e:HK(a,n.amount)?n.amount:null"),
      TAP.replace("?n.amount-e:null", "?n.amount-e:HK(a,n.amount)?n.amount:null"),
      TAP.replace("c.short(a,i,n.amount)", "c.short(a,i,n.amount-l)"),
      TAP.replace("&&c.short?await c.short", "&&0?await 0"),
    ],
    sizing: [SIZING.replace("let n=t*D1", "let n=t"), SIZING.replace("fee:n}", "fee:t}"), SIZING.replace("return e.amount===t?e:null", "return e"), SIZING.replace("filter(e=>n<e)", "filter(e=>1)")],
    move: [MOVE.replace("s=a+BigInt(o)*t", "s=a+t"), MOVE.replace("a=(e+i-1n)/i*i", "a=e"), MOVE.replace(":UK(r,", ":XX(r,"), MOVE.replace("c=i?.left??r", "c=r")],
    dry: [DRY.replace("&&n.moved!==void 0", ""), DRY.replace("cost:E1(r.plan)+a", "cost:a"), DRY.replace("fee:()=>x7?.evmFeeNow(e)", "fee:()=>x7?.relayFee(e)")],
  };
  for (const [k, list] of Object.entries(broken)) for (const b of list) assert.equal(all({ [k]: b })[k], false, `${k}: ${b.slice(0, 100)}`);
});
