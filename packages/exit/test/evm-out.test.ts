// The exit tool's Base and Robinhood pools, offline (card exit-evm-pools-with-the-words): the pins are the deploy
// records, and a bad To, the pool as To, one RPC twice or no prover is refused before any money moves. The signatures
// are the wallet's (packages/wallet/test/pool-evm-exit.test.ts); the whole exit runs on a fork of each mainnet
// (scripts/evm-fork.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { entropyToWords, EVM_POOLS, wordsToSeed64, type EvmRpc } from "@blindfill/kit/core";
import type { VaultProver } from "@blindfill/kit";
import { exitBase, exitEth, exitEvm, exitRobinhood, ExitEvmRefused } from "../src/evm-out.ts";

const ROOT = new URL("../../../", import.meta.url);
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the wallet's A.8 words, public, holding nothing
const PROVER: VaultProver = { load: async () => {}, prove: async () => ({}) as never };

test("each chain's pool is its deploy record's PrivacyPoolSimple, scanned from that deploy", () => {
  for (const chain of ["base", "robinhood"] as const) {
    const rec = JSON.parse(readFileSync(new URL(`contracts/pool-evm/deployments/${chain}.json`, ROOT), "utf8"));
    assert.equal(EVM_POOLS[chain]?.pool, rec.contracts.PrivacyPoolSimple.address.toLowerCase(), chain);
    assert.ok(EVM_POOLS[chain]!.fromBlock > 0n);
  }
  assert.equal(typeof exitBase, "function");
  assert.equal(typeof exitRobinhood, "function");
  assert.equal(exitEth(1_000_000_000_000_000n), "0.001 ETH");
  assert.equal(exitEth(0n), "0 ETH");
});

test("a To that is no address to pay, the pool as To, one RPC twice and no prover are refused before any money moves", async () => {
  let reads = 0;
  const rpc = Object.assign(async () => (reads++, "0x2105"), { url: "https://a.example" }) as unknown as EvmRpc;
  const other = Object.assign(async () => (reads++, "0x2105"), { url: "https://b.example" }) as unknown as EvmRpc;
  const ctx = { seed: SEED, to: "0x0000000000000000000000000000000000000001", rpcs: ["https://a.example", "https://b.example"] as [string, string], say: () => {} };
  const TO = "0x5555555555555555555555555555555555555555";
  await assert.rejects(exitEvm("base", ctx, { rpcs: [rpc, other], prover: PROVER }), ExitEvmRefused);
  await assert.rejects(exitEvm("base", { ...ctx, to: "0xnot" }, { rpcs: [rpc, other], prover: PROVER }), ExitEvmRefused);
  await assert.rejects(exitEvm("base", { ...ctx, to: TO }, { rpcs: [rpc, rpc], prover: PROVER }), ExitEvmRefused);
  await assert.rejects(exitEvm("base", { ...ctx, to: TO }, { rpcs: [rpc, other] }), /no prover/);
  assert.equal(reads, 0);
  await assert.rejects(exitEvm("base", { ...ctx, to: EVM_POOLS.base!.pool }, { rpcs: [rpc, other], prover: PROVER }), ExitEvmRefused);
  assert.equal(reads, 2, "only the pool-To case read the chain ids");
});
