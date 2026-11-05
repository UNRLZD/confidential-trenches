// node --test scripts/live-checks/base-200ms-blocks.test.mjs: the live check's verdict replays recorded reads
// (base-200ms-blocks.answers.json; its _note says where each was read): the good answer passes and each bad one fails by
// name, and planted changes to the good one fail by name too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BLOCK_CLOCK } from "../../apps/helper/src/data/evm/lists.ts";
import { BACK, judge, PROVIDERS, read } from "./base-200ms-blocks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "base-200ms-blocks.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
/** The good reads with one provider's block edited: `f` gets the parsed JSON-RPC answer of "head" or "back". */
const edit = (which, i, f, { now = A.good.now, clock } = {}) => {
  const reads = structuredClone(A.good.reads);
  const j = JSON.parse(reads.providers[i][which].text);
  f(j.result, j);
  reads.providers[i][which].text = JSON.stringify(j);
  return judge(reads, now, clock);
};
const hexOf = (n) => `0x${n.toString(16)}`;

test("the recorded good answer passes: on both providers the head is where the 200 ms era puts it, 10,000 blocks took 200 ms each, the head is fresh", () => {
  const r = judge(A.good.reads, A.good.now);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(A.good.reads.providers.map((p) => p.url), PROVIDERS.map((p) => p.url));
  assert.equal(BACK, 10_000);
  assert.equal(bad(r).length, 0);
  assert.equal(r.lines.filter((l) => /block time/.test(l) && l.startsWith("ok ")).length, 2);
});

test("the recorded bad answer with Base's 2 s era only fails on both providers, naming the block drift and the block time", () => {
  assert.deepEqual(A.badTwoSecondClock.clock, [{ fromBlock: 0, atMs: 1686789347000, blockMs: 2000 }]);
  assert.deepEqual(A.badTwoSecondClock.clock, BLOCK_CLOCK.base.slice(0, 1), "the 2 s era is the first era of the real table");
  const r = judge(A.good.reads, A.badTwoSecondClock.now, A.badTwoSecondClock.clock);
  assert.equal(r.ok, false, r.lines.join("\n"));
  for (const p of PROVIDERS) {
    assert.ok(bad(r).some((l) => l.includes(p.name) && /block drift/.test(l)), bad(r).join("\n"));
    assert.ok(bad(r).some((l) => l.includes(p.name) && /block time/.test(l) && /2000(\.\d+)? ms/.test(l)), bad(r).join("\n"));
  }
});

test("the same 2 s-only clock fails on a fresh replay of the good reads, and the real table passes them", () => {
  assert.equal(judge(A.good.reads, A.good.now, BLOCK_CLOCK.base.slice(0, 1)).ok, false);
  assert.equal(judge(A.good.reads, A.good.now, BLOCK_CLOCK.base).ok, true);
  assert.equal(judge(A.good.reads, A.good.now).ok, true, "the default is the helper's real table");
});

test("the recorded bad answer with one provider's head 90 s stale fails, naming that provider", () => {
  assert.match(A.badStaleHead.note, /edited/);
  const r = judge(A.badStaleHead.reads, A.badStaleHead.now);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => l.includes(PROVIDERS[1].name) && /stale/.test(l)), bad(r).join("\n"));
  assert.ok(!bad(r).some((l) => l.includes(PROVIDERS[0].name)), "the fresh provider is not blamed");
});

test("the good reads judged 61 s later fail as stale on both providers, 55 s later pass the freshness line", () => {
  const late = judge(A.good.reads, A.good.now + 61_000);
  assert.equal(bad(late).filter((l) => /stale/.test(l)).length, 2, late.lines.join("\n"));
  const ok = judge(A.good.reads, A.good.now + 55_000);
  assert.ok(!bad(ok).some((l) => /stale/.test(l)), ok.lines.join("\n"));
});

test("a head 11 blocks off the era's prediction fails, 5 blocks off passes", () => {
  // the header's time stays, its number moves: only the drift line can see it
  const off = (d) => edit("head", 0, (b) => { b.number = hexOf(Number(b.number) + d); });
  const r = off(11);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.includes(PROVIDERS[0].name) && /block drift/.test(l)), bad(r).join("\n"));
  assert.ok(!bad(off(-5)).some((l) => /block drift/.test(l)), bad(off(-5)).join("\n"));
});

test("a block time 1% off fails, 0.5% off passes", () => {
  // the back block's time moves earlier, so 10,000 blocks (a 2000 s span) took 22 s more (+1.1%) or 10 s more (+0.5%)
  const slow = (extraS) => edit("back", 1, (b) => { b.timestamp = hexOf(Number(b.timestamp) - extraS); });
  const r = slow(22);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => l.includes(PROVIDERS[1].name) && /block time/.test(l)), bad(r).join("\n"));
  const fine = slow(10);
  assert.ok(!bad(fine).some((l) => /block time/.test(l)), fine.lines.join("\n"));
});

test("a provider that errors, times out or answers 500 fails naming it and does not throw", () => {
  for (const f of [{ error: "TimeoutError: The operation was aborted due to timeout" }, { error: "fetch failed" }, { status: 500, text: "upstream down" }, { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "rate limited" } }) }]) {
    for (const which of ["head", "back"]) {
      const reads = structuredClone(A.good.reads);
      reads.providers[0][which] = f;
      const r = judge(reads, A.good.now);
      assert.equal(r.ok, false, r.lines.join("\n"));
      assert.ok(bad(r).some((l) => l.includes(PROVIDERS[0].name)), bad(r).join("\n"));
    }
  }
});

test("a malformed answer fails by name: a non-hex number, a missing timestamp, a number past safe integers, a null result, not JSON, a back block that is not 10,000 below", () => {
  const cases = [
    ["head", (b) => { b.number = "0xZZ"; }],
    ["head", (b) => { b.number = "12345"; }],
    ["head", (b) => { b.number = "0x" + "f".repeat(20); }],
    ["head", (b) => { delete b.timestamp; delete b.timestampMs; }],
    ["head", (b) => { b.timestamp = "soon"; }],
    ["head", (b) => { b.timestampMs = "0x"; }],
    ["back", (b) => { b.number = hexOf(Number(b.number) + 1); }],
    ["back", (b) => { delete b.timestamp; delete b.timestampMs; }],
    ["head", (b, j) => { j.result = null; }],
  ];
  for (const [which, f] of cases) {
    const r = edit(which, 1, f);
    assert.equal(r.ok, false, `${which} ${f}\n${r.lines.join("\n")}`);
    assert.ok(bad(r).some((l) => l.includes(PROVIDERS[1].name)), bad(r).join("\n"));
  }
  const reads = structuredClone(A.good.reads);
  reads.providers[1].head.text = "<html>502</html>";
  assert.equal(judge(reads, A.good.now).ok, false);
  assert.equal(judge({ providers: [] }, A.good.now).ok, false, "no providers is no read");
  assert.equal(judge(undefined, A.good.now).ok, false);
  assert.equal(judge(A.good.reads, Number.NaN).ok, false);
});

test("read() gathers both providers' head and the block 10,000 below it, with a 10 s limit, and a failed fetch is recorded, not thrown", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: body.method, params: body.params, aborts: init.signal instanceof AbortSignal });
    if (url === PROVIDERS[1].url && body.params[0] !== "latest") throw new Error("boom");
    const n = body.params[0] === "latest" ? 0x331ef98 : parseInt(body.params[0], 16);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { number: hexOf(n), timestamp: "0x6aece9b9" } }), { status: 200 });
  };
  const reads = await read(fetchFn);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.method === "eth_getBlockByNumber" && c.params[1] === false && c.aborts));
  for (const p of PROVIDERS) assert.deepEqual(calls.filter((c) => c.url === p.url).map((c) => c.params[0]), ["latest", hexOf(0x331ef98 - 10_000)]);
  assert.deepEqual(reads.providers.map((p) => p.url), PROVIDERS.map((p) => p.url));
  assert.match(reads.providers[1].back.error, /boom/);
  assert.equal(typeof reads.providers[0].back.text, "string");
});
