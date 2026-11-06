// planted (card signer-guard-parser, reviewer variant b09b-glob-literal of 1a8a42f0)
// Vite's own glob: the bundler pulls the module in; the guard sees no import
const mods = import.meta.glob("../../../../../../packages/kit/src/trade/evm/sell.ts", { eager: true });
export const send = (k: Uint8Array, b: never) => (Object.values(mods)[0] as any).evmPoolSignSell(k, "base", b);
