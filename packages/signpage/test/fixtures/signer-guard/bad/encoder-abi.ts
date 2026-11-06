// planted (card signer-guard-parser): the pool's deposit as an ABI entry, and its signature hashed with a space in it
export const ABI = [{ type: "function", name: "deposit", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [] }] as const;
export const selectorOf = (id: (s: string) => string) => id("deposit(uint256, " + "uint256)").slice(0, 10);
