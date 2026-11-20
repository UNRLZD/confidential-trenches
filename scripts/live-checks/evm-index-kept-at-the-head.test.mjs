// node --test scripts/live-checks/evm-index-kept-at-the-head.test.mjs: the live check evm-index-kept-at-the-head,
// replayed. evm-index-kept-at-the-head.answers.json holds three real mainnet runs from the Mac (`--record`, read only,
// nothing signed):
// - good: this card's branch, each chain's index synced on from the release's snapshot and kept at the head by gap
//   syncs every EVM_INDEX_KEEP_MS, five coins a chain tapped cold after 30 s: PASS, no tap scanned by currency first;
// - once: the same with the index synced once and kept no more (`--no-keep`, main before this card): FAIL, the new
//   coins' taps scanned the blocks past N by currency before their answers;
// - bad: no index served (`--no-index`): FAIL, no index, and the taps scanned from the depth's floor.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAINS, judge } from "./evm-index-kept-at-the-head.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-index-kept-at-the-head.answers.json", import.meta.url), "utf8"));
const bad = (v) => v.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good run passes", () => {
  const v = judge(A.good);
  assert.deepEqual(bad(v), []);
  assert.equal(v.verdict, "PASS");
});

test("the recorded run with the index synced once fails on the new coins' scans by currency before their answers", () => {
  const v = judge(A.once);
  assert.equal(v.verdict, "FAIL");
  for (const chain of CHAINS) {
    assert.ok(bad(v).some((l) => l.startsWith(`BAD [${chain}]`) && l.includes("no scan by currency before its answer")), chain);
    assert.ok(bad(v).some((l) => l.startsWith(`BAD [${chain}] every gap sync`)), chain);
  }
});

test("the recorded run with no index served fails, on each chain's index and on its taps' scans", () => {
  const v = judge(A.bad);
  assert.equal(v.verdict, "FAIL");
  for (const chain of CHAINS) {
    assert.ok(bad(v).some((l) => l.startsWith(`BAD [${chain}] the index synced on from the release's snapshot`)), chain);
    assert.ok(bad(v).some((l) => l.startsWith(`BAD [${chain}]`) && l.includes("no getLogs at or below the N")), chain);
  }
});

test("one tap of the good run that scans by currency from past maxLag below its newest block fails on that tap alone", () => {
  const a = structuredClone(A.good);
  const r = a.chains.robinhood.rows[0];
  r.logs = [...r.logs, { host: "rpc.mainnet.chain.robinhood.com", from: r.n + 1, to: r.n + 500, currency: true, after: false }];
  const v = judge(a);
  assert.equal(v.verdict, "FAIL");
  assert.equal(bad(v).length, 1, bad(v).join("\n"));
  assert.ok(bad(v)[0].includes(`${r.symbol}: no scan by currency before its answer`), bad(v)[0]);
});

test("a gap sync that reads the index again from its first block fails", () => {
  const a = structuredClone(A.good);
  const k = a.chains.base.keep[0];
  k.logs = [...(k.logs ?? []), { host: "base-rpc.publicnode.com", from: a.chains.base.index.snapshotFrom, to: a.chains.base.index.snapshotFrom + 9_999, currency: false, after: false }];
  assert.ok(bad(judge(a)).some((l) => l.startsWith("BAD [base] every gap sync")));
});

test("an index built cold, not from the release's snapshot, fails", () => {
  const a = structuredClone(A.good);
  a.chains.robinhood.index.from = a.chains.robinhood.index.snapshotFrom + 1;
  assert.ok(bad(judge(a)).some((l) => l.startsWith("BAD [robinhood] the index synced on from the release's snapshot")));
});

test("a tap that ends in a provider's fault fails", () => {
  const a = structuredClone(A.good);
  Object.assign(a.chains.base.rows[0], { ok: false, code: "rpc_error" });
  assert.equal(judge(a).verdict, "FAIL");
});
