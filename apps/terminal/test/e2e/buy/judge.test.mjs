// node --test apps/terminal/test/e2e/buy/judge.test.mjs (card app-a2-e2e): the devnet buy and sell's verdict replayed
// from recorded runs (run.answers.json), so the judge's rules are held without a browser or money.
//   good: a green run as recorded (run.mjs --record): the buy and the sell filled, every tx read back on both RPCs;
//   cut:  a real run with no money (run.mjs --plant free: signed in and U answered, then cut before the fund line: no
//         funding, no deposit, no tap, no buy transaction), which must fail.
// Planted from the good run: the sell cut, W still holding the coin after the sell, the two RPCs reading W apart, a buy
// tx not read back on one RPC, a host past the devnet RPC and the helper.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { b58, DEVNET_GENESIS, devnetOnly, judge, rpc, unb58 } from "./run.mjs";

const SRC = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");

const answers = JSON.parse(readFileSync(new URL("./run.answers.json", import.meta.url), "utf8"));
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD")).join("\n");
const mut = (f) => {
  const rec = structuredClone(answers.good);
  f(rec);
  return judge(rec);
};

test("the recorded green run passes: the buy and the sell filled", () => {
  const v = judge(answers.good);
  assert.ok(v.ok, bad(v));
  assert.ok(answers.good.txs.some((t) => t.step === "buy") && answers.good.txs.some((t) => t.step === "sell"));
});

test("the recorded run with the buy cut fails, on the buy", () => {
  const v = judge(answers.cut);
  assert.equal(v.ok, false);
  assert.match(bad(v), /the buy tapped once: 0/);
  assert.match(bad(v), /the buy's transactions sent: 0/);
});

test("the sell cut fails, on the sell", () => {
  const v = mut((r) => {
    r.sell = { taps: 0, asks: 0 };
    r.txs = r.txs.filter((t) => t.step !== "sell");
    r.heldAfterSell = r.heldAfterBuy;
  });
  assert.equal(v.ok, false);
  assert.match(bad(v), /the sell tapped once: 0/);
  assert.match(bad(v), /the sell's transactions sent: 0/);
  assert.match(bad(v), /after the sell W holds/);
});

test("W's coin read apart on the two RPCs, or none after the buy, fails", () => {
  assert.equal(mut((r) => (r.heldAfterBuy = [r.heldAfterBuy[0], "1"])).ok, false);
  assert.equal(mut((r) => (r.heldAfterBuy = ["0", "0"])).ok, false);
  assert.equal(mut((r) => (r.heldAfterSell = ["0", "5"])).ok, false);
});

test("a buy transaction that did not read back ok on both RPCs fails", () => {
  const v = mut((r) => (r.txs.find((x) => x.step === "buy").reads[1] = { status: null, err: "none" }));
  assert.equal(v.ok, false);
});

test("a host past the devnet RPC and the helper fails", () => {
  assert.equal(mut((r) => (r.hosts = [...r.hosts, "api.mainnet-beta.solana.com"])).ok, false);
});

test("base58 round-trips a signature and a key", () => {
  for (const s of answers.good.txs.map((t) => t.sig).concat(answers.good.u, answers.good.w)) assert.equal(b58(unb58(s)), s);
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
