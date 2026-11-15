// Card base-reads-never-starve-max: a held or refused /v1/rpc/base or /v1/rpc/robinhood read names its JSON-RPC method
// and its params' shape (lengths only) in its log lines, so the next live reading names the function that sent it; never
// an address, a block number, a key or the caller's IP.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as rpcModule from "./rpc.ts";
import { createRpc } from "./rpc.ts";
import { providerHolds } from "../limits/limits.ts";

// read off the module, so this file still loads at a base without it and its tests fail on the behaviour (red runs)
const { keyedPaces, rpcShape } = rpcModule as unknown as { keyedPaces?: (env: Record<string, string>) => Record<string, never>; rpcShape?: (r: unknown) => string };

const ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const W = "0x00000000000000000000000071c7656ec7ab88b098defb751b7401b5f6d8976f";
const IP = "198.51.100.7";
const KEYS = { BASE_RPC_URL_QUICKNODE: "https://name-two.base-mainnet.quiknode.test/plantedBASEqn00key123456789abcd/", BASE_RPC_URL_DRPC_1: "https://lb.drpc.test/base/plantedBASEdr00key123456789abcd", ROBINHOOD_RPC_URL_QUICKNODE: "https://name-three.robinhood-mainnet.quiknode.test/plantedRHqn0000key123456789abcd/", ROBINHOOD_RPC_URL_DRPC_1: "https://lb.drpc.test/robinhood/plantedRHdr0000key123456789abcd" };
const LOGS = { jsonrpc: "2.0", id: 9, method: "eth_getLogs", params: [{ address: ADDRESS, topics: [["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], null, [W]], fromBlock: "0x34aad47", toBlock: "0x34aad4a" }] };
const clock = () => {
  const t = { v: performance.timeOrigin + performance.now() };
  return { t, now: () => t.v, sleep: async (ms: number) => void (t.v += ms) };
};

for (const chain of ["base", "robinhood"] as const) {
  for (const keyed of [false, true]) {
    test(`card base-reads-never-starve-max: a ${chain} read${keyed ? " on ?keyed=only" : ""} every provider throttles: each hold line and the refusal name its method and params shape, never an address, a block, a key or the IP`, async () => {
      const lines: string[] = [];
      const fetch = async (): Promise<Response> => new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
      const c = clock();
      const env = Object.fromEntries(Object.entries(KEYS).filter(([k]) => k.startsWith(chain.toUpperCase())));
      const r = createRpc(env, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(env) ?? {}), pinned: { [chain]: ["https://public-spare.test"] }, now: c.now, sleep: c.sleep, log: (l) => lines.push(l) });
      const a = await r.handle(chain, "application/json", JSON.stringify(LOGS), IP, false, keyed);
      assert.equal(a.status, 429, a.body);
      const shape = `${keyed ? "keyed " : ""}eth_getLogs[{address:s42,topics:[[s66],null,[s66]],fromBlock:s9,toBlock:s9}]`;
      const holds = lines.filter((l) => l.startsWith(`rpc hold ${chain} `));
      assert.ok(holds.length > 0, "the providers' holds were logged");
      // the request's own walk names its shape; the helper's own finalized-head read (a keyed log page's) names its own
      for (const l of holds) assert.ok(l.endsWith(` caller 1 s ${shape}`) || (keyed && l.endsWith(" caller 1 s helper eth_getBlockByNumber[s9,b]")), l);
      assert.ok(holds.some((l) => l.endsWith(shape)), "the read's own holds name it");
      assert.equal(a.why, `${chain} every provider held ${shape}`);
      for (const l of [...lines, a.why ?? ""]) {
        for (const secret of [ADDRESS, W.slice(26), "0x34aad47", "0x34aad4a", IP, "planted"]) assert.ok(!l.toLowerCase().includes(secret.toLowerCase()), `${secret} in: ${l}`);
      }
    });
  }
}

test("card base-reads-never-starve-max: rpcShape names a balanceOf eth_call, a block read and a batch by kinds and lengths alone, held to RPC_SHAPE_MAX against a hostile body", () => {
  assert.equal(typeof rpcShape, "function", "rpcShape is exported");
  const shape = rpcShape!;
  assert.equal(shape({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: ADDRESS, data: `0x70a08231${W.slice(2)}` }, { blockHash: `0x${"ab".repeat(32)}` }] }), "eth_call[{to:s42,data:s74},{blockHash:s66}]");
  assert.equal(shape({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }), "eth_getBlockByNumber[s6,b]");
  assert.equal(shape({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" }), "eth_blockNumber");
  assert.equal(shape([{ method: "eth_chainId", params: [] }, { method: "eth_blockNumber", params: [] }]), "batch2 eth_chainId[] eth_blockNumber[]");
  // a hostile key or a deep or long body: no key text that is no plain name, three levels, RPC_SHAPE_MAX characters
  const hostile = shape({ method: "eth_call", params: [{ "198.51.100.7": 1, [ADDRESS]: 2, a: [[[[[1]]]]] }, ...Array.from({ length: 50 }, () => ({ x: "y".repeat(9) }))] });
  assert.ok(!hostile.includes("198.51") && !hostile.includes(ADDRESS), hostile);
  assert.ok(hostile.startsWith("eth_call[{?:n,?:n,a:[[…]]}"), hostile);
  assert.ok(hostile.length <= 200, String(hostile.length));
});
