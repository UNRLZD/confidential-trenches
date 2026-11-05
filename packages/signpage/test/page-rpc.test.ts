// The signing page's RPCs (card signpage-rpc-throttle-retry): every pool read and send the page makes, testnet and
// mainnet, goes through the kit's client with the page's retry, so a throttle once is a read that lands, never a kind
// that answers failed (run 6: a devnet provider's 429 burst).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SolanaRpcTransportError } from "../../kit/src/trade/solana/send.ts";
import { pageHelperRpc, pageRpc } from "../src/page-rpc.ts";
import { testnetPoolDeps } from "../src/pool-testnet.ts";
import { SOLANA_PROVIDER_A, TRADE_HELPER, releaseTradeDeps } from "../src/trade.ts";

/** globalThis.fetch for one test: each URL answers 429 (Retry-After 0) on its first call, then the call's result. */
async function withThrottledOnce(run: (seen: Map<string, number>) => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  const seen = new Map<string, number>();
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    const n = (seen.get(url) ?? 0) + 1;
    seen.set(url, n);
    if (n === 1) return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "0" } });
    const id = (JSON.parse(String(init?.body)) as { id: string }).id;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: 42 }), { status: 200 });
  }) as typeof fetch;
  try {
    await run(seen);
  } finally {
    globalThis.fetch = real;
  }
}

// the testnet build's pool RPCs read through a 429 once in test/pool-testnet.test.ts, which runs as that build
test("the mainnet build's pool RPCs (src/pool-testnet.ts on SIGN_HOST's build): Solana's pair, provider A and the helper's route, reads through a 429 once; Base and Robinhood have no pair yet", async () => {
  await withThrottledOnce(async (seen) => {
    const deps = testnetPoolDeps();
    for (const r of deps.rpcs("solana")!) assert.equal(await (r as unknown as (m: string, p: unknown[]) => Promise<unknown>)("getSlot", []), 42);
    assert.equal(seen.get(SOLANA_PROVIDER_A), 2);
    assert.equal(seen.get(`${TRADE_HELPER}/v1/rpc/solana`), 2);
    assert.equal(deps.rpcs("base"), null);
    assert.equal(deps.rpcs("robinhood"), null);
  });
});

test("the page's direct and helper RPCs (the mainnet pool reads) read through a 429 once", async () => {
  await withThrottledOnce(async (seen) => {
    assert.equal(await pageRpc("https://solana-rpc.publicnode.com")("getSlot", []), 42);
    assert.equal(await pageHelperRpc("https://helper.example")("getSlot", []), 42);
    assert.equal(seen.get("https://solana-rpc.publicnode.com"), 2);
    assert.equal(seen.get("https://helper.example/v1/rpc/solana"), 2);
  });
});

test("the page's trade path (src/trade.ts releaseTradeDeps): both providers read through a 429 once", async () => {
  await withThrottledOnce(async (seen) => {
    const d = releaseTradeDeps();
    for (const p of d.providers) assert.equal(await p("getSlot", []), 42);
    assert.equal(seen.get(SOLANA_PROVIDER_A), 2);
    assert.equal(seen.get(`${TRADE_HELPER}/v1/rpc/solana`), 2);
  });
});

test("a page RPC that stays throttled rejects naming the fault and the host, never a bare failure", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 429, headers: { "retry-after": "30" } })) as typeof fetch;
  try {
    const e = await pageRpc("https://api.devnet.solana.com")("getSlot", []).catch((x: unknown) => x);
    assert.ok(e instanceof SolanaRpcTransportError);
    assert.equal(e.fault, "http_429");
    assert.equal(e.host, "api.devnet.solana.com");
  } finally {
    globalThis.fetch = real;
  }
});
