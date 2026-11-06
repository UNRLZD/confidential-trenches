// Replays pool-evm-deploy-resume-safe.answers.json (the testnet deploys, read on both RPCs of each chain) through the
// live check: the recorded good answers pass; the same recording with one thing changed fails: a run key that kept more
// than DUST, a record whose contract is made by two deploys (paid twice), an RPC whose head block is behind the
// record's last transaction, a contract address with no code, and a transaction more than the record lists.
//   node --test scripts/live-checks/pool-evm-deploy-resume-safe.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DUST } from "./pool-evm-deploy.mjs";
import { check } from "./pool-evm-deploy-resume-safe.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-evm-deploy-resume-safe.answers.json", import.meta.url), "utf8"));
const CHAINS = Object.keys(A.deployments);

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
const run = (chain, answers = A.good[chain], d = A.deployments[chain]) => check({ deployment: d, fetchFn: replay(answers), rpcs: A.rpcs[chain], sleep: async () => {} });
/** the chain's recording with each answer `pick(a)` selects, on the second RPC, given `f(a.json)` */
function mutate(chain, pick, f) {
  const out = structuredClone(A.good[chain]);
  let n = 0;
  for (const a of out) if (a.url === A.rpcs[chain][1] && pick(a)) (f(a.json), n++);
  assert.ok(n > 0, "the mutation found its answer");
  return out;
}
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.match(r.lines.filter((l) => l.startsWith("FAIL")).join("\n"), re);
};

test("the recorded good answers pass on both chains, every read on both RPCs at a head block", async () => {
  assert.deepEqual(CHAINS.sort(), ["base-sepolia", "robinhood-testnet"]);
  for (const chain of CHAINS) {
    const r = await run(chain);
    assert.equal(r.ok, true, r.lines.join("\n"));
    for (const u of A.rpcs[chain]) assert.ok(r.lines.some((l) => /^ok {3}run key .* keeps at most \d+ wei at block \d+ on /.test(l) && l.includes(u)), u);
  }
});

test("a run key holding more than DUST on one RPC fails", async () => {
  for (const chain of CHAINS) fails(await run(chain, mutate(chain, (a) => a.method === "eth_getBalance", (j) => (j.result = "0x" + (DUST + 1n).toString(16)))), /keeps at most .* wei/);
});

test("a contract made by two deploys (paid twice) fails, as does a key that sent one more transaction than the record", async () => {
  for (const chain of CHAINS) {
    const d = structuredClone(A.deployments[chain]);
    d.txs.splice(1, 0, { ...d.txs[0] });
    const r = await check({ deployment: d, fetchFn: async (u, init) => replay(A.good[chain].concat(A.good[chain]))(u, init), rpcs: A.rpcs[chain], sleep: async () => {} });
    fails(r, /WithdrawalVerifier is made by exactly one deploy of the record: 2/);
    fails(await run(chain, mutate(chain, (a) => a.method === "eth_getTransactionCount", (j) => (j.result = "0x" + (BigInt(j.result) + 1n).toString(16)))), /sent exactly the record's/);
  }
});

test("an RPC whose head block is behind the record's last transaction fails, as does a contract address with no code", async () => {
  for (const chain of CHAINS) {
    fails(await run(chain, mutate(chain, (a) => a.method === "eth_blockNumber", (j) => (j.result = "0x1"))), /head block 1 is at or past/);
    fails(await run(chain, mutate(chain, (a) => a.method === "eth_getCode", (j) => (j.result = "0x"))), /holds code at block/);
  }
});
