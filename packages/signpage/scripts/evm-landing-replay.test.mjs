// node --test scripts/evm-landing-replay.test.mjs (from packages/signpage): the replay's plan, offline. Every host of a
// record's busiest windows is replayed with its methods as many times as recorded, from the page's own lists; a host in
// none is refused before anything is sent; a send is never replayed as a send, and nothing is read but the pool.
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRead, refused, replayPlan } from "./evm-landing-replay.mjs";

const POOL = "0xaa080e74ec99cf5c684548c77ca145edfcf899cf";
const rec = (windows) => ({ chain: "base", steps: [{ name: "first leaf: a ready proof inside its first minute", hostWindowMax: windows }] });
const LISTS = ["https://base-rpc.publicnode.com", "https://base.api.pocket.network", "https://mainnet.base.org"];

test("every host of the windows, its methods as many times as recorded, on the URL of the page's list", () => {
  const plan = replayPlan(rec({
    "base-rpc.publicnode.com": { n: 4, by: { eth_getBlockByNumber: 2, "eth_call 0xbeb4a9b3": 1, eth_sendRawTransaction: 1 } },
    "mainnet.base.org": { n: 1, by: { eth_getLogs: 1 } },
    "base.api.pocket.network": { n: 0, by: {} },
  }), LISTS);
  assert.deepEqual(plan.map((p) => [p.host, p.url, p.n, p.methods.length]), [
    ["base-rpc.publicnode.com", "https://base-rpc.publicnode.com", 4, 4],
    ["mainnet.base.org", "https://mainnet.base.org", 1, 1],
  ]);
});

test("a host in no list the page reads is refused before anything is sent; a record with no windows too", () => {
  assert.throws(() => replayPlan(rec({ "evil.example": { n: 1, by: { eth_chainId: 1 } } }), LISTS), /evil\.example: in no list/);
  assert.throws(() => replayPlan({ chain: "base", steps: [] }, LISTS), /no hostWindowMax/);
});

test("read-only: a send is a chain id, an eth_call the pool's recorded selector at latest, a log read 100 blocks on the pool", () => {
  assert.deepEqual(asRead("eth_sendRawTransaction", POOL, 1000n), ["eth_chainId", []]);
  assert.deepEqual(asRead("eth_call 0xbeb4a9b3", POOL, 1000n), ["eth_call", [{ to: POOL, data: "0xbeb4a9b3" }, "latest"]]);
  assert.deepEqual(asRead("eth_getLogs", POOL, 1000n), ["eth_getLogs", [{ address: POOL, fromBlock: "0x384", toBlock: "0x3e8" }]]);
  for (const m of ["eth_sendRawTransaction", "eth_sendTransaction", "personal_sign", "?"]) assert.equal(asRead(m, POOL, 1n)[0], "eth_chainId", m);
});

test("a refusal for rate: HTTP 429, a JSON-RPC rate error or -32005; a revert or an archive refusal is not one", () => {
  assert.ok(refused({ status: 429, body: null }));
  assert.ok(refused({ status: 200, body: { error: { code: -32005, message: "x" } } }));
  assert.ok(refused({ status: 200, body: { error: { code: -32000, message: "Too many requests" } } }));
  assert.ok(!refused({ status: 200, body: { error: { code: 3, message: "execution reverted" } } }));
  assert.ok(!refused({ status: 403, body: { error: { code: -32602, message: "Archive requests require a personal token" } } }));
});
