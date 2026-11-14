/// <reference types="node" />
// Every Solana reference on the page reads the coin's Meteora DLMM pairs (card solana-buy-reaches-raydium-and-meteora):
// src/page-rpc.ts pageReference asks the page's finder (keptDlmmPairs, set at start by main.ts on mainnet) beside the
// pump venues' read. Replays NEARKAT's pair B8BH6ZKr… as two mainnet providers answered it (the kit's
// test/vectors/nearkat-dlmm.json). Good: with the finder the buy's reference is the pair's, E the program's own out;
// a finder that fails, or none, leaves the pump venues alone (no reference for NEARKAT, what main answered), never a
// throw; a coin's pairs are read once a minute, and a failed read is not kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DLMM_PAIRS_KEEP_MS, keptDlmmPairs, pageReference } from "../src/page-rpc.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";

type Provider = { slot: number; accounts: Record<string, { owner: string; data: string } | null> };
const V = JSON.parse(readFileSync(new URL("../../kit/test/vectors/nearkat-dlmm.json", import.meta.url), "utf8")) as {
  mint: string; pair: string; providers: Record<string, Provider>; programOut: Record<string, { out: string }>;
};
const [PA, PB] = Object.values(V.providers) as [Provider, Provider];
function replay(p: Provider, url: string): SolanaRpc {
  const f = (async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getMultipleAccounts");
    return {
      context: { slot: p.slot },
      value: (params[0] as string[]).map((a) => (p.accounts[a] ? { owner: p.accounts[a]!.owner, lamports: 1, executable: false, rentEpoch: 0, data: [p.accounts[a]!.data, "base64"] } : null)),
    };
  }) as SolanaRpc;
  return Object.assign(f, { url });
}
const pair = () => [replay(PA, "https://a.example"), replay(PB, "https://b.example")] as const;
const buy = { side: "buy" as const, token: V.mint, amount: 100_000_000n };

test("with the page's finder a DLMM coin's buy has the pair's reference, E the program's own out", async () => {
  const asked: string[] = [];
  const ref = await pageReference(pair(), buy, async (t) => (asked.push(t), [V.pair]));
  assert.deepEqual(asked, [V.mint]);
  assert.ok(ref !== null);
  assert.equal(ref.pools[0]!.venue, "dlmm");
  assert.equal(ref.pools[0]!.address, V.pair);
  assert.equal(ref.expectedOut, BigInt(V.programOut["100000000"]!.out));
});

test("no finder, a finder that finds none, or one that fails: the pump venues alone, no reference for NEARKAT, never a throw", async () => {
  assert.equal(await pageReference(pair(), buy, null), null);
  assert.equal(await pageReference(pair(), buy, async () => []), null);
  assert.equal(await pageReference(pair(), buy, async () => Promise.reject(new Error("scan down"))), null);
  // a request that names its pairs is read with those, the finder never asked
  const ref = await pageReference(pair(), { ...buy, dlmmPairs: [V.pair] }, async () => assert.fail("asked"));
  assert.equal(ref?.pools[0]?.venue, "dlmm");
});

test("the finder reads a coin's pairs once a minute; a failed read is not kept", async () => {
  let t = 0;
  let reads = 0;
  const scan = (fail: () => boolean): SolanaRpc =>
    Object.assign((async (method: string) => {
      assert.equal(method, "getProgramAccounts");
      reads++;
      if (fail()) throw new Error("down");
      return { context: { slot: 1 }, value: [] };
    }) as SolanaRpc, { url: "https://scan.example" });
  let down = true;
  const find = keptDlmmPairs(() => [scan(() => down), scan(() => down)], () => pair(), () => t);
  await assert.rejects(find(V.mint));
  down = false;
  assert.deepEqual(await find(V.mint), []);
  const after = reads;
  t += DLMM_PAIRS_KEEP_MS - 1;
  assert.deepEqual(await find(V.mint), []);
  assert.equal(reads, after, "kept for the minute");
  t += 1;
  await find(V.mint);
  assert.equal(reads, after + 4, "read again past it (both mints' orders on both providers)");
});

test("the tap's venue (readCoinVenue): a DLMM coin's pair with the finder; with none (no DLMM table pinned) it throws, so the tap moves nothing from Cash", async () => {
  const { readCoinVenue } = await import("../src/pools.ts");
  const v = await readCoinVenue(pair(), V.mint, async () => [V.pair]);
  assert.deepEqual({ ...v }, { kind: "dlmm", tokenAccountSize: v.tokenAccountSize, cashback: false, decimals: v.decimals });
  assert.ok(v.tokenAccountSize > 165, "NEARKAT is a Token-2022 coin with a transfer fee: its account is larger");
  await assert.rejects(readCoinVenue(pair(), V.mint));
  await assert.rejects(readCoinVenue(pair(), V.mint, async () => []));
  // a pair the finder names that is not this coin's is no venue
  await assert.rejects(readCoinVenue(pair(), V.mint, async () => ["11111111111111111111111111111111"]));
});
