// planted (card signer-guard-parser, reviewer variant b10-handrolled-sell of 1a8a42f0)
// a sell signed by hand: the kit's own EIP-712 Sell digest (sell-unpinned.ts), signed with noble's secp256k1, no kit signer
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
const utf8 = (s: string) => new TextEncoder().encode(s);
const TYPE = keccak_256(utf8("Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,address feeRecipient,uint256 deadline,uint256 nonce)"));
export const sign = (key: Uint8Array, structRest: Uint8Array, domain: Uint8Array) => {
  const struct = keccak_256(new Uint8Array([...TYPE, ...structRest]));
  const digest = keccak_256(new Uint8Array([0x19, 0x01, ...domain, ...struct]));
  return secp256k1.sign(digest, key, { prehash: false, lowS: true, format: "recovered" });
};
