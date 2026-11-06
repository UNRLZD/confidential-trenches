// Replays evm-fee-collector.answers.json through the live check: the recorded good answers (the deployed collectors on
// Base Sepolia and Robinhood testnet, each read on two RPCs of two operators, with no sell listed yet) pass; the same
// recording with one thing changed fails: the collector's code, its immutable holding another sink, a record whose
// sink is not the kit's pinned sell sender, an owner() that answers, a run key that kept money, another chain id. The
// sell side replays the answers' sellFixture (constructed, one sell per chain, until card evm-testnet-delegate-review3
// lists real ones): it passes as it is, and fails with no Paid, a Paid from another address or another contract,
// under the fee, two Paid, a failed sell, and a sell that is not W's type 4 transaction.
//   node --test scripts/live-checks/evm-fee-collector.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PAID, check, checkSells } from "./evm-fee-collector.mjs";
import { CHAINS, DUST, pinnedBuild, selector } from "./pool-evm-deploy.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-fee-collector.answers.json", import.meta.url), "utf8"));
const CHAIN_NAMES = Object.keys(CHAINS);
const lower = (s) => String(s).toLowerCase();
const OTHER = "0x" + "ba".repeat(20);
const word = (a) => "0x" + lower(a).slice(2).padStart(64, "0");

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
const sleep = async () => {};
const run = (chain, answers = A.good[chain], d = A.deployments[chain]) => check({ deployment: d, fetchFn: replay(answers), rpcs: A.rpcs[chain], sleep });
const collectors = Object.fromEntries(CHAIN_NAMES.map((c) => [c, A.deployments[c].contracts.FeeCollector.address]));
const X = A.sellFixture;
const sells = (answers = X.answers, list = X.sells) => checkSells({ sells: list, collectors, fetchFn: replay(answers), rpcsOf: (c) => A.rpcs[c], sleep });
/** the recording `list` with every answer `pick(a)` selects changed by `f(a.json)`, on the first RPC of its chain only */
function mutate(list, pick, f) {
  const out = structuredClone(list);
  const firsts = new Set(CHAIN_NAMES.map((c) => A.rpcs[c][0]));
  let n = 0;
  for (const a of out) if (firsts.has(a.url) && pick(a)) (f(a.json), n++);
  assert.ok(n > 0, "the mutation found its answer");
  return out;
}
const fails = (r, re) => {
  assert.equal(r.ok, false);
  assert.match(r.lines.filter((l) => l.startsWith("FAIL")).join("\n"), re);
};
const at = (chain) => lower(A.deployments[chain].contracts.FeeCollector.address);
const isCode = (addr) => (a) => a.method === "eth_getCode" && lower(a.params[0]) === lower(addr);
const flip = (h, i) => h.slice(0, 2 + 2 * i) + (parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16) ^ 1).toString(16).padStart(2, "0") + h.slice(4 + 2 * i);
const isReceipt = (a) => a.method === "eth_getTransactionReceipt";
const paidLogs = (j) => (j.result?.logs ?? []).filter((l) => lower(l.topics?.[0]) === PAID);

test("the recorded good answers pass: both collectors on both RPCs, no sell listed yet (ok), and the sell fixture", async () => {
  assert.deepEqual(Object.keys(A.deployments).sort(), CHAIN_NAMES.slice().sort());
  for (const chain of CHAIN_NAMES) {
    const r = await run(chain);
    assert.equal(r.ok, true, r.lines.join("\n"));
    for (const u of A.rpcs[chain]) assert.ok(r.lines.some((l) => l.startsWith("ok") && l.endsWith(`chain id ${CHAINS[chain].chainId} is ${chain}'s ${CHAINS[chain].chainId} on ${u}`)), u);
    assert.deepEqual(Object.keys(A.deployments[chain].contracts), ["FeeCollector"]);
    assert.ok(A.deployments[chain].txs.some((t) => t.step.startsWith("sweep")), "the run swept");
    assert.equal(A.deployments[chain].dryRun, false, "a real deploy");
  }
  assert.deepEqual(A.sells, [], "no real sell yet (evm-testnet-delegate-review3 lists the first)");
  const none = await sells(A.good.sells, A.sells);
  assert.equal(none.ok, true, none.lines.join("\n"));
  assert.deepEqual(none.lines, ["ok   0 sells listed"]);
  assert.deepEqual(X.sells.map((s) => s.chain).sort(), CHAIN_NAMES.slice().sort(), "the fixture has one sell per chain");
  const r = await sells();
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const s of X.sells) for (const u of A.rpcs[s.chain]) assert.ok(r.lines.some((l) => l.startsWith("ok") && l.includes(`carries one Paid(W ${lower(s.w)}`) && l.endsWith(`on ${u}: 1 Paid, from ${word(s.w)}, value ${BigInt(s.fee)}`)), u);
});

test("the collector's code changed outside its immutable fails", async () => {
  for (const chain of CHAIN_NAMES) {
    const b = pinnedBuild(chain, "FeeCollector", at(chain));
    const free = [...Array(b.length).keys()].find((i) => b.immutables.every((s) => s.every((x) => i < x || i >= x + 32)));
    fails(await run(chain, mutate(A.good[chain], isCode(at(chain)), (j) => (j.result = flip(j.result, free)))), /FeeCollector \S+ code is the build's/);
  }
});

test("the collector's immutable holding another sink fails, and so does a record whose sink is not the kit's pin", async () => {
  for (const chain of CHAIN_NAMES) {
    const b = pinnedBuild(chain, "FeeCollector", at(chain));
    const i = b.immutables[0][0] + 31; // the sink's last byte, in every place the immutable is
    const other = mutate(A.good[chain], isCode(at(chain)), (j) => {
      for (const s of b.immutables[0]) j.result = flip(j.result, s + 31);
    });
    assert.ok(i < b.length);
    fails(await run(chain, other), /FeeCollector's immutable holds one word, the record's sink/);
    const d = structuredClone(A.deployments[chain]);
    d.contracts.FeeCollector.sink = OTHER;
    fails(await run(chain, A.good[chain], d), /the record's sink 0xbaba\S+ is the sell sender the kit pins/);
  }
});

test("an owner() that answers, a run key that kept money, and another chain id each fail", async () => {
  for (const chain of CHAIN_NAMES) {
    const owner = (a) => a.method === "eth_call" && lower(a.params[0].to) === at(chain) && a.params[0].data === selector("owner()");
    fails(await run(chain, mutate(A.good[chain], owner, (j) => {
      delete j.error;
      j.result = word(OTHER);
    })), /FeeCollector has no owner\(\)/);
    const bal = (a) => a.method === "eth_getBalance";
    fails(await run(chain, mutate(A.good[chain], bal, (j) => (j.result = "0x" + (DUST + 1n).toString(16)))), /deployer \S+ has no code, sent exactly/);
    fails(await run(chain, mutate(A.good[chain], (a) => a.method === "eth_chainId", (j) => (j.result = "0x1"))), /chain id 0x1 is/);
  }
});

test("a Paid from another address, from another contract, under the fee, or none at all fails", async () => {
  fails(await sells(mutate(X.answers, isReceipt, (j) => paidLogs(j).forEach((l) => (l.topics[1] = word(OTHER))))), /carries one Paid\(W/);
  fails(await sells(mutate(X.answers, isReceipt, (j) => paidLogs(j).forEach((l) => (l.address = OTHER)))), /carries one Paid\(W .*: 0 Paid/);
  fails(await sells(mutate(X.answers, isReceipt, (j) => paidLogs(j).forEach((l) => (l.data = word("0x01"))))), /carries one Paid\(W .*value 1$/m);
  fails(await sells(mutate(X.answers, isReceipt, (j) => (j.result.logs = j.result.logs.filter((l) => lower(l.topics?.[0]) !== PAID)))), /0 Paid/);
  // two Paid in one receipt (a second payment beside the sell's) is not the sell's one payment
  fails(await sells(mutate(X.answers, isReceipt, (j) => j.result.logs.push(...paidLogs(j).map((l) => structuredClone(l))))), /2 Paid/);
});

test("a failed sell and a sell that is not W's type 4 transaction each fail", async () => {
  fails(await sells(mutate(X.answers, isReceipt, (j) => (j.result.status = "0x0"))), /succeeded on .*status 0x0/);
  fails(await sells(mutate(X.answers, (a) => a.method === "eth_getTransactionByHash", (j) => (j.result.type = "0x2"))), /is a type 4 transaction to W/);
  fails(await sells(mutate(X.answers, (a) => a.method === "eth_getTransactionByHash", (j) => (j.result.to = OTHER))), /is a type 4 transaction to W/);
  const bigger = X.sells.map((s) => ({ ...s, fee: (BigInt(s.fee) * 1000n).toString() }));
  fails(await sells(X.answers, bigger), /carries one Paid\(W/);
});
