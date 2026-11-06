// planted (card signer-guard-parser, reviewer variant b12 of 40115c3d, with a signature): a deposit's calldata built at
// run time (no literal holds it), signed as W's own send by an HD key held in a let, as wallet/derive/keys.ts holds one
import { HDKey } from "../../../../../wallet/node_modules/@scure/bip32/index.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
const t = "uint256";
const sel = keccak_256(new TextEncoder().encode(["deposit(", t, ",", t, ")"].join(""))).slice(0, 4);
export const sign = (seed: Uint8Array, rlpUnsigned: (data: Uint8Array) => Uint8Array, args: Uint8Array) => {
  let node = HDKey.fromMasterSeed(seed);
  node = node.deriveChild(0);
  return node.sign(keccak_256(rlpUnsigned(new Uint8Array([...sel, ...args]))));
};
