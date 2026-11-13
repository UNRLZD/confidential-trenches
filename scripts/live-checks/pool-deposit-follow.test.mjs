// node --test scripts/live-checks/pool-deposit-follow.test.mjs: the live check replays its recorded answers
// (pool-deposit-follow.answers.json). good: this card's build, re-recorded by card pool-deposit-op-txs (the run's end read
// from its {end, txs}, the follow function re-cut into the excerpt from that build), and by card evm-deposit-route-mainnet
// (the wiring, the follow's deps with its deposit and refund functions and depositFrom re-cut from that build), and by card evm-first-proof-inside-ten-seconds (the follow function re-cut from its build, twice: the
// costs a round under the floor holds, then only under it and never across a clock set back): PASS. bad: origin/main 6616059d's build (release-91), and
// liveBefore: SIGN_HOST before this card's deploy: each FAIL, each mark named. Planted on the good one: another /app.js,
// no pin, each mark taken away: each FAIL. Planted in the bundle's own excerpt (pool-deposit-follow.excerpt.txt, cut from
// this build's public/app.js: the floor and its read, the quote check, the wiring, the follow's page deps, its reads and
// loop, the fixed source and depositFrom (review H1), the pool refund rule and the mover's key open): each rule the card
// adds taken away: the mark it rests on FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, WHY } from "./pool-deposit-follow.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pool-deposit-follow.answers.json", import.meta.url), "utf8"));
const INDEX = ANSWERS.good.index;
const JS = readFileSync(new URL("./pool-deposit-follow.excerpt.txt", import.meta.url), "utf8");
const MARKS = Object.keys(WHY);
const bad = (...ks) => ks.map((k) => `BAD ${WHY[k]}`);
const N = "[\\w$]+";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

for (const k of ["bad", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, each mark named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, bad(...MARKS));
  });
}

// card helper-says-why-a-vendor-refused: pool.address is handed the page's stop; SIGN_HOST before it fails on that mark alone
test("recorded bad answer beforeStop: FAIL on wired alone", () => {
  const v = judge(ANSWERS.beforeStop);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, bad("wired"));
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const k of MARKS) assert.deepEqual(judge({ ...g, [k]: false }).lines, bad(k), k);
});

test("the excerpt of this build: every mark holds", () => {
  const f = facts(INDEX, JS);
  for (const k of MARKS) assert.equal(f[k], true, k);
});

const PLANTED = [
  ["the floor with no deposit cost", new RegExp(`\\+${N}\\(${N},${N},\\{stateSize:0,labelSize:0\\},\\{mark:0n,statePage:0n,labelPage:0n\\}\\)`), "", ["floor"]],
  ["the floor with no rent floor for U_X", new RegExp(`\\)\\+${N}\\(${N},0\\)\\}`), ")}", ["floor"]],
  ["the floor at a new page on one tree only", /labelPage:0n\}\)\+/, "labelPage:1n})+", ["floor"]],
  ["the floor held on amount out, not min out (R11)", new RegExp(`return (${N})\\.minAmountOut<(${N})\\.floor&&`), "return $1.amountOut<$2.floor&&", ["floor"]],
  ["a context floor under the rung let through", new RegExp(`\\|\\|(${N})\\.floor<${N}\\[\\1\\.chain\\]\\)&&`), ")&&", ["floor"]],
  ["the lower of the two RPCs' fees", new RegExp(`fee:(${N})\\[0\\]>\\1\\[1\\]`), "fee:$1[0]<$1[1]", ["floorRead"]],
  ["one RPC's fee only", new RegExp(`fee:(${N})\\[0\\]>\\1\\[1\\]\\?\\1\\[0\\]:\\1\\[1\\]`), "fee:$1[0]", ["floorRead"]],
  ["pool.address handed no floor read", new RegExp(`,floor:${N},checked:`), ",checked:", ["wired"]],
  ["pool.address handed no follow", new RegExp(`=>(${N})\\.quoted\\((${N}),(${N}),(${N}),(${N})\\),stop:`), "=>void 0,stop:", ["wired"]],
  // card helper-says-why-a-vendor-refused: pool.address is handed the page's stop on sign out (src/main.ts quotesStopped)
  ["pool.address handed no stop", new RegExp(`(=>${N}\\.quoted\\(${N},${N},${N},${N}\\)),stop:${N}\\}\\)`), "$1})", ["wired"]],
  ["the follow depositing from index 0, not the op's own U", new RegExp(`\\{s:BigInt\\((${N})\\.s\\),i:\\1\\.i,u:\\1\\.u\\}`), "{s:BigInt($1.s),i:0,u:$1.u}", ["wired"]],
  ["the follow depositing through the kinds' handler, not depositFrom", /\.depositFrom\(/, ".flow(", ["wired"]],
  ["the follow with no refund mover", new RegExp(`,refund:(${N})\\(async (${N})=>`), ",other:$1(async $2=>", ["wired"]],
  ["the refund mover at a floor not the one it is handed", new RegExp(`,floor:(${N}),priced:`), ",floor:async()=>0n,priced:", ["wired"]],
  ["U_X's balance read at confirmed (G2)", /getBalance`,\[([\w$]+)\.u,\{commitment:`finalized`\}/, "getBalance`,[$1.u,{commitment:`confirmed`}", ["chainFirst"]],
  ["the higher balance counted", new RegExp(`(=await ${N}\\.balances\\(${N}\\),${N}=)(${N})<(${N})\\?\\2:\\3;`), "$1$2<$3?$3:$2;", ["chainFirst"]],
  ["a deposit under the floor", new RegExp(`&&(${N})>=(${N})\\.floor\\)(?=${N}&&!${N}&&)`), "&&!0)", ["chainFirst"]],
  ["the costs read while U_X holds nothing (review L2)", new RegExp(`=(${N})>=(${N})\\.ladder\\.min\\?(${N})\\?\\.c\\?\\?await (${N})\\(\\)`), "=!0?$3?.c??await $4()", ["chainFirst"]],
  // card evm-first-proof-inside-ten-seconds: a carry on costs held from an earlier round, not read in its own
  ["a carry on held costs", new RegExp(`\\?(${N}):null,(${N})=(${N})>=(${N})\\.ladder\\.min\\?`), "?$1:null,$2=$3>=$4.ladder.min?$1?.c??0n:", ["chainFirst"]],
  ["the costs held past a balance that moved", new RegExp(`&&(${N})\\.low===(${N})&&`), "&&", ["chainFirst"]],
  // review of evm-first-proof-inside-ten-seconds: held across a clock set back, and held over the floor
  ["the costs held across a clock set back", new RegExp(`&&(${N})>=(${N})\\.at&&`), "&&", ["chainFirst"]],
  ["the costs held over the floor", new RegExp(`=(${N})!==null&&(${N})<\\1\\.floor\\?`), "=$1!==null?", ["chainFirst"]],
  ["an ended op's U_X read again on the follow's own reads, not a restore's paced ones (delta review P2-b)", /,again:e=>P3\(/, ",again:e=>(", ["wired"]],
  ["an ended op's U_X read again with no drawn wait first (delta review P2-b)", /,againWait:e=>wB\(e\)/, "", ["wired"]],
  ["a fixed source of another pool's scope let through (H1)", new RegExp(`if\\((${N})\\.s!==(${N})\\|\\|`), "if(", ["fromUX"]],
  ["a fixed source whose U is not the op's U_X let through (review 2 L2)", new RegExp(`\\|\\|(${N})\\((${N})\\)\\.address!==\\2\\.u\\)return\\{error:\`not_allowed\`\\};`), ")return{error:`not_allowed`};", ["fromUX"]],
  ["the kind drops the fixed source (review 2 L1)", new RegExp(`=await (${N})\\((${N}),(${N}),(${N})\\)\\}finally`), "=await $1($2,$3)}finally", ["fromUX"]],
  ["a fixed U with a note still landing deposited again (H1)", new RegExp(`if\\((${N})\\.has\\((${N})\\.i\\)\\)return\\{stage:\`not_landed\`,txs:\\[\\]\\};`), "", ["fromUX"]],
  ["a U the store never planned let through (H1)", new RegExp(`if\\((${N})===void 0\\)return\\{error:\`not_allowed\`\\};(${N})=\\{s:`), "$2={s:", ["fromUX"]],
  ["the newest-used-or-planned fallback kept with a fixed source (H1)", new RegExp(`if\\((${N})===void 0&&(${N})===0&&`), "if(!0&&$2===0&&", ["fromUX"]],
  ["depositFrom with no pool rule (H1)", new RegExp(`try\\{(${N})=${N}\\(\\{\\.\\.\\.(${N}),kind:\`pool\\.deposit\`\\}\\)\\}`), "try{$1=$2}", ["fromUX"]],
  ["depositFrom runs the Solana kind on any chain (H1)", new RegExp(`return (${N})\\.chain===\`solana\`\\?`), "return !0?", ["fromUX"]],
  ["depositFrom drops the fixed source on Base and Robinhood (card evm-deposit-route-mainnet)", new RegExp(`\\?\\.\\((${N}),(${N}),(${N})\\)\\?\\?\\{error:`), "?.($1,$2)??{error:", ["fromUX"]],
  ["any end counted as landed", new RegExp(`\\|\\|(${N})===\`part_filled\`\\)&&!await`), "||!0)&&!await", ["chainFirst"]],
  // card evm-deposit-route-mainnet review and re-read: a note of U_X's still landing holds in_pool and the end; a
  // landed note counts only after this quote's own SUCCESS; a carry U_X cannot pay with its fee shows short
  ["a carry counted landed with a later rung of U_X's still landing", new RegExp(`&&!await ${N}\\(\\);return (${N})&&`), ";return $1&&", ["chainFirst"]],
  ["in_pool shown while a note of U_X's is landing", new RegExp(`if\\(!(${N})&&(${N})!==\`in_pool\`&&`), "if($2!==`in_pool`&&", ["chainFirst"]],
  ["a neighbour's landed note counted before this quote's own SUCCESS (re-read P2-1)", new RegExp(`!(${N})&&!(${N})&&${N}&&(${N})\\.noted!==void 0`), "!$1&&!$2&&$3.noted!==void 0", ["chainFirst"]],
  ["SUCCESS never read as this quote's payment (re-read P2-1)", new RegExp(`${N}\\.status===\`SUCCESS\`&&\\(${N}=!0\\),`), "", ["chainFirst"]],
  ["a carry U_X cannot pay with its fee shown as nothing (re-read P3-2)", new RegExp(`${N}===\`not_funded\`&&!${N}&&await ${N}\\(\`short\`\\),`), "", ["chainFirst"]],
  // card deposit-takes-each-pools-own-coin: a plain carry of money not its own shows nothing (review P3-a), its base is
  // lowered to what U_X reads, and a note of U_X's landing or a deposit that filled reads at the fast pace
  ["a plain carry shown in_pool before its own money was seen", new RegExp(`&&\\(!${N}\\|\\|${N}\\)&&\\((${N})=!0,await`), "&&($1=!0,await", ["chainFirst"]],
  ["a plain send's base never lowered", new RegExp(`;(${N})&&(${N})<(${N})&&\\(\\3=\\2\\);let `), ";let ", ["chainFirst"]],
  ["no fast pace while a note of U_X's lands", new RegExp(`(=await ${N}\\(\\);)${N}&&\\(${N}=!0\\),`), "$1", ["chainFirst"]],
  ["the status read for U_X, not the refund id", new RegExp(`,Date\\.now\\(\\),(${N})\\.refund_id\\)`), ",Date.now(),$1.u)", ["chainFirst"]],
  ["a refund's move to another coin", new RegExp(`if\\((${N})\\.destinationAsset!==${N}\\[${N}\\]\\)return ${N}\\(\`destinationAsset\`\\);`), "", ["refundCarry"]],
  ["a refund's move to another wallet", new RegExp(`if\\((${N})\\.recipient!==(${N})\\.wallet\\)return ${N}\\(\`recipient\`\\);`), "", ["refundCarry"]],
  ["a refund's move refunding elsewhere", new RegExp(`if\\((${N})\\.refundTo!==(${N})\\.id\\)return ${N}\\(\`refundTo\`\\);`), "", ["refundCarry"]],
  ["a refund's move under the floor", new RegExp(`return (${N})\\.minAmountOut<(${N})\\.floor\\?${N}\\(\`floor\`\\):`), "return ", ["refundCarry"]],
  ["a refund's move from another U_X", new RegExp(`try\\{${N}\\(${N},${N}\\.wallet,${N}\\.id\\)\\}catch\\{return ${N}\\(\`deposit_wallet\`\\)\\}`), "", ["refundCarry"]],
  ["the mover's key not the op's refund id", new RegExp(`if\\((${N})\\.id!==(${N})\\.refund_id\\)throw`), "if(!1)throw", ["refundCarry"]],
];

for (const [name, from, to, fails] of PLANTED) {
  test(`planted in the excerpt: ${name}: FAIL on ${fails.join(", ")}`, () => {
    assert.equal((JS.match(new RegExp(from.source, "g")) ?? []).length, 1, `${name}: the plant's site is in the build once`);
    const js = JS.replace(from, to);
    const f = facts(INDEX.replace(/integrity="sha384-[^"]+"/, `integrity="${facts("", js).sha384}"`), js);
    assert.deepEqual(judge(f).lines, bad(...fails), name);
  });
}

// card evm-deposit-on-mainnet: depositFrom's Solana branch under the one rule (the pool's withdraw in the build,
// src/pool-testnet.ts poolWayOut) reads as before; the rule's clause standing in for the pin guard does not
test("planted in the excerpt: depositFrom's Solana branch with the withdraw rule beside the pin guard: PASS; the rule in the pin guard's place: FAIL on fromUX", () => {
  const site = /n===void 0\?\{error:`not_allowed`\}:S\(i,r,t\)/;
  assert.equal((JS.match(new RegExp(site.source, "g")) ?? []).length, 1, "the plant's site is in the build once");
  const pinned = (js) => facts(INDEX.replace(/integrity="sha384-[^"]+"/, `integrity="${facts("", js).sha384}"`), js);
  const ruled = JS.replace(site, "n===void 0||!X(`solana`)?{error:`not_allowed`}:S(i,r,t)");
  assert.deepEqual(judge(pinned(ruled)).lines, [], "the rule beside the pin guard");
  const dropped = JS.replace(site, "!X(`solana`)?{error:`not_allowed`}:S(i,r,t)");
  assert.deepEqual(judge(pinned(dropped)).lines, bad("fromUX"), "the pin guard dropped for the rule");
});
