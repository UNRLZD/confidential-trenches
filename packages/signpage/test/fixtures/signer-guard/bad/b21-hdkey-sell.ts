// planted (card signer-guard-parser, reviewer variant b21 of 40115c3d): a sell signed by hand with @scure/bip32's
// HDKey.sign (secp.sign, prehash false), W's key put in an HDKey of its own
import { HDKey } from "../../../../../wallet/node_modules/@scure/bip32/index.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
const SELL_TYPEHASH = hexBytes("4f1d8c2a9b7e3f6a5d4c3b2a1908f7e6d5c4b3a291807f6e5d4c3b2a19080706");
export const sign = (wKey: Uint8Array, domain: Uint8Array, fields: Uint8Array) => {
  const digest = keccak_256(new Uint8Array([0x19, 0x01, ...domain, ...keccak_256(new Uint8Array([...SELL_TYPEHASH, ...fields]))]));
  return new HDKey({ privateKey: wKey }).sign(digest);
};
