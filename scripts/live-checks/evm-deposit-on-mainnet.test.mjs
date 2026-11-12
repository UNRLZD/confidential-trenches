// node --test scripts/live-checks/evm-deposit-on-mainnet.test.mjs: card evm-deposit-on-mainnet's live check, replayed.
// evm-deposit-on-mainnet.answers.json holds two real runs from the Mac (`--record`), none edited:
// - good: `--local`, this card's SIGN_HOST build in SIGN_HOST's place, both mainnet pools on both of their RPCs and the
//   deployed helper read live: PASS;
// - bad_live_before: SIGN_HOST as served before this card (release 124: no Base or Robinhood deposit address, no EVM
//   withdraw in the mainnet bundle), the same chain and helper reads: FAIL on the page alone.
// And plants on the good run: each page marker missing, a pool with no code or two scopes, a helper that does not carry
// a pool, a provider silent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, pageFacts } from "./evm-deposit-on-mainnet.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-deposit-on-mainnet.answers.json", import.meta.url), "utf8"));
const spoil = (f) => {
  const a = structuredClone(A.good);
  f(a);
  return judge(a);
};

test("the recorded good run passes: this card's build offers and follows Base's and Robinhood's deposit and carries their withdraw, and both pools answer", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(A.good.from, "local build");
});

test("the recorded bad run fails, on the page alone: SIGN_HOST before this card", () => {
  const v = judge(A.bad_live_before);
  assert.equal(v.verdict, "FAIL");
  const bad = v.lines.filter((l) => l.startsWith("BAD"));
  assert.ok(bad.length >= 4 && bad.every((l) => l.includes("[SIGN_HOST]")), bad.join("\n"));
});

test("planted: each page marker missing, or a served bundle the index does not pin, is a FAIL", () => {
  for (const k of ["rule", "addressed", "reader"]) assert.equal(spoil((a) => (a.page[k] = false)).verdict, "FAIL", k);
  assert.equal(spoil((a) => (a.page.withdraw = 1)).verdict, "FAIL", "half the withdraw");
  assert.equal(spoil((a) => (a.page.pin = "sha384-other")).verdict, "FAIL", "pin");
});

test("planted: a pool with no code, code that differs, two scopes or a zero scope, or a read refused, is a FAIL", () => {
  const at = (a, net, what, k) => a.reads.filter((r) => r.net === net && r.what === what)[k];
  assert.equal(spoil((a) => (at(a, "base", "code", 0).answer.result = "0x")).verdict, "FAIL");
  assert.equal(spoil((a) => (at(a, "robinhood", "code", 1).answer.result = "0x60")).verdict, "FAIL");
  assert.equal(spoil((a) => (at(a, "base", "scope", 1).answer.result = "0x" + "1".padStart(64, "0"))).verdict, "FAIL");
  assert.equal(spoil((a) => { for (const r of a.reads.filter((x) => x.net === "robinhood" && x.what === "scope")) r.answer.result = "0x" + "0".repeat(64); }).verdict, "FAIL");
  assert.equal(spoil((a) => (at(a, "base", "scope", 0).answer = { error: { code: 3, message: "execution reverted" } })).verdict, "FAIL");
  assert.equal(spoil((a) => (a.reads = a.reads.filter((r) => !(r.net === "base" && r.what === "code")))).verdict, "FAIL", "no read is no pass");
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
