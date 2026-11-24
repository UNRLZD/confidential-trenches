// The live check evm-cut-logs-only-where-served replayed on its recorded answers
// (evm-cut-logs-only-where-served.answers.json):
//   good: this card's kit on Base and Robinhood mainnet, every warm tap's cut-log read sent to a listed provider: PASS;
//   bad_unfiltered: the same kit with unmovedSince's filter taken out, one Base read sent to mainnet.base.org and two
//   Robinhood reads to robinhood-rpc.publicnode.com: FAIL;
// and planted cases: a listed provider that refuses the read, in the probe or in a tap, fails; a venue listing fewer
// than two fails; taps that read no cut log on either chain have nothing to judge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cutLogIds, judge } from "./evm-cut-logs-only-where-served.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-cut-logs-only-where-served.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (f) => {
  const run = structuredClone(A.good);
  f(run);
  return judge(run);
};

test("the recorded good answer passes: every listed provider answers the read, every tap's read went to one", () => {
  const r = judge(A.good);
  assert.deepEqual([r.ok, r.quiet], [true, false], r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  [base] the taps' 3 cut-log reads, 0 to providers the venue does not list: base-rpc.publicnode.com 1, base-mainnet.public.blastapi.io 1, base.api.pocket.network 1"), r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  [robinhood] the taps' 4 cut-log reads, 0 to providers the venue does not list: robinhood.drpc.org 2, rpc.mainnet.chain.robinhood.com 2"), r.lines.join("\n"));
  for (const host of ["base-rpc.publicnode.com", "base-mainnet.public.blastapi.io", "base.api.pocket.network", "robinhood.drpc.org", "rpc.mainnet.chain.robinhood.com"]) assert.ok(r.lines.some((l) => l.startsWith("ok ") && l.includes(`${host} (listed) answers the read`)), host);
});

test("the recorded bad answer fails: without the filter, reads went to mainnet.base.org and Robinhood's publicnode", () => {
  const r = judge(A.bad_unfiltered);
  assert.deepEqual([r.ok, r.quiet], [false, false]);
  assert.deepEqual(bad(r), ["BAD [base] the taps' 3 cut-log reads, 1 to providers the venue does not list: mainnet.base.org 1", "BAD [robinhood] the taps' 4 cut-log reads, 2 to providers the venue does not list: robinhood-rpc.publicnode.com 2"]);
});

test("planted cases: a listed provider that refuses the read fails; a venue listing one provider fails; no answer is no verdict", () => {
  // the probe: a listed provider's refusal (bloXroute's words) fails; its no-answer alone is printed, never judged
  const refusedProbe = edit((r) => (r.chains.robinhood.probe.providers["robinhood.drpc.org"][1] = { refused: "-32601 Method not available on this endpoint" }));
  assert.equal(refusedProbe.ok, false);
  assert.match(bad(refusedProbe)[0], /^BAD \[robinhood\] robinhood\.drpc\.org \(listed\) refuses the read: /);
  const silent = edit((r) => (r.chains.robinhood.probe.providers["robinhood.drpc.org"] = [{ no: "robinhood.drpc.org HTTP 429: 429 Too Many Requests" }]));
  assert.equal(silent.ok, true, silent.lines.join("\n"));
  assert.ok(silent.lines.some((l) => l.startsWith("--  [robinhood] robinhood.drpc.org (listed): no answer")));
  // a tap's read a listed provider refused fails
  const refusedTap = edit((r) => (r.chains.base.taps[1].cut[0] = { ...r.chains.base.taps[1].cut[0], logs: undefined, refused: "-32011 request limit reached" }));
  assert.equal(refusedTap.ok, false);
  assert.match(bad(refusedTap)[0], /^BAD \[base\] no listed provider refused a tap's cut-log read: /);
  // a venue listing fewer than two: no warm tap can prove a pool unmoved
  const one = edit((r) => (r.chains.robinhood.listed = ["robinhood.drpc.org"]));
  assert.equal(one.ok, false);
  assert.ok(bad(one).includes("BAD [robinhood] the venue lists 1 log provider(s): a warm tap needs two that agree"));
});

test("nothing to judge: taps that read no cut log on either chain; one chain's reads alone are judged", () => {
  const none = edit((r) => {
    for (const c of Object.values(r.chains)) for (const t of c.taps) t.cut = [];
  });
  assert.deepEqual([none.ok, none.quiet], [true, true], none.lines.join("\n"));
  assert.equal(bad(none).length, 0);
  const baseOnly = edit((r) => {
    for (const t of r.chains.robinhood.taps) t.cut = [];
  });
  assert.deepEqual([baseOnly.ok, baseOnly.quiet], [true, false]);
  assert.ok(baseOnly.lines.includes("--  [robinhood] no tap read the pruned pools' logs: nothing to judge on this chain"));
});

test("cutLogIds reads the ids of a post's eth_getLogs of Swap and ModifyLiquidity as an OR, and of no other call", () => {
  const swap = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
  const ml = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";
  const body = JSON.stringify([
    { jsonrpc: "2.0", id: 0, method: "eth_getBlockByNumber", params: ["0x10", false] },
    { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ fromBlock: "0x11", toBlock: "0x1a", topics: [[swap, ml], ["0x" + "ab".repeat(32)]] }] },
    { jsonrpc: "2.0", id: 2, method: "eth_getLogs", params: [{ topics: [swap] }] },
    { jsonrpc: "2.0", id: 3, method: "eth_getLogs", params: [{ topics: [[swap]] }] },
  ]);
  assert.deepEqual(cutLogIds(body), [1]);
  assert.deepEqual(cutLogIds(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "eth_getLogs", params: [{ topics: [[ml, swap]] }] })), [7]);
  assert.deepEqual(cutLogIds("not json"), []);
});
