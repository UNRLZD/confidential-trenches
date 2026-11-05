// The signing page's RPCs (card signpage-rpc-throttle-retry): every pool read and send the page makes, testnet and
// mainnet, goes through the kit's client with the page's retry, so a throttle once is a read that lands, never a kind
// that answers failed (run 6: a devnet provider's 429 burst).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SolanaRpcTransportError } from "../../kit/src/trade/solana/send.ts";
import { pageHelperRpc, pageRpc } from "../src/page-rpc.ts";
import { TESTNET_RPCS, testnetPoolDeps } from "../src/pool-testnet.ts";
import { SOLANA_PROVIDER_A, TRADE_HELPER, releaseTradeDeps } from "../src/trade.ts";
import { readFileSync } from "node:fs";
import { HELPER_RPC_METHODS } from "../../kit/src/helper/v1.ts";

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

test("the testnet build's pool RPCs, every chain and both providers, read through a 429 once", async () => {
  await withThrottledOnce(async (seen) => {
    const deps = testnetPoolDeps();
    for (const chain of ["solana", "base", "robinhood"] as const) {
      const rpcs = deps.rpcs(chain)!;
      for (const r of rpcs) assert.equal(await (r as unknown as (m: string, p: unknown[]) => Promise<unknown>)("getSlot", []), 42);
      for (const u of TESTNET_RPCS[chain]) assert.equal(seen.get(u), 2, u);
    }
  });
});

test("card pool-buy-send-fast: the testnet build's second Solana provider is the helper's /v1/rpc/solana-devnet, as mainnet's is its /v1/rpc/solana, read with the kit's HELPER_FETCH_INIT; no 1-request-a-second public provider", async () => {
  // onfinality's public devnet endpoint (x-ratelimit-limit-sec 1, limit-day 1000, read 5 Nov 15:03Z) held the 5 Nov
  // 13:50:55Z buy 11.2 s in the page's reads: 26 of its answers were 429
  assert.deepEqual([...TESTNET_RPCS.solana], ["https://api.devnet.solana.com", `${TRADE_HELPER}/v1/rpc/solana-devnet`]);
  const real = globalThis.fetch;
  const inits = new Map<string, RequestInit | undefined>();
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    inits.set(String(u), init);
    const id = (JSON.parse(String(init?.body)) as { id: string }).id;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: 7 }), { status: 200 });
  }) as typeof fetch;
  try {
    const [a, b] = testnetPoolDeps().rpcs("solana")! as unknown as ((m: string, p: unknown[]) => Promise<unknown>)[];
    assert.equal(await a!("getSlot", []), 7);
    assert.equal(await b!("getSlot", []), 7);
  } finally {
    globalThis.fetch = real;
  }
  const helper = inits.get(`${TRADE_HELPER}/v1/rpc/solana-devnet`);
  assert.ok(helper, "the second read went to the helper's devnet route");
  assert.equal(helper!.credentials, "omit");
  assert.equal(helper!.referrerPolicy, "no-referrer");
  assert.equal(inits.get("https://api.devnet.solana.com")?.credentials, undefined, "the public provider read plainly");
});

// The Solana pool path's files: every read it makes goes to both of the page's providers, and the second is the
// helper's /v1/rpc/solana (main.ts) or /v1/rpc/solana-devnet (TESTNET_RPCS), which forwards only HELPER_RPC_METHODS.solana
const POOL_PATH = [
  "../src/pool-buy.ts", "../src/pool-deposit.ts", "../src/pool-sell.ts", "../src/pool-spend.ts", "../src/pool-withdraw.ts", "../src/pool-price.ts", "../src/pool-kinds.ts", "../src/pool-testnet.ts",
  "../../wallet/src/pool/solana.ts", "../../wallet/src/pool/solana-restore.ts", "../../wallet/src/pool/buy-wallets.ts", "../../wallet/src/pool/queue.ts", "../../wallet/src/pool/pool.ts", "../../wallet/src/pool/balances.ts",
  "../../kit/src/trade/solana/pool.ts", "../../kit/src/trade/solana/pool-buy.ts", "../../kit/src/trade/solana/send.ts",
];
/** Every Solana JSON-RPC method named in a file: a quoted get*, is*, simulate*, send* or request* name. */
const solanaMethodsIn = (src: string): string[] => [...src.matchAll(/["'`]((?:get|is|simulate|send|request)[A-Z][A-Za-z]+)["'`]/g)].map((m) => m[1]!);
const SOLANA_RPC = /^(get(AccountInfo|Balance|Block|BlockHeight|BlockTime|FeeForMessage|LatestBlockhash|MinimumBalanceForRentExemption|MultipleAccounts|ProgramAccounts|SignatureStatuses|SignaturesForAddress|Slot|TokenAccountsByOwner|TokenLargestAccounts|Transaction|Health|Version|GenesisHash|EpochInfo|RecentPrioritizationFees)|isBlockhashValid|simulateTransaction|sendTransaction|requestAirdrop)$/;

test("card pool-buy-send-fast: every Solana read the pool path makes is on the helper's list, so the page's second provider never refuses one (getSlot, getSignaturesForAddress, getFeeForMessage, getBlockTime, getProgramAccounts were refused 400)", () => {
  const used = new Map<string, string>();
  for (const f of POOL_PATH) for (const m of solanaMethodsIn(readFileSync(new URL(f, import.meta.url), "utf8"))) if (SOLANA_RPC.test(m)) used.set(m, f);
  for (const m of ["getSlot", "getSignaturesForAddress", "getFeeForMessage", "getBlockTime", "getProgramAccounts", "getAccountInfo", "getTransaction"]) assert.ok(used.has(m), `the scan finds ${m}`);
  const off = [...used].filter(([m]) => !(HELPER_RPC_METHODS.solana as readonly string[]).includes(m));
  assert.deepEqual(off, [], `read by the pool path, refused by the helper: ${off.map(([m, f]) => `${m} (${f})`).join(", ")}`);
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
