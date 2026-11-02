// deposit/account.ts re-exports the kit's NEAR networks module (packages/kit/src/near/networks.ts), so no caller changes.
//   node --test test/near-networks-reexport.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import * as account from "../src/deposit/account.ts";
import * as near from "../../kit/src/near/networks.ts";

test("deposit/account.ts re-exports the same table, pair rule and provider, so no caller changes", () => {
  for (const k of ["NEAR_NETWORKS", "NEAR_RPC_URLS", "NEAR_RPC_METHOD", "RPC_TIMEOUT_MS", "nearPairNetwork", "nearPairRule", "nearRpc"] as const)
    assert.equal((account as Record<string, unknown>)[k], (near as Record<string, unknown>)[k], k);
  assert.ok(Object.isFrozen(near.NEAR_NETWORKS) && Object.isFrozen(near.NEAR_NETWORKS.testnet) && Object.isFrozen(near.NEAR_NETWORKS.mainnet.fastnear));
});
