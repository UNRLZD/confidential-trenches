// node --test apps/terminal/test/e2e/buy/judge.test.mjs (card app-a2-e2e): the devnet buy and sell's verdict replayed
// from recorded runs (run.answers.json, each run.mjs --record on 10 Nov, the net log left out), so the judge's rules are
// held without a browser or money. No recorded run has sold yet:
//   free: --plant free: signed in, U answered, its deposit asked unfunded (not_funded), cut before the fund line: FAIL;
//   run2: a paid run whose buy filled ("Filled 14.9s Final", every tx finalized on both RPCs), then the run's own
//         token-account scan met the public devnet RPC's 429 before the sell: every buy line ok, FAIL on the sell;
//   run3: a paid run whose buy landed (finalized on both RPCs) but the box read "Slow 89.9s" at the run's 90 s bound: FAIL
//         on the buy's end;
//   run4: a paid run whose buy filled ("Filled 7.8s Final", W read on both RPCs) and whose sell was tapped once and sent
//         one pool.sell, which SIGN_HOST refused at +23.7 s with nothing sent (the box: Failed, Retry; W still holds the
//         coin on both RPCs): every buy line and the sell's tap ok, FAIL on the sell's end.
// Planted from run2: W read apart on the two RPCs, a buy tx not read back on one RPC, a host past the devnet RPC and the
// helper.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { b58, DEVNET_GENESIS, devnetOnly, judge, netTable, rpc, unb58 } from "./run.mjs";

const SRC = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
const answers = JSON.parse(readFileSync(new URL("./run.answers.json", import.meta.url), "utf8"));
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD")).join("\n");
const ok = (v, re) => v.lines.some((l) => l.startsWith("ok ") && re.test(l));
const mut = (f) => {
  const rec = structuredClone(answers.run2);
  f(rec);
  return judge(rec);
};
const BUY = [/signed in the no-PRF way/, /pool.address answered U/, /U funded \d+ lamports/, /pool.deposit answered/, /on the pool path: pool/, /Proof ready drawn/, /the buy tapped once: 1/, /one pool.buy sent: 1/, /the box ended "Filled/, /the buy's transactions sent: 1/, /every transaction read back ok/, /CSP violations: none/, /hosts reached/];

test("the free run fails: no funding, no tap, no buy", () => {
  const v = judge(answers.free);
  assert.equal(v.ok, false);
  assert.match(bad(v), /pool.deposit answered \{"ok":false,"code":"not_funded"\}/);
  assert.match(bad(v), /the buy tapped once: 0/);
  assert.match(bad(v), /the buy's transactions sent: 0/);
});

test("run 2: every buy line is ok, and the run fails on the sell it never reached", () => {
  const v = judge(answers.run2);
  for (const re of BUY) assert.ok(ok(v, re), `${re} not ok:\n${bad(v)}`);
  assert.equal(v.ok, false);
  assert.match(bad(v), /the sell tapped once: 0/);
  assert.match(bad(v), /the sell's transactions sent: 0/);
});

test("run 3: a box that ends Slow fails on the buy's end", () => {
  const v = judge(answers.run3);
  assert.equal(v.ok, false);
  assert.match(bad(v), /the box ended "Slow/);
});

test("run 4: every buy line and the sell's one tap and one pool.sell are ok; the refused sell fails", () => {
  const v = judge(answers.run4);
  for (const re of [...BUY, /the buy's wallet \w+ holds 974924498778 \/ 974924498778/, /the sell tapped once: 1/, /one sell sent: 1 pool.sell/, /the run's own reads: all answered/, /one page from first frame to last: 1/]) assert.ok(ok(v, re), `${re} not ok:\n${bad(v)}`);
  assert.equal(v.ok, false);
  assert.match(bad(v), /the sell box ended "Retry"/);
  assert.match(bad(v), /the sell's transactions sent: 0/);
  assert.match(bad(v), /after the sell W holds 974924498778 \/ 974924498778/);
});

test("run 4 is a buy proof and not a sell proof: BUY passes, SELL is NOT PROVEN by name", () => {
  const v = judge(answers.run4);
  assert.equal(v.buy.ok, true, bad(v));
  assert.equal(v.sell.ok, false);
  assert.deepEqual(v.sell.notProven, ['the sell box ended "Retry"', "the sell's transactions sent: 0", "after the sell W holds 974924498778 / 974924498778 on the two RPCs"]);
  assert.equal(v.ok, false, "the whole run, a buy and a sell, still fails");
});

test("no recorded run proves a sell; only run 4 proves the buy whole", () => {
  for (const k of ["free", "run2", "run3", "run4"]) assert.equal(judge(answers[k]).sell.ok, false, k);
  assert.deepEqual(["free", "run2", "run3", "run4"].filter((k) => judge(answers[k]).buy.ok), ["run4"]);
});

test("a buy line that is not ok fails the buy verdict; a sell line never does", () => {
  const four = (f) => {
    const rec = structuredClone(answers.run4);
    f(rec);
    return judge(rec);
  };
  assert.equal(four((r) => (r.buy.end = "Slow 89.9s")).buy.ok, false);
  assert.equal(four((r) => (r.hosts = [...r.hosts, "api.mainnet-beta.solana.com"])).buy.ok, false);
  assert.equal(four((r) => (r.sell = { taps: 0, asks: 0 })).buy.ok, true);
});

test("W read apart on the two RPCs, or none after the buy, fails", () => {
  assert.match(bad(mut((r) => (r.heldAfterBuy = ["977526752591", "1"]))), /the buy's wallet/);
  assert.match(bad(mut((r) => (r.heldAfterBuy = ["0", "0"]))), /the buy's wallet/);
  assert.equal(ok(mut((r) => (r.heldAfterBuy = ["977526752591", "977526752591"])), /the buy's wallet/), true);
  assert.match(bad(mut((r) => (r.heldAfterSell = ["0", "5"]))), /after the sell W holds/);
});

test("a buy transaction that did not read back ok on both RPCs fails", () => {
  assert.match(bad(mut((r) => (r.txs.find((x) => x.step === "buy").reads[1] = { status: null, err: "none" }))), /every transaction read back ok/);
});

test("a host past the devnet RPC and the helper fails", () => {
  assert.match(bad(mut((r) => (r.hosts = [...r.hosts, "api.mainnet-beta.solana.com"]))), /hosts reached/);
});

test("a read of the run's own that failed is named at the end", () => {
  assert.match(bad(mut((r) => (r.readErrors = ["after the buy: getTransaction: {\"code\":429}"]))), /the run's own reads: after the buy/);
});

test("base58 round-trips a signature and a key", () => {
  for (const s of answers.run2.txs.map((t) => t.sig).concat(answers.run2.u, answers.run2.w)) assert.equal(b58(unb58(s)), s);
});

test("any cluster but devnet is refused: mainnet's genesis, a split pair, a missing read", () => {
  assert.doesNotThrow(() => devnetOnly([DEVNET_GENESIS, DEVNET_GENESIS]));
  const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"; // mainnet-beta's genesis hash
  assert.throws(() => devnetOnly([MAINNET, MAINNET]), /not devnet/);
  assert.throws(() => devnetOnly([DEVNET_GENESIS, MAINNET]), /not devnet/);
  assert.throws(() => devnetOnly([DEVNET_GENESIS]), /not devnet/);
});

test("the run checks the cluster before it prints, starts a browser or asks for money, and holds no key", () => {
  const body = SRC.slice(SRC.indexOf("export async function run("));
  const at = (s) => body.indexOf(s);
  assert.ok(at("devnetOnly(") > 0);
  for (const later of ["console.log(", "startHarness(", "fund: "]) assert.ok(at("devnetOnly(") < at(later), later);
  for (const no of [".keys", "createPrivateKey", "PRIVATE"]) assert.equal(SRC.includes(no), false, no);
  assert.equal(/rpc\([^)]*"sendTransaction"/.test(SRC), false, "the run sends no transaction itself");
});

test("a rate-limited read is asked again, a bounded number of times; any other error is not", async () => {
  const answers = (list) => {
    let n = 0;
    const fetchFn = async () => {
      const a = list[Math.min(n++, list.length - 1)];
      return { status: a === "http429" ? 429 : 200, json: async () => a };
    };
    return { fetchFn, calls: () => n };
  };
  const limited = { jsonrpc: "2.0", id: 1, error: { code: 429, message: "Connection rate limits exceeded" } };
  let f = answers(["http429", limited, { jsonrpc: "2.0", id: 1, result: 7 }]);
  assert.equal(await rpc("https://x.test", "getBalance", [], { pauseMs: 0, fetchFn: f.fetchFn }), 7);
  assert.equal(f.calls(), 3);
  f = answers([limited]);
  await assert.rejects(rpc("https://x.test", "getBalance", [], { tries: 4, pauseMs: 0, fetchFn: f.fetchFn }), /429/);
  assert.equal(f.calls(), 4);
  f = answers([{ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad" } }]);
  await assert.rejects(rpc("https://x.test", "getBalance", [], { pauseMs: 0, fetchFn: f.fetchFn }), /-32602/);
  assert.equal(f.calls(), 1);
});

test("the network table counts each answer by step, host and method: status, JSON-RPC code, failure, none", () => {
  const e = (x) => ({ step: "buy", host: "api.devnet.solana.com", method: "getProgramAccounts", ...x });
  assert.deepEqual(netTable([e({ status: 200, code: -32016 }), e({ status: 200, code: -32016 }), e({ status: 429 }), e({ status: 200, code: null }), e({ failed: "net::ERR_ABORTED" }), e({})]), [
    "net buy api.devnet.solana.com getProgramAccounts: 200/-32016 x2, 429 x1, 200 x1, failed:net::ERR_ABORTED x1, no answer x1",
  ]);
  assert.deepEqual(netTable([{ step: "sell", host: "ct-api.unrealized.trade", path: "/v1/pool/solana/send", method: null, status: 200 }]), ["net sell ct-api.unrealized.trade /v1/pool/solana/send: 200 x1"]);
});

test("the run waits up to 5 minutes for a trade's end label and records Slow or Stuck on the way", () => {
  assert.match(SRC, /const END_MS = 5 \* 60_000;/);
  assert.equal(/FILL_MS/.test(SRC), false);
  assert.match(SRC, /\^\(Filled\|Failed\|Not landed\|Retry\)\\b/);
  assert.match(SRC, /\^\(Slow\|Stuck\)\$/);
});
