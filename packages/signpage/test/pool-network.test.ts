// SIGN_HOST's build is mainnet (card signpage-pool-flow): with __SIGN_NETWORK__ unset, as in Node, or "mainnet", as
// scripts/build-app.mjs sets it for SIGN_HOST's build, SOL_POOLS pins the mainnet pool alone (card
// sol-pools-mainnet-pin; ../../wallet/test/sol-pool-mainnet-pin.test.ts holds its reads), never the devnet one.
// scripts/build-network.test.mjs holds the bundle itself: the mainnet build carries no testnet pin or provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SOL_MAINNET_DEPLOY, SOL_POOLS } from "../../wallet/src/pool/solana.ts";
import { POOL_TESTNET } from "../../wallet/src/pool/network.ts";

test("the mainnet tables: the mainnet Solana pool pinned, the devnet one not", () => {
  assert.equal(POOL_TESTNET, false);
  assert.deepEqual(Object.keys(SOL_POOLS), ["mainnet"]);
  assert.equal(SOL_POOLS.mainnet!.program, SOL_MAINNET_DEPLOY.program);
  assert.equal(SOL_POOLS.devnet, undefined);
  assert.ok(Object.isFrozen(SOL_POOLS) && Object.isFrozen(SOL_POOLS.mainnet));
});
