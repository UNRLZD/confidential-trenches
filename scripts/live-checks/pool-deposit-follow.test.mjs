// node --test scripts/live-checks/pool-deposit-follow.test.mjs: the live check replays its recorded answers
// (pool-deposit-follow.answers.json). good: this card's build: PASS. bad: origin/main 6616059d's build (release-91), and
// liveBefore: SIGN_HOST before this card's deploy: each FAIL, each mark named. Planted on the good one: another /app.js,
// no pin, each mark taken away: each FAIL. Planted in the bundle's own excerpt (pool-deposit-follow.excerpt.txt, cut from
// this build's public/app.js: the floor and its read, the quote check, the wiring, the follow's page deps, its reads and
// loop, the pool refund rule and the mover's key open): each rule the card adds taken away: the mark it rests on FAILs.
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
  ["pool.address handed no follow", new RegExp(`=>(${N})\\.quoted\\((${N}),(${N}),(${N}),(${N})\\)\\}\\)`), "=>void 0})", ["wired"]],
  ["the follow depositing through another kind", /\[`pool\.deposit`\],`solana`/, "[`pool.buy`],`solana`", ["wired"]],
  ["the follow with no refund mover", new RegExp(`,refund:(${N})\\(\\{read:`), ",other:$1({read:", ["wired"]],
  ["U_X's balance read at confirmed (G2)", /getBalance`,\[([\w$]+)\.u,\{commitment:`finalized`\}/, "getBalance`,[$1.u,{commitment:`confirmed`}", ["chainFirst"]],
  ["the higher balance counted", new RegExp(`=(${N})<(${N})\\?\\1:\\2,`), "=$1<$2?$2:$1,", ["chainFirst"]],
  ["a deposit under the floor", new RegExp(`if\\((${N})>=(${N})\\.floor\\)\\{`), "if(!0){", ["chainFirst"]],
  ["any end counted as landed", new RegExp(`\\|\\|(${N})===\`part_filled\`\\)&&`), "||!0)&&", ["chainFirst"]],
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
