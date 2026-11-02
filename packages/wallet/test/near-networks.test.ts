// The NEAR networks module (src/near/networks.ts, split out of src/deposit/account.ts by card signpage-withdraw-form):
// it imports nothing, so the signing page carries no kit code for it; what it copies from the kit is held equal here,
// and src/deposit/account.ts re-exports the very same objects.   node --test test/near-networks.test.ts
/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HELPER_RPC_METHODS, VAULT_CONSTANTS } from "@blindfill/kit";
import * as account from "../src/deposit/account.ts";
import * as near from "../src/near/networks.ts";

test("mainnet's usdc is the kit's VAULT_CONSTANTS.TOKEN, and nearRpc's method is on the kit's NEAR list", () => {
  assert.equal(near.NEAR_NETWORKS.mainnet.usdc, VAULT_CONSTANTS.TOKEN);
  assert.ok((HELPER_RPC_METHODS.near as readonly string[]).includes(near.NEAR_RPC_METHOD));
});

test("the module imports nothing, and names no field token (the bundle then holds no `token:` before a public id)", () => {
  const src = readFileSync(new URL("../src/near/networks.ts", import.meta.url), "utf8");
  assert.deepEqual(src.split("\n").filter((l) => /^\s*(import|export .* from)\b/.test(l)), []);
  assert.doesNotMatch(src, /\btoken\s*:/i);
  for (const net of Object.values(near.NEAR_NETWORKS)) assert.deepEqual(Object.keys(net), ["usdc", "vault", "fastnear", "drpc"]);
});

test("deposit/account.ts re-exports the same table, pair rule and provider, so no caller changes", () => {
  for (const k of ["NEAR_NETWORKS", "NEAR_RPC_URLS", "NEAR_RPC_METHOD", "RPC_TIMEOUT_MS", "nearPairNetwork", "nearPairRule", "nearRpc"] as const)
    assert.equal((account as Record<string, unknown>)[k], (near as Record<string, unknown>)[k], k);
  assert.ok(Object.isFrozen(near.NEAR_NETWORKS) && Object.isFrozen(near.NEAR_NETWORKS.testnet) && Object.isFrozen(near.NEAR_NETWORKS.mainnet.fastnear));
});
