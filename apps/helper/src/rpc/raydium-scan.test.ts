// node --test src/rpc/raydium-scan.test.ts (card solana-buy-reaches-raydium-and-meteora): the signing page finds a coin's
// Raydium CPMM and AMM v4 SOL pools with the kit's scans (readSolanaCpmmPools, readSolanaAmmV4Pools: getProgramAccounts
// by the pool's size and both mints, addresses only) on Solana Vibe Station and on POST /v1/rpc/solana. The helper
// carries those exact shapes, the coin on either side, to route A (SOLANA_RPC_URL) as any scan; any wider scan of either
// program is refused before any call. The shapes are written out here (raydium-cp-swap states/pool.rs: 637 bytes,
// token_0_mint 168, token_1_mint 200; raydium-amm state.rs: 752 bytes, coin_vault_mint 400, pc_vault_mint 432) and held
// equal to the kit's, so this file runs against a helper without them (b6657467d answered 400).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOLANA_SOL_MINT } from "@blindfill/kit";
import { createRpc } from "./rpc.ts";

/** A still clock: a caller's share and a provider's budget are fixed windows on the helper's clock (limits.ts
 *  clientWindow, upstreamBudget; card helper-share-tests-on-a-still-clock), so on the machine's clock a window's turn
 *  inside a test clears the share its counts and 429s assert (PR 979's merge queue run 44243609488). */
const STILL = (): number => 1_800_000_000_000;
const HIGH = "7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh";
const CZLSUJ = "CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump";
const CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const shape = (program: string, size: number, at: [number, number]) => (x: string, y: string): readonly unknown[] => [
  program,
  { commitment: "confirmed", encoding: "base64", withContext: true, dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: size }, { memcmp: { offset: at[0], bytes: x } }, { memcmp: { offset: at[1], bytes: y } }] },
];
const SCANS = { cpmm: shape(CPMM, 637, [168, 200]), ammV4: shape(AMM_V4, 752, [400, 432]) } as const;
const COIN = { cpmm: HIGH, ammV4: CZLSUJ } as const;
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

test("the shapes here are the kit's scans", async () => {
  const kit = (await import("@blindfill/kit")) as Record<string, unknown>;
  const cpmm = kit.solanaCpmmPoolScan as (x: string, y: string) => readonly unknown[];
  const amm = kit.solanaAmmV4PoolScan as (x: string, y: string) => readonly unknown[];
  assert.equal(typeof cpmm, "function", "the kit has no CPMM pool scan");
  assert.equal(typeof amm, "function", "the kit has no AMM v4 pool scan");
  assert.deepEqual(cpmm(HIGH, SOLANA_SOL_MINT), SCANS.cpmm(HIGH, SOLANA_SOL_MINT));
  assert.deepEqual(amm(CZLSUJ, SOLANA_SOL_MINT), SCANS.ammV4(CZLSUJ, SOLANA_SOL_MINT));
});

for (const kind of ["cpmm", "ammV4"] as const) {
  const scan = SCANS[kind];
  const coin = COIN[kind];
  test(`${kind}: the kit's pool scan, the coin on either side, goes to route A`, async () => {
    for (const params of [scan(coin, SOLANA_SOL_MINT), scan(SOLANA_SOL_MINT, coin)]) {
      const { sent, f } = fakeFetch();
      const r = createRpc(ENV, { now: STILL, fetch: f, log: () => {} });
      const a = await call(r, "solana", body(params));
      assert.equal(a.status, 200, a.body);
      assert.deepEqual(sent, [A]);
    }
  });

  test(`${kind}: any wider scan of the program is refused before any call`, async () => {
    const [prog, c] = scan(coin, SOLANA_SOL_MINT) as [string, { filters: unknown[] } & Record<string, unknown>];
    const f3 = c.filters;
    const wider: (readonly unknown[])[] = [
      [prog, { ...c, filters: [f3[0], f3[1]] }], // one mint: every pool of the coin
      [prog, { ...c, filters: [f3[1], f3[2]] }], // no size
      [prog, { ...c, dataSlice: { offset: 0, length: 752 } }], // the pools' bytes
      [prog, { ...c, filters: [{ dataSize: 165 }, f3[1], f3[2]] }], // another size
      [prog, { ...c, filters: [f3[0], { memcmp: { offset: 0, bytes: coin } }, f3[2]] }], // a mint at another offset
      [prog, { ...c, encoding: "jsonParsed" }],
      [prog, { ...c, extra: 1 }],
      scan(coin, coin), // no wSOL side
      scan(SOLANA_SOL_MINT, SOLANA_SOL_MINT),
      scan(coin, "not-a-key"),
      [kind === "cpmm" ? AMM_V4 : CPMM, c], // the other program with this one's shape
      ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", c], // another program
    ];
    for (const params of wider) {
      const { sent, f } = fakeFetch();
      const r = createRpc(ENV, { now: STILL, fetch: f, log: () => {} });
      const a = await call(r, "solana", body(params));
      assert.equal(a.status, 400, JSON.stringify(params));
      assert.equal(sent.length, 0);
    }
    // the marks route carries the marks scan alone, never this one
    const { sent, f } = fakeFetch();
    const r = createRpc({ ...ENV, SOLANA_RPC_URL_QUICKNODE: "https://x.solana-mainnet.quiknode.example/test-key-qn-not-a-secret/" }, { now: STILL, fetch: f, log: () => {} });
    assert.equal((await call(r, "solana-marks", body(scan(coin, SOLANA_SOL_MINT)))).status, 400);
    assert.equal(sent.length, 0);
  });
}
