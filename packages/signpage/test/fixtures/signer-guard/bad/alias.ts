// planted (card signer-guard-parser): the rule's signer under another name, its note never picked
import { signEvmSell as sign } from "../../../../src/rules/pool.ts";

export const send = (key: Uint8Array, ctx: never, built: never) => sign(key, ctx, built);
