// node --test apps/terminal/test/e2e/buy/judge.test.mjs (card app-a2-e2e): the devnet buy and sell's verdict replayed
// from recorded runs (run.answers.json), so the judge's rules are held without a browser or money.
//   good: a green run as recorded (run.mjs --record): the buy and the sell filled, every tx read back on both RPCs;
//   cut:  a real run with the buy cut (run.mjs --plant no-buy: no tap, no pool.buy, no buy transaction), which must fail.
// Planted from the good run: the sell cut, W still holding the coin after the sell, the two RPCs reading W apart, a buy
// tx not read back on one RPC, a host past the devnet RPC and the helper.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { b58, judge, unb58 } from "./run.mjs";

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
