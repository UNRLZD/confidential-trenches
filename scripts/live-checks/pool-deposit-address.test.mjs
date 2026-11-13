// node --test scripts/live-checks/pool-deposit-address.test.mjs: the live check replays its recorded answers
// (pool-deposit-address.answers.json). good: this card's build: PASS. bad: main 7d70c9fd's build, and liveBefore:
// SIGN_HOST before this card's deploy: each FAIL, each mark named. Planted on the good one: another /app.js, no pin, each
// mark taken away: each FAIL. Planted in the bundle's own excerpt
// (pool-deposit-address.excerpt.txt, cut from this build's public/app.js: the pools' list and the namer, the namer, the
// record read, the host and its wiring): each rule the card adds taken away, and
// pool.address wired with no follow or no floor read, the network or floor-read gate, or the pool floor taken away
// (review F2, F3), and each stop check (card helper-says-why-a-vendor-refused): the mark it rests on FAILs. good: re-recorded
// at card pool-deposit-follow's build, then at card helper-says-why-a-vendor-refused's, its excerpt re-cut from that build
// (its delta review: the page's floor, the Solana floor and its reads added as the excerpt's last three lines). The namer's line
// re-cut from card signpage-passes-yield-to-a-trade's build (its lock-free read before nameDeposit), its name kept.
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

// card helper-says-why-a-vendor-refused: pool.address is handed the page's stop and checks it after each wait; SIGN_HOST
// before it fails on those two marks alone
test("recorded bad answer beforeStop: FAIL on unfollowed and stopped", () => {
  const v = judge(ANSWERS.beforeStop);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, bad("unfollowed", "stopped"));
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
  ["the namer handed no pools", new RegExp(`(\\{top:!${N},scope:${N},)pools:${N},`), "$1", ["namerPools"]],
  ["the pools' list keeps NEAR", new RegExp(`(flatMap\\(${N}=>)${N}\\.chain===\`near\`\\?\\[\\]:(\\[\\{chain:)`), "$1$2", ["namerPools"]],
  ["one scope that fails stops the rest", new RegExp(`(for\\(let\\{scope:${N},evm:${N}\\}of ${N}\\))try\\{(await ${N}\\([^)]*\\))\\}catch\\{\\}`), "$1$2", ["namesEach"]],
  ["every pool named as Solana", new RegExp(`evm:(${N})\\.chain!==\`solana\``), "evm:!1", ["namesEach"]],
  ["the EVM key not zeroed", new RegExp(`(\\{let (${N})=${N}\\(${N},${N},${N}\\);)\\2\\.secretKey\\.fill\\(0\\),`), "$1", ["namesRecord"]],
  ["the EVM record with no address", new RegExp(`,\\.\\.\\.${N}===void 0\\?\\{\\}:\\{evm:${N}\\}\\}\\)`), "})", ["namesRecord"]],
  // card signpage-passes-yield-to-a-trade: the record read with no lock first, nameDeposit asked only for a change
  ["every naming asks nameDeposit (its exclusive seed lock), the record not read first", new RegExp(`let ${N}=${N}\\(await ${N}\\.get\\(\`meta\`,${N}\\(${N}\\)\\)\\.catch\\(\\(\\)=>void 0\\)\\);${N}!==void 0&&[^;]*?\\)\\|\\|(?=await )`), "", ["namesRecord"]],
  ["a naming skipped on its scope alone, whatever its index", new RegExp(`&&\\((${N})\\.index>${N}\\|\\|${N}\\.index===${N}&&${N}\\.id===${N}\\.id&&${N}\\.evm===${N}\\)\\|\\|`), "||", ["namesRecord"]],
  ["a naming skipped with no compare of the EVM address", new RegExp(`&&(${N})\\.evm===${N}\\)\\|\\|`), ")||", ["namesRecord"]],
  ["a Solana wallet read from the record's EVM address", new RegExp(`\\?(${N})\\.evm===void 0\\?${N}\\.encode\\(${N}\\.decode\\(${N}\\.id\\)\\):null:`), "?$1.evm:", ["sameChain"]],
  ["the first pool, not the asked chain's", new RegExp(`\\.pools\\(\\)\\.find\\(${N}=>${N}\\.chain===${N}\\)`), ".pools()[0]", ["sameChain", "unfollowed"]],
  ["no follow gate", new RegExp(`(if\\()${N}===void 0\\|\\|${N}\\.checked===void 0\\|\\|`), "$1", ["unfollowed"]],
  ["the answer starts down, not not_allowed", new RegExp(`=\\{error:\`not_allowed\`\\}((?:,${N}=${N}\\.stop\\?\\.\\(\\),${N}=\\(\\)=>${N}\\?\\.aborted===!0)?;return\\{after:\\(async\\(\\)=>\\{let ${N}=${N}\\.chain,${N}=${N}\\.pools\\(\\))`), "={error:`down`}$1", ["unfollowed", "stopped"]],
  ["pool.address wired with no follow", new RegExp(`,checked:\\((${N}),(${N}),(${N}),(${N})\\)=>${N}\\.quoted\\(\\1,\\2,\\3,\\4\\),`), ",", ["unfollowed"]],
  // card helper-says-why-a-vendor-refused: pool.address is handed the page's stop on sign out (src/main.ts quotesStopped)
  ["pool.address wired with no stop", new RegExp(`(=>${N}\\.quoted\\(${N},${N},${N},${N}\\)),stop:${N}\\}\\)`), "$1})", ["unfollowed"]],
  // re-review P2: the stop read once and checked after each wait, and the ask handed it
  ["no stop check after the namer's wait", new RegExp(`if\\(await (${N})\\.named\\?\\.\\(\\)\\.catch\\(\\(\\)=>\\{\\}\\),${N}\\(\\)\\)return void\\(${N}=\\{error:\`down\`\\}\\);`), "await $1.named?.().catch(()=>{});", ["stopped"]],
  ["no stop check after the floor read", new RegExp(`(\\}catch\\{${N}=\\{error:\`down\`\\};return\\})if\\(${N}\\(\\)\\)return void\\(${N}=\\{error:\`down\`\\}\\);(if\\(${N}===null\\)return;)`), "$1$2", ["stopped"]],
  ["no stop check after the second record read", new RegExp(`(let ${N}=${N}\\(await ${N}\\.read\\(${N}\\.scope\\),${N},${N}\\.scope\\);)if\\(${N}\\(\\)\\)return void\\(${N}=\\{error:\`down\`\\}\\);(if\\(!${N}\\|\\|!${N}\\(${N},${N}\\)\\)return;)`), "$1$2", ["stopped"]],
  // delta review P3-5, P3-6: the stop after the follow's write, handed to the floor read and on to its RPC reads
  ["no stop check after the follow's write", new RegExp(`if\\(await (${N}\\.checked\\([^;]*?\\)),${N}\\(\\)\\)return void\\(${N}=\\{error:\`down\`\\}\\);`), "await $1;", ["stopped"]],
  ["the floor read not handed the stop", new RegExp(`(=await ${N}\\.floor\\(${N},${N}\\.wallet),${N}\\)\\}`), "$1)}", ["stopped"]],
  ["the page's floor keeps the stop from the Solana floor", new RegExp(`(\\?${N}\\(${N},${N}\\.program,${N}),${N}\\):null\\}`), "$1):null}", ["stopped"]],
  ["the Solana floor keeps it from its reads", new RegExp(`(\\{let\\{fee:${N},rent:${N}\\}=await ${N}\\(${N},${N},${N}),${N}\\);`), "$1);", ["stopped"]],
  ["no check before the floor's reads start", new RegExp(`(\\{)${N}\\?\\.throwIfAborted\\(\\);(let ${N}=await ${N}\\(${N}\\),${N}=await Promise\\.all)`), "$1$2", ["stopped"]],
  ["no check before a blockhash read", new RegExp(`(async ${N}=>\\{)${N}\\?\\.throwIfAborted\\(\\);(let ${N}=\\(await ${N}\\(\`getLatestBlockhash\`)`), "$1$2", ["stopped"]],
  ["no check before a fee read, whose message names U_X", new RegExp(`(\\{stateSize:0,labelSize:0\\},${N},${N}\\);)${N}\\?\\.throwIfAborted\\(\\);`), "$1", ["stopped"]],
  ["the quote's ask not handed the stop", new RegExp(`(,${N}\\.fetch,void 0,void 0),${N}\\)\\}`), "$1)}", ["stopped"]],
  // with no floor read wired, none is handed the stop either
  ["pool.address wired with no floor read", new RegExp(`,floor:${N},checked:`), ",checked:", ["unfollowed", "stopped"]],
  ["no floor-read gate", new RegExp(`\\|\\|${N}\\.floor===void 0\\|\\|`), "||", ["unfollowed"]],
  ["no network gate (review F2)", new RegExp(`\\|\\|${N}\\.network!==\`mainnet\`\\)return;`), ")return;", ["unfollowed"]],
  ["the page's network not passed (review F2)", new RegExp(`(\\{pools:${N},)network:${N},(read:)`), "$1$2", ["unfollowed"]],
  ["no pool floor (review F3)", new RegExp(`return (${N})\\.minAmountOut<${N}\\.floor&&${N}\\(\`floor\`\\)`), "return $1", ["floored"]],
  ["a context floor under the rung let through (review F3)", new RegExp(`\\|\\|(${N})\\.floor<${N}\\[\\1\\.chain\\]\\)&&`), ")&&", ["floored"]],
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
