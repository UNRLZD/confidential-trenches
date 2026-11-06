// planted (card signer-guard-parser): the kit's signer reached through a namespace import of the kit's index, whose
// `export * from "./trade/evm/sell.ts"` re-exports it, by an element access
import * as kit from "../../../../../kit/src/index.ts";

export const send = (key: Uint8Array, built: never) => kit["evmPoolSignSell"](key, "base", built);
