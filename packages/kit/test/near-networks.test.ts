// The NEAR networks module (src/near/networks.ts, from the wallet's deposit/account.ts by card signpage-withdraw-form,
// moved here by card app-verify-pair-rule): it imports nothing, so the signing page carries no kit code for it; what it
// copies from the kit's other files is held equal here.   node --test test/near-networks.test.ts      (from packages/kit)
/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HELPER_RPC_METHODS, VAULT_CONSTANTS } from "@blindfill/kit";
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

test("the entry exports the pair rule and its network type, the very same functions, and not the table or the provider", async () => {
  const kit = await import("@blindfill/kit");
  assert.equal(kit.nearPairNetwork, near.nearPairNetwork);
  assert.equal(kit.nearPairRule, near.nearPairRule);
  assert.equal("NEAR_NETWORKS" in kit, false);
  assert.equal("nearRpc" in kit, false);
});

const rpc = (name: string) => ({ name, query: async () => ({}) });
test("exactly one FastNEAR URL and the network's dRPC, in either order, is a pair; anything else is not", () => {
  const { fastnear, drpc } = near.NEAR_NETWORKS.testnet;
  const [a, b] = fastnear;
  assert.equal(near.nearPairNetwork([rpc(a), rpc(drpc)]), "testnet");
  assert.equal(near.nearPairNetwork([rpc(drpc), rpc(b)]), "testnet");
  assert.equal(near.nearPairNetwork([rpc(a), rpc(b)]), null, "two hosts of one operator are one read");
  assert.equal(near.nearPairNetwork([rpc(a), rpc(a)]), null);
  assert.equal(near.nearPairNetwork([rpc(drpc), rpc(drpc)]), null);
  assert.equal(near.nearPairNetwork([rpc(a), rpc(near.NEAR_NETWORKS.mainnet.drpc)]), null, "a pair across networks");
  assert.equal(near.nearPairNetwork([rpc(a), rpc("https://rpc.example.org")]), null);
  assert.equal(near.nearPairNetwork([rpc(a)]), null);
  assert.equal(near.nearPairNetwork("not a pair"), null);
  assert.match(near.nearPairRule(), /^the RPCs must be one of .* exactly$/);
  assert.ok(near.nearPairRule("testnet").includes(drpc));
});
