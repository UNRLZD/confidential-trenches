// W's signature of a pool withdraw or buy in the helper's tests (card helper-evm-sender-2): the test W key, its address
// (every test request's recipient), and a release's calldata with its signature put in place, made over the helper's
// own digest (evmReleaseDigest), which src/pool/evm-release.test.ts holds to cast's EIP-712 of the pool's type strings.
// The key is a test key: sha256("helper-evm-sender-2/test-key/W").
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { evmAddressOf, evmReadRelease, evmReleaseDigest } from "../../src/pool/evm.ts";

export const W_KEY = new Uint8Array(createHash("sha256").update("helper-evm-sender-2/test-key/W").digest());
export const W = evmAddressOf(W_KEY);
/** Base Sepolia's chain id, the kit's pin for the tests' network. */
export const TEST_CHAIN_ID = 84_532n;

/** r ‖ s ‖ v of `digest` by `key`: s low, v 27 or 28, as the device's signer makes it. */
export function sign65(key: Uint8Array, digest: Uint8Array): Uint8Array {
  const rec = secp256k1.sign(digest, key, { prehash: false, lowS: true, format: "recovered" });
  return Uint8Array.from([...rec.subarray(1, 65), 27 + rec[0]!]);
}

/** `data` (a withdraw's or a buy's calldata, 0x hex) with its signature words replaced by `key`'s signature of the
 *  release it reads as, on `pool` and `chainId`: the signature is the calldata's last three words (r, s, v and its pad). */
export function signRelease(data: string, pool: string, chainId = TEST_CHAIN_ID, key = W_KEY): string {
  const r = evmReadRelease(new Uint8Array(Buffer.from(data.slice(2), "hex")));
  const sig = sign65(key, evmReleaseDigest(chainId, pool, r));
  return `${data.slice(0, -192)}${Buffer.from(sig).toString("hex").padEnd(192, "0")}`;
}
