// planted (card signer-guard-parser, reviewer variant b03-dynimport-then-any of 1a8a42f0)
export const send = (k: Uint8Array, b: never) => import("../../../../../../packages/kit/src/trade/evm/sell.ts").then((m: any) => m.evmPoolSignSell(k, "base", b));
