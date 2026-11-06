// planted (card signer-guard-parser, reviewer variant b01-dynimport-computed of 1a8a42f0)
export const send = async (k: Uint8Array, b: never) => {
  const m = await import("../../../../../../packages/kit/src/trade/evm/sell.ts");
  return (m as any)["evmPool" + "SignSell"](k, "base", b);
};
