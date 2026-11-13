// The exit tool's Base and Robinhood pools, offline (card exit-evm-pools-with-the-words): the pins are the deploy
// records, G is the words' standard first EVM account, W's Withdraw signature and the gas wallet's transactions recover
// to their signers, the withdraw calldata has the pool's one encoding, and a bad To or one RPC twice is refused before
// any read. The whole exit runs on a fork of each mainnet: scripts/evm-fork.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, EVM_POOLS, freshWallet, wordsToSeed64, type EvmRpc } from "@blindfill/kit/core";
import { exitBase, exitEvm, exitEvmAddress, exitGasKey, exitRobinhood, exitSignTx, exitWithdrawCalldata, exitWithdrawSignature, EXIT_GAS_PATH, ExitEvmRefused } from "../src/evm-out.ts";

const ROOT = new URL("../../../", import.meta.url);
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the wallet's A.8 words, public, holding nothing
const hex = (b: Uint8Array): string => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;

test("each chain's pool is its deploy record's PrivacyPoolSimple, scanned from that deploy", () => {
  for (const chain of ["base", "robinhood"] as const) {
    const rec = JSON.parse(readFileSync(new URL(`contracts/pool-evm/deployments/${chain}.json`, ROOT), "utf8"));
    assert.equal(EVM_POOLS[chain]?.pool, rec.contracts.PrivacyPoolSimple.address.toLowerCase(), chain);
    assert.ok(EVM_POOLS[chain]!.fromBlock > 0n);
  }
  assert.equal(typeof exitBase, "function");
  assert.equal(typeof exitRobinhood, "function");
});

test("G is the words' first EVM account at m/44'/60'/0'/0/0, never a W", () => {
  assert.equal(EXIT_GAS_PATH, "m/44'/60'/0'/0/0");
  const k = exitGasKey(SEED);
  // the BIP-39 'abandon x11 about' words' first Ethereum account, as every EVM wallet derives it
  assert.equal(exitEvmAddress(k), "0x9858effd232b4033e47d90003d41ec34ecaeda94");
  const w = freshWallet(SEED, "evm", 1n, 0);
  assert.notEqual(w.address.toLowerCase(), exitEvmAddress(k));
  assert.equal(exitEvmAddress(w.secretKey), w.address.toLowerCase());
});

test("W's Withdraw signature recovers to W under the pool's EIP-712 digest", () => {
  const w = freshWallet(SEED, "evm", 7n, 0);
  const pool = EVM_POOLS.base!.pool;
  const sig = exitWithdrawSignature(w.secretKey, 8453n, pool, 11n, 22n, 33n);
  assert.equal(sig.length, 65);
  assert.ok(sig[64] === 27 || sig[64] === 28);
  const word = (v: bigint) => Uint8Array.from(v.toString(16).padStart(64, "0").match(/../g)!, (x) => parseInt(x, 16));
  const utf8 = (s: string) => new TextEncoder().encode(s);
  const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
  const domain = keccak_256(cat(keccak_256(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak_256(utf8("Blindfill")), keccak_256(utf8("1")), word(8453n), word(BigInt(pool))));
  const digest = keccak_256(cat(Uint8Array.of(0x19, 0x01), domain, keccak_256(cat(keccak_256(utf8("Withdraw(uint256 nullifier,uint256 context,uint256 value)")), word(11n), word(22n), word(33n)))));
  const pub = secp256k1.Signature.fromBytes(sig.subarray(0, 64), "compact").addRecoveryBit(sig[64]! - 27).recoverPublicKey(digest).toBytes(false);
  assert.equal(hex(keccak_256(pub.subarray(1)).subarray(12)), w.address.toLowerCase());
});

test("the gas wallet's type 2 transaction is 0x02-prefixed, its hash keccak of the raw bytes", () => {
  const k = exitGasKey(SEED);
  const { raw, hash } = exitSignTx(k, { chainId: 8453n, nonce: 0n, tip: 10_000_000n, maxFee: 20_000_000n, gas: 21_000n, to: "0x5555555555555555555555555555555555555555", value: 1n, data: new Uint8Array(0) });
  assert.equal(raw[0], 2);
  assert.equal(hash, hex(keccak_256(raw)));
});

test("withdraw calldata: the pool's selector and its 1,028 bytes", () => {
  const w = freshWallet(SEED, "evm", 7n, 0);
  const proof = { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"], protocol: "groth16", curve: "bn128" };
  const relay = { recipient: w.address, feeRecipient: EVM_POOLS.base!.feeRecipient, feeCap: 0n, deadlineMs: 1n, refundPrecommitment: 0n, salt: `0x${"00".repeat(16)}` };
  const data = exitWithdrawCalldata(EVM_POOLS.base!.pool, relay, proof as never, ["1", "2", "3", "4", "5", "6", "7", "8"] as never, 0n, new Uint8Array(65));
  assert.equal(data.length, 1028);
  assert.equal(hex(data.subarray(0, 4)), hex(keccak_256(new TextEncoder().encode("withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,bytes)")).subarray(0, 4)));
  // pB's pairs swapped for the EVM pairing: (4, 3), (6, 5)
  const at = (k: number) => BigInt(hex(data.subarray(4 + 32 * k, 36 + 32 * k)));
  assert.deepEqual([at(1), at(2), at(3), at(4), at(5), at(6), at(7), at(8)], [1n, 2n, 4n, 3n, 6n, 5n, 7n, 8n]);
});

test("a To that is no address to pay, and one RPC twice, are refused before any read", async () => {
  let reads = 0;
  const rpc = Object.assign(async () => (reads++, "0x2105"), { url: "https://a.example" }) as unknown as EvmRpc;
  const other = Object.assign(async () => (reads++, "0x2105"), { url: "https://b.example" }) as unknown as EvmRpc;
  const ctx = { seed: SEED, to: "0x0000000000000000000000000000000000000001", rpcs: ["https://a.example", "https://b.example"] as [string, string], say: () => {} };
  await assert.rejects(exitEvm("base", ctx, { rpcs: [rpc, other] }), ExitEvmRefused);
  await assert.rejects(exitEvm("base", { ...ctx, to: "0xnot" }, { rpcs: [rpc, other] }), ExitEvmRefused);
  await assert.rejects(exitEvm("base", { ...ctx, to: "0x5555555555555555555555555555555555555555" }, { rpcs: [rpc, rpc] }), ExitEvmRefused);
  await assert.rejects(exitEvm("base", { ...ctx, to: EVM_POOLS.base!.pool }, { rpcs: [rpc, other] }), ExitEvmRefused);
  assert.equal(reads, 2, "only the pool-To case read the chain ids");
});
