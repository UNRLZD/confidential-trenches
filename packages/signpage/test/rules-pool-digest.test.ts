// The review's cross-check: evmWithdrawDigest against contracts/pool-evm's recorded Withdraw signature (cast's EIP-712,
// test/fixtures/buy-proofs.json .local.signedWithdraw), which Buy.t.sol recovers to W on chain 31337.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { evmWithdrawDigest } from "../src/rules/pool.ts";
test("evmWithdrawDigest recovers the pool-evm fixture's Withdraw signature to Hardhat account 0", () => {
  const fx = JSON.parse(readFileSync(new URL("../../../contracts/pool-evm/test/fixtures/buy-proofs.json", import.meta.url), "utf8"));
  const sw = fx.local.signedWithdraw;
  const pool = fx.local.pool;
  const chainId = BigInt(fx.local.chainId);
  const m = sw.message;
  const d = evmWithdrawDigest(chainId, pool, { nullifier: BigInt(m.nullifier), context: BigInt(m.context), value: BigInt(m.value) });
  const sig = Buffer.from(String(sw.signature).slice(2), "hex");
  const pub = secp256k1.Signature.fromBytes(sig.subarray(0, 64), "compact").addRecoveryBit(sig[64]! - 27).recoverPublicKey(d);
  const addr = "0x" + Buffer.from(keccak_256(pub.toBytes(false).slice(1)).slice(12)).toString("hex");
  assert.equal(addr, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
});
