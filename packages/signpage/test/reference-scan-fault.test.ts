// card pool-buy-waits-out-a-throttle: a pool scan a provider throttled past the page's own retry is that fault, never
// "no pools". pageReference read it as none, so a coin whose only pools are on a scanned venue (Meteora DLMM, Raydium)
// answered quote_check_failed at once and the buy never waited; now the reference throws the fault when it names no
// pool (the buy's attempts wait it out, read-waits.ts readsWaited), and a pool another venue names still quotes.
//   node --test test/reference-scan-fault.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { pageReference, type PoolFinders } from "../src/page-rpc.ts";

const COIN = "9a13W5HdHk8P3wHtmJmM1pJWXa9ARn9pRx16khKmtppu";
const REQ = { side: "buy", token: COIN, amount: 1_000_000n } as const;

/** A provider on which no account of the coin's pump venues exists: every account it is asked for is null. */
const empty = (url: string): SolanaRpc =>
  Object.assign(async (method: string, params: readonly unknown[]) => {
    if (method === "getMultipleAccounts") return { context: { slot: 1 }, value: (params[0] as unknown[]).map(() => null) };
    if (method === "getAccountInfo") return { context: { slot: 1 }, value: null };
    throw new Error(`unexpected ${method}`);
  }, { url });
const pair = [empty("https://a.example"), empty("https://b.example")] as const;
const throttled = (): Promise<readonly string[]> => Promise.reject(new SolanaRpcTransportError("http_429", "HTTP 429", 3, "seat.example", 1_000));

test("a coin with no pump pool whose DLMM scan was throttled: the reference throws the scan's fault, never no reference", async () => {
  const finders: PoolFinders = { dlmmPairs: throttled, cpmmPools: async () => [], ammV4Pools: async () => [] };
  await assert.rejects(pageReference(pair, REQ, finders), (e: unknown) => e instanceof SolanaRpcTransportError && e.fault === "http_429");
});

test("a scan that failed otherwise (an answer out of shape) is still no pools: null, as before", async () => {
  const finders: PoolFinders = { dlmmPairs: () => Promise.reject(new Error("a DLMM pair list is not a list")), cpmmPools: async () => [], ammV4Pools: async () => [] };
  assert.equal(await pageReference(pair, REQ, finders), null);
});

test("no scan failed and no pool: null, the coin has none", async () => {
  const finders: PoolFinders = { dlmmPairs: async () => [], cpmmPools: async () => [], ammV4Pools: async () => [] };
  assert.equal(await pageReference(pair, REQ, finders), null);
});
