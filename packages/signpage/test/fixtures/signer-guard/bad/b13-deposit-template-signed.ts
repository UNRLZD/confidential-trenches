// planted (card signer-guard-parser, reviewer variant b13 of 40115c3d, with a signature): the deposit's signature in a
// template with substitutions, signed with an HD key's own sign
import { HDKey } from "../../../../../wallet/node_modules/@scure/bip32/index.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
const t = "uint256";
const sel = keccak_256(new TextEncoder().encode(`deposit(${t},${t})`)).slice(0, 4);
export const sign = (seed: Uint8Array, rlpUnsigned: (data: Uint8Array) => Uint8Array, args: Uint8Array) => HDKey.fromMasterSeed(seed).deriveChild(0).sign(keccak_256(rlpUnsigned(new Uint8Array([...sel, ...args]))));
