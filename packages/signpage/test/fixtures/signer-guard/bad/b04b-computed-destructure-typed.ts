// planted (card signer-guard-parser, reviewer variant b04b-computed-destructure-typed of 1a8a42f0)
import * as kit from "../../../../../../packages/kit/src/index.ts";
const key = "evmPoolSignSell" as const;
const { [key]: s } = kit;
export const send = (k: Uint8Array, b: never) => s(k, "base", b);
