// node --test src/pool/mainnet-only.test.ts (card helper-mainnet-pools-only): the helper loads and serves mainnet pools
// only (owner, 12 Nov: no test networks). The host's environment may still hold the lines of the test pools before
// (Base Sepolia, Robinhood testnet, Solana devnet): each loads nothing and refuses nothing, so no test network's
// provider can hold a deploy or turn a live run red. Test keys only: fixed bytes and sha256 of a label; no key here
// holds or moves anything.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { evmPoolVenues } from "@blindfill/kit";
import { base58 } from "../bind/checks.ts";
import { evmPoolSendersFromEnv, POOL_EVM_COLLECTOR_ENV, POOL_EVM_ENV, POOL_EVM_SELL_ENV } from "./evm.ts";
import { MAINNET_POOL_NETWORKS } from "./mainnet-only.ts";
import { POOL_SOLANA_ENV, solanaPoolSendersFromEnv } from "./solana.ts";

const KEY = "0x" + "11".repeat(32);
const SELL = "0x" + "22".repeat(32);
const FEE_PAYER = ((seed) => base58(Uint8Array.from([...seed, ...ed25519.getPublicKey(seed)])))(new Uint8Array(createHash("sha256").update("helper-mainnet-pools-only/FP").digest()));
const PROGRAM = base58(ed25519.getPublicKey(new Uint8Array(createHash("sha256").update("helper-mainnet-pools-only/PROGRAM").digest())));

// the test pools' lines as a host's environment held them, by their names (no table of the helper's names them now)
const kit = evmPoolVenues() as Record<string, { pool?: string; feeCollector?: string } | undefined>;
const evmTestLines = (suffix: string, network: string): Record<string, string> => ({
  [`POOL_EVM_ADDRESS_${suffix}`]: kit[network]?.pool ?? "0x" + "ab".repeat(20),
  [`POOL_EVM_SENDER_KEY_${suffix}`]: KEY,
  [`POOL_EVM_FEE_${suffix}`]: "10000000000000",
  [`POOL_EVM_FEE_RECIPIENT_${suffix}`]: "0x" + "cd".repeat(20),
  [`POOL_EVM_RPCS_${suffix}`]: "https://a.sepolia.example,https://b.testnet.example",
  [`POOL_EVM_SELL_KEY_${suffix}`]: SELL,
  [`POOL_EVM_FEE_COLLECTOR_${suffix}`]: kit[network]?.feeCollector ?? "0x" + "ef".repeat(20),
});
const TEST_LINES: Record<string, string> = {
  ...evmTestLines("BASE_SEPOLIA", "base-sepolia"),
  ...evmTestLines("ROBINHOOD_TESTNET", "robinhood-testnet"),
  POOL_SOLANA_PROGRAM_DEVNET: `${PROGRAM},${base58(ed25519.getPublicKey(new Uint8Array(32).fill(7)))}`,
  POOL_SOLANA_FEE_PAYER_KEY_DEVNET: FEE_PAYER,
  POOL_SOLANA_FEE_DEVNET: "1300000",
  POOL_SOLANA_RPCS_DEVNET: "https://a.devnet.example,https://b.devnet.example",
};
// the same names, each set to a value every reader refuses, or set alone (a sell key with no pool)
const BAD_LINES: Record<string, string> = Object.fromEntries(Object.keys(TEST_LINES).map((n) => [n, "not-a-value"]));

test("card helper-mainnet-pools-only: every pool table names the mainnets only (pool/mainnet-only.ts MAINNET_POOL_NETWORKS)", () => {
  for (const table of [POOL_EVM_ENV, POOL_EVM_SELL_ENV, POOL_EVM_COLLECTOR_ENV]) assert.deepEqual(Object.keys(table), [...MAINNET_POOL_NETWORKS.evm]);
  assert.deepEqual(Object.keys(POOL_SOLANA_ENV), [...MAINNET_POOL_NETWORKS.solana]);
  const names = [...Object.values(POOL_EVM_ENV).flat(), ...Object.values(POOL_EVM_SELL_ENV), ...Object.values(POOL_EVM_COLLECTOR_ENV), ...Object.values(POOL_SOLANA_ENV).flat()];
  assert.deepEqual(names.filter((n) => /SEPOLIA|TESTNET|DEVNET/.test(n)), []);
});

test("card helper-mainnet-pools-only: an environment holding every test pool's lines loads no test pool sender and refuses nothing, whole, broken or a sell key alone", () => {
  for (const env of [TEST_LINES, BAD_LINES, { POOL_EVM_SELL_KEY_BASE_SEPOLIA: SELL }, { POOL_EVM_FEE_COLLECTOR_ROBINHOOD_TESTNET: "0x" + "ef".repeat(20) }, { POOL_SOLANA_FEE_PAYER_KEY_DEVNET: FEE_PAYER }]) {
    const evm = evmPoolSendersFromEnv(env, undefined, undefined, undefined, () => {});
    const sol = solanaPoolSendersFromEnv(env);
    assert.deepEqual([[...evm.values()].map((s) => s.network), [...sol.values()].map((s) => s.cluster)], [[], []], JSON.stringify(Object.keys(env)));
  }
});

test("card helper-mainnet-pools-only: the mainnet pools beside the test lines load as before, and only they", () => {
  const env = {
    ...TEST_LINES,
    POOL_EVM_ADDRESS_BASE: kit.base!.pool!,
    POOL_EVM_SENDER_KEY_BASE: KEY,
    POOL_SOLANA_PROGRAM_MAINNET: PROGRAM,
    POOL_SOLANA_FEE_PAYER_KEY_MAINNET: FEE_PAYER,
    POOL_SOLANA_FEE_MAINNET: "1300000",
    POOL_SOLANA_RPCS_MAINNET: "https://a.mainnet.example,https://b.mainnet.example",
  };
  const evm = evmPoolSendersFromEnv(env, undefined, undefined, undefined, () => {});
  const sol = solanaPoolSendersFromEnv(env);
  assert.deepEqual([...evm.values()].map((s) => s.network), ["base"]);
  assert.deepEqual([...sol.values()].map((s) => s.cluster), ["mainnet"]);
});

test("card helper-mainnet-pools-only: node src/env-check.ts, which deploy/redeploy.sh runs before a swap, exits 0 on the test lines alone", () => {
  const run = spawnSync(process.execPath, [path.join(import.meta.dirname, "../env-check.ts")], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...BAD_LINES } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
