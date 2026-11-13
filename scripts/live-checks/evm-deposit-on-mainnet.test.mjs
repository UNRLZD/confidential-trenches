// node --test scripts/live-checks/evm-deposit-on-mainnet.test.mjs: card evm-deposit-on-mainnet's live check, replayed.
// evm-deposit-on-mainnet.answers.json holds two real runs from the Mac (`--record`, 13 Nov 04:46Z and 00:41Z), none edited:
// - good: `--local`, this card's SIGN_HOST build (its no-leaf read marked) in SIGN_HOST's place, both mainnet pools on both of their RPCs, the
//   device's bind reads and the deployed helper read live: PASS;
// - bad_live_before: SIGN_HOST as served before this card (no Base or Robinhood deposit address, no EVM withdraw in the
//   mainnet bundle), the same chain, bind and helper reads: FAIL on the page alone.
// The fee part's bad answer is real too: each run keeps the helper's answer for the period before the bind's (`other`,
// another block), which in the bind's place FAILs. And plants on the good run: each page marker missing, a pool with no
// code or two scopes, a chain id that is not the chain's, a helper that does not carry a pool, a helper fee one step off
// the device's, a provider silent, each EVM withdraw site off the rule (and, on planted bundles, each one folded).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkChain, deviceFee, judge, judgeBundle, noLeafRead, pageFacts } from "./evm-deposit-on-mainnet.mjs";

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

test("planted: each EVM withdraw site off the rule, or not read, is a FAIL on the page alone", () => {
  for (const k of ["host", "flow", "deps", "run", "owed"]) {
    const v = spoil((a) => (a.page.withdrawSites[k] = false));
    assert.equal(v.verdict, "FAIL", k);
    assert.deepEqual(v.lines.filter((l) => l.startsWith("BAD")).map((l) => l.slice(-(k.length + 2))), [`(${k})`], v.lines.join("\n"));
  }
  assert.equal(spoil((a) => delete a.page.withdrawSites).verdict, "FAIL", "not read");
});

test("the withdraw sites on planted bundles, in the minified shape of this build: each one folded behind a constant (POOL_TESTNET on SIGN_HOST) reads false", () => {
  const Q = "`";
  const js =
    "var X=Object.freeze({solana:!0,base:!0,robinhood:!0}),F=(e,t=X)=>t[e]===!0;" +
    "function P(t){let n=t.pin,r=e=>F(e,t.withdrawBuilt),A=e=>null,Kt=(n,i)=>{if(!r(n))return null;let a=A(n);if(a===null)return null;let o=t.evmQueuePool?.(n)??0;return o}," +
    `Ut=async(e,t)=>{if(!(!Ot||!r(e.chain)||(e.chain===${Q}solana${Q}?n===void 0:A(e.chain)===null))){}},` +
    `Xt=(e,t)=>{let n=r(e)?A(e):null;return{chain:e,keys:{pool:n?.pin.pool??${Q}${Q}}}},` +
    `S=async()=>{let p=d.chain;if(p===${Q}base${Q}||p===${Q}robinhood${Q}){let e=Kt(p,s)}},` +
    `w=(t,i)=>t.kind===${Q}pool.withdraw${Q}&&r(t.chain)&&e.openWithdraw&&A(t.chain)!==null?e.openWithdraw(t.chain,i)??{error:${Q}not_allowed${Q}}:{error:${Q}not_allowed${Q}};return w}`;
  const sites = (s) => pageFacts("", s).withdrawSites;
  assert.deepEqual(sites(js), { host: true, flow: true, deps: true, run: true, owed: true }, "the planted good shape reads true");
  const folds = {
    // M1: the host's first statement a constant's return
    host: js.replace("Kt=(n,i)=>{if(!r(n))return null;", "Kt=(n,i)=>{return null;if(!r(n))return null;"),
    // M1d: the flow's branch without the rule
    flow: js.replace(`&&r(t.chain)&&e.openWithdraw`, "&&e.openWithdraw"),
    // M1c: the screen's pool folded to null
    deps: js.replace("let n=r(e)?A(e):null;", "let n=null;"),
    // M1e: the run refused for every chain but Solana
    run: js.replace("if(!(!Ot||!r(e.chain)||", `if(!(!Ot||e.chain!==${Q}solana${Q}||!r(e.chain)||`),
    // G9: a reload's owed finish dropped
    owed: js.replace(`if(p===${Q}base${Q}||p===${Q}robinhood${Q}){let e=Kt(p,s)}`, ""),
  };
  for (const [k, s] of Object.entries(folds)) {
    assert.notEqual(s, js, k);
    assert.equal(sites(s)[k], false, k);
  }
  assert.equal(sites(js.replace("r=e=>F(e,t.withdrawBuilt)", "r=e=>!0")).host, false, "a wayOut that is not the rule");
  assert.equal(sites(js + ";var K2=(n,i)=>{if(!r(n))return null;let a=A(n);if(a===null)return null;let o=t.evmQueuePool?.(n)??0;return o};").host, false, "a second host beside it");
});

test("planted: the EVM withdraw's no-leaf read missing, or not read, is a FAIL on the page alone", () => {
  for (const plant of [(a) => (a.page.noLeaf = false), (a) => delete a.page.noLeaf]) {
    const v = spoil(plant);
    assert.equal(v.verdict, "FAIL");
    assert.deepEqual(v.lines.filter((l) => l.startsWith("BAD")).map((l) => l.slice(-"(noLeaf)".length)), ["(noLeaf)"], v.lines.join("\n"));
  }
});

test("the no-leaf read on planted bundles, in the minified shape of this build: a catch of every refusal, no catch, another class, or a second read reads false", () => {
  const Q = "`";
  const cls = `var SC=class extends Error{code=${Q}no_leaf${Q};constructor(e){super(e),this.name=${Q}PoolNoLeafError${Q}}},CC=class extends Error{code=${Q}rpc_disagree${Q}};`;
  const read = "y=(e,t)=>c.trees(e,AbortSignal.timeout(J$),t).catch(e=>{if(e instanceof SC)return null;throw e}),b=e=>e!==null&&g.leafIndex<BigInt(e.stateTree.size),x=1;";
  const js = `${cls}let v={ms:1},${read}`;
  assert.equal(noLeafRead(js), true, "the planted good shape reads true");
  const plants = {
    // the red mutant of test/pool-withdraw-evm.test.ts, minified: every refusal read as no leaf
    "every refusal": js.replace("if(e instanceof SC)return null;throw e", "if(e instanceof SC||!0)return null;throw e"),
    "every refusal, folded": js.replace(".catch(e=>{if(e instanceof SC)return null;throw e})", ".catch(e=>null)"),
    "no catch": js.replace(".catch(e=>{if(e instanceof SC)return null;throw e})", ""),
    "another class": js.replace("e instanceof SC)", "e instanceof CC)"),
    "no rethrow": js.replace("return null;throw e}", "return null}"),
    "no class": js.replace("this.name=`PoolNoLeafError`", "this.name=`PoolReadError`"),
    "a second read": js + `let w=1,${read}`,
  };
  for (const [k, s] of Object.entries(plants)) {
    assert.notEqual(s, js, k);
    assert.equal(noLeafRead(s), false, k);
  }
});
