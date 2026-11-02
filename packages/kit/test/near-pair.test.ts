// The NEAR RPC pair rule, read through the kit's public entry as an app reads it (card app-verify-pair-rule).
//   node --test test/near-pair.test.ts      (from packages/kit)
// It is the wallet's own rule, re-exported, not copied: the same functions, so no path can drift from another.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Kit from "@blindfill/kit";
import * as Wallet from "../../wallet/src/near/networks.ts";

const rpc = (name: string) => ({ name, query: async () => ({}) });

test("the entry's pair rule is the wallet's own functions", () => {
  assert.equal(Kit.nearPairNetwork, Wallet.nearPairNetwork);
  assert.equal(Kit.nearPairRule, Wallet.nearPairRule);
  // the only names the card adds to the entry; the network table and the provider stay the wallet's
  assert.equal("NEAR_NETWORKS" in Kit, false);
  assert.equal("nearRpc" in Kit, false);
});

test("exactly one FastNEAR URL and the network's dRPC, in either order, is a pair; anything else is not", () => {
  const { fastnear, drpc } = Wallet.NEAR_NETWORKS.testnet;
  const [a, b] = fastnear;
  assert.equal(Kit.nearPairNetwork([rpc(a), rpc(drpc)]), "testnet");
  assert.equal(Kit.nearPairNetwork([rpc(drpc), rpc(b)]), "testnet");
  assert.equal(Kit.nearPairNetwork([rpc(a), rpc(b)]), null, "two hosts of one operator are one read");
  assert.equal(Kit.nearPairNetwork([rpc(a), rpc(a)]), null);
  assert.equal(Kit.nearPairNetwork([rpc(drpc), rpc(drpc)]), null);
  assert.equal(Kit.nearPairNetwork([rpc(a), rpc(Wallet.NEAR_NETWORKS.mainnet.drpc)]), null, "a pair across networks");
  assert.equal(Kit.nearPairNetwork([rpc(a), rpc("https://rpc.example.org")]), null);
  assert.equal(Kit.nearPairNetwork([rpc(a)]), null);
  assert.equal(Kit.nearPairNetwork("not a pair"), null);
});

test("the refusal's words name the pair", () => {
  assert.match(Kit.nearPairRule(), /^the RPCs must be one of .* exactly$/);
  assert.ok(Kit.nearPairRule("testnet").includes(Wallet.NEAR_NETWORKS.testnet.drpc));
});
