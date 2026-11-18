// node --test scripts/live-checks/rh-provider-fails-64-read-batch.test.mjs: the live check replays its recorded runs
// (rh-provider-fails-64-read-batch.answers.json), each written by its own --record from this Mac, 18 Nov 2026:
//   good (00:48Z): this card's kit, its four Robinhood quote providers, each answering the kit's batch (3 calls of 64
//   real quotes) in full: PASS;
//   bad (00:49Z): main caaf429dd's kit, the same four and rpc-robinhood.globalstake.io, which answered the batch HTTP 500
//   after 2.6 s while it quoted the 6-read control in full: FAIL;
//   badCalls (17 Nov 23:59Z): 4 calls a batch (--calls 4), which robinhood.drpc.org refuses, code 31: FAIL.
// Then cases planted on the good run, one end state undone each.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONTROL_READS, judge, kitShape } from "./rh-provider-fails-64-read-batch.mjs";

const A = JSON.parse(readFileSync(new URL("./rh-provider-fails-64-read-batch.answers.json", import.meta.url), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
const GS = "rpc-robinhood.globalstake.io";
// the provider the planted cases undo: one of the good run's
const P = "robinhood.rpc.blxrbdn.com";
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

test("the good answer: every Robinhood provider the kit pins answers the kit's batch, 3 calls of 64 quotes each: PASS", () => {
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
});

test("the bad answer: main's list, where globalstake answers the batch HTTP 500 and quotes the 6-read control: FAIL", () => {
  assert.equal(at(A.bad, GS)?.answer?.status, 500);
  assert.equal(at(A.bad, GS).control?.ok, "1".repeat(CONTROL_READS));
  fails(A.bad, `${GS}: answers 6 reads at once quoted in full but not the kit's batch`);
  // every other provider of that run answered in full: globalstake alone is the fault
  const r = judge(A.bad);
  assert.equal(r.lines.filter((l) => l.startsWith("BAD")).length, 1, r.lines.join("\n"));
});

test("the kit no longer pins a provider the bad run read failing the batch", () => {
  const failing = judge(A.bad).lines.filter((l) => l.startsWith("BAD ")).map((l) => l.slice(4).split(/[: ]/)[0]);
  assert.deepEqual(failing, [GS]);
  for (const h of failing) assert.ok(!kitShape().providers.some((u) => new URL(u).host === h), `${h} is still pinned`);
});

test("badCalls: a batch of 4 calls, which robinhood.drpc.org refuses (code 31) while it quotes 6 reads: FAIL", () => {
  assert.equal(A.badCalls.shape.calls, 4);
  assert.deepEqual(at(A.badCalls, "robinhood.drpc.org").control?.ok, "1".repeat(CONTROL_READS));
  fails(A.badCalls, "robinhood.drpc.org call 1: an error");
  fails(A.badCalls, "the batch is the kit's");
});

test("planted on a provider of the good run: the batch HTTP 500 (globalstake's answer) while 6 reads at once are quoted: FAIL", () => {
  const run = clone(A.good);
  at(run, P).control = SMALL;
  at(run, P).answer = { status: 500, noAnswer: `${P} HTTP 500: not JSON (<html> <head><title>500 Internal Server)` };
  fails(run, `${P}: answers 6 reads at once quoted in full but not the kit's batch`);
  // a 413 and a timeout of the whole batch, and one call of it HTTP 500: FAIL the same way
  for (const answer of [{ status: 413, noAnswer: `${P} HTTP 413: not JSON (<html>413 Request Entity Too Large)` }, { noAnswer: `${P}: no answer (TimeoutError)` }]) {
    at(run, P).answer = answer;
    fails(run, `${P}: answers 6 reads at once quoted in full but not the kit's batch`);
  }
  const one = clone(A.good);
  at(one, P).control = SMALL;
  at(one, P).answer.calls[1] = { noAnswer: `${P} HTTP 200: no answer for call 2 of 3` };
  fails(one, `${P} call 2: answers 6 reads at once quoted in full but not the kit's batch`);
  // a JSON-RPC error for the whole batch fails whatever the control
  const err = clone(A.good);
  at(err, P).answer = { status: 200, error: { code: -32600, message: "batch too large" } };
  fails(err, `${P}: answers the kit's batch with an error`);
});

test("planted: the same HTTP 500 where the 6 reads are not answered either is a passing fault: INCONCLUSIVE", () => {
  for (const control of [undefined, { noAnswer: `${P} HTTP 500: not JSON (<html> <head><title>500 Internal Server)` }, { ok: "111112", gas: [1, 2] }]) {
    const run = clone(A.good);
    if (control !== undefined) at(run, P).control = control;
    at(run, P).answer = { status: 500, noAnswer: `${P} HTTP 500: not JSON (<html> <head><title>500 Internal Server)` };
    quiet(run, `${P}: a passing fault`);
  }
});

test("planted: a call that left reads unquoted, a call missing, a call with an error, an answer not the code's: FAIL", () => {
  let run = clone(A.good);
  at(run, P).answer.calls[1].ok = "2" + "1".repeat(63);
  fails(run, `${P} call 2: 63 of 64 reads quoted`);
  run = clone(A.good);
  at(run, P).answer.calls[2].ok = "1".repeat(6);
  fails(run, `${P} call 3: 6 of 64 reads quoted`);
  run = clone(A.good);
  at(run, P).answer.calls.pop();
  fails(run, `${P}: 2 answers for 3 calls`);
  run = clone(A.good);
  at(run, P).answer.calls[0] = { error: { code: -32000, message: "out of gas" } };
  fails(run, `${P} call 1: an error`);
  run = clone(A.good);
  at(run, P).answer.calls[0] = { notCode: '"0x"' };
  fails(run, `${P} call 1: not the code's answer`);
});

test("planted: the kit's batch or list moves past the recording: FAIL until it is read again", () => {
  const kit = kitShape();
  fails(A.good, "the batch is the kit's", { ...kit, perCall: kit.perCall * 2 });
  fails(A.good, "the batch is the kit's", { ...kit, calls: kit.calls + 1 });
  fails(A.good, "every provider the kit pins on robinhood was read", { ...kit, providers: [...kit.providers, "https://rpc.example.org"] });
  const run = clone(A.good);
  run.reads = run.reads.filter((x) => x.provider !== P);
  fails(run, "every provider the kit pins on robinhood was read");
  const big = clone(A.good);
  at(big, P).bytes = kit.maxBytes + 1;
  fails(big, `${P}: the batch's body is`);
});

test("planted: a provider that answers nothing or throttles the batch is named, INCONCLUSIVE, never PASS", () => {
  let run = clone(A.good);
  at(run, P).head = { noAnswer: `${P}: no answer (ECONNREFUSED)` };
  quiet(run, `${P}: no answer to its latest block`);
  run = clone(A.good);
  at(run, P).answer = { status: 429, noAnswer: `${P} HTTP 429: 429 Too Many Requests` };
  quiet(run, `${P}: throttled`);
  run = clone(A.good);
  at(run, "robinhood.drpc.org").answer.calls[0] = { noAnswer: 'robinhood.drpc.org HTTP 200: rate limit {"message":"You reached Public endpoint rate limit, please upgrade to paid plan","code":15}' };
  quiet(run, "robinhood.drpc.org call 1: throttled");
});
