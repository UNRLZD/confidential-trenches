// Replays of live check evm-device-reads-need-no-old-state: the recorded good run (the page's build of this card, its
// /app.js holding the sync's fresh-block read, with the live reads of both mainnets: the fee held at the turn, a bind
// 30 s in with no state read, the root time at a fresh block) passes; the recorded bad run (SIGN_HOST's /app.js before
// this card's release, the same live reads) fails; and each rule alone on the good run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judge, SIGN } from "./evm-device-reads-need-no-old-state.mjs";
import { PAGES } from "./page-evm-rpc-csp.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-device-reads-need-no-old-state.answers.json", import.meta.url), "utf8"));
const one = (f) => {
  const g = structuredClone(A.good);
  f(g);
  return judge(g);
};

test("the recorded good answer passes", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  for (const chain of ["base", "robinhood"]) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${chain}: the period's fee held at its turn`)), r.lines.join("\n"));
});

test("the recorded bad answer (SIGN_HOST's page before this card) fails", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.ok(r.lines.some((l) => /^BAD SIGN_HOST \/app\.js .* holds the sync's fresh-block root-time read/.test(l)), r.lines.join("\n"));
});

test("SIGN is the signing page's own origin", () => {
  assert.equal(SIGN, new URL(PAGES.sign).origin);
});

test("each rule alone on the good answer", () => {
  assert.equal(one((g) => (g.chains.robinhood.hold = { ok: false, atMs: 9000, name: "EvmOperatorsUnanswered", error: "the chain fee at block 1: one operator alone never passes" })).verdict, "FAIL", "no hold at the turn");
  assert.equal(one((g) => (g.chains.base.hold.operators = ["base.org", "base.org"])).verdict, "FAIL", "a hold on one operator twice");
  assert.equal(one((g) => (g.chains.robinhood.hold.feeAgeMs = 10_000)).verdict, "FAIL", "the fee read once the block was 10 s old");
  assert.equal(one((g) => delete g.chains.base.hold.feeAgeMs).verdict, "FAIL", "a hold with no fee age");
  assert.equal(one((g) => (g.chains.base.bind = { ok: true, sameHash: true, stateReads: 2 })).verdict, "FAIL", "a bind that asked state");
  assert.equal(one((g) => (g.chains.robinhood.bind = { ok: false, sameHash: false, stateReads: 0 })).verdict, "FAIL", "the first block moved (a reorg): the bind would read again");
  assert.equal(one((g) => (g.chains.base.times = { ...g.chains.base.times, ok: false, empty: false, root: "0x" + "0".repeat(63) + "7", value: "0x" + "0".repeat(64) })).verdict, "FAIL", "a root the pool made, timed zero");
  assert.equal(one((g) => (g.chains.base.times = { ...g.chains.base.times, ok: true, empty: true, value: "0x" + "0".repeat(63) + "1" })).verdict, "FAIL", "an empty pool's root 0 answered a time");
  assert.equal(one((g) => (g.chains.robinhood.times = { ok: false, error: "the chain fee at block 1: a and b answered differently" })).verdict, "FAIL", "two operators that differ");
  assert.equal(one((g) => (g.chains.base.hold = { ok: false, atMs: 9000, name: "Error", error: "HTTP 429" })).verdict, "INCONCLUSIVE", "no answer alone: never a pass");
  assert.equal(one((g) => delete g.chains.robinhood).verdict, "FAIL", "a chain not read");
});

// Release 116's sign live run 43024665974 (job 130536379249): "BAD base: the pool's root time at a fresh block was not
// read (rpc 1 does not know block 56057679 yet)", a Base provider behind a block the other just reported. The child now
// reads it under the wallet's lag retries and names a provider still behind on the last as `lagging`.
const LAG = { ok: false, name: "EvmLagError", error: "rpc 1 does not know block 56057679 yet", lagging: ["base-rpc.publicnode.com"] };

test("a provider still behind a fresh block on the last lag retry is INCONCLUSIVE, named", () => {
  for (const [step, f] of [
    ["the root time", (g) => (g.chains.base.times = { ...LAG })],
    ["the hold", (g) => (g.chains.base.hold = { ...LAG, atMs: 13_000 })],
    ["the bind", (g) => (g.chains.robinhood.bind = { ...LAG, stateReads: 0, lagging: ["robinhood.api.pocket.network"] })],
  ]) {
    const r = one(f);
    assert.equal(r.verdict, "INCONCLUSIVE", `${step}: ${r.lines.join("\n")}`);
    assert.ok(r.lines.some((l) => /^-- .* (base-rpc\.publicnode\.com|robinhood\.api\.pocket\.network) did not know the fresh block yet/.test(l)), `${step}: names the provider`);
  }
});

test("a wrong answer about a block the provider knows still fails, a lag beside it too", () => {
  assert.equal(one((g) => (g.chains.base.times = { ok: false, name: "EvmOperatorsDiffer", error: "base stateRootTimes(root) at 56057679: a and b answered differently" })).verdict, "FAIL", "two operators that differ at a known block");
  assert.equal(one((g) => (g.chains.base.times = { ok: false, name: "EvmLagError", error: "rpc 1 does not know block 56057679 yet" })).verdict, "FAIL", "a lag the child names no provider for (the record before this change) is not let through");
  assert.equal(one((g) => (g.chains.base.times = { ...LAG, lagging: [] })).verdict, "FAIL", "an empty lagging list names no provider");
  assert.equal(one((g) => (g.chains.base.times = { ...LAG, ok: true, empty: false, value: "0x" + "0".repeat(64) })).verdict, "FAIL", "a read that answered is judged on its answer");
  assert.equal(one((g) => ((g.chains.base.times = { ...LAG }), (g.chains.robinhood.hold.feeAgeMs = 10_000))).verdict, "FAIL", "a real FAIL beside a lag");
});
