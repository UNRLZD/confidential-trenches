// planted (card signer-guard-parser): the rule's signer held in a typed const, then in a let, then called
import { signEvmSell } from "../../../../src/rules/pool.ts";

const held: typeof signEvmSell = signEvmSell;
let later: typeof signEvmSell | undefined;
later = held;
export const send = (key: Uint8Array, ctx: never, built: never) => later!(key, ctx, built);
