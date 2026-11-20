// node --test scripts/live-checks/evm-pool-index-route.test.mjs: the live check evm-pool-index-route, replayed.
// evm-pool-index-route.answers.json holds two real mainnet runs from the Mac (`--record`, read only, nothing signed):
// - good: each chain's index synced cold on its two readers, served and kept at the head by gap syncs every
//   EVM_INDEX_KEEP_MS (card evm-index-kept-at-the-head), then three coins a chain tapped cold and warm: PASS, no tap
//   asked a block at or below the index's N and no cold tap scanned by currency before its answer;
// - once: card evm-pool-index-route's good run (19 Nov 09:05Z), its index synced once and kept no more: FAIL, its cold
//   taps scanned the blocks past N by currency before their answers (Base 4, Robinhood 2, 10 and 2);
// - bad: the same kit with no index served (`--no-index`), the quote's bounded scan alone: FAIL, each chain's index
//   not served and its taps' scans read from the depth's floor.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAINS, judge } from "./evm-pool-index-route.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-pool-index-route.answers.json", import.meta.url), "utf8"));
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good run passes", () => {
  const v = judge(A.good);
  assert.deepEqual(bad(v), []);
  assert.equal(v.verdict, "PASS");
});

test("the recorded run with the index synced once fails on its cold taps' scans by currency before their answers", () => {
  const v = judge(A.once);
  assert.equal(v.verdict, "FAIL");
  for (const chain of CHAINS) assert.ok(bad(v).some((l) => l.startsWith(`BAD [${chain}]`) && l.includes("cold: no scan by currency before its answer")), chain);
  assert.ok(bad(v).every((l) => l.includes("cold: no scan by currency before its answer")), bad(v).join("\n"));
});

test("the recorded run with no index served fails, on each chain's index and on its taps' getLogs at or below N", () => {
  const v = judge(A.bad);
  assert.equal(v.verdict, "FAIL");
  for (const chain of CHAINS) {
    assert.ok(bad(v).some((l) => l.startsWith(`BAD [${chain}] the pool index synced whole and served`)), chain);
    assert.ok(bad(v).some((l) => l.startsWith(`BAD [${chain}]`) && l.includes("no getLogs at or below the index's N")), chain);
  }
});

test("one tap of the good run that asks a block at the index's N fails on that tap alone", () => {
  const a = structuredClone(A.good);
  const c = a.chains.base;
  const u = c.rows[0].runs[1];
  u.logs = [...(u.logs ?? []), { host: "base-rpc.publicnode.com", from: c.index.covers, to: c.index.covers + 10, currency: true, after: true }];
  const v = judge(a);
  assert.equal(v.verdict, "FAIL");
  assert.equal(bad(v).length, 1, bad(v).join("\n"));
  assert.ok(bad(v)[0].includes(`${c.rows[0].symbol} warm: no getLogs at or below`), bad(v)[0]);
});

test("a tap that ends in a provider's fault fails", () => {
  const a = structuredClone(A.good);
  Object.assign(a.chains.robinhood.rows[0].runs[0], { ok: false, code: "rpc_error" });
  assert.equal(judge(a).verdict, "FAIL");
});
