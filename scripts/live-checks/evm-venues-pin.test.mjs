// Replays evm-venues-pin.answers.json (a real run on the money gate's RPCs, 2026-11-03) through the live check: the
// recorded good answers pass on both testnets; the same recording with one thing changed fails: a pin's code with one
// byte flipped, a pin that differs between the two RPCs, a router or WETH with other code, another chain id, a kit
// pin that is not the record's, and two RPCs of one operator.
//   node --test scripts/live-checks/evm-venues-pin.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { check, deployed } from "./evm-venues-pin.mjs";
import { CHAINS } from "./pool-evm-deploy.mjs";

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
    assert.equal(r.lines.filter((l) => / is the build's /.test(l)).length, chain === "base-sepolia" ? 4 : 3, chain);
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
  fails(await run(b, { venue: { ...v, pool: other } }), /the pool pin 0x0+bad0/);
  fails(await run(b, { venue: { ...v, adapters: { v4: v.adapters.v4 } } }), /the v3 adapter pin \(none\)/);
  fails(await run(b, { venue: { ...v, routers: [other] } }), /the routers/);
  fails(await run("robinhood-testnet", { venue: { ...evmPoolVenues()["robinhood-testnet"], adapters: { v3: other, v4: evmPoolVenues()["robinhood-testnet"].adapters.v4 } } }), /the v3 adapter pin 0x0+bad0 is the record's UniswapV3Adapter \(none\)/);
  fails(await run(b, { rpcs: [u1, u1] }), /operator/);
});
