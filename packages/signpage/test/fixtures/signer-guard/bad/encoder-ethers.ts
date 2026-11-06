// planted (card signer-guard-parser): the pool's deposit encoded ethers-style, by its function name
type Iface = { encodeFunctionData(name: string, args: readonly unknown[]): string };

export const data = (iface: Iface, precommitment: bigint, amount: bigint) => iface.encodeFunctionData("deposit", [precommitment, amount]);
