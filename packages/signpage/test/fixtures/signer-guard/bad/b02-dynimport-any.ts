// planted (card signer-guard-parser, reviewer variant b02-dynimport-any of 1a8a42f0)
export const send = async (k: Uint8Array, b: never) => {
  const m: any = await import("../../../../../../packages/kit/src/trade/evm/sell.ts");
  return m.evmPoolSignSell(k, "base", b);
};
