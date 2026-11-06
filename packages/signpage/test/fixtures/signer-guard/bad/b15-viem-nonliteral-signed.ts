// planted (card signer-guard-parser, reviewer variant b15 of 40115c3d, with a signature): viem's functionName by a const,
// the calldata signed by a signer some other file put on globalThis, reached through a cast
import { keccak_256 } from "@noble/hashes/sha3.js";
type Encode = (a: { abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => Uint8Array;
const fn = "deposit";
export const sign = (encodeFunctionData: Encode, abi: readonly unknown[], args: readonly unknown[], wKey: Uint8Array) =>
  (globalThis as unknown as { __sign: (d: Uint8Array, k: Uint8Array) => Uint8Array }).__sign(keccak_256(encodeFunctionData({ abi, functionName: fn, args })), wKey);
