// Replays of live check device-evm-fee-read-walks-operators: the recorded good run (10 Nov 21:18Z, Pocket and publicnode refusing
// the Robinhood block's state and walked past) passes; the bad one (every Robinhood seat but one refusing it) fails; and
// each rule fails alone on the good run with one thing changed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge } from "./device-evm-fee-read-walks-operators.mjs";

const A = JSON.parse(readFileSync(new URL("./device-evm-fee-read-walks-operators.answers.json", import.meta.url), "utf8"));
const one = (f) => {
  const g = structuredClone(A.good);
  f(g);
  return judge(g);
};

test("the recorded good answer passes, a refusing seat named and walked past", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /walked past/.test(l)));
});

test("the recorded bad answer (one Robinhood operator keeps the block's state) fails", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.ok(r.lines.some((l) => /^BAD robinhood: 1 operators keep the state/.test(l)), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^BAD robinhood: the kit's walk binds the fee read on none/.test(l)));
});

test("each rule fails alone on the good answer", () => {
  assert.equal(one((g) => (g.chains.base.seats[1].chainId = { result: "0x1" })).verdict, "FAIL", "a wrong chain id");
  assert.equal(one((g) => (g.chains.base.seats[2].cors[0] = { status: 204, acao: "https://other.example", allowHeaders: "content-type" })).verdict, "FAIL", "a page origin refused");
  assert.equal(one((g) => (g.chains.base.seats[3].fee = { result: ["0x" + "0".repeat(63) + "1", "0x" + "0".repeat(64)] })).verdict, "FAIL", "two seats that differ");
  assert.equal(one((g) => (g.chains.robinhood.walk = { hosts: ["rpc.mainnet.chain.robinhood.com", "customer-origin.offchainlabs.com"], operators: ["robinhood.com", "robinhood.com"], agree: true })).verdict, "FAIL", "a walk on one operator twice");
  assert.equal(one((g) => (g.chains.robinhood.seats = g.chains.robinhood.seats.slice(0, 2))).verdict, "FAIL", "a list of two operators: no spare");
  assert.equal(one((g) => g.chains.robinhood.seats.splice(2, 0, { ...g.chains.robinhood.seats[0], url: "https://customer-origin.offchainlabs.com" })).verdict, "FAIL", "two seats of one operator");
  // no answers alone (a 429 on all but one): never a pass
  assert.equal(one((g) => g.chains.base.seats.slice(1).forEach((s) => (s.fee = { noAnswer: "base HTTP 429: 429 Too Many Requests" }))).verdict, "INCONCLUSIVE");
});
