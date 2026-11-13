// node --test scripts/live-checks/max-is-what-you-hold-after-a-trade.test.mjs: the live check's verdict replays recorded
// answers (max-is-what-you-hold-after-a-trade.answers.json), each facts() over a tree's index.html and app.js, 13 Nov
// 18:38Z:
//   good: this card's branch, built with packages/signpage/scripts/build-app.mjs --out: the index pins the bundle, and it
//         prices Max at the mainnet buy's tip, asks that tip per set of pieces, and counts no change of 0 as too_small: PASS;
//   bad:  SIGN_HOST as served before the card: Max at the tip cap, the old spend, a change of 0 counted: FAIL.
// Planted from those: each mark alone missing, and an index that pins another bundle or none.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { facts, judge } from "./max-is-what-you-hold-after-a-trade.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "max-is-what-you-hold-after-a-trade.answers.json"), "utf8"));
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

test("recorded bad answer: SIGN_HOST before the card: FAIL on all three marks", () => {
  const r = judge(ANSWERS.bad);
  fails(r, /tip cap/);
  fails(r, /pick funds/);
  fails(r, /change of 0/);
});

test("planted: each mark alone, and the index's pin", () => {
  fails(mut((a) => (a.tip = false)), /tip cap/);
  fails(mut((a) => (a.spend = false)), /pick funds/);
  fails(mut((a) => (a.small = false)), /change of 0/);
  fails(mut((a) => (a.sha384 = ANSWERS.bad.sha384)), /not the one index\.html pins/);
  fails(mut((a) => (a.index = "<html></html>")), /pins no \/app\.js/);
});

test("facts() reads each mark from the minified code as the build writes it, and misses each when it is gone", () => {
  const index = '<script src="/app.js" integrity="x"></script>';
  const tip = "bK=e=>Tp(`mainnet`,e);function xK(e,t,n,r=bK){return Object.freeze(e.map(e=>e.chain===`solana`?QG(e.id,e.scope,eK(t,n,r)):e))}";
  const spend = "if(i=n(Math.min(r.length,4)),typeof i!=`bigint`||i<0n)throw Error(`the tap's tip is not a bigint at least 0`);if(i>a)return 0n";
  const small = "e.state===`UNSPENT`&&e.leaf!==void 0&&e.leaf.value>0n&&SD(r,e.leaf.value)===null";
  const all = facts(index, `${tip};${spend};${small}`);
  assert.deepEqual([all.tip, all.spend, all.small], [true, true, true]);
  // the code before the card, as SIGN_HOST served it
  const before = facts(index, "bK=yK(`mainnet`);function xK(e,t,n){return Object.freeze(e.map(e=>e.chain===`solana`?$G(e.id,e.scope,tK(t,n)):e))};e.state===`UNSPENT`&&e.leaf!==void 0&&SD(r,e.leaf.value)===null");
  assert.deepEqual([before.tip, before.spend, before.small], [false, false, false]);
});
