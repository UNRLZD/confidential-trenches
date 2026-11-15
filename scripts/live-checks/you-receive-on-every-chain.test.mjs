// node --test scripts/live-checks/you-receive-on-every-chain.test.mjs: the live check's verdict replays recorded answers
// (you-receive-on-every-chain.answers.json), each facts() over a tree's index.html and app.js:
//   good: this card's branch, built with packages/signpage/scripts/build-app.mjs --out: the index pins the bundle, and
//         its dry prices a Solana buy above one tap (the move's notes, cashFirst sized to it), answers cost and out on
//         Base and Robinhood, and takes and answers NEAR: PASS;
//   bad:  SIGN_HOST as served before the card: none of them: FAIL.
// Planted from those: each mark alone missing, and an index that pins another bundle or none.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { facts, judge } from "./you-receive-on-every-chain.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "you-receive-on-every-chain.answers.json"), "utf8"));
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

test("recorded bad answer: SIGN_HOST before the card: FAIL on every chain", () => {
  const r = judge(ANSWERS.bad);
  fails(r, /^BAD Solana/);
  fails(r, /^BAD Base and Robinhood/);
  fails(r, /^BAD NEAR/);
});

test("planted: each mark alone, and the index's pin", () => {
  fails(mut((a) => (a.sol = false)), /^BAD Solana/);
  fails(mut((a) => (a.evm = false)), /^BAD Base and Robinhood/);
  fails(mut((a) => (a.near = false)), /^BAD NEAR/);
  fails(mut((a) => (a.sha384 = ANSWERS.bad.sha384)), /not the one index\.html pins/);
  fails(mut((a) => (a.index = "<html></html>")), /pins no \/app\.js/);
});

test("facts() reads each mark from the minified code as the build writes it, and misses each when it is gone", () => {
  const index = '<script src="/app.js" integrity="x"></script>';
  // as the build writes them (packages/signpage built at this card's branch)
  const sol = "notes.map((e,t)=>({noteId:`move#${t}`,own:!0,chunk:e,wallet:{address:`move#${t}`}}));u=l!==null&&a===`solana`&&c.short?await c.short(a,i,n.amount).catch(()=>null):null";
  const near = "g=e=>{if(e.chain===`near`)return h(e);if((e.chain===`base`||e.chain===`robinhood`)&&g7)return 1};d=e.amountOut>0n?$V(e.amountOut,n):void 0";
  const params = 'X={from:Bh,to:Bh,amount:Dh};Y={"pool.buy.dry":K({chain:Bh,token:Ih},{amount:Dh})}';
  const evm = ANSWERS.evm_sample;
  const all = facts(index, `${sol};${near};${params};${evm}`);
  assert.deepEqual([all.sol, all.evm, all.near], [true, true, true]);
  // each gone: the bare gap moved, no NEAR route, NEAR's params on the pool chains' check, no EVM cost and out
  assert.equal(facts(index, `${sol.replace("c.short?await c.short", "0?0")};${near};${params};${evm}`).sol, false);
  assert.equal(facts(index, `${sol};${near.replace("chain===`near`", "chain===`x`")};${params};${evm}`).near, false);
  assert.equal(facts(index, `${sol};${near};${params.replace("chain:Bh", "chain:Ph")};${evm}`).near, false);
  assert.equal(facts(index, `${sol};${near};${params}`).evm, false);
});
