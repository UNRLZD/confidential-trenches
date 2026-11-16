// Card robinhood-quote-answers-cold: the pool index snapshots the sign release ships (public/evm-index/<chain>.json,
// scripts/evm-index-snapshot.mjs) each read back through the page's own check (the kit's evmPoolIndexFromSnapshot, on
// the venue's chain id, PoolManager and cap), inside the page's size bound, so a fresh device starts its sync from it;
// the live check robinhood-quote-answers-cold holds SIGN_HOST serving these bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { evmPoolVenues } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { evmPoolIndexFromSnapshot } from "../../kit/src/checks/evm/pool-index.ts";
import { EVM_INDEX_SNAPSHOT_MAX } from "../src/pool-testnet.ts";

for (const chain of ["base", "robinhood"] as const) {
  test(`the committed ${chain} snapshot reads back through the page's check, under its size bound`, () => {
    const file = new URL(`../public/evm-index/${chain}.json`, import.meta.url);
    assert.ok(statSync(file).size <= EVM_INDEX_SNAPSHOT_MAX, `${statSync(file).size} bytes`);
    const v = evmPoolVenues()[chain]!;
    const ix = evmPoolIndexFromSnapshot(JSON.parse(readFileSync(file, "utf8")), { chainId: v.chainId, poolManager: v.poolManager!, cap: v.index!.cap });
    assert.ok(ix !== null, "the snapshot does not read back");
    assert.ok(ix.pools.length > 0 && ix.through > ix.from, `${ix.pools.length} pools, ${ix.from} to ${ix.through}`);
  });
}
