// node --test apps/helper/src/rpc/index-allowance.test.ts (card helper-robinhood-route-serves-a-device-sync): on the
// keyed-only route of an EVM chain (POST /v1/rpc/{robinhood,base}?keyed=only), a device's pool index sync (the kit's
// checks/evm/pool-index.ts: the PoolManager's Initialize logs a span, the span's last block beside it) draws its own
// allowance for the caller's address, so the page's background passes on the same address never leave it a 429; the
// allowance is per address and every call still draws on the chain's total. The URLs are made up; the keys are planted
// strings.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as rpcModule from "./rpc.ts";
import { createRpc, keyedBudget } from "./rpc.ts";
import { evmPoolVenues } from "../../../../packages/kit/src/index.ts";

// read off the module, so this file loads at a base without them and fails on the behaviour (red runs)
const { INDEX_CLIENT, INITIALIZE_TOPIC } = rpcModule as unknown as { INDEX_CLIENT?: string; INITIALIZE_TOPIC?: string };

const CHAINS = ["robinhood", "base"] as const;
const ENV: Record<string, string> = {
  ROBINHOOD_RPC_URL: "https://robinhood-mainnet.alchemy.test/v2/plantedRHown000key123456789abcd",
  BASE_RPC_URL: "https://base-mainnet.alchemy.test/v2/plantedBASEown0key123456789abcd",
};
/** The kit's Initialize topic (packages/kit/src/checks/evm/pool-index.ts INITIALIZE). */
const INITIALIZE = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
/** A still clock: the caller's share is a fixed window on the helper's clock (limits.ts clientWindow), so the 429s this
 *  file asserts come inside one window (logs-cache.test.ts STILL). */
const STILL = (): number => 1_800_000_000_000;
const HEAD = 120_000_000;
const hex = (n: number): string => `0x${n.toString(16)}`;
const SPAN = 500_000;
/** A 6-day snapshot's sync as the kit sends it (measured through the deployed route, 21 Nov 17:02Z: 12 posts, 23 calls):
 *  the head, then 11 posts of one span's Initialize logs and its last block. */
const head = (id: number): string => JSON.stringify({ jsonrpc: "2.0", id, method: "eth_getBlockByNumber", params: ["latest", false] });
const span = (chain: (typeof CHAINS)[number], i: number, topics: unknown[] = [INITIALIZE]): string => {
  const to = HEAD - i * SPAN;
  return JSON.stringify([
    { jsonrpc: "2.0", id: 2 * i, method: "eth_getLogs", params: [{ address: evmPoolVenues()[chain]!.poolManager, topics, fromBlock: hex(to - SPAN + 1), toBlock: hex(to) }] },
    { jsonrpc: "2.0", id: 2 * i + 1, method: "eth_getBlockByNumber", params: [hex(to), false] },
  ]);
};
/** One of the page's background passes' reads (packages/wallet/src/pool/buy-wallets.ts): a holdings read. */
const pass = (id: number): string => JSON.stringify({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: "0x9306359433127c4f3be426f6faeb00a3c41f66db", data: "0x70a08231" }, "latest"] });

function provider() {
  let calls = 0;
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    const one = (req: { id: number; method: string; params: unknown[] }) => {
      calls++;
      if (req.method === "eth_getBlockByNumber") return { jsonrpc: "2.0", id: req.id, result: { number: req.params[0] === "latest" || req.params[0] === "finalized" ? hex(HEAD) : req.params[0], hash: `0x${"ab".repeat(32)}` } };
      if (req.method === "eth_getLogs") return { jsonrpc: "2.0", id: req.id, result: [] };
      return { jsonrpc: "2.0", id: req.id, result: `0x${"0".repeat(64)}` };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls: () => calls };
}

test("the Initialize topic is the kit's", () => {
  assert.equal(INITIALIZE_TOPIC, INITIALIZE);
});

for (const chain of CHAINS) {
  const share = keyedBudget(chain).perClient;
  test(`${chain}: the page's passes at the address's whole share (${share} in 10 s) and a 6-day index sync beside them: every post of the sync answered, never a 429`, async () => {
    const p = provider();
    const r = createRpc(ENV, { fetch: p.fetch as never, now: STILL, log: () => undefined });
    const ip = "203.0.113.31";
    const passes: number[] = [];
    for (let i = 0; i < share - 1; i++) passes.push((await r.handle(chain, "application/json", pass(i), ip, false, true)).status);
    assert.deepEqual(passes, Array(share - 1).fill(200), "the passes: inside the share");
    const sync: number[] = [(await r.handle(chain, "application/json", head(1), ip, false, true)).status];
    for (let i = 1; i <= 11; i++) sync.push((await r.handle(chain, "application/json", span(chain, i), ip, false, true)).status);
    assert.deepEqual(sync, Array(12).fill(200), "the sync: the head on the share's last call, its 11 spans on their own allowance");
    assert.equal((await r.handle(chain, "application/json", pass(99), ip, false, true)).status, 429, "the share itself: spent by the passes and the head, as before");
  });

  test(`${chain}: a coin's read (Initialize and the coin as a topic) is an index read too; one PoolManager read with any other method, another address or another event is the caller's share`, async () => {
    const p = provider();
    const r = createRpc(ENV, { fetch: p.fetch as never, now: STILL, log: () => undefined });
    const ip = "203.0.113.32";
    for (let i = 0; i < share; i++) assert.equal((await r.handle(chain, "application/json", pass(i), ip, false, true)).status, 200);
    const coin = `0x${"0".repeat(24)}${"11".repeat(20)}`;
    assert.equal((await r.handle(chain, "application/json", span(chain, 1, [INITIALIZE, coin]), ip, false, true)).status, 200, "a coin's read");
    assert.equal((await r.handle(chain, "application/json", span(chain, 2, [INITIALIZE, null, coin]), ip, false, true)).status, 200, "a coin's read as currency1");
    const swap = `0x${"40".repeat(32)}`;
    assert.equal((await r.handle(chain, "application/json", span(chain, 3, [swap]), ip, false, true)).status, 429, "another event: the share");
    const mixed = JSON.stringify([JSON.parse(span(chain, 4))[0], JSON.parse(pass(7))]);
    assert.equal((await r.handle(chain, "application/json", mixed, ip, false, true)).status, 429, "an index read with an eth_call beside it: the share");
    const other = span(chain, 5).replace(evmPoolVenues()[chain]!.poolManager!, "0x1111111111111111111111111111111111111111");
    assert.equal((await r.handle(chain, "application/json", other, ip, false, true)).status, 429, "another address: the share");
  });

  test(`${chain}: the index allowance is per address and bounded (${share} in 10 s, then its 429 with a Retry-After), and every index call draws on the chain's total`, async () => {
    assert.equal(typeof INDEX_CLIENT, "string");
    const p = provider();
    // the chain's total two shares: one address's passes and its index spend it all
    const r = createRpc({ ...ENV, [`RPC_BUDGET_${chain.toUpperCase()}`]: `${2 * share},${share}` }, { fetch: p.fetch as never, now: STILL, log: () => undefined });
    const ip = "203.0.113.33";
    const index: number[] = [];
    for (let i = 1; i <= share / 2 + 1; i++) index.push((await r.handle(chain, "application/json", span(chain, i), ip, false, true)).status);
    assert.deepEqual(index, [...Array(share / 2).fill(200), 429], "the index's own allowance: its 30 calls, then a 429");
    const refused = await r.handle(chain, "application/json", span(chain, 99), ip, false, true);
    assert.ok(Number(refused.headers?.["Retry-After"]) >= 1 && Number(refused.headers?.["Retry-After"]) <= 10, "the 429 names its wait");
    assert.equal((await r.handle(chain, "application/json", span(chain, 1), "203.0.113.34", false, true)).status, 200, "another address: its own allowance");
    for (let i = 0; i < share - 2; i++) assert.equal((await r.handle(chain, "application/json", pass(i), ip, false, true)).status, 200, "the share untouched by the index");
    assert.equal((await r.handle(chain, "application/json", pass(98), "203.0.113.35", false, true)).status, 429, "the chain's total spent: index calls drew on it");
  });
}
