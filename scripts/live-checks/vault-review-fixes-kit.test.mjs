// node --test scripts/live-checks/vault-review-fixes-kit.test.mjs: the check's verdict replays recorded answers
// (vault-review-fixes-kit.answers.json), each read on 2026-11-06 by vault-review-fixes-kit.mjs collect():
//   good: this card's branch: all six listed RPCs refuse a view over the cap in words the kit halves on, and the exit
//         read of the testnet vault reads every list whole with first pages of at most 125 Tgas: PASS;
//   bad:  the same read run from main a04e3efd, before this card: every list's first page is 1,000 rows: FAIL.
// Planted from the good answer: an RPC that refuses in other words, a probe missing, the exit read stopped, a list read
// short, a first page one row over the budget; and an RPC that answers the probe whole, or busy, passes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUDGET_TGAS, GAS_PER_ROW, LISTS, judge } from "./vault-review-fixes-kit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "vault-review-fixes-kit.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: six refusals the kit knows, every list whole at pages under the budget: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 2 + 6 + 1 + LISTS.length);
});

test("recorded bad answer: main before this card asks 1,000 rows of every list: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r.lines), [
    "BAD the exit pair: deposits's first page is 1000 and 1000 rows, at most 276.4 Tgas (budget 125)",
    "BAD the exit pair: spends's first page is 1000 and 1000 rows, at most 497.1 Tgas (budget 125)",
    "BAD the exit pair: leaves's first page is 1000 and 1000 rows, at most 162.5 Tgas (budget 125)",
    "BAD the exit pair: labels's first page is 1000 and 1000 rows, at most 162.5 Tgas (budget 125)",
  ]);
});

test("planted: an RPC refusing in words the kit does not know fails, naming it", () => {
  const r = mut((rec) => void (rec.probes[2].answer.result.error = "wasm execution failed with error: HostError(GasExceeded)"));
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r.lines).length, 1);
  assert.match(bad(r.lines)[0], new RegExp(`^BAD ${ANSWERS.good.probes[2].url.replace(/[.]/g, "\\.")}: .*not a refusal the kit knows$`));
});

test("planted: an RPC answering the probe whole (a raised cap) or busy (dRPC's free-plan timeout) passes", () => {
  const whole = mut((rec) => void (rec.probes[0].answer = { jsonrpc: "2.0", id: "x", result: { block_height: 1, block_hash: "h", logs: [], result: [123, 125] } }));
  assert.equal(whole.ok, true, whole.lines.join("\n"));
  assert.ok(whole.lines.some((l) => /whole \(a higher cap\)$/.test(l)));
  const busy = mut((rec) => void (rec.probes[2].answer = { id: "x", jsonrpc: "2.0", error: { message: "Request timeout on the free plan, please upgrade to paid plan", code: 30 } }));
  assert.equal(busy.ok, true, busy.lines.join("\n"));
});

test("planted: a probe missing, the exit read stopped, a list read short, a page one row over: each fails", () => {
  assert.ok(bad(mut((rec) => rec.probes.pop()).lines).some((l) => / no probe read$/.test(l)));
  assert.ok(bad(mut((rec) => void (rec.exit = { error: "vault sync stopped (rpc): x", pages: [] })).lines).some((l) => /the read stopped/.test(l)));
  assert.ok(bad(mut((rec) => void (rec.exit.whole = false)).lines).some((l) => /every list read whole/.test(l)));
  for (const list of LISTS) {
    const over = Math.floor(BUDGET_TGAS / GAS_PER_ROW[list]) + 1;
    const r = mut((rec) => void (rec.exit.pages.find((q) => q.method === list).limit = over));
    assert.ok(bad(r.lines).some((l) => l.startsWith(`BAD the exit pair: ${list}'s first page`)), `${list} at ${over} rows`);
  }
  assert.equal(judge(null).ok, false);
});
