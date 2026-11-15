// node --test src/rpc/dlmm-scan.test.ts (card solana-buy-reaches-raydium-and-meteora): the signing page finds a coin's
// Meteora DLMM SOL pairs with the kit's scan (readSolanaDlmmPairs: getProgramAccounts by the pair's size and both mints,
// addresses only) on Solana Vibe Station and on POST /v1/rpc/solana. The helper carries that exact shape, the coin and
// wSOL in either order, to route A (SOLANA_RPC_URL) as any scan; any wider scan of the DLMM program (one mint, no size,
// the pairs' bytes, another program's size) is refused before any call, so no caller spends the keyed quota on a sweep.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOLANA_SOL_MINT, solanaDlmmPairScan } from "@blindfill/kit";
import { createRpc } from "./rpc.ts";

const NEARKAT = "6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr";
const DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
// made-up hosts and test-only keys: nothing here reaches a network
const A = "https://mainnet.helius-rpc.example/?api-key=test-key-a-not-a-secret";
const ENV = { SOLANA_RPC_URL: A, POOL_SOLANA_PROGRAM_MAINNET: "EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF" };
const body = (params: readonly unknown[]) => ({ jsonrpc: "2.0", id: 9, method: "getProgramAccounts", params });
function fakeFetch() {
  const sent: string[] = [];
  const f = async (url: string, init: RequestInit) => {
    sent.push(url);
    const p = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: p.id, result: { context: { slot: 1 }, value: [] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { sent, f };
}
const call = (r: ReturnType<typeof createRpc>, chain: string, b: unknown) => r.handle(chain, "application/json", JSON.stringify(b));

test("the kit's DLMM pair scan, the coin as X or as Y, goes to route A", async () => {
  for (const params of [solanaDlmmPairScan(NEARKAT, SOLANA_SOL_MINT), solanaDlmmPairScan(SOLANA_SOL_MINT, NEARKAT)]) {
    const { sent, f } = fakeFetch();
    const r = createRpc(ENV, { fetch: f, log: () => {} });
    const a = await call(r, "solana", body(params));
    assert.equal(a.status, 200, a.body);
    assert.deepEqual(sent, [A]);
  }
});

test("any wider scan of the DLMM program is refused before any call", async () => {
  const [prog, c] = solanaDlmmPairScan(NEARKAT, SOLANA_SOL_MINT) as [string, { filters: unknown[] } & Record<string, unknown>];
  const f3 = c.filters;
  const wider: (readonly unknown[])[] = [
    [prog, { ...c, filters: [f3[0], f3[1]] }], // one mint: every pair of the coin
    [prog, { ...c, filters: [f3[1], f3[2]] }], // no size
    [prog, { ...c, dataSlice: { offset: 0, length: 904 } }], // the pairs' bytes
    [prog, { ...c, filters: [{ dataSize: 10136 }, f3[1], f3[2]] }], // bin arrays
    [prog, { ...c, encoding: "jsonParsed" }],
    [prog, { ...c, extra: 1 }],
    solanaDlmmPairScan(NEARKAT, NEARKAT), // no wSOL side
    solanaDlmmPairScan(SOLANA_SOL_MINT, SOLANA_SOL_MINT),
    solanaDlmmPairScan(NEARKAT, "not-a-key"),
    ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", c], // another program
  ];
  assert.equal(prog, DLMM);
  for (const params of wider) {
    const { sent, f } = fakeFetch();
    const r = createRpc(ENV, { fetch: f, log: () => {} });
    const a = await call(r, "solana", body(params));
    assert.equal(a.status, 400, JSON.stringify(params));
    assert.equal(sent.length, 0);
  }
  // the marks route carries the marks scan alone, never this one
  const { sent, f } = fakeFetch();
  const r = createRpc({ ...ENV, SOLANA_RPC_URL_QUICKNODE: "https://x.solana-mainnet.quiknode.example/test-key-qn-not-a-secret/" }, { fetch: f, log: () => {} });
  assert.equal((await call(r, "solana-marks", body(solanaDlmmPairScan(NEARKAT, SOLANA_SOL_MINT)))).status, 400);
  assert.equal(sent.length, 0);
});
