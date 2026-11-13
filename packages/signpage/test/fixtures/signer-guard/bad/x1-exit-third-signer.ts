// planted (card exit-evm-pools-with-the-words, merge of the release-132 train): the test exempts evmExitWithdrawSignature
// and evmExitSignSend in this file, as EXEMPT does in packages/wallet/src/pool/evm-exit.ts; a third function of the same
// file that signs a pool deposit with the curve is not exempt
import { secp256k1 } from "@noble/curves/secp256k1.js";
export function evmExitWithdrawSignature(k: Uint8Array, d: Uint8Array) {
  return secp256k1.sign(d, k, { prehash: false });
}
export function evmExitSignSend(k: Uint8Array, d: Uint8Array) {
  return secp256k1.sign(d, k, { prehash: false });
}
export function evmExitSignDeposit(k: Uint8Array, d: Uint8Array) {
  return secp256k1.sign(d, k, { prehash: false });
}
