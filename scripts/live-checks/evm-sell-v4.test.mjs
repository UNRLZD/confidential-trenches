// Replays evm-sell-v4.answers.json through the live check: the recorded good answers (until the real redeploy, the dry
// run on anvil forks of Base Sepolia and Robinhood testnet, each read on two loopback URLs; its note gives the
// re-record command) pass; the same recording with one thing changed fails: the v1 delegate's code, POOL_MANAGER()
// or WETH() answering another address, an immutable holding another PoolManager, an EIP-1967 slot set, an owner()
// that answers, a PoolManager with other code, a failed deploy or one that made another address, a run key that kept
// money or sent one more transaction, another chain id, and a record naming more than the delegate.
//   node --test scripts/live-checks/evm-sell-v4.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check, runRecord } from "./evm-sell-v4.mjs";
import { BUILD, CHAINS, DUST, EIP1967, runtimeOf, selector } from "./pool-evm-deploy.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-sell-v4.answers.json", import.meta.url), "utf8"));
const CHAIN_NAMES = Object.keys(CHAINS);

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
const run = (chain, answers = A.good[chain], d = A.deployments[chain]) =>
  check({ deployment: d, fetchFn: replay(answers), rpcs: A.rpcs[chain], sleep: async () => {} });
/** the chain's recording with every answer `pick(a)` selects changed by `f(a.json)`, on the first RPC only */
function mutate(chain, pick, f) {
  const out = structuredClone(A.good[chain]);
  let n = 0;
  for (const a of out) if (a.url === A.rpcs[chain][0] && pick(a)) (f(a.json), n++);
  assert.ok(n > 0, "the mutation found its answer");
  return out;
}
const fails = (r, re) => {
  assert.equal(r.ok, false);
  assert.match(r.lines.filter((l) => l.startsWith("FAIL")).join("\n"), re);
};
const lower = (s) => String(s).toLowerCase();
const del = (chain) => A.deployments[chain].contracts.SellDelegate.address;
const isCall = (to, sig) => (a) => a.method === "eth_call" && lower(a.params[0].to) === lower(to) && a.params[0].data === selector(sig);
const isCode = (addr) => (a) => a.method === "eth_getCode" && lower(a.params[0]) === lower(addr);
const flip = (h, at) => h.slice(0, 2 + 2 * at) + (parseInt(h.slice(2 + 2 * at, 4 + 2 * at), 16) ^ 1).toString(16).padStart(2, "0") + h.slice(4 + 2 * at);
const OTHER = "0x" + "00".repeat(12) + "ba".repeat(20);

test("the recorded good answers pass on both chains, every read on both RPCs", async () => {
  assert.deepEqual(Object.keys(A.deployments).sort(), CHAIN_NAMES.slice().sort());
  for (const chain of CHAIN_NAMES) {
    const d = A.deployments[chain];
    const r = await run(chain);
    assert.equal(r.ok, true, r.lines.join("\n"));
    for (const u of A.rpcs[chain]) assert.ok(r.lines.some((l) => l.endsWith(`chain id ${CHAINS[chain].chainId} is ${chain}'s ${CHAINS[chain].chainId} on ${u}`)), u);
    assert.deepEqual(Object.keys(d.contracts), ["SellDelegate"]);
    assert.ok(r.lines.some((l) => l.includes(`SellDelegate.POOL_MANAGER() returns 0x000000000000000000000000${CHAINS[chain].poolManager.address.slice(2)}`)), chain);
    assert.ok(d.txs.some((t) => t.step.startsWith("sweep")), "the run swept");
  }
});

test("the v1 delegate's code fails: this check takes only the build pinned to the address, never the v1 one", async () => {
  // the v1 delegate as deployed on Base Sepolia, read on both RPCs (sell-delegate-v1.code.json)
  const V = JSON.parse(readFileSync(new URL("./sell-delegate-v1.code.json", import.meta.url), "utf8"));
  const f = BUILD.frozen.SellDelegate;
  assert.equal(lower(V.address), f.at["base-sepolia"]);
  const v1 = V.code;
  const r1 = runtimeOf(v1, f.immutables);
  assert.equal(r1.masked, f.masked, "the recorded code is the frozen v1 build");
  for (const chain of CHAIN_NAMES) fails(await run(chain, mutate(chain, isCode(del(chain)), (j) => (j.result = v1))), /SellDelegate \S+ code is the build pinned to it: 4119 bytes/);
});

test("POOL_MANAGER() or WETH() answering another address fails", async () => {
  for (const chain of CHAIN_NAMES) {
    fails(await run(chain, mutate(chain, isCall(del(chain), "POOL_MANAGER()"), (j) => (j.result = OTHER))), /SellDelegate.POOL_MANAGER\(\) returns/);
    fails(await run(chain, mutate(chain, isCall(del(chain), "WETH()"), (j) => (j.result = OTHER))), /SellDelegate.WETH\(\) returns/);
  }
});

test("the build's code with its PoolManager immutable set to another address fails, though the zeroed code agrees", async () => {
  const chain = "base-sepolia";
  const pm = CHAINS[chain].poolManager.address.slice(2);
  const starts = BUILD.contracts.SellDelegate.immutables.find((g) => A.good[chain].find(isCode(del(chain))).json.result.slice(2 + 2 * g[0], 2 + 2 * g[0] + 64).endsWith(pm));
  assert.ok(starts, "the PoolManager's immutable");
  const swapped = mutate(chain, isCode(del(chain)), (j) => {
    for (const s of starts) j.result = j.result.slice(0, 2 + 2 * s) + OTHER.slice(2) + j.result.slice(2 + 2 * s + 64);
  });
  fails(await run(chain, swapped), /SellDelegate's 2 immutables each hold one word, the chain's WETH and PoolManager/);
  // one place of it only: the immutable holds two words
  fails(await run(chain, mutate(chain, isCode(del(chain)), (j) => (j.result = flip(j.result, starts[1] + 31)))), /immutables each hold one word.*2 words/);
});

test("other code bytes, an EIP-1967 slot set, an owner() that answers, a PoolManager with other code fail", async () => {
  const chain = "robinhood-testnet";
  fails(await run(chain, mutate(chain, isCode(del(chain)), (j) => (j.result = flip(j.result, 10)))), /code is the build pinned to it/);
  fails(await run(chain, mutate(chain, (a) => a.method === "eth_getStorageAt" && lower(a.params[0]) === lower(del(chain)) && a.params[1] === EIP1967.implementation, (j) => (j.result = "0x" + "11".repeat(32)))), /EIP-1967 implementation slot is 0/);
  fails(await run(chain, mutate(chain, isCall(del(chain), "owner()"), (j) => (delete j.error, (j.result = OTHER)))), /SellDelegate has no owner\(\)/);
  fails(await run(chain, mutate(chain, isCode(CHAINS[chain].poolManager.address), (j) => (j.result = flip(j.result, 5)))), /PoolManager \S+ code hash/);
});

test("a failed deploy, or one that made another address, fails; so does a run key that kept money or sent one more", async () => {
  const chain = "base-sepolia";
  const tx = A.deployments[chain].txs.find((t) => t.contract === "SellDelegate").hash;
  const isTx = (a) => a.method === "eth_getTransactionReceipt" && a.params[0] === tx;
  fails(await run(chain, mutate(chain, isTx, (j) => (j.result.status = "0x0"))), /deploy SellDelegate \S+ succeeded.*status 0x0/);
  fails(await run(chain, mutate(chain, isTx, (j) => (j.result.contractAddress = "0x" + "12".repeat(20)))), /made SellDelegate/);
  const key = A.deployments[chain].deployer;
  fails(await run(chain, mutate(chain, (a) => a.method === "eth_getBalance" && lower(a.params[0]) === key, (j) => (j.result = "0x" + (DUST + 1n).toString(16)))), /keeps at most 10000000000000 wei/);
  fails(await run(chain, mutate(chain, (a) => a.method === "eth_getTransactionCount" && lower(a.params[0]) === key, (j) => (j.result = "0x" + (BigInt(j.result) + 1n).toString(16)))), /sent exactly the record's/);
});

test("another chain id fails, a record naming more than the delegate fails, and a dry-run record read off loopback fails", async () => {
  fails(await run("base-sepolia", mutate("base-sepolia", (a) => a.method === "eth_chainId", (j) => (j.result = "0x2105"))), /chain id 0x2105 is base-sepolia's/);
  const d = structuredClone(A.deployments["robinhood-testnet"]);
  d.contracts.UniswapV4Adapter = { address: "0x" + "34".repeat(20) };
  fails(await run("robinhood-testnet", undefined, d), /names SellDelegate alone/);
  if (A.deployments["base-sepolia"].dryRun) {
    const r = await check({ deployment: A.deployments["base-sepolia"], fetchFn: replay([]), rpcs: CHAINS["base-sepolia"].rpcs, sleep: async () => {} });
    fails(r, /dry-run record read on a non-loopback RPC/);
  }
});

test("the run record lists every transaction of each real redeploy as money-path Tx lines, and refuses a dry run", () => {
  const real = Object.values(A.deployments).map((d) => ({ ...d, dryRun: false }));
  const text = runRecord(real);
  const lines = text.split("\n");
  assert.equal(lines[1], "Money path: yes");
  assert.deepEqual(lines.filter((l) => l.startsWith("Tx: ")), real.flatMap((d) => d.txs.map((t) => `Tx: ${d.chain} ${t.hash}`)));
  assert.ok(real.every((d) => text.includes(d.contracts.SellDelegate.address)));
  assert.throws(() => runRecord(real.map((d) => ({ ...d, dryRun: true }))), /dry run/);
});
