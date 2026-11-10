// node --test packages/wallet/test/evm-pool-pins.test.ts (card evm-pool-pins): the wallet's EVM pool pins, EVM_POOLS.
// - The testnet build pins Base Sepolia's and Robinhood testnet's pool, each the pool of that chain's newest pool record
//   (scripts/live-checks/pool-evm-deploy.mjs poolFile: card pool-evm-buy-pays-revert's set, not pool-evm-deploy.md's
//   3 Nov pools) and the pool the kit's venue list pins, with an address of its own as the fee recipient.
// - No build pins a mainnet pool: a mainnet pin turns on deposits into a pool the app cannot yet trade or withdraw from,
//   so it waits for its own card once buy, sell and withdraw are proven on testnet.
// - SIGN_HOST's build (where nothing sets the network) pins nothing, as SOL_POOLS keeps devnet out of it.
// The chain's word on each pin (the deploy receipt's block and contract on two RPCs, the code, the deployed helper's fee
// recipient) is the live check's: scripts/live-checks/evm-pool-pins.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { evmPoolVenues } from "@blindfill/kit";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { EVM_POOLS } = await import("../src/pool/evm.ts");
const DEPLOY = (await import(new URL("../../../scripts/live-checks/pool-evm-deploy.mjs", import.meta.url).href)) as { poolFile: (chain: string) => string };

const TESTNETS = ["base-sepolia", "robinhood-testnet"] as const;
const ADDRESS = /^0x[0-9a-f]{40}$/;

test("the testnet build pins exactly Base Sepolia's and Robinhood testnet's pool", () => {
  assert.deepEqual(Object.keys(EVM_POOLS).sort(), [...TESTNETS]);
});

for (const net of TESTNETS) {
  test(`${net}'s pin is its newest pool record's pool and the kit's venue pool, with its own fee recipient and deploy block`, () => {
    const pin = EVM_POOLS[net];
    assert.ok(pin, `no ${net} pin`);
    assert.equal(pin.network, net);
    const record = JSON.parse(readFileSync(DEPLOY.poolFile(net), "utf8")) as { chain: string; dryRun: boolean; contracts: { PrivacyPoolSimple: { address: string } } };
    assert.equal(record.chain, net);
    assert.equal(record.dryRun, false, "a dry run's record is never pinned");
    assert.equal(pin.pool, record.contracts.PrivacyPoolSimple.address.toLowerCase(), `the pin is ${DEPLOY.poolFile(net)}'s pool`);
    const venue = evmPoolVenues()[net];
    assert.equal(pin.pool, venue.pool?.toLowerCase(), "the pin is the pool the kit's builder and signer pin");
    assert.match(pin.pool, ADDRESS);
    assert.match(pin.feeRecipient, ADDRESS);
    for (const other of [pin.pool, venue.sellSender, venue.feeCollector, "0x" + "0".repeat(40)]) assert.notEqual(pin.feeRecipient, other?.toLowerCase(), "the fee recipient is an address of its own");
    assert.equal(typeof pin.fromBlock, "bigint");
    assert.ok(pin.fromBlock > 0n);
    assert.ok(Object.isFrozen(EVM_POOLS) && Object.isFrozen(pin), "frozen");
  });
}

test("the pins are the ones the live check reads on the chain and the helper (scripts/live-checks/evm-pool-pins.mjs PINS)", async () => {
  const { PINS } = (await import(new URL("../../../scripts/live-checks/evm-pool-pins.mjs", import.meta.url).href)) as { PINS: Record<string, { network: string; pool: string; feeRecipient: string; fromBlock: string }> };
  const ours = Object.fromEntries(Object.entries(EVM_POOLS).map(([k, p]) => [k, { ...p!, fromBlock: p!.fromBlock.toString() }]));
  assert.deepEqual(ours, { ...PINS });
});

test("no build pins a mainnet pool: SIGN_HOST's build pins nothing", () => {
  for (const net of ["base", "robinhood"] as const) assert.equal(Object.hasOwn(EVM_POOLS, net), false, `the testnet build pins ${net}`);
  // SIGN_HOST's build: the network unset, as in any process that does not set it
  const mainnet = execFileSync(process.execPath, ["--input-type=module", "-e", `const { EVM_POOLS } = await import(${JSON.stringify(fileURLToPath(new URL("../src/pool/evm.ts", import.meta.url)))}); console.log(JSON.stringify(Object.keys(EVM_POOLS)));`], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(mainnet), []);
});
