// planted (card signer-guard-parser, carried from precommit-taken-recover's inline cases): the pool's deposit encoded
// viem-style by its function name, by its signature, and by its selector in a string
type Encode = (a: { abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => string;

export const data = (encodeFunctionData: Encode, abi: readonly unknown[], args: readonly unknown[]) => encodeFunctionData({ abi, functionName: "deposit", args });
export const SIGNATURE = "deposit(uint256,uint256)";
export const call = (args: string) => "0xE2BBB158" + args;
