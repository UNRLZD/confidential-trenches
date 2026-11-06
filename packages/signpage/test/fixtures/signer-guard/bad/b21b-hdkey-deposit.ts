// planted (card signer-guard-parser, reviewer variant b21b of 40115c3d): a pool deposit as W's own type-2 send, its
// calldata built at run time, signed with HDKey.sign on a key derived the way the wallet derives W's
import { HDKey } from "../../../../../wallet/node_modules/@scure/bip32/index.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
const t = "uint256";
const sel = keccak_256(new TextEncoder().encode(["deposit(", t, ",", t, ")"].join(""))).slice(0, 4);
export const sign = (seed: Uint8Array, rlpUnsigned: (data: Uint8Array) => Uint8Array, args: Uint8Array) => {
  const node = HDKey.fromMasterSeed(seed).deriveChild(0);
  return node.sign(keccak_256(rlpUnsigned(new Uint8Array([...sel, ...args]))));
};
