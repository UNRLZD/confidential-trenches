// node --test src/rpc/clmm-scan.test.ts (card solana-buy-never-below-a-hidden-market): the signing page finds a coin's
// Raydium CLMM markets, wSOL and USDC, with the kit's scan (readSolanaClmmPools: getProgramAccounts by the pool's size,
// 1544, and both mints at 73 and 105, addresses only) on POST /v1/rpc/solana. The helper carries that exact shape, the
// coin and wSOL or USDC in either order, to route A as any scan; any wider scan of the CLMM program (one mint, no size,
// the pools' bytes, a quote other than wSOL or USDC, another program's scan shape) is refused before any call. A USDC
// quote stays the CLMM scan's alone: the DLMM, CPMM and AMM v4 scans still need wSOL on one side.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOLANA_CLMM_PROGRAM, SOLANA_SOL_MINT, SOLANA_USDC_MINT, solanaClmmPoolScan, solanaCpmmPoolScan } from "@blindfill/kit";
import { createRpc } from "./rpc.ts";

const STILL = (): number => 1_800_000_000_000;
const MPLX = "METAewgxyPbgwsseH8T16a39CQ5VyVxZi9zXiDPY18m";
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
const call = (r: ReturnType<typeof createRpc>, b: unknown) => r.handle("solana", "application/json", JSON.stringify(b));

test("the kit's CLMM pool scan, the coin as token 0 or 1 beside wSOL or USDC, goes to route A", async () => {
  const [prog, c] = solanaClmmPoolScan(MPLX, SOLANA_SOL_MINT) as [string, { filters: unknown[] }];
  assert.equal(prog, SOLANA_CLMM_PROGRAM);
  assert.deepEqual(c.filters, [{ dataSize: 1544 }, { memcmp: { offset: 73, bytes: MPLX } }, { memcmp: { offset: 105, bytes: SOLANA_SOL_MINT } }]);
  for (const q of [SOLANA_SOL_MINT, SOLANA_USDC_MINT]) {
    for (const params of [solanaClmmPoolScan(MPLX, q), solanaClmmPoolScan(q, MPLX)]) {
      const { sent, f } = fakeFetch();
      const a = await call(createRpc(ENV, { now: STILL, fetch: f, log: () => {} }), body(params));
      assert.equal(a.status, 200, a.body);
      assert.deepEqual(sent, [A]);
    }
  }
});

test("any wider scan of the CLMM program, or a USDC scan of another program, is refused before any call", async () => {
  const [prog, c] = solanaClmmPoolScan(MPLX, SOLANA_SOL_MINT) as [string, { filters: unknown[] } & Record<string, unknown>];
  const f3 = c.filters;
  const wider: (readonly unknown[])[] = [
    [prog, { ...c, filters: [f3[0], f3[1]] }], // one mint: every pool of the coin
    [prog, { ...c, filters: [f3[1], f3[2]] }], // no size
    [prog, { ...c, dataSlice: { offset: 0, length: 1544 } }], // the pools' bytes
    [prog, { ...c, filters: [{ dataSize: 10240 }, f3[1], f3[2]] }], // tick arrays
    [prog, { ...c, filters: [f3[0], { memcmp: { offset: 74, bytes: MPLX } }, f3[2]] }], // another offset
    [prog, { ...c, encoding: "jsonParsed" }],
    [prog, { ...c, extra: 1 }],
    solanaClmmPoolScan(MPLX, MPLX), // no quote side
    solanaClmmPoolScan(SOLANA_USDC_MINT, SOLANA_USDC_MINT),
    solanaClmmPoolScan(MPLX, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"), // USDT: not a quote the device prices
    solanaClmmPoolScan(MPLX, "not-a-key"),
    solanaCpmmPoolScan(MPLX, SOLANA_USDC_MINT), // USDC is the CLMM scan's quote alone
  ];
  for (const params of wider) {
    const { sent, f } = fakeFetch();
    const a = await call(createRpc(ENV, { now: STILL, fetch: f, log: () => {} }), body(params));
    assert.equal(a.status, 400, JSON.stringify(params));
    assert.equal(sent.length, 0);
  }
});
