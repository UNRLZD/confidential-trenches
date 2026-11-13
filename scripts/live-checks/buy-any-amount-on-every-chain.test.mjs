// node --test scripts/live-checks/buy-any-amount-on-every-chain.test.mjs: the live check's verdict replays recorded answers
// (buy-any-amount-on-every-chain.answers.json), each facts() over a tree's index.html and app.js:
//   good: this card's branch, built with packages/signpage/scripts/build-app.mjs --out: the index pins the bundle, and
//         its Max sums every note held on Base and Robinhood, a rest W buys an amount that is no whole note, and
//         Solana's Max is every ready set: PASS;
//   bad:  SIGN_HOST as served before the card: none of them: FAIL.
// Planted from those: each mark alone missing, and an index that pins another bundle or none.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { facts, judge } from "./buy-any-amount-on-every-chain.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "buy-any-amount-on-every-chain.answers.json"), "utf8"));
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

test("recorded bad answer: SIGN_HOST before the card: FAIL on every mark", () => {
  const r = judge(ANSWERS.bad);
  fails(r, /one note, not every note/);
  fails(r, /no W buys the rest/);
  fails(r, /Solana's Max is one set/);
});

test("planted: each mark alone, and the index's pin", () => {
  fails(mut((a) => (a.evm_max = false)), /one note, not every note/);
  fails(mut((a) => (a.evm_rest = false)), /no W buys the rest/);
  fails(mut((a) => (a.sol_max = false)), /Solana's Max is one set/);
  fails(mut((a) => (a.sha384 = ANSWERS.bad.sha384)), /not the one index\.html pins/);
  fails(mut((a) => (a.index = "<html></html>")), /pins no \/app\.js/);
});

test("facts() reads each mark from the minified code as the build writes it, and misses each when it is gone", () => {
  const index = '<script src="/app.js" integrity="x"></script>';
  const spend = "var Ez=e=>e.reduce((e,t)=>e+(t.chunk>t.feeCap?t.chunk-t.feeCap:0n),0n);";
  // as the build writes poolBalances' two sums and the page's split run
  const sum = "if(r.chain===`base`||r.chain===`robinhood`){for(let e of f)t.tapMax+=bz(e.own,e.others,d);continue}let p=Sz(f,d).reduce((e,t)=>e+t.spend,0n);p>t.tapMax&&(t.tapMax=p)";
  const split = "route:e=>r?.route?.(e)},n,i,{split:!0});if(`legs`in d){let t=d.legs}";
  const rest = "`buy(address,address,uint256,bytes)`;var Y=`owed/wbuy-evm`";
  const all = facts(index, `${spend}${sum};${split};${rest}`);
  assert.deepEqual([all.evm_max, all.evm_rest, all.sol_max], [true, true, true]);
  const none = facts(index, "var Ez=e=>e.reduce((e,t)=>t.chunk>e?t.chunk:e,0n);i>t.tapMax&&(t.tapMax=i);route:e=>r?.route?.(e)},n,i)");
  assert.deepEqual([none.evm_max, none.evm_rest, none.sol_max], [false, false, false]);
  // the Solana sum without the split run, and the split run without the sum
  assert.equal(facts(index, `${spend}${sum};${rest}`).sol_max, false);
  assert.equal(facts(index, `${spend}${split};${rest}`).sol_max, false);
});
