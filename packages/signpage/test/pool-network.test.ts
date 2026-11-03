// SIGN_HOST's build is mainnet (card signpage-pool-flow): with __SIGN_NETWORK__ unset, as in Node, or "mainnet", as
// scripts/build-app.mjs sets it for SIGN_HOST's build, SOL_POOLS pins no pool on either cluster until
// pool-sol-deploy-mainnet pins one, and the testnet deps are not what the page's mainnet pins say.
// scripts/build-network.test.mjs holds the bundle itself: the mainnet build carries no testnet pin or provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SOL_POOLS } from "../../wallet/src/pool/solana.ts";
import { POOL_TESTNET } from "../../wallet/src/pool/network.ts";

test("the mainnet tables: no Solana pool pinned, on mainnet or devnet", () => {
  assert.equal(POOL_TESTNET, false);
  assert.deepEqual(Object.keys(SOL_POOLS), []);
  assert.equal(SOL_POOLS.mainnet, undefined);
  assert.ok(Object.isFrozen(SOL_POOLS));
});
