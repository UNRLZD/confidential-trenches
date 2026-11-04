// Replays evm-venues-pin.answers.json (a real run on the money gate's RPCs, re-recorded 2026-11-04 for card
// evm-selldelegate-exact-debit) through the live check: the recorded good answers pass on both testnets; the same recording with one
// thing changed fails: a pin's code with one byte flipped, a pin that differs between the two RPCs, a router or WETH
// with other code, another chain id, a kit pin that is not the record's (the sell delegate's record is the
// newest redeploy's, card evm-selldelegate-exact-debit's; the PoolManager is pool-evm-deploy's CHAINS one), and two RPCs of one operator.
//   node --test scripts/live-checks/evm-venues-pin.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { check, deployed } from "./evm-venues-pin.mjs";
import { CHAINS, EIP1967, pinnedBuild } from "./pool-evm-deploy.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-venues-pin.answers.json", import.meta.url), "utf8"));
const RECORD = Object.fromEntries(deployed());

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
const run = (chain, { answers = A.good, venue = evmPoolVenues()[chain], rpcs = CHAINS[chain].rpcs } = {}) =>
  check({ chain, venue, deployment: RECORD[chain], fetchFn: replay(answers), rpcs, sleep: async () => {} });
const lower = (s) => String(s).toLowerCase();
/** the recording with every answer `pick(a)` selects changed by `f(a.json)`, on the RPCs `urls` */
function mutate(urls, pick, f) {
  const out = structuredClone(A.good);
  let n = 0;
  for (const a of out) if ([urls].flat().includes(a.url) && pick(a)) (f(a.json), n++);
  assert.ok(n > 0, "the mutation found its answer");
  return out;
}
const isCode = (addr) => (a) => a.method === "eth_getCode" && lower(a.params[0]) === lower(addr);
const flip = (h, at) => h.slice(0, 2 + 2 * at) + (parseInt(h.slice(2 + 2 * at, 4 + 2 * at), 16) ^ 1).toString(16).padStart(2, "0") + h.slice(4 + 2 * at);
const fails = (r, re) => {
  assert.equal(r.ok, false);
  assert.match(r.lines.filter((l) => l.startsWith("FAIL")).join("\n"), re);
};

test("the recorded good answers pass on both testnets: every pin is the record's and holds the build's code on both RPCs", async () => {
  assert.deepEqual(A.chains, ["base-sepolia", "robinhood-testnet"]);
  assert.deepEqual(Object.keys(RECORD), A.chains);
  for (const chain of A.chains) {
    const r = await run(chain);
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.equal(r.lines.filter((l) => / is the build's /.test(l)).length, chain === "base-sepolia" ? 5 : 4, chain); // the pins and the verifier
  }
});

test("a pin's code with one byte flipped, or other code on one RPC, fails", async () => {
  for (const chain of A.chains) {
    const [u1, u2] = CHAINS[chain].rpcs;
    for (const pin of [evmPoolVenues()[chain].pool, evmPoolVenues()[chain].sellDelegate, evmPoolVenues()[chain].adapters.v4]) {
      fails(await run(chain, { answers: mutate([u1, u2], isCode(pin), (j) => (j.result = flip(j.result, 200))) }), /is the build's/);
      fails(await run(chain, { answers: mutate(u1, isCode(pin), (j) => (j.result = flip(j.result, 200))) }), /the same code on both RPCs/);
      fails(await run(chain, { answers: mutate([u1, u2], isCode(pin), (j) => (j.result = "0x")) }), /the same code on both RPCs/);
    }
  }
});

test("WETH or the router with other code, another chain id, a kit pin that is not the record's, or one operator fails", async () => {
  const b = "base-sepolia";
  const [u1, u2] = CHAINS[b].rpcs;
  fails(await run(b, { answers: mutate(u1, isCode(CHAINS[b].router.address), (j) => (j.result = flip(j.result, 10))) }), /the router/);
  fails(await run(b, { answers: mutate(u2, isCode(CHAINS[b].weth.address), (j) => (j.result = flip(j.result, 10))) }), /WETH/);
  fails(await run(b, { answers: mutate(u1, (a) => a.method === "eth_chainId", (j) => (j.result = "0x2105")) }), /chain id 0x2105/);
  const v = evmPoolVenues()[b];
  const other = "0x000000000000000000000000000000000000bad0";
  fails(await run(b, { venue: { ...v, sellDelegate: other } }), /the sell delegate pin 0x0+bad0/);
  // the v1 delegate (pool-evm-deploy's record), which sells through no PoolManager, is no longer the pin (card evm-sell-v4-kit)
  fails(await run(b, { venue: { ...v, sellDelegate: "0x23ad5aabcc139650597f8dc79e9def8bd817ef88" } }), /the sell delegate pin 0x23ad\w+ is the record's SellDelegate 0xe39f/);
  // nor the evm-sell-v4 delegate, which has no exact-debit check (card evm-selldelegate-exact-debit)
  fails(await run(b, { venue: { ...v, sellDelegate: "0xfa1442419b6984b8e3aa8933c690f80f063b6adf" } }), /the sell delegate pin 0xfa14\w+ is the record's SellDelegate 0xe39f/);
  fails(await run(b, { venue: { ...v, poolManager: other } }), /the PoolManager 0x0+bad0 is pool-evm-deploy's/);
  fails(await run(b, { venue: { ...v, poolManager: undefined } }), /the PoolManager \(none\) is pool-evm-deploy's/);
  fails(await run(b, { venue: { ...v, pool: other } }), /the pool pin 0x0+bad0/);
  fails(await run(b, { venue: { ...v, adapters: { v4: v.adapters.v4 } } }), /the v3 adapter pin \(none\)/);
  fails(await run(b, { venue: { ...v, routers: [other] } }), /the routers/);
  fails(await run("robinhood-testnet", { venue: { ...evmPoolVenues()["robinhood-testnet"], adapters: { v3: other, v4: evmPoolVenues()["robinhood-testnet"].adapters.v4 } } }), /the v3 adapter pin 0x0+bad0 is the record's UniswapV3Adapter \(none\)/);
  fails(await run(b, { rpcs: [u1, u1] }), /operator/);
});

// the review of c473b3d: the build's code with other immutables, consistent on both RPCs, must fail
const HOSTILE = "000000000000000000000000" + "ba".repeat(20);
const word = (a) => "000000000000000000000000" + lower(a).slice(2);
/** the recording with the immutable of `name` at `pin` on `chain` (its build: pinnedBuild) that holds `from` rewritten
 * to HOSTILE, on both RPCs */
function swapImmutable(chain, pin, name, from) {
  const out = structuredClone(A.good);
  let n = 0;
  for (const a of out) {
    if (a.method !== "eth_getCode" || lower(a.params[0]) !== lower(pin)) continue;
    let h = a.json.result.slice(2);
    const starts = pinnedBuild(chain, name, pin).immutables.find((g) => h.slice(2 * g[0], 2 * g[0] + 64) === from);
    assert.ok(starts, `${name} holds ${from}`);
    for (const s of starts) h = h.slice(0, 2 * s) + HOSTILE + h.slice(2 * s + 64);
    a.json.result = "0x" + h;
    n++;
  }
  assert.equal(n, 2, "both RPCs");
  return out;
}

test("a pin with the build's code but other immutables fails: the pool's verifier, the v3 adapter's router, the delegate's WETH", async () => {
  const chain = "base-sepolia";
  const v = evmPoolVenues()[chain];
  const d = RECORD[chain];
  for (const [pin, name, from, re] of [
    [v.pool, "PrivacyPoolSimple", word(d.contracts.WithdrawalVerifier.address), /PrivacyPoolSimple's immutables/],
    [v.adapters.v3, "UniswapV3Adapter", word(CHAINS[chain].router.address), /UniswapV3Adapter's immutables/],
    [v.sellDelegate, "SellDelegate", word(CHAINS[chain].weth.address), /SellDelegate's immutables/],
  ]) fails(await run(chain, { answers: swapImmutable(chain, pin, name, from) }), re);
});

test("the pool's verifier, the PoolManager or Robinhood testnet WETH's implementation with other code, or another WETH implementation, fails", async () => {
  for (const chain of A.chains) {
    const [u1] = CHAINS[chain].rpcs;
    fails(await run(chain, { answers: mutate(u1, isCode(RECORD[chain].contracts.WithdrawalVerifier.address), (j) => (j.result = flip(j.result, 100))) }), /WithdrawalVerifier/);
    fails(await run(chain, { answers: mutate(u1, isCode(CHAINS[chain].poolManager.address), (j) => (j.result = flip(j.result, 100))) }), /PoolManager/);
  }
  const r = "robinhood-testnet";
  const [u1, u2] = CHAINS[r].rpcs;
  fails(await run(r, { answers: mutate(u2, isCode(CHAINS[r].weth.implementation.address), (j) => (j.result = flip(j.result, 100))) }), /WETH's implementation/);
  fails(await run(r, { answers: mutate([u1, u2], (a) => a.method === "eth_getStorageAt" && lower(a.params[0]) === lower(CHAINS[r].weth.address), (j) => (j.result = "0x" + word("0x" + "ba".repeat(20)))) }), /implementation slot/);
});

test("a middle listed on a testnet fails", async () => {
  for (const chain of A.chains) fails(await run(chain, { venue: { ...evmPoolVenues()[chain], middles: ["0x000000000000000000000000000000000000bad0"] } }), /middle/);
});

test("one RPC's stale head does not hide a WETH upgrade: the implementation slot is read at latest (the review of ccee09a)", async () => {
  const chain = "robinhood-testnet";
  const [u1, u2] = CHAINS[chain].rpcs;
  const W = CHAINS[chain].weth;
  const answers = structuredClone(A.good);
  const heads = [u1, u2].map((u) => BigInt(answers.find((a) => a.url === u && a.method === "eth_blockNumber").json.result));
  const agreed = "0x" + (heads[0] < heads[1] ? heads[0] : heads[1]).toString(16);
  const stale = "0x" + ((heads[0] < heads[1] ? heads[0] : heads[1]) - 9000n).toString(16);
  const isSlot = (a) => a.method === "eth_getStorageAt" && lower(a.params[0]) === lower(W.address);
  const implCode = answers.find((a) => a.method === "eth_getCode" && lower(a.params[0]) === lower(W.implementation.address)).json.result;
  for (const a of answers) {
    if (a.url === u2 && a.method === "eth_blockNumber") a.json.result = stale; // one RPC's stale head sets the agreed block
    if (Array.isArray(a.params) && a.params.at(-1) === agreed) a.params[a.params.length - 1] = stale;
    if (isSlot(a)) a.json.result = "0x" + word("0x" + "ba".repeat(20)); // the proxy upgraded since that block
  }
  for (const u of [u1, u2]) {
    // that block, from history: the pinned implementation still
    answers.push({ url: u, method: "eth_getStorageAt", params: [W.address, EIP1967.implementation, stale], status: 200, json: { jsonrpc: "2.0", id: 1, result: "0x" + word(W.implementation.address) } });
    answers.push({ url: u, method: "eth_getCode", params: [W.implementation.address, stale], status: 200, json: { jsonrpc: "2.0", id: 1, result: implCode } });
  }
  fails(await run(chain, { answers }), /implementation slot/);
});
