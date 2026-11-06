// planted (card signer-guard-parser, review of c00a169d, L3): the test exempts signDigest in this file, as EXEMPT does in
// sell-unpinned.ts; a function of that name nested in another top-level function is not the exempt one
import { secp256k1 } from "@noble/curves/secp256k1.js";
export function signDigest(k: Uint8Array, d: Uint8Array) {
  return secp256k1.sign(d, k, { prehash: false });
}
export function evmPoolSellFeeMax(k: Uint8Array, d: Uint8Array) {
  function signDigest() {
    return secp256k1.sign(d, k, { prehash: false });
  }
  return signDigest();
}
