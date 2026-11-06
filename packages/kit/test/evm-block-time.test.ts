// Card base-200ms-blocks: each EVM chain's maxLag in trade/evm/buy-unpinned.ts stands for a time, and is held to that
// time at the chain's block time read on chain. Base and Base Sepolia went from a block every 2 s to one every 200 ms
// (Base at block 53556127, 2026-11-05 18:00:01Z), and Base's maxLag 5 then stood for 1 s, not the 10 s it was set for.
// Block times read 2026-11-05 20:38Z, 10,000 blocks back from the head on both of each chain's providers named below:
//   base              base-rpc.publicnode.com, base.gateway.tenderly.co             2,000 s -> 200.0 ms a block
//   base-sepolia      sepolia.base.org, base-sepolia-rpc.publicnode.com             2,000 s -> 200.0 ms
//   robinhood         rpc.mainnet.chain.robinhood.com, robinhood.drpc.org           1,012 s -> 101.2 ms
//   robinhood-testnet rpc.testnet.chain.robinhood.com, robinhood-testnet.drpc.org   1,634 s -> 163.4 ms
// Live check base-200ms-blocks reads Base's again after every helper deploy and fails when it moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";

const BLOCK_MS = { base: 200, "base-sepolia": 200, robinhood: 101.2, "robinhood-testnet": 163.4 } as const;
// the time each chain's maxLag stands for (the comment beside it): two heads at most this far apart
const LAG_MS = { base: 10_000, "base-sepolia": 20_000, robinhood: 10_000, "robinhood-testnet": 16_340 } as const;

test("each EVM chain's maxLag is the time it stands for at the chain's own block time (Base: 10 s is 50 blocks of 200 ms, never 5)", () => {
  const v = evmPoolVenues() as Record<string, { maxLag?: number }>;
  assert.deepEqual(Object.keys(v).sort(), Object.keys(BLOCK_MS).sort());
  for (const [chain, ms] of Object.entries(BLOCK_MS)) {
    const lag = v[chain]!.maxLag!;
    const want = LAG_MS[chain as keyof typeof LAG_MS];
    // within 2% of the time it stands for (Robinhood's 100 blocks are 10.12 s)
    assert.ok(Math.abs(lag * ms - want) <= want * 0.02, `${chain}: maxLag ${lag} blocks of ${ms} ms is ${lag * ms} ms, not ${want} ms`);
  }
});

// Card notes-per-pool-evm-base-hang: each testnet's pool pair (`providers`) is where the wallet's pool sync pages the
// pool's logs from its deploy block (evmPool, evmTreeSync), so each one must answer the pool's eth_getLogs over the
// pager's full page (EVM_LOG_PAGE_BLOCKS in packages/wallet/src/pool/evm.ts). Each provider's widest page read live on
// the pool's own filter (its address and its three topics), from its deploy block, over 1,000, 10,000, 50,000 and
// 100,000 blocks (2026-11-06 04:35Z on Base Sepolia, 05:01Z on Robinhood testnet): the largest it answered.
// sepolia.base.org refused all four ("-32614: eth_getLogs is limited to a 200 range"): at 200 ms blocks its 156-block
// pages were about 8,250 for the Base Sepolia pool's 1,287,712 blocks, 41 min, and its live check printed nothing.
const PAGE = 10_000;
const WIDEST: Record<string, number> = {
  "sepolia.base.org": 200,
  "base-sepolia-rpc.publicnode.com": 50_000,
  "base-testnet.api.pocket.network": 100_000,
  "rpc.testnet.chain.robinhood.com": 100_000,
  "robinhood-sepolia-rpc.publicnode.com": 50_000,
};

test("each testnet's pool pair pages the pool's logs at the pool sync's full page (never sepolia.base.org's 200 blocks)", () => {
  const v = evmPoolVenues() as Record<string, { providers?: readonly string[] }>;
  for (const chain of ["base-sepolia", "robinhood-testnet"]) {
    const hosts = v[chain]!.providers!.map((u) => new URL(u).host);
    assert.equal(hosts.length, 2, chain);
    for (const h of hosts) {
      assert.ok(h in WIDEST, `${chain}: ${h}'s widest page on the pool's logs was never read`);
      assert.ok(WIDEST[h]! >= PAGE, `${chain}: ${h} pages the pool's logs at ${WIDEST[h]} blocks, under the sync's ${PAGE}`);
    }
  }
});

