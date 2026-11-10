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

// Circle's testnet USDC on Base Sepolia, a public address (contracts/pool-evm/script/testnet-run.mjs)
const SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";

test("the mainnet build refuses an EVM pool buy by name, whatever pin a chain has (card signpage-evm-pool-buy; its mainnet pins are a later card)", async () => {
  const { testnetPool } = await import("../src/pool-testnet.ts");
  const pin = Object.freeze({ network: "base" as const, pool: "0x00000000000000000000000000000000000F0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n });
  const rpcs = ["https://a.example", "https://b.example"].map((url) => Object.assign(async () => assert.fail("no RPC read"), { url }));
  const t = testnetPool({ store: async () => assert.fail("no store read"), seed64: async () => assert.fail("no seed read") } as never, {
    evmPin: () => pin,
    evmRpcs: () => rpcs,
    evmSync: () => ({ events: async () => assert.fail("no sync read") }),
    tradeKinds: { evmBuy: () => () => assert.fail("no EVM buy on mainnet") },
  });
  for (const chain of ["base", "robinhood"] as const)
    assert.deepEqual(t.flow({ kind: "pool.buy", chain, token: SEPOLIA_USDC, amount: 10n ** 15n, slippageBps: 100, decimals: 18 }, null as never), { error: "not_allowed" });
});
