// Replays pool-sol-deploy-sweep.answers.json through the live check: the recorded good answer (the devnet stop run,
// read on two devnet RPCs) passes; the same recording with one thing changed fails: the funder holding a lamport, a
// sweep landing before the funding, a sweep that failed, a sweep to another address, the last sweep leaving lamports,
// a transaction of the record left unsettled, a run that was not stopped, and RPCs that are not two devnet operators.
//   node --test scripts/live-checks/pool-sol-deploy-sweep.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check } from "./pool-sol-deploy-sweep.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-sol-deploy-sweep.answers.json", import.meta.url), "utf8"));
const D = A.deployment;
const sweeps = D.txs.filter((t) => t.step.startsWith("sweep"));
const funding = D.txs.find((t) => t.step.startsWith("funding"));

function replay(answers) {
  const used = new Set();
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const i = answers.findIndex((a, j) => !used.has(j) && a.url === url && a.method === method && JSON.stringify(a.params) === JSON.stringify(params));
    if (i < 0) throw new Error(`no recorded answer for ${method} ${JSON.stringify(params).slice(0, 80)} on ${url}`);
    used.add(i);
    const a = answers[i];
    return { ok: a.status === 200, status: a.status, json: async () => a.json };
  };
}
const run = (answers, deployment = D, rpcs = A.rpcs) => check({ deployment, fetchFn: replay(answers), rpcs, sleep: async () => {} });
/** the recording with every answer of `method` for `first` param changed by `f(result)` */
function mutate(method, first, f) {
  const out = structuredClone(A.good);
  for (const a of out) if (a.method === method && a.params[0] === first && a.json?.result) a.json.result = f(a.json.result);
  return out;
}
const fails = (r, re) => {
  assert.equal(r.ok, false);
  assert.match(r.lines.filter((l) => l.startsWith("FAIL")).join("\n"), re);
};

test("the recorded good answer passes, every line ok on both RPCs", async () => {
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(funding && sweeps.length >= 1);
  assert.equal(r.lines.filter((l) => / on https:/.test(l)).length, 2 * (1 + D.txs.length + 1 + 2 * sweeps.length + 1 + 1));
});

test("a funder holding a lamport fails", async () => {
  fails(await run(mutate("getBalance", D.funder, (r) => ({ ...r, value: 1 }))), /the funder \S+ holds 1 lamports at finalized/);
});

test("a sweep in a slot before the funding's fails", async () => {
  fails(await run(mutate("getTransaction", sweeps[0].signature, (r) => ({ ...r, slot: 1 }))), /came after the funding/);
});

test("a sweep that failed fails, and so does one to another address", async () => {
  fails(await run(mutate("getTransaction", sweeps[0].signature, (r) => ({ ...r, meta: { ...r.meta, err: { InstructionError: [0, "Custom"] } } }))), /is finalized with no error/);
  fails(await run(mutate("getTransaction", sweeps[0].signature, (r) => {
    const k = [...r.transaction.message.accountKeys];
    k[r.transaction.message.instructions[0].accounts[1]] = "11111111111111111111111111111112";
    return { ...r, transaction: { ...r.transaction, message: { ...r.transaction.message, accountKeys: k } } };
  })), /is the funder's one transfer to/);
});

test("a last sweep that leaves lamports on the funder fails", async () => {
  const last = sweeps.at(-1).signature;
  fails(await run(mutate("getTransaction", last, (r) => {
    const i = r.transaction.message.accountKeys.indexOf(D.funder);
    const post = [...r.meta.postBalances];
    post[i] = 5000;
    return { ...r, meta: { ...r.meta, postBalances: post } };
  })), /the last sweep left the funder at 5000 lamports/);
});

test("a record with a transaction left sent, or a run that was not stopped, fails", async () => {
  const sent = structuredClone(D);
  sent.txs.push({ step: "deposit 0.01 SOL (tag 1)", signature: "1".repeat(64), state: "sent" });
  fails(await run(A.good, sent), /no transaction of the record is left unsettled/);
  fails(await run(A.good, { ...D, stopped: null }), /the run was stopped by a signal/);
});

test("RPCs that are not two devnet operators fail", async () => {
  // the second RPC's answers, served from a host that is no known devnet operator
  const other = "https://devnet.example.com";
  const answers = A.good.map((a) => (a.url === A.rpcs[1] ? { ...a, url: other } : a));
  fails(await run(answers, D, [A.rpcs[0], other]), /known devnet operator/);
});
