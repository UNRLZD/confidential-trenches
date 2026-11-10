// Replays of live check device-evm-fee-read-walks-operators: the recorded good run (10 Nov 21:53Z: Base bound in its
// period; Robinhood's bind found three of four operators without the state about 40 s back and bound at the next
// period's first block, as the queue's next pass does) passes; the bad one (every Robinhood seat but one lacking the
// state, in this period and the next) fails; and each rule alone on the good run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, ORIGINS } from "./device-evm-fee-read-walks-operators.mjs";
import { PAGES } from "./page-evm-rpc-csp.mjs";

const A = JSON.parse(readFileSync(new URL("./device-evm-fee-read-walks-operators.answers.json", import.meta.url), "utf8"));
const one = (f) => {
  const g = structuredClone(A.good);
  f(g);
  return judge(g);
};

test("the recorded good answer passes: the next period's bind named, the seats lacking the state named", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^ok {2}robinhood: the bind read the chain fee at block \d+ \(the period from .*, the next period, as the queue's next pass\)/.test(l)), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^-- {2}robinhood: 60 s back .* 1 of 4 operators held the state on one ask; lacking: robinhood\.drpc\.org, robinhood\.api\.pocket\.network, robinhood-rpc\.publicnode\.com/.test(l)));
});

test("the recorded bad answer (no two operators keep the block's state, this period or the next) fails", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.ok(r.lines.some((l) => /^BAD robinhood: the bind did not bind in this period or the next \(2 tries\)/.test(l)), r.lines.join("\n"));
});

test("the CORS origins are the two pages' own (the signing page is confidential.unrealized.trade, no child host)", () => {
  assert.deepEqual(ORIGINS, [new URL(PAGES.sign).origin, new URL(PAGES.app).origin]);
  assert.deepEqual(ORIGINS, ["https://confidential.unrealized.trade", "https://ct-app.unrealized.trade"]);
});

test("each rule alone on the good answer", () => {
  assert.equal(one((g) => (g.chains.base.seats[1].chainId = { result: "0x1" })).verdict, "FAIL", "a wrong chain id");
  assert.equal(one((g) => (g.chains.base.seats[2].cors[0] = { status: 204, acao: "https://other.example", allowHeaders: "content-type" })).verdict, "FAIL", "a page origin refused");
  assert.equal(one((g) => (g.chains.base.seats[3].fee = { result: ["0x" + "0".repeat(63) + "1", "0x" + "0".repeat(64)] })).verdict, "FAIL", "two seats that differ 60 s back");
  assert.equal(one((g) => (g.chains.robinhood.bind.tries = [{ start: "x", ok: false, name: "EvmOperatorsDiffer", error: "the chain fee at block 1: a and b answered differently" }])).verdict, "FAIL", "two operators that differ on the bind");
  assert.equal(one((g) => (g.chains.robinhood.bind.tries.find((t) => t.ok).operators = ["robinhood.com", "robinhood.com"])).verdict, "FAIL", "a bind on one operator twice");
  assert.equal(one((g) => (g.chains.robinhood.seats = g.chains.robinhood.seats.slice(0, 2))).verdict, "FAIL", "a list of two operators: no spare");
  // the next period's bind, as the queue's next pass: a pass
  // the bind in its own period: a pass with no next-period words
  const own = one((g) => g.chains.robinhood.bind.tries.shift());
  assert.equal(own.verdict, "PASS");
  assert.ok(!own.lines.some((l) => /^ok {2}robinhood: .*the next period/.test(l)));
  // the walk 60 s back not bound while the bind bound: a WARN naming who held the state, never silent, never a FAIL
  const warn = one((g) => {
    g.chains.robinhood.walk = { error: "one operator alone never passes" };
    for (const s of g.chains.robinhood.seats.slice(1)) s.fee = { error: { code: 27, message: "Unknown state" } };
  });
  assert.equal(warn.verdict, "PASS");
  assert.ok(warn.lines.some((l) => /^WARN robinhood: 60 s back, 1 of 4 operators held the state on one ask: rpc\.mainnet\.chain\.robinhood\.com/.test(l)), warn.lines.join("\n"));
  // no answers alone: never a pass
  assert.equal(one((g) => (g.chains.base.bind.tries = [{ start: "x", ok: false, name: "noAnswer", error: "HTTP 429" }])).verdict, "INCONCLUSIVE");
});
