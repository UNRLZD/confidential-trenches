// Replays pool-sol-deploy-sweep.answers.json through the live check: the recorded good answer (the devnet stop run's
// journal, read on two devnet RPCs) passes; the same recording with one thing changed fails: the funder holding a
// lamport, a funding whose block time is before the stop, a sweep landing before the funding, a sweep that failed, a
// sweep to another address, the last sweep leaving lamports, a transaction of the journal left unsettled, a run that
// was not stopped, a journal with no stop time, a journal whose keys are kept, and RPCs that are not two devnet
// operators.
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
  assert.equal(r.lines.filter((l) => / on https:/.test(l)).length, 2 * (1 + D.txs.length + 2 + 2 * sweeps.length + 1 + 1));
});

test("a funder holding a lamport fails", async () => {
  fails(await run(mutate("getBalance", D.funder, (r) => ({ ...r, value: 1 }))), /the funder \S+ holds 1 lamports at finalized/);
});

test("a funding whose block time is before the stop fails", async () => {
  const before = Math.floor(Date.parse(D.stopped_at) / 1000) - 1;
  fails(await run(mutate("getTransaction", funding.signature, (r) => ({ ...r, blockTime: before }))), /landed after the stop: block time \d+ >= \d+/);
});

test("a journal whose keys are kept, or with no stop time, fails", async () => {
  fails(await run(A.good, { ...D, keys: { ...D.keys, state: "kept", why: ["the funder holds 5000 lamports"] } }), /the run's keys were removed: kept/);
  fails(await run(A.good, { ...D, stopped_at: undefined }), /the journal says when the stop came/);
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

// ---- card pool-sol-deploy-after-run F4: the steps line drops a whole address only, wherever it stands ----
test("F4 a: a journal-built sweep record whose dust step names its 43-character payer in brackets passes the money gate's reader", async () => {
  const { parseLive } = await import("../ci/money-gate.mjs");
  const { runRecord } = await import("./pool-sol-deploy-sweep.mjs");
  const payer = "jvfZAHpyRS6jSqmP9pUHmbtUtPj2nPtRYvHKcFgNTMi"; // 43 characters, a NEAR hash's shape
  assert.equal(payer.length, 43);
  const dust = { step: `another payer's transaction naming the funder (${payer}): not a funding`, signature: "3qRUcXSY" + "1".repeat(80), state: "landed" };
  const md = runRecord({ ...D, txs: [...D.txs, dust] }, A.rpcs);
  const r = parseLive(md, "pool-sol-deploy-sweep");
  assert.deepEqual(r.problems, [], md);
  assert.ok(!md.includes(payer), "the payer is not on the steps line");
});

test("F4 b: a step that carries an 88-character signature keeps it whole on the steps line, so the gate reads it: an unlisted one is refused, a listed one passes", async () => {
  const { parseLive } = await import("../ci/money-gate.mjs");
  const { runRecord } = await import("./pool-sol-deploy-sweep.mjs");
  const { stepsOf } = await import("./pool-sol-deploy.mjs");
  const other = "4".repeat(44) + "5".repeat(44);
  assert.equal(stepsOf([{ step: `x ${other}` }]), `x ${other}`);
  const md = runRecord({ ...D, txs: [...D.txs, { step: `x ${other}`, signature: sweeps[0].signature, state: "landed" }] }, A.rpcs);
  assert.ok(parseLive(md, "pool-sol-deploy-sweep").problems.some((p) => p.includes(other)), md);
  const listed = runRecord({ ...D, txs: [...D.txs, { step: `x ${other}`, signature: other, state: "landed" }] }, A.rpcs);
  assert.deepEqual(parseLive(listed, "pool-sol-deploy-sweep").problems, [], listed);
  // an address at the end of a label or after "(" goes
  assert.equal(stepsOf([{ step: `to ${"A".repeat(44)}` }, { step: `(${"B".repeat(32)})` }]), "to, ()");
});
