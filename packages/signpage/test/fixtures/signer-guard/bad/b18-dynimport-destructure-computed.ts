// planted (card signer-guard-parser, reviewer variant b18-dynimport-destructure-computed of 1a8a42f0)
const key = "evmPoolSignSell" as const;
export const send = async (k: Uint8Array, b: never) => {
  const { [key]: s } = await import("../../../../../../packages/kit/src/trade/evm/sell.ts");
  return s(k, "base", b);
};
