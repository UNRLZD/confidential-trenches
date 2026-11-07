// Replays evm-sell-hook-intrablock.answers.json through the live check. The good answer is the check's own run on the
// card's branch (7 Nov 16:40Z): both trace providers answer each transaction's prestate and call traces, equal, holding
// ArbOS's state, and the replay at the prestate without ArbOS runs on two quote providers; it passes. The bad answer is
// a real read of the same kind with the override as before the card's exclusion (ArbOS's state kept in): Nitro refuses
// it on every replay; it fails on those lines alone.
//   node --test scripts/live-checks/evm-sell-hook-intrablock.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge } from "./evm-sell-hook-intrablock.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-sell-hook-intrablock.answers.json", import.meta.url), "utf8"));

test("the good answer (ArbOS left out of the replay) passes", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(A.good.txs.length, 3);
});

test("the bad answer (ArbOS kept in the override) fails: every replay refused, and only that", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  const bad = r.lines.filter((l) => l.startsWith("BAD"));
  assert.equal(bad.length, 6, bad.join("\n"));
  assert.ok(bad.every((l) => /the replay at its prestate runs on .*"code":-32000,"message":"overriding address 0xA4b05FffffFffFFFFfFFfffFfffFFfffFfFfFFFf {2}not allowed"/.test(l)), bad.join("\n"));
});

test("each rule fails alone on the good answer with one thing changed", () => {
  const one = (f) => {
    const g = structuredClone(A.good);
    f(g);
    return judge(g).ok;
  };
  assert.equal(one((g) => (g.trace = [g.trace[0], g.trace[0]])), false, "one trace company");
  assert.equal(one((g) => g.txs.pop()), false, "too few transactions");
  assert.equal(one((g) => (g.txs[0].traces[1].digest = { ok: false, answer: '{"http":499,"body":""}' })), false, "a trace unanswered");
  assert.equal(one((g) => (g.txs[0].traces[1].digest.pre = "00".repeat(32))), false, "the prestates differ");
  assert.equal(one((g) => g.txs[0].traces.pop()), false, "one trace provider read");
  assert.equal(one((g) => (g.txs[1].traces[0].digest.accounts = g.txs[1].traces[0].digest.accounts.filter((a) => !a.startsWith("0xa4b05f")))), false, "no ArbOS in the prestate");
  assert.equal(one((g) => (g.txs[2].replays[0].answer = { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "historical state not available" } })), false, "the state refused");
  assert.equal(one((g) => g.txs[2].replays.pop()), false, "one quote provider");
});
