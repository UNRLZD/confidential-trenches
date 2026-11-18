// node --test scripts/live-checks/rh-provider-fails-64-read-batch.test.mjs: the live check replays its recorded runs
// (rh-provider-fails-64-read-batch.answers.json), each written by its own --record from this Mac, 18 Nov 2026:
//   good: the kit's batch (3 calls of 64 real quotes) on all five pinned Robinhood providers: PASS;
//   bad: the same with 4 calls a batch (--calls 4): robinhood.drpc.org answers each call code 31 "Batch of more than 3
//   requests are not allowed on free plan": FAIL.
// Then cases planted on the good run, one end state undone each, among them rpc-robinhood.globalstake.io's answer to
// the gas-starve check's call of 64 reads on 10 Nov (HTTP 500, an nginx page).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONTROL_READS, judge, kitShape } from "./rh-provider-fails-64-read-batch.mjs";

const A = JSON.parse(readFileSync(new URL("./rh-provider-fails-64-read-batch.answers.json", import.meta.url), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
const GS = "rpc-robinhood.globalstake.io";
const SMALL = { ok: "1".repeat(CONTROL_READS), gas: [104833, 117833] };
const at = (run, host) => run.reads.find((r) => r.provider === host);
const fails = (run, start, kit) => {
  const r = judge(run, kit);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith(`BAD ${start}`)), `${start}\n${r.lines.join("\n")}`);
};
const quiet = (run, start) => {
  const r = judge(run);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith(`--- ${start}`)), `${start}\n${r.lines.join("\n")}`);
  assert.ok(!r.lines.some((l) => l.startsWith("BAD")), r.lines.join("\n"));
};

test("the good answer: every pinned Robinhood provider answers the kit's batch, 3 calls of 64 quotes each: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  const kit = kitShape();
  assert.deepEqual(A.good.shape, { calls: kit.calls, perCall: kit.perCall, maxBytes: kit.maxBytes });
  assert.ok(kit.perCall >= 64, `the kit's reads a call: ${kit.perCall}`);
  assert.deepEqual(A.good.reads.map((x) => x.provider), kit.providers.map((u) => new URL(u).host));
  for (const x of A.good.reads) {
    assert.equal(x.answer.calls.length, kit.calls, x.provider);
    for (const c of x.answer.calls) assert.equal(c.ok, "1".repeat(kit.perCall), x.provider);
  }
  assert.ok(at(A.good, GS) !== undefined);
});

test("the bad answer: a batch of 4 calls, which robinhood.drpc.org refuses (code 31) while it quotes 6 reads: FAIL", () => {
  assert.equal(A.bad.shape.calls, 4);
  assert.deepEqual(at(A.bad, "robinhood.drpc.org").control?.ok, "1".repeat(CONTROL_READS));
  fails(A.bad, "robinhood.drpc.org call 1: an error");
  fails(A.bad, "the batch is the kit's");
});

test("planted: globalstake answers the batch HTTP 500 (its 10 Nov answer to 64 reads) while 6 reads at once are quoted: FAIL", () => {
  const run = clone(A.good);
  at(run, GS).control = SMALL;
  at(run, GS).answer = { status: 500, noAnswer: `${GS} HTTP 500: not JSON (<html> <head><title>500 Internal Server)` };
  fails(run, `${GS}: answers 6 reads at once quoted in full but not the kit's batch`);
  // a 413 and a timeout of the whole batch, and one call of it HTTP 500: FAIL the same way
  for (const answer of [{ status: 413, noAnswer: `${GS} HTTP 413: not JSON (<html>413 Request Entity Too Large)` }, { noAnswer: `${GS}: no answer (TimeoutError)` }]) {
    at(run, GS).answer = answer;
    fails(run, `${GS}: answers 6 reads at once quoted in full but not the kit's batch`);
  }
  const one = clone(A.good);
  at(one, GS).control = SMALL;
  at(one, GS).answer.calls[1] = { noAnswer: `${GS} HTTP 200: no answer for call 2 of 3` };
  fails(one, `${GS} call 2: answers 6 reads at once quoted in full but not the kit's batch`);
  // a JSON-RPC error for the whole batch fails whatever the control
  const err = clone(A.good);
  at(err, GS).answer = { status: 200, error: { code: -32600, message: "batch too large" } };
  fails(err, `${GS}: answers the kit's batch with an error`);
});

test("planted: the same HTTP 500 where the 6 reads are not answered either (globalstake on GitHub's runners, 14-17 Nov) is a passing fault: INCONCLUSIVE", () => {
  for (const control of [undefined, { noAnswer: `${GS} HTTP 500: not JSON (<html> <head><title>500 Internal Server)` }, { ok: "111112", gas: [1, 2] }]) {
    const run = clone(A.good);
    if (control !== undefined) at(run, GS).control = control;
    at(run, GS).answer = { status: 500, noAnswer: `${GS} HTTP 500: not JSON (<html> <head><title>500 Internal Server)` };
    quiet(run, `${GS}: a passing fault`);
  }
});

test("planted: a call that left reads unquoted, a call missing, a call with an error, an answer not the code's: FAIL", () => {
  let run = clone(A.good);
  at(run, GS).answer.calls[1].ok = "2" + "1".repeat(63);
  fails(run, `${GS} call 2: 63 of 64 reads quoted`);
  run = clone(A.good);
  at(run, GS).answer.calls[2].ok = "1".repeat(6);
  fails(run, `${GS} call 3: 6 of 64 reads quoted`);
  run = clone(A.good);
  at(run, GS).answer.calls.pop();
  fails(run, `${GS}: 2 answers for 3 calls`);
  run = clone(A.good);
  at(run, GS).answer.calls[0] = { error: { code: -32000, message: "out of gas" } };
  fails(run, `${GS} call 1: an error`);
  run = clone(A.good);
  at(run, GS).answer.calls[0] = { notCode: '"0x"' };
  fails(run, `${GS} call 1: not the code's answer`);
});

test("planted: the kit's batch or list moves past the recording: FAIL until it is read again", () => {
  const kit = kitShape();
  fails(A.good, "the batch is the kit's", { ...kit, perCall: kit.perCall * 2 });
  fails(A.good, "the batch is the kit's", { ...kit, calls: kit.calls + 1 });
  fails(A.good, "every provider the kit pins on robinhood was read", { ...kit, providers: [...kit.providers, "https://rpc.example.org"] });
  const run = clone(A.good);
  run.reads = run.reads.filter((x) => x.provider !== GS);
  fails(run, "every provider the kit pins on robinhood was read");
  const big = clone(A.good);
  at(big, GS).bytes = kit.maxBytes + 1;
  fails(big, `${GS}: the batch's body is`);
});

test("planted: a provider that answers nothing or throttles the batch is named, INCONCLUSIVE, never PASS", () => {
  let run = clone(A.good);
  at(run, GS).head = { noAnswer: `${GS}: no answer (ECONNREFUSED)` };
  quiet(run, `${GS}: no answer to its latest block`);
  run = clone(A.good);
  at(run, GS).answer = { status: 429, noAnswer: `${GS} HTTP 429: 429 Too Many Requests` };
  quiet(run, `${GS}: throttled`);
  run = clone(A.good);
  at(run, "robinhood.drpc.org").answer.calls[0] = { noAnswer: 'robinhood.drpc.org HTTP 200: rate limit {"message":"You reached Public endpoint rate limit, please upgrade to paid plan","code":15}' };
  quiet(run, "robinhood.drpc.org call 1: throttled");
});
