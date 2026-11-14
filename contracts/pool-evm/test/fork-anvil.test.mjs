// node --test contracts/pool-evm/test/fork-anvil.test.mjs: a fork run's block at or before the fork's block is read from
// the fork's URL, never anvil (whose 1.7.1 deadlocks on it under a cache write); every other request reaches anvil as sent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { anvilFetch } from "./fork-anvil.mjs";

const ANVIL = "http://127.0.0.1:48671";
const FORK = "http://127.0.0.1:47571/base";
const AT = 0x3601af0;

// a fake fetch: anvil answers its node info and each call by name; the fork's URL answers each call by name, marked
const fake = (info = { forkConfig: { forkUrl: FORK, forkBlockNumber: AT } }) => {
  const sent = [];
  const answer = (url, c) => (c.method === "anvil_nodeInfo" ? { jsonrpc: "2.0", id: c.id, result: info } : { jsonrpc: "2.0", id: c.id, result: `${url === FORK ? "fork" : "anvil"}:${c.method}:${c.params?.[0] ?? ""}` });
  const realFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, body });
    const out = Array.isArray(body) ? body.map((c) => answer(url, c)) : answer(url, body);
    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
  };
  return { sent, realFetch };
};
const call = (id, method, params = []) => ({ jsonrpc: "2.0", id, method, params });
const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const hex = (n) => `0x${n.toString(16)}`;

test("a block at or before the fork's block is read from the fork's URL; a later one, a tag, or any other method from anvil; a batch is split and answered in its order", async () => {
  const { sent, realFetch } = fake();
  const f = anvilFetch(realFetch, ANVIL);
  assert.equal((await (await f(post(call(1, "eth_getBlockByNumber", [hex(AT), true])))).json()).result, `fork:eth_getBlockByNumber:${hex(AT)}`);
  assert.equal((await (await f(post(call(2, "eth_getBlockByNumber", [hex(AT - 9), false])))).json()).result, `fork:eth_getBlockByNumber:${hex(AT - 9)}`);
  assert.equal((await (await f(post(call(3, "eth_getBlockByNumber", [hex(AT + 1), false])))).json()).result, `anvil:eth_getBlockByNumber:${hex(AT + 1)}`);
  assert.equal((await (await f(post(call(4, "eth_getBlockByNumber", ["latest", false])))).json()).result, "anvil:eth_getBlockByNumber:latest");
  assert.equal((await (await f(post(call(5, "eth_getLogs", [{ fromBlock: hex(1), toBlock: hex(2) }])))).json()).result, "anvil:eth_getLogs:[object Object]");
  const batch = [call(6, "eth_call", ["x"]), call(7, "eth_getBlockByNumber", [hex(AT - 1), false]), call(8, "eth_getBlockByNumber", ["finalized", false])];
  assert.deepEqual(
    (await (await f(post(batch))).json()).map((x) => x.result),
    ["anvil:eth_call:x", `fork:eth_getBlockByNumber:${hex(AT - 1)}`, "anvil:eth_getBlockByNumber:finalized"],
  );
  // node info read once
  assert.equal(sent.filter((s) => !Array.isArray(s.body) && s.body.method === "anvil_nodeInfo").length, 1);
});

test("with no fork in anvil's node info, or a body that is not JSON, every request reaches anvil as sent", async () => {
  const { realFetch } = fake({});
  const f = anvilFetch(realFetch, ANVIL);
  assert.equal((await (await f(post(call(1, "eth_getBlockByNumber", [hex(AT), true])))).json()).result, `anvil:eth_getBlockByNumber:${hex(AT)}`);
  const seen = [];
  const g = anvilFetch(async (url, init) => (seen.push([url, init.body]), new Response("{}")), ANVIL);
  await g({ method: "POST", body: "not json" });
  assert.deepEqual(seen, [[ANVIL, "not json"]]);
});

test("a node info read that fails (anvil not up yet) fails that request and is read again at the next", async () => {
  const { realFetch } = fake();
  let down = true;
  const f = anvilFetch(async (url, init) => {
    if (down) throw new TypeError("fetch failed");
    return realFetch(url, init);
  }, ANVIL);
  await assert.rejects(f(post(call(1, "eth_getBlockByNumber", [hex(AT), false]))));
  down = false;
  assert.equal((await (await f(post(call(2, "eth_getBlockByNumber", [hex(AT), false])))).json()).result, `fork:eth_getBlockByNumber:${hex(AT)}`);
});
