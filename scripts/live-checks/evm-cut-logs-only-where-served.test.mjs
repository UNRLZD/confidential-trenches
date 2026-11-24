// The live check evm-cut-logs-only-where-served replayed on its recorded answers
// (evm-cut-logs-only-where-served.answers.json):
//   good: card robinhood-cut-logs-off-the-index-seat's kit on Base and Robinhood mainnet, every Base warm tap's cut-log
//   read sent to a listed provider, and Robinhood, listing dRPC alone, sending none while its warm taps quoted: PASS;
//   bad_own_seat: card evm-cut-logs-only-where-served's kit (release 203's), Robinhood's own RPC, the index sync's seat,
//   listed and asked two of the warm taps' cut-log reads: FAIL;
//   bad_unfiltered: that kit with unmovedSince's filter taken out, one Base read sent to mainnet.base.org and two
//   Robinhood reads to robinhood-rpc.publicnode.com: FAIL;
// and planted cases: a listed provider that refuses the read, in the probe or in a tap, fails; a venue listing one
// provider whose taps send a cut-log read fails, and one whose warm taps never quoted has nothing to judge; taps that
// read no cut log on either chain have nothing to judge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cutLogIds, judge } from "./evm-cut-logs-only-where-served.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-cut-logs-only-where-served.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (f, from = A.good) => {
  const run = structuredClone(from);
  f(run);
  return judge(run);
};

test("the recorded good answer passes: every listed provider answers the read, Base's taps read only those, Robinhood's none", () => {
  const r = judge(A.good);
  assert.deepEqual([r.ok, r.quiet], [true, false], r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  [base] the taps' 4 cut-log reads, 0 to providers the venue does not list: base-rpc.publicnode.com 2, base-mainnet.public.blastapi.io 2"), r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  [robinhood] the venue does not list rpc.mainnet.chain.robinhood.com, the index sync's seat, as a log provider"), r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  [robinhood] the taps sent no cut-log read, and a warm tap quoted"), r.lines.join("\n"));
  for (const host of ["base-rpc.publicnode.com", "base-mainnet.public.blastapi.io", "robinhood.drpc.org"]) assert.ok(r.lines.some((l) => l.startsWith("ok ") && l.includes(`${host} (listed) answers the read`)), host);
});

test("the recorded bad answers fail: Robinhood's own listed and asked; without the filter, reads went to mainnet.base.org and Robinhood's publicnode", () => {
  const seat = judge(A.bad_own_seat);
  assert.deepEqual([seat.ok, seat.quiet], [false, false]);
  assert.deepEqual(bad(seat), ["BAD [robinhood] the venue lists rpc.mainnet.chain.robinhood.com, the index sync's seat, as a log provider", "BAD [robinhood] 2 of the taps' 4 cut-log reads to rpc.mainnet.chain.robinhood.com, the index sync's seat"]);
  const r = judge(A.bad_unfiltered);
  assert.deepEqual([r.ok, r.quiet], [false, false]);
  assert.deepEqual(bad(r), ["BAD [base] the taps' 3 cut-log reads, 1 to providers the venue does not list: mainnet.base.org 1", "BAD [robinhood] the venue lists rpc.mainnet.chain.robinhood.com, the index sync's seat, as a log provider", "BAD [robinhood] the taps' 4 cut-log reads, 2 to providers the venue does not list: robinhood-rpc.publicnode.com 2"]);
});

test("planted cases: a listed provider that refuses the read fails; one provider listed and a cut-log read sent fails; no answer is no verdict", () => {
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
  // one provider listed: no pair proves a pool unmoved, so any cut-log read a tap sends fails, even to that one
  const one = edit((r) => (r.chains.robinhood.taps[1].cut = [{ host: "robinhood.drpc.org", status: 200, logs: 3 }]));
  assert.equal(one.ok, false);
  assert.deepEqual(bad(one), ["BAD [robinhood] the venue lists 1 log provider(s), yet the taps sent 1 cut-log reads: robinhood.drpc.org 1"]);
  // one provider listed, no read sent, but no warm tap quoted: nothing on Robinhood shows the taps would have read
  const unquoted = edit((r) => {
    for (const t of r.chains.robinhood.taps) Object.assign(t, { ok: false, code: "rpc_unavailable" });
  });
  assert.equal(unquoted.ok, true, unquoted.lines.join("\n"));
  assert.ok(unquoted.lines.includes("--  [robinhood] no warm tap quoted: nothing to judge on this chain"));
});

test("nothing to judge: taps that read no cut log on Base and no warm tap quoted on Robinhood; one chain's verdict alone is judged", () => {
  const none = edit((r) => {
    for (const t of r.chains.base.taps) t.cut = [];
    for (const t of r.chains.robinhood.taps) Object.assign(t, { ok: false, code: "rpc_unavailable" });
  });
  assert.deepEqual([none.ok, none.quiet], [true, true], none.lines.join("\n"));
  assert.equal(bad(none).length, 0);
  const robinhoodOnly = edit((r) => {
    for (const t of r.chains.base.taps) t.cut = [];
  });
  assert.deepEqual([robinhoodOnly.ok, robinhoodOnly.quiet], [true, false]);
  assert.ok(robinhoodOnly.lines.includes("--  [base] no tap read the pruned pools' logs: nothing to judge on this chain"));
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
