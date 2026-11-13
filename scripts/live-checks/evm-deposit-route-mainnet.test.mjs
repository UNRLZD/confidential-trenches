// node --test scripts/live-checks/evm-deposit-route-mainnet.test.mjs: the live check replays its recorded answers
// (evm-deposit-route-mainnet.answers.json). good: this card's build: PASS. liveBefore: SIGN_HOST before this card's
// deploy: FAIL, each mark named. Planted on the good one: another /app.js, no pin, each mark taken away: each FAIL. Planted
// in the bundle's own excerpt (evm-deposit-route-mainnet.excerpt.txt, cut from this build's public/app.js: the EVM floor,
// its constants and its reads, the follow deps and their landed-tx read, the wiring and the page's network, the open-note
// hold, the fixed source, the EVM kind and depositFrom): each rule the card adds taken away: the mark it rests on FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, WHY } from "./evm-deposit-route-mainnet.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./evm-deposit-route-mainnet.answers.json", import.meta.url), "utf8"));
const INDEX = ANSWERS.good.index;
const JS = readFileSync(new URL("./evm-deposit-route-mainnet.excerpt.txt", import.meta.url), "utf8");
const MARKS = Object.keys(WHY);
const bad = (...ks) => ks.map((k) => `BAD ${WHY[k]}`);
const N = "[\\w$]+";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer liveBefore: FAIL, each mark named", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, bad(...MARKS));
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const k of MARKS) assert.deepEqual(judge({ ...g, [k]: false }).lines, bad(k), k);
});

test("the excerpt of this build: every mark holds, no wallet reader yet", () => {
  const f = facts(INDEX, JS);
  for (const k of MARKS) assert.equal(f[k], true, k);
  assert.equal(f.reader, "none");
});

// pool-testnet.ts pageEvmWalletRpc as SIGN_HOST's build minifies it (evm-deposit-on-mainnet.test.mjs plants the same), and
// its helper address: planted beside the excerpt, which holds neither
const HELPER_READER =
  ";var H=`https://ct-api.unrealized.trade`;var pageEvmWalletRpc=(e,t=!1)=>{if(t)return;let n=M.get(e);if(n===void 0){let t=C(H,e);M.set(e,n=Object.assign((e,n)=>t(e,n),{url:`${H}/v1/rpc/${e}`}))}return n};";

test("the wallet reader wired (the helper's reader by its name): read as wired, never judged", () => {
  const f = facts(INDEX, JS.replace(/wallet:[\w$]+=>void 0,notes:/, "wallet:pageEvmWalletRpc,notes:") + HELPER_READER);
  assert.equal(f.reader, "wired");
  for (const k of MARKS) assert.equal(f[k], true, k);
});

test("review P3-4: a wallet reader that is not the helper's route (another function, or the reader with another address) reads other and FAILs on wired", () => {
  const other = facts(INDEX, JS.replace(/wallet:[\w$]+=>void 0,notes:/, "wallet:e=>Y(e),notes:") + HELPER_READER + "var Y=e=>fetch(e);");
  assert.equal(other.reader, "other");
  assert.equal(other.wired, false);
  const elsewhere = facts(INDEX, JS.replace(/wallet:[\w$]+=>void 0,notes:/, "wallet:pageEvmWalletRpc,notes:") + HELPER_READER.replace("https://ct-api.unrealized.trade", "https://rpc.example"));
  assert.equal(elsewhere.reader, "other");
  assert.equal(elsewhere.wired, false);
});

const PLANTED = [
  ["the floor with no L1 fee", /\+e\.l1Fee\}/, "}", ["floor"]],
  ["the floor at one base fee, not two", /\(2n\*e\.baseFee\+e\.tip\)/, "(e.baseFee+e.tip)", ["floor"]],
  ["the floor with no headroom", new RegExp(`\\+${N}\\(e\\.stateDepth,e\\.labelDepth\\)\\)`), ")", ["floor"]],
  ["the ladder's least rung under 0.001 ETH (the floor and the follow both rest on it)", /min:1000000000000000n\}/, "min:1n}", ["floor", "follow"]],
  ["the floor at less than the capped gas", new RegExp(`,(${N})=1000000n,`), ",$1=21000n,", ["floor"]],
  ["U's tip above the cap", new RegExp(`,(${N})=10000000n,`), ",$1=1n,", ["floor"]],
  ["the base fees of the two RPCs not held equal", new RegExp(`\\((${N})\\[0\\]!==\\1\\[1\\]\\|\\|`), "(!1||", ["floor"]],
  ["the base fee off the agreed block", new RegExp(`\\|\\|(${N})\\.baseFeePerGas!==(${N})\\[0\\]\\)&&`), ")&&", ["floor"]],
  ["the L1 fee read without the headroom", new RegExp(`await (${N})\\((${N}),(${N})\\+(${N})\\((${N})\\.state\\[0\\],\\5\\.label\\[0\\]\\),`), "await $1($2,$3,", ["floor"]],
  ["the floor read not the floor of the price", new RegExp(`return ${N}\\(await (${N})\\(e,t\\)\\)`), "return $1(e,t)", ["floor"]],
  ["U_X polled on one pool RPC, not the wallet reader", /if\(e\.wallet===void 0\)return/, "if(!0)return", ["follow"]],
  ["U_X's reading on the wallet reader counted once", /return\[i,i\]\}/, "return[i,0n]}", ["follow"]],
  ["the follow ended on the wallet reader's word, not the pool's two RPCs (review P1)", /\{chainBalances:/, "{otherBalances:", ["follow"]],
  ["the EVM follow deps drop the refund mover", /,\.\.\.e\.refund\?\{refund:e\.refund\}:\{\}/, "", ["follow"]],
  ["the follow at a floor not the floor read", new RegExp(`costs:async\\(\\)=>\\{let (${N})=await ${N}\\(`), "costs:async()=>{let $1=await Number(", ["follow"]],
  ["the follow keeping money in U_X", /keep:0n\}/, "keep:1n}", ["follow"]],
  ["the per-rung cost the whole floor", new RegExp(`perRung:(${N})-(${N})\\.min,`), "perRung:$1,", ["follow"]],
  ["the deadline past on one clock", /\.every\(/, ".some(", ["follow"]],
  ["the status read for U_X, not the refund id", /Date\.now\(\),t\.refund_id\)/, "Date.now(),t.u)", ["follow"]],
  ["a mainnet page quoting with no wallet reader", new RegExp(`return (${N})\\.network!==\`testnet\`&&(${N})===void 0\\?null:`), "return ", ["wired"]],
  ["a page network that is not the build's", new RegExp(` (${N})=\`mainnet\`,`), " $1=`main`,", ["wired"]],
  ["the EVM quote floored on Solana's read", new RegExp(`return (${N})===null\\?null:${N}\\(\\1\\.rpcs,\\1\\.pin\\)\\}`), "return $1===null?null:0n}", ["wired"]],
  ["the EVM follow with no refund mover", /,deposit:r,refund:i\(/, ",deposit:r,other:i(", ["wired"]],
  ["the EVM follow's refund at another floor", new RegExp(`refund:(${N})\\(\\(\\)=>${N}\\((${N})\\.rpcs,\\2\\.pin\\)\\)`), "refund:$1(()=>0n)", ["wired"]],
  ["the EVM follow with no landed-note read on a reload (review P2a)", /,noted:b,open:x\}\}/, ",noted:void 0,open:x}}", ["wired"]],
  ["the EVM floor wired to Solana's floor", /return g\.floor\(e\);/, "return null;", ["wired"]],
  ["the follow's deposit from index 0, not the op's own U", /i:e\.i,u:e\.u\}/, "i:0,u:e.u}", ["wired"]],
  ["the follow's deposit on Solana always", new RegExp(`,e\\.chain,(${N})\\[(${N})\\[e\\.chain\\]\\]`), ",`solana`,$1[$2[e.chain]]", ["wired"]],
  ["a fixed source of another scope let through", new RegExp(`if\\((${N})\\.s!==(${N})\\)return\\{error:\`not_allowed\`\\};`), "", ["fromUX"]],
  ["a fixed U that is not the op's U_X let through", new RegExp(`,(${N})\\.address!==(${N})\\.u\\)return`), ",!1)return", ["fromUX"]],
  ["a fixed U with a note still landing deposited again", new RegExp(`if\\((${N})\\.has\\((${N})\\.i\\)\\)return\\{stage:\`not_landed\`,txs:\\[\\]\\};`), "", ["fromUX"]],
  ["a U the store never planned let through", new RegExp(`if\\(!\\(await (${N})\\(\\)\\)\\.some\\(`), "if(!0||!(await $1()).some(", ["fromUX"]],
  ["the run with a fixed source paying from the newest landed U", new RegExp(`\\{kind:\`deposit\`,s:(${N}),i:(${N})\\.i\\},null`), "{kind:`deposit`,s:$1,i:0},null", ["fromUX"]],
  ["a fixed source's run reading another U's landing (review P3)", /if\(r!==void 0&&i!==r\.i\)continue;/, "", ["fromUX"]],
  ["the EVM kind drops the fixed source", /\},n,a,i\)/, "},n,a)", ["fromUX"]],
  ["depositFrom drops the fixed source on Base and Robinhood", new RegExp(`\\?\\.\\((${N}),(${N}),(${N})\\)\\?\\?\\{error:`), "?.($1,$2)??{error:", ["fromUX"]],
  ["depositFrom runs the Solana kind on every chain", new RegExp(`return (${N})\\.chain===\`solana\`\\?`), "return !0?", ["fromUX"]],
  // review: every rung's tx reaches the op, a later rung still landing holds in_pool and the end
  ["the EVM follow with no landed-tx read", /,\.\.\.e\.notes===void 0\?\{\}:\{landed:/, ",...!0?{}:{landed:", ["landed"]],
  ["a landed send read at latest, not finalized", /\[`finalized`,!1\]\)\]\);if\(i===null\)return null;/, "[`latest`,!1])]);if(i===null)return null;", ["landed"]],
  ["the two RPCs' tx reads not held alike", /if\(i!==a\)throw Error\(`the RPCs read a deposit tx apart`\);/, "", ["landed"]],
  ["the route not handing the follow the notes", /,\.\.\.e\.notes===void 0\?\{\}:\{notes:e\.notes\}/, "", ["wired"]],
  ["main.ts's route with no notes", new RegExp(`,notes:\\(\\)=>${N}\\(\\)\\}\\)`), "})", ["wired"]],
  ["the EVM follow with no open-note hold", /,noted:b,open:x\}\}/, ",noted:b}}", ["wired"]],
  ["the open-note hold on landed notes, not landing ones", new RegExp(`e\\.state===\`INCOMING\`&&(${N})\\(e,t\\)`), "e.state===`UNSPENT`&&$1(e,t)", ["wired"]],
];

for (const [name, from, to, fails] of PLANTED) {
  test(`planted in the excerpt: ${name}: FAIL on ${fails.join(", ")}`, () => {
    assert.equal((JS.match(new RegExp(from.source, `g${from.flags}`)) ?? []).length, 1, `${name}: the plant's site is in the build once`);
    const js = JS.replace(from, to);
    const f = facts(INDEX.replace(/integrity="sha384-[^"]+"/, `integrity="${facts("", js).sha384}"`), js);
    assert.deepEqual(judge(f).lines, bad(...fails), name);
  });
}

// card evm-deposit-on-mainnet: the new shapes this check reads, each with its bad twin
const pinned = (js) => facts(INDEX.replace(/integrity="sha384-[^"]+"/, `integrity="${facts("", js).sha384}"`), js);
test("planted in the excerpt: depositFrom's Solana branch with the withdraw rule beside the pin guard: PASS; the rule in the pin guard's place: FAIL on fromUX", () => {
  const site = /n===void 0\?\{error:`not_allowed`\}:C\(i,r,t\)/;
  assert.equal((JS.match(new RegExp(site.source, "g")) ?? []).length, 1, "the plant's site is in the build once");
  assert.deepEqual(judge(pinned(JS.replace(site, "n===void 0||!X(`solana`)?{error:`not_allowed`}:C(i,r,t)"))).lines, [], "the rule beside the pin guard");
  assert.deepEqual(judge(pinned(JS.replace(site, "!X(`solana`)?{error:`not_allowed`}:C(i,r,t)"))).lines, bad("fromUX"), "the pin guard dropped for the rule");
});

test("planted in the excerpt: main.ts's reader as a call (wallet:e=>Z(e), the helper's route): PASS and wired; with it, a route that quotes a non-testnet page with no reader: FAIL on wired", () => {
  const call = (js) => js.replace(/wallet:([\w$]+)=>void 0,notes:/, "wallet:$1=>pageEvmWalletRpc($1),notes:") + HELPER_READER;
  const js = call(JS);
  assert.notEqual(js, JS, "the reader's site is in the build");
  assert.deepEqual(judge(pinned(js)).lines, []);
  assert.equal(pinned(js).reader, "wired");
  const guard = /network!==`testnet`&&r===void 0\?null:/;
  assert.equal((js.match(new RegExp(guard.source, "g")) ?? []).length, 1, "the guard's site is in the build once");
  assert.deepEqual(judge(pinned(js.replace(guard, ""))).lines, bad("wired"), "no reader still quotes");
  // what the reader reads (the helper's /v1/rpc route, nothing else) is evm-deposit-on-mainnet's: its planted cases
  // "a reader that is not our helper" and "no wallet reader" read false there
});
