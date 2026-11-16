// node --test apps/helper/src/rpc/keyed-chainid.test.ts (card base-reads-never-throttled): a keyed read of an EVM
// chain's id is answered from the chain's constant and never sent. Live 16 Nov 15:1xZ, dRPC's free plan refused Base's
// keyed eth_chainId 22 times in 9 min (helper.sh docker logs, `rpc hold base drpc.live caller 1 s`), each read a call
// of the one dRPC bucket the pool reads need. The URLs are made up, the keys planted strings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRpc } from "./rpc.ts";

const DR = "https://lb.drpc.test/base/plantedBASEdr1key123456789abcd";
const RH = "https://lb.drpc.test/robinhood/plantedRHdr1key123456789abcd";
const ENV: Record<string, string> = { BASE_RPC_URL_DRPC_1: DR, ROBINHOOD_RPC_URL_DRPC_1: RH };

function world() {
  const sent: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    sent.push(String(init.body));
    const reqs = [JSON.parse(String(init.body))].flat() as { id: unknown; method: string }[];
    const out = reqs.map((r) => ({ jsonrpc: "2.0", id: r.id, result: r.method === "eth_chainId" ? (url === DR ? "0x2105" : "0x1237") : "0x10" }));
    return new Response(JSON.stringify(Array.isArray(JSON.parse(String(init.body))) ? out : out[0]), { status: 200, headers: { "content-type": "application/json" } });
  };
  const r = createRpc(ENV, { fetch: fetch as never, log: () => {} });
  return { r, sent };
}
const call = (id: unknown, method = "eth_chainId") => ({ jsonrpc: "2.0", id, method, params: [] });

test("a keyed eth_chainId is the chain's constant, its id kept, and nothing is sent", async () => {
  const w = world();
  const base = await w.r.handle("base", "application/json", JSON.stringify(call(7)), "203.0.113.9", false, true);
  assert.equal(base.status, 200);
  assert.deepEqual(JSON.parse(base.body), { jsonrpc: "2.0", id: 7, result: "0x2105" });
  const rh = await w.r.handle("robinhood", "application/json", JSON.stringify(call("a")), "203.0.113.9", false, true);
  assert.deepEqual(JSON.parse(rh.body), { jsonrpc: "2.0", id: "a", result: "0x1237" });
  const batch = await w.r.handle("base", "application/json", JSON.stringify([call(1), call(2)]), "203.0.113.9", false, true);
  assert.deepEqual(JSON.parse(batch.body), [{ jsonrpc: "2.0", id: 1, result: "0x2105" }, { jsonrpc: "2.0", id: 2, result: "0x2105" }]);
  assert.equal(w.sent.length, 0, `sent ${w.sent.length} reads to dRPC`);
});

test("a batch with any other method is sent as before", async () => {
  const w = world();
  const a = await w.r.handle("base", "application/json", JSON.stringify([call(1), call(2, "eth_blockNumber")]), "203.0.113.9", false, true);
  assert.equal(a.status, 200);
  assert.equal(w.sent.length, 1);
});
