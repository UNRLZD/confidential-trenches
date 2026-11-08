// node --test scripts/live-checks/pool-deposit-address.test.mjs: the live check replays its recorded answers
// (pool-deposit-address.answers.json). good: this card's build: PASS. bad: main 7d70c9fd's build, and liveBefore:
// SIGN_HOST before this card's deploy: each FAIL, each mark named. Planted on the good one: another /app.js, no pin, each
// mark taken away: each FAIL. Planted in the bundle's own excerpt
// (pool-deposit-address.excerpt.txt, cut from this build's public/app.js: the pools' list and the namer, the namer, the
// record read, the host and its wiring): each rule the card adds taken away, and
// pool.address wired with a follow, the network gate or the pool floor taken away (review F2, F3): the mark it rests on FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, WHY } from "./pool-deposit-address.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pool-deposit-address.answers.json", import.meta.url), "utf8"));
const INDEX = ANSWERS.good.index;
const JS = readFileSync(new URL("./pool-deposit-address.excerpt.txt", import.meta.url), "utf8");
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
  ["the namer handed no pools", new RegExp(`(\\{top:!${N},scope:${N},)pools:${N},`), "$1", ["namerPools"]],
  ["the pools' list keeps NEAR", new RegExp(`(flatMap\\(${N}=>)${N}\\.chain===\`near\`\\?\\[\\]:(\\[\\{chain:)`), "$1$2", ["namerPools"]],
  ["one scope that fails stops the rest", new RegExp(`(for\\(let\\{scope:${N},evm:${N}\\}of ${N}\\))try\\{(await ${N}\\([^)]*\\))\\}catch\\{\\}`), "$1$2", ["namesEach"]],
  ["every pool named as Solana", new RegExp(`evm:(${N})\\.chain!==\`solana\``), "evm:!1", ["namesEach"]],
  ["the EVM key not zeroed", new RegExp(`(\\{let (${N})=${N}\\(${N},${N},${N}\\);)\\2\\.secretKey\\.fill\\(0\\),`), "$1", ["namesRecord"]],
  ["the EVM record with no address", new RegExp(`,\\.\\.\\.${N}===void 0\\?\\{\\}:\\{evm:${N}\\}\\}\\)`), "})", ["namesRecord"]],
  ["a Solana wallet read from the record's EVM address", new RegExp(`\\?(${N})\\.evm===void 0\\?${N}\\.encode\\(${N}\\.decode\\(${N}\\.id\\)\\):null:`), "?$1.evm:", ["sameChain"]],
  ["the first pool, not the asked chain's", new RegExp(`\\.pools\\(\\)\\.find\\(${N}=>${N}\\.chain===${N}\\)`), ".pools()[0]", ["sameChain", "unfollowed"]],
  ["no follow gate", new RegExp(`(if\\()${N}===void 0\\|\\|${N}\\.checked===void 0\\|\\|`), "$1", ["unfollowed"]],
  ["the answer starts down, not not_allowed", new RegExp(`=\\{error:\`not_allowed\`\\}(;return\\{after:\\(async\\(\\)=>\\{let ${N}=${N}\\.chain,${N}=${N}\\.pools\\(\\))`), "={error:`down`}$1", ["unfollowed"]],
  ["pool.address wired with a follow", new RegExp(`("pool\\.address":${N}\\(\\{pools:${N},network:${N},read:${N}\\.depositRead,named:\\(\\)=>${N}\\.named\\(\\))\\}\\)`), "$1,checked:()=>{}})", ["unfollowed"]],
  ["no network gate (review F2)", new RegExp(`\\|\\|${N}\\.network!==\`mainnet\`\\)return;`), ")return;", ["unfollowed"]],
  ["the page's network not passed (review F2)", new RegExp(`(\\{pools:${N},)network:${N},(read:)`), "$1$2", ["unfollowed"]],
  ["no pool floor (review F3)", new RegExp(`return (${N})\\.minAmountOut<${N}\\[${N}\\.chain\\]&&${N}\\(\`floor\`\\)`), "return $1", ["floored"]],
  ["the vault's floor kept (review F3)", /intoVault:!1\}\);return/, "intoVault:!0});return", ["floored"]],
  ["the Solana floor at the vault's 1,000,000 lamports (review F3)", /\{one:1000000n,min:10000000n\}/, "{one:1000000n,min:1000000n}", ["floored"]],
  ["Robinhood's floor not the EVM ladder's (review F3)", new RegExp(`(robinhood:)${N}(\\.min\\})`), "$1other$2", ["floored"]],
];

for (const [name, from, to, fails] of PLANTED) {
  test(`planted in the excerpt: ${name}: FAIL on ${fails.join(", ")}`, () => {
    assert.equal((JS.match(new RegExp(from.source, "g")) ?? []).length, 1, `${name}: the plant's site is in the build once`);
    const js = JS.replace(from, to);
    const f = facts(INDEX.replace(/integrity="sha384-[^"]+"/, `integrity="${facts("", js).sha384}"`), js);
    assert.deepEqual(judge(f).lines, bad(...fails), name);
  });
}
