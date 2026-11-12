// node --test scripts/live-checks/evm-deposit-on-mainnet.test.mjs: card evm-deposit-on-mainnet's live check, replayed.
// evm-deposit-on-mainnet.answers.json holds two real runs from the Mac (`--record`, 12 Nov 23:44Z and 23:45Z), none edited:
// - good: `--local`, this card's SIGN_HOST build in SIGN_HOST's place, both mainnet pools on both of their RPCs, the
//   device's bind reads and the deployed helper read live: PASS;
// - bad_live_before: SIGN_HOST as served before this card (no Base or Robinhood deposit address, no EVM withdraw in the
//   mainnet bundle), the same chain, bind and helper reads: FAIL on the page alone.
// The fee part's bad answer is real too: each run keeps the helper's answer for the period before the bind's (`other`,
// another block), which in the bind's place FAILs. And plants on the good run: each page marker missing, a pool with no
// code or two scopes, a chain id that is not the chain's, a helper that does not carry a pool, a helper fee one step off
// the device's, a provider silent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkChain, deviceFee, judge, judgeBundle, pageFacts } from "./evm-deposit-on-mainnet.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-deposit-on-mainnet.answers.json", import.meta.url), "utf8"));
const spoil = (f) => {
  const a = structuredClone(A.good);
  f(a);
  return judge(a);
};

test("the recorded good run passes: this card's build offers and follows Base's and Robinhood's deposit and carries their withdraw, both pools answer, and the helper's fee is the device's own", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(A.good.from, "local build");
  for (const net of ["base", "robinhood"]) assert.ok(v.lines.some((l) => l.startsWith(`ok  [${net}] the helper's fee for the period`)), net);
});

test("the recorded bad run fails, on the page alone: SIGN_HOST before this card", () => {
  const v = judge(A.bad_live_before);
  assert.equal(v.verdict, "FAIL");
  const bad = v.lines.filter((l) => l.startsWith("BAD"));
  assert.ok(bad.length >= 4 && bad.every((l) => l.includes("[SIGN_HOST]")), bad.join("\n"));
  assert.equal(checkChain(A.bad_live_before).verdict, "PASS", "its chain and fee parts pass: the page alone fails it");
});

test("the bundle part alone (bundle-checks' run on a build): the good build passes, the build before this card fails", () => {
  assert.equal(judgeBundle(A.good).verdict, "PASS");
  assert.equal(judgeBundle(A.bad_live_before).verdict, "FAIL");
});

test("the fee part's recorded bad answer: the helper's answer for the period before, in the bind's place, FAILs (another block and epoch)", () => {
  for (const net of ["base", "robinhood"]) {
    const v = spoil((a) => (a.fee[net].helper = a.fee[net].other));
    assert.equal(v.verdict, "FAIL", net);
    assert.ok(v.lines.some((l) => l.startsWith(`BAD [${net}] the helper's fee for the period`)), v.lines.join("\n"));
  }
});

test("the --part helper run (after a helper deploy): no page read, the chain and the fee judged", () => {
  const helperRun = (f = () => {}) => {
    const a = structuredClone(A.good);
    delete a.page;
    a.part = "helper";
    f(a);
    return judge(a);
  };
  assert.equal(helperRun().verdict, "PASS");
  assert.equal(helperRun((a) => (a.fee.base.helper.body.fee = String(BigInt(a.fee.base.helper.body.fee) + 10_000_000_000_000n))).verdict, "FAIL");
});

test("planted: a helper fee one step off the device's, a bind with no base fee read, or no bind read at all, is a FAIL", () => {
  assert.equal(deviceFee(A.good.fee.base.bind).toString(), A.good.fee.base.helper.body.fee, "the device's fee is the recorded helper's");
  assert.equal(spoil((a) => (a.fee.robinhood.helper.body.fee = String(BigInt(a.fee.robinhood.helper.body.fee) - 10_000_000_000_000n))).verdict, "FAIL");
  assert.equal(spoil((a) => (a.fee.base.helper = { net: "base", status: 404, body: { error: { code: "not_found" } } })).verdict, "FAIL");
  assert.equal(spoil((a) => (a.fee.base.bind.baseFeePerGas = String(BigInt(a.fee.base.bind.baseFeePerGas) * 1000n))).verdict, "FAIL", "a fee at another base fee");
  assert.equal(spoil((a) => delete a.fee.robinhood).verdict, "FAIL", "no bind read is no pass");
  assert.equal(spoil((a) => (a.fee.base.bind = { start: a.fee.base.bind.start, ok: false, name: "Error", error: "relayFee: not this pool's" })).verdict, "FAIL");
});

test("planted: a bind that met a provider not yet holding the block, or no answer, is INCONCLUSIVE, never PASS", () => {
  assert.equal(spoil((a) => (a.fee.base.bind = { start: a.fee.base.bind.start, ok: false, name: "EvmLagError", error: "lag", lagging: ["mainnet.base.org"] })).verdict, "INCONCLUSIVE");
  assert.equal(spoil((a) => (a.fee.robinhood.bind = { start: a.fee.robinhood.bind.start, ok: false, name: "noAnswer", error: "no answer in 10000 ms" })).verdict, "INCONCLUSIVE");
  assert.equal(spoil((a) => (a.fee.base.helper = { net: "base", noAnswer: "ct-api.unrealized.trade: TypeError" })).verdict, "INCONCLUSIVE");
});

test("planted: each page marker missing, or a served bundle the index does not pin, is a FAIL", () => {
  for (const k of ["rule", "addressed", "reader"]) assert.equal(spoil((a) => (a.page[k] = false)).verdict, "FAIL", k);
  assert.equal(spoil((a) => (a.page.withdraw = 1)).verdict, "FAIL", "half the withdraw");
  assert.equal(spoil((a) => (a.page.pin = "sha384-other")).verdict, "FAIL", "pin");
});

test("planted: a pool with no code, code that differs, two scopes or a zero scope, a read refused, or a chain id not the chain's, is a FAIL", () => {
  const at = (a, net, what, k) => a.reads.filter((r) => r.net === net && r.what === what)[k];
  assert.equal(spoil((a) => (at(a, "base", "code", 0).answer.result = "0x")).verdict, "FAIL");
  assert.equal(spoil((a) => (at(a, "robinhood", "code", 1).answer.result = "0x60")).verdict, "FAIL");
  assert.equal(spoil((a) => (at(a, "base", "scope", 1).answer.result = "0x" + "1".padStart(64, "0"))).verdict, "FAIL");
  assert.equal(spoil((a) => { for (const r of a.reads.filter((x) => x.net === "robinhood" && x.what === "scope")) r.answer.result = "0x" + "0".repeat(64); }).verdict, "FAIL");
  assert.equal(spoil((a) => (at(a, "base", "scope", 0).answer = { error: { code: 3, message: "execution reverted" } })).verdict, "FAIL");
  assert.equal(spoil((a) => (a.reads = a.reads.filter((r) => !(r.net === "base" && r.what === "code")))).verdict, "FAIL", "no read is no pass");
  assert.equal(spoil((a) => (at(a, "robinhood", "chainId", 1).answer.result = "0x2105")).verdict, "FAIL", "Robinhood's second RPC on Base");
  assert.equal(at(A.good, "robinhood", "chainId", 0).answer.result, "0x1237", "Robinhood is chain 4663 as read");
});

test("planted: a helper that does not carry a pool (404, or another pool named) is a FAIL", () => {
  assert.equal(spoil((a) => Object.assign(a.helper.find((h) => h.net === "base"), { status: 404, body: { error: { code: "not_found" } } })).verdict, "FAIL");
  assert.equal(spoil((a) => (a.helper.find((h) => h.net === "robinhood").body.pool = "0x" + "11".repeat(20))).verdict, "FAIL");
});

test("planted: a provider or the helper silent is INCONCLUSIVE, never PASS", () => {
  assert.equal(spoil((a) => (a.reads[0].answer = { noAnswer: "mainnet.base.org: timeout" })).verdict, "INCONCLUSIVE");
  assert.equal(spoil((a) => (a.helper[0] = { net: "base", noAnswer: "ct-api.unrealized.trade: TypeError" })).verdict, "INCONCLUSIVE");
});

test("the page markers on planted bundles: a table that leaves a chain out, or a reader that is not the helper's, reads false", () => {
  const index = '<script type="module" src="/app.js" integrity="sha384-x"></script>';
  const js =
    "var X=Object.freeze({solana:!0,base:!0,robinhood:!0}),F=(e,t=X)=>t[e]===!0;var H=`https://ct-api.unrealized.trade`;" +
    "var Z=(e,t=!1)=>{if(t)return;let n=M.get(e);if(n===void 0){let t=C(H,e);M.set(e,n=Object.assign((e,n)=>t(e,n),{url:`${H}/v1/rpc/${e}`}))}return n};" +
    "function A(){return S().filter(e=>F(e.chain))}var K={\"pool.address\":P({pools:A,network:R}),q:1};" +
    "v=Q({network:R,pool:e=>T?.evmPoolOf(e)??null,wallet:e=>Z(e),notes:()=>a()});";
  const f = pageFacts(index, js);
  assert.deepEqual([f.rule, f.addressed, f.reader], [true, true, true], "the planted good shape reads true");
  assert.equal(pageFacts(index, js.replace("robinhood:!0", "robinhood:!1")).rule, false, "Robinhood left out");
  assert.equal(pageFacts(index, js.replace("filter(e=>F(e.chain))", "filter(e=>e.chain===`solana`)")).addressed, false, "addresses by another rule");
  assert.equal(pageFacts(index, js.replace("wallet:e=>Z(e)", "wallet:e=>void 0")).reader, false, "no wallet reader");
  assert.equal(pageFacts(index, js.replace("`https://ct-api.unrealized.trade`", "`https://rpc.example`")).reader, false, "a reader that is not our helper");
  assert.equal(pageFacts(index, js + "var X2=Object.freeze({solana:!0,base:!0,robinhood:!0}),F2=(e,t=X2)=>t[e]===!0;").rule, false, "a second copy beside it");
});
